/**
 * Merging (architecture §4 services/merge.ts, invariant 5, §0.3).
 *
 * `prepareMerge` plans a merge of `headSha` into a target branch at
 * `targetSha` and builds what publication needs: a fast-forward (the ref
 * moves to the head; mergeCommit = head) or a two-parent merge commit
 * [target, head] over gitops `merge3`'s tree, committed by Forge. It only
 * reads, so it runs outside any publication lease. `publishMerge` asks the
 * checks-gate about the exact tree being published, prepares the push
 * (write credential and pack), lets the caller revalidate (`beforeSend`),
 * then moves the one target ref through GitPusher with the target as the
 * expected old value; only a confirmed `ok` counts. A moved target is
 * `STALE_TARGET` (re-plan).
 *
 * Criss-cross histories (several merge bases) are refused as
 * `MULTIPLE_MERGE_BASES` rather than merged against an arbitrary base.
 */

import {
  BlobTooLargeError,
  buildCommit,
  merge3,
  mergeBase,
  type CommitInfo,
  type CommitReader,
  type GitIdent,
  type GitObject,
  type MergeConflict,
  type MergeReader,
  type TreeEntry,
} from '@forge/gitops';
import type { ChecksGate, ChecksRepo, RequiredChecks } from './checksGate';
import type { GitPusher } from './gitwrite';
import { EMPTY_TREE, RefStoreUnavailable, readCommitInfo, type ResolveContext } from './refs';

/** Committer of every merge commit Forge writes; the author is the merging principal. */
export const FORGE_COMMITTER = { name: 'Forge', email: 'forge@forge.invalid' } as const;

/**
 * Per-merge work budgets. Every commit, tree and blob read is one Artifacts
 * RPC (commits may hit the commit cache), keeping a merge well inside the
 * Workers subrequest limit.
 */
export const MERGE_BUDGETS = {
  maxCommitReads: 2_000,
  maxTreeReads: 2_000,
  maxChanges: 20_000,
  maxBlobReads: 300,
  maxBlobBytes: 4 * 1024 * 1024,
  nodeBudget: 400_000,
  concurrency: 8,
  /** Raw plus compressed bytes of the objects a merge creates, held until publication. */
  maxMergedBytes: 16 * 1024 * 1024,
  contentConcurrency: 1,
};

export type MergeBudgets = Partial<typeof MERGE_BUDGETS>;

export interface MergeSources extends CommitReader, MergeReader {}

export type MergeStatus = 'fast-forward' | 'clean' | 'conflicts' | 'up-to-date' | 'unrelated' | 'unknown';

export interface MergeWork {
  commitReads: number;
  treeReads: number;
  blobReads: number;
}

export interface Mergeability {
  targetSha: string;
  headSha: string;
  status: MergeStatus;
  fastForward: boolean;
  mergeBase: string | null;
  /** The tree publication would produce (the head tree for a fast-forward); null unless fast-forward or clean. */
  treeSha: string | null;
  conflicts: MergeConflict[];
  /** For `unknown`: the budget or read failure that stopped planning, or `criss-cross`. */
  unknownReason?: string;
  /** Required checks for `treeSha`; null when there is no tree to check. */
  checks: RequiredChecks | null;
  /** Fast-forward or clean, and every required check passed. */
  mergeable: boolean;
  work: MergeWork;
}

export interface MergeabilityInput {
  repo: ChecksRepo;
  targetSha: string;
  headSha: string;
  configId?: string | null;
  budgets?: MergeBudgets;
}

export interface PreparedMerge {
  kind: 'fast-forward' | 'merge';
  targetSha: string;
  headSha: string;
  mergeBase: string;
  treeSha: string;
  /** The commit the target ref will point at: the head for a fast-forward. */
  mergeCommit: string;
  /** Objects the remote may lack: the merge commit, merged blobs and rebuilt trees. */
  objects: GitObject[];
  work: MergeWork;
}

export interface PrepareInput {
  targetSha: string;
  headSha: string;
  message: string;
  /** Defaults to the Forge committer. */
  author?: { name: string; email: string };
  /** Commit time in Unix seconds (default: now). */
  now?: number;
  budgets?: MergeBudgets;
}

export interface MergeTarget {
  repo: ChecksRepo;
  /** Full ref name, e.g. `refs/heads/main`. */
  ref: string;
  configId?: string | null;
}

