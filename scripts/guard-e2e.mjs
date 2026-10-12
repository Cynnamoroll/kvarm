#!/usr/bin/env node
/**
 * Live driver for the change guard and its checks-gate (m5-guard-check):
 * VAL-GUARD-001..007, VAL-MERGE-006, VAL-QUEUE-003..005 and VAL-COST-011.
 * (VAL-CAND-005 runs in `candidates-e2e.mjs --only gate`, VAL-CONFLICT-005 in
 * `conflict-resolution-e2e.mjs --only policy`.)
 *
 * Every scenario runs in a fresh public repo owned by KVARM_USER, named
 * `m5-guard-check-<purpose>-<timestamp>`, seeded with real git pushes and
 * deleted afterwards (unless --keep). No repo carries a `.kvarm/ci.json`
 * except `gaming`, whose base needs one to edit:
 *   refresh  clean README change: one kvarm/guard run at the head; a push to
 *            the head branch adds a second run at the new head; the commit
 *            status shows only the guard (VAL-GUARD-001/006)
 *   secret   planted AWS key + fake kvarm_pat_ token: guard failure with
 *            {path, line, rule, message} findings, both values absent from
 *            every captured response; explicit merge 409 naming kvarm/guard,
 *            main unmoved, change open (VAL-GUARD-002/007)
 *   gaming   `npm test` -> `npm test || true` in .kvarm/ci.json (VAL-GUARD-003)
 *   testdel  tests/app.test.js deleted (VAL-GUARD-004)
 *   dep      "lodahs" added to package.json (VAL-GUARD-005)
 *   auto     clean auto change merges with no merge call; an auto change
 *            whose guard failed merges after a push removes the secret (VAL-MERGE-006)
 *   pair     two clean auto changes created concurrently both land, linear
 *            first-parent history, the second on the first (VAL-QUEUE-003/004)
 *   eject    a failing and a clean change enqueued together (auto and review
 *            variants): the failing one ejected CHECKS_FAILED, the clean one
 *            merged, a third merges afterwards (VAL-QUEUE-005)
 *   cost     change detail d1 equal with 1 vs 6 check runs (VAL-COST-011)
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . ./.env.local; set +a
 *   node scripts/guard-e2e.mjs [--keep] [--only refresh,secret,gaming,testdel,dep,auto,pair,eject,cost]
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper; commits use the configured git identity.
 * Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } } });
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm5-guard-check';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

// Fake planted values (the AWS documentation example key and a made-up token), assembled so this file holds neither.
const AWS_FAKE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
const KVARM_FAKE = ['kvarm', 'pat', '0123456789abcdef'.repeat(4)].join('_');

function die(msg) {
  console.error(`guard-e2e: ${msg}`);
  process.exit(2);
}

function check(id, label, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(path, { method = 'GET', json, token = PAT, label } = {}) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  for (let i = 0; ; i++) {
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    if (res.status === 429 && i < 3) {
      await sleep(Number(res.headers.get('retry-after') ?? 5) * 1000);
      continue;
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const cost = res.headers.get('x-kvarm-cost');
    if (label) costs.push({ label, status: res.status, cost });
    return { status: res.status, text, json: body, cost, c: parseCost(cost) };
  }
}

function parseCost(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) out[k.trim()] = Number.isNaN(Number(v)) ? v : Number(v);
  }
  return out;
}

const work = mkdtempSync(join(tmpdir(), 'guard-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: PAT };

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function mustGit(args, cwd) {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}

async function pushRetry(dir, url, refspecs) {
  for (let i = 0; i < 8; i++) {
    const r = git(['push', '-q', url, ...refspecs], dir);
    if (r.code === 0) return;
    await sleep(3000);
  }
  throw new Error(`push ${refspecs.join(' ')} kept failing`);
}

function writeFiles(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    if (content === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitAll(dir, msg) {
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

function lsRemote(url, ref) {
  const r = git(['ls-remote', url, ref], work);
  return r.out.split('\n').find((l) => l.endsWith(`\t${ref}`))?.split('\t')[0] ?? null;
}

const repoPath = (repo) => `/api/v1/repos/${OWNER}/${repo}`;
const gitUrl = (repo) => `${BASE}/${OWNER}/${repo}.git`;

/** main with `baseFiles`; each branch is one commit off main applying its files (null deletes). */
async function seed(repo, baseFiles, branches) {
  const dir = join(work, repo);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  writeFiles(dir, { 'README.md': `# ${repo}\n\nA guard fixture.\n`, ...baseFiles });
  const base = commitAll(dir, 'base');
  const heads = {};
  for (const [name, files] of Object.entries(branches)) {
    mustGit(['checkout', '-q', '-b', name, base], dir);
    writeFiles(dir, files);
    heads[name] = commitAll(dir, `${name} work`);
  }
  mustGit(['checkout', '-q', 'main'], dir);
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', ...Object.keys(branches).map((b) => `${b}:refs/heads/${b}`)]);
  return { dir, base, heads, api: repoPath(repo), url: gitUrl(repo) };
}

