/**
 * The tree of a revert, as `git revert` computes it: an inverse three-way
 * merge with the reverted commit as the base, the target tip as ours and the
 * commit's parent as theirs (merge-ort, like `git merge-tree --write-tree
 * --merge-base=<commit> <target> <parent>`). A merge commit reverts relative
 * to its first parent by default, like `git revert -m 1`; a root commit
 * reverts to the empty tree.
 *
 * No resolver runs: a revert takes git's result exactly, so a hunk git would
 * leave conflicted is a conflict here too and no tree is produced. A tree
 * equal to the target's is `empty` (nothing to revert, as when the change
 * was already reverted), which git refuses to commit as well.
 */

import { merge3, type Merge3Options, type Merge3Truncation, type MergeConflict, type MergeReader } from './merge3';
import type { CommitReader } from './mergebase';
import { buildTree, type GitObject } from './index';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface RevertInput {
  /** The commit to revert. */
  commit: string;
  /** The tip the revert applies to. */
  target: string;
  /** Parent to revert relative to, 1-based (`git revert -m`); default 1. */
  mainline?: number;
  /**
   * Revert relative to this commit instead of a parent: the net effect of
   * `commit` over `against` is undone (a fast-forwarded change set reverts
   * to the target it landed on).
   */
  against?: string;
}

export type RevertStatus = 'clean' | 'conflicts' | 'empty' | 'missing' | 'unknown';

export interface RevertResult {
  status: RevertStatus;
  /** The commit the revert restores (the chosen parent or `against`); null for a root commit. */
  parent: string | null;
  /** Whether the reverted commit has several parents. */
  merge: boolean;
  /** The reverted tree, for `clean` and `empty`. */
  treeHash: string | null;
  /** Objects `treeHash` needs that the merge created; empty unless `clean`. */
  objects: GitObject[];
  conflicts: MergeConflict[];
  /** For `missing`: which input could not be read; `mainline` names a parent the commit does not have. */
  missing?: 'commit' | 'target' | 'against' | 'mainline';
  /** For `unknown`: the budget or read failure that stopped the merge. */
  truncatedReason?: Merge3Truncation;
  treeReads: number;
  blobReads: number;
}

function withEmptyTree(reader: MergeReader): MergeReader {
  return {
    readTree: (hash) => (hash === EMPTY_TREE ? Promise.resolve([]) : reader.readTree(hash)),
    readBlob: (hash) => reader.readBlob(hash),
  };
}

export async function revertTree(reader: CommitReader & MergeReader, input: RevertInput, options: Merge3Options = {}): Promise<RevertResult> {
  const none = { treeHash: null, objects: [], conflicts: [], treeReads: 0, blobReads: 0 };
  const [commit, target] = await Promise.all([reader.readCommit(input.commit), reader.readCommit(input.target)]);
  if (!commit) return { status: 'missing', missing: 'commit', parent: null, merge: false, ...none };
  const merge = commit.parents.length > 1;
  if (!target) return { status: 'missing', missing: 'target', parent: null, merge, ...none };

  let parent: string | null;
  let parentTree: string;
  if (input.against !== undefined) {
    const against = await reader.readCommit(input.against);
    if (!against) return { status: 'missing', missing: 'against', parent: input.against, merge, ...none };
    parent = input.against;
    parentTree = against.treeHash;
  } else if (commit.parents.length === 0) {
    if ((input.mainline ?? 1) !== 1) return { status: 'missing', missing: 'mainline', parent: null, merge, ...none };
    parent = null;
    parentTree = EMPTY_TREE;
  } else {
    const n = input.mainline ?? 1;
    parent = Number.isInteger(n) && n >= 1 ? (commit.parents[n - 1] ?? null) : null;
    if (parent === null) return { status: 'missing', missing: 'mainline', parent: null, merge, ...none };
    const p = await reader.readCommit(parent);
    if (!p) return { status: 'missing', missing: 'against', parent, merge, ...none };
    parentTree = p.treeHash;
  }

  const m = await merge3(withEmptyTree(reader), commit.treeHash, target.treeHash, parentTree, { ...options, resolver: undefined, virtualDepth: 0 });
  const work = { treeReads: m.treeReads, blobReads: m.blobReads };
  if (m.truncated) {
    return { status: 'unknown', parent, merge, treeHash: null, objects: [], conflicts: [], ...(m.truncatedReason ? { truncatedReason: m.truncatedReason } : {}), ...work };
  }
  if (!m.clean || m.treeHash === null) return { status: 'conflicts', parent, merge, treeHash: null, objects: [], conflicts: m.conflicts, ...work };
  if (m.treeHash === target.treeHash) return { status: 'empty', parent, merge, treeHash: m.treeHash, objects: [], conflicts: [], ...work };
  // Reverting everything leaves the empty tree, which the store need not hold yet.
  const objects = m.treeHash === EMPTY_TREE ? [await buildTree([])] : m.objects;
  return { status: 'clean', parent, merge, treeHash: m.treeHash, objects, conflicts: [], ...work };
}

/**
 * git's revert message for `subject` (the reverted commit's first line),
 * followed by the caller's reason as its own paragraph. `range` names a
 * revert relative to an `against` commit that is not the commit's first
 * parent: every commit in `parent..commit` is undone, not only the last.
 */
export function revertMessage(o: { subject: string; commit: string; parent: string | null; merge: boolean; range?: boolean; reason?: string }): string {
  const subject = o.subject.split('\n', 1)[0]!.trim();
  const what =
    o.range && o.parent
      ? `This reverts commits ${o.parent}..${o.commit}.`
      : o.merge && o.parent
        ? `This reverts commit ${o.commit}, reversing\nchanges made to ${o.parent}.`
        : `This reverts commit ${o.commit}.`;
  const reason = o.reason?.trim();
  return `Revert "${subject}"\n\n${what}\n${reason ? `\n${reason}\n` : ''}`;
}
