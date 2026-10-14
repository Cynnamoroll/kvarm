/**
 * Shared oracles for the merge-family tests (merge3, criss-cross, revert).
 */

import { parseTree, type GitObject } from '../src/index';
import type { MergeReader } from '../src/merge3';

/**
 * Every object under `tree` is either one the merge created or already in
 * the store. Gitlinks (mode 160000) name commits, not store objects, and
 * are skipped.
 */
export async function closed(reader: MergeReader, tree: string, created: readonly GitObject[]): Promise<boolean> {
  const own = created.find((o) => o.hash === tree);
  const entries = own ? parseTree(own.raw.subarray(own.raw.indexOf(0) + 1)) : await reader.readTree(tree);
  if (!entries) return false;
  for (const e of entries) {
    if (e.mode === '40000') {
      if (!(await closed(reader, e.hash, created))) return false;
    } else if (e.mode !== '160000' && !created.some((o) => o.hash === e.hash) && !(await reader.readBlob(e.hash))) return false;
  }
  return true;
}
