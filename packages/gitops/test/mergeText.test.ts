/**
 * Line-level three-way merge (diff3 with git's xdiff merge rules). Clean
 * results and conflict counts are compared with `git merge-file`, which runs
 * the same xdiff merge; conflict hunks use git's marker layout.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isBinaryContent3, mergeText } from '../src/merge3';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-merge-text-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `git merge-file -p` over the three texts: merged output and conflict count. */
function gitMergeFile(base: string, ours: string, theirs: string): { merged: string; conflicts: number } {
  writeFileSync(join(root, 'base'), base);
  writeFileSync(join(root, 'ours'), ours);
  writeFileSync(join(root, 'theirs'), theirs);
  const r = spawnSync('git', ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', 'ours', 'base', 'theirs'], {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (r.status === null || r.status < 0) throw new Error(`git merge-file failed: ${r.stderr.toString()}`);
  return { merged: r.stdout.toString(), conflicts: r.status };
}

function merge(base: string, ours: string, theirs: string, simplifyNonAlnum = false) {
  const r = mergeText(enc(base), enc(ours), enc(theirs), { labels: { ours: 'ours', theirs: 'theirs' }, simplifyNonAlnum });
  if (!r) throw new Error('over budget');
  return { clean: r.clean, conflicts: r.conflicts, merged: dec(r.merged) };
}

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join('');

describe('mergeText', () => {
  const base = lines('a', 'b', 'c', 'd', 'e', 'f', 'g');

  it('merges edits separated by an unchanged line', () => {
    const r = merge(base, lines('A', 'b', 'c', 'd', 'e', 'f', 'g'), lines('a', 'b', 'C', 'd', 'e', 'f', 'g'));
    expect(r).toEqual({ clean: true, conflicts: 0, merged: lines('A', 'b', 'C', 'd', 'e', 'f', 'g') });
  });

  it('treats touching edits as a conflict, like git', () => {
    const r = merge(base, lines('a', 'B', 'c', 'd', 'e', 'f', 'g'), lines('a', 'b', 'C', 'd', 'e', 'f', 'g'));
    expect(r.clean).toBe(false);
    expect(r.conflicts).toBe(1);
    expect(r.merged).toBe(lines('a', '<<<<<<< ours', 'B', 'c', '=======', 'b', 'C', '>>>>>>> theirs', 'd', 'e', 'f', 'g'));
  });

  it('accepts the identical change made on both sides', () => {
    const ours = lines('a', 'b', 'X', 'Y', 'e', 'f', 'g');
    expect(merge(base, ours, ours)).toEqual({ clean: true, conflicts: 0, merged: ours });
  });

  it('takes the changed side when the other is unchanged', () => {
    const theirs = lines('a', 'e', 'f', 'g', 'h');
    expect(merge(base, base, theirs).merged).toBe(theirs);
    expect(merge(base, theirs, base).merged).toBe(theirs);
  });

  it('keeps a missing final newline as part of the last line', () => {
    const b = 'one\ntwo\nthree';
    expect(merge(b, 'ONE\ntwo\nthree', 'one\ntwo\nthree\n')).toEqual({ clean: true, conflicts: 0, merged: 'ONE\ntwo\nthree\n' });
    const both = merge(b, 'one\ntwo\nthree\nfour', 'one\ntwo\nthree\nfive\n');
    expect(both.clean).toBe(false);
    expect(both.merged).toBe(gitMergeFile(b, 'one\ntwo\nthree\nfour', 'one\ntwo\nthree\nfive\n').merged);
  });

  it('splits a conflict around lines both sides agree on (zealous refinement)', () => {
    const r = merge(base, lines('a', 'X', 'same', 'Y', 'e', 'f', 'g'), lines('a', 'P', 'same', 'Q', 'e', 'f', 'g'));
    expect(r.conflicts).toBe(1);
    const sep = lines('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j');
    const far = merge(sep, lines('a', 'X', 'c', 'd', 'e', 'f', 'g', 'h', 'Y', 'j'), lines('a', 'P', 'c', 'd', 'e', 'f', 'g', 'h', 'Q', 'j'));
    expect(far.conflicts).toBe(2);
  });

  it('reports over-budget diffs as null rather than guessing', () => {
    const big = Array.from({ length: 400 }, (_, i) => `l${i}`);
    const shuffled = [...big].reverse();
    expect(mergeText(enc(lines(...big)), enc(lines(...shuffled)), enc(lines(...big, 'tail')), { nodeBudget: 10 })).toBeNull();
  });

  it('detects binary content by a NUL in the first 8000 bytes, like git', () => {
    expect(isBinaryContent3(enc('text'), enc('more'), enc('\0'))).toBe(true);
    expect(isBinaryContent3(enc('x'.repeat(8000) + '\0'), enc('a'), enc('b'))).toBe(false);
    expect(isBinaryContent3(enc('a'), enc('b'), enc('c'))).toBe(false);
  });
});

/** Deterministic PRNG (mulberry32) so failures replay. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(src: string[], rand: () => number, tag: string): string[] {
  const out = [...src];
  const edits = 1 + Math.floor(rand() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1));
    const op = rand();
    if (op < 0.4 && out.length > 0) out[Math.min(at, out.length - 1)] = `${tag}${e} changed`;
    else if (op < 0.7) out.splice(at, 0, `${tag}${e} inserted`);
    else out.splice(at, Math.min(1 + Math.floor(rand() * 3), out.length - at));
  }
  return out;
}

describe('mergeText parity with git merge-file (seeded fuzz)', () => {
  it('matches clean output and conflict counts on 300 random three-way edits', () => {
    const rand = rng(20261008);
    let clean = 0;
    let conflicted = 0;
    for (let i = 0; i < 300; i++) {
      const n = 4 + Math.floor(rand() * 16);
      const vocab = ['{', '}', '', 'return x;'];
      const b = Array.from({ length: n }, (_, k) => (rand() < 0.2 ? vocab[Math.floor(rand() * vocab.length)]! : `line ${k}`));
      const o = mutate(b, rand, 'o');
      const t = mutate(b, rand, 't');
      const [bs, os, ts] = [b, o, t].map((x) => lines(...x)) as [string, string, string];
      const ours = merge(bs, os, ts, true);
      const git = gitMergeFile(bs, os, ts);
      const ctx = { case: i, base: bs, ours: os, theirs: ts };
      expect({ ...ctx, conflicts: ours.conflicts }).toEqual({ ...ctx, conflicts: git.conflicts });
      expect({ ...ctx, merged: ours.merged }).toEqual({ ...ctx, merged: git.merged });
      if (git.conflicts === 0) clean++;
      else conflicted++;
    }
    expect(clean).toBeGreaterThan(30);
    expect(conflicted).toBeGreaterThan(30);
  });
});
