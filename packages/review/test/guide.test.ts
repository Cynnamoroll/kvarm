import { describe, expect, it } from 'vitest';
import type { Hunk } from '@kvarm/diffcore';
import type { RiskTag } from '../src/risk';
import {
  buildCoverage,
  carryGuide,
  fallbackGuide,
  isContractPath,
  matchReviewGlob,
  parseReviewConfig,
  validateGuide,
  type CoverageFileInput,
} from '../src/guide';

const tags = (...values: RiskTag[]) => values;
const hunk = (oldStart: number, newStart: number, lines: Hunk['lines'], over: Partial<Hunk> = {}): Hunk => ({
  oldStart,
  oldLines: lines.filter((line) => line.type !== 'ins').length,
  newStart,
  newLines: lines.filter((line) => line.type !== 'del').length,
  lines,
  ...over,
});
const line = (type: 'eq' | 'ins' | 'del', text: string) => ({ type, text });
const file = (path: string, over: Partial<CoverageFileInput> = {}): CoverageFileInput => ({
  path,
  status: 'modified',
  oldHash: 'a'.repeat(40),
  newHash: 'b'.repeat(40),
  additions: 1,
  deletions: 1,
  tags: [],
  hunks: [hunk(1, 1, [line('eq', 'before'), line('del', 'old'), line('ins', 'new'), line('eq', 'after')])],
  ...over,
});

