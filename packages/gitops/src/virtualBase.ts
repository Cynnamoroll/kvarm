/**
 * The virtual merge base of a criss-cross history (architecture §3.1), as
 * git's recursive and ort strategies build it: when two tips have several
 * best common ancestors, the ancestors are merged pairwise into one virtual
 * commit, and the outer three-way merge runs against that commit's tree.
 *
 * Each pairwise merge is itself a full merge: its own merge bases are
 * computed over the real history plus the virtual commits made so far (a
 * virtual commit's parents are the two commits it merged), merged
 * recursively when there are several again, and the two trees are then
 * merged with `merge3` at that call depth, which writes conflicts into the
 * tree the way merge-ort does (markers kept, modify/delete keeps the base).
 * Two bases with no common ancestor merge against the empty tree, as in git.
 *
 * Bases are merged oldest committer time first, as in git. When a base lacks
 * a committer time or times tie, object-id order is a deterministic fallback;
 * if that ambiguous fold writes a conflict, it stops with `baseOrder`.
 * Conflict-hunk side order changes the virtual base text and can change
 * whether the outer text merge is clean. Conflicts git settles with rules
 * merge3 does not model at depth (renames, file/directory, type changes) stop
 * with `virtualConflict`.
 *
 * Budgeted: the number of bases of any one pair, the recursion depth, and
 * the commit reads, tree reads, blob reads and created bytes of all inner
 * merges together. A spent budget returns `truncated` with no tree.
 */

import { parseTree, type GitObject, type TreeEntry } from './index';
import { merge3, TreeReadBudgetError, type Merge3Options, type Merge3Truncation, type MergeReader } from './merge3';
import { mergeBase, type CommitInfo, type CommitReader, type MergeBaseTruncation } from './mergebase';

export interface VirtualBaseOptions extends Omit<Merge3Options, 'resolver' | 'virtualDepth'> {
  /** Max distinct commit reads across every inner merge-base walk (default 2_000). */
  maxCommitReads?: number;
  /**
   * Whether reading commit `sha` stays within the caller's commit budget,
   * replacing this merge's own count against `maxCommitReads`: a caller whose
   * reader memoizes the commits it already walked (the outer merge-base
   * walk) charges only for commits that are new to it.
   */
  mayReadCommit?: (sha: string) => boolean;
  /** Max merge bases of any one pair, the outermost included (default 8). */
  maxMergeBases?: number;
  /** Max call depth of inner merges; the outermost bases merge at depth 1 (default 3). */
  maxVirtualDepth?: number;
}

export type VirtualBaseTruncation = Merge3Truncation | MergeBaseTruncation | 'maxMergeBases' | 'maxVirtualDepth' | 'baseOrder';

export interface VirtualBaseResult {
  /** The virtual base tree; null when truncated. */
  treeHash: string | null;
  /**
   * Objects the virtual tree needs that the inner merges created. They are
   * merge inputs only: serve them to the outer merge's reader, never publish them.
   */
  objects: GitObject[];
  /** Inner merges run. */
  merges: number;
  /** Conflicts written into the virtual tree (markers, kept bases). */
  conflicts: number;
  truncated: boolean;
  truncatedReason?: VirtualBaseTruncation;
  /** The conflicting path, missing object, failed read message or ambiguous base ids. */
  truncatedDetail?: string;
  commitReads: number;
  treeReads: number;
  blobReads: number;
}

export const VIRTUAL_BASE_DEFAULTS = {
  maxCommitReads: 2_000,
  maxMergeBases: 8,
  maxVirtualDepth: 3,
  maxTreeReads: 10_000,
  maxBlobReads: 1_000,
  maxMergedBytes: 16 * 1024 * 1024,
};

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

class Stop extends Error {
  constructor(
    readonly reason: VirtualBaseTruncation,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);

class VirtualMerge implements CommitReader, MergeReader {
  merges = 0;
  conflicts = 0;
  commitReads = 0;
  treeReads = 0;
  blobReads = 0;
  private createdBytes = 0;
  private readonly commits = new Map<string, Promise<CommitInfo | null>>();
  private readonly virtualCommits = new Map<string, CommitInfo>();
  private readonly trees = new Map<string, Promise<TreeEntry[] | null>>();
  readonly objects = new Map<string, GitObject>();

  constructor(
    private readonly inner: CommitReader & MergeReader,
    private readonly opts: VirtualBaseOptions & typeof VIRTUAL_BASE_DEFAULTS,
  ) {}

  /** Set when a commit read was refused for the budget; the walk only sees a failed read. */
  private overBudget = false;

  readCommit(sha: string): Promise<CommitInfo | null> {
    const v = this.virtualCommits.get(sha);
    if (v) return Promise.resolve(v);
    let p = this.commits.get(sha);
    if (!p) {
      if (!(this.opts.mayReadCommit?.(sha) ?? this.commitReads < this.opts.maxCommitReads)) {
        this.overBudget = true;
        return Promise.reject(new Stop('maxCommitReads'));
      }
      this.commitReads++;
      p = this.inner.readCommit(sha);
      this.commits.set(sha, p);
    }
    return p;
  }

  /**
   * Trees are memoized across the inner merges, which mostly read the same
   * base subtrees, and `maxTreeReads` bounds distinct fetches.
   */
  async readTree(hash: string): Promise<TreeEntry[] | null> {
    const o = this.objects.get(hash);
    if (o?.type === 'tree') return parseTree(body(o));
    if (hash === EMPTY_TREE) return [];
    let p = this.trees.get(hash);
    if (!p) {
      if (this.treeReads >= this.opts.maxTreeReads) throw new TreeReadBudgetError(hash);
      this.treeReads++;
      p = this.inner.readTree(hash);
      this.trees.set(hash, p);
    }
    return p;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    const o = this.objects.get(hash);
    if (o?.type === 'blob') return body(o).slice();
    return this.inner.readBlob(hash);
  }

