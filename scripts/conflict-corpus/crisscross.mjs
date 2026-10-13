/**
 * Criss-cross cases for the conflict corpus: commit graphs whose two tips
 * have several merge bases, so git merges the bases into a virtual ancestor
 * first (merge-ort's recursive step) and the tip merge runs against it.
 *
 * A case lists commits in creation order. Each is `[name, parents, patch]`:
 * a root's patch is its whole file map; any other commit starts from its
 * first parent's files and applies the patch (same patch language as
 * cases.mjs, without `{from}` renames: these cases are rename-free).
 * `ours` and `theirs` name the tips; `bases` is how many merge bases git
 * reports for them, checked when the corpus is built, like `expect`.
 */

import { L, rng } from './cases.mjs';

const ten = (changes = {}) => L(...Array.from({ length: 10 }, (_, i) => changes[i + 1] ?? `line ${i + 1}`));

/** @type {import('./corpus.d.mts').CrissCrossCase[]} */
export const CRISS_CROSS_CASES = [
  {
    // Both bases edit disjoint lines; both tips carry the merged result plus their own edits.
    name: 'cc-clean-disjoint',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'a.txt': ten(), 'b.txt': 'b\n' }],
      ['B1', ['O'], { 'a.txt': ten({ 2: 'B1' }) }],
      ['B2', ['O'], { 'a.txt': ten({ 9: 'B2' }) }],
      ['M1', ['B1', 'B2'], { 'a.txt': ten({ 2: 'B1', 9: 'B2' }) }],
      ['M2', ['B2', 'B1'], { 'a.txt': ten({ 2: 'B1', 9: 'B2' }) }],
      ['A', ['M1'], { 'b.txt': 'b from A\n' }],
      ['B', ['M2'], { 'c.txt': 'c from B\n' }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    // The bases conflict on line 5; both criss-cross merges resolved it the same way and then
    // edited opposite ends of the file. The markers in the virtual ancestor cancel out.
    name: 'cc-conflict-cancels',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten() }],
      ['B1', ['O'], { 'f.txt': ten({ 5: 'five from B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 5: 'five from B2' }) }],
      ['M1', ['B1', 'B2'], { 'f.txt': ten({ 1: 'first edited by M1', 5: 'five resolved' }) }],
      ['M2', ['B2', 'B1'], { 'f.txt': ten({ 5: 'five resolved', 10: 'last edited by M2' }) }],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    // Each criss-cross merge kept a different base's side: against either base alone the merge
    // would silently pick one; against the virtual ancestor it is a real conflict, as in git.
    name: 'cc-real-conflict',
    expect: 'conflict',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten(), 'g.txt': 'g\n' }],
      ['B1', ['O'], { 'f.txt': ten({ 5: 'five from B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 5: 'five from B2' }) }],
      ['M1', ['B1', 'B2'], {}],
      ['M2', ['B2', 'B1'], {}],
      ['A', ['M1'], { 'g.txt': 'g from A\n' }],
      ['B', ['M2'], { 'h.txt': 'h from B\n' }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    name: 'cc-identical-resolution',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten() }],
      ['B1', ['O'], { 'f.txt': ten({ 3: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 3: 'B2' }) }],
      ['M1', ['B1', 'B2'], { 'f.txt': ten({ 3: 'both' }) }],
      ['M2', ['B2', 'B1'], { 'f.txt': ten({ 3: 'both' }) }],
      ['A', ['M1'], { 'f.txt': ten({ 3: 'both', 8: 'A' }) }],
      ['B', ['M2'], { 'x.txt': 'x\n' }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    // One base modified, the other deleted; the virtual ancestor keeps the original file, so a
    // tip that kept the modification and a tip that kept the deletion conflict.
    name: 'cc-modify-delete',
    expect: 'conflict',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten(), 'keep.txt': 'k\n' }],
      ['B1', ['O'], { 'f.txt': ten({ 4: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': null }],
      ['M1', ['B1', 'B2'], {}],
      ['M2', ['B2', 'B1'], {}],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    name: 'cc-delete-agreed',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten(), 'keep.txt': 'k\n' }],
      ['B1', ['O'], { 'f.txt': ten({ 4: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': null }],
      ['M1', ['B1', 'B2'], { 'f.txt': null }],
      ['M2', ['B2', 'B1'], { 'keep.txt': 'kept\n' }],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    // Both bases add the same path with different content (an add/add merged against an empty base).
    name: 'cc-add-add-resolved',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'README.md': 'r\n' }],
      ['B1', ['O'], { 'new.txt': L('one', 'B1') }],
      ['B2', ['O'], { 'new.txt': L('one', 'B2') }],
      ['M1', ['B1', 'B2'], { 'new.txt': L('one', 'merged') }],
      ['M2', ['B2', 'B1'], { 'new.txt': L('one', 'merged') }],
      ['A', ['M1'], { 'README.md': 'r from A\n' }],
      ['B', ['M2'], { 'other.txt': 'o\n' }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    name: 'cc-add-add-conflict',
    expect: 'conflict',
    bases: 2,
    commits: [
      ['O', [], { 'README.md': 'r\n' }],
      ['B1', ['O'], { 'new.txt': L('one', 'B1') }],
      ['B2', ['O'], { 'new.txt': L('one', 'B2') }],
      ['M1', ['B1', 'B2'], {}],
      ['M2', ['B2', 'B1'], {}],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    // Binary content does not merge; the virtual ancestor keeps the original bytes.
    name: 'cc-binary-conflict',
    expect: 'conflict',
    bases: 2,
    commits: [
      ['O', [], { 'img.bin': 'PNG\0base', 'r.txt': 'r\n' }],
      ['B1', ['O'], { 'img.bin': 'PNG\0B1' }],
      ['B2', ['O'], { 'img.bin': 'PNG\0B2' }],
      ['M1', ['B1', 'B2'], {}],
      ['M2', ['B2', 'B1'], {}],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    name: 'cc-binary-same-resolution',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'img.bin': 'PNG\0base', 'r.txt': 'r\n' }],
      ['B1', ['O'], { 'img.bin': 'PNG\0B1' }],
      ['B2', ['O'], { 'img.bin': 'PNG\0B2' }],
      ['M1', ['B1', 'B2'], { 'img.bin': 'PNG\0final' }],
      ['M2', ['B2', 'B1'], { 'img.bin': 'PNG\0final', 'r.txt': 'r2\n' }],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    // Three bases editing different lines, merged in different orders on each side.
    name: 'cc-three-bases-clean',
    expect: 'clean',
    bases: 3,
    commits: [
      ['O', [], { 'f.txt': ten(), 'g.txt': 'g\n' }],
      ['B1', ['O'], { 'f.txt': ten({ 1: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 5: 'B2' }) }],
      ['B3', ['O'], { 'f.txt': ten({ 9: 'B3' }) }],
      ['M12', ['B1', 'B2'], { 'f.txt': ten({ 1: 'B1', 5: 'B2' }) }],
      ['A', ['M12', 'B3'], { 'f.txt': ten({ 1: 'B1', 5: 'B2', 9: 'B3' }), 'g.txt': 'g from A\n' }],
      ['M32', ['B3', 'B2'], { 'f.txt': ten({ 5: 'B2', 9: 'B3' }) }],
      ['B', ['M32', 'B1'], { 'f.txt': ten({ 1: 'B1', 5: 'B2', 9: 'B3' }), 'h.txt': 'h\n' }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    name: 'cc-three-bases-conflict',
    expect: 'conflict',
    bases: 3,
    commits: [
      ['O', [], { 'f.txt': ten() }],
      ['B1', ['O'], { 'f.txt': ten({ 5: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 5: 'B2' }) }],
      ['B3', ['O'], { 'f.txt': ten({ 5: 'B3' }) }],
      ['M12', ['B1', 'B2'], {}],
      ['A', ['M12', 'B3'], {}],
      ['M32', ['B3', 'B2'], {}],
      ['B', ['M32', 'B1'], {}],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    name: 'cc-three-bases-cancels',
    expect: 'clean',
    bases: 3,
    commits: [
      ['O', [], { 'f.txt': ten() }],
      ['B1', ['O'], { 'f.txt': ten({ 5: 'B1' }) }],
      ['B2', ['O'], { 'f.txt': ten({ 5: 'B2' }) }],
      ['B3', ['O'], { 'f.txt': ten({ 5: 'B3' }) }],
      ['M12', ['B1', 'B2'], { 'f.txt': ten({ 5: 'all' }) }],
      ['A', ['M12', 'B3'], { 'f.txt': ten({ 2: 'A', 5: 'all' }) }],
      ['M32', ['B3', 'B2'], { 'f.txt': ten({ 5: 'all' }) }],
      ['B', ['M32', 'B1'], { 'f.txt': ten({ 5: 'all', 8: 'B' }) }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    // The two merge bases are themselves a criss-cross pair: their virtual merge needs its own
    // virtual ancestor (call depth 2).
    name: 'cc-nested-depth-2',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'f.txt': ten(), 'g.txt': 'g\n' }],
      ['P1', ['O'], { 'f.txt': ten({ 2: 'P1' }) }],
      ['P2', ['O'], { 'f.txt': ten({ 2: 'P2' }) }],
      ['Q1', ['P1', 'P2'], { 'f.txt': ten({ 2: 'Q', 4: 'Q1' }) }],
      ['Q2', ['P2', 'P1'], { 'f.txt': ten({ 2: 'Q', 7: 'Q2' }) }],
      ['R1', ['Q1', 'Q2'], { 'f.txt': ten({ 2: 'Q', 4: 'Q1', 7: 'Q2' }) }],
      ['R2', ['Q2', 'Q1'], { 'f.txt': ten({ 2: 'Q', 4: 'Q1', 7: 'Q2' }) }],
      ['A', ['R1'], { 'g.txt': 'g from A\n' }],
      ['B', ['R2'], { 'f.txt': ten({ 2: 'Q', 4: 'Q1', 7: 'Q2', 10: 'B' }) }],
    ],
    ours: 'A',
    theirs: 'B',
  },
  {
    // Bases from two unrelated roots: their virtual merge runs against the empty tree.
    name: 'cc-unrelated-bases',
    expect: 'clean',
    bases: 2,
    commits: [
      ['R1', [], { 'one.txt': '1\n' }],
      ['R2', [], { 'two.txt': '2\n' }],
      ['M1', ['R1', 'R2'], { 'two.txt': '2\n', 'm1.txt': 'm1\n' }],
      ['M2', ['R2', 'R1'], { 'one.txt': '1\n', 'm2.txt': 'm2\n' }],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
  {
    // Same file in nested directories, untouched subtrees elsewhere: the virtual tree is rebuilt
    // along the edited paths only.
    name: 'cc-nested-dirs',
    expect: 'clean',
    bases: 2,
    commits: [
      ['O', [], { 'src/lib/a.js': ten(), 'src/main.js': 'main\n', 'docs/x.md': 'x\n' }],
      ['B1', ['O'], { 'src/lib/a.js': ten({ 3: 'B1' }), 'docs/b1.md': 'b1\n' }],
      ['B2', ['O'], { 'src/lib/a.js': ten({ 3: 'B2' }) }],
      ['M1', ['B1', 'B2'], { 'src/lib/a.js': ten({ 3: 'B12' }), 'src/main.js': 'main 1\n' }],
      ['M2', ['B2', 'B1'], { 'src/lib/a.js': ten({ 3: 'B12' }), 'docs/b1.md': 'b1\n', 'docs/x.md': 'x2\n' }],
    ],
    ours: 'M1',
    theirs: 'M2',
  },
];

/**
 * Seeded criss-cross cases over one 12-line file: two bases edit random
 * lines, each criss-cross merge picks a random resolution per line, and the
 * tips add one more random edit. Same seed, same cases.
 */
export function crissCrossRandomCases(seed = 1717, count = 24) {
  const rand = rng(seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const N = 12;
  const lines = (m) => L(...Array.from({ length: N }, (_, i) => m[i] ?? `l${i}`));
  const cases = [];
  for (let c = 0; c < count; c++) {
    const b1 = {};
    const b2 = {};
    const n1 = 1 + Math.floor(rand() * 3);
    const n2 = 1 + Math.floor(rand() * 3);
    for (let k = 0; k < n1; k++) b1[Math.floor(rand() * N)] = `b1-${c}-${k}`;
    for (let k = 0; k < n2; k++) b2[Math.floor(rand() * N)] = `b2-${c}-${k}`;
    const resolve = (tag) => {
      const out = {};
      for (let i = 0; i < N; i++) {
        const choices = [b1[i], b2[i]].filter((x) => x !== undefined);
        if (choices.length === 0) continue;
        out[i] = choices.length === 2 ? pick([...choices, `both-${c}`]) : choices[0];
      }
      if (rand() < 0.4) out[Math.floor(rand() * N)] = `${tag}-${c}`;
      return out;
    };
    const m1 = resolve('m1');
    const m2 = resolve('m2');
    const tipA = { ...m1 };
    const tipB = { ...m2 };
    if (rand() < 0.5) tipA[Math.floor(rand() * N)] = `a-${c}`;
    if (rand() < 0.5) tipB[Math.floor(rand() * N)] = `b-${c}`;
    cases.push({
      name: `cc-random-${c}`,
      bases: 2,
      commits: [
        ['O', [], { 'f.txt': lines({}) }],
        ['B1', ['O'], { 'f.txt': lines(b1) }],
        ['B2', ['O'], { 'f.txt': lines(b2) }],
        ['M1', ['B1', 'B2'], { 'f.txt': lines(m1) }],
        ['M2', ['B2', 'B1'], { 'f.txt': lines(m2) }],
        ['A', ['M1'], { 'f.txt': lines(tipA) }],
        ['B', ['M2'], { 'f.txt': lines(tipB) }],
      ],
      ours: 'A',
      theirs: 'B',
    });
  }
  return cases;
}

export function allCrissCrossCases() {
  return [...CRISS_CROSS_CASES, ...crissCrossRandomCases()];
}
