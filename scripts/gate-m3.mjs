#!/usr/bin/env node
/**
 * M3 performance gate on the 1M-line fixture (VAL-DIFF-008, -017, -021..024)
 * plus the cold-compare budget edge (first-ever compare whose base is not
 * the head's first parent, with a cold upstream read token).
 *
 *   cold    10 sequential `GET compare/bench-base...bench-head?nocache=1` with
 *           the admin PAT, timed with `curl -w %{time_total} --max-time 30`;
 *           pass when all are 200 + `x-kvarm-cache: bypass` and p50 < 500 ms.
 *           The bypass reads no compare cache entry (body, risk, ref, commit
 *           or line counts), so every run is a full cold computation
 *   spot    the same URL anonymously and as KVARM_PAT_BOT: served normally,
 *           never `bypass`
 *   order   files are path-ascending and `?order=path` is identical
 *   wide    `compare/wide-base...wide-head`: complete (totalsComplete true),
 *           or truncated with a reason and totalsComplete false (totals cover
 *           the listed subset); statsOmitted with no per-file stats
 *   files   the ~60k-line interleaved file (approximate, < 30 s, < 10 MB) and
 *           the largest file (< 10 s, < 1 MB, totals = generator record)
 *   warm    one normal compare issued twice: the second is a cache hit with an
 *           identical body
 *   sweep   every response above is 2xx within the 30 s client timeout
 *   edge    fresh repo m3-fixture-1m-gate-edge-<ts>: push main and a diverged
 *           topic, then the very first request is the compare. The push warmed
 *           the write token, so the +4 cold off-chain/no-token exception does
 *           not apply: art <= treeReads + blobReads + 3 and d1 <= 2. Only the
 *           repo created by this run is deleted (scripts/lib/fixture-repo.mjs)
 *
 * Usage (from the repo root, after `node scripts/fixture-1m.mjs`):
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/gate-m3.mjs [--repo=fixture-1m] [--runs=10] [--skip-edge] [--json=out.json]
 *
 * Tokens reach curl on stdin (`-K -`) and git through a secret-free
 * GIT_ASKPASS helper with `-c credential.helper=`; they are never printed.
 * Exit 0 only when every check passes.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
const REPO = arg('repo', 'fixture-1m');
const RUNS = Number(arg('runs', '10'));
const JSON_OUT = arg('json', null);
const SKIP_EDGE = process.argv.includes('--skip-edge');
const P = { admin: 'KVARM_PAT', bot: 'KVARM_PAT_BOT' };
for (const k of Object.values(P)) if (!process.env[k]) throw new Error(`env ${k} is not set (load apps/platform/.dev.vars.validation)`);
const root = fileURLToPath(new URL('..', import.meta.url));
const expected = JSON.parse(readFileSync(resolve(root, arg('expected', 'docs/benchmarks/fixture-1m.json')), 'utf8'));

const work = mkdtempSync(join(tmpdir(), 'gate-m3-'));
const results = [];
const sweep = [];
function check(label, ok, detail = '') {
  results.push({ ok: !!ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  return !!ok;
}

function costOf(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = k === 'cache' ? v : Number(v);
  }
  return out;
}

let seq = 0;
/** One curl GET, timed by curl itself; the body is kept on disk and parsed when JSON. */
function get(path, who = null, { label = path, inSweep = true } = {}) {
  const n = seq++;
  const bodyFile = join(work, `b${n}`);
  const headFile = join(work, `h${n}`);
  const args = ['-s', '-K', '-', '-o', bodyFile, '-D', headFile, '-w', '%{http_code} %{time_total} %{size_download}', '--max-time', '30', `${BASE}${path}`];
  const input = who ? `header = "Authorization: Bearer ${process.env[P[who]]}"\n` : '';
  const r = spawnSync('curl', args, { input, encoding: 'utf8' });
  const [code, time, size] = (r.stdout ?? '').trim().split(' ');
  const headers = {};
  try {
    for (const line of readFileSync(headFile, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
    }
  } catch {
    // no headers on a transport failure
  }
  let text = '';
  try {
    text = readFileSync(bodyFile, 'utf8');
  } catch {
    // no body
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON
  }
  const res = {
    label,
    status: Number(code) || 0,
    seconds: Number(time),
    bytes: Number(size),
    timedOut: r.status === 28,
    curlExit: r.status,
    cache: headers['x-kvarm-cache'] ?? null,
    cost: headers['x-kvarm-cost'] ?? null,
    timing: headers['server-timing'] ?? null,
    text,
    body,
  };
  if (inSweep) sweep.push(res);
  return res;
}

const api = (rest, repo = REPO) => `/api/v1/repos/${OWNER}/${repo}/${rest}`;
const show = (r) => `${r.status} ${(r.seconds * 1000).toFixed(0)} ms ${r.bytes} B cache=${r.cache} [${r.cost}] {${r.timing}}`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const summary = { at: new Date().toISOString(), base: BASE, repo: `${OWNER}/${REPO}`, refs: expected.refs };

// ---------------------------------------------------------------------------

function coldGate() {
  const path = api('compare/bench-base...bench-head?nocache=1');
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = get(path, 'admin', { label: `cold ${i + 1}` });
    runs.push(r);
    console.log(`#   cold ${String(i + 1).padStart(2)}: ${show(r)}`);
  }
  const times = runs.map((r) => r.seconds);
  const p50 = median(times);
  summary.cold = {
    runs: runs.map((r) => ({ seconds: r.seconds, status: r.status, cache: r.cache, cost: r.cost, timing: r.timing, bytes: r.bytes })),
    p50Seconds: p50,
    minSeconds: Math.min(...times),
    maxSeconds: Math.max(...times),
  };
  const first = runs[0]?.body ?? {};
  summary.cold.body = { files: first.files?.length, truncated: first.truncated, totalsComplete: first.totalsComplete, statsOmitted: first.statsOmitted, treeReads: first.treeReads, blobReads: first.blobReads };
  check(`VAL-DIFF-022 ${RUNS} cold compares all 200 + x-kvarm-cache: bypass`, runs.every((r) => r.status === 200 && r.cache === 'bypass'));
  check(`VAL-DIFF-022 cold p50 ${(p50 * 1000).toFixed(0)} ms < 500 ms (min ${(Math.min(...times) * 1000).toFixed(0)}, max ${(Math.max(...times) * 1000).toFixed(0)})`, p50 < 0.5);
  check(
    `cold body lists every bench file: files=${first.files?.length} (expected ${expected.bench.files}) truncated=${first.truncated} totalsComplete=${first.totalsComplete} statsOmitted=${first.statsOmitted}`,
    first.files?.length === expected.bench.files && first.truncated === false && first.totalsComplete === true && first.statsOmitted === true,
  );
  const cost = costOf(runs[0]?.cost);
  check(`cold cost within budget: art=${cost.art} <= treeReads ${first.treeReads} + blobReads ${first.blobReads} + 3, d1=${cost.d1} <= 2`,
    cost.art <= first.treeReads + first.blobReads + 3 && cost.d1 <= 2);
  return first;
}

