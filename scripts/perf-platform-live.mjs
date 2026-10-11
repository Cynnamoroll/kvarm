#!/usr/bin/env node
/**
 * Bounded live measurement for the platform performance sweep (VAL-PERF-001..003).
 * Setup only: one fresh public repo seeded with the fleet shape
 * (scripts/lib/fleet.mjs planFleet, 100 workspaces), no change burst.
 *
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   . "$HOME/.config/vite-plus/env"     # wrangler: read-only remote D1 reads and the train tail
 *   node scripts/perf-platform-live.mjs [--workspaces 100] [--only nexus,snapshot,changes,train] [--keep] [--out <dir>]
 *
 * Sections:
 *   nexus     100 workspaces (created with FORGE_PAT, agent label per member), pushed in
 *             batches of refspecs; once the Nexus index observed every head: every overlap
 *             page (base=main, limit 50) and the forecast probes (popular exact path,
 *             popular path paged at limit 5, the fleet/ prefix range), three samples each,
 *             with their x-forge-cost rr against the pre-fix baseline (overlap 1061/page,
 *             forecast 150) and the cost.md rows.
 *   snapshot  main's snapshot downloaded twice by commit: the first fills the repo-scoped
 *             cache (r2b=1), the second is a hit (r2b=0, same bytes, same etag = tree).
 *   changes   EXPLAIN QUERY PLAN of the state=all list statement on remote D1 (read-only)
 *             and the list's rr before and after the train adds changes.
 *   train     pins B->A, C->B, C->A (C carries two incoming pins), change sets for A, B, C
 *             and 8 independent members, enqueued 4 s apart (independents first, then C, B, A)
 *             under `wrangler tail`; records each enqueue-kick and continue-kick delivery
 *             latency, the per-pass train counters and each publication's stored cost.
 *
 * Limits: one process, <= 3 git children, <= 5 HTTP in flight, 429/Retry-After honored,
 * a 2,000-request ceiling. git uses `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS reading the token from the child's environment; no token is
 * printed. The repo `<owner>/perf-platform-live-<ts>` is deleted at the end (owner GET 404
 * readback) unless --keep. Exit 0 when every check held, 1 otherwise, 2 on usage errors.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG_PATH, createLimiter, memberFiles, parseCost, planFleet, retryAfterMs } from './lib/fleet.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLATFORM = join(ROOT, 'apps/platform');
const BASELINE = { overlap: 1061, forecast: 150 };
const ROWS = { overlapRr: 80, forecastRr: 80, publicationRr: 12 };
const CEILING = 2000;
const REQUEST_TIMEOUT_MS = 90_000;

const { values: opts } = parseArgs({
  options: {
    workspaces: { type: 'string', default: '100' },
    only: { type: 'string', default: 'nexus,snapshot,changes,train' },
    keep: { type: 'boolean', default: false },
    out: { type: 'string' },
    'push-batch': { type: 'string', default: '10' },
  },
});
const N = Number(opts.workspaces);
const ONLY = new Set(opts.only.split(','));
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
const PAT = process.env.FORGE_PAT;
if (!PAT) {
  console.error('perf-platform-live: FORGE_PAT is not set (set -a; . apps/platform/.dev.vars.validation; set +a)');
  process.exit(2);
}
if (!Number.isInteger(N) || N < 16) {
  console.error('perf-platform-live: --workspaces must be an integer >= 16');
  process.exit(2);
}
const TS = Math.floor(Date.now() / 1000);
const REPO = `perf-platform-live-${TS}`;
const API = `/api/v1/repos/${OWNER}/${REPO}`;
const GIT_URL = `${BASE}/${OWNER}/${REPO}.git`;
const work = mkdtempSync(join(tmpdir(), 'perf-platform-live-'));
const outDir = opts.out ?? join(work, 'report');
mkdirSync(outDir, { recursive: true });
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(id, label, ok, detail = '') {
  results.push({ id, label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return Boolean(ok);
}
const report = { repo: `${OWNER}/${REPO}`, startedAt: new Date().toISOString(), workspaces: N };

// ---------------------------------------------------------------- transport

const httpLim = createLimiter(5);
const gitLim = createLimiter(3);
let requests = 0;
function reserve(n) {
  if (requests + n > CEILING) throw new Error(`request ceiling ${CEILING} reached`);
  requests += n;
}

async function http(path, { method = 'GET', json, token = PAT, binary = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    reserve(1);
    const t0 = Date.now();
    const out = await httpLim.run(async () => {
      const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
      if (json !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(json);
      }
      let res;
      let buf;
      try {
        res = await fetch(`${BASE}${path}`, init);
        buf = new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        return { status: 0, error: String(err?.cause ?? err).slice(0, 200), json: null, bytes: null, headers: new Headers(), cost: '' };
      }
      let body = null;
      if (!binary) {
        try {
          body = JSON.parse(new TextDecoder().decode(buf));
        } catch {
          body = null;
        }
      }
      return { status: res.status, json: body, bytes: binary ? buf : null, headers: res.headers, cost: res.headers.get('x-forge-cost') ?? '' };
    });
    out.ms = Date.now() - t0;
    if (out.status === 0 || out.ms > 30_000) {
      (report.slowRequests ??= []).push({ method, path: path.replace(API, '…'), ms: out.ms, status: out.status, error: out.error ?? null, at: new Date(t0).toISOString() });
      console.log(`  slow/failed request: ${method} ${path.replace(API, '…')} ${out.status} after ${out.ms} ms${out.error ? ` (${out.error})` : ''}`);
    }
    if (out.status === 0 && method === 'GET' && attempt < 3) continue;
    if (out.status === 429 && attempt < 6) {
      const wait = retryAfterMs(out.headers.get('retry-after'), 5000, 65_000);
      console.log(`  429 on ${method} ${path.replace(API, '…')}; waiting ${wait} ms`);
      await sleep(wait);
      continue;
    }
    if (out.status >= 500 && method === 'GET' && attempt < 3) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    return out;
  }
}

async function git(args, { cwd = work, network = false, input, env = {}, token = PAT } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (network) reserve(4);
    const r = await gitLim.run(
      () =>
        new Promise((resolve) => {
          const child = spawn('git', ['-c', 'credential.helper=', ...args], {
            cwd,
            env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: token, ...env },
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
      console.log(`  git 429 on ${args[0]}; waiting 60 s`);
      await sleep(60_000);
      continue;
    }
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.err.slice(0, 300)}`);
    return r.out;
  }
}

function d1(sql) {
  const r = spawnSync('wrangler', ['d1', 'execute', 'forge', '--remote', '--json', '--command', sql], {
    cwd: PLATFORM,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return JSON.parse(r.stdout).map((x) => x.results ?? []);
}

/** A response header (`d1=2;rr=9`) or a stored merge_queue.cost JSON object. */
const costOf = (cost) => (typeof cost === 'string' && cost.trim().startsWith('{') ? JSON.parse(cost) : parseCost(cost));
const rrOf = (cost) => costOf(cost).rr ?? null;
const summarize = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? { n: s.length, min: s[0], p50: s[Math.floor((s.length - 1) / 2)], max: s[s.length - 1] } : { n: 0 };
};