/** Commits `files` on branch `name` and pushes it; returns the new head. */
async function pushOn(env, name, files, msg) {
  mustGit(['checkout', '-q', name], env.dir);
  writeFiles(env.dir, files);
  const sha = commitAll(env.dir, msg);
  mustGit(['checkout', '-q', 'main'], env.dir);
  await pushRetry(env.dir, env.url, [`${name}:refs/heads/${name}`]);
  return sha;
}

const create = (env, head, mergePolicy = 'review', label = 'POST changes') =>
  http(`${env.api}/changes`, { method: 'POST', json: { title: `guard ${head}`, base: 'main', head, mergePolicy }, label });

const guardRuns = (checks) => (checks ?? []).filter((k) => k.name === 'kvarm/guard');
const brief = (k) => ({ name: k.name, headSha: k.headSha?.slice(0, 8), status: k.status, conclusion: k.conclusion, findings: k.summary?.findings });

/** Polls GET changes/:n/checks until `done(json)` or the deadline. */
async function pollChecks(env, n, done, timeoutMs = 60_000) {
  const t0 = Date.now();
  let r;
  do {
    r = await http(`${env.api}/changes/${n}/checks`, { label: 'GET changes/:n/checks' });
    if (r.status === 200 && done(r.json)) break;
    await sleep(2000);
  } while (Date.now() - t0 < timeoutMs);
  return { r, ms: Date.now() - t0 };
}

async function pollChange(env, n, done, timeoutMs = 120_000) {
  const t0 = Date.now();
  const trace = [];
  let c;
  do {
    c = (await http(`${env.api}/changes/${n}`)).json;
    const s = `${c?.state}/${c?.queueState ?? '-'}`;
    if (trace[trace.length - 1] !== s) trace.push(s);
    if (done(c)) break;
    await sleep(2000);
  } while (Date.now() - t0 < timeoutMs);
  return { change: c, ms: Date.now() - t0, trace };
}

/** The single guard run of a fresh change, after creation. */
async function guardOf(env, n) {
  const { r } = await pollChecks(env, n, (j) => guardRuns(j.checks).length > 0);
  return { run: guardRuns(r.json?.checks)[0] ?? null, r };
}

