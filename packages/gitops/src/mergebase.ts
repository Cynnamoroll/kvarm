/**
 * Budgeted merge-base over a commit reader (`git merge-base --all`).
 *
 * Both tips paint their ancestors; a commit reached from both sides is a
 * common ancestor, and everything below one is painted stale because it can
 * never be a best base. Without commit dates there is no reliable
 * newest-first order, so painting runs to a fixpoint: a commit is revisited
 * whenever it gains a flag. The walk stops once only stale commits remain
 * queued and at most one candidate is left; with several candidates (a
 * criss-cross) stale painting continues until candidates that are ancestors
 * of others are eliminated or the queue drains. Commit reads are bounded and
 * a spent budget reports `truncated` rather than a guess.
 */

export interface CommitInfo {
  parents: string[];
  treeHash: string;
}

/** Anything that can read a commit's parents and tree by object id. */
export interface CommitReader {
  readCommit(sha: string): Promise<CommitInfo | null>;
}

export interface MergeBaseOptions {
  /** Max distinct readCommit calls before truncating (default 2_000). */
  maxCommitReads?: number;
  /** Max readCommit calls in flight (default 8). */
  concurrency?: number;
}

export type MergeBaseTruncation = 'maxCommitReads' | 'missingCommit' | 'readError';

export interface MergeBaseResult {
  /** Best common ancestors; empty for unrelated histories (or when truncated). */
  bases: string[];
  /** True when the answer is unknown: a budget, a missing commit or a failed read stopped the walk. */
  truncated: boolean;
  truncatedReason?: MergeBaseTruncation;
  /** The commit the reader could not find, for `missingCommit`. */
  missingCommit?: string;
  /** Message of the failed read, for `readError`. */
  readError?: string;
  commitReads: number;
}

const ONE = 1;
const TWO = 2;
const STALE = 4;
const DEFAULT_MAX_COMMIT_READS = 2_000;
const DEFAULT_CONCURRENCY = 8;

type Loaded = { parents: string[] } | { missing: true } | { error: string };

export async function mergeBase(reader: CommitReader, a: string, b: string, opts: MergeBaseOptions = {}): Promise<MergeBaseResult> {
  if (a === b) return { bases: [a], truncated: false, commitReads: 0 };
  const maxReads = opts.maxCommitReads ?? DEFAULT_MAX_COMMIT_READS;
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  const flags = new Map<string, number>();
  const loaded = new Map<string, Loaded>();
  const queue: string[] = [];
  let head = 0;
  const queued = new Set<string>();
  let nonStaleQueued = 0;
  const results: string[] = [];
  let reads = 0;

  const paint = (sha: string, add: number): void => {
    const old = flags.get(sha) ?? 0;
    const next = old | add;
    if (next === old) return;
    flags.set(sha, next);
    if (queued.has(sha)) {
      if (!(old & STALE) && next & STALE) nonStaleQueued--;
      return;
    }
    queued.add(sha);
    queue.push(sha);
    if (!(next & STALE)) nonStaleQueued++;
  };
  const live = (): string[] => results.filter((r) => !((flags.get(r) ?? 0) & STALE));
  const stop = (reason: MergeBaseTruncation, extra: Partial<MergeBaseResult> = {}): MergeBaseResult => ({
    bases: [],
    truncated: true,
    truncatedReason: reason,
    commitReads: reads,
    ...extra,
  });

  paint(a, ONE);
  paint(b, TWO);

  while (head < queue.length) {
    if (nonStaleQueued === 0 && live().length <= 1) break;
    const sha = queue[head]!;

    if (!loaded.has(sha)) {
      // Read the next few queued commits together; they are almost always needed.
      const batch: string[] = [];
      for (let i = head; i < queue.length && batch.length < concurrency; i++) {
        const s = queue[i]!;
        if (!loaded.has(s) && !batch.includes(s)) batch.push(s);
      }
      const allowed = batch.slice(0, Math.max(0, maxReads - reads));
      if (allowed.length === 0) return stop('maxCommitReads');
      reads += allowed.length;
      const got = await Promise.allSettled(allowed.map((s) => reader.readCommit(s)));
      got.forEach((r, i) => {
        const s = allowed[i]!;
        if (r.status === 'rejected') loaded.set(s, { error: String(r.reason) });
        else if (r.value === null) loaded.set(s, { missing: true });
        else loaded.set(s, { parents: r.value.parents });
      });
    }

    const info = loaded.get(sha)!;
    if ('error' in info) return stop('readError', { readError: info.error });
    if ('missing' in info) return stop('missingCommit', { missingCommit: sha });

    head++;
    queued.delete(sha);
    const f = flags.get(sha)!;
    if (!(f & STALE)) nonStaleQueued--;
    let carry = f & (ONE | TWO | STALE);
    if ((f & (ONE | TWO)) === (ONE | TWO)) {
      if (!(f & STALE) && !results.includes(sha)) results.push(sha);
      carry |= STALE;
    }
    for (const p of info.parents) paint(p, carry);
  }

  return { bases: live(), truncated: false, commitReads: reads };
}

/** Whether `ancestor` is reachable from `descendant` (a fast-forward check). */
export async function isAncestor(
  reader: CommitReader,
  ancestor: string,
  descendant: string,
  opts: MergeBaseOptions = {},
): Promise<{ ancestor: boolean; truncated: boolean }> {
  const r = await mergeBase(reader, ancestor, descendant, opts);
  if (r.truncated) return { ancestor: false, truncated: true };
  return { ancestor: r.bases.length === 1 && r.bases[0] === ancestor, truncated: false };
}
