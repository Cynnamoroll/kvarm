#!/usr/bin/env node
/**
 * Builds the three-way merge conflict corpus and prints what git does with
 * each case (`git merge-tree --write-tree`). The parity suite
 * (packages/gitops/test/merge3.corpus.test.ts) builds the same corpus and
 * compares merge3 against these results.
 *
 * Usage: node scripts/conflict-corpus/generate.mjs [--out <dir>] [--json]
 *   --out   corpus directory (default: <tmpdir>/forge-conflict-corpus);
 *           rebuilt on every run, and only ever removed when it carries the
 *           corpus marker file
 *   --json  print the full result list as JSON instead of a summary
 * Writes <out>/expected.json. Requires git >= 2.40 (merge-tree --merge-base
 * with trees). Deterministic: the same cases always yield the same oids.
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { allCases, buildCorpus } from './corpus.mjs';

const { values: args } = parseArgs({
  options: { out: { type: 'string', default: join(tmpdir(), 'forge-conflict-corpus') }, json: { type: 'boolean', default: false } },
});

const results = buildCorpus(args.out, allCases());
writeFileSync(join(args.out, 'expected.json'), JSON.stringify(results, null, 2) + '\n');

if (args.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.expected.clean ? 'clean   ' : 'conflict'}  ${r.name.padEnd(36)} ${r.expected.clean ? r.expected.tree : r.expected.conflicts.join(' ')}`);
  }
  const clean = results.filter((r) => r.expected.clean).length;
  console.log(`\n${results.length} cases: ${clean} clean, ${results.length - clean} conflicting -> ${join(args.out, 'expected.json')}`);
}
