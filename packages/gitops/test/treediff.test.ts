/**
 * Tree-diff engine tests. Trees are real git objects built by the gitops
 * builders and read back through an in-memory TreeReader, so hashing, pruning
 * and walk order are exercised exactly as in production (only the reader
 * differs). parseTree round-trips the builder.
 */

import { describe, expect, it } from 'vitest';
import { buildBlob, buildTree, parseTree, type GitObject, type TreeEntry } from '../src/index';
import { diffTrees, type TreeReader } from '../src/treediff';

class MemStore implements TreeReader {
  private readonly trees = new Map<string, Uint8Array>();
  reads = 0;

  async add(obj: GitObject): Promise<string> {
    if (obj.type === 'tree') this.trees.set(obj.hash, obj.raw);
    return obj.hash;
  }

  readTree(hash: string): Promise<TreeEntry[] | null> {
    this.reads++;
    const raw = this.trees.get(hash);
    return Promise.resolve(raw ? parseTree(raw) : null);
  }
}

const enc = (s: string) => new TextEncoder().encode(s);

async function makeStore() {
  const store = new MemStore();
  const blob = async (text: string, mode = '100644') => {
    const o = await buildBlob(enc(text));
    return { mode, name: '', hash: o.hash } as TreeEntry;
  };
  const blobHash = async (text: string) => (await buildBlob(enc(text))).hash;
  const tree = async (entries: TreeEntry[]) => {
    const o = await buildTree(entries);
    await store.add(o);
    return o.hash;
  };
  const file = (name: string, hash: string, mode = '100644'): TreeEntry => ({ mode, name, hash });
  const dir = (name: string, hash: string): TreeEntry => ({ mode: '40000', name, hash });
  return { store, blob, blobHash, tree, file, dir };
}

