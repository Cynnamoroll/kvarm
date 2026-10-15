/**
 * Merging (architecture §4 services/merge.ts, invariant 5, §0.3).
 *
 * `prepareMerge` plans a merge of `headSha` into a target branch at
 * `targetSha` and builds what publication needs: a fast-forward (the ref
 * moves to the head; mergeCommit = head) or a two-parent merge commit
 * [target, head] over gitops `merge3`'s tree, committed by Kvarm. It only
 * reads, so it runs outside any publication lease. `publishMerge` asks the
 * checks-gate about the exact tree being published, prepares the push
 * (write credential and pack), lets the caller revalidate (`beforeSend`),
 * then moves the one target ref through GitPusher with the target as the
 * expected old value; only a confirmed `ok` counts. A moved target is
 * `STALE_TARGET` (re-plan).
 *
 * Criss-cross histories (several merge bases) merge against a virtual base
 * tree, the bases merged recursively as git's ort strategy does (gitops
 * virtualBase.ts, architecture §3.1). More bases or deeper recursion than
 * the budgets allow, bases that conflict in a way the virtual tree cannot
 * hold, and merges whose renames git could pair differently from the
 * exact-rename model are refused as `MULTIPLE_MERGE_BASES` with the reason,
 * never merged against an arbitrary base or to a tree git would not write.
 *
 * Three-way merges run gitops' deterministic resolution stage (resolve.ts):
 * besides what git merges, a hunk whose two sides differ only in whitespace
 * takes the target's variant; lockfile conflicts are never resolved and are
 * marked `needsRegeneration`. Paths both sides changed that merged anyway
 * are listed in `resolved` with their rule.
 */

import {
  BlobTooLargeError,
  buildCommit,
  classifyConflicts,
  decode,
  deterministicResolver,
  merge3,
  mergeBase,
  parseTree,
  TreeReadBudgetError,
  virtualMergeBase,
  type ClassifiedConflict,
  type CommitInfo,
  type CommitReader,
  type GitIdent,
  type GitObject,
  type MergeReader,
  type MergeResolution,
  type TreeEntry,
} from '@kvarm/gitops';
import { isLockfilePath } from '@kvarm/review';
import type { ChecksGate, ChecksRepo, ChecksSubject, RequiredChecks } from './checksGate';
import type { GitPusher } from './gitwrite';
import { EMPTY_TREE, RefStoreUnavailable, readCommitInfo, type ResolveContext } from './refs';

/** Committer of every merge commit Kvarm writes; the author is the merging principal. */
export const KVARM_COMMITTER = { name: 'Kvarm', email: 'kvarm@kvarm.invalid' } as const;

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
  /**
   * Criss-cross histories: merge bases of any one pair, and the call depth
   * of the recursive merge that folds them into a virtual base. The inner
   * merges spend the read and created-bytes budgets above, shared with the
   * outer merge, so these two only bound the shape.
   */
  maxMergeBases: 8,
  maxVirtualDepth: 3,
};

/** Unknown-plan reasons that are a criss-cross the request path refuses (`MULTIPLE_MERGE_BASES`). */
const CRISS_CROSS_REFUSALS = new Map<string, string>([
  ['maxMergeBases', 'the head and the target have more merge bases than the maxMergeBases budget'],
  ['maxVirtualDepth', 'merging the merge bases recurses deeper than the maxVirtualDepth budget'],
  ['virtualConflict', 'the merge bases conflict in a way a virtual merge base cannot represent (rename, file/directory or type change)'],
  ['ambiguousRenames', "git's rename detection could pair the changed paths differently than an exact-rename merge would"],
  ['baseOrder', 'two merge bases share a commit time, so the order git would merge them in (which decides the virtual base) is unknown and the bases conflict'],
]);

/** Whether an `unknown` plan is a criss-cross the request path refuses; like a budget stop, it depends only on the two commits. */
export function isCrissCrossRefusal(unknownReason: string | undefined): boolean {
  return CRISS_CROSS_REFUSALS.has(unknownReason ?? '');
}

export type MergeBudgets = Partial<typeof MERGE_BUDGETS>;

const RESOLVE = { isLockfile: isLockfilePath };
const resolver = deterministicResolver(RESOLVE);

export type MergeConflict = ClassifiedConflict;

export interface MergeSources extends CommitReader, MergeReader {}

function parseCommitObject(o: GitObject): CommitInfo {
  const text = decode(o.raw.subarray(o.raw.indexOf(0) + 1));
  const head = text.split('\n\n')[0] ?? '';
  const committedAt = /^committer .* (\d+) [+-]\d{4}$/m.exec(head)?.[1];
  return {
    treeHash: /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? '',
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
    ...(committedAt === undefined ? {} : { committedAt: Number(committedAt) }),
  };
}

