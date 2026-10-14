/**
 * Fuzz verification against real git.
 *
 * For hundreds of generated cases (small vocabularies, so lots of duplicate
 * lines — the hardest inputs), we assert:
 *  1. Our diff is minimal: additions/deletions match `git diff --no-index`
 *     counts exactly (both are Myers-minimal edit scripts).
 *  2. Our diff is valid: replaying the op sequence reconstructs both sides.
 *
 * Deterministic: seeded RNG, case index i always generates the same case.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffOps, diffToHunks, splitLines } from '../src/index';

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Small vocabulary on purpose: duplicate lines stress the matcher.
const VOCAB = ['alpha', 'beta', 'gamma', 'delta', 'x = 1', '}', '{', 'if (x) {'];

function makeCase(seed: number): string[] {
  const rng = mulberry32(seed);
  const len = Math.floor(rng() * 60);
  return Array.from({ length: len }, () => VOCAB[Math.floor(rng() * VOCAB.length)]!);
}

function mutate(lines: string[], seed: number): string[] {
  const rng = mulberry32(seed * 7919 + 13);
  const out = [...lines];
  const edits = Math.floor(rng() * 8);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rng() * (out.length + 1));
    const kind = rng();
    const run = 1 + Math.floor(rng() * 6);
    if (kind < 0.4) {
      out.splice(at, run);
    } else if (kind < 0.8) {
      const ins = Array.from({ length: run }, () => VOCAB[Math.floor(rng() * VOCAB.length)]!);
      out.splice(at, 0, ...ins);
    } else {
      out.splice(at, run, ...Array.from({ length: run }, () => `edited-${Math.floor(rng() * 10)}`));
    }
  }
  return out;
}

describe('fuzz against git', () => {
  it('diffs are minimal (match git counts) and replay-valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'diffcore-fuzz-'));
    try {
      const aPath = join(dir, 'a.txt');
      const bPath = join(dir, 'b.txt');
      for (let t = 0; t < 250; t++) {
        const a = makeCase(t);
        const b = mutate(a, t);
        const aText = a.length === 0 ? '' : a.join('\n') + '\n';
        const bText = b.length === 0 ? '' : b.join('\n') + '\n';
        writeFileSync(aPath, aText);
        writeFileSync(bPath, bText);

        const res = spawnSync(
          'git',
          ['diff', '--no-index', '--unified=0', '--no-color', 'a.txt', 'b.txt'],
          { cwd: dir, encoding: 'utf8' },
        );
        const out = res.stdout ?? '';
        const gitDels = out
          .split('\n')
          .filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
        const gitIns = out
          .split('\n')
          .filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;

        const { ops } = diffOps(aText, bText);
        const diff = diffToHunks(aText, bText, { context: 0 });

        if (diff.approximate) {
          // Only expected when git itself found a large edit distance.
          expect(gitDels + gitIns).toBeGreaterThanOrEqual(400);
          continue;
        }

        // Minimality: same edit counts as git's Myers.
        expect(
          [t, diff.totalDeletions, gitDels],
          `case ${t}: deletions differ`,
        ).toEqual([t, gitDels, gitDels]);
        expect([t, diff.totalAdditions, gitIns], `case ${t}: additions differ`).toEqual([
          t,
          gitIns,
          gitIns,
        ]);

        // Validity: replay reconstructs both sides exactly.
        const rebuiltA: string[] = [];
        const rebuiltB: string[] = [];
        let ai = 0;
        let bi = 0;
        for (const op of ops) {
          if (op === 'eq') {
            rebuiltA.push(a[ai]!);
            rebuiltB.push(b[bi]!);
            ai++;
            bi++;
          } else if (op === 'del') {
            rebuiltA.push(a[ai]!);
            ai++;
          } else {
            rebuiltB.push(b[bi]!);
            bi++;
          }
        }
        expect([t, rebuiltA], `case ${t}: old side replay broken`).toEqual([t, splitLines(aText)]);
        expect([t, rebuiltB], `case ${t}: new side replay broken`).toEqual([t, splitLines(bText)]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