describe('parseTree', () => {
  it('round-trips buildTree', async () => {
    const { tree, file, blobHash } = await makeStore();
    const a = await blobHash('a');
    const sub = await tree([file('x.txt', a)]);
    const entries: TreeEntry[] = [file('b.txt', a, '100755'), { mode: '40000', name: 'sub', hash: sub }];
    const hash = await tree(entries);
    const store = new MemStore();
    const obj = await buildTree(entries);
    await store.add(obj);
    const parsed = parseTree(obj.raw);
    expect(parsed).toEqual(entries);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('diffTrees', () => {
  it('returns nothing for identical trees without reading', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const a = await blobHash('a');
    const t = await tree([file('a.txt', a)]);
    const res = await diffTrees(store, t, t);
    expect(res.changes).toEqual([]);
    expect(res.truncated).toBe(false);
    expect(res.treeReads).toBe(0);
  });

  it('prunes identical subtrees: only changed paths cost reads', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    const shared = await tree([file('same.txt', a), file('other.txt', b)]);
    const base = await tree([dir('shared', shared), file('root.txt', a)]);
    const head = await tree([dir('shared', shared), file('root.txt', b)]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      { path: 'root.txt', status: 'modified', oldMode: '100644', newMode: '100644', oldHash: a, newHash: b },
    ]);
    // base root + head root only; `shared` pruned by hash equality.
    expect(res.treeReads).toBe(2);
  });

  it('classifies added, removed, and modified files', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    const base = await tree([file('kept.txt', a), file('gone.txt', a)]);
    const head = await tree([file('kept.txt', a), file('new.txt', b)]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      { path: 'gone.txt', status: 'removed', oldMode: '100644', newMode: null, oldHash: a, newHash: null },
      { path: 'new.txt', status: 'added', oldMode: null, newMode: '100644', oldHash: null, newHash: b },
    ]);
  });

  it('flattens added and removed directories', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    // Distinct content per file so rename pairing doesn't kick in; this test
    // targets flatten coverage, not rename detection.
    const z = await blobHash('z');
    const base = await tree([dir('old', await tree([file('x.txt', a)]))]);
    const head = await tree([dir('new', await tree([dir('deeper', await tree([file('y.txt', b)])), file('z.txt', z)]))]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      { path: 'new/deeper/y.txt', status: 'added', oldMode: null, newMode: '100644', oldHash: null, newHash: b },
      { path: 'new/z.txt', status: 'added', oldMode: null, newMode: '100644', oldHash: null, newHash: z },
      { path: 'old/x.txt', status: 'removed', oldMode: '100644', newMode: null, oldHash: a, newHash: null },
    ]);
  });

  it('pairs exact renames by blob hash, preferring same basename', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const moved = await blobHash('moved content');
    const keep = await blobHash('keep content');
    const base = await tree([
      dir('dir1', await tree([file('a.txt', moved), file('keep.txt', keep)])),
    ]);
    const head = await tree([
      dir('dir1', await tree([file('keep.txt', keep)])),
      dir('dir2', await tree([file('b.txt', moved)])),
    ]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      {
        path: 'dir2/b.txt',
        status: 'renamed',
        oldMode: '100644',
        newMode: '100644',
        oldHash: moved,
        newHash: moved,
        oldPath: 'dir1/a.txt',
      },
    ]);
  });

  it('reports mode-only changes as typechange', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const a = await blobHash('same content');
    const base = await tree([file('run.sh', a, '100644')]);
    const head = await tree([file('run.sh', a, '100755')]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      { path: 'run.sh', status: 'typechange', oldMode: '100644', newMode: '100755', oldHash: a, newHash: a },
    ]);
  });

  it('reports tree-to-blob transitions as typechange', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const a = await blobHash('x');
    const base = await tree([dir('thing', await tree([file('inner.txt', a)]))]);
    const head = await tree([file('thing', a)]);
    const res = await diffTrees(store, base, head);
    expect(res.changes).toEqual([
      { path: 'thing', status: 'typechange', oldMode: '40000', newMode: '100644', oldHash: expect.any(String), newHash: a },
    ]);
  });

  it('truncates on the change budget and reports it', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    const c = await blobHash('c');
    const base = await tree([file('1.txt', a), file('2.txt', b), file('3.txt', c)]);
    const head = await tree([file('1.txt', c), file('2.txt', a), file('3.txt', b)]);
    const res = await diffTrees(store, base, head, { maxChanges: 2 });
    expect(res.truncated).toBe(true);
    expect(res.changes.length).toBe(2);
  });

  it('truncates on the read budget for deep trees', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    // base: a/b/c/d/x.txt = a ; head: same path = b — needs 8+ tree reads.
    const leafBase = await tree([file('x.txt', a)]);
    const leafHead = await tree([file('x.txt', b)]);
    const nest = async (leaf: string, depth: number) => {
      let hash = leaf;
      for (let i = 0; i < depth; i++) hash = await tree([dir('d', hash)]);
      return hash;
    };
    const base = await nest(leafBase, 3);
    const head = await nest(leafHead, 3);
    const res = await diffTrees(store, base, head, { maxTreeReads: 4 });
    expect(res.truncated).toBe(true);
    expect(res.truncatedReason).toBe('maxTreeReads');
    expect(res.changes.length).toBe(0);
  });

  it('names the change budget as the truncation reason', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const [a, b] = [await blobHash('a'), await blobHash('b')];
    const base = await tree([file('1.txt', a), file('2.txt', a)]);
    const head = await tree([file('1.txt', b), file('2.txt', b)]);
    const res = await diffTrees(store, base, head, { maxChanges: 1 });
    expect(res.truncatedReason).toBe('maxChanges');
    const full = await diffTrees(store, base, head);
    expect(full.truncated).toBe(false);
    expect(full.truncatedReason).toBeUndefined();
  });

  it('stops with a readError reason instead of rejecting when a tree read fails', async () => {
    const { store, tree, file, dir, blobHash } = await makeStore();
    const [a, b] = [await blobHash('a'), await blobHash('b')];
    const subBase = await tree([file('x.txt', a)]);
    const subHead = await tree([file('x.txt', b)]);
    const base = await tree([dir('sub', subBase), file('top.txt', a)]);
    const head = await tree([dir('sub', subHead), file('top.txt', b)]);
    const failing: TreeReader = {
      readTree: (hash) => (hash === subHead ? Promise.reject(new Error('Too many subrequests')) : store.readTree(hash)),
    };
    const res = await diffTrees(failing, base, head);
    expect(res.truncated).toBe(true);
    expect(res.truncatedReason).toBe('readError');
    expect(res.readError).toContain('Too many subrequests');
    // Nothing under the failed subtree is reported as added or removed.
    expect(res.changes.map((c) => c.path)).toEqual(['top.txt']);
  });

  it('sorts output by path deterministically', async () => {
    const { store, tree, file, blobHash } = await makeStore();
    const a = await blobHash('a');
    const b = await blobHash('b');
    const base = await tree([file('z.txt', a), file('m.txt', a), file('a.txt', a)]);
    const head = await tree([file('z.txt', b), file('m.txt', b), file('a.txt', b)]);
    const res = await diffTrees(store, base, head);
    expect(res.changes.map((c) => c.path)).toEqual(['a.txt', 'm.txt', 'z.txt']);
  });
});
