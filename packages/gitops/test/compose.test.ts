/**
 * Composition of candidate attempts: selected pieces of several heads fold
 * onto a start tree through merge3. Real git is the ground truth: the
 * in-memory objects are written as loose objects into a temp bare repo and
 * `git merge-tree --write-tree --merge-base=<base> <ours> <theirs>` is run
 * on the same trees.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBlob, buildTree, parseTree, type GitObject, type TreeEntry } from '../src/index';
import { composeTrees, selectTree } from '../src/compose';
import type { MergeReader } from '../src/merge3';

const enc = (s: string) => new TextEncoder().encode(s);
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LC_ALL: 'C' };

class MemStore implements MergeReader {
  readonly objects = new Map<string, GitObject>();

  put(obj: GitObject): string {
    this.objects.set(obj.hash, obj);
    return obj.hash;
  }

  async readTree(hash: string): Promise<TreeEntry[] | null> {
    const o = this.objects.get(hash);
    return o && o.type === 'tree' ? parseTree(o.raw) : null;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    const o = this.objects.get(hash);
    return o && o.type === 'blob' ? o.raw.subarray(o.raw.indexOf(0) + 1) : null;
  }
}

type Spec = Record<string, string>;

async function writeTree(store: MemStore, files: Spec): Promise<string> {
  const node = new Map<string, string>();
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
  for (const [name, content] of node) entries.push({ mode: '100644', name, hash: store.put(await buildBlob(enc(content))) });
  for (const [name, sub] of dirs) entries.push({ mode: '40000', name, hash: await writeTree(store, sub) });
  return store.put(await buildTree(entries));
}

let repo = '';
const store = new MemStore();

function sync(objects: Iterable<GitObject>): void {
  for (const o of objects) {
    const dir = join(repo, 'objects', o.hash.slice(0, 2));
    const file = join(dir, o.hash.slice(2));
    if (existsSync(file)) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, o.store);
  }
}

/** git's merge of two trees over a merge base: the tree oid when clean, else the conflicted paths. */
function gitMerge(base: string, ours: string, theirs: string): { clean: true; tree: string } | { clean: false; paths: string[] } {
  sync(store.objects.values());
  const r = spawnSync('git', ['--git-dir', repo, 'merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${base}`, ours, theirs], {
    env: GIT_ENV,
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git merge-tree failed: ${r.stderr.toString()}`);
  const parts = r.stdout.toString().split('\0');
  if (r.status === 0) return { clean: true, tree: parts[0]! };
  const paths: string[] = [];
  for (let i = 1; i < parts.length && parts[i] !== ''; i++) paths.push(parts[i]!);
  return { clean: false, paths: [...new Set(paths)].sort() };
}

const app = (line5: string) => ['a1', 'a2', 'a3', 'a4', line5, 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12'].join('\n') + '\n';
const shared = (first: string, last: string) => [first, 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', last].join('\n') + '\n';

const BASE: Spec = {
  'README.md': 'hello\n',
  'src/app.ts': app('a5'),
  'src/shared.ts': shared('s1', 's10'),
  'src/extra.ts': 'extra\n',
  'docs/b.md': 'docs\n',
};

let base = '';

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'gitops-compose-'));
  spawnSync('git', ['init', '--bare', '-q', repo], { env: GIT_ENV });
  base = await writeTree(store, BASE);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('composeTrees', () => {
  it('composes disjoint candidates to the tree git merge-tree writes', async () => {
    const a = await writeTree(store, { ...BASE, 'src/a.ts': 'export const a = 1;\n' });
    const b = await writeTree(store, { ...BASE, 'docs/b.md': 'docs edited\n' });
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a },
      { name: 'B', baseTree: base, headTree: b },
    ]);
    const expected = gitMerge(base, a, b);
    expect(expected.clean).toBe(true);
    expect(got).toMatchObject({ clean: true, conflicts: [], truncated: false });
    expect(got.treeHash).toBe(expected.clean ? expected.tree : null);
    sync(got.objects);
    const fsck = spawnSync('git', ['--git-dir', repo, 'ls-tree', '-r', got.treeHash!], { env: GIT_ENV });
    expect(fsck.status).toBe(0);
    expect(fsck.stdout.toString()).toContain('src/a.ts');
  });

  it('folds three candidates in order, like successive merge-tree runs', async () => {
    const a = await writeTree(store, { ...BASE, 'src/shared.ts': shared('S1', 's10') });
    const b = await writeTree(store, { ...BASE, 'src/shared.ts': shared('s1', 'S10') });
    const c = await writeTree(store, { ...BASE, 'docs/c.md': 'c\n' });
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a },
      { name: 'B', baseTree: base, headTree: b },
      { name: 'C', baseTree: base, headTree: c },
    ]);
    const ab = gitMerge(base, a, b);
    if (!ab.clean) throw new Error('fixture must merge');
    const abc = gitMerge(base, ab.tree, c);
    expect(abc.clean).toBe(true);
    expect(got.clean).toBe(true);
    expect(got.treeHash).toBe(abc.clean ? abc.tree : null);
    // Every created object the result needs is returned, and nothing unreachable.
    for (const o of got.objects) expect(['tree', 'blob']).toContain(o.type);
  });

  it('reports an incompatible pair with the conflicting path, the piece and no tree', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5') });
    const b = await writeTree(store, { ...BASE, 'src/app.ts': app('B5') });
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a },
      { name: 'B', baseTree: base, headTree: b },
    ]);
    const expected = gitMerge(base, a, b);
    expect(expected).toEqual({ clean: false, paths: ['src/app.ts'] });
    expect(got.clean).toBe(false);
    expect(got.treeHash).toBeNull();
    expect(got.objects).toEqual([]);
    expect(got.conflicts).toEqual([expect.objectContaining({ path: 'src/app.ts', kind: 'content', piece: 'B', hunks: 1 })]);
  });

  it('names only the incompatible path of a partially compatible pair', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5'), 'src/shared.ts': shared('S1', 's10') });
    const b = await writeTree(store, { ...BASE, 'src/app.ts': app('B5'), 'src/shared.ts': shared('s1', 'S10') });
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a },
      { name: 'B', baseTree: base, headTree: b },
    ]);
    expect(gitMerge(base, a, b)).toEqual({ clean: false, paths: ['src/app.ts'] });
    expect(got.clean).toBe(false);
    expect(got.treeHash).toBeNull();
    expect(got.conflicts.map((c) => c.path)).toEqual(['src/app.ts']);
  });

  it('keeps reporting later pieces after an incompatible one', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5') });
    const b = await writeTree(store, { ...BASE, 'src/app.ts': app('B5') });
    const c = await writeTree(store, { ...BASE, 'src/app.ts': app('C5'), 'docs/b.md': 'c docs\n' });
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a },
      { name: 'B', baseTree: base, headTree: b },
      { name: 'C', baseTree: base, headTree: c },
    ]);
    expect(got.clean).toBe(false);
    expect(got.conflicts.map((c) => [c.piece, c.path])).toEqual([
      ['B', 'src/app.ts'],
      ['C', 'src/app.ts'],
    ]);
  });

  it('composes only the selected paths of a candidate', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5'), 'src/extra.ts': 'extra by A\n' });
    const b = await writeTree(store, { ...BASE, 'src/extra.ts': 'extra by B\n' });
    // A's extra.ts would conflict with B's; selecting only app.ts from A composes cleanly.
    const got = await composeTrees(store, base, [
      { name: 'A', baseTree: base, headTree: a, paths: ['src/app.ts'] },
      { name: 'B', baseTree: base, headTree: b },
    ]);
    const aSelected = await writeTree(store, { ...BASE, 'src/app.ts': app('A5') });
    const expected = gitMerge(base, aSelected, b);
    expect(expected.clean).toBe(true);
    expect(got.clean).toBe(true);
    expect(got.treeHash).toBe(expected.clean ? expected.tree : null);
    expect(got.unmatched).toEqual([]);
  });

  it('reports selected paths that match no change of their candidate', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5') });
    const got = await composeTrees(store, base, [{ name: 'A', baseTree: base, headTree: a, paths: ['src/app.ts', 'nope.txt', 'docs/'] }]);
    expect(got.unmatched).toEqual([
      { piece: 'A', path: 'docs/' },
      { piece: 'A', path: 'nope.txt' },
    ]);
  });

  it('honours the merge budgets and reports truncation without a tree', async () => {
    const a = await writeTree(store, { ...BASE, 'src/app.ts': app('A5') });
    const b = await writeTree(store, { ...BASE, 'src/shared.ts': shared('S1', 's10') });
    const got = await composeTrees(
      store,
      base,
      [
        { name: 'A', baseTree: base, headTree: a },
        { name: 'B', baseTree: base, headTree: b },
      ],
      { maxTreeReads: 1 },
    );
    expect(got).toMatchObject({ clean: false, treeHash: null, truncated: true, truncatedReason: 'maxTreeReads' });
  });
});

describe('selectTree', () => {
  it('applies selected leaves (files and prefixes) of a head onto its base', async () => {
    const head = await writeTree(store, {
      ...BASE,
      'src/app.ts': app('H5'),
      'src/new/x.ts': 'x\n',
      'src/new/y.ts': 'y\n',
      'docs/b.md': 'head docs\n',
    });
    const got = await selectTree(store, base, head, ['src/new/', 'docs/b.md']);
    expect(got.truncated).toBe(false);
    const expected = await writeTree(store, { ...BASE, 'src/new/x.ts': 'x\n', 'src/new/y.ts': 'y\n', 'docs/b.md': 'head docs\n' });
    expect(got.treeHash).toBe(expected);
    expect(got.matched).toEqual(['docs/b.md', 'src/new/']);
  });

  it('applies a selected deletion and drops a directory left empty', async () => {
    const { 'docs/b.md': _gone, ...rest } = BASE;
    const head = await writeTree(store, rest);
    const got = await selectTree(store, base, head, ['docs/b.md']);
    expect(got.treeHash).toBe(await writeTree(store, rest));
  });
});