  private async commitInfo(sha: string): Promise<CommitInfo> {
    let c: CommitInfo | null;
    try {
      c = await this.readCommit(sha);
    } catch (err) {
      if (err instanceof Stop) throw err;
      throw new Stop('readError', err instanceof Error ? err.message : String(err));
    }
    if (!c) throw new Stop('missingCommit', sha);
    return c;
  }

  private async tree(sha: string): Promise<string> {
    return (await this.commitInfo(sha)).treeHash;
  }

  /** The tree to merge against for `bases`, merging them at `depth` when there are several. */
  async baseTree(bases: readonly string[], depth: number): Promise<string> {
    if (bases.length === 0) return EMPTY_TREE;
    if (bases.length > this.opts.maxMergeBases) throw new Stop('maxMergeBases', String(bases.length));
    if (bases.length === 1) return this.tree(bases[0]!);
    if (depth > this.opts.maxVirtualDepth) throw new Stop('maxVirtualDepth', String(depth));

    const commits = await Promise.all(bases.map(async (sha) => ({ sha, info: await this.commitInfo(sha) })));
    const missingDates = commits.filter(({ info }) => info.committedAt === undefined).map(({ sha }) => sha);
    const dated = new Map<number, string[]>();
    for (const { sha, info } of commits) {
      if (info.committedAt === undefined) continue;
      const group = dated.get(info.committedAt) ?? [];
      group.push(sha);
      dated.set(info.committedAt, group);
    }
    const tied = [...dated.values()].filter((group) => group.length > 1).flat();
    const ambiguousShas = [...new Set([...missingDates, ...tied])].sort();
    const ambiguous = ambiguousShas.length > 0;
    const ordered = commits.sort((a, b) => {
      if (missingDates.length === 0 && a.info.committedAt !== b.info.committedAt) {
        return a.info.committedAt! - b.info.committedAt!;
      }
      return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
    });
    const conflictsBefore = this.conflicts;
    let acc = ordered[0]!.sha;
    for (const { sha: next } of ordered.slice(1)) {
      const treeHash = await this.mergeCommits(acc, next, depth);
      // Not an object id, so it can never collide with a real commit.
      const id = `virtual-${depth}-${this.virtualCommits.size}`;
      this.virtualCommits.set(id, { parents: [acc, next], treeHash });
      acc = id;
    }
    if (ambiguous && this.conflicts > conflictsBefore) throw new Stop('baseOrder', ambiguousShas.join(','));
    return this.tree(acc);
  }

  private async mergeCommits(a: string, b: string, depth: number): Promise<string> {
    // readCommit enforces the commit budget on distinct reads; the walk's own limit would also count memoized ones.
    const mb = await mergeBase(this, a, b, {
      maxCommitReads: Number.MAX_SAFE_INTEGER,
      ...(this.opts.concurrency !== undefined ? { concurrency: this.opts.concurrency } : {}),
    });
    if (this.overBudget) throw new Stop('maxCommitReads');
    if (mb.truncated) throw new Stop(mb.truncatedReason ?? 'readError', mb.missingCommit ?? mb.readError);
    const base = await this.baseTree(mb.bases, depth + 1);
    const [ours, theirs] = await Promise.all([this.tree(a), this.tree(b)]);
    const { maxCommitReads: _c, maxMergeBases: _b, maxVirtualDepth: _d, mayReadCommit: _m, ...mergeOpts } = this.opts;
    const m = await merge3(this, base, ours, theirs, {
      ...mergeOpts,
      // readTree enforces the tree budget on distinct fetches across all inner merges.
      maxTreeReads: Number.MAX_SAFE_INTEGER,
      maxBlobReads: this.opts.maxBlobReads - this.blobReads,
      maxMergedBytes: this.opts.maxMergedBytes - this.createdBytes,
      virtualDepth: depth,
    });
    this.blobReads += m.blobReads;
    this.merges++;
    if (m.truncated || m.treeHash === null) throw new Stop(m.truncatedReason ?? 'readError', m.truncatedDetail);
    this.conflicts += m.conflicts.length;
    for (const o of m.objects) {
      if (this.objects.has(o.hash)) continue;
      this.objects.set(o.hash, o);
      this.createdBytes += o.raw.length + o.store.length;
    }
    return m.treeHash;
  }
}

/**
 * Merges `bases` (the merge bases of two tips, as `mergeBase` returns them)
 * into one virtual base tree. One base is its own tree; none is the empty tree.
 */
export async function virtualMergeBase(
  reader: CommitReader & MergeReader,
  bases: readonly string[],
  options: VirtualBaseOptions = {},
): Promise<VirtualBaseResult> {
  const opts = {
    ...VIRTUAL_BASE_DEFAULTS,
    ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)),
  } as VirtualBaseOptions & typeof VIRTUAL_BASE_DEFAULTS;
  const v = new VirtualMerge(reader, opts);
  const work = () => ({ merges: v.merges, conflicts: v.conflicts, commitReads: v.commitReads, treeReads: v.treeReads, blobReads: v.blobReads });
  try {
    const treeHash = await v.baseTree(bases, 1);
    return { treeHash, objects: [...v.objects.values()], truncated: false, ...work() };
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return {
      treeHash: null,
      objects: [],
      truncated: true,
      truncatedReason: err.reason,
      ...(err.detail !== undefined ? { truncatedDetail: err.detail } : {}),
      ...work(),
    };
  }
}
