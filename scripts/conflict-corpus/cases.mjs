/**
 * The scripted three-way merge corpus. Every case is a base tree plus two
 * patches (ours, theirs). A patch maps a path to:
 *
 *  - a string: a regular file (100644) with that content
 *  - `{ content, mode }`: a regular file with an explicit mode (100644/100755)
 *  - `{ symlink: target }`, `{ gitlink: sha }`
 *  - `{ from: path }`: the base entry at `path`, unchanged (an exact rename
 *    when the patch also deletes `path`)
 *  - `null`: delete the path
 *
 * `expect` documents the intended outcome; the generator checks it against
 * git so a mistyped case fails loudly instead of silently testing nothing.
 * Seeded generators add line-level and tree-level cases; same seed, same
 * corpus.
 */

/** Lines joined with a trailing newline. */
export const L = (...lines) => lines.map((l) => `${l}\n`).join('');

const CODE_LINES = [
  "import { x } from './x';",
  '',
  'function a() {',
  '  return 1;',
  '}',
  '',
  'function b() {',
  '  return 2;',
  '}',
  '',
  'function c() {',
  '  return 3;',
  '}',
  '',
  'export { a, b, c };',
];
const CODE = L(...CODE_LINES);
/** CODE with `from` replaced by `to` (first occurrence). */
const edit = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`corpus edit: ${JSON.stringify(from)} not found`);
  return text.replace(from, to);
};
const numbered = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);
const BIG = numbered(200);
const bigWith = (changes) => L(...BIG.map((l, i) => changes[i + 1] ?? l));
const GITLINK_A = '1111111111111111111111111111111111111111';
const GITLINK_B = '2222222222222222222222222222222222222222';
const GITLINK_C = '3333333333333333333333333333333333333333';