async function scenario(purpose, body) {
  if (only && !only.has(purpose)) return;
  const repo = `${PREFIX}-${purpose}-${TS}`;
  console.log(`\n# ${purpose}: ${OWNER}/${repo}`);
  const r = await withFixtureRepo(
    { owner: OWNER, repo, prefix: PREFIX, http: (p, o) => http(p, o), keep: opts.keep, visibility: 'public', log: console.log },
    async () => {
      try {
        await body(repo);
      } catch (err) {
        check(purpose, `scenario ${purpose} ran to completion`, false, String(err).slice(0, 300));
      }
    },
  );
  if (!r.ok) check(purpose, 'fixture repo', false, r.reason);
  if (!opts.keep && r.created) {
    const gone = await http(repoPath(repo));
    check(purpose, 'scratch repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
  }
}

// ---------------------------------------------------------------------------

await scenario('refresh', async (repo) => {
  const env = await seed(repo, {}, { docs: { 'README.md': `# ${repo}\n\nA guard fixture, with more words.\n` } });
  const created = await create(env, 'docs', 'review', 'POST changes (clean)');
  const n = created.json?.number;
  console.log(`POST changes -> ${created.status} #${n} checks=${JSON.stringify(created.json?.checks?.map(brief))} (x-kvarm-cost ${created.cost})`);
  const first = await pollChecks(env, n, (j) => j.checks.length > 0);
  const runs1 = first.r.json?.checks ?? [];
  console.log(`GET changes/${n}/checks after create (${first.ms} ms) -> ${JSON.stringify(runs1.map(brief))} (x-kvarm-cost ${first.r.cost})`);
  check(
    'VAL-GUARD-001',
    'after create: exactly one check run, kvarm/guard, at head sha 1',
    runs1.length === 1 && runs1[0].name === 'kvarm/guard' && runs1[0].headSha === env.heads.docs && runs1[0].treeSha?.length === 40,
    `head1=${env.heads.docs.slice(0, 8)}`,
  );
  check(
    'VAL-GUARD-006',
    'README-only change: kvarm/guard success with no findings',
    runs1[0]?.status === 'success' && runs1[0]?.conclusion === 'success' && Array.isArray(runs1[0]?.summary?.findings) && runs1[0].summary.findings.length === 0,
    JSON.stringify(runs1[0]?.summary && { conclusion: runs1[0].summary.conclusion, findings: runs1[0].summary.findings, scanned: runs1[0].summary.scanned }),
  );

  const head2 = await pushOn(env, 'docs', { 'README.md': `# ${repo}\n\nA guard fixture, with even more words.\n` }, 'docs v2');
  const second = await pollChecks(env, n, (j) => guardRuns(j.checks).some((k) => k.headSha === head2));
  const runs2 = second.r.json?.checks ?? [];
  console.log(`GET changes/${n}/checks after push (${second.ms} ms) -> headSha=${second.r.json?.headSha?.slice(0, 8)} ${JSON.stringify(runs2.map(brief))}`);
  check(
    'VAL-GUARD-001',
    'after a head push: a new kvarm/guard run at head sha 2 in addition to the first; still only guard runs',
    runs2.length === 2 &&
      runs2.every((k) => k.name === 'kvarm/guard') &&
      runs2.some((k) => k.headSha === head2 && k.status === 'success') &&
      runs2.some((k) => k.headSha === env.heads.docs),
    `head2=${head2.slice(0, 8)} after ${second.ms} ms`,
  );
  const status = await http(`${env.api}/commits/${head2}/status`, { label: 'GET commits/:sha/status' });
  console.log(`GET commits/${head2.slice(0, 8)}/status -> ${status.status} ${JSON.stringify({ ...status.json, checks: status.json?.checks?.map(brief) })} (x-kvarm-cost ${status.cost})`);
  check(
    'VAL-GUARD-001',
    'commit status of head 2 reflects only the guard (state success, total 1, kvarm/guard)',
    status.status === 200 && status.json?.state === 'success' && status.json?.total === 1 && status.json?.checks?.[0]?.name === 'kvarm/guard',
  );
  const none = await http(`${env.api}/commits/${env.base}/status`, { label: 'GET commits/:sha/status' });
  check('VAL-GUARD-001', 'commit status of an unjudged commit (main): state none, no runs', none.status === 200 && none.json?.state === 'none' && none.json?.total === 0, none.text);
});

await scenario('secret', async (repo) => {
  const env = await seed(repo, {}, { leak: { 'secrets.txt': `# config\naws_key=${AWS_FAKE}\nkvarm_token=${KVARM_FAKE}\n` } });
  const responses = [];
  const created = await create(env, 'leak', 'review', 'POST changes (secret)');
  responses.push(created.text);
  const n = created.json?.number;
  const { run, r } = await guardOf(env, n);
  responses.push(r.text);
  console.log(`GET changes/${n}/checks -> ${JSON.stringify(brief(run ?? {}))}`);
  const findings = run?.summary?.findings ?? [];
  check(
    'VAL-GUARD-002',
    'kvarm/guard failure with secret findings on secrets.txt carrying path, line, rule and message',
    run?.status === 'failure' &&
      run?.conclusion === 'failure' &&
      findings.some((f) => f.path === 'secrets.txt' && f.line === 2 && f.rule === 'secret/aws-access-key' && f.message) &&
      findings.some((f) => f.path === 'secrets.txt' && f.line === 3 && f.rule === 'secret/kvarm-token' && f.message),
    JSON.stringify(findings),
  );

  const merge = await http(`${env.api}/changes/${n}/merge`, { method: 'POST', label: 'POST changes/:n/merge (guard failed)' });
  responses.push(merge.text);
  const after = await http(`${env.api}/changes/${n}`, { label: 'GET changes/:n' });
  responses.push(after.text);
  const status = await http(`${env.api}/commits/${env.heads.leak}/status`);
  responses.push(status.text);
  const main = lsRemote(env.url, 'refs/heads/main');
  console.log(`POST changes/${n}/merge -> ${merge.status} ${merge.text.slice(0, 400)} (x-kvarm-cost ${merge.cost})`);
  console.log(`git ls-remote main -> ${main?.slice(0, 8)} (base ${env.base.slice(0, 8)}); change state=${after.json?.state} mergeable=${after.json?.mergeability?.mergeable} checks=${after.json?.mergeability?.checks?.state}`);
  check(
    'VAL-GUARD-007',
    'explicit merge -> 409 REQUIRED_CHECKS_FAILED naming kvarm/guard; main unmoved; change open',
    merge.status === 409 && merge.json?.code === 'REQUIRED_CHECKS_FAILED' && /kvarm\/guard/.test(merge.json?.error ?? '') && main === env.base && after.json?.state === 'open',
  );
  const joined = responses.join('\n');
  const hits = [AWS_FAKE, KVARM_FAKE, KVARM_FAKE.slice(10)].map((v) => joined.split(v).length - 1);
  console.log(`redaction: ${responses.length} responses, ${joined.length} bytes; matches of the AWS key / kvarm token / its hex = ${hits.join(' / ')}`);
  check('VAL-GUARD-002', 'neither planted value (nor the token hex) appears in any captured response', hits.every((h) => h === 0));
});

await scenario('gaming', async (repo) => {
  const ci = (run) => `${JSON.stringify({ jobs: [{ name: 'test', run }] }, null, 2)}\n`;
  const env = await seed(repo, { '.kvarm/ci.json': ci('npm test') }, { game: { '.kvarm/ci.json': ci('npm test || true') } });
  const n = (await create(env, 'game')).json?.number;
  const { run } = await guardOf(env, n);
  console.log(`GET changes/${n}/checks -> ${JSON.stringify(brief(run ?? {}))}`);
  check(
    'VAL-GUARD-003',
    '`npm test` -> `npm test || true`: kvarm/guard failure citing .kvarm/ci.json and ci-gaming/or-true',
    run?.status === 'failure' && (run?.summary?.findings ?? []).some((f) => f.path === '.kvarm/ci.json' && f.rule === 'ci-gaming/or-true' && Number.isInteger(f.line)),
  );
});

await scenario('testdel', async (repo) => {
  const env = await seed(
    repo,
    { 'src/app.js': 'module.exports = () => 1;\n', 'tests/app.test.js': "const app = require('../src/app');\ntest('app', () => expect(app()).toBe(1));\n" },
    { drop: { 'tests/app.test.js': null } },
  );
  const files = mustGit(['diff', '--name-status', `${env.base}..${env.heads.drop}`], env.dir);
  console.log(`git diff --name-status base..drop -> ${files}`);
  const n = (await create(env, 'drop')).json?.number;
  const { run } = await guardOf(env, n);
  console.log(`GET changes/${n}/checks -> ${JSON.stringify(brief(run ?? {}))}`);
  check(
    'VAL-GUARD-004',
    'deleting tests/app.test.js: kvarm/guard failure citing the deleted path (ci-gaming/test-deleted)',
    files === 'D\ttests/app.test.js' && run?.status === 'failure' && (run?.summary?.findings ?? []).some((f) => f.path === 'tests/app.test.js' && f.rule === 'ci-gaming/test-deleted'),
  );
});

await scenario('dep', async (repo) => {
  const pkg = (deps) => `${JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps }, null, 2)}\n`;
  const env = await seed(repo, { 'package.json': pkg({ lodash: '^4.17.21' }) }, { typo: { 'package.json': pkg({ lodash: '^4.17.21', lodahs: '^1.0.0' }) } });
  const n = (await create(env, 'typo')).json?.number;
  const { run } = await guardOf(env, n);
  console.log(`GET changes/${n}/checks -> ${JSON.stringify(brief(run ?? {}))}`);
  check(
    'VAL-GUARD-005',
    'new "lodahs" dependency: a finding naming lodahs and package.json (dependency/typosquat)',
    (run?.summary?.findings ?? []).some((f) => f.path === 'package.json' && f.rule === 'dependency/typosquat' && /lodahs/.test(f.message)) &&
      ['neutral', 'failure'].includes(run?.conclusion),
    `conclusion=${run?.conclusion}`,
  );
});

await scenario('auto', async (repo) => {
  const env = await seed(repo, {}, { clean: { 'notes.txt': 'notes\n' }, fixme: { 'conf.txt': `key=${AWS_FAKE}\n` } });
  const created = await create(env, 'clean', 'auto', 'POST changes (auto, clean)');
  const n = created.json?.number;
  const done = await pollChange(env, n, (c) => c?.state === 'merged');
  const { run } = await guardOf(env, n);
  const main = lsRemote(env.url, 'refs/heads/main');
  console.log(`clean auto #${n}: create ${created.status} state=${created.json?.state} (x-kvarm-cost ${created.cost}); guard ${run?.status}; trace ${done.trace.join(' > ')}; mergeCommit=${done.change?.mergeCommit?.slice(0, 8)} main=${main?.slice(0, 8)}`);
  check(
    'VAL-MERGE-006',
    'clean auto change: kvarm/guard success, then merged with mergeCommit and main moved to it, with no merge call',
    run?.status === 'success' && done.change?.state === 'merged' && /^[0-9a-f]{40}$/.test(done.change?.mergeCommit ?? '') && main === done.change.mergeCommit,
  );

  // An auto change whose guard failed stays open; the push that removes the secret is judged and merges it.
  const bad = await create(env, 'fixme', 'auto', 'POST changes (auto, secret)');
  const m = bad.json?.number;
  const g1 = await guardOf(env, m);
  await sleep(5000);
  const held = (await http(`${env.api}/changes/${m}`)).json;
  check(
    'VAL-MERGE-006',
    'auto change with a failed kvarm/guard stays open',
    g1.run?.status === 'failure' && held?.state === 'open' && held?.mergeability?.checks?.state === 'failure',
    `guard=${g1.run?.status} state=${held?.state} gate=${held?.mergeability?.checks?.state}`,
  );
  const fixed = await pushOn(env, 'fixme', { 'conf.txt': 'key=read-from-the-environment\n' }, 'remove the secret');
  const merged = await pollChange(env, m, (c) => c?.state === 'merged');
  const runs = (await http(`${env.api}/changes/${m}/checks`)).json?.checks ?? [];
  const main2 = lsRemote(env.url, 'refs/heads/main');
  console.log(`auto #${m} after fix push ${fixed.slice(0, 8)}: trace ${merged.trace.join(' > ')} in ${merged.ms} ms; runs ${JSON.stringify(runs.map(brief))}; main=${main2?.slice(0, 8)}`);
  check(
    'VAL-MERGE-006',
    'after the fix push: a kvarm/guard success run at the new head, then merged automatically (main = mergeCommit)',
    runs.some((k) => k.headSha === fixed && k.status === 'success') && merged.change?.state === 'merged' && main2 === merged.change?.mergeCommit && merged.ms <= 120_000,
  );
});

await scenario('pair', async (repo) => {
  const env = await seed(repo, {}, { x: { 'x.txt': 'x\n' }, y: { 'y.txt': 'y\n' } });
  const [cx, cy] = await Promise.all([create(env, 'x', 'auto', 'POST changes (auto, concurrent)'), create(env, 'y', 'auto', 'POST changes (auto, concurrent)')]);
  console.log(`concurrent creates: x ${cx.status} #${cx.json?.number} ${cx.json?.state} (x-kvarm-cost ${cx.cost}); y ${cy.status} #${cy.json?.number} ${cy.json?.state} (x-kvarm-cost ${cy.cost})`);
  const [sx, sy] = await Promise.all([pollChange(env, cx.json?.number, (c) => c?.state === 'merged'), pollChange(env, cy.json?.number, (c) => c?.state === 'merged')]);
  console.log(`x: ${sx.trace.join(' > ')} mergeCommit=${sx.change?.mergeCommit?.slice(0, 8)}; y: ${sy.trace.join(' > ')} mergeCommit=${sy.change?.mergeCommit?.slice(0, 8)}`);
  check('VAL-QUEUE-003', 'both concurrently created auto changes reach merged', sx.change?.state === 'merged' && sy.change?.state === 'merged');

  const cdir = join(work, `${repo}-clone`);
  mustGit(['clone', '-q', env.url, cdir], work);
  const graph = mustGit(['log', '--graph', '--first-parent', '--format=%h %s', 'main'], cdir);
  console.log(`git log --graph --first-parent main:\n${graph}`);
  const chain = mustGit(['rev-list', '--first-parent', 'main'], cdir).split('\n');
  const [firstSt, secondSt] = chain[1] === sx.change?.mergeCommit ? [sx, sy] : [sy, sx];
  const secondParents = mustGit(['rev-list', '--parents', '-n', '1', secondSt.change?.mergeCommit ?? 'HEAD'], cdir).split(' ').slice(1);
  const files = mustGit(['ls-tree', '--name-only', 'main'], cdir).split('\n');
  const both = `${mustGit(['show', 'main:x.txt'], cdir)}|${mustGit(['show', 'main:y.txt'], cdir)}`;
  console.log(`cat x.txt y.txt -> ${both}; files ${files.join(',')}`);
  check(
    'VAL-QUEUE-003',
    'fresh clone: x.txt and y.txt both on main; first-parent history linear (base <- first <- second)',
    files.includes('x.txt') && files.includes('y.txt') && both === 'x|y' && chain.length === 3 && chain[2] === env.base && chain[0] === secondSt.change?.mergeCommit,
    chain.map((s) => s.slice(0, 8)).join(' <- '),
  );
  check(
    'VAL-QUEUE-004',
    "the second landed commit's first parent is the first's mergeCommit (merged against the updated base)",
    secondParents[0] === firstSt.change?.mergeCommit && chain[1] === firstSt.change?.mergeCommit,
    `parents(second)=${secondParents.map((s) => s.slice(0, 8)).join(',')} first=${firstSt.change?.mergeCommit?.slice(0, 8)}`,
  );
  const fsck = git(['fsck', '--strict'], cdir);
  check('VAL-QUEUE-003', 'git fsck --strict clean', fsck.code === 0, fsck.err);
});

await scenario('eject', async (repo) => {
  const env = await seed(
    repo,
    {},
    { bad: { 'secrets.txt': `aws_key=${AWS_FAKE}\n` }, good: { 'good.txt': 'good\n' }, third: { 'third.txt': 'third\n' }, rbad: { 'r.txt': `token=${KVARM_FAKE}\n` }, rgood: { 'rgood.txt': 'rgood\n' }, rthird: { 'rthird.txt': 'rthird\n' } },
  );
  const enqueue = (n, mergePolicy) => http(`${env.api}/changes/${n}/enqueue`, { method: 'POST', json: { mergePolicy }, label: 'POST changes/:n/enqueue' });

  // auto variant: both created together, then both enqueued together (the clean one may already have merged at creation).
  const [cb, cg] = await Promise.all([create(env, 'bad', 'auto'), create(env, 'good', 'auto')]);
  const [nb, ng] = [cb.json?.number, cg.json?.number];
  const [eb, eg] = await Promise.all([enqueue(nb, 'auto'), enqueue(ng, 'auto')]);
  console.log(`auto: create bad #${nb} ${cb.json?.state}, good #${ng} ${cg.json?.state}; enqueue bad ${eb.status} ${eb.json?.entry?.state ?? eb.json?.code}, good ${eg.status} ${eg.json?.entry?.state ?? eg.json?.code}`);
  const sg = await pollChange(env, ng, (c) => c?.state === 'merged');
  const sb = await pollChange(env, nb, (c) => c?.state !== 'open' || c?.queueState === null, 60_000);
  await sleep(4000);
  const q1 = await http(`${env.api}/queue`, { label: 'GET queue' });
  const badView = (await http(`${env.api}/changes/${nb}`)).json;
  console.log(`auto bad #${nb}: ${sb.trace.join(' > ')} -> state=${badView?.state} queueState=${badView?.queueState}; good #${ng}: ${sg.trace.join(' > ')}; queue=${JSON.stringify((q1.json?.entries ?? []).map((e) => e.number))}`);
  check(
    'VAL-QUEUE-005',
    'auto: the change with the failing kvarm/guard never merges and leaves the queue; the clean one merges unattended',
    eb.status === 201 && badView?.state === 'open' && badView?.queueState === null && !(q1.json?.entries ?? []).some((e) => e.number === nb) && sg.change?.state === 'merged',
  );
  const ct = await create(env, 'third', 'auto');
  const st = await pollChange(env, ct.json?.number, (c) => c?.state === 'merged');
  check('VAL-QUEUE-005', 'auto: a third clean auto change still merges afterwards', st.change?.state === 'merged', st.trace.join(' > '));

  // review variant: both approved through the train in one near-concurrent enqueue.
  const rb = (await create(env, 'rbad')).json?.number;
  const rg = (await create(env, 'rgood')).json?.number;
  const [erb, erg] = await Promise.all([enqueue(rb, 'review'), enqueue(rg, 'review')]);
  const srg = await pollChange(env, rg, (c) => c?.state === 'merged');
  const srb = await pollChange(env, rb, (c) => c?.queueState === null, 60_000);
  const q2 = await http(`${env.api}/queue`, { label: 'GET queue' });
  console.log(`train: enqueue rbad #${rb} ${erb.status}, rgood #${rg} ${erg.status}; rbad ${srb.trace.join(' > ')}; rgood ${srg.trace.join(' > ')}; queue=${JSON.stringify((q2.json?.entries ?? []).map((e) => e.number))}`);
  check(
    'VAL-QUEUE-005',
    'train: the failing change is ejected (open, not queued), the clean one behind it published',
    erb.status === 201 && erg.status === 201 && srb.change?.state === 'open' && srb.change?.queueState === null && srg.change?.state === 'merged' && (q2.json?.entries ?? []).length === 0,
  );
  const r3 = (await create(env, 'rthird')).json?.number;
  const e3 = await enqueue(r3, 'review');
  const s3 = await pollChange(env, r3, (c) => c?.state === 'merged');
  const q3 = await http(`${env.api}/queue`);
  check('VAL-QUEUE-005', 'train: a third change enqueues and merges; queue empty (lock free)', e3.status === 201 && s3.change?.state === 'merged' && (q3.json?.entries ?? []).length === 0, s3.trace.join(' > '));
  const main = lsRemote(env.url, 'refs/heads/main');
  const cdir = join(work, `${repo}-clone`);
  mustGit(['clone', '-q', env.url, cdir], work);
  const files = mustGit(['ls-tree', '--name-only', 'main'], cdir).split('\n');
  check('VAL-QUEUE-005', 'main carries the clean changes and neither secret file', !files.includes('secrets.txt') && !files.includes('r.txt') && ['good.txt', 'third.txt', 'rgood.txt', 'rthird.txt'].every((f) => files.includes(f)), `${main?.slice(0, 8)} ${files.join(',')}`);
});

await scenario('cost', async (repo) => {
  const env = await seed(repo, {}, { a: { 'a.txt': 'a\n' }, b: { 'b.txt': 'b\n' } });
  const na = (await create(env, 'a')).json?.number;
  const nb = (await create(env, 'b')).json?.number;
  const posts = [];
  for (const name of ['lint', 'unit', 'e2e', 'types', 'build']) {
    const r = await http(`${env.api}/check-runs`, { method: 'POST', json: { headSha: env.heads.b, name, conclusion: 'success' }, label: 'POST check-runs' });
    posts.push(`${name}:${r.status}`);
  }
  const ca = (await http(`${env.api}/changes/${na}/checks`)).json?.checks ?? [];
  const cb = (await http(`${env.api}/changes/${nb}/checks`)).json?.checks ?? [];
  console.log(`POST check-runs on B ${env.heads.b.slice(0, 8)}: ${posts.join(' ')}; runs A=${ca.length} B=${cb.length} (${cb.map((k) => k.name).join(',')})`);
  check('VAL-COST-011', 'A carries 1 check run (kvarm/guard), B carries 6', ca.length === 1 && ca[0].name === 'kvarm/guard' && cb.length === 6);
  await http(`${env.api}/changes/${na}`);
  await http(`${env.api}/changes/${nb}`);
  const a = await http(`${env.api}/changes/${na}`, { label: 'GET changes/:n (1 run)' });
  const b = await http(`${env.api}/changes/${nb}`, { label: 'GET changes/:n (6 runs)' });
  console.log(`GET changes/${na} (1 run): ${a.status} x-kvarm-cost ${a.cost}\nGET changes/${nb} (6 runs): ${b.status} x-kvarm-cost ${b.cost}; B mergeability.checks=${JSON.stringify(b.json?.mergeability?.checks?.required?.map((k) => `${k.name}:${k.state}`))}`);
  check(
    'VAL-COST-011',
    'detail d1 equal for 1 and 6 check runs and within the cost.md budget (d1 <= 3, art=0 warm)',
    a.status === 200 && b.status === 200 && a.c.d1 === b.c.d1 && a.c.d1 <= 3 && a.c.art === 0 && b.c.art === 0 && b.json?.checks?.length === 6,
    `d1 ${a.c.d1} vs ${b.c.d1}`,
  );
  // Reference figure for library/cost.md: an explicit merge now also asks the gate once.
  const merged = await http(`${env.api}/changes/${na}/merge`, { method: 'POST', label: 'POST changes/:n/merge (success)' });
  console.log(`POST changes/${na}/merge -> ${merged.status} ${merged.json?.state} x-kvarm-cost ${merged.cost}`);
  check('VAL-COST-011', 'a guard-passing change merges; the merge asks the gate once (d1 <= 6)', merged.status === 200 && merged.json?.state === 'merged' && merged.c.d1 <= 6, merged.cost);
});

rmSync(work, { recursive: true, force: true });
console.log('\n# x-kvarm-cost by endpoint');
const byLabel = new Map();
for (const c of costs) byLabel.set(c.label, [...(byLabel.get(c.label) ?? []), `${c.status} ${c.cost}`]);
for (const [k, v] of byLabel) console.log(`  ${k}: ${[...new Set(v)].slice(0, 4).join(' | ')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
