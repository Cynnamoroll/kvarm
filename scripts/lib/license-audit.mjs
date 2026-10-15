/**
 * Dependency license audit over an npm v3 lockfile: SPDX expression
 * classification, the package inventory and the docs/licenses.md report.
 * Pure: the entrypoint (scripts/license-audit.mjs) does the file I/O.
 *
 * The lockfile lists every package npm resolved for the repository on every
 * platform (including optional platform binaries that are not installed
 * locally), so the report does not depend on the machine that renders it.
 */

const PERMISSIVE = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSL-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);
const WEAK_COPYLEFT = [/^LGPL-/, /^MPL-/, /^EPL-/, /^CDDL-/, /^CPL-/, /^MS-RL$/];
const COPYLEFT = [/^GPL-/, /^AGPL-/, /^SSPL-/, /^OSL-/, /^EUPL-/, /^CC-BY-SA-/];
const RESTRICTIVE = [/^BUSL-/, /^CC-BY-NC/, /^CC-BY-ND/, /^Commons-Clause$/, /^Elastic-/, /^PolyForm-/];

/** Most to least permissive; OR takes the lowest rank, AND the highest. */
const RANK = ['permissive', 'weak-copyleft', 'copyleft', 'restrictive', 'unknown'];

function classifyId(raw) {
  const id = raw.replace(/\+$/, '');
  if (PERMISSIVE.has(id)) return 'permissive';
  if (WEAK_COPYLEFT.some((re) => re.test(id))) return 'weak-copyleft';
  if (COPYLEFT.some((re) => re.test(id))) return 'copyleft';
  if (RESTRICTIVE.some((re) => re.test(id))) return 'restrictive';
  return 'unknown';
}

/**
 * Classifies an SPDX license expression as `permissive`, `weak-copyleft`,
 * `copyleft`, `restrictive` or `unknown` (missing, UNLICENSED, free text or
 * an unparsable expression).
 * @param {string | undefined | null} expression
 */
export function classifyLicense(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') return 'unknown';
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const worst = (a, b) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);
  const best = (a, b) => (RANK.indexOf(a) <= RANK.indexOf(b) ? a : b);

  function factor() {
    const t = tokens[pos++];
    if (t === undefined || t === ')') throw new Error('unexpected end');
    if (t === '(') {
      const inner = orExpr();
      if (tokens[pos++] !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (/^(AND|OR|WITH)$/i.test(t)) throw new Error('operator without operand');
    if (peek()?.toUpperCase() === 'WITH') pos += 2;
    return classifyId(t);
  }
  function andExpr() {
    let c = factor();
    while (peek()?.toUpperCase() === 'AND') {
      pos++;
      c = worst(c, factor());
    }
    return c;
  }
  function orExpr() {
    let c = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      pos++;
      c = best(c, andExpr());
    }
    return c;
  }

  try {
    const c = orExpr();
    return pos === tokens.length ? c : 'unknown';
  } catch {
    return 'unknown';
  }
}

function licenseOf(entry) {
  const l = entry.license;
  if (typeof l === 'string' && l.trim() !== '') return l.trim();
  if (l && typeof l === 'object' && typeof l.type === 'string') return l.type;
  if (Array.isArray(entry.licenses)) {
    const types = entry.licenses.map((x) => (typeof x === 'string' ? x : x?.type)).filter((x) => typeof x === 'string' && x !== '');
    if (types.length > 0) return types.join(' OR ');
  }
  return 'UNKNOWN';
}

function scopeOf(entry) {
  if (entry.dev) return 'development';
  if (entry.optional || entry.devOptional) return 'runtime (optional)';
  return 'runtime';
}

const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every package installed from the registry, one entry per lockfile path
 * (a package nested at two versions appears twice), sorted by name then path.
 * Workspace links and the root are excluded; see collectWorkspaces.
 */
export function collectDependencies(lock) {
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || entry.link || !path.includes('node_modules/')) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const license = licenseOf(entry);
    out.push({ name, version: entry.version ?? '', license, scope: scopeOf(entry), class: classifyLicense(license), path });
  }
  return out.sort((a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.path, b.path));
}

/** The repository's own workspace packages; one without a license field is covered by the root license. */
export function collectWorkspaces(lock) {
  const rootLicense = licenseOf(lock.packages?.[''] ?? {});
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '' || path.includes('node_modules/')) continue;
    out.push({ name: entry.name ?? path, path, license: entry.license ? licenseOf(entry) : rootLicense });
  }
  return out.sort((a, b) => byCodePoint(a.name, b.name));
}

/** Direct registry dependencies declared by each workspace package, resolved through the lockfile. */
function directRuntimeDependencies(lock) {
  const packages = lock.packages ?? {};
  const rows = [];
  for (const ws of collectWorkspaces(lock)) {
    const declared = Object.keys(packages[ws.path]?.dependencies ?? {}).sort(byCodePoint);
    for (const dep of declared) {
      const entry = packages[`${ws.path}/node_modules/${dep}`] ?? packages[`node_modules/${dep}`];
      if (!entry || entry.link) continue;
      const license = licenseOf(entry);
      rows.push({ workspace: ws.name, name: dep, version: entry.version ?? '', license, class: classifyLicense(license) });
    }
  }
  return rows;
}

