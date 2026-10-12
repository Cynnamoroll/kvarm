/**
 * Supported-size files with very many lines (the compare API reads sides up
 * to 4 MiB, so a file can hold hundreds of thousands of short lines). The
 * engine must count and render them without exceeding argument or stack
 * limits, and bound what it materializes for output.
 */

import { describe, expect, it } from 'vitest';
import { diffOps, diffStat, diffToHunks, limitHunks } from '../src/index';

const N = 200_000;
/** 400,000 bytes: far below the 4 MiB per-side cap. */
const BIG = 'x\n'.repeat(N);
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');

describe('200,000-line files', () => {
  it('diffs an added file', () => {
    expect(BIG.length).toBeLessThan(4 * 1024 * 1024);
    const { ops, approximate } = diffOps('', BIG, { eolAware: true });
    expect(approximate).toBe(false);
    expect(ops).toHaveLength(N);
    expect(ops.every((o) => o === 'ins')).toBe(true);
    expect(diffStat('', BIG, { eolAware: true })).toEqual({ additions: N, deletions: 0, approximate: false });
    const d = diffToHunks('', BIG, { eolAware: true });
    expect([d.totalAdditions, d.totalDeletions]).toEqual([N, 0]);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: N });
  });

  it('diffs a removed file', () => {
    const { ops } = diffOps(BIG, '', { eolAware: true });
    expect(ops).toHaveLength(N);
    expect(ops.every((o) => o === 'del')).toBe(true);
    expect(diffStat(BIG, '')).toEqual({ additions: 0, deletions: N, approximate: false });
    const d = diffToHunks(BIG, '', { eolAware: true });
    expect([d.totalAdditions, d.totalDeletions]).toEqual([0, N]);
    expect(d.hunks[0]).toMatchObject({ oldStart: 1, oldLines: N, newStart: 0, newLines: 0 });
  });

  it('diffs a 200,000-line insertion between a common prefix and suffix', () => {
    const head = lines(1000, 'head');
    const tail = lines(1000, 'tail');
    const oldText = head + tail;
    const newText = head + lines(N, 'mid') + tail;
    const { ops } = diffOps(oldText, newText);
    expect(ops).toHaveLength(N + 2000);
    expect(ops.filter((o) => o === 'ins')).toHaveLength(N);
    const d = diffToHunks(oldText, newText);
    expect([d.totalAdditions, d.totalDeletions]).toEqual([N, 0]);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]).toMatchObject({ oldStart: 998, oldLines: 6, newStart: 998, newLines: N + 6 });
  });

  it('falls back over budget with a 200,000-line common prefix and suffix', () => {
    const shared = lines(N, 'same');
    const oldText = shared + lines(3000, 'a') + shared;
    const newText = shared + lines(3000, 'b') + shared;
    const { ops, approximate } = diffOps(oldText, newText, { nodeBudget: 1000 });
    expect(approximate).toBe(true);
    expect(ops).toHaveLength(2 * N + 6000);
    expect(diffStat(oldText, newText, { nodeBudget: 1000 })).toEqual({ additions: 3000, deletions: 3000, approximate: true });
    const d = diffToHunks(oldText, newText, { nodeBudget: 1000 });
    expect(d.approximate).toBe(true);
    expect([d.totalAdditions, d.totalDeletions]).toEqual([3000, 3000]);
  });

  it('bounds the materialized hunk lines while totals cover the whole file', () => {
    const d = diffToHunks('', BIG, { eolAware: true, maxLines: 10_000, maxBytes: 1_000_000 });
    expect([d.totalAdditions, d.totalDeletions]).toEqual([N, 0]);
    expect(d.truncated).toBe(true);
    expect(d.hunks).toHaveLength(1);
    expect(d.hunks[0]!.lines).toHaveLength(10_000);
    expect(d.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 10_000 });

    const bytes = diffToHunks(lines(N, 'old'), lines(N, 'new'), { maxLines: 1_000_000, maxBytes: 20_000 });
    expect(bytes.truncated).toBe(true);
    expect(bytes.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length, 0), 0)).toBeLessThanOrEqual(20_000);
    expect([bytes.totalAdditions, bytes.totalDeletions]).toEqual([N, N]);
  });
});

describe('bounded diffToHunks matches limitHunks over the full output', () => {
  // Deterministic pseudo-random edits, so failures reproduce.
  let seed = 7;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const mutate = (src: string[]) => {
    const out: string[] = [];
    for (const l of src) {
      const r = rand(10);
      if (r === 0) continue;
      if (r === 1) out.push(`edit ${rand(1000)}`);
      else out.push(l);
      if (r === 2) out.push(`ins ${rand(1000)}`);
    }
    return out;
  };

  it('produces identical hunks, totals and truncation for random inputs and bounds', () => {
    for (let round = 0; round < 60; round++) {
      const a = Array.from({ length: 50 + rand(400) }, (_, i) => `l${i % 37}`);
      const b = mutate(a);
      const oldText = `${a.join('\n')}${rand(2) ? '\n' : ''}`;
      const newText = `${b.join('\n')}${rand(2) ? '\n' : ''}`;
      const limits = { maxLines: 1 + rand(200), maxBytes: 1 + rand(2000) };
      const context = rand(5);
      const full = diffToHunks(oldText, newText, { eolAware: true, context });
      const want = limitHunks(full.hunks, limits);
      const got = diffToHunks(oldText, newText, { eolAware: true, context, ...limits });
      expect(got.hunks).toEqual(want.hunks);
      expect(got.truncated === true).toBe(want.truncated);
      expect([got.totalAdditions, got.totalDeletions, got.approximate]).toEqual([full.totalAdditions, full.totalDeletions, full.approximate]);
      expect(diffStat(oldText, newText, { eolAware: true })).toEqual({
        additions: full.totalAdditions,
        deletions: full.totalDeletions,
        approximate: full.approximate,
      });
    }
  });
});
