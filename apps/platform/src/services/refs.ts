/**
 * Commit-ish resolution for compare and diffs: branch/tag names and full
 * commit SHAs to {sha, tree}.
 *
 * Names resolve through one protocol-v2 `ls-refs` upload-pack request for
 * all names at once (a subrequest, not an Artifacts RPC), then commits map
 * to trees through the immutable repo-scoped commit cache or `readCommit`.
 * Resolved names are kept for REF_TTL_SECONDS under the repo's current ref
 * generation, which a push through the git gate replaces.
 *
 * With `bypass`, the mutable ref cache is neither read nor written and no
 * entry of any kind is written; immutable commit entries may still be read.
 */

import { lsRefsRequest, parseLsRefs, pickRef, refCandidates } from '@forge/gitops';
import type { RepoRow } from '../db/repos';
import type { LazyRepo } from '../artifacts/repo';
import { getGitToken } from '../artifacts/tokens';
import { REF_TTL_SECONDS, compareKeys, readJson, refGeneration, writeJson } from '../cache/compare';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SHA_RE = /^[0-9a-f]{40}$/;

export interface ResolvedCommit {
  sha: string;
  tree: string;
}

export interface CommitWithParents extends ResolvedCommit {
  parents: string[];
}

interface CommitEntry {
  tree: string;
  parents: string[];
}

export interface ResolveContext {
  env: Env;
  repo: RepoRow;
  artifacts: LazyRepo;
  bypass: boolean;
  waitUntil(p: Promise<unknown>): void;
}

/** The git endpoint behind ref resolution failed; callers answer 503. */
export class RefStoreUnavailable extends Error {}

export function isFullSha(ref: string): boolean {
  return SHA_RE.test(ref);
}

/** A ref name the compare routes accept (git check-ref-format, loosely). */
export function isValidRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false;
  if (ref.startsWith('/') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x20\x7f~^:?*[\\]/.test(ref);
}

function isInvalidObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'INVALID_INPUT' || code === 'NOT_FOUND';
}

function remember(ctx: ResolveContext, sha: string, entry: CommitEntry): void {
  if (!ctx.bypass) ctx.waitUntil(writeJson(compareKeys.commit(ctx.repo.id, sha), JSON.stringify(entry)));
}

/** A commit's tree and parents from the commit cache or one `readCommit`. */
export async function readCommitInfo(ctx: ResolveContext, sha: string): Promise<CommitWithParents | null> {
  const cached = await readJson<CommitEntry>(compareKeys.commit(ctx.repo.id, sha));
  if (cached) return { sha, tree: cached.tree, parents: cached.parents };
  let commit: ArtifactsCommitMetadata | null;
  try {
    commit = await (await ctx.artifacts.get()).readCommit(sha);
  } catch (err) {
    if (isInvalidObject(err)) return null;
    throw err;
  }
  if (!commit || commit.hash !== sha) return null;
  remember(ctx, sha, { tree: commit.treeHash, parents: commit.parents });
  return { sha, tree: commit.treeHash, parents: commit.parents };
}

/**
 * A commit and its first parent (null for a root commit). An uncached commit
 * costs one `log` call that returns both.
 */
export async function readCommitAndParent(
  ctx: ResolveContext,
  sha: string,
): Promise<{ commit: CommitWithParents; parent: CommitWithParents | null } | null> {
  const cached = await readJson<CommitEntry>(compareKeys.commit(ctx.repo.id, sha));
  let commit: CommitWithParents;
  let parent: CommitWithParents | null = null;
  if (cached) {
    commit = { sha, tree: cached.tree, parents: cached.parents };
  } else {
    let log: ArtifactsCommitMetadata[];
    try {
      log = await (await ctx.artifacts.get()).log({ ref: sha, limit: 2 });
    } catch (err) {
      if (isInvalidObject(err)) return null;
      throw err;
    }
    const head = log[0];
    if (!head || head.hash !== sha) return null;
    commit = { sha, tree: head.treeHash, parents: head.parents };
    remember(ctx, sha, { tree: head.treeHash, parents: head.parents });
    const p = log[1];
    if (p && p.hash === head.parents[0]) {
      parent = { sha: p.hash, tree: p.treeHash, parents: p.parents };
      remember(ctx, p.hash, { tree: p.treeHash, parents: p.parents });
    }
  }
  const parentSha = commit.parents[0];
  if (!parentSha) return { commit, parent: null };
  parent ??= await readCommitInfo(ctx, parentSha);
  return parent ? { commit, parent } : null;
}

/** Name -> commit oid for every name, through a single ls-refs round trip. */
async function lsRefs(ctx: ResolveContext, names: string[]): Promise<Map<string, string | null>> {
  let res: Response;
  try {
    const token = await getGitToken(ctx.env, ctx.repo.artifacts_name, 'read', ctx.artifacts.get);
    res = await fetch(`${ctx.repo.artifacts_remote}/git-upload-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`forge:${token}`)}`,
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
        'Git-Protocol': 'version=2',
      },
      body: lsRefsRequest(names.flatMap(refCandidates)),
    });
  } catch (err) {
    throw new RefStoreUnavailable(`ls-refs failed: ${String(err).slice(0, 200)}`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new RefStoreUnavailable(`ls-refs failed (${res.status})`);
  }
  let refs;
  try {
    refs = parseLsRefs(new Uint8Array(await res.arrayBuffer()));
  } catch (err) {
    throw new RefStoreUnavailable(String(err));
  }
  return new Map(names.map((n) => [n, pickRef(refs, n)]));
}

/**
 * Resolves each commit-ish to {sha, tree}; null marks an unknown ref, an
 * unknown commit, or a ref that does not point at a commit.
 */
export async function resolveCommitish(
  ctx: ResolveContext,
  names: string[],
): Promise<Map<string, ResolvedCommit | null>> {
  const unique = [...new Set(names)];
  const out = new Map<string, ResolvedCommit | null>();
  const refNames = unique.filter((n) => !isFullSha(n));

  const gen = refNames.length > 0 && !ctx.bypass ? await refGeneration(ctx.repo.id) : '0';
  const uncached: string[] = [];
  await Promise.all(
    refNames.map(async (name) => {
      const hit = ctx.bypass ? undefined : await readJson<ResolvedCommit>(compareKeys.ref(ctx.repo.id, gen, name));
      if (hit) out.set(name, hit);
      else uncached.push(name);
    }),
  );
  const oids = uncached.length > 0 ? await lsRefs(ctx, uncached) : new Map<string, string | null>();

  const toCommit = new Map<string, string>();
  for (const name of unique) {
    if (isFullSha(name)) toCommit.set(name, name);
    else if (uncached.includes(name)) {
      const oid = oids.get(name) ?? null;
      if (oid) toCommit.set(name, oid);
      else out.set(name, null);
    }
  }
  await Promise.all(
    [...toCommit].map(async ([name, oid]) => {
      const info = await readCommitInfo(ctx, oid);
      const resolved = info ? { sha: info.sha, tree: info.tree } : null;
      out.set(name, resolved);
      if (resolved && !isFullSha(name) && !ctx.bypass) {
        ctx.waitUntil(writeJson(compareKeys.ref(ctx.repo.id, gen, name), JSON.stringify(resolved), REF_TTL_SECONDS));
      }
    }),
  );
  return out;
}
