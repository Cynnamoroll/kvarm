/**
 * Three-way merge parity with real git over the scripted conflict corpus
 * (scripts/conflict-corpus). The corpus is built fresh into a temp bare repo;
 * git's `merge-tree --write-tree` result for each case is the expectation.
 * Non-conflicting cases must produce the identical tree oid; conflicting
 * cases must report the same conflict set (kinds + paths).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allCases, buildCorpus, conflictKey, loadObjects, type CorpusResult } from '../../../scripts/conflict-corpus/corpus.mjs';
import { parseTree, type TreeEntry } from '../src/index';
import { merge3, type MergeReader } from '../src/merge3';

let root = '';
let results: CorpusResult[] = [];
let reader: MergeReader;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-corpus-'));
  const dir = join(root, 'corpus');
  results = buildCorpus(dir, allCases());
  const objects = loadObjects(dir);
  reader = {
    async readTree(hash: string): Promise<TreeEntry[] | null> {
      const o = objects.get(hash);
      return o && o.type === 'tree' ? parseTree(o.content) : null;
    },
    async readBlob(hash: string): Promise<Uint8Array | null> {
      const o = objects.get(hash);
      return o && o.type === 'blob' ? o.content : null;
    },
  };
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every object under `tree` is either one the merge created or already in the store. */
async function closed(tree: string, created: Map<string, { type: string; raw: Uint8Array }>): Promise<boolean> {
  const own = created.get(tree);
  const entries = own ? parseTree(own.raw.subarray(own.raw.indexOf(0) + 1)) : await reader.readTree(tree);
  if (!entries) return false;
  for (const e of entries) {
    if (e.mode === '40000') {
      if (!(await closed(e.hash, created))) return false;
    } else if (e.mode !== '160000' && !created.has(e.hash) && !(await reader.readBlob(e.hash))) return false;
  }
  return true;
}

describe('merge3 parity with git merge-tree --write-tree (conflict corpus)', () => {
  it('covers clean and conflicting cases of every conflict kind', () => {
    expect(results.length).toBeGreaterThanOrEqual(150);
    const clean = results.filter((r) => r.expected.clean).length;
    expect(clean).toBeGreaterThanOrEqual(60);
    expect(results.length - clean).toBeGreaterThanOrEqual(40);
    const kinds = new Set(results.flatMap((r) => r.expected.conflicts.map((k) => k.slice(0, k.indexOf(':')))));
    expect([...kinds].sort()).toEqual(['add-add', 'binary', 'content', 'file-directory', 'modify-delete', 'rename', 'typechange']);
  });

  it('matches git on every case', async () => {
    const mismatches: unknown[] = [];
    for (const r of results) {
      const got = await merge3(reader, r.base, r.ours, r.theirs);
      const actual = {
        clean: got.clean,
        tree: got.clean ? got.treeHash : undefined,
        conflicts: [...new Set(got.conflicts.map((c) => conflictKey(c.kind, c.paths)))].sort(),
        truncated: got.truncated,
      };
      const expected = {
        clean: r.expected.clean,
        tree: r.expected.clean ? r.expected.tree : undefined,
        conflicts: r.expected.conflicts,
        truncated: false,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ case: r.name, expected, actual });
      if (got.clean && !(await closed(got.treeHash!, new Map(got.objects.map((o) => [o.hash, o]))))) {
        mismatches.push({ case: r.name, error: 'merged tree references an object neither created nor stored' });
      }
    }
    expect(mismatches).toEqual([]);
  });
});