/** Merge inputs that also see prepared, not yet published objects (their commits, trees and blobs). */
export function overlaySources(inner: MergeSources, objects: Map<string, GitObject>): MergeSources {
  return {
    async readCommit(sha) {
      const o = objects.get(sha);
      return o?.type === 'commit' ? parseCommitObject(o) : inner.readCommit(sha);
    },
    async readTree(hash) {
      const o = objects.get(hash);
      return o?.type === 'tree' ? parseTree(o.raw) : inner.readTree(hash);
    },
    async readBlob(hash) {
      const o = objects.get(hash);
      return o?.type === 'blob' ? o.raw.slice(o.raw.indexOf(0) + 1) : inner.readBlob(hash);
    },
  };
}

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
  /** The merge base; for a criss-cross, the first of `mergeBases`. */
  mergeBase: string | null;
  /** Every merge base, sorted, when there are several (the merge ran against their virtual merge). */
  mergeBases?: string[];
  /** The tree publication would produce (the head tree for a fast-forward); null unless fast-forward or clean. */
  treeSha: string | null;
  conflicts: MergeConflict[];
  /** Paths both sides changed that merged cleanly, with the rule that merged each (three-way merges only). */
  resolved: MergeResolution[];
  /**
   * For `unknown`: the budget or read failure that stopped planning; for a
   * criss-cross the request path refuses, `maxMergeBases`, `maxVirtualDepth`,
   * `virtualConflict`, `ambiguousRenames` or `baseOrder`.
   */
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
  subject?: ChecksSubject;
  budgets?: MergeBudgets;
}

export interface PreparedMerge {
  kind: 'fast-forward' | 'merge';
  targetSha: string;
  headSha: string;
  /** The merge base; for a criss-cross, the first of `mergeBases`. */
  mergeBase: string;
  /** Every merge base, sorted, when there are several. */
  mergeBases?: string[];
  treeSha: string;
  /** The commit the target ref will point at: the head for a fast-forward. */
  mergeCommit: string;
  /** Objects the remote may lack: the merge commit, merged blobs and rebuilt trees. */
  objects: GitObject[];
  resolved: MergeResolution[];
  work: MergeWork;
}

export interface PrepareInput {
  targetSha: string;
  headSha: string;
  message: string;
  /** Defaults to the Kvarm committer. */
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
  subject?: ChecksSubject;
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
  | { ok: false; status: number; error: string; code: MergeErrorCode; reason?: string; conflicts?: MergeConflict[]; checks?: RequiredChecks };

interface MergePlan {
  status: MergeStatus;
  mergeBase: string | null;
  mergeBases?: string[];
  treeSha: string | null;
  conflicts: MergeConflict[];
  resolved: MergeResolution[];
  objects: GitObject[];
  unknownReason?: string;
  work: MergeWork;
}

const READ_FAILURES = new Set(['missingCommit', 'missingObject', 'readError']);

/** Memoizes and counts commit reads so the merge-base walk and tree lookups share them. */
export class CommitCache implements CommitReader {
  reads = 0;
  private readonly seen = new Map<string, Promise<CommitInfo | null>>();

  constructor(private readonly source: CommitReader) {}