export interface MergePublished {
  kind: 'fast-forward' | 'merge';
  ref: string;
  mergeCommit: string;
  treeSha: string;
  /** The target's value before the merge. */
  previous: string;
}

export interface MergeAttribution {
  repo: ChecksRepo;
  ref: string;
  kind: 'fast-forward' | 'merge';
  mergeCommit: string;
  targetSha: string;
  headSha: string;
}

/** Runs after a confirmed publication (attribution notes hook here); a failure is logged, never a merge failure. */
export type MergeAttributionHook = (merged: MergeAttribution) => Promise<void>;

export interface PublishDeps {
  pusher: GitPusher;
  gate: ChecksGate;
  attribution?: MergeAttributionHook;
  /**
   * Awaited once the checks-gate answer, the write credential and the pack
   * are ready, immediately before the receive-pack request. Returning false
   * cancels the publication without sending anything (`PUBLISH_CANCELLED`).
   */
  beforeSend?: () => Promise<boolean>;
}

export type MergeErrorCode =
  | 'MERGE_CONFLICT'
  | 'UP_TO_DATE'
  | 'UNRELATED_HISTORIES'
  | 'MULTIPLE_MERGE_BASES'
  | 'MERGE_TOO_LARGE'
  | 'MERGE_READ_FAILED'
  | 'REQUIRED_CHECKS_FAILED'
  | 'REQUIRED_CHECKS_PENDING'
  | 'STALE_TARGET'
  | 'PUBLISH_REJECTED'
  | 'PUBLISH_UNKNOWN'
  | 'PUBLISH_UNAVAILABLE'
  | 'PUBLISH_CANCELLED';

export type MergeResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; code: MergeErrorCode; conflicts?: MergeConflict[]; checks?: RequiredChecks };

interface MergePlan {
  status: MergeStatus;
  mergeBase: string | null;
  treeSha: string | null;
  conflicts: MergeConflict[];
  objects: GitObject[];
  unknownReason?: string;
  work: MergeWork;
}

const READ_FAILURES = new Set(['missingCommit', 'missingObject', 'readError']);

/** Memoizes and counts commit reads so the merge-base walk and tree lookups share them. */
class CommitCache implements CommitReader {
  reads = 0;
  private readonly seen = new Map<string, Promise<CommitInfo | null>>();

  constructor(private readonly source: CommitReader) {}

  readCommit(sha: string): Promise<CommitInfo | null> {
    let p = this.seen.get(sha);
    if (!p) {
      this.reads++;
      p = this.source.readCommit(sha);
      this.seen.set(sha, p);
    }
    return p;
  }
}

async function plan(sources: MergeSources, targetSha: string, headSha: string, budgets: MergeBudgets = {}): Promise<MergePlan> {
  const b = { ...MERGE_BUDGETS, ...budgets };
  const commits = new CommitCache(sources);
  const work = (): MergeWork => ({ commitReads: commits.reads, treeReads: 0, blobReads: 0 });
  const unknown = (reason: string, extra: Partial<MergePlan> = {}): MergePlan => ({
    status: 'unknown',
    mergeBase: null,
    treeSha: null,
    conflicts: [],
    objects: [],
    unknownReason: reason,
    work: work(),
    ...extra,
  });

  const mb = await mergeBase(commits, targetSha, headSha, { maxCommitReads: b.maxCommitReads, concurrency: b.concurrency });
  if (mb.truncated) return unknown(mb.truncatedReason ?? 'readError');
  const none = { treeSha: null, conflicts: [], objects: [] };
  if (mb.bases.includes(headSha)) return { status: 'up-to-date', mergeBase: headSha, ...none, work: work() };
  if (mb.bases.length === 0) return { status: 'unrelated', mergeBase: null, ...none, work: work() };
  if (mb.bases.length > 1) return unknown('criss-cross');
  const base = mb.bases[0]!;

  let trees: Array<CommitInfo | null>;
  try {
    trees = await Promise.all([commits.readCommit(base), commits.readCommit(targetSha), commits.readCommit(headSha)]);
  } catch {
    return unknown('readError', { mergeBase: base });
  }
  const [baseCommit, targetCommit, headCommit] = trees;
  if (!baseCommit || !targetCommit || !headCommit) return unknown('missingCommit', { mergeBase: base });

  if (base === targetSha) {
    return { status: 'fast-forward', mergeBase: base, treeSha: headCommit.treeHash, conflicts: [], objects: [], work: work() };
  }

  const m = await merge3(sources, baseCommit.treeHash, targetCommit.treeHash, headCommit.treeHash, {
    maxTreeReads: b.maxTreeReads,
    maxChanges: b.maxChanges,
    maxBlobReads: b.maxBlobReads,
    maxBlobBytes: b.maxBlobBytes,
    nodeBudget: b.nodeBudget,
    concurrency: b.concurrency,
    maxMergedBytes: b.maxMergedBytes,
    contentConcurrency: b.contentConcurrency,
  });
  const mergeWork = { commitReads: commits.reads, treeReads: m.treeReads, blobReads: m.blobReads };
  if (m.truncated) return { ...unknown(m.truncatedReason ?? 'readError', { mergeBase: base }), work: mergeWork };
  if (!m.clean) return { status: 'conflicts', mergeBase: base, treeSha: null, conflicts: m.conflicts, objects: [], work: mergeWork };
  return { status: 'clean', mergeBase: base, treeSha: m.treeHash, conflicts: [], objects: m.objects, work: mergeWork };
}

