import { describe, expect, it } from 'vitest';
import type { Hunk } from '../src';
import { detectMoves } from '../src/moves';

function hunk(lines: Hunk['lines']): Hunk {
  return {
    oldStart: lines.find((line) => line.type === 'del')?.oldNo ?? 0,
    oldLines: lines.filter((line) => line.type !== 'ins').length,
    newStart: lines.find((line) => line.type === 'ins')?.newNo ?? 0,
    newLines: lines.filter((line) => line.type !== 'del').length,
    lines,
  };
}

describe('detectMoves', () => {
  it('matches identical deletion and insertion runs at different positions in one file', () => {
    const result = detectMoves([{
      path: 'src/file.ts',
      hunks: [hunk([
        { type: 'del', text: '  const first = 1;', oldNo: 2 },
        { type: 'del', text: '  const second = 2;', oldNo: 3 },
        { type: 'del', text: '  return first + second;', oldNo: 4 },
        { type: 'ins', text: 'const first = 1;', newNo: 12 },
        { type: 'ins', text: 'const second = 2;', newNo: 13 },
        { type: 'ins', text: 'return first + second;', newNo: 14 },
      ])],
    }]);

    expect(result).toEqual([{
      from: { path: 'src/file.ts', start: 2, end: 4 },
      to: { path: 'src/file.ts', start: 12, end: 14 },
      lines: 3,
    }]);
  });

  it('matches runs across files and ignores blank or brace-only runs', () => {
    const result = detectMoves([
      {
        path: 'src/old.ts',
        hunks: [
          hunk([
            { type: 'del', text: '{', oldNo: 1 },
            { type: 'del', text: '}', oldNo: 2 },
          ]),
          hunk([
            { type: 'del', text: 'const a = 1;', oldNo: 8 },
            { type: 'del', text: 'const b = 2;', oldNo: 9 },
            { type: 'del', text: 'return a + b;', oldNo: 10 },
          ]),
        ],
      },
      {
        path: 'src/new.ts',
        hunks: [hunk([
          { type: 'ins', text: 'const a = 1;', newNo: 4 },
          { type: 'ins', text: 'const b = 2;', newNo: 5 },
          { type: 'ins', text: 'return a + b;', newNo: 6 },
        ])],
      },
    ]);

    expect(result).toEqual([{
      from: { path: 'src/old.ts', start: 8, end: 10 },
      to: { path: 'src/new.ts', start: 4, end: 6 },
      lines: 3,
    }]);
  });

  it('honors minimum run length and candidate limits', () => {
    const files = [{
      path: 'src/a.ts',
      hunks: [
        hunk([
          { type: 'del', text: 'a', oldNo: 1 },
          { type: 'del', text: 'b', oldNo: 2 },
          { type: 'ins', text: 'a', newNo: 5 },
          { type: 'ins', text: 'b', newNo: 6 },
        ]),
        hunk([
          { type: 'del', text: 'c', oldNo: 9 },
          { type: 'del', text: 'd', oldNo: 10 },
          { type: 'del', text: 'e', oldNo: 11 },
          { type: 'ins', text: 'c', newNo: 14 },
          { type: 'ins', text: 'd', newNo: 15 },
          { type: 'ins', text: 'e', newNo: 16 },
        ]),
      ],
    }];
    expect(detectMoves(files)).toHaveLength(1);
    expect(detectMoves(files, { minLines: 2, maxBlocks: 1 })).toHaveLength(1);
  });
});
