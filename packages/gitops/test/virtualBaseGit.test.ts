/**
 * Criss-cross merges checked against real git: with `refuseAmbiguousRenames`
 * on the inner merges and the outer one, a merge that is not refused gives
 * the tree `git merge-tree --write-tree` gives, and is never clean where git
 * conflicts. Exact renames git pairs the same way merge; renames git might
 * pair differently are refused.
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
  merge3,
  mergeBase,
  parseTree,
  virtualMergeBase,
  writePack,
  type CommitReader,
  type GitObject,
  type MergeReader,
} from '../src/index';

let dir = '';
let repoSeq = 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-virtualbase-git-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string>;
const enc = (s: string) => new TextEncoder().encode(s);
const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);

class Store implements CommitReader, MergeReader {
  objects = new Map<string, GitObject>();
  private time = 1_790_000_000;

  add(o: GitObject): GitObject {
    this.objects.set(o.hash, o);
    return o;
  }

  /** Nested paths become nested trees. */
  async tree(files: Files): Promise<string> {
    const entries = [];
    const dirs = new Map<string, Files>();
    for (const path of Object.keys(files).sort()) {
      const slash = path.indexOf('/');
      if (slash >= 0) {
        const sub = dirs.get(path.slice(0, slash)) ?? {};
        sub[path.slice(slash + 1)] = files[path]!;
        dirs.set(path.slice(0, slash), sub);
        continue;
      }
      const blob = this.add(await buildBlob(enc(files[path]!)));
      entries.push({ mode: '100644', name: path, hash: blob.hash });
    }
    for (const [name, sub] of dirs) entries.push({ mode: '40000', name, hash: await this.tree(sub) });
    return this.add(await buildTree(entries)).hash;
  }

  async commit(files: Files, parents: string[]): Promise<string> {
    const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: this.time++ };
    const tree = await this.tree(files);
    return this.add(await buildCommit({ tree, parents, author: ident, committer: ident, message: `c${this.time}` })).hash;
  }

  async readCommit(sha: string) {
    const o = this.objects.get(sha);
    if (!o || o.type !== 'commit') return null;
    const text = new TextDecoder().decode(body(o));
    const treeHash = /^tree ([0-9a-f]{40})$/m.exec(text)![1]!;
    const parents = [...text.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
    return { treeHash, parents };
  }

  async readTree(hash: string) {
    const o = this.objects.get(hash);
    return o && o.type === 'tree' ? parseTree(body(o)) : null;
  }

  async readBlob(hash: string) {
    const o = this.objects.get(hash);
    return o && o.type === 'blob' ? body(o).slice() : null;
  }
}

/** A reader that also serves `objects` (created by a merge, not stored). */
function withObjects(store: Store, objects: readonly GitObject[]): MergeReader {
  const byHash = new Map(objects.map((o) => [o.hash, o]));
  return {
    readTree: async (hash) => {
      const o = byHash.get(hash);
      return o?.type === 'tree' ? parseTree(body(o)) : store.readTree(hash);
    },
    readBlob: async (hash) => {
      const o = byHash.get(hash);
      return o?.type === 'blob' ? body(o).slice() : store.readBlob(hash);
    },
  };
}

async function gitMergeTree(store: Store, ours: string, theirs: string): Promise<{ clean: boolean; tree: string }> {
  const bare = join(dir, `r${++repoSeq}.git`);
  spawnSync('git', ['init', '-q', '--bare', bare], { env: GIT_ENV });
  const unpack = spawnSync('git', ['-C', bare, 'unpack-objects', '-q'], { input: await writePack([...store.objects.values()]), env: GIT_ENV });
  if (unpack.status !== 0) throw new Error(unpack.stderr.toString());
  const r = spawnSync('git', ['-C', bare, 'merge-tree', '--write-tree', ours, theirs], { env: GIT_ENV });
  if (r.status !== 0 && r.status !== 1) throw new Error(r.stderr.toString());
  return { clean: r.status === 0, tree: r.stdout.toString().split('\n')[0]!.trim() };
}