/** @type {import('./corpus.d.mts').CorpusCase[]} */
export const HAND_CASES = [
  // ---- clean -------------------------------------------------------------
  {
    name: 'disjoint-edits',
    expect: 'clean',
    base: { 'src/app.js': CODE },
    ours: { 'src/app.js': edit(CODE, 'return 1;', 'return 10;') },
    theirs: { 'src/app.js': edit(CODE, 'return 3;', 'return 30;') },
  },
  {
    name: 'identical-edits',
    expect: 'clean',
    base: { 'src/app.js': CODE, 'README.md': 'readme\n' },
    ours: { 'src/app.js': edit(CODE, 'return 2;', 'return 20;') },
    theirs: { 'src/app.js': edit(CODE, 'return 2;', 'return 20;'), 'README.md': 'readme v2\n' },
  },
  {
    name: 'one-side-edit-other-adds',
    expect: 'clean',
    base: { 'src/app.js': CODE },
    ours: { 'src/app.js': edit(CODE, 'function b() {', 'function bee() {') },
    theirs: { 'src/extra.js': 'export const extra = 1;\n' },
  },
  {
    name: 'add-add-identical',
    expect: 'clean',
    base: { 'README.md': 'readme\n' },
    ours: { 'NOTES.md': L('same', 'notes') },
    theirs: { 'NOTES.md': L('same', 'notes') },
  },
  {
    name: 'add-different-files',
    expect: 'clean',
    base: { 'README.md': 'readme\n' },
    ours: { 'a/ours.txt': 'ours\n' },
    theirs: { 'a/theirs.txt': 'theirs\n', 'b/theirs.txt': 'more\n' },
  },
  {
    name: 'delete-unchanged-file',
    expect: 'clean',
    base: { 'old.txt': 'old\n', 'src/app.js': CODE },
    ours: { 'old.txt': null },
    theirs: { 'src/app.js': edit(CODE, 'return 1;', 'return 11;') },
  },
  {
    name: 'both-delete',
    expect: 'clean',
    base: { 'gone.txt': 'bye\n', 'keep.txt': 'keep\n' },
    ours: { 'gone.txt': null },
    theirs: { 'gone.txt': null, 'keep.txt': 'kept\n' },
  },
  {
    name: 'rename-vs-modify',
    expect: 'clean',
    base: { 'src/util.js': CODE, 'src/main.js': 'main\n' },
    ours: { 'src/util.js': null, 'lib/util.js': { from: 'src/util.js' } },
    theirs: { 'src/util.js': edit(CODE, 'return 2;', 'return 22;') },
  },
  {
    name: 'modify-vs-rename',
    expect: 'clean',
    base: { 'docs/a.md': L('alpha', 'beta', 'gamma'), 'x.txt': 'x\n' },
    ours: { 'docs/a.md': L('ALPHA', 'beta', 'gamma') },
    theirs: { 'docs/a.md': null, 'docs/renamed.md': { from: 'docs/a.md' } },
  },
  {
    name: 'rename-both-same-target',
    expect: 'clean',
    base: { 'a.txt': L('one', 'two', 'three', 'four'), 'b.txt': 'b\n' },
    ours: { 'a.txt': null, 'moved/a.txt': { from: 'a.txt' } },
    theirs: { 'a.txt': null, 'moved/a.txt': { from: 'a.txt' }, 'b.txt': 'B\n' },
  },
  {
    name: 'mode-vs-content',
    expect: 'clean',
    base: { 'run.sh': L('#!/bin/sh', 'echo hi') },
    ours: { 'run.sh': { content: L('#!/bin/sh', 'echo hi'), mode: '100755' } },
    theirs: { 'run.sh': L('#!/bin/sh', 'echo hello') },
  },
  {
    name: 'exec-bit-both',
    expect: 'clean',
    base: { 'tool': L('#!/bin/sh', 'exit 0') },
    ours: { 'tool': { content: L('#!/bin/sh', 'exit 0'), mode: '100755' } },
    theirs: { 'tool': { content: L('#!/bin/sh', 'exit 0'), mode: '100755' } },
  },
  {
    name: 'deep-nesting',
    expect: 'clean',
    base: { 'a/b/c/d/one.txt': '1\n', 'a/b/c/d/two.txt': '2\n', 'a/b/x.txt': 'x\n', 'z.txt': 'z\n' },
    ours: { 'a/b/c/d/one.txt': 'uno\n', 'a/b/c/e/new.txt': 'new\n' },
    theirs: { 'a/b/c/d/two.txt': 'dos\n', 'a/q/r/s.txt': 's\n' },
  },
  {
    name: 'new-directory-one-side',
    expect: 'clean',
    base: { 'README.md': 'readme\n' },
    ours: { 'pkg/src/index.ts': 'export {};\n', 'pkg/package.json': '{}\n' },
    theirs: { 'README.md': 'readme!\n' },
  },
  {
    name: 'delete-directory-one-side',
    expect: 'clean',
    base: { 'legacy/a.txt': 'a\n', 'legacy/sub/b.txt': 'b\n', 'src/app.js': CODE },
    ours: { 'legacy/a.txt': null, 'legacy/sub/b.txt': null },
    theirs: { 'src/app.js': edit(CODE, 'return 3;', 'return 33;') },
  },
  {
    name: 'file-to-dir-untouched',
    expect: 'clean',
    base: { 'cfg': 'flat config\n', 'other.txt': 'o\n' },
    ours: { 'cfg': null, 'cfg/main.json': '{"a":1}\n' },
    theirs: { 'other.txt': 'O\n' },
  },
  {
    name: 'dir-to-file-untouched',
    expect: 'clean',
    base: { 'conf/a.ini': 'a\n', 'conf/b.ini': 'b\n', 'other.txt': 'o\n' },
    ours: { 'other.txt': 'O\n' },
    theirs: { 'conf/a.ini': null, 'conf/b.ini': null, 'conf': 'single file\n' },
  },
  {
    name: 'symlink-retarget-one-side',
    expect: 'clean',
    base: { 'current': { symlink: 'v1' }, 'v1/x': '1\n', 'v2/x': '2\n' },
    ours: { 'current': { symlink: 'v2' } },
    theirs: { 'v1/x': 'one\n' },
  },
  {
    name: 'gitlink-one-side',
    expect: 'clean',
    base: { 'vendor/lib': { gitlink: GITLINK_A }, 'README.md': 'r\n' },
    ours: { 'vendor/lib': { gitlink: GITLINK_B } },
    theirs: { 'README.md': 'R\n' },
  },
  {
    name: 'no-trailing-newline',
    expect: 'clean',
    base: { 'f.txt': 'one\ntwo\nthree\nfour\nfive' },
    ours: { 'f.txt': 'ONE\ntwo\nthree\nfour\nfive' },
    theirs: { 'f.txt': 'one\ntwo\nthree\nfour\nfive\n' },
  },
  {
    name: 'prepend-and-append',
    expect: 'clean',
    base: { 'list.txt': L('b', 'c', 'd') },
    ours: { 'list.txt': L('a', 'b', 'c', 'd') },
    theirs: { 'list.txt': L('b', 'c', 'd', 'e') },
  },
  {
    name: 'crlf-disjoint',
    expect: 'clean',
    base: { 'win.txt': 'one\r\ntwo\r\nthree\r\nfour\r\n' },
    ours: { 'win.txt': 'ONE\r\ntwo\r\nthree\r\nfour\r\n' },
    theirs: { 'win.txt': 'one\r\ntwo\r\nthree\r\nFOUR\r\n' },
  },
  {
    name: 'empty-file-gains-content',
    expect: 'clean',
    base: { 'empty.txt': '', 'other.txt': 'o\n' },
    ours: { 'empty.txt': L('now', 'full') },
    theirs: { 'other.txt': 'O\n' },
  },
  {
    name: 'scattered-edits-large-file',
    expect: 'clean',
    base: { 'big.txt': bigWith({}) },
    ours: { 'big.txt': bigWith({ 10: 'ours 10', 50: 'ours 50', 90: 'ours 90', 199: 'ours 199' }) },
    theirs: { 'big.txt': bigWith({ 30: 'theirs 30', 70: 'theirs 70', 150: 'theirs 150', 1: 'theirs 1' }) },
  },
  {
    name: 'one-line-gap',
    expect: 'clean',
    base: { 'f.txt': L('1', '2', '3', '4', '5') },
    ours: { 'f.txt': L('1', 'TWO', '3', '4', '5') },
    theirs: { 'f.txt': L('1', '2', '3', 'FOUR', '5') },
  },
  {
    name: 'dir-partially-moved',
    expect: 'clean',
    base: { 'dir/a.txt': 'a\n', 'dir/b.txt': 'b\n' },
    ours: { 'dir/a.txt': null, 'other/a.txt': { from: 'dir/a.txt' } },
    theirs: { 'dir/c.txt': 'c\n' },
  },
  {
    name: 'dir-rename-vs-edit',
    expect: 'clean',
    base: { 'old/x.txt': L('x1', 'x2', 'x3'), 'old/y.txt': 'y\n', 'root.txt': 'r\n' },
    ours: { 'old/x.txt': null, 'old/y.txt': null, 'new/x.txt': { from: 'old/x.txt' }, 'new/y.txt': { from: 'old/y.txt' } },
    theirs: { 'old/x.txt': L('x1', 'X2', 'x3') },
  },
  {
    name: 'binary-one-side',
    expect: 'clean',
    base: { 'img.bin': 'PNG\0\x01\x02', 'README.md': 'r\n' },
    ours: { 'img.bin': 'PNG\0\x01\x03' },
    theirs: { 'README.md': 'R\n' },
  },
  {
    name: 'tree-sort-order',
    expect: 'clean',
    base: { 'a-b': '1\n', 'a.b': '2\n', 'a/x': '3\n', 'a0': '4\n' },
    ours: { 'a/y': 'y\n', 'a.c': 'c\n' },
    theirs: { 'a-a': 'aa\n', 'a/x': 'X\n', 'a=': 'eq\n' },
  },
  {
    name: 'unicode-paths-and-content',
    expect: 'clean',
    base: { 'docs/über.md': L('grüße', 'mittel', 'ende 🚀') },
    ours: { 'docs/über.md': L('GRÜSSE', 'mittel', 'ende 🚀') },
    theirs: { 'docs/über.md': L('grüße', 'mittel', 'ende 🛸'), 'docs/日本.txt': 'こんにちは\n' },
  },
  {
    name: 'fanout',
    expect: 'clean',
    base: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`d${i % 4}/f${i}.txt`, `file ${i}\n`])),
    ours: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${(2 * i) % 4}/f${2 * i}.txt`, `ours ${2 * i}\n`])),
    theirs: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`d${(2 * i + 1) % 4}/f${2 * i + 1}.txt`, `theirs ${2 * i + 1}\n`])),
  },
  {
    name: 'identical-insertions',
    expect: 'clean',
    base: { 'f.txt': L('a', 'b', 'c') },
    ours: { 'f.txt': L('a', 'new 1', 'new 2', 'b', 'c') },
    theirs: { 'f.txt': L('a', 'new 1', 'new 2', 'b', 'c') },
  },
  {
    name: 'identical-deletions',
    expect: 'clean',
    base: { 'f.txt': L('a', 'b', 'c', 'd', 'e') },
    ours: { 'f.txt': L('a', 'd', 'e') },
    theirs: { 'f.txt': L('a', 'd', 'e'), 'g.txt': 'g\n' },
  },
  {
    name: 'rename-plus-unrelated-adds',
    expect: 'clean',
    base: { 'src/one.txt': L('one', 'uno'), 'src/two.txt': 'two\n' },
    ours: { 'src/one.txt': null, 'src/first.txt': { from: 'src/one.txt' }, 'src/three.txt': 'three\n' },
    theirs: { 'src/two.txt': 'TWO\n', 'docs/added.md': 'docs\n' },
  },
  {
    name: 'empty-base-disjoint-adds',
    expect: 'clean',
    base: {},
    ours: { 'a.txt': 'a\n' },
    theirs: { 'b.txt': 'b\n' },
  },

  // ---- conflicts ---------------------------------------------------------
  {
    name: 'same-line',
    expect: 'conflict',
    base: { 'src/app.js': CODE },
    ours: { 'src/app.js': edit(CODE, 'return 2;', 'return 200;') },
    theirs: { 'src/app.js': edit(CODE, 'return 2;', 'return -2;') },
  },
  {
    name: 'adjacent-lines',
    expect: 'conflict',
    base: { 'f.txt': L('1', '2', '3', '4') },
    ours: { 'f.txt': L('1', 'TWO', '3', '4') },
    theirs: { 'f.txt': L('1', '2', 'THREE', '4') },
  },
  {
    name: 'both-append',
    expect: 'conflict',
    base: { 'log.txt': L('start') },
    ours: { 'log.txt': L('start', 'ours') },
    theirs: { 'log.txt': L('start', 'theirs') },
  },
  {
    name: 'add-add-different',
    expect: 'conflict',
    base: { 'README.md': 'r\n' },
    ours: { 'new.txt': L('shared', 'ours') },
    theirs: { 'new.txt': L('shared', 'theirs') },
  },
  {
    name: 'modify-delete',
    expect: 'conflict',
    base: { 'f.txt': L('a', 'b'), 'g.txt': 'g\n' },
    ours: { 'f.txt': L('a', 'B') },
    theirs: { 'f.txt': null },
  },
  {
    name: 'delete-modify',
    expect: 'conflict',
    base: { 'f.txt': L('a', 'b') },
    ours: { 'f.txt': null },
    theirs: { 'f.txt': L('A', 'b') },
  },
  {
    name: 'binary-both-changed',
    expect: 'conflict',
    base: { 'blob.bin': 'bin\0base' },
    ours: { 'blob.bin': 'bin\0ours' },
    theirs: { 'blob.bin': 'bin\0theirs' },
  },
  {
    name: 'add-add-binary',
    expect: 'conflict',
    base: { 'README.md': 'r\n' },
    ours: { 'data.bin': 'bin\0o' },
    theirs: { 'data.bin': 'bin\0t' },
  },
  {
    name: 'rename-delete',
    expect: 'conflict',
    base: { 'rd.txt': L('r1', 'r2'), 'other.txt': 'o\n' },
    ours: { 'rd.txt': null, 'rd-moved.txt': { from: 'rd.txt' } },
    theirs: { 'rd.txt': null },
  },
  {
    name: 'rename-rename',
    expect: 'conflict',
    base: { 'src.txt': L('s1', 's2', 's3') },
    ours: { 'src.txt': null, 'ours-name.txt': { from: 'src.txt' } },
    theirs: { 'src.txt': null, 'theirs-name.txt': { from: 'src.txt' } },
  },
  {
    name: 'rename-onto-add',
    expect: 'conflict',
    base: { 'ra.txt': L('s1', 's2') },
    ours: { 'ra.txt': null, 'target.txt': { from: 'ra.txt' } },
    theirs: { 'target.txt': L('something', 'else') },
  },
  {
    name: 'file-vs-dir-add',
    expect: 'conflict',
    base: { 'README.md': 'r\n' },
    ours: { 'thing': 'a file\n' },
    theirs: { 'thing/inside.txt': 'a dir\n' },
  },
  {
    name: 'dir-to-file-vs-edit-inside',
    expect: 'conflict',
    base: { 'dd/x': 'q\n', 'keep.txt': 'k\n' },
    ours: { 'dd/x': null, 'dd': 'file now\n' },
    theirs: { 'dd/x': 'qq\n' },
  },
  {
    name: 'file-to-dir-vs-edit',
    expect: 'conflict',
    base: { 'fdir': 'ff\n' },
    ours: { 'fdir': null, 'fdir/in': 'z\n' },
    theirs: { 'fdir': 'ff2\n' },
  },
  {
    name: 'distinct-types',
    expect: 'conflict',
    base: { 'ty': 'k\n' },
    ours: { 'ty': { symlink: 'somewhere' } },
    theirs: { 'ty': 'k2\n' },
  },
  {
    name: 'symlink-both',
    expect: 'conflict',
    base: { 'lnk': { symlink: 'target' } },
    ours: { 'lnk': { symlink: 'other-o' } },
    theirs: { 'lnk': { symlink: 'other-t' } },
  },
  {
    name: 'dir-rename-add-inside',
    expect: 'conflict',
    base: { 'dir/a': '1\n', 'dir/b': '2\n', 'dir/c': '3\n' },
    ours: { 'dir/a': null, 'dir/b': null, 'dir/c': null, 'dir2/a': { from: 'dir/a' }, 'dir2/b': { from: 'dir/b' }, 'dir2/c': { from: 'dir/c' } },
    theirs: { 'dir/new': 'new\n' },
  },
  {
    name: 'mixed-conflicts-and-clean',
    expect: 'conflict',
    base: { 'src/app.js': CODE, 'a.txt': L('a'), 'b.txt': L('b'), 'c.txt': L('c') },
    ours: { 'src/app.js': edit(CODE, 'return 1;', 'return 100;'), 'a.txt': L('A ours'), 'b.txt': null, 'n/ours.txt': 'n\n' },
    theirs: { 'src/app.js': edit(CODE, 'return 3;', 'return 300;'), 'a.txt': L('A theirs'), 'b.txt': L('B'), 'c.txt': L('C') },
  },
  {
    name: 'overlapping-deletes',
    expect: 'conflict',
    base: { 'f.txt': L('1', '2', '3', '4', '5', '6') },
    ours: { 'f.txt': L('1', '4', '5', '6') },
    theirs: { 'f.txt': L('1', '2', '5', '6') },
  },
  {
    name: 'delete-range-vs-edit-inside',
    expect: 'conflict',
    base: { 'f.txt': L('1', '2', '3', '4', '5', '6') },
    ours: { 'f.txt': L('1', '5', '6') },
    theirs: { 'f.txt': L('1', '2', 'THREE', '4', '5', '6') },
  },
  {
    name: 'no-trailing-newline-both-append',
    expect: 'conflict',
    base: { 'f.txt': 'one\ntwo' },
    ours: { 'f.txt': 'one\ntwo\nthree' },
    theirs: { 'f.txt': 'one\ntwo\nfour\n' },
  },
  {
    name: 'gitlink-both',
    expect: 'conflict',
    base: { 'vendor/lib': { gitlink: GITLINK_A } },
    ours: { 'vendor/lib': { gitlink: GITLINK_B } },
    theirs: { 'vendor/lib': { gitlink: GITLINK_C } },
  },
  {
    name: 'mode-vs-delete',
    expect: 'conflict',
    base: { 'run.sh': L('#!/bin/sh') },
    ours: { 'run.sh': { content: L('#!/bin/sh'), mode: '100755' } },
    theirs: { 'run.sh': null },
  },
];

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, xs) => xs[Math.floor(rand() * xs.length)];

function mutateLines(src, rand, tag) {
  const out = [...src];
  const edits = 1 + Math.floor(rand() * 3);
  for (let e = 0; e < edits; e++) {
    const at = Math.floor(rand() * (out.length + 1));
    const op = rand();
    if (op < 0.4 && out.length > 0) out[Math.min(at, out.length - 1)] = `${tag} edit ${e}`;
    else if (op < 0.7) out.splice(at, 0, `${tag} insert ${e}`, ...(rand() < 0.3 ? [''] : []));
    else out.splice(at, Math.min(1 + Math.floor(rand() * 3), out.length - at));
  }
  return out;
}

/** Single-file line-level cases over code-like text (blank lines and braces repeat). */
export function textCases(seed = 9001, count = 80) {
  const rand = rng(seed);
  const vocab = ['{', '}', '', 'return null;', '  // note'];
  const cases = [];
  for (let i = 0; i < count; i++) {
    const n = 5 + Math.floor(rand() * 25);
    const base = Array.from({ length: n }, (_, k) => (rand() < 0.25 ? pick(rand, vocab) : `stmt_${k}();`));
    const ours = mutateLines(base, rand, 'ours');
    const theirs = mutateLines(base, rand, 'theirs');
    const noEol = rand() < 0.1;
    const text = (ls) => (noEol && ls.length > 0 ? ls.join('\n') : L(...ls));
    cases.push({
      name: `text-${String(i).padStart(3, '0')}`,
      base: { 'f.txt': text(base) },
      ours: { 'f.txt': text(ours) },
      theirs: { 'f.txt': text(theirs) },
    });
  }
  return cases;
}

/**
 * Small trees edited independently on both sides: content edits (that may
 * or may not collide), deletes, unique adds, exact renames and mode flips.
 * Added content is unique per side, so git's similarity-based rename
 * detection only ever finds the exact renames.
 */
export function treeCases(seed = 4242, count = 40) {
  const rand = rng(seed);
  const cases = [];
  for (let i = 0; i < count; i++) {
    const base = {};
    const nFiles = 4 + Math.floor(rand() * 6);
    for (let f = 0; f < nFiles; f++) {
      const dir = pick(rand, ['', 'src/', 'src/lib/', 'docs/']);
      base[`${dir}file${f}.txt`] = L(...Array.from({ length: 6 }, (_, k) => `c${i} f${f} line ${k}`));
    }
    const side = (tag) => {
      const patch = {};
      const paths = Object.keys(base);
      const ops = 1 + Math.floor(rand() * 3);
      for (let o = 0; o < ops; o++) {
        const p = pick(rand, paths);
        if (p in patch) continue;
        const r = rand();
        if (r < 0.45) {
          const ls = base[p].split('\n').slice(0, -1);
          ls[Math.floor(rand() * ls.length)] = `${tag} edit ${o}`;
          patch[p] = L(...ls);
        } else if (r < 0.6) {
          patch[p] = null;
        } else if (r < 0.75) {
          patch[p] = null;
          patch[`${pick(rand, ['', 'moved/', 'src/'])}${tag}-renamed${o}.txt`] = { from: p };
        } else if (r < 0.85) {
          patch[p] = { content: base[p], mode: '100755' };
        } else {
          patch[`${pick(rand, ['', 'src/', 'new/'])}${tag}-added${o}.txt`] = L(`${tag} added ${i}.${o}`, 'unique body');
        }
      }
      return patch;
    };
    cases.push({ name: `tree-${String(i).padStart(3, '0')}`, base, ours: side('ours'), theirs: side('theirs') });
  }
  return cases;
}

export function allCases() {
  return [...HAND_CASES, ...textCases(), ...treeCases()];
}
