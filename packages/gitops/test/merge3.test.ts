/**
 * Tree-level three-way merge over an in-memory object store. Exact parity
 * with `git merge-tree --write-tree` across many shapes is the corpus suite
 * (merge3.corpus.test.ts); these cases pin the result shape, budgets and
 * failure handling.
 */

import { describe, expect, it } from 'vitest';
import { buildBlob, buildTree, parseTree, type GitObject, type TreeEntry } from '../src/index';
import { BlobTooLargeError, merge3, type MergeReader } from '../src/merge3';

const enc = (s: string) => new TextEncoder().encode(s);

class MemStore implements MergeReader {
  readonly objects = new Map<string, GitObject>();
  treeReads = 0;
  blobReads = 0;

  put(obj: GitObject): string {
    this.objects.set(obj.hash, obj);
    return obj.hash;
  }

  async readTree(hash: string): Promise<TreeEntry[] | null> {
    this.treeReads++;
    const o = this.objects.get(hash);
    return o && o.type === 'tree' ? parseTree(o.raw) : null;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    this.blobReads++;
    const o = this.objects.get(hash);
    return o && o.type === 'blob' ? o.raw.subarray(o.raw.indexOf(0) + 1) : null;
  }
}

type Spec = Record<string, string>;

/** Writes a nested tree for a flat `path -> content` map and returns its hash. */
async function writeTree(store: MemStore, files: Spec, opts: { skipBlobs?: boolean } = {}): Promise<string> {
  const node = new Map<string, Spec | string>();
  const dirs = new Map<string, Spec>();
  for (const [path, content] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash === -1) node.set(path, content);
    else {
      const d = path.slice(0, slash);
      const sub = dirs.get(d) ?? {};
      sub[path.slice(slash + 1)] = content;
      dirs.set(d, sub);
    }
  }
  const entries: TreeEntry[] = [];
  for (const [name, content] of node) {
    const blob = await buildBlob(enc(content as string));
    if (!opts.skipBlobs) store.put(blob);
    entries.push({ mode: '100644', name, hash: blob.hash });
  }
  for (const [name, sub] of dirs) entries.push({ mode: '40000', name, hash: await writeTree(store, sub, opts) });
  return store.put(await buildTree(entries));
}

const base: Spec = {
  'README.md': 'hello\n',
  'src/a.txt': 'a1\na2\na3\na4\na5\n',
  'src/b.txt': 'b1\nb2\n',
  'docs/guide/intro.md': 'intro\n',
};

