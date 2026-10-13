#!/usr/bin/env node
/**
 * Runs this repository's own gate on Kvarm: pushes a change of this
 * repository to a Kvarm repository, opens a change request, lets the
 * platform queue the jobs of the change head's `.kvarm/ci.json`, runs them
 * with `kvarm runner` on this machine and reads the verdict back through the
 * platform's checks, commit status and mergeability endpoints.
 *
 *   set -a; . ./.env.local; set +a        # KVARM_BASE_URL, KVARM_USER, KVARM_PAT (read, write, api, ci)
 *   node scripts/dogfood-ci.mjs --repo <name> [--create] [--base <rev>] [--head <rev>]
 *                               [--workdir <dir>] [--timeout-min 45]
 *
 * --base (default HEAD~1) is pushed to the Kvarm repository's main as a fast
 * forward; --head (default HEAD) goes to `dogfood/<sha12>` and becomes the
 * change. --create makes the repository (private) when it does not exist.
 * Only the history reachable from those two revisions is pushed. Git runs
 * with `-c credential.helper=` and a secret-free GIT_ASKPASS; the token is
 * passed by environment and never printed. Exit status: 0 when every check of
 * the change head succeeded and the change is mergeable, 1 otherwise, 2 on a
 * usage error.
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createLive, ROOT, sleep } from './lib/live.mjs';

let opts;
try {
  ({ values: opts } = parseArgs({
    options: {
      repo: { type: 'string' },
      create: { type: 'boolean', default: false },
      base: { type: 'string', default: 'HEAD~1' },
      head: { type: 'string', default: 'HEAD' },
      workdir: { type: 'string' },
      'timeout-min': { type: 'string', default: '45' },
    },
  }));
} catch (e) {
  console.error(`dogfood-ci: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
const BASE = process.env.KVARM_BASE_URL;
const PAT = process.env.KVARM_PAT;
const OWNER = process.env.KVARM_USER;
if (!opts.repo || !BASE || !PAT || !OWNER) {
  console.error('usage: KVARM_BASE_URL, KVARM_USER and KVARM_PAT set; node scripts/dogfood-ci.mjs --repo <name> [--create] [--base <rev>] [--head <rev>]');
  process.exit(2);
}
const deadline = Date.now() + Number(opts['timeout-min']) * 60_000;
const live = createLive({ base: BASE, pat: PAT, timeoutMs: 120_000 });
const R = `/api/v1/repos/${OWNER}/${opts.repo}`;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg) => console.log(`[${at()}] ${msg}`);

function local(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

const api = (path, init = {}) => live.http(`${R}${path}`, init);

async function main() {
  const baseSha = local(['rev-parse', '--verify', `${opts.base}^{commit}`]);
  const headSha = local(['rev-parse', '--verify', `${opts.head}^{commit}`]);
  const subject = local(['log', '-1', '--format=%s', headSha]);
  const jobs = JSON.parse(local(['show', `${headSha}:.kvarm/ci.json`])).jobs.map((j) => j.name.trim());
  log(`change ${baseSha.slice(0, 12)}..${headSha.slice(0, 12)} "${subject}"; .kvarm/ci.json at head: ${jobs.join(', ')}`);

  const repo = await live.http(R);
  if (repo.status === 404 && opts.create) {
    const made = await live.http('/api/v1/repos', { method: 'POST', json: { name: opts.repo, visibility: 'private' } });
    if (made.status !== 201) throw new Error(`POST /api/v1/repos -> ${made.status} ${made.text.slice(0, 200)}`);
    log(`created private repository ${OWNER}/${opts.repo}`);
  } else if (repo.status !== 200) {
    throw new Error(`GET ${R} -> ${repo.status} ${repo.json?.code ?? ''} (pass --create to make it)`);
  }

  const url = `${BASE}/${OWNER}/${opts.repo}.git`;
  const branch = `dogfood/${headSha.slice(0, 12)}`;
  await live.git(['push', '--quiet', url, `${baseSha}:refs/heads/main`, `${headSha}:refs/heads/${branch}`], { cwd: ROOT, network: true });
  log(`pushed main=${baseSha.slice(0, 12)} and ${branch}=${headSha.slice(0, 12)}`);

  const change = await api('/changes', { method: 'POST', json: { title: `dogfood: ${subject}`.slice(0, 200), base: 'main', head: branch, mergePolicy: 'review' } });
  if (change.status !== 201) throw new Error(`POST ${R}/changes -> ${change.status} ${change.text.slice(0, 200)}`);
  const n = change.json.number;
  log(`opened change #${n}`);

  const checksNow = async () => {
    const r = await api(`/changes/${n}/checks`);
    if (r.status !== 200) throw new Error(`GET checks -> ${r.status} ${r.json?.code ?? ''}`);
    return r.json.checks.filter((c) => c.headSha === headSha);
  };
  const terminal = (c) => c.status === 'success' || c.status === 'failure' || c.status === 'skipped';

  let checks = await checksNow();
  while (!jobs.every((j) => checks.some((c) => c.name === j))) {
    if (Date.now() > deadline) throw new Error(`CI jobs never queued: ${JSON.stringify(checks.map((c) => c.name))}`);
    await sleep(2_000);
    checks = await checksNow();
  }
  log(`platform queued ${jobs.length} CI check runs from .kvarm/ci.json: ${checks.map((c) => `${c.name}=${c.status}`).join(', ')}`);

  const workdir = opts.workdir ?? join(live.work, 'runner');
  for (let i = 0; i < jobs.length * 2 && !jobs.every((j) => checks.some((c) => c.name === j && terminal(c))); i++) {
    if (Date.now() > deadline) break;
    log(`kvarm runner --once (${i + 1})`);
    const r = spawnSync(process.execPath, ['apps/cli/bin/kvarm.js', 'runner', '--repo', `${OWNER}/${opts.repo}`, '--once', '--workdir', workdir], {
      cwd: ROOT,
      env: { ...process.env, KVARM_BASE_URL: BASE, KVARM_PAT: PAT },
      encoding: 'utf8',
      timeout: Math.max(1, deadline - Date.now()),
    });
    for (const line of `${r.stdout}`.trim().split('\n').filter(Boolean)) console.log(`    ${line}`);
    if (r.status !== 0) console.log(`    runner exit ${r.status}: ${(r.stderr ?? '').trim().slice(0, 400)}`);
    checks = await checksNow();
  }

  while (!checks.every(terminal) || !checks.some((c) => c.name === 'kvarm/guard')) {
    if (Date.now() > deadline) break;
    await sleep(2_000);
    checks = await checksNow();
  }

  console.log('\ncheck runs at the change head (GET …/changes/:n/checks):');
  for (const c of checks) {
    const ms = c.startedAt && c.finishedAt ? `${Date.parse(c.finishedAt) - Date.parse(c.startedAt)} ms` : '';
    console.log(`  ${c.name.padEnd(12)} ${String(c.status).padEnd(8)} required=${c.required} ${ms}`);
  }
  const status = await api(`/commits/${headSha}/status`);
  console.log(`commit status (GET …/commits/:sha/status): ${status.status} state=${status.json?.state}`);
  const merge = await api(`/changes/${n}/mergeability`);
  const m = merge.json ?? {};
  console.log(`mergeability (GET …/changes/:n/mergeability): ${merge.status} status=${m.status} mergeable=${m.mergeable} requiredChecks=${m.checks?.state} [${(m.checks?.required ?? []).map((c) => `${c.name}:${c.state}`).join(', ')}]`);

  const ok =
    jobs.every((j) => checks.some((c) => c.name === j && c.status === 'success')) &&
    checks.every((c) => !c.required || c.status === 'success') &&
    status.json?.state === 'success' &&
    m.mergeable === true;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: ${OWNER}/${opts.repo} change #${n} at ${headSha.slice(0, 12)} in ${at()}`);
  return ok;
}

try {
  process.exitCode = (await main()) ? 0 : 1;
} catch (e) {
  console.error(`dogfood-ci: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  rmSync(live.work, { recursive: true, force: true });
}