/** The platform's criss-cross merge: virtual base, then the outer merge, both refusing ambiguous renames. */
async function ourMerge(store: Store, ours: string, theirs: string) {
  const mb = await mergeBase(store, ours, theirs);
  expect(mb.bases.length).toBeGreaterThan(1);
  const v = await virtualMergeBase(store, mb.bases, { refuseAmbiguousRenames: true });
  if (v.truncated || v.treeHash === null) return { refused: v.truncatedReason } as const;
  const [o, t] = await Promise.all([store.readCommit(ours), store.readCommit(theirs)]);
  const m = await merge3(withObjects(store, v.objects), v.treeHash, o!.treeHash, t!.treeHash, { refuseAmbiguousRenames: true });
  if (m.truncated) return { refused: m.truncatedReason } as const;
  return { merge: m } as const;
}

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`);
const text = (ls: string[]) => ls.join('\n') + '\n';
function edit(file: string, at: number, value: string): string {
  const ls = file.split('\n').slice(0, -1);
  ls[at] = value;
  return text(ls);
}

/** root -> x and root -> y; m1 = merge(x, y), m2 = merge(y, x) with tree `merged`; ours and theirs grow from them. */
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

describe('criss-cross merges against git with refuseAmbiguousRenames', () => {
  it('merges exact renames on both stages exactly like git', async () => {
    const store = new Store();
    const { ours, theirs } = await crissCross(
      store,
      ROOT,
      ({ 'a.txt': a, ...rest }) => ({ ...rest, 'docs/a.txt': a! }),
      (f) => ({ ...f, 'c.txt': edit(f['c.txt']!, 9, 'Y') }),
      ({ 'a.txt': a, ...rest }) => ({ ...rest, 'docs/a.txt': a!, 'c.txt': edit(rest['c.txt']!, 9, 'Y') }),
      ({ 'b.txt': b, ...rest }) => ({ ...rest, 'lib/b.txt': b! }),
      (f) => ({ ...f, 'docs/a.txt': edit(f['docs/a.txt']!, 4, 'T'), 'b.txt': edit(f['b.txt']!, 2, 'T') }),
    );
    const got = await ourMerge(store, ours, theirs);
    expect(got.merge?.clean).toBe(true);
    const git = await gitMergeTree(store, ours, theirs);
    expect(git.clean).toBe(true);
    expect(got.merge!.treeHash).toBe(git.tree);
  });

  it('refuses bases where git could detect a similarity rename', async () => {
    const store = new Store();
    // x renames a.txt with an edit: git pairs it, the exact model sees a delete and an add.
    const { ours, theirs } = await crissCross(
      store,
      ROOT,
      ({ 'a.txt': a, ...rest }) => ({ ...rest, 'moved.txt': edit(a!, 3, 'X') }),
      (f) => ({ ...f, 'c.txt': edit(f['c.txt']!, 9, 'Y') }),
      ({ 'a.txt': a, ...rest }) => ({ ...rest, 'moved.txt': edit(a!, 3, 'X'), 'c.txt': edit(rest['c.txt']!, 9, 'Y') }),
      (f) => f,
      (f) => ({ ...f, 'b.txt': edit(f['b.txt']!, 1, 'T') }),
    );
    expect(await ourMerge(store, ours, theirs)).toEqual({ refused: 'ambiguousRenames' });
  });

  it('stops a merge the exact model would publish where git conflicts (rename/delete)', async () => {
    const store = new Store();
    const base = await store.tree(ROOT);
    const { 'b.txt': b, ...rest } = ROOT;
    // ours renames b.txt with an edit; theirs deletes b.txt. git: rename/delete conflict.
    const oursTree = await store.tree({ ...rest, 'renamed.txt': edit(b!, 0, 'O') });
    const theirsTree = await store.tree({ 'a.txt': ROOT['a.txt']!, 'c.txt': edit(ROOT['c.txt']!, 5, 'T') });
    expect((await merge3(store, base, oursTree, theirsTree)).clean).toBe(true);
    expect(await merge3(store, base, oursTree, theirsTree, { refuseAmbiguousRenames: true })).toMatchObject({
      clean: false,
      treeHash: null,
      truncated: true,
      truncatedReason: 'ambiguousRenames',
    });
  });

  it('refuses an exact rename out of a directory the other side adds into, or with two candidates; merges a plain move', async () => {
    const store = new Store();
    const files: Files = { ...ROOT, 'lib/one.txt': text(lines(12, 'one')) };
    const base = await store.tree(files);
    const { 'lib/one.txt': one, ...rest } = files;
    const moved = await store.tree({ ...rest, 'pkg/one.txt': one! });
    const addsInLib = await store.tree({ ...files, 'lib/two.txt': text(lines(12, 'two')) });
    const editsC = await store.tree({ ...files, 'c.txt': edit(files['c.txt']!, 3, 'T') });
    const copies = await store.tree({ ...rest, 'pkg/one.txt': one!, 'pkg/copy.txt': one! });
    const opts = { refuseAmbiguousRenames: true };
    expect(await merge3(store, base, moved, addsInLib, opts)).toMatchObject({ truncatedReason: 'ambiguousRenames' });
    expect(await merge3(store, base, copies, editsC, opts)).toMatchObject({ truncatedReason: 'ambiguousRenames' });
    expect(await merge3(store, base, moved, editsC, opts)).toMatchObject({ clean: true });
  });

  it('never publishes a tree git would not write on a seeded corpus with edits, deletes, renames and adds', async () => {
    const tally = { refused: 0, clean: 0, conflicted: 0, renamesAccepted: 0 };
    const mismatches: unknown[] = [];
    const root: Files = { ...ROOT, 'lib/one.txt': text(lines(12, 'one')), 'lib/two.txt': text(lines(12, 'two')) };
    for (let seed = 1; seed <= 300; seed++) {
      let s = seed * 7919;
      const rand = () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 2 ** 32;
      };
      const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
      const names = Object.keys(root);
      const fresh = (name: string) => text(lines(12, name));
      let exactRename = false;
      // Each op is fixed when drawn and tolerates a missing file.
      const randomOp = (tag: string): ((f: Files) => Files) => {
        const name = pick(names);
        const at = Math.floor(rand() * 12);
        const r = rand();
        const value = `${tag}${seed}`;
        if (r < 0.5) return (f) => ({ ...f, [name]: edit(f[name] ?? fresh(name), at, value) });
        if (r < 0.62) {
          return (f) => {
            const { [name]: _, ...rest } = f;
            return rest;
          };
        }
        const to = `${pick(['', 'd/', 'lib/', 'pkg/'])}${name.replace('/', '-')}.${tag}`;
        if (r < 0.86) {
          const edited = r >= 0.74;
          if (!edited) exactRename = true;
          return (f) => {
            const moved = f[name];
            if (moved === undefined) return f;
            const { [name]: _, ...rest } = f;
            return { ...rest, [to]: edited ? edit(moved, at, value) : moved };
          };
        }
        return (f) => ({ ...f, [`${pick(['d/', 'lib/'])}new-${tag}.txt`]: fresh(value) });
      };
      const twoOps = (tag: string): ((f: Files) => Files) => {
        const a = randomOp(`${tag}1`);
        const b = randomOp(`${tag}2`);
        return (f) => b(a(f));
      };
      const store = new Store();
      const x = twoOps('X');
      const y = twoOps('Y');
      const { ours, theirs } = await crissCross(store, root, x, y, (f) => y(x(f)), twoOps('O'), twoOps('T'));
      const mb = await mergeBase(store, ours, theirs);
      if (mb.bases.length < 2) continue;
      const got = await ourMerge(store, ours, theirs);
      if (!got.merge) {
        tally.refused++;
        continue;
      }
      const m = got.merge;
      const git = await gitMergeTree(store, ours, theirs);
      if (m.clean) tally.clean++;
      else tally.conflicted++;
      if (m.clean && exactRename) tally.renamesAccepted++;
      // A conflict where git merges is safe (nothing is published); the reverse, or a different tree, is not.
      if ((m.clean && !git.clean) || (m.clean && m.treeHash !== git.tree)) mismatches.push({ seed, ours: m.treeHash, git });
    }
    expect(mismatches).toEqual([]);
    expect(tally.refused).toBeGreaterThan(0);
    expect(tally.clean).toBeGreaterThan(0);
    expect(tally.renamesAccepted).toBeGreaterThan(0);
  }, 120_000);
});