export async function computeMergeability(sources: MergeSources, gate: ChecksGate, input: MergeabilityInput): Promise<Mergeability> {
  const p = await plan(sources, input.targetSha, input.headSha, input.budgets);
  const checks = p.treeSha ? await gate.requiredChecksFor(input.repo, p.treeSha, input.configId ?? null) : null;
  return {
    targetSha: input.targetSha,
    headSha: input.headSha,
    status: p.status,
    fastForward: p.status === 'fast-forward',
    mergeBase: p.mergeBase,
    treeSha: p.treeSha,
    conflicts: p.conflicts,
    ...(p.unknownReason !== undefined ? { unknownReason: p.unknownReason } : {}),
    checks,
    mergeable: (p.status === 'fast-forward' || p.status === 'clean') && checks?.state === 'success',
    work: p.work,
  };
}

function planFailure(p: MergePlan): MergeResult<never> {
  switch (p.status) {
    case 'conflicts':
      return { ok: false, status: 409, error: `merge conflicts in ${p.conflicts.length} path(s)`, code: 'MERGE_CONFLICT', conflicts: p.conflicts };
    case 'up-to-date':
      return { ok: false, status: 409, error: 'the head is already contained in the target', code: 'UP_TO_DATE' };
    case 'unrelated':
      return { ok: false, status: 409, error: 'the head and the target share no history', code: 'UNRELATED_HISTORIES' };
    default:
      if (p.unknownReason === 'criss-cross') {
        return { ok: false, status: 422, error: 'the head and the target have several merge bases', code: 'MULTIPLE_MERGE_BASES' };
      }
      if (READ_FAILURES.has(p.unknownReason ?? 'readError')) {
        return { ok: false, status: 503, error: `could not read the merge inputs (${p.unknownReason})`, code: 'MERGE_READ_FAILED' };
      }
      return { ok: false, status: 422, error: `merge exceeds the ${p.unknownReason} budget`, code: 'MERGE_TOO_LARGE' };
  }
}

export async function prepareMerge(sources: MergeSources, input: PrepareInput): Promise<MergeResult<PreparedMerge>> {
  const p = await plan(sources, input.targetSha, input.headSha, input.budgets);
  if ((p.status !== 'fast-forward' && p.status !== 'clean') || !p.treeSha || !p.mergeBase) return planFailure(p);
  const common = { targetSha: input.targetSha, headSha: input.headSha, mergeBase: p.mergeBase, treeSha: p.treeSha, work: p.work };
  if (p.status === 'fast-forward') {
    return { ok: true, value: { kind: 'fast-forward', ...common, mergeCommit: input.headSha, objects: [] } };
  }
  const time = input.now ?? Math.floor(Date.now() / 1000);
  const committer: GitIdent = { ...FORGE_COMMITTER, time };
  const author: GitIdent = input.author ? { name: input.author.name, email: input.author.email, time } : committer;
  const commit = await buildCommit({ tree: p.treeSha, parents: [input.targetSha, input.headSha], author, committer, message: input.message });
  return { ok: true, value: { kind: 'merge', ...common, mergeCommit: commit.hash, objects: [commit, ...p.objects] } };
}

