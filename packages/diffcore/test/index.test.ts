import { describe, expect, it } from 'vitest';
import { diffOps, diffToHunks } from '../src/index';

describe('diffOps', () => {
  it('diffs simple edits', () => {
    const { ops } = diffOps('a\nb\nc\n', 'a\nx\nc\n');
    expect(ops).toEqual(['eq', 'del', 'ins', 'eq']);
  });

  it('handles pure insertion and deletion', () => {
    expect(diffOps('', 'new line\n').ops.every((o) => o === 'ins')).toBe(true);
    expect(diffOps('gone\n', '').ops.every((o) => o === 'del')).toBe(true);
  });

  it('is stable on large identical files', () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `line ${i}`).join('\n');
    const { ops, approximate } = diffOps(text + '\n', text + '\n');
    expect(approximate).toBe(false);
    expect(ops).toHaveLength(100_000);
    expect(ops.every((o) => o === 'eq')).toBe(true);
  });

  it('falls back over the node budget without hanging', () => {
    // Two very different 30k-line files: way over any reasonable budget.
    const a = Array.from({ length: 30_000 }, (_, i) => `a${i}`).join('\n');
    const b = Array.from({ length: 30_000 }, (_, i) => `b${i}`).join('\n');
    const t0 = Date.now();
    const { ops, approximate } = diffOps(a, b, { nodeBudget: 50_000 });
    expect(approximate).toBe(true);
    expect(ops.filter((o) => o === 'del')).toHaveLength(30_000);
    expect(ops.filter((o) => o === 'ins')).toHaveLength(30_000);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe('diffToHunks', () => {
  it('produces git-style hunks with context', () => {
    const oldText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const newText = oldText.replace('line 10', 'line 10 CHANGED');
    const diff = diffToHunks(oldText + '\n', newText + '\n', { context: 3 });
    expect(diff.hunks).toHaveLength(1);
    const h = diff.hunks[0]!;
    // 3 eq before + del + ins + 3 eq after = 8 display rows; 7 rows per side.
    expect(h.lines).toHaveLength(8);
    expect(h.lines[3]).toMatchObject({ type: 'del', text: 'line 10', oldNo: 11 });
    expect(h.lines[4]).toMatchObject({ type: 'ins', text: 'line 10 CHANGED', newNo: 11 });
    // git reports @@ -8,7 +8,7 @@
    expect(h.oldStart).toBe(8);
    expect(h.oldLines).toBe(7);
    expect(h.newStart).toBe(8);
    expect(h.newLines).toBe(7);
    expect(diff.totalAdditions).toBe(1);
    expect(diff.totalDeletions).toBe(1);
  });

  it('splits distant changes into separate hunks', () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const newText = oldText
      .replace('line 3\n', 'line 3 EDITED\n')
      .replace('line 25\n', 'line 25 EDITED\n');
    const diff = diffToHunks(oldText + '\n', newText + '\n');
    expect(diff.hunks.length).toBeGreaterThanOrEqual(2);
  });

  it('numbers sides correctly for interleaved changes', () => {
    const diff = diffToHunks('1\n2\n3\n4\n5\n', 'one\n2\n3\nfour\n5\n');
    expect(diff.totalAdditions).toBe(2);
    expect(diff.totalDeletions).toBe(2);
    for (const h of diff.hunks) {
      const olds = h.lines.filter((l) => l.oldNo !== undefined).map((l) => l.oldNo);
      const news = h.lines.filter((l) => l.newNo !== undefined).map((l) => l.newNo);
      expect([...olds].sort((x, y) => x! - y!)).toEqual(olds);
      expect([...news].sort((x, y) => x! - y!)).toEqual(news);
    }
  });
});
