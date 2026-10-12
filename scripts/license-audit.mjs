#!/usr/bin/env node
/**
 * Dependency license audit: renders docs/licenses.md from package-lock.json
 * (every resolved package with its declared license, and the non-permissive
 * or unknown ones listed explicitly).
 *
 *   node scripts/license-audit.mjs           write docs/licenses.md
 *   node scripts/license-audit.mjs --check   exit 1 when docs/licenses.md is stale
 *   node scripts/license-audit.mjs --stdout  print the report instead of writing it
 *
 * Exit status: 0 on success, 1 when --check finds a stale report.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { collectDependencies, renderLicenseReport } from './lib/license-audit.mjs';

const { values: opts } = parseArgs({
  options: {
    check: { type: 'boolean', default: false },
    stdout: { type: 'boolean', default: false },
  },
});

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = resolve(repoRoot, 'package-lock.json');
const reportPath = resolve(repoRoot, 'docs/licenses.md');

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
if (lock.lockfileVersion !== 3) {
  console.error(`license-audit: package-lock.json lockfileVersion ${lock.lockfileVersion} is not supported (expected 3)`);
  process.exit(1);
}
const report = renderLicenseReport(lock);
const deps = collectDependencies(lock);
const flagged = deps.filter((d) => d.class !== 'permissive');
const runtimeFlagged = flagged.filter((d) => d.scope !== 'development');
const summary = `${deps.length} packages; ${flagged.length} non-permissive or unknown (${runtimeFlagged.length} at runtime)`;

if (opts.stdout) {
  process.stdout.write(report);
} else if (opts.check) {
  const current = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '';
  if (current !== report) {
    console.error('license-audit: docs/licenses.md is stale; run node scripts/license-audit.mjs');
    process.exit(1);
  }
  console.log(`license-audit: docs/licenses.md is current (${summary})`);
} else {
  writeFileSync(reportPath, report);
  console.log(`license-audit: wrote docs/licenses.md (${summary})`);
}
for (const d of runtimeFlagged) console.log(`  runtime ${d.class}: ${d.name}@${d.version} (${d.license})`);