describe('merge3', () => {
  it('returns the shared tree without reading when both sides agree', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'README.md': 'hi\n' });
    store.treeReads = 0;
    expect(await merge3(store, b, o, o)).toMatchObject({ clean: true, treeHash: o, objects: [], conflicts: [], truncated: false });
    expect(await merge3(store, b, b, o)).toMatchObject({ clean: true, treeHash: o, objects: [] });
    expect(await merge3(store, b, o, b)).toMatchObject({ clean: true, treeHash: o, objects: [] });
    expect(store.treeReads).toBe(0);
  });

  it('merges disjoint edits into a new tree, returning only the objects it created', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'src/a.txt': 'A1\na2\na3\na4\na5\n', 'new/ours.txt': 'o\n' });
    const t = await writeTree(store, { ...base, 'src/a.txt': 'a1\na2\na3\na4\nA5\n', 'README.md': 'bye\n' });
    const expected = await writeTree(new MemStore(), {
      ...base,
      'src/a.txt': 'A1\na2\na3\na4\nA5\n',
      'new/ours.txt': 'o\n',
      'README.md': 'bye\n',
    });
    const r = await merge3(store, b, o, t);
    expect(r).toMatchObject({ clean: true, treeHash: expected, conflicts: [], truncated: false });
    const created = new Map(r.objects.map((x) => [x.hash, x.type]));
    expect(created.get(expected)).toBe('tree');
    expect(created.get((await buildBlob(enc('A1\na2\na3\na4\nA5\n'))).hash)).toBe('blob');
    // Only edited directories (root, src/, new/) are rebuilt; docs/ is reused.
    expect([...created.values()].filter((type) => type === 'tree')).toHaveLength(3);
    const docsTree = parseTree(store.objects.get(b)!.raw).find((e) => e.name === 'docs')!.hash;
    expect(created.has(docsTree)).toBe(false);
    expect(r.blobReads).toBe(3);
  });

  it('reports content conflicts with the three sides and no tree', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'src/b.txt': 'ours\nb2\n' });
    const t = await writeTree(store, { ...base, 'src/b.txt': 'theirs\nb2\n' });
    const r = await merge3(store, b, o, t);
    expect(r.clean).toBe(false);
    expect(r.treeHash).toBeNull();
    expect(r.objects).toEqual([]);
    expect(r.conflicts).toEqual([
      {
        path: 'src/b.txt',
        kind: 'content',
        paths: ['src/b.txt'],
        hunks: 1,
        base: { path: 'src/b.txt', mode: '100644', hash: (await buildBlob(enc('b1\nb2\n'))).hash },
        ours: { path: 'src/b.txt', mode: '100644', hash: (await buildBlob(enc('ours\nb2\n'))).hash },
        theirs: { path: 'src/b.txt', mode: '100644', hash: (await buildBlob(enc('theirs\nb2\n'))).hash },
      },
    ]);
  });

  it('reports modify/delete and merges a modification into an exact rename', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const moved = base['src/a.txt']!;
    const without = (spec: Spec, ...paths: string[]) => Object.fromEntries(Object.entries(spec).filter(([p]) => !paths.includes(p)));
    const t = await writeTree(store, { ...base, 'src/a.txt': 'a1\na2\nA3\na4\na5\n', 'src/b.txt': 'b1\nB2\n' });

    const o = await writeTree(store, { ...without(base, 'src/a.txt', 'src/b.txt'), 'lib/a.txt': moved });
    const r = await merge3(store, b, o, t);
    expect(r.conflicts.map((c) => [c.kind, c.paths])).toEqual([['modify-delete', ['src/b.txt']]]);

    const renamed = await writeTree(store, { ...without(base, 'src/a.txt'), 'lib/a.txt': moved });
    const clean = await merge3(store, b, renamed, t);
    const expected = await writeTree(new MemStore(), {
      'README.md': 'hello\n',
      'lib/a.txt': 'a1\na2\nA3\na4\na5\n',
      'src/b.txt': 'b1\nB2\n',
      'docs/guide/intro.md': 'intro\n',
    });
    expect(clean).toMatchObject({ clean: true, treeHash: expected });
  });

  it('truncates instead of guessing when the tree-read budget runs out', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'docs/guide/intro.md': 'x\n' });
    const t = await writeTree(store, { ...base, 'src/a.txt': 'y\n' });
    const r = await merge3(store, b, o, t, { maxTreeReads: 3 });
    expect(r).toMatchObject({ clean: false, treeHash: null, truncated: true, truncatedReason: 'maxTreeReads' });
  });

  it('truncates on a missing blob and on the blob size budget', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'src/a.txt': 'A1\na2\na3\na4\na5\n' });
    const t = await writeTree(store, { ...base, 'src/a.txt': 'a1\na2\na3\na4\nA5\n' });
    expect(await merge3(store, b, o, t, { maxBlobBytes: 8 })).toMatchObject({ truncated: true, truncatedReason: 'maxBlobBytes', treeHash: null });

    const missing = new MemStore();
    const mb = await writeTree(missing, base);
    const mo = await writeTree(missing, { ...base, 'src/a.txt': 'A1\na2\na3\na4\na5\n' }, { skipBlobs: true });
    const mt = await writeTree(missing, { ...base, 'src/a.txt': 'a1\na2\na3\na4\nA5\n' });
    expect(await merge3(missing, mb, mo, mt)).toMatchObject({ truncated: true, truncatedReason: 'missingObject', treeHash: null });
  });

  it('truncates on the blob-read budget', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'src/a.txt': 'A1\na2\na3\na4\na5\n' });
    const t = await writeTree(store, { ...base, 'src/a.txt': 'a1\na2\na3\na4\nA5\n' });
    expect(await merge3(store, b, o, t, { maxBlobReads: 2 })).toMatchObject({ truncated: true, truncatedReason: 'maxBlobReads' });
  });

  /** `count` files of `size` bytes edited on their first line by ours and their last line by theirs. */
  async function manyDivergentFiles(store: MemStore, count: number, size: number) {
    const body = Array.from({ length: Math.ceil(size / 16) }, (_, i) => `line ${String(i).padStart(9, '0')}`);
    const b: Spec = {};
    const o: Spec = {};
    const t: Spec = {};
    for (let i = 0; i < count; i++) {
      const lines = body.map((l) => `${i}:${l}`);
      b[`big/f${i}.txt`] = `${lines.join('\n')}\n`;
      o[`big/f${i}.txt`] = `${['OURS', ...lines.slice(1)].join('\n')}\n`;
      t[`big/f${i}.txt`] = `${[...lines.slice(0, -1), 'THEIRS'].join('\n')}\n`;
    }
    return { b: await writeTree(store, b), o: await writeTree(store, o), t: await writeTree(store, t) };
  }

  it('truncates with maxMergedBytes once many individually permitted merged blobs would exceed the aggregate budget', async () => {
    const store = new MemStore();
    const { b, o, t } = await manyDivergentFiles(store, 12, 64 * 1024);
    const roomy = await merge3(store, b, o, t, { maxMergedBytes: 64 * 1024 * 1024 });
    expect(roomy).toMatchObject({ clean: true, truncated: false });
    const retained = roomy.objects.reduce((n, x) => n + x.raw.length + x.store.length, 0);
    expect(retained).toBeGreaterThan(12 * 64 * 1024);

    // Every blob is far under maxBlobBytes and within the read budget; only the total is too large.
    const r = await merge3(store, b, o, t, { maxMergedBytes: 4 * 64 * 1024, maxBlobBytes: 1024 * 1024 });
    expect(r).toMatchObject({ clean: false, truncated: true, truncatedReason: 'maxMergedBytes', treeHash: null, objects: [] });
    expect(r.blobReads).toBeLessThan(36);
  });

  it('runs one content merge at a time, so at most three source blobs are in flight', async () => {
    const store = new MemStore();
    const { b, o, t } = await manyDivergentFiles(store, 10, 256);
    let inFlight = 0;
    let peak = 0;
    const slow: MergeReader = {
      readTree: (h) => store.readTree(h),
      readBlob: async (h) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return store.readBlob(h);
      },
    };
    const r = await merge3(slow, b, o, t);
    expect(r).toMatchObject({ clean: true, blobReads: 30 });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('a reader refusing an oversized blob truncates with maxBlobBytes; other read failures are readError', async () => {
    const store = new MemStore();
    const b = await writeTree(store, base);
    const o = await writeTree(store, { ...base, 'src/a.txt': 'A1\na2\na3\na4\na5\n' });
    const t = await writeTree(store, { ...base, 'src/a.txt': 'a1\na2\na3\na4\nA5\n' });
    const refusing: MergeReader = {
      readTree: (h) => store.readTree(h),
      readBlob: async () => {
        throw new BlobTooLargeError('too big');
      },
    };
    expect(await merge3(refusing, b, o, t)).toMatchObject({ truncated: true, truncatedReason: 'maxBlobBytes', treeHash: null });
    const failing: MergeReader = {
      readTree: (h) => store.readTree(h),
      readBlob: async () => {
        throw new Error('upstream 500');
      },
    };
    expect(await merge3(failing, b, o, t)).toMatchObject({ truncated: true, truncatedReason: 'readError', truncatedDetail: 'upstream 500' });
  });
});
