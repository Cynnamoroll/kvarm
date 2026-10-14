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
}

export interface HistoryIndexResult {
  /** A prefix of the input, in input order. */
  indexed: IndexedCommit[];
  treeReads: number;
  /** Why the call ended before the last commit; null when every commit was indexed. */
  stopped: 'maxTreeReads' | 'maxRows' | null;
}

const utf8 = new TextEncoder();

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
  for (const c of commits) {
    const first = indexed.length === 0;
    const remaining = budget.maxTreeReads - treeReads;
    if (remaining <= 0) return { indexed, treeReads, stopped: 'maxTreeReads' };
    const d = await diffTrees(reader, c.parentTree ?? EMPTY_TREE_HASH, c.tree, {
      maxTreeReads: remaining,
      maxChanges: budget.maxChangesPerCommit + 1,
      detectRenames: false,
      leavesOnly: true,
    });
    treeReads += d.treeReads;
    if (d.truncated && d.truncatedReason === 'readError') throw new HistoryReadError(`history: tree read failed: ${d.readError ?? 'unknown'}`);
    const tooMany = (d.truncated && d.truncatedReason === 'maxChanges') || d.changes.length > budget.maxChangesPerCommit;
    if (tooMany) {
      indexed.push({ sha: c.sha, changes: [], gap: true });
      continue;
    }
    if (d.truncated) {
      // Only maxTreeReads is left: the shared budget ran out inside this commit.
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
  return { indexed, treeReads, stopped: null };
}
