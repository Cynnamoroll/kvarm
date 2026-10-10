/**
 * Live CI runner contract: queued jobs on creation/head refresh, exact-SHA
 * CLI execution, required/optional rollup and merge gates, scope denial,
 * generation-fenced lease expiry, and claim/report cost headers.
 *
 * Usage (after loading apps/platform/.dev.vars.validation):
 *   node scripts/ci-e2e.mjs [--keep] [--skip-lease]
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { keep: { type: 'boolean', default: false }, 'skip-lease': { type: 'boolean', default: false } } });
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const PAT = process.env.FORGE_PAT;
const NO_CI = process.env.FORGE_PAT_NO_CI;
const OWNER = process.env.FORGE_USER ?? 'cynthia';
if (!PAT || !NO_CI) throw new Error('FORGE_PAT and FORGE_PAT_NO_CI are required');
const repo = `m5-ci-pipeline-runner-core-${Math.floor(Date.now() / 1000)}`;
const R = `/api/v1/repos/${OWNER}/${repo}`;
const root = mkdtempSync(join(tmpdir(), 'forge-ci-e2e-'));
const work = join(root, 'work');
const askpass = join(root, 'askpass.sh');
const results = [];

writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(id, label, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} [${id}] ${label}${detail ? ` -> ${detail}` : ''}`);
}
function cost(raw) {
  return Object.fromEntries(
    (raw ?? '').split(';').filter(Boolean).map((x) => {
      const [k, v] = x.split('=');
      return [k, Number.isNaN(Number(v)) ? v : Number(v)];
    }),
  );
}
async function api(path, { method = 'GET', body, token = PAT } = {}) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, rawCost: res.headers.get('x-forge-cost'), cost: cost(res.headers.get('x-forge-cost')) };
}
function git(args) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd: work,
    env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: PAT },
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
async function waitChecks(number, predicate, ms = 60_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await api(`${R}/changes/${number}/checks`);
    if (last.status === 200 && predicate(last.json.checks)) return last.json.checks;
    await sleep(1_000);
  }
  throw new Error(`checks timeout: ${JSON.stringify(last?.json)}`);
}
function runCli() {
  const r = spawnSync(process.execPath, ['apps/cli/bin/forge.js', 'runner', '--repo', `${OWNER}/${repo}`, '--once'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, FORGE_BASE_URL: BASE, FORGE_PAT: PAT },
    encoding: 'utf8',
    timeout: 120_000,
  });
  console.log(r.stdout.trim());
  if (r.status !== 0) throw new Error(`runner failed: ${r.stderr}`);
}

let created = false;
try {
  const made = await api('/api/v1/repos', { method: 'POST', body: { name: repo, visibility: 'public' } });
  if (made.status !== 201) throw new Error(`repo create ${made.status}: ${made.text}`);
  created = true;
  mkdirSync(work);
  git(['init', '-q', '-b', 'main']);
  mkdirSync(join(work, '.forge'), { recursive: true });
  writeFileSync(
    join(work, '.forge', 'ci.json'),
    `${JSON.stringify({ jobs: [{ name: 'build', run: 'cat ci-marker.txt', required: true }, { name: 'optional', run: 'exit 1', required: false }] })}\n`,
  );
  writeFileSync(join(work, 'README.md'), 'base\n');
  writeFileSync(join(work, 'ci-marker.txt'), 'marker-at-main\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(work, 'ci-marker.txt'), 'marker-at-head\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'feature']);
  const head1 = git(['rev-parse', 'HEAD']);
  const url = `${BASE}/${OWNER}/${repo}.git`;
  git(['push', '-q', url, 'main', 'feature']);

  const change = await api(`${R}/changes`, { method: 'POST', body: { title: 'CI change', base: 'main', head: 'feature', mergePolicy: 'review' } });
  if (change.status !== 201) throw new Error(`change create ${change.status}: ${change.text}`);
  const queued = await waitChecks(1, (xs) => xs.some((x) => x.name === 'build' && x.status === 'queued') && xs.some((x) => x.name === 'optional'));
  check('VAL-CI-001', 'ci.json queued build and optional checks at exact head', queued.every((x) => x.name === 'forge/guard' || x.headSha === head1), head1);

  const denied = await api(`${R}/ci/jobs/claim`, { method: 'POST', token: NO_CI, body: { runnerId: 'no-ci' } });
  check('VAL-CI-007', 'NO_CI PAT is rejected', denied.status === 403 && denied.json?.code === 'INSUFFICIENT_SCOPE', `${denied.status} ${denied.json?.code}`);
  runCli();
  runCli();
  const done1 = await waitChecks(1, (xs) => xs.some((x) => x.name === 'build' && x.status === 'success') && xs.some((x) => x.name === 'optional' && x.status === 'failure'));
  const status1 = await api(`${R}/commits/${head1}/status`);
  check('VAL-CI-003/004/005', 'runner used exact head; required success and optional failure roll up success', status1.json?.state === 'success' && done1.find((x) => x.name === 'build')?.summary?.stdout?.includes('marker-at-head'));

  writeFileSync(join(work, 'ci-marker.txt'), 'marker-at-head-2\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'head refresh']);
  const head2 = git(['rev-parse', 'HEAD']);
  git(['push', '-q', url, 'feature']);
  const refreshed = await waitChecks(1, (xs) => xs.some((x) => x.name === 'build' && x.headSha === head2 && x.status === 'queued'));
  check('VAL-CI-002', 'head push queued a new job generation at the new SHA', refreshed.some((x) => x.name === 'build' && x.headSha === head2), head2);
  runCli();
  runCli();
  const merged = await api(`${R}/changes/1/merge`, { method: 'POST' });
  check('VAL-MERGE-007', 'optional failure does not block merge', merged.status === 200 && merged.json?.state === 'merged', `${merged.status} ${merged.json?.code ?? ''}`);

  git(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main']);
  const composedBase = git(['rev-parse', 'refs/remotes/origin/main']);
  const semanticConfig = `${JSON.stringify({ jobs: [{ name: 'semantic', run: 'test ! -f a.txt -o ! -f b.txt', required: true }] })}\n`;
  const wa = await api(`${R}/workspaces`, { method: 'POST', body: { task: 'semantic a', agent: 'ci-e2e' } });
  const wb = await api(`${R}/workspaces`, { method: 'POST', body: { task: 'semantic b', agent: 'ci-e2e' } });
  if (wa.status !== 201 || wb.status !== 201) throw new Error(`workspace create failed: ${wa.status}/${wb.status}`);
  git(['checkout', '-q', '--detach', composedBase]);
  writeFileSync(join(work, '.forge', 'ci.json'), semanticConfig);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'semantic a']);
  const aSha = git(['rev-parse', 'HEAD']);
  git(['push', '-q', url, `HEAD:${wa.json.ref}`]);
  git(['checkout', '-q', '--detach', composedBase]);
  writeFileSync(join(work, '.forge', 'ci.json'), semanticConfig);
  writeFileSync(join(work, 'b.txt'), 'b\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'semantic b']);
  const bSha = git(['rev-parse', 'HEAD']);
  git(['push', '-q', url, `HEAD:${wb.json.ref}`]);
  const observedBy = async (workspace, sha) => {
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      const read = await api(`${R}/workspaces/${workspace}`);
      if (read.json?.headSha === sha) return;
      await sleep(1_000);
    }
    throw new Error(`workspace ${workspace} did not observe ${sha}`);
  };
  await Promise.all([observedBy(wa.json.id, aSha), observedBy(wb.json.id, bSha)]);
  const composed = await api(`${R}/candidates/compose`, {
    method: 'POST',
    body: { base: 'main', workspaces: [wa.json.id, wb.json.id], mergePolicy: 'review' },
  });
  if (composed.status !== 201) throw new Error(`compose ${composed.status}: ${composed.text}`);
  runCli();
  const semantic = await api(`${R}/compositions/${composed.json.id}`);
  const blocked = await api(`${R}/changes/${composed.json.changeSet}/merge`, { method: 'POST' });
  check(
    'VAL-COMPOSE-003',
    'clean composed tree records a semantic CI conflict and merge names the exact-tree failure',
    semantic.json?.conflict?.kind === 'semantic' &&
      semantic.json.conflict.treeSha === composed.json.treeSha &&
      semantic.json.conflict.checks?.includes('semantic') &&
      blocked.status === 409 &&
      blocked.json?.code === 'REQUIRED_CHECKS_FAILED' &&
      /semantic/.test(blocked.json?.error ?? ''),
    `${semantic.status} ${JSON.stringify(semantic.json?.conflict)}; ${blocked.status} ${blocked.json?.code}`,
  );

  git(['checkout', '-q', 'main']);
  git(['checkout', '-q', '-b', 'lease']);
  writeFileSync(join(work, '.forge', 'ci.json'), `${JSON.stringify({ jobs: [{ name: 'lease', run: 'echo lease', required: true }] })}\n`);
  writeFileSync(join(work, 'lease.txt'), 'lease\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'lease']);
  git(['push', '-q', url, 'lease']);
  const leaseChange = await api(`${R}/changes`, { method: 'POST', body: { title: 'Lease', base: 'main', head: 'lease', mergePolicy: 'draft' } });
  if (leaseChange.status !== 201) throw new Error(`lease change ${leaseChange.status}: ${leaseChange.text}`);
  await waitChecks(leaseChange.json.number, (xs) => xs.some((x) => x.name === 'lease' && x.status === 'queued'));
  const first = await api(`${R}/ci/jobs/claim`, { method: 'POST', body: { runnerId: 'lease-a' } });
  check('VAL-COST-012', 'claim cost is d1<=2, do=0, q=0', first.cost.d1 <= 2 && first.cost.do === 0 && first.cost.q === 0, first.rawCost);
  if (!values['skip-lease']) {
    await sleep(121_000);
    const second = await api(`${R}/ci/jobs/claim`, { method: 'POST', body: { runnerId: 'lease-b' } });
    check('VAL-CI-006', 'expired lease re-dispenses the same job with a newer generation', second.json?.job?.id === first.json?.job?.id && second.json.job.generation > first.json.job.generation);
    const report = await api(`${R}/ci/jobs/${second.json.job.id}/report`, {
      method: 'POST',
      body: { runnerId: 'lease-b', generation: second.json.job.generation, conclusion: 'success', summary: { output: 'lease' } },
    });
    check('VAL-COST-012', 'report cost is d1<=2, do=0, q=0', report.cost.d1 <= 2 && report.cost.do === 0 && report.cost.q === 0, report.rawCost);
  }
} finally {
  if (created && !values.keep) {
    const deleted = await api(R, { method: 'DELETE' });
    check('cleanup', 'scratch repo deleted', deleted.status === 200, String(deleted.status));
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (results.some((x) => !x)) process.exitCode = 1;
