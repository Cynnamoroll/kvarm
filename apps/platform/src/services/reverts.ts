/**
 * Revert change sets (architecture §11.9, §2.5).
 *
 * `POST reverts {sha | changeNumber, reason?, base?, mergePolicy?, title?}`
 * builds the revert commit server-side and opens it as a change set of kind
 * `revert`. The tree is gitops `revertTree`, the tree `git revert` commits
 * (a merge reverts relative to its first parent, `-m 1`); a merged change
 * set reverts its whole effect relative to the target it landed on (for a
 * fast-forward of several commits too). The commit's only parent is the
 * base tip, so the change fast-forwards while the base does not move.
 *
 * The commit is published on a fresh branch in the platform-reserved
 * namespace `refs/heads/kvarm-revert/<sha7>-<id>` (no git credential may
 * write there, so the head the guard and CI judged stays the platform's),
 * then `createChange` opens it exactly like any change: kvarm/guard, CI from
 * `.kvarm/ci.json`, mergeability, and the merge queue unchanged. The default
 * merge policy is `draft`: a revert merges only after someone (or the
 * incident sender) says so, and it never jumps the queue.
 *
 * Refusals write nothing: an unknown commit is 404, a revert that does not
 * apply cleanly is 409 REVERT_CONFLICT with the conflicting paths and no
 * partial commit, one that changes nothing is 409 NOTHING_TO_REVERT.
 */

import { ZERO_OID, buildCommit, hex, revertMessage, revertTree, type GitIdent, type MergeConflict } from '@kvarm/gitops';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { REVERT_BRANCH_NAMESPACE } from './branchRules';
import {
  CHANGE_LIMITS,
  MERGE_POLICIES,
  agentMergeDenial,
  createChange,
  fail,
  guarded,
  mergeAuthor,
  normalizeBranch,
  readChange,
  resolveCtx,
  branchRef,
  type ChangeContext,
  type CreatedChangeDetail,
  type MergePolicy,
} from './changes';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { KVARM_COMMITTER, MERGE_BUDGETS, artifactsMergeSources } from './merge';
import { lsRefs } from './refs';
import { isUniqueViolation, objectBody } from './result';

export const REVERT_LIMITS = {
  reasonMax: 4_096,
  /** Conflicts listed in a 409; the count is always complete. */
  conflictsMax: 100,
};

export interface RevertDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
}

export const defaultRevertDeps: RevertDeps = { pusher: (env, repo) => artifactsPusher(env, repo) };

export interface RevertRequest {
  sha?: string;
  changeNumber?: number;
  reason?: string;
  base?: string;
  title?: string;
  mergePolicy?: MergePolicy;
}

export interface RevertView {
  /** The reverted commit (a merged change set's merge commit or fast-forwarded head). */
  sha: string;
  /** The commit whose tree the revert restores for the reverted paths; null for a root commit. */
  parent: string | null;
  merge: boolean;
  changeNumber: number | null;
  /** The revert branch, under `kvarm-revert/`. */
  branch: string;
  commit: string;
  treeSha: string;
  reason: string | null;
}

export interface RevertCreated {
  revert: RevertView;
  change: CreatedChangeDetail;
}