  has(sha: string): boolean {
    return this.seen.has(sha);
  }

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

export interface SharedTrees extends MergeSources {
  /** Distinct trees fetched so far. */
  fetched(): number;
}

/**
 * Tree reads memoized across the merges of one criss-cross (the virtual
 * base's inner merges and the outer merge mostly read the same subtrees),
 * with one budget on distinct fetches: past it a read throws
 * `TreeReadBudgetError`, which a merge reports as `maxTreeReads`.
 */
export function sharedTrees(sources: MergeSources, maxTreeReads: number): SharedTrees {
  const trees = new Map<string, Promise<TreeEntry[] | null>>();
  return {
    readCommit: (sha) => sources.readCommit(sha),
    readTree(hash) {
      let p = trees.get(hash);
      if (!p) {
        if (trees.size >= maxTreeReads) return Promise.reject(new TreeReadBudgetError(hash));
        p = sources.readTree(hash);
        trees.set(hash, p);
      }
      return p;
    },
    readBlob: (hash) => sources.readBlob(hash),
    fetched: () => trees.size,
  };
}

export type VirtualBaseOutcome =
  | { ok: true; treeHash: string; sources: MergeSources; objects: GitObject[]; work: { blobReads: number; bytes: number } }
  | { ok: false; reason: string; work: { blobReads: number; bytes: number } };

/**
 * The virtual merge base of a criss-cross (architecture §3.1) within budget
 * `b`. Commits go through `commits`, so the inner walks pay only for commits
 * the outer walk has not read; trees go through `trees`, whose fetches the
 * caller counts. The returned sources also serve the virtual objects, for
 * the merge that uses the virtual base; the caller gives that merge what is
 * left of the blob and created-bytes budgets.
 */
export async function crissCrossBase(trees: SharedTrees, commits: CommitCache, bases: readonly string[], b: typeof MERGE_BUDGETS): Promise<VirtualBaseOutcome> {
  const reader: MergeSources = { readCommit: (sha) => commits.readCommit(sha), readTree: (h) => trees.readTree(h), readBlob: (h) => trees.readBlob(h) };
  const v = await virtualMergeBase(reader, bases, {
    ...b,
    mayReadCommit: (sha) => commits.has(sha) || commits.reads < b.maxCommitReads,
    refuseAmbiguousRenames: true,
  });
  const work = { blobReads: v.blobReads, bytes: v.objects.reduce((n, o) => n + o.raw.length + o.store.length, 0) };
  if (v.truncated || v.treeHash === null) return { ok: false, reason: v.truncatedReason ?? 'readError', work };
  return { ok: true, treeHash: v.treeHash, sources: overlaySources(reader, new Map(v.objects.map((o) => [o.hash, o]))), objects: v.objects, work };
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
    resolved: [],
    objects: [],
    unknownReason: reason,
    work: work(),
    ...extra,
  });

  const mb = await mergeBase(commits, targetSha, headSha, { maxCommitReads: b.maxCommitReads, concurrency: b.concurrency });
  if (mb.truncated) return unknown(mb.truncatedReason ?? 'readError');
  const none = { treeSha: null, conflicts: [], resolved: [], objects: [] };
  if (mb.bases.includes(headSha)) return { status: 'up-to-date', mergeBase: headSha, ...none, work: work() };
  if (mb.bases.length === 0) return { status: 'unrelated', mergeBase: null, ...none, work: work() };
  const bases = [...mb.bases].sort();
  const base = bases[0]!;
  const several = bases.length > 1 ? { mergeBases: bases } : {};

  let trees: Array<CommitInfo | null>;
  try {
    trees = await Promise.all([commits.readCommit(base), commits.readCommit(targetSha), commits.readCommit(headSha)]);
  } catch {
    return unknown('readError', { mergeBase: base, ...several });
  }
  const [baseCommit, targetCommit, headCommit] = trees;
  if (!baseCommit || !targetCommit || !headCommit) return unknown('missingCommit', { mergeBase: base, ...several });

  if (bases.length === 1 && base === targetSha) {
    return { status: 'fast-forward', mergeBase: base, treeSha: headCommit.treeHash, conflicts: [], resolved: [], objects: [], work: work() };
  }

  // Criss-cross: merge the bases into a virtual base tree first (architecture §3.1); its
  // inner merges spend the same read and created-bytes budgets as the outer merge.
  let baseTree = baseCommit.treeHash;
  let mergeSources = sources;
  let virtualWork = { blobReads: 0, bytes: 0 };
  let shared: SharedTrees | null = null;
  if (bases.length > 1) {
    shared = sharedTrees(sources, b.maxTreeReads);
    const v = await crissCrossBase(shared, commits, bases, b);
    virtualWork = v.work;
    if (!v.ok) {
      return { ...unknown(v.reason, { mergeBase: base, ...several }), work: { commitReads: commits.reads, treeReads: shared.fetched(), blobReads: v.work.blobReads } };
    }
    baseTree = v.treeHash;
    mergeSources = v.sources;
  }

