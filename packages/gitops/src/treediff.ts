/**
 * Tree-level diff: classify every changed path between two git trees.
 *
 * Classic git diff-tree walk: recurse both trees in parallel and prune any
 * subtree whose hash is identical on both sides — work is proportional to
 * CHANGED paths, not tree size. Exact renames pair up by blob hash (git's
 * cheapest -M mode). Reads go through an abstract {@link TreeReader} so the
 * engine runs anywhere: the Artifacts binding in production, in-memory
 * stores in tests.
 *
 * Deterministic: output is sorted by path. Budgeted: the walk stops and
 * reports `truncated` when read or change limits are hit, so pathological
 * repos degrade instead of hanging.
 */

import type { TreeEntry } from './index';

export type TreeChangeStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'typechange';

export interface TreeChange {
  path: string;
  status: TreeChangeStatus;
  /** Mode in the base tree, null when the file is new. */
  oldMode: string | null;
  /** Mode in the head tree, null when the file was deleted. */
  newMode: string | null;
  /** Blob SHA in the base tree, null when new. */
  oldHash: string | null;
  /** Blob SHA in the head tree, null when deleted. */
  newHash: string | null;
  /** Present for renames: the path in the base tree. */
  oldPath?: string;
}

export interface TreeDiffOptions {
  /** Max readTree calls before truncating (default 10_000). */
  maxTreeReads?: number;
  /** Max emitted changes before truncating (default 20_000). */
  maxChanges?: number;
  /** Max concurrent subtree walks (default 8). */
  concurrency?: number;
  /** Pair exact renames by blob hash (default true). */
  detectRenames?: boolean;
}

export interface TreeDiffResult {
  /** Changed file paths, sorted by path. */
  changes: TreeChange[];
  /** True when a budget stopped the walk early. */
  truncated: boolean;
  /** readTree calls made — prune effectiveness is visible here. */
  treeReads: number;
}

/** Anything that can list a git tree's entries by object hash. */
export interface TreeReader {
  readTree(hash: string): Promise<TreeEntry[] | null>;
}

const DEFAULT_MAX_TREE_READS = 10_000;
const DEFAULT_MAX_CHANGES = 20_000;
const DEFAULT_CONCURRENCY = 8;

/** Raw git trees store directory mode as "40000"; some tooling writes "040000". */
function isTreeMode(mode: string): boolean {
  return mode === '40000' || mode === '040000';
}

/** Run thunks through a fixed-size worker pool (starts at most `limit` at once). */
async function runPool(thunks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, thunks.length) }, async () => {
    while (next < thunks.length) {
      const thunk = thunks[next++]!;
      await thunk();
    }
  });
  await Promise.all(workers);
}

class TreeDiffWalk {
  private readonly changes: TreeChange[] = [];
  private readonly maxTreeReads: number;
  private readonly maxChanges: number;
  private readonly concurrency: number;
  private treeReads = 0;
  private stopped = false;

  constructor(
    private readonly reader: TreeReader,
    opts: TreeDiffOptions,
  ) {
    this.maxTreeReads = opts.maxTreeReads ?? DEFAULT_MAX_TREE_READS;
    this.maxChanges = opts.maxChanges ?? DEFAULT_MAX_CHANGES;
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  }

  async run(baseTreeHash: string, headTreeHash: string, detectRenames: boolean): Promise<TreeDiffResult> {
    let changes: TreeChange[] = this.changes;
    if (baseTreeHash !== headTreeHash) {
      await this.walk(baseTreeHash, headTreeHash, '');
      if (detectRenames && !this.stopped) changes = pairRenames(changes);
    }
    changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { changes, truncated: this.stopped, treeReads: this.treeReads };
  }

  private emit(change: TreeChange): void {
    if (this.changes.length >= this.maxChanges) {
      this.stopped = true;
      return;
    }
    this.changes.push(change);
  }

  /** Read a tree, or stop the walk when the read budget is exhausted. */
  private async readTree(hash: string): Promise<TreeEntry[] | null> {
    if (this.treeReads >= this.maxTreeReads) {
      this.stopped = true;
      return null;
    }
    this.treeReads++;
    return this.reader.readTree(hash);
  }

