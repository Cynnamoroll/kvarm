/**
 * Virtual merge base for criss-cross histories, checked against real git:
 * whenever `virtualMergeBase` accepts a pair of bases, the outer merge over
 * its tree must give the tree `git merge-tree --write-tree` gives (or conflict
 * where git conflicts), and the merged tree must be closed over the store plus
 * the published objects.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBlob,
  buildCommit,
  buildTree,
  encode,
  merge3,
  mergeBase,
  objectBytes,
  parseTree,
  reachableObjects,
  readerWith,
  virtualMergeBase,
  writePack,
  type CommitReader,
  type GitObject,
  type MergeReader,
} from '../src/index';

let dir = '';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-virtualbase-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string>;

class Store implements CommitReader, MergeReader {
  objects = new Map<string, GitObject>();
  private time = 1_790_000_000;

  add(o: GitObject): GitObject {
    this.objects.set(o.hash, o);
    return o;
  }

  async tree(files: Files): Promise<string> {
    const entries = [];
    for (const name of Object.keys(files).sort()) {
      const blob = this.add(await buildBlob(encode(files[name]!)));
      entries.push({ mode: '100644', name, hash: blob.hash });
    }
    return this.add(await buildTree(entries)).hash;
  }

  async commit(files: Files, parents: string[]): Promise<string> {
    const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: this.time++ };
    const tree = await this.tree(files);
    return this.add(await buildCommit({ tree, parents, author: ident, committer: ident, message: `c${this.time}` })).hash;
  }

  private body(o: GitObject): Uint8Array {
    return o.raw.subarray(o.raw.indexOf(0) + 1);
  }

  async readCommit(sha: string) {
    const o = this.objects.get(sha);
    if (o?.type !== 'commit') return null;
    const head = new TextDecoder().decode(this.body(o)).split('\n\n')[0]!;
    return {
      treeHash: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
      parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
    };
  }

  async readTree(hash: string) {
    const o = this.objects.get(hash);
    return o?.type === 'tree' ? parseTree(this.body(o)) : null;
  }

  async readBlob(hash: string) {
    const o = this.objects.get(hash);
    return o?.type === 'blob' ? this.body(o).slice() : null;
  }
}

let repoSeq = 0;
async function gitMergeTree(store: Store, ours: string, theirs: string): Promise<{ clean: boolean; tree: string }> {
  const bare = join(dir, `r${++repoSeq}.git`);
  spawnSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });
  const unpack = spawnSync('git', ['-C', bare, 'unpack-objects', '-q'], { input: await writePack([...store.objects.values()]), env: GIT_ENV });
  if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
  const r = spawnSync('git', ['-C', bare, 'merge-tree', '--write-tree', ours, theirs], { env: GIT_ENV });
  if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.toString());
  return { clean: r.status === 0, tree: r.stdout.toString().split('\n')[0]!.trim() };
}

/** Our merge of two tips with a criss-cross history: virtual base, then the outer merge. */
async function ourMerge(store: Store, ours: string, theirs: string) {
  const mb = await mergeBase(store, ours, theirs);
  expect(mb.truncated).toBe(false);
  expect(mb.bases).toHaveLength(2);
  const v = await virtualMergeBase(store, mb.bases);
  if (!v.ok) return { virtual: v } as const;
  const [o, t] = await Promise.all([store.readCommit(ours), store.readCommit(theirs)]);
  const m = await merge3(readerWith(store, v.objects), v.treeHash, o!.treeHash, t!.treeHash);
  return { virtual: v, merge: m } as const;
}

/** Every object under `tree` is stored or among `published`. */
async function closed(store: Store, tree: string, published: GitObject[]): Promise<boolean> {
  const pool = new Map(published.map((o) => [o.hash, o]));
  const walk = async (hash: string): Promise<boolean> => {
    const own = pool.get(hash);
    const entries = own ? parseTree(own.raw.subarray(own.raw.indexOf(0) + 1)) : await store.readTree(hash);
    if (!entries) return false;
    for (const e of entries) {
      if (e.mode === '40000' ? !(await walk(e.hash)) : !pool.has(e.hash) && !(await store.readBlob(e.hash))) return false;
    }
    return true;
  };
  return walk(tree);
}

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const text = (ls: string[]) => ls.join('\n') + '\n';
function edit(file: string, at: number, value: string): string {
  const ls = file.split('\n').slice(0, -1);
  ls[at] = value;
  return text(ls);
}

/**
 * root -> x (edits by `xEdit`) and root -> y (`yEdit`); m1 = merge(x, y) and
 * m2 = merge(y, x) with the same tree; ours = m1 + `oursEdit`, theirs = m2 + `theirsEdit`.
 */
async function crissCross(
  store: Store,
  root: Files,
  xEdit: (f: Files) => Files,
  yEdit: (f: Files) => Files,
  merged: (f: Files) => Files,
  oursEdit: (f: Files) => Files,
  theirsEdit: (f: Files) => Files,
) {
  const r = await store.commit(root, []);
  const x = await store.commit(xEdit(root), [r]);
  const y = await store.commit(yEdit(root), [r]);
  const m = merged(root);
  const m1 = await store.commit(m, [x, y]);
  const m2 = await store.commit({ ...m }, [y, x]);
  const ours = await store.commit(oursEdit(m), [m1]);
  const theirs = await store.commit(theirsEdit(m), [m2]);
  return { ours, theirs };
}

const ROOT: Files = { 'a.txt': text(lines(12, 'a')), 'b.txt': text(lines(12, 'b')), 'c.txt': text(lines(12, 'c')) };

