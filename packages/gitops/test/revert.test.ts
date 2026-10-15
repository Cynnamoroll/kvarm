/**
 * Revert parity with real git: scripted histories are built in a temp
 * repository and `git revert` (`-m 1`/`-m 2` for merges) is the expectation.
 * revertTree must produce the identical tree oid for a revert git commits,
 * and the same conflicted paths, with no tree, for one git stops on.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode, parseTree, type TreeEntry } from '../src/index';
import type { MergeReader } from '../src/merge3';
import type { CommitInfo, CommitReader } from '../src/mergebase';
import { revertMessage, revertTree } from '../src/revert';
import { closed } from './helpers';

let root = '';
let n = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-revert-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const lines = (count: number, tag = 'line') => Array.from({ length: count }, (_, i) => `${tag} ${i + 1}\n`).join('');

class Repo {
  readonly dir: string;

  constructor() {
    this.dir = join(root, `r${n++}`);
    mkdirSync(this.dir);
    this.git('init', '-q', '-b', 'main');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  /** Writes (string) or deletes (null) files, stages everything and commits. */
  commit(message: string, files: Record<string, string | null>): string {
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.dir, path);
      if (content === null) unlinkSync(full);
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    this.git('add', '-A');
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }

  rename(from: string, to: string, message: string): string {
    renameSync(join(this.dir, from), join(this.dir, to));
    return this.commit(message, {});
  }

  tree(rev: string): string {
    return this.git('rev-parse', `${rev}^{tree}`);
  }

  /** git revert of `sha` on HEAD: the tree it commits, or the conflicted paths it stops on (HEAD restored). */
  revert(sha: string, mainline?: number): { tree: string } | { conflicts: string[] } {
    const args = ['revert', '--no-edit', ...(mainline ? ['-m', String(mainline)] : []), sha];
    const r = spawnSync('git', args, { cwd: this.dir, encoding: 'utf8' });
    if (r.status === 0) {
      const tree = this.tree('HEAD');
      this.git('reset', '-q', '--hard', 'HEAD~1');
      return { tree };
    }
    const conflicts = this.git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean).sort();
    if (conflicts.length === 0) throw new Error(`git revert failed without conflicts: ${r.stderr}${r.stdout}`);
    this.git('revert', '--abort');
    return { conflicts };
  }

  /** Every object of the repository, as a commit, tree and blob reader. */
  reader(): CommitReader & MergeReader {
    const out = execFileSync('git', ['cat-file', '--batch-all-objects', '--batch', '--unordered'], { cwd: this.dir, maxBuffer: 64 * 1024 * 1024 });
    const objects = new Map<string, { type: string; content: Uint8Array }>();
    let off = 0;
    while (off < out.length) {
      const nl = out.indexOf(0x0a, off);
      const [oid, type, size] = out.subarray(off, nl).toString('latin1').split(' ');
      const start = nl + 1;
      const end = start + Number(size);
      objects.set(oid!, { type: type!, content: new Uint8Array(out.subarray(start, end)) });
      off = end + 1;
    }
    return {
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
  }
}

async function expectParity(repo: Repo, sha: string, mainline?: number, gitMainline = mainline) {
  const target = repo.git('rev-parse', 'HEAD');
  const reader = repo.reader();
  const got = await revertTree(reader, { commit: sha, target, ...(mainline ? { mainline } : {}) });
  const want = repo.revert(sha, gitMainline);
  if ('tree' in want) {
    expect(got.status).toBe('clean');
    expect(got.treeHash).toBe(want.tree);
    expect(await closed(reader, got.treeHash!, got.objects)).toBe(true);
  } else {
    expect(got.status).toBe('conflicts');
    expect(got.treeHash).toBeNull();
    expect(got.objects).toEqual([]);
    expect([...new Set(got.conflicts.flatMap((c) => c.paths))].sort()).toEqual(want.conflicts);
  }
  return got;
}

