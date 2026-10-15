/**
 * Per-commit changed paths for a path-history index.
 *
 * Each commit is diffed against its first parent's tree (the empty tree for a
 * root commit) as leaf paths. All commits share one tree-read budget and one
 * row budget (count and path bytes). A commit that cannot be indexed within
 * the budgets is a gap when it is the first commit of the call (so every call
 * makes progress) and ends the call otherwise; a commit with more changes
 * than the per-commit cap is always a gap. A gap is reported, never dropped
 * silently. A tree that cannot be read, or does not exist, is an error
 * (`HistoryReadError`), never an empty directory.
 */

import { diffTrees, type TreeChangeStatus, type TreeReader } from './treediff';

export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** A tree read failed or named a missing tree; nothing of the call should be recorded. */
export class HistoryReadError extends Error {
  override readonly name = 'HistoryReadError';
}

export interface HistoryCommit {
  sha: string;
  tree: string;
  /** First parent's tree; null for a root commit. */
  parentTree: string | null;
}

export interface IndexedCommit {
  sha: string;
  /** Changed leaf paths, sorted; empty for a gap. */
  changes: { path: string; status: TreeChangeStatus }[];
  /** The commit's changes could not be indexed within the budgets. */
  gap: boolean;
}

export interface HistoryBudget {
  /** Tree reads shared by all commits of the call. */
  maxTreeReads: number;
  /** Changed paths one commit may have before it becomes a gap. */
  maxChangesPerCommit: number;
  /** Path rows the whole call may produce. */
  maxRows: number;
  /** UTF-8 bytes of the paths of those rows (default unbounded). */
  maxRowBytes?: number;
  /** Commits to diff at once; completed results are still consumed in input order. */
  commitConcurrency?: number;
}

export interface HistoryIndexResult {
  /** A prefix of the input, in input order. */
  indexed: IndexedCommit[];
  treeReads: number;
  /** Why the call ended before the last commit; null when every commit was indexed. */
  stopped: 'maxTreeReads' | 'maxRows' | null;
}

const utf8 = new TextEncoder();

/** Cache tree reads by object id with LRU eviction; failed and missing reads are not retained. */
export function cachedTreeReader(source: TreeReader, maxEntries: number): TreeReader {
  type Entries = Awaited<ReturnType<TreeReader['readTree']>>;
  const limit = Math.max(0, Math.floor(maxEntries));
  const cache = new Map<string, Promise<Entries>>();
  return {
    readTree(hash) {
      if (limit === 0) return source.readTree(hash);
      const cached = cache.get(hash);
      if (cached) {
        cache.delete(hash);
        cache.set(hash, cached);
        return cached;
      }
      const pending = Promise.resolve().then(() => source.readTree(hash));
      cache.set(hash, pending);
      while (cache.size > limit) cache.delete(cache.keys().next().value!);
      void pending.then(
        (entries) => {
          if (entries === null && cache.get(hash) === pending) cache.delete(hash);
        },
        () => {
          if (cache.get(hash) === pending) cache.delete(hash);
        },
      );
      return pending;
    },
  };
}

export async function indexCommits(source: TreeReader, commits: readonly HistoryCommit[], budget: HistoryBudget): Promise<HistoryIndexResult> {
  const reader: TreeReader = {
    readTree: async (hash) => {
      // The empty tree need not exist as an object in the repository.
      if (hash === EMPTY_TREE_HASH) return [];
      const entries = await source.readTree(hash);
      // The diff would read a missing tree as an empty directory.
      if (!entries) throw new Error(`missing tree ${hash}`);
      return entries;
    },
  };
  const maxRowBytes = budget.maxRowBytes ?? Number.POSITIVE_INFINITY;
  const indexed: IndexedCommit[] = [];
  let treeReads = 0;
  let rows = 0;
  let rowBytes = 0;
  const concurrency = Math.max(1, Math.floor(budget.commitConcurrency ?? 1));
  for (let offset = 0; offset < commits.length; offset += concurrency) {
    const remaining = budget.maxTreeReads - treeReads;
    if (remaining <= 0) return { indexed, treeReads, stopped: 'maxTreeReads' };
    const batch = commits.slice(offset, offset + concurrency);
    const results = await Promise.all(
      batch.map(async (c) =>
        diffTrees(reader, c.parentTree ?? EMPTY_TREE_HASH, c.tree, {
          maxTreeReads: remaining,
          maxChanges: budget.maxChangesPerCommit + 1,
          detectRenames: false,
          leavesOnly: true,
        }),
      ),
    );
    for (let i = 0; i < batch.length; i++) {
      const c = batch[i]!;
      const d = results[i]!;
      const first = indexed.length === 0;
      const available = budget.maxTreeReads - treeReads;
      if (available <= 0) return { indexed, treeReads, stopped: 'maxTreeReads' };
      const overReadBudget = d.treeReads > available;
      treeReads += Math.min(d.treeReads, available);
      if (d.truncated && d.truncatedReason === 'readError') throw new HistoryReadError(`history: tree read failed: ${d.readError ?? 'unknown'}`);
      const tooMany = (d.truncated && d.truncatedReason === 'maxChanges') || d.changes.length > budget.maxChangesPerCommit;
      if (tooMany) {
        indexed.push({ sha: c.sha, changes: [], gap: true });
        continue;
      }
      if (overReadBudget || d.truncated) {
        // Later diffs in this batch may finish after the ordered budget is used.
        if (!first) return { indexed, treeReads, stopped: 'maxTreeReads' };
        indexed.push({ sha: c.sha, changes: [], gap: true });
        continue;
      }
      const bytes = d.changes.reduce((n, x) => n + utf8.encode(x.path).length, 0);
      if (rows + d.changes.length > budget.maxRows || rowBytes + bytes > maxRowBytes) {
        if (!first) return { indexed, treeReads, stopped: 'maxRows' };
        indexed.push({ sha: c.sha, changes: [], gap: true });
        continue;
      }
      rows += d.changes.length;
      rowBytes += bytes;
      indexed.push({ sha: c.sha, changes: d.changes.map((x) => ({ path: x.path, status: x.status })), gap: false });
    }
  }
  return { indexed, treeReads, stopped: null };
}
