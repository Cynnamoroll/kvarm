/**
 * Deterministic conflict resolution (resolve.ts) on top of merge3. The cases
 * git already merges (non-overlapping hunks, the identical change on both
 * sides, an identical add on both sides) must keep git's exact tree and be
 * reported as resolutions; a whitespace-only conflict, which git refuses, is
 * resolved to the target's variant; lockfile conflicts and real content
 * conflicts stay unresolved. Trees come from the conflict-corpus builder, so
 * git's `merge-tree --write-tree` result is the expectation where git has one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCorpus, loadObjects, type CorpusCase, type CorpusResult } from '../../../scripts/conflict-corpus/corpus.mjs';
import { parseTree, type GitObject, type TreeEntry } from '../src/index';
import { merge3, mergeText, type MergeReader } from '../src/merge3';
import { classifyConflicts, deterministicResolver, whitespaceEquivalent } from '../src/resolve';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const linesWith = (edits: Record<number, string>) => LINES.map((l, i) => (edits[i + 1] ?? l) + '\n').join('');
const BASE = { 'lines.txt': linesWith({}), 'README.md': 'readme\n' };

const isLockfile = (p: string) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p);
const resolver = deterministicResolver({ isLockfile });

const CASES: CorpusCase[] = [
  { name: 'non-overlapping', base: BASE, ours: { 'lines.txt': linesWith({ 2: 'line 2 main' }) }, theirs: { 'lines.txt': linesWith({ 18: 'line 18 feature' }) } },
  // Each side also adds its own file so the trees differ and the merge does not short-circuit.
  {
    name: 'identical',
    base: BASE,
    ours: { 'lines.txt': linesWith({ 5: 'line 5 shared' }), 'ours.txt': 'o\n' },
    theirs: { 'lines.txt': linesWith({ 5: 'line 5 shared' }), 'theirs.txt': 't\n' },
  },
  { name: 'identical-trees', base: BASE, ours: { 'lines.txt': linesWith({ 5: 'line 5 shared' }) }, theirs: { 'lines.txt': linesWith({ 5: 'line 5 shared' }) } },
  {
    name: 'identical-hunk-plus-own-edits',
    base: BASE,
    ours: { 'lines.txt': linesWith({ 1: 'line 1 main', 5: 'line 5 shared' }) },
    theirs: { 'lines.txt': linesWith({ 5: 'line 5 shared', 20: 'line 20 feature' }) },
  },
  {
    name: 'whitespace',
    base: BASE,
    ours: { 'lines.txt': linesWith({ 7: '    line 7 indented' }) },
    theirs: { 'lines.txt': linesWith({ 7: '\tline 7 indented' }) },
  },
  {
    name: 'add-add',
    base: BASE,
    ours: { 'both.txt': 'same content\nline two\n', 'ours.txt': 'o\n' },
    theirs: { 'both.txt': 'same content\nline two\n', 'theirs.txt': 't\n' },
  },
  { name: 'unresolvable', base: BASE, ours: { 'lines.txt': linesWith({ 9: 'line 9 main' }) }, theirs: { 'lines.txt': linesWith({ 9: 'line 9 feature' }) } },
  {
    name: 'whitespace-and-real',
    base: BASE,
    ours: { 'lines.txt': linesWith({ 3: '  line 3', 15: 'line 15 main' }) },
    theirs: { 'lines.txt': linesWith({ 3: '\tline 3', 15: 'line 15 feature' }) },
  },
  {
    name: 'lockfile-whitespace',
    base: { ...BASE, 'package-lock.json': '{\n  "a": 1\n}\n' },
    ours: { 'package-lock.json': '{\n    "a": 2\n}\n' },
    theirs: { 'package-lock.json': '{\n\t"a": 2\n}\n' },
  },
];

let root = '';
let results = new Map<string, CorpusResult>();
let reader: MergeReader;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gitops-resolve-'));
  const dir = join(root, 'corpus');
  results = new Map(buildCorpus(dir, CASES).map((r) => [r.name, r]));
  const objects = loadObjects(dir);
  reader = {
    async readTree(hash: string): Promise<TreeEntry[] | null> {
      const o = objects.get(hash);
      return o && o.type === 'tree' ? parseTree(o.content) : null;
    },
    async readBlob(hash: string): Promise<Uint8Array | null> {
      const o = objects.get(hash);
      return o && o.type === 'blob' ? o.content : null;
    },
  };
}, 60_000);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

async function run(name: string, withResolver = true) {
  const c = results.get(name)!;
  const r = await merge3(reader, c.base, c.ours, c.theirs, withResolver ? { resolver } : {});
  return { c, r };
}

/** Content of `path` in a merged tree, reading created objects first. */
async function fileIn(tree: string, path: string, created: GitObject[]): Promise<string | null> {
  const own = new Map(created.map((o) => [o.hash, o]));
  const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);
  let entries = own.has(tree) ? parseTree(body(own.get(tree)!)) : await reader.readTree(tree);
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const e = entries?.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) {
      const blob = own.has(e.hash) ? body(own.get(e.hash)!) : await reader.readBlob(e.hash);
      return blob ? dec(blob) : null;
    }
    entries = own.has(e.hash) ? parseTree(body(own.get(e.hash)!)) : await reader.readTree(e.hash);
  }
  return null;
}