function spotChecks() {
  const path = api('compare/bench-base...bench-head?nocache=1');
  for (const who of [null, 'bot']) {
    const r = get(path, who, { label: `spot ${who ?? 'anon'}` });
    check(`VAL-DIFF-022 ${who ?? 'anonymous'} ?nocache=1 served normally (no bypass): ${show(r)}`, r.status === 200 && r.cache !== 'bypass');
  }
}

function orderChecks(cold) {
  const paths = (cold.files ?? []).map((f) => f.path);
  const sorted = [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  check('VAL-DIFF-008 bench files are path-ascending', paths.length > 0 && paths.every((p, i) => p === sorted[i]));
  const r = get(api('compare/bench-base...bench-head?order=path'), 'admin', { label: 'order=path' });
  const ordered = (r.body?.files ?? []).map((f) => f.path);
  check(`VAL-DIFF-008 ?order=path identical order: ${show(r)}`, r.status === 200 && ordered.length === paths.length && ordered.every((p, i) => p === paths[i]));
}

function wideCheck() {
  const r = get(api('compare/wide-base...wide-head'), 'admin', { label: 'wide' });
  const b = r.body ?? {};
  const files = b.files ?? [];
  const honest =
    b.truncated === true
      ? typeof b.truncatedReason === 'string' && b.truncatedReason.length > 0 && files.length < expected.wide.changedPaths && b.totalsComplete === false
      : files.length === expected.wide.changedPaths && b.totalsComplete === true;
  summary.wide = { seconds: r.seconds, status: r.status, bytes: r.bytes, files: files.length, expected: expected.wide.changedPaths, truncated: b.truncated, truncatedReason: b.truncatedReason, totalsComplete: b.totalsComplete, statsOmitted: b.statsOmitted, treeReads: b.treeReads, totals: b.totals, cost: r.cost, cache: r.cache };
  check(
    `VAL-DIFF-021 wide pair: files=${files.length}/${expected.wide.changedPaths} truncated=${b.truncated} reason="${b.truncatedReason ?? ''}" totalsComplete=${b.totalsComplete} statsOmitted=${b.statsOmitted} totals.files=${b.totals?.files} ${show(r)}`,
    r.status === 200 && !r.timedOut && honest && b.statsOmitted === true && files.every((f) => f.additions === undefined && f.deletions === undefined) && b.totals?.files === files.length,
  );
}

function fileChecks() {
  const mix = expected.bench.interleaved;
  const m = get(api(`compare/bench-base...bench-head/file?path=${encodeURIComponent(mix.path)}`), 'admin', { label: 'interleaved' });
  summary.interleaved = { seconds: m.seconds, status: m.status, bytes: m.bytes, approximate: m.body?.approximate, truncated: m.body?.truncated, totalAdditions: m.body?.totalAdditions, totalDeletions: m.body?.totalDeletions, gitNumstat: { additions: mix.additions, deletions: mix.deletions }, cost: m.cost, cache: m.cache };
  check(
    `VAL-DIFF-017 ${mix.path} (${mix.lines} lines): approximate=${m.body?.approximate} +${m.body?.totalAdditions}/-${m.body?.totalDeletions} (git +${mix.additions}/-${mix.deletions}) ${show(m)}`,
    m.status === 200 && m.body?.approximate === true && m.body?.totalAdditions > 0 && m.body?.totalDeletions > 0 && m.seconds < 30 && m.bytes < 10 * 1024 * 1024,
  );
  const big = expected.bench.largest;
  const l = get(api(`compare/bench-base...bench-head/file?path=${encodeURIComponent(big.path)}`), 'admin', { label: 'largest' });
  summary.largest = { seconds: l.seconds, status: l.status, bytes: l.bytes, totalAdditions: l.body?.totalAdditions, totalDeletions: l.body?.totalDeletions, expected: { additions: big.additions, deletions: big.deletions }, cost: l.cost, cache: l.cache };
  check(
    `VAL-DIFF-024 ${big.path} (${big.lines} lines, ${big.bytes} B): +${l.body?.totalAdditions}/-${l.body?.totalDeletions} (generator +${big.additions}/-${big.deletions}) ${show(l)}`,
    l.status === 200 && l.seconds < 10 && l.bytes < 1024 * 1024 && l.body?.totalAdditions === big.additions && l.body?.totalDeletions === big.deletions,
  );
}

function warmChecks() {
  const path = api('compare/bench-base...bench-head');
  const one = get(path, 'admin', { label: 'warm 1' });
  const two = get(path, 'admin', { label: 'warm 2' });
  summary.warm = [one, two].map((r) => ({ seconds: r.seconds, status: r.status, cache: r.cache, cost: r.cost }));
  check(`VAL-DIFF-023 warm repeat is a cache hit with an identical body: ${one.cache} -> ${two.cache} ${show(two)}`,
    one.status === 200 && two.status === 200 && two.cache === 'hit' && two.text === one.text);
  const c = costOf(two.cost);
  check(`warm compare cost d1=${c.d1} <= 1, art=${c.art}, do=${c.do}, sub=${c.sub}`, c.d1 <= 1 && c.art === 0 && c.do === 0 && c.sub === 0);
}

function sweepCheck() {
  const bad = sweep.filter((r) => r.status < 200 || r.status >= 300 || r.timedOut || r.seconds >= 30);
  summary.sweep = sweep.map((r) => ({ label: r.label, status: r.status, seconds: r.seconds }));
  check(`VAL-DIFF-023 sweep of ${sweep.length} fixture requests: zero non-2xx, zero timeouts, all < 30 s`, bad.length === 0, bad.map((r) => `${r.label}:${r.status}/${r.seconds}s`).join(' '));
}

// ---------------------------------------------------------------------------
// Budget edge: first-ever compare, base off the head's first parent, cold read token
// ---------------------------------------------------------------------------

const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv GATE_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', GATE_GIT_TOKEN: process.env.KVARM_PAT };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function rest(path, { method = 'GET', json } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${process.env.KVARM_PAT}` } };
  if (json) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, text: await res.text() };
}