  private async walk(baseHash: string, headHash: string, prefix: string): Promise<void> {
    if (this.stopped || baseHash === headHash) return; // identical subtree: pruned

    const [baseEntries, headEntries] = await Promise.all([
      this.readTree(baseHash),
      this.readTree(headHash),
    ]);
    if (this.stopped) return;

    const baseMap = new Map((baseEntries ?? []).map((e) => [e.name, e] as const));
    const headMap = new Map((headEntries ?? []).map((e) => [e.name, e] as const));
    const names = new Set<string>([...baseMap.keys(), ...headMap.keys()]);

    const subtasks: Array<() => Promise<void>> = [];
    for (const name of names) {
      if (this.stopped) return;
      const b = baseMap.get(name);
      const h = headMap.get(name);
      const path = prefix + name;

      if (b && h) {
        if (b.hash === h.hash) {
          // Same object: only a mode change can differ (hash encodes the type).
          if (b.mode !== h.mode) {
            this.emit({ path, status: 'typechange', oldMode: b.mode, newMode: h.mode, oldHash: b.hash, newHash: h.hash });
          }
          // Identical content: nothing more to do for this subtree.
        } else if (isTreeMode(b.mode) && isTreeMode(h.mode)) {
          subtasks.push(() => this.walk(b.hash, h.hash, `${path}/`));
        } else if (!isTreeMode(b.mode) && !isTreeMode(h.mode)) {
          this.emit({ path, status: 'modified', oldMode: b.mode, newMode: h.mode, oldHash: b.hash, newHash: h.hash });
        } else {
          // Directory became a file (or vice versa).
          this.emit({ path, status: 'typechange', oldMode: b.mode, newMode: h.mode, oldHash: b.hash, newHash: h.hash });
        }
      } else if (b) {
        if (isTreeMode(b.mode)) {
          subtasks.push(() => this.collectSide(b.hash, `${path}/`, 'removed'));
        } else {
          this.emit({ path, status: 'removed', oldMode: b.mode, newMode: null, oldHash: b.hash, newHash: null });
        }
      } else if (h) {
        if (isTreeMode(h.mode)) {
          subtasks.push(() => this.collectSide(h.hash, `${path}/`, 'added'));
        } else {
          this.emit({ path, status: 'added', oldMode: null, newMode: h.mode, oldHash: null, newHash: h.hash });
        }
      }
    }
    if (subtasks.length > 0) await runPool(subtasks, this.concurrency);
  }

  /** Flatten a subtree that exists on only one side; every leaf becomes a change. */
  private async collectSide(treeHash: string, prefix: string, status: 'added' | 'removed'): Promise<void> {
    if (this.stopped) return;
    const entries = await this.readTree(treeHash);
    if (this.stopped || !entries) return;

    const subtasks: Array<() => Promise<void>> = [];
    for (const e of entries) {
      const path = prefix + e.name;
      if (isTreeMode(e.mode)) {
        subtasks.push(() => this.collectSide(e.hash, `${path}/`, status));
      } else if (status === 'added') {
        this.emit({ path, status: 'added', oldMode: null, newMode: e.mode, oldHash: null, newHash: e.hash });
      } else {
        this.emit({ path, status: 'removed', oldMode: e.mode, newMode: null, oldHash: e.hash, newHash: null });
      }
    }
    if (subtasks.length > 0) await runPool(subtasks, this.concurrency);
  }
}

/** Pair removed and added leaves carrying the identical blob hash as renames. */
function pairRenames(changes: TreeChange[]): TreeChange[] {
  const removedByHash = new Map<string, TreeChange[]>();
  for (const c of changes) {
    if (c.status !== 'removed' || !c.oldHash) continue;
    const bucket = removedByHash.get(c.oldHash);
    if (bucket) bucket.push(c);
    else removedByHash.set(c.oldHash, [c]);
  }
  if (removedByHash.size === 0) return changes;

  const out: TreeChange[] = [];
  const usedRemoved = new Set<TreeChange>();
  for (const c of changes) {
    if (c.status !== 'added' || !c.newHash) {
      out.push(c);
      continue;
    }
    const candidates = removedByHash.get(c.newHash);
    if (!candidates) {
      out.push(c);
      continue;
    }
    // Prefer the candidate with the same basename, then the shortest old path.
    const basename = c.path.slice(c.path.lastIndexOf('/') + 1);
    let best: TreeChange | undefined;
    let bestScore = -Infinity;
    for (const cand of candidates) {
      if (usedRemoved.has(cand)) continue;
      const candBase = cand.path.slice(cand.path.lastIndexOf('/') + 1);
      const score = (candBase === basename ? 2 : 0) - cand.path.length;
      if (score > bestScore) {
        best = cand;
        bestScore = score;
      }
    }
    if (best) {
      usedRemoved.add(best);
      out.push({
        path: c.path,
        status: 'renamed',
        oldMode: best.oldMode,
        newMode: c.newMode,
        oldHash: best.oldHash,
        newHash: c.newHash,
        oldPath: best.path,
      });
    } else {
      out.push(c);
    }
  }
  // Drop removed entries that became renames.
  return out.filter((c) => !usedRemoved.has(c));
}

/** Diff two trees: every changed path with old/new blob hashes and modes. */
export function diffTrees(
  reader: TreeReader,
  baseTreeHash: string,
  headTreeHash: string,
  opts: TreeDiffOptions = {},
): Promise<TreeDiffResult> {
  return new TreeDiffWalk(reader, opts).run(baseTreeHash, headTreeHash, opts.detectRenames !== false);
}