describe('deterministic resolution rules', () => {
  it('non-overlapping hunks: git’s merged tree, both edits kept, reported as resolved', async () => {
    const { c, r } = await run('non-overlapping');
    expect(c.expected.clean).toBe(true);
    expect(r).toMatchObject({ clean: true, treeHash: c.expected.tree, conflicts: [] });
    expect(r.resolved).toEqual([{ path: 'lines.txt', rule: 'non-overlapping' }]);
    expect(await fileIn(r.treeHash!, 'lines.txt', r.objects)).toBe(linesWith({ 2: 'line 2 main', 18: 'line 18 feature' }));
  });

  it('identical change on both sides: the shared text once', async () => {
    const { c, r } = await run('identical');
    expect(r).toMatchObject({ clean: true, treeHash: c.expected.tree });
    expect(r.resolved).toEqual([{ path: 'lines.txt', rule: 'identical-change' }]);
    const merged = (await fileIn(r.treeHash!, 'lines.txt', r.objects))!;
    expect(merged.split('\n')[4]).toBe('line 5 shared');
    expect(merged.match(/line 5 shared/g)).toHaveLength(1);

    const same = await run('identical-trees');
    expect(same.r).toMatchObject({ clean: true, treeHash: same.c.ours, resolved: [] });

    const mixed = await run('identical-hunk-plus-own-edits');
    expect(mixed.r).toMatchObject({ clean: true, treeHash: mixed.c.expected.tree });
    expect(await fileIn(mixed.r.treeHash!, 'lines.txt', mixed.r.objects)).toBe(
      linesWith({ 1: 'line 1 main', 5: 'line 5 shared', 20: 'line 20 feature' }),
    );
  });

  it('whitespace-only conflict: git refuses, the resolver picks the target’s variant', async () => {
    const plain = await run('whitespace', false);
    expect(plain.c.expected.clean).toBe(false);
    expect(plain.r.clean).toBe(false);
    expect(plain.r.resolved).toEqual([]);

    const { r } = await run('whitespace');
    expect(r).toMatchObject({ clean: true, conflicts: [], truncated: false });
    expect(r.resolved).toEqual([{ path: 'lines.txt', rule: 'whitespace-only', hunks: 1 }]);
    const merged = (await fileIn(r.treeHash!, 'lines.txt', r.objects))!;
    expect(merged).toBe(linesWith({ 7: '    line 7 indented' }));
  });

  it('add-add of an identical file: one path, exact content', async () => {
    const { c, r } = await run('add-add');
    expect(r).toMatchObject({ clean: true, treeHash: c.expected.tree });
    expect(r.resolved).toEqual([{ path: 'both.txt', rule: 'add-add-identical' }]);
    expect(await fileIn(r.treeHash!, 'both.txt', r.objects)).toBe('same content\nline two\n');
  });

  it('a different edit of the same line stays a content conflict', async () => {
    const { c, r } = await run('unresolvable');
    expect(c.expected.clean).toBe(false);
    expect(r.clean).toBe(false);
    expect(r.treeHash).toBeNull();
    expect(r.conflicts.map((x) => ({ path: x.path, kind: x.kind }))).toEqual([{ path: 'lines.txt', kind: 'content' }]);
  });

  it('a file with a whitespace hunk and a real conflict stays conflicted', async () => {
    const { r } = await run('whitespace-and-real');
    expect(r.clean).toBe(false);
    expect(r.conflicts.map((x) => x.path)).toEqual(['lines.txt']);
  });

  it('lockfile conflicts are never auto-resolved and are marked for regeneration', async () => {
    const { r } = await run('lockfile-whitespace');
    expect(r.clean).toBe(false);
    expect(classifyConflicts(r.conflicts, { isLockfile }).map((x) => ({ path: x.path, kind: x.kind, needsRegeneration: x.needsRegeneration }))).toEqual([
      { path: 'package-lock.json', kind: 'content', needsRegeneration: true },
    ]);
    const other = await run('unresolvable');
    expect(classifyConflicts(other.r.conflicts, { isLockfile })[0]).not.toHaveProperty('needsRegeneration');
  });
});