export async function publishMerge(deps: PublishDeps, target: MergeTarget, prepared: PreparedMerge): Promise<MergeResult<MergePublished>> {
  const checks = await deps.gate.requiredChecksFor(target.repo, prepared.treeSha, target.configId ?? null);
  if (checks.state === 'failure') {
    return { ok: false, status: 409, error: 'a required check failed', code: 'REQUIRED_CHECKS_FAILED', checks };
  }
  if (checks.state === 'pending') {
    return { ok: false, status: 409, error: 'required checks have not finished', code: 'REQUIRED_CHECKS_PENDING', checks };
  }

  let update;
  try {
    update = await deps.pusher.prepareUpdate({ ref: target.ref, oldOid: prepared.targetSha, newOid: prepared.mergeCommit }, prepared.objects);
  } catch (err) {
    if (!(err instanceof RefStoreUnavailable)) throw err;
    return { ok: false, status: 503, error: `git write unavailable: ${err.message}`, code: 'PUBLISH_UNAVAILABLE' };
  }
  if (deps.beforeSend && !(await deps.beforeSend())) {
    return { ok: false, status: 409, error: 'the publication was cancelled before it was sent', code: 'PUBLISH_CANCELLED' };
  }
  const r = await update.send();
  if (r.status === 'stale') {
    return { ok: false, status: 409, error: `${target.ref} moved since the merge was prepared`, code: 'STALE_TARGET' };
  }
  if (r.status === 'rejected') {
    return { ok: false, status: 502, error: `the git store rejected the update: ${r.reason ?? 'no reason'}`, code: 'PUBLISH_REJECTED' };
  }
  if (r.status !== 'ok') {
    // The ref may or may not have moved; the caller re-reads it before retrying.
    return { ok: false, status: 502, error: `the update's outcome is unknown: ${r.error ?? r.reason ?? `HTTP ${r.httpStatus}`}`, code: 'PUBLISH_UNKNOWN' };
  }

  if (deps.attribution) {
    try {
      await deps.attribution({
        repo: target.repo,
        ref: target.ref,
        kind: prepared.kind,
        mergeCommit: prepared.mergeCommit,
        targetSha: prepared.targetSha,
        headSha: prepared.headSha,
      });
    } catch (err) {
      console.warn(JSON.stringify({ mergeAttributionFailed: String(err).slice(0, 200), mergeCommit: prepared.mergeCommit }));
    }
  }
  return {
    ok: true,
    value: { kind: prepared.kind, ref: target.ref, mergeCommit: prepared.mergeCommit, treeSha: prepared.treeSha, previous: prepared.targetSha },
  };
}

function isInvalidObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'INVALID_INPUT' || code === 'NOT_FOUND';
}

/**
 * Merge inputs over one repo's Artifacts handle. Commits go through the
 * commit cache (`readCommitInfo`); tree modes are normalized to git's
 * canonical `40000` so rebuilt trees hash like git's; blobs over
 * `maxBlobBytes` are refused by size before their bytes are read.
 */
export function artifactsMergeSources(ctx: ResolveContext, maxBlobBytes: number = MERGE_BUDGETS.maxBlobBytes): MergeSources {
  return {
    async readCommit(sha) {
      const c = await readCommitInfo(ctx, sha);
      return c ? { treeHash: c.tree, parents: c.parents } : null;
    },
    async readTree(hash): Promise<TreeEntry[] | null> {
      if (hash === EMPTY_TREE) return [];
      let entries: ArtifactsTreeEntry[] | null;
      try {
        entries = await (await ctx.artifacts.get()).readTree(hash);
      } catch (err) {
        if (isInvalidObject(err)) return null;
        throw err;
      }
      return entries ? entries.map((e) => ({ mode: e.mode === '040000' ? '40000' : e.mode, name: e.name, hash: e.hash })) : null;
    },
    async readBlob(hash) {
      let blob: Blob | null;
      try {
        blob = await (await ctx.artifacts.get()).readBlob(hash);
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === 'MEMORY_LIMIT') throw new BlobTooLargeError(hash);
        if (isInvalidObject(err)) return null;
        throw err;
      }
      if (!blob) return null;
      if (blob.size > maxBlobBytes) throw new BlobTooLargeError(hash);
      return new Uint8Array(await blob.arrayBuffer());
    },
  };
}