describe('revertTree parity with git revert', () => {
  it('reverts a normal commit under later unrelated work like git revert', async () => {
    const r = new Repo();
    r.commit('base', { 'f.txt': lines(12), 'g.txt': 'g\n', 'dir/r.txt': 'renamed\n' });
    const bad = r.commit('bad', { 'f.txt': lines(12).replace('line 2\n', 'line two\n'), 'g.txt': null, 'h.txt': 'new\n', 'dir/k.txt': 'k\n' });
    r.commit('later', { 'f.txt': lines(12).replace('line 2\n', 'line two\n').replace('line 11\n', 'line eleven\n'), 'i.txt': 'i\n' });
    const got = await expectParity(r, bad);
    expect(got).toMatchObject({ merge: false, parent: r.git('rev-parse', `${bad}^`) });
  });

  it('reverts an exact rename and a mode change', async () => {
    const r = new Repo();
    r.commit('base', { 'a/x.txt': 'x\n', 'run.sh': '#!/bin/sh\n' });
    const moved = r.rename('a/x.txt', 'b.txt', 'move');
    r.commit('later', { 'c.txt': 'c\n' });
    await expectParity(r, moved);
    chmodSync(join(r.dir, 'run.sh'), 0o755);
    r.commit('exec', {});
    const exec = r.git('rev-parse', 'HEAD');
    r.commit('after', { 'd.txt': 'd\n' });
    await expectParity(r, exec);
  });

  it('reverts a merge commit relative to its first parent like git revert -m 1, and -m 2', async () => {
    const r = new Repo();
    r.commit('base', { 'a.txt': lines(8, 'a'), 'b.txt': lines(8, 'b') });
    r.git('checkout', '-q', '-b', 'feature');
    r.commit('feature 1', { 'a.txt': lines(8, 'a').replace('a 3\n', 'a three\n'), 'feat/x.txt': 'x\n' });
    r.commit('feature 2', { 'feat/y.txt': 'y\n' });
    r.git('checkout', '-q', 'main');
    r.commit('main 1', { 'b.txt': lines(8, 'b').replace('b 7\n', 'b seven\n') });
    r.git('merge', '-q', '--no-ff', '--no-edit', 'feature');
    const merge = r.git('rev-parse', 'HEAD');
    r.commit('main 2', { 'b.txt': lines(8, 'b').replace('b 7\n', 'b seven\n').replace('b 1\n', 'b one\n'), 'c.txt': 'c\n' });
    const one = await expectParity(r, merge, undefined, 1);
    expect(one).toMatchObject({ merge: true, parent: r.git('rev-parse', `${merge}^1`) });
    const two = await expectParity(r, merge, 2);
    expect(two.parent).toBe(r.git('rev-parse', `${merge}^2`));
    expect(two.treeHash).not.toBe(one.treeHash);
  });

  it('reports the conflicted paths and no tree where git revert stops', async () => {
    const r = new Repo();
    r.commit('base', { 'f.txt': lines(6), 'keep.txt': 'k\n' });
    const bad = r.commit('bad', { 'f.txt': lines(6).replace('line 3\n', 'line three\n'), 'gone.txt': 'g\n' });
    r.commit('rework', { 'f.txt': lines(6).replace('line 3\n', 'line THREE\n'), 'gone.txt': 'g changed\n' });
    const got = await expectParity(r, bad);
    expect(got.conflicts.map((c) => [c.kind, c.path])).toEqual([
      ['content', 'f.txt'],
      ['modify-delete', 'gone.txt'],
    ]);
  });

  it('reverts a root commit to the empty tree and carries the empty tree object', async () => {
    const r = new Repo();
    const first = r.commit('root', { 'only.txt': 'o\n' });
    const got = await expectParity(r, first);
    expect(got.parent).toBeNull();
    expect(got.objects.map((o) => o.hash)).toEqual([got.treeHash]);
  });

  it('reverts a fast-forwarded range against the target it landed on, like the merge-tree of that range', async () => {
    const r = new Repo();
    const before = r.commit('base', { 'f.txt': lines(10), 'z.txt': 'z\n' });
    r.commit('ff 1', { 'f.txt': lines(10).replace('line 1\n', 'line one\n') });
    const head = r.commit('ff 2', { 'n.txt': 'n\n', 'z.txt': null });
    const tip = r.commit('later', { 'f.txt': lines(10).replace('line 1\n', 'line one\n').replace('line 9\n', 'line nine\n') });
    const reader = r.reader();
    const got = await revertTree(reader, { commit: head, target: tip, against: before });
    const want = r.git('merge-tree', '--write-tree', `--merge-base=${head}`, tip, before);
    expect(got.status).toBe('clean');
    expect(got.parent).toBe(before);
    expect(got.treeHash).toBe(want);
  });

  it('answers empty for a revert that changes nothing and missing for unknown inputs', async () => {
    const r = new Repo();
    r.commit('base', { 'f.txt': 'a\n' });
    const bad = r.commit('bad', { 'f.txt': 'b\n' });
    r.git('revert', '--no-edit', bad);
    const tip = r.git('rev-parse', 'HEAD');
    const reader = r.reader();
    expect(await revertTree(reader, { commit: bad, target: tip })).toMatchObject({ status: 'empty', treeHash: r.tree(tip), objects: [] });
    expect(await revertTree(reader, { commit: 'f'.repeat(40), target: tip })).toMatchObject({ status: 'missing', missing: 'commit', treeHash: null });
    expect(await revertTree(reader, { commit: bad, target: 'e'.repeat(40) })).toMatchObject({ status: 'missing', missing: 'target' });
    expect(await revertTree(reader, { commit: bad, target: tip, mainline: 2 })).toMatchObject({ status: 'missing', missing: 'mainline' });
    const parent = r.git('rev-parse', `${bad}^`);
    const noParent = { ...reader, readCommit: (sha: string) => (sha === parent ? Promise.resolve(null) : reader.readCommit(sha)) };
    expect(await revertTree(noParent, { commit: bad, target: tip })).toMatchObject({ status: 'missing', missing: 'parent', parent });
  });

  it('stops on a spent budget with no tree', async () => {
    const r = new Repo();
    r.commit('base', { 'f.txt': lines(6) });
    const bad = r.commit('bad', { 'f.txt': lines(6).replace('line 2\n', 'line two\n') });
    r.commit('later', { 'f.txt': lines(6).replace('line 2\n', 'line two\n').replace('line 5\n', 'line five\n') });
    const got = await revertTree(r.reader(), { commit: bad, target: r.git('rev-parse', 'HEAD') }, { maxBlobReads: 1 });
    expect(got).toMatchObject({ status: 'unknown', truncatedReason: 'maxBlobReads', treeHash: null, objects: [] });
  });
});

describe('revertMessage', () => {
  it("writes git's revert message with the reason as its own paragraph", () => {
    const sha = 'a'.repeat(40);
    expect(revertMessage({ subject: 'Add thing\n\nbody', commit: sha, parent: 'b'.repeat(40), merge: false })).toBe(`Revert "Add thing"\n\nThis reverts commit ${sha}.\n`);
    expect(revertMessage({ subject: 'Merge feature', commit: sha, parent: 'b'.repeat(40), merge: true, reason: 'p99 doubled' })).toBe(
      `Revert "Merge feature"\n\nThis reverts commit ${sha}, reversing\nchanges made to ${'b'.repeat(40)}.\n\np99 doubled\n`,
    );
    expect(revertMessage({ subject: 'Last of three', commit: sha, parent: 'b'.repeat(40), merge: false, range: true })).toBe(
      `Revert "Last of three"\n\nThis reverts commits ${'b'.repeat(40)}..${sha}.\n`,
    );
  });
});
