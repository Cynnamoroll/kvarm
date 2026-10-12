/**
 * Per-file diff helpers used by the compare API, checked against real git:
 * binary detection, end-of-file newline awareness (git counts a missing
 * final newline as a changed line), git -U3 hunk headers, and output bounds.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffToHunks, isBinaryContent, limitHunks } from '../src/index';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'diffcore-file-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function gitDiff(oldText: string | Uint8Array, newText: string | Uint8Array, extra: string[] = []): string {
  writeFileSync(join(dir, 'a'), oldText);
  writeFileSync(join(dir, 'b'), newText);
  const res = spawnSync('git', ['diff', '--no-index', '--no-color', ...extra, 'a', 'b'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return res.stdout ?? '';
}

function gitNumstat(oldText: string, newText: string): [number, number] {
  const line = gitDiff(oldText, newText, ['--numstat']).trim();
  if (line === '') return [0, 0];
  const [add, del] = line.split('\t');
  return [Number(add), Number(del)];
}

function gitHunkHeaders(oldText: string, newText: string): number[][] {
  return gitDiff(oldText, newText, ['-U3', '--no-indent-heuristic'])
    .split('\n')
    .filter((l) => l.startsWith('@@'))
    .map((l) => {
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)!;
      return [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    });
}

describe('isBinaryContent', () => {
  it('matches git: a NUL byte within the first 8000 bytes means binary', () => {
    const text = new TextEncoder().encode('hello\nworld\n');
    const withNul = new Uint8Array([0x68, 0x00, 0x69, 0x0a]);
    const lateNul = new Uint8Array(9000).fill(0x61);
    lateNul[8500] = 0;
    expect(isBinaryContent(text)).toBe(false);
    expect(isBinaryContent(withNul)).toBe(true);
    expect(isBinaryContent(lateNul)).toBe(false);
    expect(isBinaryContent(new Uint8Array(0))).toBe(false);
    // git agrees: numstat prints "-\t-" for the NUL file only.
    expect(gitDiff(text, withNul, ['--numstat']).startsWith('-\t-')).toBe(true);
    expect(gitDiff(new Uint8Array(9000).fill(0x61), lateNul, ['--numstat']).startsWith('-\t-')).toBe(false);
  });
});

describe('eolAware diffs', () => {
  const cases: Array<[string, string, string]> = [
    ['adds a final newline', 'a\nb', 'a\nb\n'],
    ['removes a final newline', 'a\nb\n', 'a\nb'],
    ['edits the last line without newline', 'a\nb', 'a\nc'],
    ['appends after a line without newline', 'a\nb', 'a\nb\nc'],
    ['new file without newline', '', 'x\ny'],
    ['deleted file without newline', 'x\ny', ''],
    ['identical without newline', 'same\nlast', 'same\nlast'],
  ];
  for (const [name, oldText, newText] of cases) {
    it(`${name}: counts match git numstat`, () => {
      const d = diffToHunks(oldText, newText, { eolAware: true });
      expect([d.totalAdditions, d.totalDeletions]).toEqual(gitNumstat(oldText, newText));
      expect(d.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual(
        gitHunkHeaders(oldText, newText),
      );
    });
  }

  it('flags the line that lacks a newline and keeps its text clean', () => {
    const d = diffToHunks('a\nb', 'a\nb\n', { eolAware: true });
    const del = d.hunks[0]!.lines.find((l) => l.type === 'del')!;
    const ins = d.hunks[0]!.lines.find((l) => l.type === 'ins')!;
    expect(del).toMatchObject({ text: 'b', oldNo: 2, noEol: true });
    expect(ins.text).toBe('b');
    expect(ins.noEol).toBeUndefined();
  });

  it('keeps the default (eol-blind) behaviour unchanged', () => {
    const d = diffToHunks('a\nb', 'a\nb\n');
    expect(d.hunks).toHaveLength(0);
  });

  it('matches git -U3 headers on a 40-line file with one edited line', () => {
    const oldText = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const newText = oldText.replace('line 17\n', 'line 17 edited\n');
    const d = diffToHunks(oldText, newText, { eolAware: true });
    expect(d.hunks.map((h) => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual(
      gitHunkHeaders(oldText, newText),
    );
  });
});

describe('limitHunks', () => {
  const oldText = Array.from({ length: 5000 }, (_, i) => `old ${i}`).join('\n') + '\n';
  const newText = Array.from({ length: 5000 }, (_, i) => `new ${i}`).join('\n') + '\n';

  it('returns everything untouched when within bounds', () => {
    const d = diffToHunks('a\nb\n', 'a\nc\n');
    const out = limitHunks(d.hunks, { maxLines: 100, maxBytes: 10_000 });
    expect(out.truncated).toBe(false);
    expect(out.hunks).toEqual(d.hunks);
  });

  it('cuts at the line bound and keeps hunk headers consistent with the lines kept', () => {
    const d = diffToHunks(oldText, newText);
    const out = limitHunks(d.hunks, { maxLines: 1000, maxBytes: 10_000_000 });
    expect(out.truncated).toBe(true);
    const lines = out.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(lines).toBe(1000);
    for (const h of out.hunks) {
      expect(h.lines.filter((l) => l.type !== 'ins')).toHaveLength(h.oldLines);
      expect(h.lines.filter((l) => l.type !== 'del')).toHaveLength(h.newLines);
    }
  });

  it('cuts at the byte bound', () => {
    const d = diffToHunks(oldText, newText);
    const out = limitHunks(d.hunks, { maxLines: 1_000_000, maxBytes: 20_000 });
    expect(out.truncated).toBe(true);
    const bytes = out.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length, 0), 0);
    expect(bytes).toBeLessThanOrEqual(20_000);
  });
});