export interface RevertOrigin {
  /** Appended to the change body: who asked for the revert (for example an incident event). */
  note?: string;
  /**
   * Fixes the branch suffix instead of a random one. Branch creation is a
   * compare-and-swap from nothing, so a second attempt with the same key gets
   * `409 REVERT_BRANCH_EXISTS` instead of a second change.
   */
  branchKey?: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const READ_FAILURES = new Set(['missingObject', 'readError']);

export function parseRevertRequest(input: unknown): ServiceResult<RevertRequest> {
  const parsed = objectBody(input);
  if (!parsed.ok) return parsed;
  const b = parsed.value;
  const out: RevertRequest = {};
  if ((b.sha === undefined) === (b.changeNumber === undefined)) return fail(422, 'pass exactly one of sha or changeNumber', 'INVALID_REVERT_TARGET');
  if (b.sha !== undefined) {
    if (typeof b.sha !== 'string' || !SHA_RE.test(b.sha.toLowerCase())) return fail(422, 'sha must be a full 40-character commit id', 'INVALID_SHA');
    out.sha = b.sha.toLowerCase();
  }
  if (b.changeNumber !== undefined) {
    if (typeof b.changeNumber !== 'number' || !Number.isInteger(b.changeNumber) || b.changeNumber < 1) {
      return fail(422, 'changeNumber must be a positive integer', 'INVALID_CHANGE_NUMBER');
    }
    out.changeNumber = b.changeNumber;
  }
  if (b.reason !== undefined && b.reason !== null) {
    if (typeof b.reason !== 'string' || b.reason.length > REVERT_LIMITS.reasonMax) {
      return fail(422, `reason must be a string of at most ${REVERT_LIMITS.reasonMax} characters`, 'INVALID_REASON');
    }
    if (b.reason.trim()) out.reason = b.reason.trim();
  }
  if (b.base !== undefined) {
    const base = normalizeBranch(b.base);
    if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
    out.base = base;
  }
  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.trim().length > CHANGE_LIMITS.titleMax) {
      return fail(422, `title must be 1-${CHANGE_LIMITS.titleMax} characters`, 'INVALID_TITLE');
    }
    out.title = b.title.trim();
  }
  if (b.mergePolicy !== undefined) {
    if (typeof b.mergePolicy !== 'string' || !(MERGE_POLICIES as readonly string[]).includes(b.mergePolicy)) {
      return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
    }
    out.mergePolicy = b.mergePolicy as MergePolicy;
  }
  return { ok: true, value: out };
}

function randomSuffix(): string {
  return hex(crypto.getRandomValues(new Uint8Array(4)));
}

/** The live value of one ref (one ls-refs round trip), or null when it does not exist. */
export function liveRef(cx: Pick<ChangeContext, 'env' | 'repo' | 'waitUntil'>, ref: string): Promise<string | null> {
  return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => (await lsRefs(resolveCtx(cx, artifacts), [ref])).get(ref) ?? null);
}

/** `kvarm-revert/<sha7>-<key>`: the key is random, or derived from an incident event so a repeated delivery names the same branch. */
export function revertBranch(sha: string, key: string): string {
  return `${REVERT_BRANCH_NAMESPACE.slice('refs/heads/'.length)}/${sha.slice(0, 7)}-${key}`;
}

function conflictList(conflicts: readonly MergeConflict[]) {
  const listed = conflicts.slice(0, REVERT_LIMITS.conflictsMax).map((c) => ({ path: c.path, kind: c.kind, paths: c.paths }));
  return { conflicts: listed, conflictCount: conflicts.length, ...(conflicts.length > listed.length ? { conflictsTruncated: true } : {}) };
}

