/**
 * Per-commit changed paths for the path-history index: leaf paths against the
 * first parent, a shared tree-read budget, and gaps instead of silent drops.
 */

import { describe, expect, it } from 'vitest';
import { buildBlob, buildTree, encode, EMPTY_TREE_HASH, HistoryReadError, indexCommits, parseTree, type GitObject, type TreeReader } from '../src/index';

class Trees implements TreeReader {
  objects = new Map<string, GitObject>();
  reads = 0;

  async tree(files: Record<string, string>): Promise<string> {
    // Nested paths become nested trees.
    const root: Record<string, unknown> = {};
    for (const [path, content] of Object.entries(files)) {
      const parts = path.split('/');
      let node = root;
      for (const p of parts.slice(0, -1)) node = (node[p] ??= {}) as Record<string, unknown>;
      node[parts[parts.length - 1]!] = content;
    }
    const write = async (node: Record<string, unknown>): Promise<string> => {
      const entries = [];
      for (const name of Object.keys(node).sort()) {
        const v = node[name];
        if (typeof v === 'string') {
          const b = await buildBlob(encode(v));
          this.objects.set(b.hash, b);
          entries.push({ mode: '100644', name, hash: b.hash });
        } else entries.push({ mode: '40000', name, hash: await write(v as Record<string, unknown>) });
      }
      const t = await buildTree(entries);
      this.objects.set(t.hash, t);
      return t.hash;
    };
    return write(root);
  }

  async readTree(hash: string) {
    this.reads++;
    const o = this.objects.get(hash);
    return o ? parseTree(o.raw.subarray(o.raw.indexOf(0) + 1)) : null;
  }
}

const BUDGET = { maxTreeReads: 1000, maxChangesPerCommit: 100, maxRows: 1000 };

describe('indexCommits', () => {
  it('lists leaf changes against the first parent, and everything for a root commit without reading the empty tree', async () => {
    const t = new Trees();
    const t1 = await t.tree({ 'a.txt': '1', 'src/b.txt': '1' });
    const t2 = await t.tree({ 'a.txt': '2', 'src/b.txt': '1', 'src/c.txt': '1' });
    const t3 = await t.tree({ 'a.txt': '2', 'src/c.txt': '1' });
    expect(t.objects.has(EMPTY_TREE_HASH)).toBe(false);
    const r = await indexCommits(
      t,
      [
        { sha: 'c1', tree: t1, parentTree: null },
        { sha: 'c2', tree: t2, parentTree: t1 },
        { sha: 'c3', tree: t3, parentTree: t2 },
      ],
      BUDGET,
    );
    expect(r.stopped).toBeNull();
    expect(r.indexed).toEqual([
      { sha: 'c1', gap: false, changes: [{ path: 'a.txt', status: 'added' }, { path: 'src/b.txt', status: 'added' }] },
      { sha: 'c2', gap: false, changes: [{ path: 'a.txt', status: 'modified' }, { path: 'src/c.txt', status: 'added' }] },
      { sha: 'c3', gap: false, changes: [{ path: 'src/b.txt', status: 'removed' }] },
    ]);
  });

  it('reports a directory replaced by a file as leaves, not a typechange', async () => {
    const t = new Trees();
    const before = await t.tree({ 'x/y.txt': '1' });
    const after = await t.tree({ x: 'file' });
    const r = await indexCommits(t, [{ sha: 'c', tree: after, parentTree: before }], BUDGET);
    expect(r.indexed[0]!.changes.map((c) => `${c.status}:${c.path}`).sort()).toEqual(['added:x', 'removed:x/y.txt']);
  });

  it('marks a commit with more changes than the per-commit cap as a gap and continues', async () => {
    const t = new Trees();
    const big = await t.tree(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, 'x'])));
    const small = await t.tree({ ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}`, 'x'])), g: 'y' });
    const r = await indexCommits(
      t,
      [
        { sha: 'big', tree: big, parentTree: null },
        { sha: 'small', tree: small, parentTree: big },
      ],
      { ...BUDGET, maxChangesPerCommit: 10 },
    );
    expect(r.indexed).toEqual([
      { sha: 'big', gap: true, changes: [] },
      { sha: 'small', gap: false, changes: [{ path: 'g', status: 'added' }] },
    ]);
  });

  it('stops at the shared tree-read budget, but always makes progress on the first commit', async () => {
    const t = new Trees();
    const deep = (v: string) => t.tree({ 'a/b/c/d/e.txt': v });
    const t1 = await deep('1');
    const t2 = await deep('2');
    const t3 = await deep('3');
    const commits = [
      { sha: 'c2', tree: t2, parentTree: t1 },
      { sha: 'c3', tree: t3, parentTree: t2 },
    ];
    const one = await indexCommits(t, commits, { ...BUDGET, maxTreeReads: 12 });
    expect(one.indexed.map((c) => c.sha)).toEqual(['c2']);
    expect(one.indexed[0]!.gap).toBe(false);
    expect(one.stopped).toBe('maxTreeReads');
    expect(one.treeReads).toBeLessThanOrEqual(12);

    const starved = await indexCommits(t, commits, { ...BUDGET, maxTreeReads: 3 });
    expect(starved.indexed).toEqual([{ sha: 'c2', gap: true, changes: [] }]);
    expect(starved.stopped).toBe('maxTreeReads');
  });

  it('stops at the row budget after the first commit', async () => {
    const t = new Trees();
    const t1 = await t.tree({ a: '1', b: '1' });
    const t2 = await t.tree({ a: '2', b: '2' });
    const r = await indexCommits(
      t,
      [
        { sha: 'c1', tree: t1, parentTree: null },
        { sha: 'c2', tree: t2, parentTree: t1 },
      ],
      { ...BUDGET, maxRows: 3 },
    );
    expect(r.indexed.map((c) => c.sha)).toEqual(['c1']);
    expect(r.stopped).toBe('maxRows');
  });

  it('fails loudly on a tree read error instead of indexing a partial commit', async () => {
    const failing: TreeReader = {
      async readTree() {
        throw new Error('upstream 503');
      },
    };
    await expect(indexCommits(failing, [{ sha: 'c', tree: 'a'.repeat(40), parentTree: 'b'.repeat(40) }], BUDGET)).rejects.toThrow(/upstream 503/);
  });

  it('fails on a missing tree instead of reading it as an empty directory', async () => {
    const t = new Trees();
    const t1 = await t.tree({ a: '1', b: '1' });
    // The parent tree does not exist: diffing against "empty" would list every path as added.
    const r = indexCommits(t, [{ sha: 'c', tree: t1, parentTree: 'f'.repeat(40) }], BUDGET);
    await expect(r).rejects.toBeInstanceOf(HistoryReadError);
    await expect(r).rejects.toThrow(/missing tree/);
  });

  it('stops at the path-byte budget after the first commit, and gaps a first commit over it', async () => {
    const t = new Trees();
    const long = 'x'.repeat(60);
    const t1 = await t.tree({ [long]: '1' });
    const t2 = await t.tree({ [long]: '2' });
    const commits = [
      { sha: 'c1', tree: t1, parentTree: null },
      { sha: 'c2', tree: t2, parentTree: t1 },
    ];
    const r = await indexCommits(t, commits, { ...BUDGET, maxRowBytes: 100 });
    expect(r.indexed.map((c) => c.sha)).toEqual(['c1']);
    expect(r.stopped).toBe('maxRows');
    const tiny = await indexCommits(t, commits, { ...BUDGET, maxRowBytes: 10 });
    expect(tiny.indexed[0]).toEqual({ sha: 'c1', gap: true, changes: [] });
  });
});