describe('whitespaceEquivalent', () => {
  const recs = (...xs: string[]) => xs.map((x) => `${x}\n`);

  it('ignores indentation, trailing space, CR and blank lines, not word boundaries', () => {
    expect(whitespaceEquivalent(recs('    a  b'), recs('\ta b'))).toBe(true);
    expect(whitespaceEquivalent(recs('a b'), recs('a b \r'))).toBe(true);
    expect(whitespaceEquivalent(recs('a', '', 'b'), recs('a', 'b'))).toBe(true);
    expect(whitespaceEquivalent(recs('a b'), recs('ab'))).toBe(false);
    expect(whitespaceEquivalent(recs('a'), recs('b'))).toBe(false);
    expect(whitespaceEquivalent(recs('x'), [])).toBe(false);
  });

  it('works on byte records: UTF-8 continuation bytes 0x85/0xA0 are not whitespace', () => {
    const bytes = (s: string) => String.fromCharCode(...enc(s));
    // U+00E0 (C3 A0) and U+2026 (E2 80 A6) / U+0105 (C4 85) contain bytes a Unicode-aware \s would match.
    expect(whitespaceEquivalent([bytes('xà\n')], [bytes('x\n')])).toBe(false);
    expect(whitespaceEquivalent([bytes('ą\n')], [bytes('\n')])).toBe(false);
    expect(whitespaceEquivalent([bytes('  à\n')], [bytes('\tà\n')])).toBe(true);
  });
});

describe('mergeText resolveHunk', () => {
  it('leaves git’s behavior alone without a resolver and counts resolved hunks with one', () => {
    const base = 'a\nb\nc\n';
    const ours = 'a\n  b\nc\n';
    const theirs = 'a\n\tb\nc\n';
    expect(mergeText(enc(base), enc(ours), enc(theirs))).toMatchObject({ clean: false, conflicts: 1, resolved: 0 });
    const r = mergeText(enc(base), enc(ours), enc(theirs), { resolveHunk: () => 'theirs' })!;
    expect({ clean: r.clean, conflicts: r.conflicts, resolved: r.resolved, merged: dec(r.merged) }).toEqual({
      clean: true,
      conflicts: 0,
      resolved: 1,
      merged: theirs,
    });
  });
});
