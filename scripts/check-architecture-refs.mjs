#!/usr/bin/env node
/**
 * Architecture reference audit: every numbered citation in a repository text
 * file ("architecture §11.4", "§0.1/§0.3", "invariant 5", or "<doc>.md §N")
 * must resolve to a numbered heading of docs/architecture.md, or of the
 * repository document it names.
 *
 *   node scripts/check-architecture-refs.mjs          summary per section, unresolved citations
 *   node scripts/check-architecture-refs.mjs --json   machine-readable report
 *
 * Exit status: 0 when every citation resolves, 1 otherwise.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkCitations } from './lib/architecture-refs.mjs';

const { values: opts } = parseArgs({ options: { json: { type: 'boolean', default: false } } });

const TEXT_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs', '.sql', '.md', '.jsonc', '.yml', '.yaml', '.sh']);
// The audit's own tests hold deliberately dangling sample citations.
const EXCLUDED = new Set(['scripts/test/architectureRefs.test.ts']);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Tracked files plus new, not-ignored ones, so the audit also holds before a commit.
const candidates = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter((p) => p !== '');

const files = [...new Set(candidates)]
  .filter((p) => TEXT_EXTENSIONS.has(extname(p)) && !EXCLUDED.has(p) && existsSync(resolve(repoRoot, p)))
  .map((path) => ({ path, text: readFileSync(resolve(repoRoot, path), 'utf8') }));
const docs = new Map(files.filter((f) => f.path.endsWith('.md')).map((f) => [f.path, f.text]));

const { resolved, unresolved } = checkCitations(files, docs);
const bySection = new Map();
for (const c of resolved) {
  const key = `${c.target} §${c.section}`;
  bySection.set(key, (bySection.get(key) ?? 0) + 1);
}

if (opts.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        citations: resolved.length + unresolved.length,
        resolved: resolved.length,
        bySection: Object.fromEntries([...bySection].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))),
        unresolved,
      },
      null,
      2,
    )}\n`,
  );
} else {
  for (const [key, n] of [...bySection].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))) {
    console.log(`${String(n).padStart(3)}  ${key}`);
  }
  for (const u of unresolved) console.log(`UNRESOLVED ${u.path}:${u.line}  ${u.text}  (${u.reason}: ${u.target} §${u.section})`);
  console.log(`${resolved.length + unresolved.length} citations, ${resolved.length} resolved, ${unresolved.length} unresolved`);
}
process.exit(unresolved.length === 0 ? 0 : 1);