/** Splits concatenated (possibly pretty-printed) JSON objects, as `wrangler tail --format json` writes them. */
function splitJsonStream(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // a partial object at the tail's start or end
        }
        start = -1;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- state

const plan = planFleet({ workspaces: N, ts: TS });
const ws = new Map();
let local = '';
let seed = '';
let repoCreated = false;
let agentId = null;
let agentToken = null;

async function setup() {
  console.log(`\n## setup  ${OWNER}/${REPO} (${N} workspaces), work dir ${work}`);
  const exists = await http(API);
  if (exists.status !== 404) throw new Error(`${REPO} already exists (${exists.status})`);
  const made = await http('/api/v1/repos', { method: 'POST', json: { name: REPO, visibility: 'public' } });
  if (made.status !== 201) throw new Error(`repo create ${made.status}`);
  repoCreated = true;
  local = join(work, 'local');
  mkdirSync(join(local, 'shared'), { recursive: true });
  mkdirSync(join(local, 'iface'));
  await git(['init', '-q', '-b', 'main'], { cwd: local });
  writeFileSync(join(local, 'README.md'), `# ${REPO}\n\nScratch repo of one perf-platform-live run.\n`);
  writeFileSync(join(local, CONFIG_PATH), plan.config);
  writeFileSync(join(local, 'iface/README.md'), 'pinned interface chain a <- b <- c\n');
  await git(['add', '-A'], { cwd: local });
  await git(['commit', '-q', '-m', 'perf seed'], { cwd: local });
  seed = await git(['rev-parse', 'HEAD'], { cwd: local });
  await git(['push', '-q', GIT_URL, 'main:refs/heads/main'], { cwd: local, network: true });
  console.log(`seed ${seed}`);

  for (const m of plan.members) {
    let parent = seed;
    if (m.chain === 'B') parent = ws.get(plan.chain.A).commit;
    if (m.chain === 'C') parent = ws.get(plan.chain.B).commit;
    const files = memberFiles(plan, m);
    const env = { GIT_INDEX_FILE: join(work, `index-${m.key}`) };
    await git(['read-tree', parent], { cwd: local, env });
    for (const [path, content] of Object.entries(files)) {
      const blob = await git(['hash-object', '-w', '--stdin'], { cwd: local, input: content });
      await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { cwd: local, env });
    }
    const tree = await git(['write-tree'], { cwd: local, env });
    const commit = await git(['commit-tree', tree, '-p', parent, '-m', `${m.key}: ${m.role} work`], { cwd: local });
    ws.set(m.key, { member: m, commit });
  }

  // Human credentials may not write refs/heads/agents/*, so one agent principal owns every workspace.
  const agent = await http('/api/v1/agents', { method: 'POST', json: { name: `perf-live-${TS}`, description: 'perf-platform-live fixture agent' } });
  if (agent.status !== 201) throw new Error(`agent create ${agent.status} ${agent.json?.code ?? ''}`);
  agentId = agent.json.agent.id;
  const minted = await http(`/api/v1/agents/${agentId}/tokens`, {
    method: 'POST',
    json: { repo: `${OWNER}/${REPO}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 7200, name: 'perf-live' },
  });
  if (minted.status !== 201) throw new Error(`agent token ${minted.status} ${minted.json?.code ?? ''}`);
  agentToken = minted.json.token;

  // Workspace creation is a write: paced under the per-credential write limit.
  const t0 = Date.now();
  for (const m of plan.members) {
    const created = await http(`${API}/workspaces`, { method: 'POST', token: agentToken, json: { task: `perf ${m.key}: ${m.role}`, base: 'main' } });
    if (created.status !== 201) throw new Error(`workspace ${m.key}: ${created.status} ${created.json?.code ?? ''}`);
    Object.assign(ws.get(m.key), { id: created.json.id, ref: created.json.ref });
    await sleep(600);
  }
  console.log(`created ${ws.size} workspaces in ${Date.now() - t0} ms`);
  const batch = Math.max(1, Number(opts['push-batch']));
  const all = [...ws.values()];
  const t1 = Date.now();
  for (let i = 0; i < all.length; i += batch) {
    await git(['push', '-q', GIT_URL, ...all.slice(i, i + batch).map((w) => `${w.commit}:${w.ref}`)], { cwd: local, network: true, token: agentToken });
  }
  report.setup = { createMs: t1 - t0, pushMs: Date.now() - t1, pushBatch: batch };
  console.log(`pushed ${all.length} workspace refs in batches of ${batch} in ${Date.now() - t1} ms`);

  const t2 = Date.now();
  let seen = 0;
  const trajectory = [];
  while (Date.now() - t2 < 300_000) {
    const observed = new Map();
    let cursor = null;
    do {
      const r = await http(`${API}/forecast?paths=fleet/&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (r.status !== 200) throw new Error(`forecast ${r.status}`);
      for (const mm of r.json.matches ?? []) observed.set(mm.workspace, mm.observedHeadSha);
      cursor = r.json.nextCursor;
    } while (cursor);
    seen = all.filter((w) => observed.get(w.id) === w.commit).length;
    trajectory.push([Date.now() - t2, seen]);
    if (seen === N) break;
    await sleep(4000);
  }
  report.setup.observedMs = Date.now() - t2;
  report.setup.observeTrajectory = trajectory;
  check('setup', `the Nexus index observed all ${N} pushed heads`, seen === N, `${seen}/${N} after ${Date.now() - t2} ms`);
}