/** POST reverts: see the module comment. */
export function createRevert(cx: ChangeContext, input: unknown, deps: RevertDeps = defaultRevertDeps, origin: RevertOrigin = {}): Promise<ServiceResult<RevertCreated>> {
  return guarded(async () => {
    const parsed = parseRevertRequest(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const mergePolicy = p.mergePolicy ?? 'draft';

    let commitSha: string;
    let against: string | undefined;
    let changeNumber: number | null = null;
    let base = p.base;
    if (p.changeNumber !== undefined) {
      const row = await readChange(cx.env, cx.repo.id, p.changeNumber);
      if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
      if (row.state !== 'merged' || !row.merge_commit) return fail(409, `change ${row.number} has not merged`, 'CHANGE_NOT_MERGED');
      commitSha = row.merge_commit;
      // base_sha is the target the change landed on (recorded with the merge), which also covers a fast-forward of several commits.
      if (row.base_sha) against = row.base_sha;
      changeNumber = row.number;
      base ??= row.base_ref;
    } else {
      commitSha = p.sha!;
    }
    base ??= cx.repo.default_branch;
    const denied = agentMergeDenial(cx.actor, base, mergePolicy);
    if (denied) return denied;

    const planned = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const baseSha = (await lsRefs(ctx, [branchRef(base)])).get(branchRef(base)) ?? null;
      if (!baseSha) return fail(422, `base branch not found: ${base}`, 'REF_NOT_FOUND', { ref: base });
      let meta: ArtifactsCommitMetadata | null;
      try {
        meta = await (await artifacts.get()).readCommit(commitSha);
      } catch (err) {
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== 'INVALID_INPUT' && code !== 'NOT_FOUND') throw err;
        meta = null;
      }
      if (!meta || meta.hash !== commitSha) return fail(404, `commit not found: ${commitSha}`, 'COMMIT_NOT_FOUND');
      const r = await revertTree(artifactsMergeSources(ctx), { commit: commitSha, target: baseSha, ...(against ? { against } : {}) }, { ...MERGE_BUDGETS });
      switch (r.status) {
        case 'missing':
          return r.missing === 'commit'
            ? fail(404, `commit not found: ${commitSha}`, 'COMMIT_NOT_FOUND')
            : fail(503, `could not read the revert inputs (${r.missing})`, 'REVERT_READ_FAILED');
        case 'conflicts':
          return fail(409, `the revert of ${commitSha} does not apply cleanly to ${base}: ${r.conflicts.length} path(s) conflict`, 'REVERT_CONFLICT', {
            ref: base,
            headSha: baseSha,
            ...conflictList(r.conflicts),
          });
        case 'empty':
          return fail(409, `reverting ${commitSha} changes nothing on ${base}`, 'NOTHING_TO_REVERT', { ref: base, headSha: baseSha });
        case 'unknown':
          return READ_FAILURES.has(r.truncatedReason ?? 'readError')
            ? fail(503, `could not read the revert inputs (${r.truncatedReason ?? 'readError'})`, 'REVERT_READ_FAILED')
            : fail(422, `the revert exceeds the ${r.truncatedReason} budget`, 'REVERT_TOO_LARGE', { reason: r.truncatedReason });
      }
      // A fast-forwarded change set of several commits reverts as one range; its message must not name only the head.
      const range = against !== undefined && meta.parents[0] !== against;
      return { ok: true as const, value: { baseSha, r, subject: meta.message, range } };
    });
    if (!planned.ok) return planned;
    const { baseSha, r, subject, range } = planned.value;

    const time = Math.floor(Date.now() / 1000);
    const committer: GitIdent = { ...KVARM_COMMITTER, time };
    const who = mergeAuthor(cx.actor);
    const author: GitIdent = who ? { ...who, time } : committer;
    const message = revertMessage({ subject, commit: commitSha, parent: r.parent, merge: r.merge, range, ...(p.reason ? { reason: p.reason } : {}) });
    const commit = await buildCommit({ tree: r.treeHash!, parents: [baseSha], author, committer, message });
    const branch = revertBranch(commitSha, origin.branchKey ?? randomSuffix());
    const ref = branchRef(branch);

    const pusher = deps.pusher(cx.env, cx.repo);
    // The branch is only reachable through its change; a failure to open the change removes it (compare-and-swap, best effort).
    const removeBranch = () => pusher.updateRef({ ref, oldOid: commit.hash, newOid: ZERO_OID }).catch(() => undefined);
    const pushed = await pusher.updateRef({ ref, oldOid: ZERO_OID, newOid: commit.hash }, [commit, ...r.objects]);
    if (pushed.status === 'stale') return fail(409, `the revert branch ${branch} already exists`, 'REVERT_BRANCH_EXISTS', { ref: branch });
    let created = pushed.status === 'ok';
    if (pushed.status === 'unknown') {
      const live = await liveRef(cx, ref).catch(() => undefined);
      created = live === commit.hash;
      if (live === undefined) await removeBranch();
    }
    if (!created) {
      return fail(502, `the revert branch could not be created (${pushed.status}${pushed.reason ? `: ${pushed.reason}` : ''})`, 'REF_CREATE_FAILED');
    }

    const title = p.title ?? message.split('\n', 1)[0]!.slice(0, CHANGE_LIMITS.titleMax);
    const body = [message.split('\n\n').slice(1).join('\n\n').trim(), origin.note].filter(Boolean).join('\n\n');
    let change: ServiceResult<CreatedChangeDetail>;
    try {
      change = await createChange(cx, { title, body, base, head: branch, mergePolicy }, { kind: 'revert' });
    } catch (err) {
      // Another request opened the change on this branch first (one change per revert branch, migration 0031); the branch is its head now.
      if (isUniqueViolation(err)) return fail(409, `the revert branch ${branch} already has a change`, 'REVERT_BRANCH_EXISTS', { ref: branch });
      await removeBranch();
      throw err;
    }
    if (!change.ok) {
      await removeBranch();
      return change;
    }
    return {
      ok: true,
      value: {
        revert: { sha: commitSha, parent: r.parent, merge: r.merge, changeNumber, branch, commit: commit.hash, treeSha: r.treeHash!, reason: p.reason ?? null },
        change: change.value,
      },
    };
  });
}
