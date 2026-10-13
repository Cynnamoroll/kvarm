#!/usr/bin/env node
/**
 * Fleet driver: ONE live run of 100 active agent workspaces on one fresh
 * repo, with crafted overlapping edits and a paced change burst through the
 * merge queue (VAL-SCALE-001..004).
 *
 *   set -a; . ./.env.local; set +a
 *   . "$HOME/.config/vite-plus/env"           # wrangler, for read-only D1 counters
 *   node scripts/fleet-driver.mjs --preflight-only            # projection only, no network
 *   node scripts/fleet-driver.mjs --ceiling 1000              # forced over-projection: exit 3, nothing runs
 *   node scripts/fleet-driver.mjs --write-benchmark           # the campaign run (a completed run writes
 *                                                             # docs/benchmarks/fleet-100.{md,json}, failed checks listed)
 *   node scripts/fleet-driver.mjs --render-only <report.json> [--write-benchmark]   # re-render a saved report, no network
 *   node scripts/fleet-driver.mjs --smoke --workspaces 16     # labelled rehearsal, never a campaign result
 *
 * Plan (scripts/lib/fleet.mjs planFleet): member w000 is the early sentinel
 * (pushed, never enqueued, must stay active at its sha), w001 <- w002 <- w003
 * a pinned interface chain enqueued C, B, ..., A (out of dependency order),
 * twelve members edit shared/config.txt (non-overlapping lines, one identical
 * edit pair, four same-line variants that genuinely conflict), the rest add
 * only their own marker file. Each member is its own agent principal with
 * its own write token for refs/heads/agents/*; it creates its workspace and
 * pushes it. Change sets and enqueues use KVARM_PAT (review policy: the
 * enqueue approves the head). The first <= 5 conflicted changes are
 * resolved through the resolve-conflict task flow by their own agent; the
 * rest are listed as incomplete with their reason.
 *
 * Limits enforced at runtime: one process, <= 3 git children, <= 5 in-flight
 * HTTP requests, a request ledger that refuses the request that would pass
 * the ceiling (git children count gitHttpPerOp requests each), paced pushes
 * and enqueues, 429/Retry-After honored with a bounded campaign retry
 * budget. Any invariant failure or ceiling breach aborts with the failure
 * point recorded, then the scoped cleanup still runs: the driver revokes
 * only the agents it created and deletes only the repo it created (owner
 * GET 404 readback). It never deploys and never prints a token: git uses
 * `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a secret-free
 * GIT_ASKPASS reading the token from the child's environment.
 *
 * Exit codes: 0 every check held; 1 a check failed or the run aborted;
 * 2 usage/environment; 3 preflight refused (projection does not fit).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkIsolatedName } from './lib/fixture-repo.mjs';
import { remoteD1Args } from './lib/wrangler-target.mjs';
import {
  BUDGET_ROWS,
  CAMPAIGN_LIMITS,
  CHECK_IDS,
  CONFIG_PATH,
  CampaignAbort,
  CeilingExceeded,
  RequestLedger,
  checkProjection,
  comparePublications,
  countMarkers,
  createInvariants,
  createLimiter,
  editLine,
  endpointClass,
  findMonetary,
  forecastMemberSet,
  longestQueueIdle,
  memberFiles,
  parseCost,
  percentile,
  planFleet,
  projectCampaign,
  reconcileWorkspaces,
  renderBenchmarkMarkdown,
  retryAfterMs,
  sumCosts,
  verifyGraph,
  verifyNotes,
  withinBudget,
} from './lib/fleet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'scale-staged-campaign';
const NOTES_REF = 'refs/notes/kvarm-attribution';
const MONETARY_CHECK = 'campaign report has no monetary amount or pricing derivation';
const BUDGETS = BUDGET_ROWS;

const { values: opts } = parseArgs({
  options: {
    'preflight-only': { type: 'boolean', default: false },
    smoke: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    'write-benchmark': { type: 'boolean', default: false },
    workspaces: { type: 'string', default: '100' },
    ceiling: { type: 'string', default: String(CAMPAIGN_LIMITS.ceiling) },
    'git-children': { type: 'string', default: String(CAMPAIGN_LIMITS.gitChildren) },
    'http-in-flight': { type: 'string', default: String(CAMPAIGN_LIMITS.httpInFlight) },
    'pushes-per-minute': { type: 'string', default: '30' },
    'enqueue-interval-ms': { type: 'string', default: '600' },
    'poll-interval-ms': { type: 'string', default: '4000' },
    'max-burst-min': { type: 'string', default: '40' },
    'max-resolutions': { type: 'string', default: '5' },
    out: { type: 'string' },
    'worker-version': { type: 'string' },
    'render-only': { type: 'string' },
  },
});

// Re-renders the table from a saved report.json (derived rows recomputed from its recorded data); no network.
if (opts['render-only']) {
  const saved = JSON.parse(readFileSync(opts['render-only'], 'utf8'));
  if (saved.burst && saved.d1?.queue) saved.burst.longestIdle = longestQueueIdle(saved.d1.queue);
  const md = renderBenchmarkMarkdown(saved);
  const json = JSON.stringify(saved, null, 2) + '\n';
  // The monetary check's own label names what it looks for; the run scanned the report before that row existed.
  const scanned = JSON.stringify({ ...saved, checks: (saved.checks ?? []).filter((c) => c.label !== MONETARY_CHECK) });
  const monetary = [...findMonetary(md), ...findMonetary(scanned)];
  if (monetary.length) {
    console.error(`fleet-driver: monetary text in the report: ${monetary.slice(0, 3).join(', ')}`);
    process.exit(1);
  }
  if (opts['write-benchmark']) {
    const dir = join(ROOT, 'docs/benchmarks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'fleet-100.md'), md);
    writeFileSync(join(dir, 'fleet-100.json'), json);
    console.log('benchmark re-rendered: docs/benchmarks/fleet-100.md, docs/benchmarks/fleet-100.json');
  } else process.stdout.write(md);
  process.exit(0);
}

const TS = Math.floor(Date.now() / 1000);
const N = Number(opts.workspaces);
if (N !== 100 && !opts.smoke) {
  console.error('fleet-driver: the approved run is 100 workspaces; a different count needs --smoke (a labelled rehearsal, never a campaign result)');
  process.exit(2);
}
if (opts.smoke && opts['write-benchmark']) {
  console.error('fleet-driver: --smoke runs never write the benchmark table');
  process.exit(2);
}
const limits = {
  ...CAMPAIGN_LIMITS,
  ceiling: Number(opts.ceiling),
  gitChildren: Number(opts['git-children']),
  httpInFlight: Number(opts['http-in-flight']),
};
const pace = {
  pushesPerMinute: Number(opts['pushes-per-minute']),
  enqueueIntervalMs: Number(opts['enqueue-interval-ms']),
  pollIntervalMs: Number(opts['poll-interval-ms']),
  maxBurstMs: Number(opts['max-burst-min']) * 60_000,
  maxResolutions: Number(opts['max-resolutions']),
};
const plan = planFleet({ workspaces: N, ts: TS });
const projection = projectCampaign(plan, pace);
const verdict = checkProjection(projection, limits);

// ---------------------------------------------------------------- preflight

console.log(`# fleet-driver preflight (${opts.smoke ? `SMOKE rehearsal, ${N} workspaces, not a campaign result` : 'campaign run'})`);
console.log(
  `workload: ${N} active workspaces on one fresh repo (one ownership profile: personal), ${plan.burst.length}-change paced burst through the queue; ` +
    `${plan.overlapKeys.length} members edit ${CONFIG_PATH} (${plan.expectedPairs.size} expected overlap pairs incl. the 3-member pinned chain); sentinel ${plan.sentinel} never enqueued`,
);
console.log(`limits: <= ${limits.gitChildren} git children, <= ${limits.httpInFlight} in-flight HTTP, campaign ceiling ${limits.ceiling} harness requests (git child = ${limits.gitHttpPerOp} requests)`);
console.log(
  `git pacing: per-credential git write limit ${limits.gitWritesPerMin}/min; pushes paced at ${pace.pushesPerMinute}/min = ${projection.gitWritesPerMinute} write requests/min (one agent token per push); enqueues >= ${pace.enqueueIntervalMs} ms apart; polls every ${pace.pollIntervalMs} ms`,
);
console.log('projected harness-issued requests:');
for (const i of projection.items) console.log(`  ${i.stage.padEnd(8)} ${String(i.requests).padStart(5)}  (http ${i.http}, git children ${i.git})  ${i.label}`);
console.log(`  total    ${String(projection.total).padStart(5)}  of ceiling ${limits.ceiling}`);
console.log('projected server-side background work (not counted against the ceiling):');
for (const b of projection.background) console.log(`  ${String(b.count).padStart(5)}  ${b.label}`);
if (!verdict.fits) {
  for (const p of verdict.problems) console.error(`PREFLIGHT REFUSED: ${p}`);
  console.error('the run did not start (no request was sent)');
  process.exit(3);
}
console.log('preflight: fits');
if (opts['preflight-only']) process.exit(0);

// ---------------------------------------------------------------- environment

const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(OWNER)) throw new Error(`KVARM_USER ${JSON.stringify(OWNER)} is not a valid login`);
const PAT = process.env.KVARM_PAT;
if (!PAT) {
  console.error('fleet-driver: KVARM_PAT is not set (set -a; . ./.env.local; set +a)');
  process.exit(2);
}
if (spawnSync('wrangler', ['--version'], { encoding: 'utf8' }).status !== 0) {
  console.error('fleet-driver: wrangler is not on PATH (. "$HOME/.config/vite-plus/env"); it reads D1 counters read-only');
  process.exit(2);
}
const REPO = `${PREFIX}-${opts.smoke ? 'smoke' : 'fleet'}-${TS}`;
const bad = checkIsolatedName(REPO, PREFIX);
if (bad) {
  console.error(`fleet-driver: ${bad}`);
  process.exit(2);
}
const API = `/api/v1/repos/${OWNER}/${REPO}`;
const GIT_URL = `${BASE}/${OWNER}/${REPO}.git`;
const work = mkdtempSync(join(tmpdir(), 'fleet-driver-'));
const outDir = opts.out ?? join(work, 'report');
mkdirSync(outDir, { recursive: true });
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

// ---------------------------------------------------------------- runtime state

const transcript = [];
const log = (line) => {
  transcript.push(line);
  console.log(line);
};
const { results, check, gate } = createInvariants({ log, stage: () => stage });

const ledger = new RequestLedger(limits.ceiling);
const httpLim = createLimiter(limits.httpInFlight);
const gitLim = createLimiter(limits.gitChildren);
const counters = new Map();
const retries = { http429: 0, git429: 0, queueFull: 0, gitRead: 0, budget: projection.opts.retryBudget };
let stage = 'setup';
const stageMs = {};
let stageStart = Date.now();
function enter(next) {
  stageMs[stage] = (stageMs[stage] ?? 0) + (Date.now() - stageStart);
  stage = next;
  stageStart = Date.now();
  log(`\n## ${next}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function spendRetry(kind) {
  retries[kind]++;
  if (retries.http429 + retries.git429 + retries.queueFull > retries.budget) {
    throw new CampaignAbort(`429 retry budget ${retries.budget} exhausted at ${stage}`);
  }
}

/** One REST request through the HTTP limiter and the ledger; 429 waits for Retry-After unless the caller handles it. */
async function api(path, { method = 'GET', json, token = PAT, handle429 = false, label = stage } = {}) {
  for (let attempt = 0; ; attempt++) {
    ledger.reserve('http', 1, label);
    const t0 = Date.now();
    let res;
    let text;
    try {
      ({ res, text } = await httpLim.run(async () => {
        const init = { method, headers: { Authorization: `Bearer ${token}` } };
        if (json !== undefined) {
          init.headers['content-type'] = 'application/json';
          init.body = JSON.stringify(json);
        }
        const r = await fetch(`${BASE}${path}`, init);
        return { res: r, text: await r.text() };
      }));
    } catch (err) {
      if (method === 'GET' && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new CampaignAbort(`network failure on ${method} ${endpointClass(method, path)} at ${stage}: ${String(err).slice(0, 200)}`);
    }
    const cost = res.headers.get('x-kvarm-cost');
    const cls = endpointClass(method, path);
    const agg = counters.get(cls) ?? { count: 0, costs: [], statuses: {} };
    agg.count++;
    agg.statuses[res.status] = (agg.statuses[res.status] ?? 0) + 1;
    if (cost) agg.costs.push(parseCost(cost));
    counters.set(cls, agg);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const out = { status: res.status, json: body, cost, retryAfter: res.headers.get('retry-after'), ms: Date.now() - t0 };
    if (res.status === 429 && !handle429) {
      spendRetry('http429');
      const wait = retryAfterMs(out.retryAfter, 5000, 65_000);
      log(`  429 on ${cls}; waiting ${wait} ms (Retry-After ${out.retryAfter ?? 'absent'})`);
      await sleep(wait);
      continue;
    }
    if (res.status >= 500 && method === 'GET' && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return out;
  }
}

/** One git child through the git limiter; network commands reserve gitHttpPerOp requests each and retry a 429 after 60 s. */
async function git(args, { cwd = work, token = PAT, network = false, input, env = {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (network) ledger.reserve('git', limits.gitHttpPerOp, stage);
    const r = await gitLim.run(
      () =>
        new Promise((resolve) => {
          const child = spawn('git', ['-c', 'credential.helper=', ...args], {
            cwd,
            env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: token, ...env },
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
          if (input !== undefined) child.stdin.end(input);
          else child.stdin.end();
        }),
    );
    if (network && r.code !== 0 && /\b429\b|rate limited/i.test(r.err) && attempt < 3) {
      spendRetry('git429');
      log(`  git 429 on ${args[0]}; waiting 60 s`);
      await sleep(60_000);
      continue;
    }
    // Reads change nothing remotely, so a failed read is retried (bounded) and every failure stays in the transcript.
    if (network && r.code !== 0 && READ_ONLY_GIT.has(args[0]) && attempt < 2) {
      retries.gitRead++;
      gitReadFailures.push({ stage, op: args[0], attempt: attempt + 1, error: r.err.slice(0, 300) });
      log(`  git ${args[0]} failed (attempt ${attempt + 1}): ${r.err.split('\n').slice(0, 2).join(' / ').slice(0, 200)}; retrying in 5 s`);
      if (args[0] === 'clone') rmSync(args[args.length - 1], { recursive: true, force: true });
      await sleep(5000);
      continue;
    }
    return r;
  }
}
const READ_ONLY_GIT = new Set(['clone', 'ls-remote', 'fetch']);
const gitReadFailures = [];
async function mustGit(args, o) {
  const r = await git(args, o);
  if (r.code !== 0) throw new CampaignAbort(`git ${args[0]} failed at ${stage}: ${r.err.slice(0, 300)}`);
  return r.out;
}

function pacer(intervalMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + intervalMs;
    if (at > now) await sleep(at - now);
  };
}

function wrangler(sql) {
  const r = spawnSync(process.execPath, remoteD1Args(sql), {
    cwd: join(ROOT, 'apps/platform'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  d1Reads++;
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return JSON.parse(r.stdout).map((x) => x.results ?? []);
}
let d1Reads = 0;
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** Commit built with plumbing in a private index, so member commits never share a working tree. */
async function commitFiles(key, parent, files, message, extraParents = []) {
  const env = { GIT_INDEX_FILE: join(work, `index-${key}`) };
  await mustGit(['read-tree', parent], { cwd: local, env });
  for (const [path, content] of Object.entries(files)) {
    const blob = await mustGit(['hash-object', '-w', '--stdin'], { cwd: local, input: content });
    await mustGit(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { cwd: local, env });
  }
  const tree = await mustGit(['write-tree'], { cwd: local, env });
  const parents = [parent, ...extraParents].flatMap((p) => ['-p', p]);
  return mustGit(['commit-tree', tree, ...parents, '-m', message], { cwd: local });
}

// ---------------------------------------------------------------- run

const report = {
  run: { repo: `${OWNER}/${REPO}`, smoke: Boolean(opts.smoke), startedAt: new Date().toISOString(), head: gitHead(), worker: opts['worker-version'] ?? null },
  limits: { ...limits, ...pace },
  projection: { total: projection.total, items: projection.items, background: projection.background },
};
const ws = new Map(); // key -> {member, agentId, token, id, ref, branch, commit, number, ...}
const claimWorkspaces = [];
const agents = [];
let repoCreated = false;
let local = '';
let seed = '';
const ledgerCommits = new Set();
let abortedAt = null;
// The burst poller polls the deployment in the background; the abort path stops
// it before cleanup so its requests cannot starve the ledger the repo DELETE needs.
let stopPoller = null;
const burst = { samples: [], enqueue: new Map(), changes: new Map(), windowStart: null, windowEnd: null };
const incomplete = [];
const d1 = {};

function gitHead() {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return (r.stdout ?? '').trim() || null;
}

async function bootstrapSnapshot() {
  const user = await api('/api/v1/user');
  const e2e = await api(`/api/v1/repos/${OWNER}/kvarm-e2e`);
  const [pats, users, repos] = wrangler(
    `SELECT id, user_id, name, prefix, scopes, created_at, expires_at FROM pat ORDER BY id; SELECT id, login FROM users WHERE login = '${OWNER}'; SELECT id, owner_login, name, visibility, default_branch, artifacts_name, created_at, pushed_at FROM repos WHERE owner_login = '${OWNER}' AND name = 'kvarm-e2e'`,
  );
  return {
    user: { status: user.status, login: user.json?.user?.login ?? null },
    kvarmE2e: { status: e2e.status, digest: digest(e2e.json) },
    d1: { pats: pats.length, patsDigest: digest(pats), userDigest: digest(users), repoDigest: digest(repos) },
  };
}

async function main() {
  // -------------------------------------------------------------- setup
  log(`\n## setup  repo ${OWNER}/${REPO}, work dir ${work}`);
  report.bootstrapBefore = await bootstrapSnapshot();
  gate('setup', `bootstrap readable: user ${OWNER} and ${OWNER}/kvarm-e2e`, report.bootstrapBefore.user.login === OWNER && report.bootstrapBefore.kvarmE2e.status === 200);
  const exists = await api(API);
  gate('setup', `${OWNER}/${REPO} does not exist yet`, exists.status === 404, `GET ${exists.status}`);
  const made = await api('/api/v1/repos', { method: 'POST', json: { name: REPO, visibility: 'public' } });
  gate('setup', `created ${OWNER}/${REPO}`, made.status === 201, `POST ${made.status}`);
  repoCreated = true;

  local = join(work, 'local');
  mkdirSync(local);
  await mustGit(['init', '-q', '-b', 'main'], { cwd: local });
  mkdirSync(join(local, 'shared'));
  mkdirSync(join(local, 'iface'));
  writeFileSync(join(local, 'README.md'), `# ${REPO}\n\nScratch repo of one fleet-driver run.\n`);
  writeFileSync(join(local, CONFIG_PATH), plan.config);
  writeFileSync(join(local, 'iface/README.md'), 'pinned interface chain a <- b <- c\n');
  await mustGit(['add', '-A'], { cwd: local });
  await mustGit(['commit', '-q', '-m', 'fleet seed'], { cwd: local });
  seed = await mustGit(['rev-parse', 'HEAD'], { cwd: local });
  await mustGit(['push', '-q', GIT_URL, 'main:refs/heads/main'], { cwd: local, network: true });
  log(`seed ${seed}`);

  // -------------------------------------------------------------- local commits
  enter('fleet');
  const t0 = Date.now();
  for (const m of plan.members) {
    let parent = seed;
    if (m.chain === 'B') parent = ws.get(plan.chain.A).commit;
    if (m.chain === 'C') parent = ws.get(plan.chain.B).commit;
    const commit = await commitFiles(m.key, parent, memberFiles(plan, m), `${m.key}: ${m.role} work`);
    ledgerCommits.add(commit);
    ws.set(m.key, { member: m, commit, parent });
  }
  log(`built ${ws.size} member commits locally in ${Date.now() - t0} ms`);

  // -------------------------------------------------------------- fleet
  const paceFleet = pacer(Math.ceil(60_000 / pace.pushesPerMinute));
  let failed = null;
  const fleetStart = Date.now();
  const tasks = [];
  for (const m of plan.members) {
    await paceFleet();
    if (failed) break;
    tasks.push(
      (async () => {
        const w = ws.get(m.key);
        const agent = await api('/api/v1/agents', {
          method: 'POST',
          json: { name: `ssc-${TS}-${m.key}`, description: `scale-staged-campaign fleet agent ${m.key}` },
        });
        if (agent.status !== 201) throw new CampaignAbort(`agent ${m.key}: POST agents ${agent.status} ${agent.json?.code ?? ''}`);
        w.agentId = agent.json.agent.id;
        agents.push(w.agentId);
        const minted = await api(`/api/v1/agents/${w.agentId}/tokens`, {
          method: 'POST',
          json: { repo: `${OWNER}/${REPO}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 10_800, name: 'fleet' },
        });
        if (minted.status !== 201) throw new CampaignAbort(`agent ${m.key}: mint token ${minted.status} ${minted.json?.code ?? ''}`);
        w.token = minted.json.token;
        const created = await api(`${API}/workspaces`, { method: 'POST', token: w.token, json: { task: `fleet ${m.key}: ${m.role} work`, base: 'main' } });
        if (created.status !== 201) throw new CampaignAbort(`workspace ${m.key}: POST ${created.status} ${created.json?.code ?? ''}`);
        Object.assign(w, { id: created.json.id, ref: created.json.ref, branch: created.json.branch, baseSha: created.json.baseSha, agentName: created.json.agent, createdAt: created.json.createdAt });
        if (created.json.agentId !== w.agentId || created.json.baseSha !== seed) throw new CampaignAbort(`workspace ${m.key}: agentId/baseSha mismatch`);
        const pushed = await git(['push', '-q', GIT_URL, `${w.commit}:${w.ref}`], { cwd: local, token: w.token, network: true });
        if (pushed.code !== 0) throw new CampaignAbort(`push ${m.key}: ${pushed.err.slice(0, 200)}`);
        w.pushedAt = Date.now();
      })().catch((err) => {
        failed ??= err;
      }),
    );
  }
  await Promise.all(tasks);
  if (failed) throw failed instanceof CampaignAbort ? failed : new CampaignAbort(String(failed));
  const fleetMs = Date.now() - fleetStart;
  gate('VAL-SCALE-002', `${N} workspaces created by ${N} distinct agent principals and pushed`, new Set([...ws.values()].map((w) => w.agentId)).size === N && [...ws.values()].every((w) => w.pushedAt), `${fleetMs} ms`);
  report.fleet = { workspaces: N, burst: plan.burst.length, createAndPushMs: fleetMs, peakGitChildren: gitLim.peak, peakHttp: httpLim.peak };

  // Pins: B on A, C on B, each at the source's live head.
  const A = ws.get(plan.chain.A);
  const Bw = ws.get(plan.chain.B);
  const C = ws.get(plan.chain.C);
  const pinB = await api(`${API}/workspaces/${Bw.id}/dependencies`, { method: 'POST', json: { onWorkspace: A.id, revision: A.commit } });
  const pinC = await api(`${API}/workspaces/${C.id}/dependencies`, { method: 'POST', json: { onWorkspace: Bw.id, revision: Bw.commit } });
  gate('VAL-SCALE-003', 'pinned chain A <- B <- C created (active, depths 2 and 3)', pinB.status === 201 && pinC.status === 201 && pinB.json?.state === 'active' && pinC.json?.depth === 3, `B ${pinB.status}/${pinB.json?.depth}, C ${pinC.status}/${pinC.json?.depth}`);

  // -------------------------------------------------------------- observe
  enter('observe');
  const idToKey = new Map([...ws.values()].map((w) => [w.id, w.member.key]));
  const lastPush = Math.max(...[...ws.values()].map((w) => w.pushedAt));
  const observeStart = Date.now();
  let observed = new Map();
  while (Date.now() - observeStart < projection.opts.maxObserveMs) {
    observed = new Map();
    let cursor = null;
    do {
      const r = await api(`${API}/forecast?paths=fleet/&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (r.status !== 200) throw new CampaignAbort(`forecast ${r.status}`);
      for (const mm of r.json.matches ?? []) observed.set(mm.workspace, mm.observedHeadSha);
      cursor = r.json.nextCursor;
    } while (cursor);
    const current = [...ws.values()].filter((w) => observed.get(w.id) === w.commit).length;
    if (current === N) break;
    await sleep(projection.opts.observePollMs);
  }
  const allObserved = [...ws.values()].every((w) => observed.get(w.id) === w.commit);
  gate('VAL-SCALE-002', `the Nexus index observed all ${N} pushed heads`, allObserved, `${Date.now() - lastPush} ms after the last push (poll granularity ${projection.opts.observePollMs} ms)`);
  report.fleet.lastPushToAllObservedMs = Date.now() - lastPush;

  // -------------------------------------------------------------- pre-burst verification
  enter('verify-pre');
  const lsPre = await lsRemote();
  const expectedRefs = new Map([['refs/heads/main', seed], ...[...ws.values()].map((w) => [w.ref, w.commit])]);
  const lsDiff = diffRefs(expectedRefs, lsPre);
  gate('VAL-SCALE-002a', `git ls-remote equals the driver ledger (${expectedRefs.size} refs: main + ${N} workspace refs)`, lsDiff.length === 0, lsDiff.length ? lsDiff.slice(0, 5).join('; ') : `ls-remote ${lsPre.size} refs, diff empty`);

  const pages = [];
  const listed = [];
  let cursor = null;
  do {
    const r = await api(`${API}/workspaces?status=active&limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200) throw new CampaignAbort(`workspace list ${r.status}`);
    pages.push({ size: r.json.workspaces.length, cost: r.cost });
    listed.push(...r.json.workspaces.map((w) => w.id));
    cursor = r.json.nextCursor;
  } while (cursor && pages.length < 20);
  log(`workspace list pages (limit 30): ${pages.map((p) => `${p.size} [${p.cost}]`).join(', ')}`);
  const ledgerIds = new Set([...ws.values()].map((w) => w.id));
  gate(
    'VAL-SCALE-002b',
    `paginated workspace list stitches to exactly the ${N} campaign workspaces (no duplicates, no omissions, page <= 30)`,
    listed.length === N && new Set(listed).size === N && listed.every((id) => ledgerIds.has(id)) && pages.every((p) => p.size <= 30),
    `${pages.length} pages, ${listed.length} ids, ${new Set(listed).size} distinct`,
  );
  check('VAL-SCALE-002b', `workspace list pages within ${BUDGETS.workspaceList}`, pages.every((p) => withinBudget(parseCost(p.cost), BUDGETS.workspaceList).ok), pages.map((p) => p.cost).join(' | '));

  const overlapPages = [];
  const pairs = [];
  cursor = null;
  do {
    const r = await api(`${API}/workspaces/overlap?base=main&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (r.status !== 200) throw new CampaignAbort(`overlap ${r.status}`);
    overlapPages.push({ size: r.json.pairs.length, cost: r.cost, truncated: r.json.truncated, truncatedReason: r.json.truncatedReason ?? null, incomplete: r.json.incomplete ?? [] });
    pairs.push(...r.json.pairs.map((p) => plan.pairKey(idToKey.get(p.workspaces[0]) ?? p.workspaces[0], idToKey.get(p.workspaces[1]) ?? p.workspaces[1])));
    cursor = r.json.nextCursor;
  } while (cursor && overlapPages.length < 20);
  const pairSet = new Set(pairs);
  const missingPairs = [...plan.expectedPairs].filter((p) => !pairSet.has(p));
  const extraPairs = [...pairSet].filter((p) => !plan.expectedPairs.has(p));
  const independentKeys = new Set(plan.members.filter((m) => m.role === 'independent' || m.role === 'sentinel').map((m) => m.key));
  log(`overlap pages (limit 50): ${overlapPages.map((p) => `${p.size} pairs truncated=${p.truncated}${p.truncatedReason ? ` (${p.truncatedReason})` : ''} [${p.cost}]`).join(', ')}`);
  gate(
    'VAL-SCALE-002c',
    `overlap query returns exactly the ${plan.expectedPairs.size} crafted pairs and none of the ${independentKeys.size} independent members`,
    missingPairs.length === 0 && extraPairs.length === 0 && pairs.length === pairSet.size && ![...pairSet].some((p) => p.split('|').some((k) => independentKeys.has(k))),
    `${pairs.length} pairs; missing ${missingPairs.length}, extra ${extraPairs.length}`,
  );
  check(
    'VAL-SCALE-002c',
    'overlap truncation is explicit: every truncated page names its reason',
    overlapPages.every((p) => !p.truncated || Boolean(p.truncatedReason)),
    overlapPages.some((p) => p.truncated) ? 'truncated with reasons' : 'no page truncated (pair space within the documented caps)',
  );
  check('VAL-SCALE-002c', `overlap pages within the cost.md row ${BUDGETS.overlap}`, overlapPages.every((p) => withinBudget(parseCost(p.cost), BUDGETS.overlap).ok), overlapPages.map((p) => p.cost).join(' | '));
  const fc = await api(`${API}/forecast?paths=${encodeURIComponent(CONFIG_PATH)}&limit=100`);
  const fcMembers = forecastMemberSet({ status: fc.status, matches: fc.json?.matches, idToKey, overlapKeys: plan.overlapKeys });
  report.verifyPre = { lsRemoteRefs: lsPre.size, listPages: pages, overlapPages, overlapPairs: pairs.length, forecastMatches: fcMembers.size };
  check('VAL-SCALE-002c', `forecast within ${BUDGETS.forecast}`, withinBudget(parseCost(fc.cost), BUDGETS.forecast).ok, fc.cost ?? '');
  gate(
    'VAL-SCALE-002c',
    `forecast for ${CONFIG_PATH} names exactly the ${plan.overlapKeys.length} shared-file members`,
    fcMembers.ok,
    `${fcMembers.size} matches, status ${fc.status} [${fc.cost}]`,
  );

  // -------------------------------------------------------------- change sets
  enter('burst');
  const changeTasks = plan.burst.map((key) =>
    (async () => {
      const w = ws.get(key);
      const r = await api(`${API}/workspaces/${w.id}/change-set`, { method: 'POST', json: { title: `fleet ${key}: ${w.member.role}`, mergePolicy: 'review' } });
      if (r.status !== 201) throw new CampaignAbort(`change set ${key}: ${r.status} ${r.json?.code ?? ''}`);
      w.number = r.json.number;
      w.changeHead = r.json.headSha;
      w.changeState0 = r.json.state;
    })(),
  );
  await Promise.all(changeTasks);
  gate('VAL-SCALE-003', `${plan.burst.length} change sets opened at their pushed heads`, plan.burst.every((k) => ws.get(k).changeHead === ws.get(k).commit));

  // -------------------------------------------------------------- burst
  let enqueueDone = false;
  let pausedUntil = 0;
  let pollCancelled = false;
  const paceEnqueue = pacer(pace.enqueueIntervalMs);
  const poller = (async () => {
    const pollStart = Date.now();
    for (;;) {
      if (pollCancelled) return;
      const snap = await pollState('polls');
      burst.samples.push({ t: Date.now(), backlog: snap.backlog, merged: snap.merged });
      const settled = enqueueDone && snap.backlog === 0 && [...burst.enqueue.keys()].every((k) => {
        const c = burst.changes.get(ws.get(k).number);
        return c && c.queueState === null;
      });
      if (settled) return;
      if (Date.now() - pollStart > pace.maxBurstMs) throw new CampaignAbort(`burst did not settle within ${pace.maxBurstMs / 60_000} min`);
      await sleep(pace.pollIntervalMs);
    }
  })();
  // Waiting for the poller here (rather than only flagging it) keeps an in-flight
  // poll from overlapping the cleanup DELETE the ledger has to pay for.
  stopPoller = async () => {
    pollCancelled = true;
    await poller.catch(() => {});
  };
  let pollerFailed = null;
  poller.catch((err) => (pollerFailed = err));
  try {
    for (const key of plan.enqueueOrder) {
      const w = ws.get(key);
      for (let attempt = 0; ; attempt++) {
        if (pollerFailed) throw pollerFailed;
        await paceEnqueue();
        if (Date.now() < pausedUntil) await sleep(pausedUntil - Date.now());
        const r = await api(`${API}/changes/${w.number}/enqueue`, { method: 'POST', json: { headSha: w.commit, mergePolicy: 'review' }, handle429: true });
        if (r.status === 201) {
          burst.enqueue.set(key, { at: Date.now(), enqueuedAt: Date.parse(r.json.entry.enqueuedAt), attempts: attempt + 1, cost: r.cost, entryId: r.json.entry.id });
          break;
        }
        if (r.status === 429) {
          spendRetry('queueFull');
          const wait = retryAfterMs(r.retryAfter, 30_000, 65_000);
          pausedUntil = Date.now() + wait;
          log(`  429 ${r.json?.code ?? ''} at #${w.number} (${key}); Retry-After ${r.retryAfter}; pausing enqueues ${wait} ms`);
          if (attempt >= 10) throw new CampaignAbort(`#${w.number} refused 429 more than 10 times`);
          continue;
        }
        if (r.status === 409 && r.json?.code === 'MERGE_CONFLICT') {
          burst.enqueue.set(key, { refused: 'MERGE_CONFLICT', at: Date.now() });
          log(`  #${w.number} (${key}) already conflicted at enqueue: 409 MERGE_CONFLICT`);
          break;
        }
        throw new CampaignAbort(`enqueue #${w.number} (${key}): ${r.status} ${r.json?.code ?? ''} ${r.json?.error ?? ''}`.slice(0, 300));
      }
      if (burst.enqueue.size % 20 === 0) log(`  enqueued ${burst.enqueue.size}/${plan.burst.length}`);
    }
  } catch (err) {
    // Every early exit of this loop (including the abort above) leaves the poller
    // running; stop it here so it does not keep spending the request ledger.
    await stopPoller?.();
    throw err;
  }
  enqueueDone = true;
  log(`  all ${plan.burst.length} enqueue requests answered; waiting for the train`);
  await poller;
  stopPoller = null;
  const chainKeys = new Set([plan.chain.B, plan.chain.C]);
  const enqueueCosts = [...burst.enqueue.entries()].filter(([, e]) => e.cost).map(([k, e]) => ({ key: k, pinned: chainKeys.has(k), cost: e.cost }));
  for (const e of enqueueCosts.filter((x) => !withinBudget(parseCost(x.cost), BUDGETS.enqueue).ok)) {
    log(`  enqueue ${e.key}${e.pinned ? ' (pinned dependent)' : ''} outside ${BUDGETS.enqueue}: ${e.cost} -> ${withinBudget(parseCost(e.cost), BUDGETS.enqueue).violations.join(', ')}`);
  }
  report.enqueueCosts = enqueueCosts;
  const unpinned = enqueueCosts.filter((e) => !e.pinned);
  check('VAL-SCALE-003', `every admitted enqueue of an unpinned change within the cost.md workspace-backed row ${BUDGETS.enqueue}`, unpinned.every((e) => withinBudget(parseCost(e.cost), BUDGETS.enqueue).ok), summarizeCosts(unpinned.map((e) => e.cost)));
  log(`  pinned dependents' enqueue counters (the documented row was measured without pins): ${enqueueCosts.filter((e) => e.pinned).map((e) => `${e.key} ${e.cost}`).join(' | ')}`);

  // -------------------------------------------------------------- conflicts
  enter('resolve');
  const burstPublished = plan.burst.filter((k) => burst.changes.get(ws.get(k).number)?.state === 'merged');
  burst.windowEnd = Math.max(...burstPublished.map((k) => burst.changes.get(ws.get(k).number).mergedAtMs));
  const leftovers = plan.burst.filter((k) => burst.changes.get(ws.get(k).number)?.state !== 'merged');
  log(`burst settled: ${burstPublished.length} published, ${leftovers.length} not published (${leftovers.map((k) => `#${ws.get(k).number} ${ws.get(k).member.role} ${burst.changes.get(ws.get(k).number)?.state}`).join(', ')})`);
  const conflictKinds = {};
  for (const k of leftovers) {
    const d = await api(`${API}/changes/${ws.get(k).number}`);
    ws.get(k).detail = { state: d.json?.state, conflicts: d.json?.conflicts ?? [] };
    for (const c of d.json?.conflicts ?? []) conflictKinds[`${c.kind} conflict on ${c.path}`] = (conflictKinds[`${c.kind} conflict on ${c.path}`] ?? 0) + 1;
  }
  const conflicted = leftovers.filter((k) => ws.get(k).detail.state === 'conflicted').sort((a, b) => ws.get(a).number - ws.get(b).number);
  const toResolve = conflicted.slice(0, pace.maxResolutions);
  const resolved = [];
  for (const k of toResolve) {
    const r = await resolveConflict(k);
    if (r) resolved.push(k);
  }
  for (const k of leftovers.filter((x) => !resolved.includes(x))) {
    const w = ws.get(k);
    const reason = toResolve.includes(k) ? 'resolution attempt failed' : conflicted.includes(k) ? `conflicted beyond the ${pace.maxResolutions}-resolution cap` : `state ${w.detail.state}`;
    incomplete.push({ number: w.number, key: k, role: w.member.role, state: w.detail.state, reason, conflicts: w.detail.conflicts });
  }
  report.conflictKinds = conflictKinds;

  // -------------------------------------------------------------- final verification
  enter('verify-final');
  await pollState();
  const queueNow = await api(`${API}/queue?limit=100`);
  check('VAL-SCALE-003', 'final eligible queue is empty', queueNow.status === 200 && (queueNow.json?.entries ?? []).length === 0, `${(queueNow.json?.entries ?? []).length} active entries`);
  const accepted = plan.burst.filter((k) => burst.changes.get(ws.get(k).number)?.state === 'merged');
  const notAccepted = plan.burst.filter((k) => !accepted.includes(k));
  check('VAL-SCALE-003', 'every burst change reached a terminal state (published, or listed incomplete with a reason)', accepted.length + incomplete.length === plan.burst.length, `${accepted.length} published, ${incomplete.length} incomplete`);
  for (const i of incomplete) log(`  incomplete #${i.number} ${i.key} (${i.role}): ${i.reason}; conflicts ${JSON.stringify(i.conflicts)}`);

  // Remote D1 (read-only): queue rows and background counters, before the repo delete removes them.
  const repoSel = `(SELECT id FROM repos WHERE owner_login = '${OWNER}' AND name = '${REPO}')`;
  const [qRows, pushStats, snapStates, snapTrees, checkRows, taskRows] = wrangler(
    [
      `SELECT change_number, state, reason_code, merge_commit, previous_sha, cost, enqueued_at, updated_at, attempts, generation FROM merge_queue WHERE repo_id = ${repoSel} ORDER BY seq`,
      `SELECT COUNT(*) AS events, SUM(deliveries) AS deliveries, SUM(completed_at IS NULL) AS incomplete, CAST(AVG(completed_at - received_at) AS INTEGER) AS avgEffectMs, MAX(completed_at - received_at) AS maxEffectMs, CAST(AVG(received_at - event_at) AS INTEGER) AS avgArrivalMs, MAX(received_at - event_at) AS maxArrivalMs FROM push_events WHERE repo_id = ${repoSel}`,
      `SELECT state, COUNT(*) AS n FROM snapshot_commits WHERE repo_id = ${repoSel} GROUP BY state`,
      `SELECT state, build_cost FROM snapshot_trees WHERE repo_id = ${repoSel}`,
      `SELECT name, status, conclusion, COUNT(*) AS n FROM check_runs WHERE repo_id = ${repoSel} GROUP BY name, status, conclusion`,
      `SELECT kind, status, COUNT(*) AS n FROM agent_tasks WHERE repo_id = ${repoSel} GROUP BY kind, status`,
    ].join('; '),
  );
  d1.queue = qRows;
  d1.pushEvents = pushStats[0] ?? null;
  d1.snapshots = { commits: snapStates, trees: snapTrees.length, treeBuildCost: sumCosts(snapTrees.map((t) => safeJson(t.build_cost) ?? {})) };
  d1.checkRuns = checkRows;
  d1.tasks = taskRows;
  const published = qRows.filter((q) => q.state === 'published');
  const publishedByChange = new Map();
  for (const q of published) publishedByChange.set(q.change_number, (publishedByChange.get(q.change_number) ?? 0) + 1);
  const reasons = {};
  for (const q of qRows.filter((x) => x.state !== 'published')) reasons[`${q.state} ${q.reason_code ?? ''}`.trim()] = (reasons[`${q.state} ${q.reason_code ?? ''}`.trim()] ?? 0) + 1;
  log(`queue rows: ${qRows.length} (${published.length} published; others ${JSON.stringify(reasons)})`);
  check(
    'VAL-SCALE-003',
    'one published queue entry per accepted change and none for any other change (no lost or double publication records)',
    accepted.every((k) => publishedByChange.get(ws.get(k).number) === 1) && notAccepted.every((k) => !publishedByChange.has(ws.get(k).number)) && published.length === accepted.length,
    `${published.length} published rows for ${accepted.length} accepted changes`,
  );
  const mergeCommits = accepted.map((k) => burst.changes.get(ws.get(k).number).mergeCommit);
  check('VAL-SCALE-003', 'every accepted change has a distinct publication identity (merge commit)', new Set(mergeCommits).size === accepted.length && mergeCommits.every(Boolean), `${new Set(mergeCommits).size} distinct`);

  // Fresh clone: content and graph.
  const cloneDir = join(work, 'clone');
  await mustGit(['clone', '-q', GIT_URL, cloneDir], { network: true });
  const tip = await mustGit(['rev-parse', 'HEAD'], { cwd: cloneDir });
  const filesList = (await mustGit(['ls-files'], { cwd: cloneDir })).split('\n').filter(Boolean);
  const files = filesList.map((p) => ({ path: p, text: readFileSync(join(cloneDir, p), 'utf8') }));
  const markerExpect = new Map();
  for (const m of plan.members) {
    const ok = accepted.includes(m.key) ? 1 : 0;
    markerExpect.set(m.marker, ok);
    if (m.lineMarker) markerExpect.set(m.lineMarker, ok);
  }
  markerExpect.set(plan.identicalMarker, plan.members.some((m) => m.role === 'identical' && accepted.includes(m.key)) ? 1 : 0);
  const counts = countMarkers(files, [...markerExpect.keys()]);
  const markerBad = [...markerExpect].filter(([mk, want]) => counts.get(mk) !== want).map(([mk, want]) => `${mk}: ${counts.get(mk)} (want ${want})`);
  check(
    'VAL-SCALE-003',
    `fresh clone: each accepted change's unique marker present exactly once, none for unaccepted changes or the sentinel (${markerExpect.size} markers over ${files.length} files)`,
    markerBad.length === 0,
    markerBad.slice(0, 5).join('; ') || `main ${tip}`,
  );
  const fpRaw = await mustGit(['rev-list', '--first-parent', '--parents', 'HEAD'], { cwd: cloneDir });
  const firstParent = fpRaw.split('\n').map((l) => {
    const [sha, ...parents] = l.split(' ');
    return { sha, parents };
  });
  const prevByChange = new Map(published.map((q) => [q.change_number, q.previous_sha]));
  const acceptedPubs = accepted.map((k) => {
    const c = burst.changes.get(ws.get(k).number);
    return { number: c.number, headSha: c.headSha, mergeCommit: c.mergeCommit, previous: prevByChange.get(c.number) ?? undefined };
  });
  const graph = verifyGraph({ firstParent, seed, accepted: acceptedPubs, ledgerCommits });
  check('VAL-SCALE-003', `graph: main's first-parent history is exactly one step per accepted publication (${firstParent.length - 1} steps)`, graph.ok, graph.problems.slice(0, 5).join('; '));
  const reachable = new Set((await mustGit(['rev-list', 'HEAD'], { cwd: cloneDir })).split('\n'));
  check('VAL-SCALE-003', 'every accepted head is reachable from main', acceptedPubs.every((p) => reachable.has(p.headSha)));
  const ffCount = acceptedPubs.filter((p) => p.mergeCommit === p.headSha).length;
  const sample = acceptedPubs.filter((p) => p.mergeCommit !== p.headSha).slice(0, 3);
  for (const s of sample) log(`  graph sample #${s.number}: merge ${s.mergeCommit} parents [${firstParent.find((f) => f.sha === s.mergeCommit)?.parents.join(', ')}] (recorded previous ${s.previous}, head ${s.headSha})`);
  const pos = (k) => graph.order.indexOf(ws.get(k).number);
  check(
    'VAL-SCALE-003',
    'pinned chain published in dependency order although enqueued C, B, ..., A',
    [plan.chain.A, plan.chain.B, plan.chain.C].every((k) => accepted.includes(k)) && pos(plan.chain.A) < pos(plan.chain.B) && pos(plan.chain.B) < pos(plan.chain.C),
    `first-parent positions A ${pos(plan.chain.A)}, B ${pos(plan.chain.B)}, C ${pos(plan.chain.C)} of ${graph.order.length}`,
  );

  // Per-publication stored counters vs the documented publication row applicable to each, keyed on incoming pins as the
  // enqueue comparison is (the chain's dependents B and C carry pins; A is only a source).
  const pubCosts = published.map((q) => ({ number: q.change_number, cost: safeJson(q.cost) ?? {} }));
  const pinnedNumbers = new Set([...chainKeys].map((k) => ws.get(k).number));
  const pubs = comparePublications(pubCosts, pinnedNumbers, BUDGETS.publication);
  log(`per-publication stored counters (merge_queue.cost): unpinned ${summarizeCosts(pubCosts.filter((p) => !pinnedNumbers.has(p.number)).map((p) => p.cost))}`);
  log(`  with incoming pins: ${pubCosts.filter((p) => pinnedNumbers.has(p.number)).map((p) => `#${p.number} ${fmt(p.cost)}`).join(' | ')}`);
  for (const v of pubs.outside) log(`  outside ${v.row}: #${v.number}${v.pinned ? ' (incoming pins)' : ''} ${v.cost} -> ${v.violations.join(', ')}`);
  check(CHECK_IDS.publication, 'every per-publication stored counter set within the applicable cost.md publication row', pubs.ok, pubs.detail);
  report.publicationCosts = pubCosts.map((p) => ({ number: p.number, pinned: pinnedNumbers.has(p.number), cost: fmt(p.cost) }));
  report.publicationsOutsideRow = pubs.outside.map((v) => ({ number: v.number, pinned: v.pinned, row: v.row, cost: v.cost }));

  // Sentinel, ledger reconciliation, bootstrap.
  const sentinel = ws.get(plan.sentinel);
  const sg = await api(`${API}/workspaces/${sentinel.id}`);
  const lsEnd = await lsRemote();
  check(
    'VAL-SCALE-004a',
    `early sentinel workspace ${plan.sentinel} still active at its recorded sha (GET + ls-remote)`,
    sg.json?.status === 'active' && sg.json?.headSha === sentinel.commit && lsEnd.get(sentinel.ref) === sentinel.commit,
    `status ${sg.json?.status}, GET head ${sg.json?.headSha}, ls-remote ${lsEnd.get(sentinel.ref)}, recorded ${sentinel.commit}`,
  );
  // The platform's own attribution notes ref: one note per Kvarm merge commit and per accepted resolution commit.
  const notesSha = lsEnd.get(NOTES_REF) ?? null;
  let notesList = null;
  if (notesSha) {
    await mustGit(['fetch', '-q', 'origin', `+${NOTES_REF}:${NOTES_REF}`], { cwd: cloneDir, network: true });
    notesList = await mustGit(['notes', '--ref=kvarm-attribution', 'list'], { cwd: cloneDir });
  }
  const expectedNotes = [...acceptedPubs.filter((p) => p.mergeCommit !== p.headSha).map((p) => p.mergeCommit), ...claimWorkspaces.map((c) => c.resolution)];
  const notes = verifyNotes({ notesList, expected: expectedNotes });
  check(
    'VAL-SCALE-004c',
    `${NOTES_REF} notes exactly the ${expectedNotes.length} Kvarm merge commits and resolution commits, once each`,
    notes.ok,
    `${notes.noted} noted at ${notesSha ?? 'absent'}; missing ${notes.missing.slice(0, 3).join(', ') || 'none'}; unexpected ${notes.unexpected.slice(0, 3).join(', ') || 'none'}`,
  );
  const expectEnd = new Map([
    ['refs/heads/main', tip],
    ...[...ws.values()].map((w) => [w.ref, accepted.includes(w.member.key) ? burst.changes.get(w.number).headSha : w.commit]),
    ...claimWorkspaces.map((c) => [c.ref, c.resolution]),
    ...(notesSha && notes.ok ? [[NOTES_REF, notesSha]] : []),
  ]);
  const endDiff = diffRefs(expectEnd, lsEnd);
  check('VAL-SCALE-004c', `final ls-remote equals the ledger (${expectEnd.size} refs; no ref deleted or moved unexpectedly)`, endDiff.length === 0, endDiff.slice(0, 5).join('; ') || 'diff empty');
  const all = [];
  cursor = null;
  do {
    const r = await api(`${API}/workspaces?status=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    all.push(...(r.json?.workspaces ?? []).map((w) => ({ id: w.id, status: w.status })));
    cursor = r.json?.nextCursor;
  } while (cursor && all.length < 1000);
  const created = [
    ...[...ws.values()].map((w) => ({ id: w.id, expect: accepted.includes(w.member.key) ? 'merged' : 'active' })),
    ...claimWorkspaces.map((c) => ({ id: c.id, expect: 'active' })),
  ];
  const recon = reconcileWorkspaces({ created, abandoned: [], listed: all });
  check(
    'VAL-SCALE-004c',
    `ledger reconciliation: ${created.length} created (${N} fleet + ${claimWorkspaces.length} task-claim), 0 abandoned/deleted, every one listed with its expected status`,
    recon.ok,
    `listed ${JSON.stringify(recon.byStatus)}; missing ${recon.missing.length}, unexpected ${recon.unexpected.length}, mismatched ${recon.mismatched.length}`,
  );
  report.reconciliation = { created: created.length, ...recon };

  report.bootstrapAfter = await bootstrapSnapshot();
  check('VAL-SCALE-004b', `bootstrap data untouched (user ${OWNER}, ${OWNER}/kvarm-e2e, PAT rows)`, JSON.stringify(report.bootstrapAfter) === JSON.stringify(report.bootstrapBefore), `pats ${report.bootstrapAfter.d1.pats}, digests equal`);

  // Measured burst results.
  const lat = [...burst.enqueue.entries()]
    .filter(([k, e]) => e.enqueuedAt && accepted.includes(k) && !resolved.includes(k))
    .map(([k, e]) => burst.changes.get(ws.get(k).number).mergedAtMs - e.enqueuedAt);
  const windowStart = Math.min(...[...burst.enqueue.values()].filter((e) => e.enqueuedAt).map((e) => e.enqueuedAt));
  const windowMs = burst.windowEnd - windowStart;
  report.burst = {
    accepted: accepted.length,
    acceptedInBurstWindow: burstPublished.length,
    resolvedAndPublished: resolved.length,
    incomplete: incomplete.length,
    windowMs,
    throughputPerMin: Number((burstPublished.length / (windowMs / 60_000)).toFixed(2)),
    latencyMs: { p50: percentile(lat, 50), p90: percentile(lat, 90), max: lat.length ? Math.max(...lat) : null, samples: lat.length },
    longestIdle: longestQueueIdle(d1.queue ?? []),
    backlogMax: Math.max(0, ...burst.samples.map((s) => s.backlog)),
    backlogSamples: burst.samples.map((s) => [s.t - windowStart, s.backlog, s.merged]),
    queueFull429: retries.queueFull,
    retries: retries.http429 + retries.git429 + retries.queueFull,
    fastForwards: ffCount,
    mergeCommits: accepted.length - ffCount,
    admission: retries.queueFull
      ? `backpressure fired: ${retries.queueFull} enqueue(s) answered 429 QUEUE_FULL with Retry-After and were retried after the stated wait`
      : `no backpressure fired at this pace: the queue never reached its admission capacity of 64 active entries (max backlog ${Math.max(0, ...burst.samples.map((s) => s.backlog))})`,
  };
  log(`burst: ${JSON.stringify({ ...report.burst, backlogSamples: undefined })}`);
  check('VAL-SCALE-003', 'admission/backpressure statement recorded (429 honored or capacity not reached)', true, report.burst.admission);
  const nonoverlapLanded = plan.members.filter((m) => m.role === 'nonoverlap' && accepted.includes(m.key)).length;
  const identicalLanded = plan.members.filter((m) => m.role === 'identical' && accepted.includes(m.key)).length;
  const ejectedConflicts = qRows.filter((q) => q.state === 'ejected' && q.reason_code === 'MERGE_CONFLICT').length;
  report.conflicts = {
    'same-file edits on separate lines, landed as clean merges (both edits present)': nonoverlapLanded,
    'identical edit pair, both landed (edit present once)': identicalLanded,
    'same-line variants (genuine conflicts) in the burst': plan.members.filter((m) => m.role === 'conflict').length,
    'train ejections MERGE_CONFLICT': ejectedConflicts,
    ...Object.fromEntries(Object.entries(conflictKinds).map(([k, v]) => [`conflicted changes: ${k}`, v])),
    'resolve-conflict tasks opened': (taskRows.filter((t) => t.kind === 'resolve-conflict').reduce((s, t) => s + t.n, 0)),
    'resolved through the task flow and published': resolved.length,
    'incomplete (listed with reasons)': incomplete.length,
  };
}

async function resolveConflict(key) {
  const w = ws.get(key);
  const tasks = await api(`${API}/tasks?status=open&kind=resolve-conflict&limit=100`);
  const task = (tasks.json?.tasks ?? []).find((t) => t.change?.number === w.number);
  if (!task) {
    log(`  #${w.number}: no open resolve-conflict task`);
    return false;
  }
  const claim = await api(`${API}/tasks/${task.id}/claim`, { method: 'POST', token: w.token, json: { ttlSeconds: 600 } });
  if (claim.status !== 200) {
    log(`  #${w.number}: claim ${claim.status} ${claim.json?.code ?? ''}`);
    return false;
  }
  const claimWs = claim.json.workspace;
  const generation = claim.json.lease?.generation ?? claim.json.task?.generation;
  await mustGit(['fetch', '-q', GIT_URL, 'refs/heads/main'], { cwd: local, network: true });
  const mainSha = await mustGit(['rev-parse', 'FETCH_HEAD'], { cwd: local });
  const mainConfig = await mustGit(['show', `${mainSha}:${CONFIG_PATH}`], { cwd: local });
  const lines = (mainConfig + '\n').split('\n');
  const variant = w.member.lineText.replace(/^line \d+: /, '');
  const resolvedConfig = editLine(mainConfig + '\n', w.member.line, `${lines[w.member.line - 1]} | ${variant}`);
  const files = { ...memberFiles(plan, w.member), [CONFIG_PATH]: resolvedConfig };
  const resolution = await commitFiles(`res-${key}`, mainSha, files, `resolve #${w.number}: keep main's line ${w.member.line} and ${key}'s variant`, [w.commit]);
  ledgerCommits.add(resolution);
  const pushed = await git(['push', '-q', GIT_URL, `${resolution}:${claimWs.ref}`], { cwd: local, token: w.token, network: true });
  if (pushed.code !== 0) {
    log(`  #${w.number}: resolution push failed: ${pushed.err.slice(0, 200)}`);
    return false;
  }
  claimWorkspaces.push({ id: claimWs.id, ref: claimWs.ref, resolution, number: w.number });
  const done = await api(`${API}/tasks/${task.id}/complete`, { method: 'POST', token: w.token, json: { generation, sha: resolution } });
  if (done.status !== 200) {
    log(`  #${w.number}: complete ${done.status} ${done.json?.code ?? ''} ${done.json?.error ?? ''}`.slice(0, 300));
    return false;
  }
  const enq = await api(`${API}/changes/${w.number}/enqueue`, { method: 'POST', json: { headSha: resolution, mergePolicy: 'review' } });
  if (enq.status !== 201) {
    log(`  #${w.number}: re-enqueue ${enq.status} ${enq.json?.code ?? ''}`);
    return false;
  }
  burst.enqueue.set(key, { ...burst.enqueue.get(key), reenqueuedAt: Date.parse(enq.json.entry.enqueuedAt) });
  const t0 = Date.now();
  while (Date.now() - t0 < projection.opts.resolutionWaitMs) {
    await sleep(pace.pollIntervalMs);
    const c = await api(`${API}/changes/${w.number}`);
    if (c.json?.state === 'merged') {
      burst.changes.set(w.number, toChange(c.json));
      log(`  #${w.number} (${key}) resolved via task ${task.id} (generation ${generation}) by ${w.agentName}, published ${c.json.mergeCommit} in ${Date.now() - t0} ms after re-enqueue`);
      return true;
    }
  }
  log(`  #${w.number}: not published within ${projection.opts.resolutionWaitMs} ms after the resolution`);
  return false;
}

function toChange(c) {
  return { number: c.number, state: c.state, queueState: c.queueState ?? null, headSha: c.headSha, mergeCommit: c.mergeCommit, mergedAtMs: c.mergedAt ? Date.parse(c.mergedAt) : null };
}

async function pollState(label = stage) {
  let cursor = null;
  let merged = 0;
  do {
    const r = await api(`${API}/changes?state=all&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { label });
    if (r.status !== 200) throw new CampaignAbort(`changes list ${r.status}`);
    for (const c of r.json.changes) burst.changes.set(c.number, toChange(c));
    cursor = r.json.nextCursor;
  } while (cursor);
  for (const c of burst.changes.values()) if (c.state === 'merged') merged++;
  const q = await api(`${API}/queue?limit=100`, { label });
  return { backlog: (q.json?.entries ?? []).length, merged };
}

async function lsRemote() {
  const out = await mustGit(['ls-remote', GIT_URL], { network: true });
  const refs = new Map();
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    if (ref !== 'HEAD') refs.set(ref, sha);
  }
  return refs;
}

function diffRefs(expected, actual) {
  const diff = [];
  for (const [ref, sha] of expected) if (actual.get(ref) !== sha) diff.push(`${ref}: ledger ${sha}, remote ${actual.get(ref) ?? 'absent'}`);
  for (const ref of actual.keys()) if (!expected.has(ref)) diff.push(`${ref}: not in ledger`);
  return diff;
}

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : (s ?? null);
  } catch {
    return null;
  }
}
const fmt = (c) =>
  Object.entries(c)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
function summarizeCosts(list) {
  const parsed = list.map((c) => (typeof c === 'string' ? parseCost(c) : c));
  const keys = [...new Set(parsed.flatMap((c) => Object.keys(c).filter((k) => typeof c[k] === 'number')))];
  return keys.map((k) => `${k} ${Math.min(...parsed.map((c) => c[k] ?? 0))}..${Math.max(...parsed.map((c) => c[k] ?? 0))}`).join(', ') + ` (n=${parsed.length})`;
}

async function cleanup() {
  enter('cleanup');
  const out = { agentsRevoked: 0, agentRevokeFailures: [], repoDelete: null, repoGetAfter: null };
  for (const id of agents) {
    try {
      const r = await api(`/api/v1/agents/${id}`, { method: 'DELETE' });
      if (r.status === 200 && r.json?.agent?.status === 'revoked') out.agentsRevoked++;
      else out.agentRevokeFailures.push(`${id}: ${r.status}`);
    } catch (err) {
      out.agentRevokeFailures.push(`${id}: ${String(err).slice(0, 100)}`);
    }
  }
  check('VAL-SCALE-004b', `revoked every agent this run created (${agents.length})`, out.agentsRevoked === agents.length, out.agentRevokeFailures.slice(0, 3).join('; '));
  if (repoCreated && !opts.keep) {
    try {
      const del = await api(API, { method: 'DELETE' });
      const after = await api(API);
      out.repoDelete = del.status;
      out.repoGetAfter = after.status;
      check('VAL-SCALE-004b', `deleted only the repo this run created (${OWNER}/${REPO}): DELETE then owner GET 404`, del.status >= 200 && del.status < 300 && after.status === 404, `DELETE ${del.status}, GET ${after.status}`);
    } catch (err) {
      // Like the agent revocations above: a failed delete is recorded, not thrown,
      // so the report still carries the rest of the cleanup result.
      out.repoDeleteError = String(err?.message ?? err).slice(0, 200);
      check('VAL-SCALE-004b', `deleted only the repo this run created (${OWNER}/${REPO}): DELETE then owner GET 404`, false, out.repoDeleteError);
    }
  } else if (repoCreated) log(`kept ${OWNER}/${REPO} (--keep)`);
  return out;
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  abortedAt = { stage, reason: err instanceof CeilingExceeded ? `ceiling breach: ${err.message}` : String(err?.message ?? err) };
  log(`\nABORTED at ${stage}: ${abortedAt.reason}`);
  exitCode = 1;
} finally {
  try {
    // Before the cleanup DELETE: a poller still running would spend the request
    // ledger that delete needs, and the repo would be left behind.
    await stopPoller?.();
    report.cleanup = await cleanup();
  } catch (err) {
    log(`cleanup error: ${String(err?.message ?? err)}`);
    exitCode = 1;
  }
  stageMs[stage] = (stageMs[stage] ?? 0) + (Date.now() - stageStart);
}

// ---------------------------------------------------------------- report

report.run.finishedAt = new Date().toISOString();
report.abortedAt = abortedAt;
report.incomplete = incomplete;
report.stageMs = stageMs;
report.requests = {
  projected: projection.total,
  observed: ledger.total,
  byKind: ledger.byKind,
  byStage: Object.fromEntries(
    [...new Set([...projection.items.map((i) => i.stage), ...Object.keys(ledger.byLabel)])].map((s) => [
      s,
      { projected: projection.items.filter((i) => i.stage === s).reduce((a, i) => a + i.requests, 0), observed: ledger.byLabel[s] ?? 0 },
    ]),
  ),
  peakHttpInFlight: httpLim.peak,
  peakGitChildren: gitLim.peak,
  retries,
  outOfBandD1Reads: d1Reads,
};
report.counters = Object.fromEntries(
  [...counters.entries()].sort().map(([k, v]) => [k, { count: v.count, statuses: v.statuses, sum: sumCosts(v.costs) }]),
);
report.background = {
  'push events (D1 push_events)': d1.pushEvents?.events ?? 'n/a',
  'push event deliveries': d1.pushEvents?.deliveries ?? 'n/a',
  'push event arrival after the Artifacts event, avg / max ms': d1.pushEvents ? `${d1.pushEvents.avgArrivalMs} / ${d1.pushEvents.maxArrivalMs}` : 'n/a',
  'push event effects completion after arrival, avg / max ms': d1.pushEvents ? `${d1.pushEvents.avgEffectMs} / ${d1.pushEvents.maxEffectMs}` : 'n/a',
  'queue entries (published / other)': d1.queue ? `${d1.queue.filter((q) => q.state === 'published').length} / ${d1.queue.filter((q) => q.state !== 'published').length}` : 'n/a',
  'summed stored per-publication counters (merge_queue.cost)': d1.queue ? sumCosts(d1.queue.filter((q) => q.state === 'published').map((q) => safeJson(q.cost) ?? {})) : 'n/a',
  'check runs recorded': d1.checkRuns ? d1.checkRuns.reduce((s, r) => s + r.n, 0) : 'n/a',
  'snapshot commits (by state)': d1.snapshots ? d1.snapshots.commits.map((s) => `${s.state} ${s.n}`).join(', ') || '0' : 'n/a',
  'snapshot tree builds, summed build counters': d1.snapshots ? `${d1.snapshots.trees}: ${fmt(d1.snapshots.treeBuildCost)}` : 'n/a',
};
report.d1 = d1;
report.checks = results;
report.passed = results.filter((r) => r.ok).length;
report.failed = results.filter((r) => !r.ok).length;
report.fleet ??= { workspaces: N, burst: plan.burst.length };
report.fleet.overlapPairs = report.verifyPre?.overlapPairs ?? null;

log('\n## projected vs observed harness requests');
for (const [s, v] of Object.entries(report.requests.byStage)) log(`  ${s.padEnd(13)} projected ${String(v.projected).padStart(5)}  observed ${String(v.observed).padStart(5)}`);
log(`  total         projected ${String(projection.total).padStart(5)}  observed ${String(ledger.total).padStart(5)}  (ceiling ${limits.ceiling}; peak HTTP ${httpLim.peak}/${limits.httpInFlight}, peak git children ${gitLim.peak}/${limits.gitChildren}; retries ${JSON.stringify(retries)}; out-of-band read-only D1 queries ${d1Reads})`);
log('\n## x-kvarm-cost by endpoint class (summed)');
for (const [k, v] of Object.entries(report.counters)) log(`  ${k}: ${v.count} × ${JSON.stringify(v.statuses)}  ${fmt(v.sum)}`);
log('\n## server-side background work (separate from the harness ceiling)');
for (const [k, v] of Object.entries(report.background)) log(`  ${k}: ${typeof v === 'object' ? fmt(v) : v}`);
log('\nWork counters are application telemetry, not a Cloudflare bill.');

report.notes = [
  ...(report.enqueueCosts ?? [])
    .filter((e) => e.pinned)
    .map((e) => `Pinned dependent ${e.key} enqueue counters \`${e.cost}\` (the cost.md workspace-backed enqueue row was measured on unpinned changes).`),
  ...Object.entries(
    (report.publicationsOutsideRow ?? []).reduce((acc, v) => {
      const k = `${v.pinned ? 'with-incoming-pins' : 'unpinned'} \`${v.cost}\` publication(s) outside the publication row ${v.row ?? BUDGETS.publication.unpinned}`;
      (acc[k] ??= []).push(`#${v.number}`);
      return acc;
    }, {}),
  ).map(([k, nums]) => `${nums.length} ${k}: ${nums.slice(0, 12).join(', ')}${nums.length > 12 ? ', …' : ''}.`),
  ...gitReadFailures.map((f) => `Read-only git ${f.op} failed at ${f.stage} (attempt ${f.attempt}) and was retried: ${f.error.split('\n')[0].slice(0, 160)}`),
  ...incomplete.map((i) => `Incomplete #${i.number} (${i.key}, ${i.role}): ${i.reason}.`),
];
const json = JSON.stringify(report, null, 2);
const complete = Boolean(report.burst) && !abortedAt;
const draftMd = complete ? renderBenchmarkMarkdown(report) : null;
const monetary = [...findMonetary(json), ...(draftMd ? findMonetary(draftMd) : []), ...findMonetary(transcript.join('\n'))];
check(CHECK_IDS.monetary, MONETARY_CHECK, monetary.length === 0, monetary.slice(0, 3).join(', '));
report.checks = results;
report.passed = results.filter((r) => r.ok).length;
report.failed = results.filter((r) => !r.ok).length;
const md = complete ? renderBenchmarkMarkdown(report) : null;
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(outDir, 'transcript.log'), transcript.join('\n') + '\n');
if (md) writeFileSync(join(outDir, 'fleet-100.md'), md);
// A completed run is the measurement whatever its checks say; the table states every failed check.
if (opts['write-benchmark'] && md) {
  const dir = join(ROOT, 'docs/benchmarks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fleet-100.md'), md);
  writeFileSync(join(dir, 'fleet-100.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`benchmark written: docs/benchmarks/fleet-100.md, docs/benchmarks/fleet-100.json${report.failed ? ` (${report.failed} failed checks listed in it)` : ''}`);
}
console.log(`\nreport: ${join(outDir, 'report.json')}  transcript: ${join(outDir, 'transcript.log')}`);
console.log(`${report.passed}/${results.length} checks passed${abortedAt ? `; ABORTED at ${abortedAt.stage}` : ''}`);
if (!opts.out) rmSync(join(work, 'local'), { recursive: true, force: true });
rmSync(join(work, 'clone'), { recursive: true, force: true });
process.exit(exitCode || (report.failed ? 1 : 0));