// ---------------------------------------------------------------- nexus

async function nexus() {
  console.log('\n## nexus');
  const idToKey = new Map([...ws.values()].map((w) => [w.id, w.member.key]));
  const samples = { overlap: [], forecastExact: [], forecastPaged: [], forecastPrefix: [] };
  let pairs = new Set();
  let truncatedWithoutReason = 0;
  for (let s = 0; s < 3; s++) {
    pairs = new Set();
    let cursor = null;
    let pages = 0;
    do {
      const r = await http(`${API}/workspaces/overlap?base=main&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (r.status !== 200) throw new Error(`overlap ${r.status}`);
      samples.overlap.push({ sample: s, page: pages, pairs: r.json.pairs.length, cost: r.cost, truncated: r.json.truncated });
      if (r.json.truncated && !r.json.truncatedReason) truncatedWithoutReason++;
      for (const p of r.json.pairs) pairs.add(plan.pairKey(idToKey.get(p.workspaces[0]), idToKey.get(p.workspaces[1])));
      cursor = r.json.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    const ex = await http(`${API}/forecast?paths=${encodeURIComponent(CONFIG_PATH)}&limit=100`);
    samples.forecastExact.push({ sample: s, matches: ex.json?.matches?.length, cost: ex.cost, truncated: ex.json?.truncated });
    let fcur = null;
    const pagedIds = [];
    let fpages = 0;
    do {
      const r = await http(`${API}/forecast?paths=${encodeURIComponent(CONFIG_PATH)}&limit=5${fcur ? `&cursor=${encodeURIComponent(fcur)}` : ''}`);
      samples.forecastPaged.push({ sample: s, page: fpages, matches: r.json?.matches?.length, cost: r.cost });
      pagedIds.push(...(r.json?.matches ?? []).map((mm) => mm.workspace));
      fcur = r.json?.nextCursor;
      fpages++;
    } while (fcur && fpages < 10);
    const pre = await http(`${API}/forecast?paths=fleet/&limit=100`);
    samples.forecastPrefix.push({ sample: s, matches: pre.json?.matches?.length, cost: pre.cost, truncated: pre.json?.truncated });
    if (s === 0) {
      check('VAL-PERF-001', `forecast paged at limit 5 stitches to the ${plan.overlapKeys.length} shared-file members`, new Set(pagedIds).size === plan.overlapKeys.length && pagedIds.length === plan.overlapKeys.length, `${pagedIds.length} ids over ${fpages} pages`);
    }
  }
  const missing = [...plan.expectedPairs].filter((p) => !pairs.has(p));
  const extra = [...pairs].filter((p) => !plan.expectedPairs.has(p));
  check('VAL-PERF-001', `overlap returns exactly the ${plan.expectedPairs.size} crafted pairs`, missing.length === 0 && extra.length === 0, `${pairs.size} pairs, missing ${missing.length}, extra ${extra.length}`);
  check('VAL-PERF-001', 'overlap truncation stays explicit', truncatedWithoutReason === 0);
  const ovRr = samples.overlap.map((x) => rrOf(x.cost));
  const exRr = samples.forecastExact.map((x) => rrOf(x.cost));
  check('VAL-PERF-001', `forecast ${CONFIG_PATH} names the ${plan.overlapKeys.length} shared-file members`, samples.forecastExact.every((x) => x.matches === plan.overlapKeys.length && !x.truncated));
  check('VAL-PERF-001', `overlap rr per page <= ${ROWS.overlapRr} (baseline ${BASELINE.overlap}/page)`, ovRr.every((v) => v !== null && v <= ROWS.overlapRr), JSON.stringify(summarize(ovRr)));
  check('VAL-PERF-001', `forecast popular-path rr <= ${ROWS.forecastRr} (baseline ${BASELINE.forecast})`, exRr.every((v) => v !== null && v <= ROWS.forecastRr), JSON.stringify(summarize(exRr)));
  const d1s = [...samples.overlap, ...samples.forecastExact, ...samples.forecastPaged, ...samples.forecastPrefix].map((x) => costOf(x.cost).d1);
  console.log(`overlap pages: ${samples.overlap.map((x) => `s${x.sample}p${x.page} ${x.pairs} pairs [${x.cost}]`).join(' | ')}`);
  console.log(`forecast exact: ${samples.forecastExact.map((x) => `[${x.cost}]`).join(' | ')}`);
  console.log(`forecast paged (limit 5): ${samples.forecastPaged.map((x) => `s${x.sample}p${x.page} ${x.matches} [${x.cost}]`).join(' | ')}`);
  console.log(`forecast prefix fleet/ (limit 100): ${samples.forecastPrefix.map((x) => `${x.matches} truncated=${x.truncated} [${x.cost}]`).join(' | ')}`);
  report.nexus = { samples, d1: summarize(d1s), overlapRr: summarize(ovRr), forecastExactRr: summarize(exRr), forecastPagedRr: summarize(samples.forecastPaged.map((x) => rrOf(x.cost))), forecastPrefixRr: summarize(samples.forecastPrefix.map((x) => rrOf(x.cost))) };
}

// ---------------------------------------------------------------- snapshot

async function snapshot() {
  console.log('\n## snapshot');
  const t0 = Date.now();
  let meta = null;
  while (Date.now() - t0 < 180_000) {
    meta = await http(`${API}/snapshots/main`);
    if (meta.status === 200 && meta.json?.state === 'ready') break;
    if (meta.status === 202 && meta.json?.state === 'absent') await http(`${API}/snapshots/main`, { method: 'POST' });
    await sleep(3000);
  }
  if (meta?.status !== 200) {
    check('VAL-PERF-003', 'main snapshot ready', false, `${meta?.status} ${meta?.json?.state}`);
    return;
  }
  const sha = meta.json.sha;
  const first = await http(`${API}/snapshots/${sha}/download`, { binary: true });
  const second = await http(`${API}/snapshots/${sha}/download`, { binary: true });
  const third = await http(`${API}/snapshots/main/download`, { binary: true });
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  console.log(`download 1 ${first.status} ${first.bytes.length} B [${first.cost}] etag ${first.headers.get('etag')}`);
  console.log(`download 2 ${second.status} ${second.bytes.length} B [${second.cost}] etag ${second.headers.get('etag')}`);
  console.log(`download by ref ${third.status} ${third.bytes.length} B [${third.cost}]`);
  const c1 = parseCost(first.cost);
  const c2 = parseCost(second.cost);
  const c3 = parseCost(third.cost);
  check('VAL-PERF-003', 'the first download streams from R2 (r2b=1) and the repeat is a cache hit (r2b=0, art=0)', c1.r2b === 1 && c2.r2b === 0 && c2.art === 0 && c2.cache === 'hit', `${first.cost} -> ${second.cost}`);
  check('VAL-PERF-003', 'cache hit: same bytes, same etag (tree), d1 <= 1', same(first.bytes, second.bytes) && first.headers.get('etag') === second.headers.get('etag') && c2.d1 <= 1, `etag ${second.headers.get('etag')}`);
  check('VAL-PERF-003', 'download by ref name hits the same entry', c3.r2b === 0 && same(first.bytes, third.bytes), third.cost);
  report.snapshot = { sha, size: first.bytes.length, etag: second.headers.get('etag'), miss: first.cost, hit: second.cost, byRef: third.cost, missMs: first.ms, hitMs: second.ms };
}

// ---------------------------------------------------------------- changes

const LIST_ALL_SQL = (repoId) => `EXPLAIN QUERY PLAN SELECT c.id, c.repo_id, c.number, c.title, c.body, c.base_ref, c.head_ref, c.head_sha, c.base_sha,
       c.state, c.author_id, u.login AS author_login, c.agent_meta, c.merge_commit, c.merged_at, c.created_at,
       c.updated_at, c.merge_policy, c.risk_score, c.risk_level, c.risk_reasons, c.kind, c.source_change_id, c.conflicts,
       (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queue_state,
       (SELECT w.id FROM workspaces w WHERE w.change_set_id = c.id LIMIT 1) AS workspace_id
  FROM change_sets c LEFT JOIN users u ON u.id = c.author_id WHERE c.repo_id = '${repoId}' AND c.number < 9007199254740991 ORDER BY c.number DESC LIMIT 31`;

async function changesList(label) {
  const r = await http(`${API}/changes?state=all&limit=30`);
  console.log(`changes state=all (${label}): ${r.status} ${r.json?.changes?.length} changes [${r.cost}]`);
  return { label, count: r.json?.changes?.length ?? null, cost: r.cost };
}

async function changesExplain() {
  console.log('\n## changes');
  const [[repoRow]] = d1(`SELECT id FROM repos WHERE owner_login = '${OWNER}' AND name = '${REPO}'`);
  const [qp] = d1(LIST_ALL_SQL(repoRow.id));
  const lines = qp.map((p) => p.detail);
  console.log(`EXPLAIN QUERY PLAN (remote D1):\n  ${lines.join('\n  ')}`);
  const main = lines.find((l) => l.startsWith('SEARCH c ')) ?? '';
  check('VAL-PERF-003', 'state=all searches change_sets by the (repo_id, number) index with no temp B-tree sort', /USING (COVERING )?INDEX \S+ \(repo_id=\? AND number<\?\)/.test(main) && !lines.some((l) => /TEMP B-TREE/.test(l)), main);
  report.changes = { plan: lines, lists: [await changesList('before train')] };
}

// ---------------------------------------------------------------- train

function startTail() {
  const file = join(outDir, 'tail.jsonl');
  const stream = createWriteStream(file);
  const child = spawn(join(ROOT, 'node_modules/.bin/wrangler'), ['tail', 'forge-platform', '--format', 'json'], { cwd: PLATFORM, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream);
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  return {
    file,
    async stop() {
      await sleep(8000);
      child.kill('SIGINT');
      await new Promise((r) => child.once('close', r));
      stream.end();
      return err;
    },
  };
}

async function train() {
  console.log('\n## train');
  const A = ws.get(plan.chain.A);
  const B = ws.get(plan.chain.B);
  const C = ws.get(plan.chain.C);
  const pins = [
    await http(`${API}/workspaces/${B.id}/dependencies`, { method: 'POST', json: { onWorkspace: A.id, revision: A.commit } }),
    await http(`${API}/workspaces/${C.id}/dependencies`, { method: 'POST', json: { onWorkspace: B.id, revision: B.commit } }),
    await http(`${API}/workspaces/${C.id}/dependencies`, { method: 'POST', json: { onWorkspace: A.id, revision: A.commit } }),
  ];
  check('VAL-PERF-002', 'pins B->A, C->B, C->A created (C carries two incoming pins)', pins.every((p) => p.status === 201), pins.map((p) => `${p.status} ${p.json?.code ?? p.json?.state ?? ''}`).join(', '));
  const independents = plan.members.filter((m) => m.role === 'independent').slice(0, 8).map((m) => m.key);
  const keys = [...independents, plan.chain.C, plan.chain.B, plan.chain.A];
  for (const key of keys) {
    const w = ws.get(key);
    const r = await http(`${API}/workspaces/${w.id}/change-set`, { method: 'POST', json: { title: `perf ${key}`, mergePolicy: 'review' } });
    if (r.status !== 201) throw new Error(`change set ${key}: ${r.status} ${r.json?.code ?? ''}`);
    w.number = r.json.number;
  }
  const tail = startTail();
  await sleep(10_000);
  const enqueues = [];
  for (const key of keys) {
    const w = ws.get(key);
    const r = await http(`${API}/changes/${w.number}/enqueue`, { method: 'POST', json: { headSha: w.commit, mergePolicy: 'review' } });
    enqueues.push({ key, number: w.number, status: r.status, code: r.json?.code ?? null, enqueuedAt: Date.parse(r.json?.entry?.enqueuedAt ?? ''), respondedAt: Date.now(), cost: r.cost });
    await sleep(4000);
  }
  check('VAL-PERF-002', `${keys.length} enqueues admitted`, enqueues.every((e) => e.status === 201), enqueues.filter((e) => e.status !== 201).map((e) => `${e.key} ${e.status} ${e.code}`).join(', '));
  const t0 = Date.now();
  const numbers = new Set(enqueues.map((e) => e.number));
  let merged = new Map();
  while (Date.now() - t0 < 360_000) {
    const r = await http(`${API}/changes?state=all&limit=100`);
    merged = new Map((r.json?.changes ?? []).filter((c) => numbers.has(c.number) && c.state === 'merged').map((c) => [c.number, c]));
    if (merged.size === numbers.size) break;
    await sleep(4000);
  }
  const tailErr = await tail.stop();
  check('VAL-PERF-002', `all ${numbers.size} changes published`, merged.size === numbers.size, `${merged.size}/${numbers.size} in ${Date.now() - t0} ms after the last enqueue`);

  const [[repoRow]] = d1(`SELECT id FROM repos WHERE owner_login = '${OWNER}' AND name = '${REPO}'`);
  const [qRows] = d1(`SELECT q.change_number, q.state, q.cost, q.enqueued_at, q.updated_at FROM merge_queue q WHERE q.repo_id = '${repoRow.id}' ORDER BY q.seq`);
  const pinCount = new Map([
    [B.number, 1],
    [C.number, 2],
  ]);
  const pubs = qRows.map((q) => ({ number: q.change_number, state: q.state, pins: pinCount.get(q.change_number) ?? 0, cost: q.cost }));
  for (const p of pubs) console.log(`  publication #${p.number} (${p.pins} incoming pins) ${p.state} [${p.cost}]`);
  const multi = pubs.find((p) => p.pins === 2);
  const multiRr = multi ? rrOf(multi.cost) : null;
  check('VAL-PERF-002', `the two-pin publication (C) within the publication row rr<=${ROWS.publicationRr}`, multiRr !== null && multiRr <= ROWS.publicationRr, multi?.cost ?? 'missing');

  // Kick delivery from the tail: queue invocations carrying a train log line.
  const events = splitJsonStream(readFileSync(tail.file, 'utf8'));
  const trainLines = [];
  for (const ev of events) {
    if (!ev?.event?.queue) continue;
    for (const l of ev.logs ?? []) {
      const msg = Array.isArray(l.message) ? l.message[0] : l.message;
      if (typeof msg !== 'string' || !msg.includes('"train"')) continue;
      try {
        const parsed = JSON.parse(msg);
        if (parsed.train) trainLines.push({ invokedAt: ev.eventTimestamp, loggedAt: l.timestamp, ...parsed });
      } catch {
        // not a consumer line
      }
    }
  }
  trainLines.sort((a, b) => a.loggedAt - b.loggedAt);
  const enqueueKicks = trainLines.filter((t) => t.train.reason === 'enqueue');
  const enqueueLatency = [];
  const used = new Set();
  for (const e of enqueues.filter((x) => Number.isFinite(x.enqueuedAt))) {
    const hit = enqueueKicks.find((t, i) => !used.has(i) && t.invokedAt >= e.enqueuedAt - 1000 && (used.add(i), true));
    if (hit) enqueueLatency.push(hit.invokedAt - e.enqueuedAt);
  }
  const continueLatency = [];
  for (let i = 1; i < trainLines.length; i++) {
    if (trainLines[i].train.reason !== 'continue') continue;
    const prev = trainLines.slice(0, i).reverse().find((t) => t.loggedAt <= trainLines[i].invokedAt);
    if (prev) continueLatency.push(trainLines[i].invokedAt - prev.loggedAt);
  }
  const passCosts = trainLines.flatMap((t) => t.train.passCosts ?? []);
  const reasons = {};
  for (const t of trainLines) reasons[t.train.reason] = (reasons[t.train.reason] ?? 0) + 1;
  console.log(`tail: ${events.length} events, ${trainLines.length} train lines ${JSON.stringify(reasons)}${tailErr ? `; tail stderr ${tailErr.slice(0, 200)}` : ''}`);
  console.log(`enqueue-kick delivery ms: ${JSON.stringify(summarize(enqueueLatency))} ${JSON.stringify(enqueueLatency)}`);
  console.log(`continue-kick delivery ms: ${JSON.stringify(summarize(continueLatency))} ${JSON.stringify(continueLatency)}`);
  const per = (k) => summarize(passCosts.map((c) => c[k] ?? 0));
  console.log(`per-pass counters (${passCosts.length} passes): d1 ${JSON.stringify(per('d1'))} rr ${JSON.stringify(per('rr'))} art ${JSON.stringify(per('art'))} sub ${JSON.stringify(per('sub'))}`);
  check('VAL-PERF-002', 'train-kick delivery measured over the window', enqueueLatency.length > 0, `${enqueueLatency.length} enqueue kicks, ${continueLatency.length} continue kicks`);
  report.train = {
    enqueues,
    publications: pubs,
    tailEvents: events.length,
    trainLines: trainLines.map((t) => ({ invokedAt: t.invokedAt, loggedAt: t.loggedAt, cost: t.cost, train: t.train })),
    reasons,
    enqueueKickMs: { ...summarize(enqueueLatency), samples: enqueueLatency },
    continueKickMs: { ...summarize(continueLatency), samples: continueLatency },
    perPass: { passes: passCosts.length, d1: per('d1'), rr: per('rr'), art: per('art'), sub: per('sub') },
  };
  report.changes ??= { lists: [] };
  report.changes.lists.push(await changesList('after train'));
}

// ---------------------------------------------------------------- run

let failure = null;
try {
  await setup();
  if (ONLY.has('nexus')) await nexus();
  if (ONLY.has('snapshot')) await snapshot();
  if (ONLY.has('changes')) await changesExplain();
  if (ONLY.has('train')) await train();
} catch (err) {
  failure = err;
  console.error(`ABORT: ${String(err?.stack ?? err).slice(0, 600)}`);
} finally {
  // The readback decides: a DELETE whose reply was lost may still have removed the repo.
  if (repoCreated && !opts.keep) {
    const del = await http(API, { method: 'DELETE' });
    const gone = await http(API);
    check('cleanup', `deleted ${OWNER}/${REPO} (owner GET 404)`, gone.status === 404, `DELETE ${del.status}${del.error ? ` (${del.error})` : ''}, GET ${gone.status}`);
  } else if (repoCreated) console.log(`kept ${OWNER}/${REPO}`);
  if (agentId) {
    const r = await http(`/api/v1/agents/${agentId}`, { method: 'DELETE' });
    check('cleanup', `revoked the fixture agent ${agentId}`, r.status === 200 && r.json?.agent?.status === 'revoked', `DELETE ${r.status}${r.error ? ` (${r.error})` : ''}`);
  }
  report.requests = requests;
  report.checks = results;
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks held; ${requests} requests; report ${join(outDir, 'report.json')}`);
  process.exit(failure || failed.length ? 1 : 0);
}
