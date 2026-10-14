/**
 * Criss-cross merge parity with real git (architecture §3.1): commit graphs
 * whose tips have several merge bases (scripts/conflict-corpus/crisscross.mjs)
 * are built into a temp bare repo, and git's `merge-tree --write-tree` of
 * the two tips (the default ort strategy, virtual ancestor included) is the
 * expectation. mergeBase + virtualMergeBase + merge3 must produce the
 * identical tree for clean cases and the same conflict set otherwise.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allCrissCrossCases, buildCrissCrossCorpus, conflictKey, loadObjects, type CrissCrossResult } from '../../../scripts/conflict-corpus/corpus.mjs';
import { decode, parseTree, type GitObject, type TreeEntry } from '../src/index';
import { merge3, type MergeReader } from '../src/merge3';
import { mergeBase, type CommitInfo, type CommitReader } from '../src/mergebase';
import { virtualMergeBase } from '../src/virtualBase';
import { closed } from './helpers';

let root = '';
let results: CrissCrossResult[] = [];
let reader: CommitReader & MergeReader;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-crisscross-'));
  const dir = join(root, 'corpus');
  results = buildCrissCrossCorpus(dir, allCrissCrossCases());
  const objects = loadObjects(dir);
  reader = {
    async readCommit(sha: string): Promise<CommitInfo | null> {
      const o = objects.get(sha);
      if (!o || o.type !== 'commit') return null;
      const head = decode(o.content).split('\n\n')[0] ?? '';
      return { treeHash: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!, parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!) };
    },
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

function overlay(objects: readonly GitObject[]): MergeReader {
  const byHash = new Map(objects.map((o) => [o.hash, o]));
  const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);
  return {
    async readTree(hash) {
      const o = byHash.get(hash);
      return o?.type === 'tree' ? parseTree(body(o)) : reader.readTree(hash);
    },
    async readBlob(hash) {
      const o = byHash.get(hash);
      return o?.type === 'blob' ? body(o) : reader.readBlob(hash);
    },
  };
}

const keys = (conflicts: Array<{ kind: string; paths: string[] }>) => [...new Set(conflicts.map((c) => conflictKey(c.kind, c.paths)))].sort();

describe('criss-cross merges match git (virtual merge base)', () => {
  it('covers clean, cancelling, conflicting, three-base and nested cases', () => {
    expect(results.length).toBeGreaterThanOrEqual(30);
    expect(results.filter((r) => r.expected.clean).length).toBeGreaterThanOrEqual(10);
    expect(results.filter((r) => !r.expected.clean).length).toBeGreaterThanOrEqual(10);
    expect(results.some((r) => r.bases.length === 3)).toBe(true);
    const kinds = new Set(results.flatMap((r) => r.expected.conflicts.map((k) => k.slice(0, k.indexOf(':')))));
    expect([...kinds].sort()).toEqual(['binary', 'content', 'modify-delete']);
  });

  it('matches git merge-tree on every case', async () => {
    const mismatches: unknown[] = [];
    for (const r of results) {
      const mb = await mergeBase(reader, r.ours, r.theirs);
      expect([...mb.bases].sort(), r.name).toEqual(r.bases);
      const v = await virtualMergeBase(reader, mb.bases);
      if (v.truncated || !v.treeHash) {
        mismatches.push({ case: r.name, virtual: v.truncatedReason, detail: v.truncatedDetail });
        continue;
      }
      const [ours, theirs] = await Promise.all([reader.readCommit(r.ours), reader.readCommit(r.theirs)]);
      const got = await merge3(overlay(v.objects), v.treeHash, ours!.treeHash, theirs!.treeHash);
      const actual = { clean: got.clean, tree: got.clean ? got.treeHash : undefined, conflicts: keys(got.conflicts), truncated: got.truncated };
      const expected = { clean: r.expected.clean, tree: r.expected.clean ? r.expected.tree : undefined, conflicts: r.expected.conflicts, truncated: false };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) mismatches.push({ case: r.name, expected, actual });
      // What publication pushes (the outer merge's objects) plus the store must close the tree: no virtual-only object.
      if (got.clean && !(await closed(reader, got.treeHash!, got.objects))) {
        mismatches.push({ case: r.name, error: 'merged tree references a virtual-base object' });
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('differs from merging against any single base on some cases (the corpus exercises the virtual ancestor)', async () => {
    let differs = 0;
    for (const r of results) {
      const [ours, theirs] = await Promise.all([reader.readCommit(r.ours), reader.readCommit(r.theirs)]);
      for (const base of r.bases) {
        const single = await merge3(reader, (await reader.readCommit(base))!.treeHash, ours!.treeHash, theirs!.treeHash);
        const same = single.clean === r.expected.clean && (single.clean ? single.treeHash === r.expected.tree : JSON.stringify(keys(single.conflicts)) === JSON.stringify(r.expected.conflicts));
        if (!same) differs++;
      }
    }
    expect(differs).toBeGreaterThan(0);
  });
});