  const m = await merge3(mergeSources, baseTree, targetCommit.treeHash, headCommit.treeHash, {
    // Over shared trees the reader enforces maxTreeReads on distinct fetches, the virtual base's included.
    maxTreeReads: shared ? Number.MAX_SAFE_INTEGER : b.maxTreeReads,
    maxChanges: b.maxChanges,
    maxBlobReads: b.maxBlobReads - virtualWork.blobReads,
    maxBlobBytes: b.maxBlobBytes,
    nodeBudget: b.nodeBudget,
    concurrency: b.concurrency,
    maxMergedBytes: b.maxMergedBytes - virtualWork.bytes,
    contentConcurrency: b.contentConcurrency,
    resolver,
    // Over a virtual base the result must be git's; refuse what the exact-rename model cannot vouch for.
    refuseAmbiguousRenames: bases.length > 1,
  });
  const mergeWork = { commitReads: commits.reads, treeReads: shared ? shared.fetched() : m.treeReads, blobReads: virtualWork.blobReads + m.blobReads };
  if (m.truncated) return { ...unknown(m.truncatedReason ?? 'readError', { mergeBase: base, ...several }), work: mergeWork };
  if (!m.clean) {
    return {
      status: 'conflicts',
      mergeBase: base,
      ...several,
      treeSha: null,
      conflicts: classifyConflicts(m.conflicts, RESOLVE),
      resolved: [],
      objects: [],
      work: mergeWork,
    };
  }
  return { status: 'clean', mergeBase: base, ...several, treeSha: m.treeHash, conflicts: [], resolved: m.resolved, objects: m.objects, work: mergeWork };
}

/** Mergeability without the checks: the merge plan of a commit pair only. */
export type MergePlanView = Omit<Mergeability, 'checks' | 'mergeable'>;

/** The merge plan alone, for callers that need the merge outcome but not the required checks. */
export async function computeMergePlan(sources: MergeSources, input: Omit<MergeabilityInput, 'repo' | 'configId'>): Promise<MergePlanView> {
  const p = await plan(sources, input.targetSha, input.headSha, input.budgets);
  return {
    targetSha: input.targetSha,
    headSha: input.headSha,
    status: p.status,
    fastForward: p.status === 'fast-forward',
    mergeBase: p.mergeBase,
    ...(p.mergeBases ? { mergeBases: p.mergeBases } : {}),
    treeSha: p.treeSha,
    conflicts: p.conflicts,
    resolved: p.resolved,
    ...(p.unknownReason !== undefined ? { unknownReason: p.unknownReason } : {}),
    work: p.work,
  };
}

export async function computeMergeability(sources: MergeSources, gate: ChecksGate, input: MergeabilityInput): Promise<Mergeability> {
  const p = await computeMergePlan(sources, input);
  const checks = p.treeSha ? await gate.requiredChecksFor(input.repo, p.treeSha, input.configId ?? null, input.subject) : null;
  return { ...p, checks, mergeable: (p.status === 'fast-forward' || p.status === 'clean') && checks?.state === 'success' };
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
      {
        const refusal = CRISS_CROSS_REFUSALS.get(p.unknownReason ?? '');
        if (refusal) return { ok: false, status: 422, error: refusal, code: 'MULTIPLE_MERGE_BASES', reason: p.unknownReason! };
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
  const common = {
    targetSha: input.targetSha,
    headSha: input.headSha,
    mergeBase: p.mergeBase,
    ...(p.mergeBases ? { mergeBases: p.mergeBases } : {}),
    treeSha: p.treeSha,
    resolved: p.resolved,
    work: p.work,
  };
  if (p.status === 'fast-forward') {
    return { ok: true, value: { kind: 'fast-forward', ...common, mergeCommit: input.headSha, objects: [] } };
  }
  const time = input.now ?? Math.floor(Date.now() / 1000);
  const committer: GitIdent = { ...KVARM_COMMITTER, time };
  const author: GitIdent = input.author ? { name: input.author.name, email: input.author.email, time } : committer;
  const commit = await buildCommit({ tree: p.treeSha, parents: [input.targetSha, input.headSha], author, committer, message: input.message });
  return { ok: true, value: { kind: 'merge', ...common, mergeCommit: commit.hash, objects: [commit, ...p.objects] } };
}

function checkNames(checks: RequiredChecks, state: 'failure' | 'pending'): string {
  return checks.required
    .filter((c) => c.state === state)
    .map((c) => c.name)
    .join(', ');
}

export async function publishMerge(deps: PublishDeps, target: MergeTarget, prepared: PreparedMerge): Promise<MergeResult<MergePublished>> {
  const checks = await deps.gate.requiredChecksFor(target.repo, prepared.treeSha, target.configId ?? null, target.subject);
  if (checks.state === 'failure') {
    return { ok: false, status: 409, error: `required check ${checkNames(checks, 'failure')} failed`, code: 'REQUIRED_CHECKS_FAILED', checks };
  }
  if (checks.state === 'pending') {
    return { ok: false, status: 409, error: `required check ${checkNames(checks, 'pending')} has not finished`, code: 'REQUIRED_CHECKS_PENDING', checks };
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
      return c ? { treeHash: c.tree, parents: c.parents, committedAt: c.committedAt } : null;
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
