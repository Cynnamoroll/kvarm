#!/usr/bin/env node
/**
 * Builds the validation contract's risk-fixture repo on the live worker and
 * (unless --no-verify) checks VAL-RISK-001..007 plus a first-ever cold
 * compare against the VAL-COST-005 budget.
 *
 *   main       base: every file present
 *   risky      one commit, 10 changed paths, one trigger per risk tag:
 *              .forge/ci.json (ci-config), deleted test/app.test.ts
 *              (test-deletion), package-lock.json (lockfile), package.json
 *              adds left-pad (new-dependency), x.md -> y.md and whitespace-only
 *              ws.txt (mechanical), src/billing.ts (semantic),
 *              src/generated/api.gen.ts (generated), src/auth/session.ts
 *              (security-sensitive), new big.ts with 5,000 lines (large)
 *   docs-only  one prose change to README.md
 *
 * Every run creates its own repo and stamps README.md with the run id, so
 * the tree pairs (and their compare/risk cache entries) are new each run.
 * The repo must not exist yet and must be named
 * m3-risk-engine-<purpose>-<timestamp>; an existing repo is rejected before any
 * push and only a repo created by this run is ever deleted (failure
 * included, see scripts/lib/fixture-repo.mjs).
 *
 * As cynthia (FORGE_PAT, instance admin). Tokens are read from env var
 * NAMES only and never printed; git runs with `-c credential.helper=` and a
 * secret-free GIT_ASKPASS helper.
 *
 * Usage: node scripts/risk-fixture.mjs [--repo=<name>] [--keep] [--no-verify]
 *   --repo      create this new repo name (default m3-risk-engine-fixture-<ts>)
 *   --keep      keep the repo (default: delete it at the end)
 *   --no-verify only build and push the fixture
 * Exit 0 when every check held, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const KEEP = process.argv.includes('--keep');
const VERIFY = !process.argv.includes('--no-verify');
if (!process.env.FORGE_PAT) throw new Error('env FORGE_PAT is not set');
const OWNER = 'cynthia';
const RUN = String(Date.now());
const REPO = arg('repo') ?? `m3-risk-engine-fixture-${RUN}`;

const results = [];
function check(label, ok, detail = '') {
  results.push({ ok: !!ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function costOf(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = k === 'cache' ? v : Number(v);
  }
  return out;
}

async function http(path, { method = 'GET', json, auth = true } = {}) {
  const headers = auth ? { Authorization: `Bearer ${process.env.FORGE_PAT}` } : {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON
  }
  const header = res.headers.get('x-forge-cost');
  return { status: res.status, text, body, header, cost: costOf(header), cache: res.headers.get('x-forge-cache'), ms: Math.round(performance.now() - started) };
}

const api = (rest) => `/api/v1/repos/${OWNER}/${REPO}/${rest}`;
const show = (r) => `${r.status} ${r.ms}ms x-forge-cache=${r.cache} ${r.header}`;

const work = mkdtempSync(join(tmpdir(), 'risk-fixture-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd, auth = false) {
  const date = '2026-10-01T00:00:00Z';
  const env = {
    ...process.env,
    GIT_ASKPASS: askpass,
    GIT_TERMINAL_PROMPT: '0',
    FORGE_E2E_TOKEN: auth ? process.env.FORGE_PAT : '',
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() };
}

function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir).out;
}

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const pkg = (deps) => `${JSON.stringify({ name: 'risk-fixture', version: '1.0.0', dependencies: deps }, null, 2)}\n`;
const BASE_FILES = {
  '.forge/ci.json': '{"jobs":[{"name":"test","run":"npm test"}]}\n',
  'test/app.test.ts': "import { it } from 'vitest';\nimport { total } from '../src/billing';\n\nit('adds', () => {\n  if (total(1, 2) !== 3) throw new Error('bad');\n});\n",
  'package-lock.json': `${JSON.stringify({ name: 'risk-fixture', lockfileVersion: 3, packages: { '': { name: 'risk-fixture' } } }, null, 2)}\n`,
  'package.json': pkg({ hono: '^4.6.0' }),
  'x.md': '# Notes\n\nMoved without changes.\n',
  'ws.txt': 'alpha beta\ngamma delta\n',
  'src/billing.ts': 'export function total(a: number, b: number): number {\n  return a + b;\n}\n',
  'src/generated/api.gen.ts': '// Code generated by api-gen. DO NOT EDIT.\nexport const API_VERSION = 1;\n',
  'src/auth/session.ts': 'export const SESSION_TTL_SECONDS = 3600;\n',
  'README.md': `# Risk fixture\n\nThis repository exercises the risk tags.\n\nRun ${RUN}.\n`,
};
const RISKY_CHANGES = {
  '.forge/ci.json': '{"jobs":[{"name":"test","run":"npm test || true"}]}\n',
  'package-lock.json': `${JSON.stringify(
    { name: 'risk-fixture', lockfileVersion: 3, packages: { '': { name: 'risk-fixture' }, 'node_modules/left-pad': { version: '1.3.0' } } },
    null,
    2,
  )}\n`,
  'package.json': pkg({ hono: '^4.6.0', 'left-pad': '1.3.0' }),
  'ws.txt': 'alpha  beta\n\tgamma delta\n',
  'src/billing.ts': 'export function total(a: number, b: number): number {\n  return a - b;\n}\n',
  'src/generated/api.gen.ts': '// Code generated by api-gen. DO NOT EDIT.\nexport const API_VERSION = 2;\n',
  'src/auth/session.ts': 'export const SESSION_TTL_SECONDS = 60;\n',
  'big.ts': `${Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\n`,
};
const EXPECTED_TAGS = {
  '.forge/ci.json': 'ci-config',
  'test/app.test.ts': 'test-deletion',
  'package-lock.json': 'lockfile',
  'package.json': 'new-dependency',
  'y.md': 'mechanical',
  'ws.txt': 'mechanical',
  'src/billing.ts': 'semantic',
  'src/generated/api.gen.ts': 'generated',
  'src/auth/session.ts': 'security-sensitive',
  'big.ts': 'large',
};

async function build() {
  const dir = join(work, REPO);
  git(['init', '-q', '-b', 'main', dir], work);
  git(['remote', 'add', 'origin', `${BASE}/${OWNER}/${REPO}.git`], dir);
  write(dir, BASE_FILES);
  const main = commitAll(dir, 'risk fixture base');

  git(['checkout', '-q', '-b', 'risky'], dir);
  rmSync(join(dir, 'test/app.test.ts'));
  git(['mv', 'x.md', 'y.md'], dir);
  write(dir, RISKY_CHANGES);
  const risky = commitAll(dir, 'risky change');

  git(['checkout', '-q', 'main'], dir);
  git(['checkout', '-q', '-b', 'docs-only'], dir);
  write(dir, { 'README.md': `# Risk fixture\n\nThis repository exercises the risk tags and the change rating.\n\nRun ${RUN}.\n` });
  const docs = commitAll(dir, 'docs only');

  const nameStatus = git(['diff', '--name-status', '-M', 'main', 'risky'], dir).out;
  console.log(`# main ${main}\n# risky ${risky}\n# docs-only ${docs}\n# git diff --name-status -M main risky:\n${nameStatus.replace(/^/gm, '#   ')}`);
  let pushed;
  for (let i = 0; i < 10; i++) {
    pushed = git(['push', '-q', 'origin', 'main', 'risky', 'docs-only'], dir, true);
    if (pushed.code === 0 || !/503|warming/i.test(pushed.err)) break;
    await sleep(3000);
  }
  check('push main, risky, docs-only through the git proxy', pushed.code === 0, pushed.err.slice(0, 300));
  return { dir, main, risky, docs, changedPaths: nameStatus.split('\n').filter(Boolean).length };
}

/** Run after the first-ever compare: an upload-pack read would warm the read token first. */
function checkRemote(fx) {
  const remote = git(['ls-remote', 'origin', 'refs/heads/risky'], fx.dir, true).out.split('\t')[0];
  check('ls-remote risky equals the local commit', remote === fx.risky, remote);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const riskOf = (r) => JSON.stringify({ files: (r.body?.files ?? []).map((f) => [f.path, f.risk]), rating: r.body?.rating }, null, 0);

async function verify(fx) {
  // First request of all, straight after the push: commit, line-count and
  // read-token entries are all cold (the push only warmed the write token).
  const first = await http(api('compare/main...risky?nocache=1'));
  const b0 = first.body ?? {};
  check(`VAL-COST-005 first-ever cold compare main...risky: treeReads=${b0.treeReads} blobReads=${b0.blobReads} ${show(first)}`,
    first.status === 200 && first.cache === 'bypass' && Number.isInteger(b0.treeReads) && b0.treeReads >= 1 &&
    Number.isInteger(b0.blobReads) && b0.blobReads >= 0 && first.cost.art <= b0.treeReads + b0.blobReads + 3 && first.cost.d1 <= 2,
    `art ${first.cost.art} <= ${b0.treeReads} + ${b0.blobReads} + 3; d1 ${first.cost.d1} <= 2`);

  checkRemote(fx);

  const r = await http(api('compare/main...risky'));
  const files = r.body?.files ?? [];
  check(`risky has >= 10 changed paths (git: ${fx.changedPaths}) ${show(r)}`, r.status === 200 && files.length >= 10 && files.length === fx.changedPaths);
  check('VAL-RISK-001 every file has risk {score: integer 0..100, tags: string[]}',
    files.length > 0 && files.every((f) => Number.isInteger(f.risk?.score) && f.risk.score >= 0 && f.risk.score <= 100 &&
      Array.isArray(f.risk.tags) && f.risk.tags.every((t) => typeof t === 'string')));
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  for (const [path, tag] of Object.entries(EXPECTED_TAGS)) {
    check(`VAL-RISK-002 ${path} -> ${tag}`, byPath[path]?.risk?.tags?.includes(tag), JSON.stringify(byPath[path]?.risk));
  }

  const ranked = await http(api('compare/main...risky?order=risk'));
  const want = [...files].sort((a, b) => b.risk.score - a.risk.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => f.path);
  const got = (ranked.body?.files ?? []).map((f) => f.path);
  check(`VAL-RISK-003 ?order=risk equals (-score, path) re-sort ${show(ranked)}`, ranked.status === 200 && isDeepStrictEqual(got, want),
    got.map((p) => `${p}:${byPath[p]?.risk?.score}`).join(' '));

  const rating = r.body?.rating ?? {};
  check('VAL-RISK-004 rating {score integer 0..100, level low|medium|high, reasons non-empty}',
    Number.isInteger(rating.score) && rating.score >= 0 && rating.score <= 100 && ['low', 'medium', 'high'].includes(rating.level) &&
      Array.isArray(rating.reasons) && rating.reasons.length > 0 && rating.reasons.every((x) => typeof x === 'string'),
    JSON.stringify(rating));
  const docs = await http(api('compare/main...docs-only'));
  check(`VAL-RISK-005 docs-only rates low below risky ${show(docs)}`, docs.status === 200 && docs.body?.rating?.level === 'low' &&
    docs.body.rating.score < rating.score, `docs ${JSON.stringify(docs.body?.rating)} vs risky score ${rating.score}`);
  check('VAL-RISK-006 risky (CI config + test deletion) rates high with reasons', rating.level === 'high' && rating.reasons?.length >= 1,
    JSON.stringify(rating.reasons));

  const n1 = await http(api('compare/main...risky?nocache=1'));
  const n2 = await http(api('compare/main...risky?nocache=1'));
  check(`VAL-RISK-007 two nocache computations give identical risk JSON (${n1.cache}, ${n2.cache})`,
    n1.cache === 'bypass' && n2.cache === 'bypass' && riskOf(n1) === riskOf(n2) && riskOf(n1) === riskOf(r));

  const warm = await http(api('compare/main...risky'));
  check(`warm compare is a cache hit within budget ${show(warm)}`, warm.cache === 'hit' && warm.cost.d1 <= 1 && warm.cost.art === 0 &&
    warm.cost.do === 0 && warm.cost.sub === 0 && riskOf(warm) === riskOf(r));
  const anonRanked = await http(api(`compare/${fx.main}...${fx.risky}?order=risk`), { auth: false });
  check(`anonymous sha-addressed ?order=risk hits the tree-pair entry ${show(anonRanked)}`, anonRanked.cache === 'hit' &&
    isDeepStrictEqual((anonRanked.body?.files ?? []).map((f) => f.path), want));
}

try {
  console.log(`# ${new Date().toISOString()} base ${BASE}; repo ${OWNER}/${REPO}; run ${RUN}`);
  const run = await withFixtureRepo({ owner: OWNER, repo: REPO, prefix: 'm3-risk-engine', http, keep: KEEP, log: console.log }, async () => {
    check(`create public ${OWNER}/${REPO} (new, created by this run)`, true);
    try {
      const fx = await build();
      if (VERIFY) await verify(fx);
      else checkRemote(fx);
    } catch (err) {
      check(`driver error: ${err?.stack ?? err}`, false);
    }
  });
  if (!run.ok) check(`refusing to run: ${run.reason}`, false);
} catch (err) {
  check(`driver error: ${err?.stack ?? err}`, false);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