async function edgeCheck() {
  const name = `m3-fixture-1m-gate-edge-${Date.now()}`;
  const run = await withFixtureRepo({ owner: OWNER, repo: name, prefix: 'm3-fixture-1m-gate', http: rest, log: console.log }, async () => {
    check(`edge: create ${OWNER}/${name} (new, created by this run)`, true);
    const dir = join(work, 'edge');
    mkdirSync(dir);
    git(['init', '-q', '-b', 'main'], dir);
    const commitFile = (content) => {
      writeFileSync(join(dir, 'e.txt'), content);
      // Tree diffs are cached by tree hash across repos, so every run needs
      // trees no earlier run produced for the compare to be truly cold.
      writeFileSync(join(dir, 'keep.txt'), `${name}\n`);
      git(['add', '-A'], dir);
      git(['commit', '-q', '-m', content.trim()], dir);
      return git(['rev-parse', 'HEAD'], dir).out;
    };
    const c1 = commitFile('one\n');
    const c2 = commitFile('two\n');
    git(['checkout', '-q', '-b', 'topic', c1], dir);
    const c3 = commitFile('three\n');
    // Push only: it warms the write token in this colo, never the read token.
    const pushed = git(['push', '-q', `${BASE}/${OWNER}/${name}.git`, 'main', 'topic'], dir);
    if (!check('edge: push main (c1 -> c2) and topic (c1 -> c3)', pushed.code === 0, pushed.err.slice(0, 200))) return;
    const r = get(api('compare/main...topic', name), 'admin', { label: 'edge first-ever', inSweep: false });
    const b = r.body ?? {};
    const c = costOf(r.cost);
    summary.edge = { repo: `${OWNER}/${name}`, base: c2, head: c3, headParent: c1, status: r.status, cache: r.cache, cost: r.cost, treeReads: b.treeReads, blobReads: b.blobReads, budget: (b.treeReads ?? 0) + (b.blobReads ?? 0) + 3 };
    check(
      `edge: first-ever compare main...topic (base ${c2.slice(0, 7)} is not head ${c3.slice(0, 7)}'s parent ${c1.slice(0, 7)}): art=${c.art} <= treeReads ${b.treeReads} + blobReads ${b.blobReads} + 3, d1=${c.d1} <= 2 ${show(r)}`,
      r.status === 200 && b.base?.sha === c2 && b.head?.sha === c3 && r.cache === 'miss' && c.art <= b.treeReads + b.blobReads + 3 && c.d1 <= 2,
    );
  });
  if (!run.ok) check(`edge: refusing to run: ${run.reason}`, false);
}

// ---------------------------------------------------------------------------

try {
  console.log(`# ${summary.at} ${BASE} ${OWNER}/${REPO} bench-head=${expected.refs['bench-head'].sha.slice(0, 12)}`);
  const cold = coldGate();
  spotChecks();
  orderChecks(cold);
  wideCheck();
  fileChecks();
  warmChecks();
  sweepCheck();
  if (!SKIP_EDGE) await edgeCheck();
} catch (err) {
  check(`driver error: ${err?.stack ?? err}`, false);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
summary.checks = results;
if (JSON_OUT) writeFileSync(resolve(JSON_OUT), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`\n# ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