const cell = (s) => String(s).replaceAll('|', '\\|');
const row = (cells) => `| ${cells.map(cell).join(' | ')} |`;

/** The committed docs/licenses.md body. Deterministic for a given lockfile. */
export function renderLicenseReport(lock) {
  const deps = collectDependencies(lock);
  const workspaces = collectWorkspaces(lock);
  const flagged = deps.filter((d) => d.class !== 'permissive');
  const runtimeFlagged = flagged.filter((d) => d.scope !== 'development');
  const runtimeCount = deps.filter((d) => d.scope !== 'development').length;
  const rootLicense = licenseOf(lock.packages?.[''] ?? {});

  const lines = [
    '# Dependency licenses',
    '',
    'Generated by `node scripts/license-audit.mjs` from `package-lock.json`. The lockfile lists every package npm resolved for this repository on every platform, including optional platform binaries that are not installed on a given machine. Regenerate after changing dependencies; `node scripts/license-audit.mjs --check` exits non-zero when this file is stale.',
    '',
    `Kvarm itself is licensed under ${rootLicense} (see \`LICENSE\`). This report is an inventory of declared licenses, not legal advice or clearance.`,
    '',
    'Classes: `permissive` (MIT, ISC, Apache-2.0, BSD, 0BSD, CC0-1.0, PSF-2.0 and similar), `weak-copyleft` (LGPL, MPL, EPL, CDDL), `copyleft` (GPL, AGPL, SSPL, CC-BY-SA), `restrictive` (source-available or non-commercial) and `unknown` (no declared license or an unrecognized one). An `OR` expression takes its most permissive choice, an `AND` expression its most restrictive part. Scope `development` means the package is reachable only from devDependencies (build, test and deploy tooling) and is not part of the deployed Worker or the CLI at runtime.',
    '',
    '## Summary',
    '',
    `${deps.length} packages: ${runtimeCount} runtime, ${deps.length - runtimeCount} development.`,
    '',
    row(['license', 'class', 'runtime', 'development', 'total']),
    '| --- | --- | ---: | ---: | ---: |',
  ];
  const tally = new Map();
  for (const d of deps) {
    const t = tally.get(d.license) ?? { class: d.class, runtime: 0, development: 0 };
    if (d.scope === 'development') t.development++;
    else t.runtime++;
    tally.set(d.license, t);
  }
  for (const [license, t] of [...tally].sort((a, b) => b[1].runtime + b[1].development - (a[1].runtime + a[1].development) || byCodePoint(a[0], b[0]))) {
    lines.push(row([license, t.class, t.runtime, t.development, t.runtime + t.development]));
  }

  lines.push('', '## Non-permissive or unknown licenses', '');
  if (flagged.length === 0) {
    lines.push('Non-permissive or unknown licenses: none.');
  } else {
    lines.push(
      runtimeFlagged.length === 0
        ? 'Runtime dependencies with a non-permissive or unknown license: none.'
        : `Runtime dependencies with a non-permissive or unknown license: ${runtimeFlagged.length} (listed below with scope runtime).`,
      '',
      `${flagged.length} package(s) declare a license that is not permissive or not recognized:`,
      '',
      row(['package', 'version', 'license', 'class', 'scope', 'lockfile path']),
      '| --- | --- | --- | --- | --- | --- |',
      ...flagged.map((d) => row([d.name, d.version, d.license, d.class, d.scope, d.path])),
    );
  }

  lines.push(
    '',
    '## Workspace packages',
    '',
    'The repository\'s own packages. One without a `license` field is covered by the root license.',
    '',
    row(['package', 'path', 'license']),
    '| --- | --- | --- |',
    ...workspaces.map((w) => row([w.name, w.path, w.license])),
  );

  const direct = directRuntimeDependencies(lock);
  if (direct.length > 0) {
    lines.push(
      '',
      '## Direct runtime dependencies of the workspace packages',
      '',
      row(['workspace', 'dependency', 'version', 'license', 'class']),
      '| --- | --- | --- | --- | --- |',
      ...direct.map((d) => row([d.workspace, d.name, d.version, d.license, d.class])),
    );
  }

  // Kept by hand: dependencies that live outside package-lock.json. The Go
  // module has no npm entry, but it ships in the built CLI the same way.
  lines.push(
    '',
    '## Non-npm dependencies',
    '',
    row(['workspace', 'dependency', 'version', 'license', 'class']),
    '| --- | --- | --- | --- | --- |',
    ...NON_NPM_DEPENDENCIES.map((d) => row([d.workspace, d.name, d.version, d.license, d.class])),
  );

  lines.push(
    '',
    '## All packages',
    '',
    row(['package', 'version', 'license', 'scope', 'class']),
    '| --- | --- | --- | --- | --- |',
    ...deps.map((d) => row([d.name, d.version, d.license, d.scope, d.class])),
    '',
  );
  return lines.join('\n');
}

/** Dependencies of workspaces that no lockfile describes (the Go CLI's module). */
const NON_NPM_DEPENDENCIES = [
  { workspace: '@kvarm/cli (Go, apps/cli)', name: 'github.com/klauspost/compress', version: 'v1.20.3', license: 'BSD-3-Clause', class: 'permissive' },
];