describe('virtualMergeBase', () => {
  it('merges a clean criss-cross exactly like git merge-tree', async () => {
    const store = new Store();
    const { ours, theirs } = await crissCross(
      store,
      ROOT,
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 2, 'X') }),
      (f) => ({ ...f, 'c.txt': edit(f['c.txt']!, 9, 'Y') }),
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 2, 'X'), 'c.txt': edit(f['c.txt']!, 9, 'Y') }),
      (f) => ({ ...f, 'b.txt': edit(f['b.txt']!, 1, 'O') }),
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 8, 'T') }),
    );
    const got = await ourMerge(store, ours, theirs);
    expect(got.virtual.ok).toBe(true);
    expect(got.merge?.clean).toBe(true);
    const git = await gitMergeTree(store, ours, theirs);
    expect(git.clean).toBe(true);
    expect(got.merge!.treeHash).toBe(git.tree);
    const published = reachableObjects(got.merge!.treeHash!, [...got.merge!.objects, ...(got.virtual.ok ? got.virtual.objects : [])]);
    expect(await closed(store, got.merge!.treeHash!, published)).toBe(true);
  });

  it('is independent of the order of the bases', async () => {
    const store = new Store();
    const { ours, theirs } = await crissCross(
      store,
      ROOT,
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 2, 'X') }),
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 10, 'Y') }),
      (f) => ({ ...f, 'a.txt': edit(edit(f['a.txt']!, 2, 'X'), 10, 'Y') }),
      (f) => f,
      (f) => f,
    );
    const { bases } = await mergeBase(store, ours, theirs);
    const a = await virtualMergeBase(store, bases);
    const b = await virtualMergeBase(store, [...bases].reverse());
    expect(a.ok && b.ok && a.treeHash === b.treeHash).toBe(true);
  });

  it('refuses bases that conflict with each other', async () => {
    const store = new Store();
    const { ours, theirs } = await crissCross(
      store,
      ROOT,
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 4, 'X') }),
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 4, 'Y') }),
      (f) => ({ ...f, 'a.txt': edit(f['a.txt']!, 4, 'XY') }),
      (f) => ({ ...f, 'b.txt': edit(f['b.txt']!, 0, 'O') }),
      (f) => ({ ...f, 'c.txt': edit(f['c.txt']!, 0, 'T') }),
    );
    const got = await ourMerge(store, ours, theirs);
    expect(got.virtual).toMatchObject({ ok: false, reason: 'bases-conflict' });
  });

  it('refuses anything but exactly two bases', async () => {
    const store = new Store();
    expect(await virtualMergeBase(store, ['a'.repeat(40)])).toMatchObject({ ok: false, reason: 'too-many-bases' });
    expect(await virtualMergeBase(store, ['a', 'b', 'c'].map((c) => c.repeat(40)))).toMatchObject({ ok: false, reason: 'too-many-bases' });
  });

  it('reports a missing base as a read failure, not a refusal', async () => {
    const store = new Store();
    const r = await store.commit(ROOT, []);
    expect(await virtualMergeBase(store, [r, 'f'.repeat(40)])).toMatchObject({ ok: false, reason: 'missingCommit' });
  });

  it('counts its created objects with objectBytes', async () => {
    const blob = await buildBlob(encode('hello\n'));
    expect(objectBytes([blob])).toBe(blob.raw.length + blob.store.length);
  });

  it('agrees with git on a seeded corpus of criss-cross merges', async () => {
    const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
    const tally = { accepted: 0, refused: 0, clean: 0, conflicted: 0 };
    const mismatches: unknown[] = [];
    for (const seed of seeds) {
      let s = seed;
      const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
      const names = Object.keys(ROOT);
      const randomEdit = (tag: string) => {
        const name = pick(names);
        const at = Math.floor(rand() * 12);
        return (f: Files) => ({ ...f, [name]: edit(f[name]!, at, `${tag}${seed}`) });
      };
      const store = new Store();
      const x = randomEdit('X');
      const y = randomEdit('Y');
      // The criss-cross merges keep both bases' edits when they do not touch
      // the same line, and pick a third value when they do.
      const merged = (f: Files) => {
        const fx = x(f);
        const fy = y(f);
        const out: Files = {};
        for (const n of names) {
          const lx = fx[n]!.split('\n');
          const ly = fy[n]!.split('\n');
          const lb = f[n]!.split('\n');
          out[n] = lb.map((l, i) => (lx[i] !== l && ly[i] !== l && lx[i] !== ly[i] ? `M${seed}` : lx[i] !== l ? lx[i]! : ly[i]!)).join('\n');
        }
        return out;
      };
      const { ours, theirs } = await crissCross(store, ROOT, x, y, merged, randomEdit('O'), randomEdit('T'));
      const mb = await mergeBase(store, ours, theirs);
      if (mb.bases.length !== 2) continue;
      const got = await ourMerge(store, ours, theirs);
      if (!got.virtual.ok) {
        tally.refused++;
        continue;
      }
      tally.accepted++;
      const git = await gitMergeTree(store, ours, theirs);
      const m = got.merge!;
      if (m.clean) tally.clean++;
      else tally.conflicted++;
      if (m.clean !== git.clean || (m.clean && m.treeHash !== git.tree)) mismatches.push({ seed, ours: m.clean ? m.treeHash : 'conflict', git });
      if (m.clean && !(await closed(store, m.treeHash!, reachableObjects(m.treeHash!, [...m.objects, ...got.virtual.objects])))) {
        mismatches.push({ seed, error: 'merged tree is not closed over the store and the published objects' });
      }
    }
    expect(mismatches).toEqual([]);
    // The corpus must exercise acceptance, refusal and both outer outcomes.
    expect(tally.accepted).toBeGreaterThan(10);
    expect(tally.refused).toBeGreaterThan(0);
    expect(tally.clean).toBeGreaterThan(0);
    expect(tally.conflicted).toBeGreaterThan(0);
  });
});
