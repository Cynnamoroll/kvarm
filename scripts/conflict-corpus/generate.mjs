#!/usr/bin/env node
/**
 * Builds the three-way merge conflict corpus and prints what git does with
 * each case (`git merge-tree --write-tree`). The parity suites
 * (packages/gitops/test/merge3.corpus.test.ts and crisscross.corpus.test.ts)
 * build the same corpora and compare merge3 against these results.
 *
 * Usage: node scripts/conflict-corpus/generate.mjs [--out <dir>] [--json]
 *   --out   corpus directory (default: <tmpdir>/kvarm-conflict-corpus);
 *           rebuilt on every run, and only ever removed when it carries the
 *           corpus marker file
 *   --json  print the tree cases' result list as JSON instead of a summary
 *           (the criss-cross results are in their expected.json)
 * Writes <out>/expected.json (tree cases) and
 * <out>/criss-cross/expected.json (criss-cross commit graphs, merged by git
 * through a virtual merge base). Requires git >= 2.40 (merge-tree
 * --merge-base with trees). Deterministic: the same cases always yield the
 * same oids.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { allCases, allCrissCrossCases, buildCorpus, buildCrissCrossCorpus } from './corpus.mjs';

const { values: args } = parseArgs({
  options: { out: { type: 'string', default: join(tmpdir(), 'kvarm-conflict-corpus') }, json: { type: 'boolean', default: false } },
});

const results = buildCorpus(args.out, allCases());
writeFileSync(join(args.out, 'expected.json'), JSON.stringify(results, null, 2) + '\n');
const ccDir = join(args.out, 'criss-cross');
const crissCross = buildCrissCrossCorpus(ccDir, allCrissCrossCases());
writeFileSync(join(ccDir, 'expected.json'), JSON.stringify(crissCross, null, 2) + '\n');

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of [...results, ...crissCross]) {
    console.log(`${r.expected.clean ? 'clean   ' : 'conflict'}  ${r.name.padEnd(36)} ${r.expected.clean ? r.expected.tree : r.expected.conflicts.join(' ')}`);
  }
  const summary = (rs, where) => `${rs.length} cases: ${rs.filter((r) => r.expected.clean).length} clean, ${rs.filter((r) => !r.expected.clean).length} conflicting -> ${where}`;
  console.log(`\n${summary(results, join(args.out, 'expected.json'))}`);
  console.log(`criss-cross ${summary(crissCross, join(ccDir, 'expected.json'))}`);
}
