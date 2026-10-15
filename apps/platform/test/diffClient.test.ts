/**
 * Headless probe of the diff client's geometry (issue #6): the virtualized
 * viewport must keep roughly 100 mounted rows on a 1M-line diff and never
 * move the row a given scroll position shows (no scroll jumps).
 *
 * The shipped module (public/assets/diffClient.js) is imported directly —
 * the DOM wiring is guarded on `document`, so the pure geometry runs here
 * in workerd. The 1M-row probe exercises the window and pool over the
 * benchmark fixture's changed-line count without materializing row objects;
 * rowsOf itself is covered on smaller hunks.
 */

import { describe, expect, it } from 'vitest';
import {
  INLINE_MAX_ROWS,
  OVERSCAN,
  POOL_SIZE,
  ROW_HEIGHT,
  VIEWPORT_ROWS,
  inlineOf,
  RowPool,
  rowsOf,
  windowOf,
} from '../public/assets/diffClient.js';

/** Deterministic PRNG so the probe's scroll sequence is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('row model', () => {
  it('renders normal-sized diffs inline, without the virtualized viewport', () => {
    // Wrapped inline rows need no scroll and no fixed-height geometry; only
    // diffs past INLINE_MAX_ROWS fall back to the virtualized canvas.
    expect(inlineOf(1)).toBe(true);
    expect(inlineOf(INLINE_MAX_ROWS)).toBe(true);
    expect(inlineOf(INLINE_MAX_ROWS + 1)).toBe(false);
    expect(inlineOf(1_000_002)).toBe(false);
  });

  it('flattens hunks into header and line rows with line numbers and width', () => {
    const model = rowsOf([
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          { type: 'eq', text: 'keep', oldNo: 1, newNo: 1 },
          { type: 'del', text: 'old', oldNo: 2 },
          { type: 'ins', text: 'new', newNo: 2 },
        ],
      },
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 9,
        newLines: 2,
        lines: [
          { type: 'ins', text: 'a', newNo: 9 },
          { type: 'ins', text: 'b', newNo: 10 },
        ],
      },
    ]);
    expect(model.total).toBe(7);
    expect(model.rows[0]).toMatchObject({ kind: 'hunk', op: 'hunk', text: '@@ -1,3 +1,3 @@' });
    expect(model.rows[1]).toMatchObject({ op: 'eq', oldNo: 1, newNo: 1 });
    expect(model.rows[2]).toMatchObject({ op: 'del', oldNo: 2, newNo: null });
    expect(model.rows[3]).toMatchObject({ op: 'ins', oldNo: null, newNo: 2 });
    expect(model.rows[4]).toMatchObject({ kind: 'hunk', text: '@@ -0,0 +9,2 @@' });
    expect(model.maxChars).toBeGreaterThanOrEqual('@@ -0,0 +9,2 @@'.length);
    // The widest line plus the gutter drives the width.
    expect(model.maxChars).toBe('keep'.length + 12);
  });

  it('counts a 120,000-line file (the benchmark fixture\'s largest) into rows', () => {
    const lines = Array.from({ length: 120_000 }, (_, i) => ({ type: 'ins' as const, text: `x${i}`, newNo: i + 1 }));
    const model = rowsOf([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }]);
    expect(model.total).toBe(120_001);
  });
});

describe('window geometry', () => {
  it('clamps to the file and keeps a bounded size', () => {
    expect(windowOf(10, 0, OVERSCAN)).toEqual({ start: 0, end: 10 });
    const tail = windowOf(10, 10 * ROW_HEIGHT + 5, OVERSCAN);
    expect(tail).toEqual({ start: 0, end: 10 });
    const w = windowOf(1000, 500 * ROW_HEIGHT, OVERSCAN);
    expect(w.start).toBe(Math.max(0, 500 - OVERSCAN));
    expect(w.end - w.start).toBeLessThanOrEqual(VIEWPORT_ROWS + 2 * OVERSCAN + 1);
  });

  it('the pool always covers a full window', () => {
    expect(POOL_SIZE).toBeGreaterThanOrEqual(VIEWPORT_ROWS + 2 * OVERSCAN + 1);
  });

  it('is monotonic while scrolling forward: the visible top never moves backwards', () => {
    const total = 1_000_002; // the 1M-line fixture pair's changed lines
    const random = mulberry32(7);
    let scrollTop = 0;
    let prevStart = windowOf(total, 0, OVERSCAN).start;
    for (let step = 0; step < 500; step++) {
      scrollTop = Math.min(total * ROW_HEIGHT - 1, Math.floor(scrollTop + random() * 4000));
      const { start, end } = windowOf(total, scrollTop, OVERSCAN);
      expect(start).toBeGreaterThanOrEqual(prevStart);
      expect(start).toBeLessThan(end);
      expect(end).toBeLessThanOrEqual(total);
      prevStart = start;
    }
  });
});

describe('recycled row pool', () => {
  it('keeps at most POOL_SIZE rows mounted across a 1M-line scroll and serves every visible index', () => {
    const total = 1_000_002;
    const pool = new RowPool(POOL_SIZE);
    const random = mulberry32(42);
    let scrollTop = 0;
    let mountedMax = 0;
    for (let step = 0; step < 1_000; step++) {
      scrollTop = Math.min(total * ROW_HEIGHT - 1, Math.floor(scrollTop + random() * 8000));
      const { start, end } = windowOf(total, scrollTop, OVERSCAN);
      pool.assign(start, end);
      mountedMax = Math.max(mountedMax, pool.size);
      // The row under the viewport top is the one the spacer says it is:
      // a deterministic scrollTop -> index map is exactly the no-jump guarantee.
      const topIndex = Math.floor(scrollTop / ROW_HEIGHT);
      expect(topIndex).toBeGreaterThanOrEqual(start);
      expect(topIndex).toBeLessThan(end);
      // Every wanted index has exactly one slot, and no slot serves two rows.
      const slots = [...pool.slotOf.values()];
      expect(new Set(slots).size).toBe(slots.length);
      expect(pool.slotOf.size).toBe(end - start);
    }
    expect(mountedMax).toBeLessThanOrEqual(POOL_SIZE);
    expect(mountedMax).toBeLessThanOrEqual(110);
    expect(mountedMax).toBeGreaterThan(VIEWPORT_ROWS);
  });

  it('keeps a scrolled-past row on its slot while it stays inside the window', () => {
    const pool = new RowPool(POOL_SIZE);
    pool.assign(100, 160);
    const before = pool.slotOf.get(120)!;
    const updates = pool.assign(100, 160);
    expect(updates.size).toBe(0); // nothing repainted, nothing moved
    expect(pool.slotOf.get(120)).toBe(before);
    // A window shift frees exactly the rows that left and paints only the new ones.
    const shifted = pool.assign(150, 210);
    expect(shifted.size).toBe(50);
    expect(pool.slotOf.get(140)).toBeUndefined();
    expect(pool.size).toBe(60);
  });
});
