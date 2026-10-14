/**
 * Virtual merge base for criss-cross histories (git's recursive strategy,
 * restricted to the case it can answer exactly).
 *
 * When two tips have two best common ancestors, git merges those ancestors
 * into a virtual commit and uses its tree as the merge base. This module does
 * the same for exactly two bases whose own merge base is unique, and only
 * where merge3's model provably agrees with git's: no side of the inner
 * merge leaves room for a similarity rename (`refuseAmbiguousRenames`), and
 * no path needs a line-level merge (git's xdiff could conflict where
 * mergeText does not, and would then put conflict markers in the virtual
 * base). Paths changed on one side only, or identically on both, merge the
 * same way in git, so the virtual tree is the one git uses. Three or more
 * bases, bases with several merge bases of their own, unrelated bases and
 * anything else are refused; the caller reports several merge bases.
 *
 * Budgets: the inner merge gets the caller's per-merge limits; the caller
 * subtracts its reads and bytes from the outer merge's, while `maxChanges`
 * (per side) and `nodeBudget` (per line diff) apply to each stage alone.
 */

import { mergeBase, type CommitReader, type MergeBaseTruncation } from './mergebase';
import { merge3, type Merge3Options, type Merge3Truncation, type MergeReader } from './merge3';
import { parseTree, type GitObject } from './index';

export type VirtualBaseRefusal = 'too-many-bases' | 'nested-criss-cross' | 'unrelated-bases' | 'bases-conflict' | 'bases-ambiguous';

export interface VirtualBaseOptions extends Omit<Merge3Options, 'resolver'> {
  /** Max distinct readCommit calls for the bases' own merge base (default 2_000). */
  maxCommitReads?: number;
}

export type VirtualBaseFailure = VirtualBaseRefusal | MergeBaseTruncation | Merge3Truncation;

export type VirtualBaseResult =
  | { ok: true; treeHash: string; objects: GitObject[]; bases: string[]; commitReads: number; treeReads: number; blobReads: number }
  | { ok: false; reason: VirtualBaseFailure; commitReads: number; treeReads: number; blobReads: number };

/** Size a created object occupies against a merge's `maxMergedBytes` budget. */
export function objectBytes(objects: readonly GitObject[]): number {
  return objects.reduce((n, o) => n + o.raw.length + o.store.length, 0);
}

/** A tree and blob reader that also sees `objects` (created, not yet stored). */
export function readerWith(reader: MergeReader, objects: readonly GitObject[]): MergeReader {
  const byHash = new Map(objects.map((o) => [o.hash, o]));
  const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);
  return {
    async readTree(hash) {
      const o = byHash.get(hash);
      return o?.type === 'tree' ? parseTree(body(o)) : reader.readTree(hash);
    },
    async readBlob(hash) {
      const o = byHash.get(hash);
      return o?.type === 'blob' ? body(o).slice() : reader.readBlob(hash);
    },
  };
}

export async function virtualMergeBase(
  reader: CommitReader & MergeReader,
  bases: readonly string[],
  opts: VirtualBaseOptions = {},
): Promise<VirtualBaseResult> {
  let commitReads = 0;
  const refuse = (reason: VirtualBaseFailure, treeReads = 0, blobReads = 0): VirtualBaseResult => ({ ok: false, reason, commitReads, treeReads, blobReads });
  if (bases.length !== 2) return refuse('too-many-bases');
  // Sorted, so the same pair always yields the same virtual tree.
  const [b1, b2] = [...bases].sort() as [string, string];

  const inner = await mergeBase(reader, b1, b2, { maxCommitReads: opts.maxCommitReads, concurrency: opts.concurrency });
  commitReads += inner.commitReads;
  if (inner.truncated) return refuse(inner.truncatedReason ?? 'readError');
  if (inner.bases.length === 0) return refuse('unrelated-bases');
  if (inner.bases.length > 1) return refuse('nested-criss-cross');

  let commits;
  try {
    commits = await Promise.all([reader.readCommit(inner.bases[0]!), reader.readCommit(b1), reader.readCommit(b2)]);
  } catch {
    return refuse('readError');
  }
  commitReads += 3;
  const [root, c1, c2] = commits;
  if (!root || !c1 || !c2) return refuse('missingCommit');

  const m = await merge3(reader, root.treeHash, c1.treeHash, c2.treeHash, { ...opts, resolver: undefined, refuseAmbiguousRenames: true });
  if (m.truncated) return refuse(m.truncatedReason ?? 'missingObject', m.treeReads, m.blobReads);
  if (m.refused) return refuse('bases-ambiguous', m.treeReads, m.blobReads);
  if (!m.clean || !m.treeHash) return refuse('bases-conflict', m.treeReads, m.blobReads);
  // A line-level merge may be clean here where git's xdiff conflicts, and git
  // would then carry conflict markers into its virtual base.
  if (m.resolved.some((r) => r.rule !== 'identical-change' && r.rule !== 'add-add-identical')) {
    return refuse('bases-ambiguous', m.treeReads, m.blobReads);
  }
  return { ok: true, treeHash: m.treeHash, objects: m.objects, bases: [b1, b2], commitReads, treeReads: m.treeReads, blobReads: m.blobReads };
}

/**
 * The objects of `pool` reachable from `rootTree`. Trees outside the pool are
 * already stored, and so is everything under them, so the walk descends only
 * through pooled trees. Used to publish exactly what a merged tree needs out
 * of the objects a merge (and its virtual base) created.
 */
export function reachableObjects(rootTree: string, pool: readonly GitObject[]): GitObject[] {
  const byHash = new Map(pool.map((o) => [o.hash, o]));
  const out = new Map<string, GitObject>();
  const stack = [rootTree];
  while (stack.length > 0) {
    const hash = stack.pop()!;
    const o = byHash.get(hash);
    if (!o || out.has(hash)) continue;
    out.set(hash, o);
    if (o.type !== 'tree') continue;
    for (const e of parseTree(o.raw.subarray(o.raw.indexOf(0) + 1))) {
      // Gitlinks name commits in other repositories; nothing to carry.
      if (e.mode !== '160000') stack.push(e.hash);
    }
  }
  return [...out.values()];
}