describe('review config and contract globs', () => {
  it('parses valid config and enforces list and enum limits', () => {
    expect(parseReviewConfig(JSON.stringify({ contracts: ['src/**/*.proto'], scrutinize: ['src/auth/**'], receipts: ['dist/**'], postingThreshold: 'high' }))).toEqual({
      ok: true,
      value: { contracts: ['src/**/*.proto'], scrutinize: ['src/auth/**'], receipts: ['dist/**'], postingThreshold: 'high' },
    });
    expect(parseReviewConfig(JSON.stringify({ receipts: Array(101).fill('**') }))).toMatchObject({ ok: false });
    expect(parseReviewConfig('{"postingThreshold":"urgent"}')).toMatchObject({ ok: false });
    expect(parseReviewConfig('{"unknown":true}')).toMatchObject({ ok: false });
    expect(parseReviewConfig('{')).toMatchObject({ ok: false });
  });

  it('matches *, **, ?, and brace alternatives without crossing slash for *', () => {
    expect(matchReviewGlob('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matchReviewGlob('src/*.ts', 'src/deep/a.ts')).toBe(false);
    expect(matchReviewGlob('src/**/a?.{ts,tsx}', 'src/deep/a1.tsx')).toBe(true);
    expect(matchReviewGlob('src/**/a?.{ts,tsx}', 'src/deep/a10.ts')).toBe(false);
  });

  it('recognizes built-in contract paths and configured globs, except test declarations', () => {
    for (const path of ['apps/platform/migrations/0024.sql', 'proto/model.proto', 'api/openapi.yaml', 'schema.graphql', 'db/schema.prisma', 'packages/a/index.d.ts']) {
      expect(isContractPath(path), path).toBe(true);
    }
    expect(isContractPath('packages/a/test/fixture.d.ts')).toBe(false);
    expect(isContractPath('src/public-api.ts', ['src/public-*.ts'])).toBe(true);
  });
});

describe('coverage map', () => {
  it('keeps hunk keys stable across line shifts and trailing whitespace, but changes with content', async () => {
    const first = await buildCoverage([file('src/a.ts')], {});
    const shifted = await buildCoverage([file('src/a.ts', { hunks: [hunk(99, 101, [line('eq', 'before  '), line('del', 'old  '), line('ins', 'new '), line('eq', 'after')])] })], {});
    const edited = await buildCoverage([file('src/a.ts', { hunks: [hunk(1, 1, [line('eq', 'before'), line('del', 'old'), line('ins', 'different'), line('eq', 'after')])] })], {});
    expect(shifted.units[0]?.key).toBe(first.units[0]?.key);
    expect(edited.units[0]?.key).not.toBe(first.units[0]?.key);
  });

  it('suffixes identical hunk keys in source order', async () => {
    const input = file('src/a.ts', { hunks: [hunk(1, 1, [line('ins', 'same')]), hunk(8, 8, [line('ins', 'same')])] });
    const map = await buildCoverage([input], {});
    expect(map.units[1]?.key).toBe(`${map.units[0]?.key}-2`);
  });

  it('applies scrutinize floors for each danger tag, contracts and protected files', async () => {
    const danger: RiskTag[] = ['security-sensitive', 'ci-config', 'test-deletion', 'new-dependency'];
    const files = danger.map((tag, i) => file(`src/${i}.ts`, { tags: tags(tag) }));
    files.push(file('proto/a.proto'), file('src/protected.ts', { protected: true }));
    const map = await buildCoverage(files, {});
    expect(map.units.every((unit) => unit.floor === 'scrutinize' && unit.defaultTier === 'scrutinize')).toBe(true);
    expect(map.contracts).toEqual(['proto/a.proto']);
  });

  it('uses receipt floors and deterministic receipt summaries', async () => {
    const map = await buildCoverage([
      file('package-lock.json', { tags: tags('lockfile'), additions: 12, deletions: 3, hunks: null }),
      file('src/generated/a.ts', { tags: tags('generated'), additions: 400, deletions: 380, hunks: null }),
      file('src/format.ts', { tags: tags('mechanical'), additions: 5, deletions: 5, hunks: null }),
      file('src/old.ts', { status: 'deleted', additions: 0, deletions: 120, hunks: null }),
    ], {});
    expect(map.units.map(({ floor, receipt }) => [floor, receipt])).toEqual([
      ['receipt', 'lockfile · +12 −3'],
      ['receipt', 'generated · +400 −380'],
      ['receipt', 'mechanical (whitespace) · +5 −5'],
      ['receipt', 'deleted · 120 lines'],
    ]);
  });

  it('does not lower a danger floor for receipt config and reports budget truncation', async () => {
    const map = await buildCoverage([
      file('src/secret.ts', { tags: tags('security-sensitive', 'generated'), hunks: null }),
      file('src/budget.ts', { hunks: null, truncated: true }),
    ], { receipts: ['src/secret.ts'] });
    expect(map.units[0]?.floor).toBe('scrutinize');
    expect(map.truncated).toBe(true);
  });
});

describe('guide validation and carry-forward', () => {
  it('rejects every invalid input shape with a precise INVALID_GUIDE error', async () => {
    const map = await buildCoverage([file('src/a.ts')], {});
    const key = map.units[0]!.key;
    const valid = { intent: 'change', chapters: [{ id: 'c1', title: 'Core', tier: 'read', hunks: [key] }] };
    const invalid = [
      null,
      [],
      { ...valid, intent: 'x'.repeat(501) },
      { ...valid, steps: Array(21).fill('step') },
      { ...valid, beforeAfter: Array(13).fill({ lane: 'x', before: 'a', after: 'b' }) },
      { ...valid, chapters: [] },
      { ...valid, chapters: [{ ...valid.chapters[0], id: 'unguided' }] },
      { ...valid, chapters: [{ ...valid.chapters[0], id: 'bad_id' }] },
      { ...valid, chapters: [valid.chapters[0], { ...valid.chapters[0] }] },
      { ...valid, chapters: [{ ...valid.chapters[0], tier: 'low' }] },
      { ...valid, chapters: [{ ...valid.chapters[0], hunks: [] }] },
      { ...valid, chapters: [{ ...valid.chapters[0], dependsOn: ['missing'] }] },
      { ...valid, chapters: [{ ...valid.chapters[0], dependsOn: ['c1'] }] },
      { ...valid, chapters: [{ ...valid.chapters[0], hunks: ['unknown'] }] },
      { ...valid, chapters: [valid.chapters[0], { ...valid.chapters[0], id: 'c2' }] },
      { ...valid, chapters: [{ ...valid.chapters[0], notes: [{ hunk: 'unknown', kind: 'note', body: 'note' }] }] },
      { ...valid, contracts: [{ surface: 'src/a.ts', impact: 'other' }] },
      { ...valid, unchanged: Array(21).fill('x') },
      { ...valid, evidence: [{ kind: 'unknown', ref: 'x' }] },
    ];
    for (const input of invalid) expect(validateGuide(input, map)).toMatchObject({ ok: false, code: 'INVALID_GUIDE' });
    expect(validateGuide({ ...valid, intent: 'x'.repeat(65_537) }, map)).toMatchObject({ ok: false, code: 'GUIDE_TOO_LARGE' });
  });

  it('rejects unknown keys, duplicates and unknown unit keys while naming at most ten', async () => {
    const many = await buildCoverage(Array.from({ length: 12 }, (_, i) => file(`src/${i}.ts`)), {});
    expect(validateGuide({ intent: '', extra: true, chapters: [{ id: 'c1', title: 'x', tier: 'read', hunks: [many.units[0]!.key] }] }, many)).toMatchObject({ ok: false, code: 'INVALID_GUIDE' });
    expect(validateGuide({ intent: '', chapters: [{ id: 'c1', title: 'x', tier: 'read', hunks: ['nope'] }] }, many)).toMatchObject({
      ok: false,
      code: 'INVALID_GUIDE',
      error: expect.stringContaining('nope'),
    });
    const duplicate = many.units[0]!.key;
    expect(validateGuide({ intent: '', chapters: [
      { id: 'c1', title: 'x', tier: 'read', hunks: [duplicate] },
      { id: 'c2', title: 'y', tier: 'read', hunks: [duplicate] },
    ] }, many)).toMatchObject({ ok: false, code: 'INVALID_GUIDE' });
  });

  it('adds gaps to unguided, raises below-floor chapters and reports undeclared contracts', async () => {
    const map = await buildCoverage([file('apps/platform/migrations/0024.sql'), file('src/security.ts', { tags: tags('security-sensitive') })], {});
    const [contract, danger] = map.units;
    const result = validateGuide({
      intent: 'schema',
      chapters: [{ id: 'schema', title: 'Schema', tier: 'receipt', hunks: [contract!.key] }],
      contracts: [{ surface: 'apps/platform/migrations/0024.sql', impact: 'additive' }],
    }, map);
    expect(result).toMatchObject({ ok: true, gaps: [danger!.key], undeclared: [] });
    if (result.ok) {
      expect(result.guide.chapters.at(-1)).toMatchObject({ id: 'unguided', tier: 'read', hunks: [danger!.key] });
      expect(result.raised).toContainEqual({ key: contract!.key, from: 'receipt', to: 'scrutinize' });
      expect(result.raised).toContainEqual({ key: danger!.key, from: 'read', to: 'scrutinize' });
    }
  });

  it('orders deterministic fallback chapters and carries matching keys only', async () => {
    const map = await buildCoverage([
      file('src/read.ts'),
      file('apps/platform/migrations/0024.sql'),
      file('test/a.test.ts'),
      file('package-lock.json', { tags: tags('lockfile'), hunks: null }),
    ], {});
    const one = fallbackGuide(map);
    expect(fallbackGuide(map)).toEqual(one);
    expect(one.source).toBe('fallback');
    expect(one.chapters.at(-1)?.id).toBe('receipts');
    expect(one.chapters.some((chapter) => chapter.id === 'tests')).toBe(true);
    const next = await buildCoverage([file('src/read.ts'), file('src/new.ts')], {});
    const carried = carryGuide(one, next);
    const retained = one.chapters.flatMap((chapter) => chapter.hunks).filter((key) => next.units.some((unit) => unit.key === key));
    expect(carried.chapters.flatMap((chapter) => chapter.hunks)).toEqual(expect.arrayContaining(retained));
    expect(carried.chapters.at(-1)?.id).toBe('unguided');
  });
});
