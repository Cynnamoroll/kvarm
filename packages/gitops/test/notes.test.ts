/**
 * Git notes commits on refs/notes/forge-attribution: what buildNotesCommit
 * writes is read back by real `git notes`, and notes git itself wrote (at the
 * root or below fanout directories) are found and replaced in place.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORGE_NOTES_REF,
  NotesTreeError,
  buildBlob,
  buildNotesCommit,
  buildTree,
  decode,
  encode,
  findNote,
  parseTree,
  writePack,
  type GitObject,
  type TreeEntry,
} from '../src/index';

let dir = '';

function git(args: string[], input?: Uint8Array | string): string {
  const r = spawnSync('git', args, {
    cwd: dir,
    input,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Trees straight from the real repository. */
const repoReader = {
  async readTree(hash: string): Promise<TreeEntry[] | null> {
    const r = spawnSync('git', ['cat-file', 'tree', hash], { cwd: dir });
    return r.status === 0 ? parseTree(new Uint8Array(r.stdout)) : null;
  },
};

async function writeObjects(objects: GitObject[]): Promise<void> {
  git(['unpack-objects', '-q'], Buffer.from(await writePack(objects)));
}

const ident = { name: 'Forge', email: 'forge@forge.invalid', time: 1_790_000_000 };
const commits: string[] = [];

function emptyCommit(msg: string): string {
  git(['commit', '-q', '--allow-empty', '-m', msg]);
  return git(['rev-parse', 'HEAD']).trim();
}

function notesTip(): { commit: string; tree: string } | null {
  const r = spawnSync('git', ['rev-parse', '--verify', '-q', FORGE_NOTES_REF], { cwd: dir });
  if (r.status !== 0) return null;
  const commit = r.stdout.toString().trim();
  return { commit, tree: git(['rev-parse', `${commit}^{tree}`]).trim() };
}

async function addNote(target: string, text: string) {
  const parent = notesTip();
  const r = await buildNotesCommit({ reader: repoReader, parent, target, content: encode(text), author: ident });
  await writeObjects(r.objects);
  git(['update-ref', FORGE_NOTES_REF, r.commit, ...(parent ? [parent.commit] : [])]);
  return r;
}

const show = (sha: string) => git(['notes', '--ref=forge-attribution', 'show', sha]);
const list = () =>
  git(['notes', '--ref=forge-attribution', 'list'])
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ')[1]!);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-notes-'));
  git(['init', '-q', '-b', 'main']);
  for (let i = 0; i < 4; i++) commits.push(emptyCommit(`c${i}`));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildNotesCommit', () => {
  it('creates the notes ref: git notes show returns the content', async () => {
    const r = await addNote(commits[0]!, '{"agent":"a1"}\n');
    expect(r.replaced).toBeNull();
    expect(show(commits[0]!)).toBe('{"agent":"a1"}\n');
    expect(git(['cat-file', '-p', r.commit])).toMatch(/^tree [0-9a-f]{40}\nauthor Forge <forge@forge.invalid> /);
    // A root notes commit has no parent; the tree is fanout-free (the path is the commit sha).
    expect(git(['rev-list', '--parents', '-n', '1', r.commit]).trim()).toBe(r.commit);
    expect(git(['ls-tree', '--name-only', r.tree]).trim()).toBe(commits[0]);
    git(['fsck', '--strict', '--no-dangling']);
  });

  it('adds a second note on top of the previous notes commit', async () => {
    const before = notesTip()!;
    const r = await addNote(commits[1]!, 'second\n');
    expect(git(['rev-parse', `${r.commit}^`]).trim()).toBe(before.commit);
    expect(show(commits[0]!)).toBe('{"agent":"a1"}\n');
    expect(show(commits[1]!)).toBe('second\n');
    expect(list().sort()).toEqual([commits[0], commits[1]].sort());
  });

  it('replaces an existing note without duplicating its entry', async () => {
    const r = await addNote(commits[0]!, 'replaced\n');
    expect(r.replaced?.path).toBe(commits[0]);
    expect(show(commits[0]!)).toBe('replaced\n');
    expect(list().filter((s) => s === commits[0])).toHaveLength(1);
    // Only the new blob, the root tree and the commit are written.
    expect(r.objects.map((o) => o.type).sort()).toEqual(['blob', 'commit', 'tree']);
  });

  it('finds and replaces a note git stored below a fanout directory', async () => {
    const target = commits[2]!;
    // A notes tree with git's 2/38 fanout for one note and a root entry for another.
    const old = await buildBlob(encode('old fanout note\n'));
    const keep = await buildBlob(encode('root note\n'));
    const sub = await buildTree([{ mode: '100644', name: target.slice(2), hash: old.hash }]);
    const root = await buildTree([
      { mode: '40000', name: target.slice(0, 2), hash: sub.hash },
      { mode: '100644', name: commits[3]!, hash: keep.hash },
    ]);
    await writeObjects([old, keep, sub, root]);
    const c = git(['commit-tree', root.hash, '-m', 'fanout notes']).trim();
    git(['update-ref', FORGE_NOTES_REF, c]);
    expect(show(target)).toBe('old fanout note\n');

    expect(await findNote(repoReader, root.hash, target)).toEqual({ blob: old.hash, path: `${target.slice(0, 2)}/${target.slice(2)}` });
    const r = await addNote(target, 'new fanout note\n');
    expect(r.replaced?.path).toBe(`${target.slice(0, 2)}/${target.slice(2)}`);
    expect(show(target)).toBe('new fanout note\n');
    expect(show(commits[3]!)).toBe('root note\n');
    expect(list().filter((s) => s === target)).toHaveLength(1);
    // The fanout directory was rebuilt in place, not shadowed by a root entry.
    expect(git(['ls-tree', '--name-only', r.tree]).trim().split('\n').sort()).toEqual([commits[3], target.slice(0, 2)].sort());
  });

  it('finds notes written by git notes add', async () => {
    git(['notes', '--ref=forge-attribution', 'add', '-f', '-m', 'from git', commits[1]!]);
    const tip = notesTip()!;
    const loc = await findNote(repoReader, tip.tree, commits[1]!);
    expect(loc).not.toBeNull();
    expect(decode(new Uint8Array(spawnSync('git', ['cat-file', 'blob', loc!.blob], { cwd: dir }).stdout))).toBe('from git\n');
    expect(await findNote(repoReader, tip.tree, 'f'.repeat(40))).toBeNull();
    expect(await findNote(repoReader, null, commits[1]!)).toBeNull();
  });

  it('refuses a target that is not a full sha and a notes tree it cannot read', async () => {
    await expect(buildNotesCommit({ reader: repoReader, parent: null, target: 'abc', content: encode('x'), author: ident })).rejects.toThrow(TypeError);
    await expect(findNote(repoReader, '0'.repeat(39) + '1', commits[0]!)).rejects.toThrow(NotesTreeError);
  });
});
