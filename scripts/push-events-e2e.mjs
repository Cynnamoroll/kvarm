#!/usr/bin/env node
/**
 * Live validation driver for the queue push dispatcher (VAL-EVENT-001, 003,
 * 004 live half, 005).
 *
 * As KVARM_USER (KVARM_PAT) it creates a public repo, pushes a seed commit and
 * waits for its Artifacts push event to be processed (GET .../events). Then:
 *
 * - VAL-EVENT-001/003: pushes commit A, polls GET /api/v1/repos/:o/:r until
 *   pushedAt is strictly later (≤ 10 s) and anonymous info/refs until it
 *   advertises A (≤ 2 s), then waits for the queue to complete the event.
 * - VAL-EVENT-004: pushes B, force-pushes back to A, then forward to B again,
 *   waiting for each event and then polling GET .../snapshots/main every 2 s
 *   until it is 200 ready for the pushed sha (≤ 120 s). {sha,size,files,builtAt}
 *   recorded at A and B must come back unchanged after B→A and after the
 *   repeated A→B (reuse, not rebuild). The two genuine A→B transitions must
 *   appear as two distinct, completed event rows; the repeat snapshot effects
 *   reuse the deterministic snapshot instance instead of creating new ones.
 *   ls-remote shows B at the end and no request in the cycle returns 5xx.
 * - VAL-EVENT-005: creates an orphan Artifacts repo with wrangler (no D1 row),
 *   pushes to it directly with a wrangler-issued token, checks the platform
 *   answers 404 for it, then pushes C to the platform repo and requires
 *   pushedAt to move, the event to complete with a snapshot effect and
 *   snapshots/main to reach ready for C within 120 s.
 *
 * With --tail it also runs `wrangler tail` and prints the consumer's
 * per-message {cost, outcome} lines.
 *
 * Tokens come from env by NAME (load .env.local) and
 * are never printed; git runs with `-c credential.helper=` and a secret-free
 * GIT_ASKPASS helper. Commits use the configured git identity. Wrangler must
 * be on PATH (`. "$HOME/.config/vite-plus/env"`).
 *
 * Usage: node scripts/push-events-e2e.mjs [--tail] [--keep]
 * Exit 0 when every expectation held, 1 otherwise. The platform repo and the
 * orphan Artifacts repo are deleted at the end unless --keep.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeAskpass } from './lib/live.mjs';

const { values: args } = parseArgs({
  options: { tail: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false } },
});
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
if (!process.env.KVARM_PAT) throw new Error('env KVARM_PAT is not set');
const PLATFORM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'platform');
const PUSHED_AT_BOUND_MS = 10000;
const REFS_BOUND_MS = 2000;
const EVENT_LIMIT_MS = 60000;
const ZERO = '0'.repeat(40);

const ts = Date.now();
const REPO = `m4-push-dispatcher-${ts}`;
const ORPHAN = `val-orphans-${ts}`;
const REFS = `/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`;

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const statuses = [];
async function http(path, { method = 'GET', headers = {}, body, auth } = {}) {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${process.env.KVARM_PAT}`;
  const init = { method, headers: h, redirect: 'manual' };
  if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  statuses.push(res.status);
  return { status: res.status, text, header: res.headers.get('x-kvarm-cost') };
}
const api = (method, path, json) =>
  http(`/api/v1${path}`, {
    method,
    auth: true,
    headers: json === undefined ? {} : { 'content-type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

const work = mkdtempSync(join(tmpdir(), 'push-events-'));
const askpass = writeAskpass(work);

function git(dir, gitArgs, token = process.env.KVARM_PAT) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: token };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...gitArgs], { cwd: dir, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function wrangler(wargs) {
  const r = spawnSync('npx', ['wrangler', ...wargs], { cwd: PLATFORM_DIR, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function commit(dir, label) {
  writeFileSync(join(dir, 'README.md'), `# ${label}\n\n${label}-${Date.now()}\n`);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', label]);
  return git(dir, ['rev-parse', 'HEAD']).out;
}

async function push(dir, refspec, force = false) {
  for (let i = 0; i < 10; i++) {
    const r = git(dir, ['push', '-q', ...(force ? ['-f'] : []), 'origin', refspec]);
    if (r.code === 0 || !/503|warming|429/i.test(r.err)) return { ...r, doneAt: Date.now() };
    await sleep(3000);
  }
  return { ...git(dir, ['push', '-q', ...(force ? ['-f'] : []), 'origin', refspec]), doneAt: Date.now() };
}

/** The repo's `pushedAt` as epoch ms (the API answers ISO 8601; null stays null). */
async function pushedAt() {
  const r = await api('GET', `/repos/${OWNER}/${REPO}`);
  const v = r.status === 200 ? JSON.parse(r.text).repo?.pushedAt ?? null : null;
  return typeof v === 'string' ? Date.parse(v) : null;
}

async function events() {
  const r = await api('GET', `/repos/${OWNER}/${REPO}/events?limit=100`);
  return { ...r, list: r.status === 200 ? JSON.parse(r.text).events : [] };
}

/** Waits for a completed event for before→after that is not already in `seen`. */
async function waitEvent(before, after, t0, seen) {
  for (;;) {
    const r = await events();
    const hit = r.list.find((e) => e.before === before && e.after === after && e.completedAt && !seen.has(e.id));
    const at = Date.now() - t0;
    if (hit) {
      seen.add(hit.id);
      return { event: hit, at, header: r.header };
    }
    if (at > EVENT_LIMIT_MS) return { event: null, at, header: r.header };
    await sleep(500);
  }
}

const SNAPSHOT_BOUND_MS = 120000;
const pick = (b) => b && { sha: b.sha, size: b.size, files: b.files, builtAt: b.builtAt };

/** Polls GET .../snapshots/main every 2 s until 200 ready for `sha`; returns {sha,size,files,builtAt}. */
async function snapshotReady(label, sha, t0) {
  let last = '';
  for (;;) {
    const r = await api('GET', `/repos/${OWNER}/${REPO}/snapshots/main`);
    const body = r.status === 200 || r.status === 202 ? JSON.parse(r.text) : null;
    const at = Date.now() - t0;
    const line = `${r.status} ${body?.state ?? ''} ${body?.sha?.slice(0, 7) ?? ''}`;
    if (line !== last) console.log(`#   ${label} snapshots/main poll ${at} ms: ${line} (${r.header})`);
    last = line;
    if (r.status === 200 && body.state === 'ready' && body.sha === sha) {
      const meta = pick(body);
      check(`${label} snapshots/main ready for ${sha.slice(0, 7)} within ${SNAPSHOT_BOUND_MS} ms (${at} ms) ${JSON.stringify(meta)}`, true, true);
      return { meta, body };
    }
    if (r.status >= 500 || r.status === 404 || r.status === 409 || at > SNAPSHOT_BOUND_MS) {
      check(`${label} snapshots/main ready for ${sha.slice(0, 7)} within ${SNAPSHOT_BOUND_MS} ms`, `${r.status} ${r.text.slice(0, 200)}`, () => false);
      return { meta: null, body };
    }
    await sleep(2000);
  }
}

function snapshotDetail(event) {
  const s = event?.effects?.find((f) => f.effect === 'snapshot');
  return s ? `${s.state}:${s.detail ?? ''}` : '(none)';
}

/** Pushes, then requires the queue to complete the matching event; prints the row. */
async function pushAndWait(label, dir, refspec, before, after, seen, force = false) {
  const p = await push(dir, refspec, force);
  check(`${label} git push${force ? ' -f' : ''} ${before.slice(0, 7)}→${after.slice(0, 7)}`, p.code, 0);
  const w = await waitEvent(before, after, p.doneAt, seen);
  check(`${label} queue completed the event in ${w.at} ms (events ${w.header})`, w.event !== null, true);
  if (w.event) {
    const lag = Date.parse(w.event.receivedAt) - Date.parse(w.event.eventAt);
    console.log(`#   ${label} event ${w.event.id.slice(0, 12)} eventAt=${w.event.eventAt} receivedAt=${w.event.receivedAt} (+${lag} ms) deliveries=${w.event.deliveries} effects=${JSON.stringify(w.event.effects.map((f) => `${f.effect}:${f.state}:${f.detail ?? ''}`))}`);
  }
  return { ...p, event: w.event };
}

let tail = null;
let tailOut = '';
if (args.tail) {
  // Spawn the binary itself (not npx) so killing it does not orphan a child tail.
  tail = spawn(join(PLATFORM_DIR, '..', '..', 'node_modules', '.bin', 'wrangler'), ['tail', 'kvarm-platform', '--format', 'json'], { cwd: PLATFORM_DIR });
  tail.stdout.on('data', (d) => (tailOut += d));
  tail.stderr.on('data', () => {});
  await sleep(8000);
}

let created = false;
let orphanCreated = false;
const dir = join(work, 'repo');
mkdirSync(dir);
const seen = new Set();
try {
  const c = await api('POST', '/repos', { name: REPO, visibility: 'public' });
  created = check(`create public ${OWNER}/${REPO}`, c.status, 201);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', `${BASE}/${OWNER}/${REPO}.git`]);

  const seed = commit(dir, 'seed');
  await pushAndWait('seed', dir, 'main', ZERO, seed, seen);

  // ---- VAL-EVENT-001 / 003 ----
  const before = await pushedAt();
  check('pushedAt recorded before the push', before, (v) => Number.isFinite(v));
  const a = commit(dir, 'A');
  const pa = await push(dir, 'main');
  check(`push A ${a.slice(0, 7)}`, pa.code, 0);
  const t0 = pa.doneAt;
  let refsAt = Infinity;
  let pushedAtAt = Infinity;
  let after = before;
  while (Date.now() - t0 <= PUSHED_AT_BOUND_MS && (refsAt === Infinity || pushedAtAt === Infinity)) {
    if (refsAt === Infinity) {
      const r = await http(REFS);
      if (r.status === 200 && r.text.includes(a)) refsAt = Date.now() - t0;
    }
    if (pushedAtAt === Infinity) {
      after = await pushedAt();
      if (Number.isFinite(after) && after > before) pushedAtAt = Date.now() - t0;
    }
  }
  console.log(`#   pushedAt before=${new Date(before).toISOString()} after=${new Date(after).toISOString()}`);
  check(`VAL-EVENT-001 pushedAt strictly later within ${PUSHED_AT_BOUND_MS} ms (${pushedAtAt} ms)`, pushedAtAt, (v) => v <= PUSHED_AT_BOUND_MS);
  check(`VAL-EVENT-003 info/refs advertises A within ${REFS_BOUND_MS} ms (${refsAt} ms)`, refsAt, (v) => v <= REFS_BOUND_MS);
  const wa = await waitEvent(seed, a, t0, seen);
  check(`queue completed seed→A in ${wa.at} ms`, wa.event !== null, true);
  check('seed→A snapshot effect created', snapshotDetail(wa.event), (s) => s.startsWith('done:created'));
  const snapA = await snapshotReady('step 1 (A)', a, t0);

  // ---- VAL-EVENT-004: A→B, B→A, A→B ----
  const b = commit(dir, 'B');
  const ab1 = await pushAndWait('A→B #1', dir, 'main', a, b, seen);
  check('A→B #1 snapshot effect created', snapshotDetail(ab1.event), (s) => s.startsWith('done:created'));
  const snapB = await snapshotReady('step 2 (B)', b, ab1.doneAt);
  check('A and B snapshots are distinct builds', snapA.meta?.builtAt !== snapB.meta?.builtAt && snapA.meta?.sha !== snapB.meta?.sha, true);
  const ba = await pushAndWait('B→A', dir, `${a}:refs/heads/main`, b, a, seen, true);
  check('B→A snapshot reuses the immutable A instance', snapshotDetail(ba.event), (s) => s.startsWith('done:reused') && s.endsWith(a));
  const snapBA = await snapshotReady('step 3 (B→A)', a, ba.doneAt);
  check('step 3 metadata {sha,size,files,builtAt} equals step 1 (A reused, not rebuilt)', JSON.stringify(snapBA.meta), JSON.stringify(snapA.meta));
  const ab2 = await pushAndWait('A→B #2', dir, `${b}:refs/heads/main`, a, b, seen, true);
  check('A→B #2 snapshot reuses the immutable B instance', snapshotDetail(ab2.event), (s) => s.startsWith('done:reused') && s.endsWith(b));
  const snapAB2 = await snapshotReady('step 4 (A→B #2)', b, ab2.doneAt);
  check('step 4 metadata {sha,size,files,builtAt} equals step 2 (B absorbed, no rebuild)', JSON.stringify(snapAB2.meta), JSON.stringify(snapB.meta));

  const list = (await events()).list;
  const abRows = list.filter((e) => e.before === a && e.after === b);
  for (const e of list) console.log(`#   events ${e.id.slice(0, 12)} ${e.before.slice(0, 7)}→${e.after.slice(0, 7)} source=${e.source} deliveries=${e.deliveries} completedAt=${e.completedAt}`);
  check('two genuine A→B transitions remain distinct event rows', abRows.map((e) => e.id).filter((v, i, s) => s.indexOf(v) === i).length, 2);
  check('every event completed with three recorded effects', list.every((e) => e.completedAt && e.effects.length === 3), true);
  const lsRemote = git(dir, ['ls-remote', 'origin', 'refs/heads/main']).out.split(/\s+/)[0];
  check('ls-remote after the cycle shows B', lsRemote, b);
  const pa4 = await pushedAt();
  check('pushedAt is a plausible timestamp', pa4, (v) => Number.isFinite(v) && v >= ts && v <= Date.now() + 60000);

  // ---- VAL-EVENT-005: orphan Artifacts repo ----
  const oc = wrangler(['artifacts', 'repos', 'create', ORPHAN, '--namespace', 'default', '--json']);
  orphanCreated = check(`wrangler artifacts repos create ${ORPHAN}`, oc.code, 0);
  const remote = JSON.parse(oc.out || '{}').remote;
  console.log(`#   orphan remote ${remote}`);
  const tok = wrangler(['artifacts', 'repos', 'issue-token', ORPHAN, '--namespace', 'default', '--scope', 'write', '--ttl', '600', '--json']);
  check('wrangler issued a write token for the orphan', tok.code, 0);
  const orphanToken = JSON.parse(tok.out || '{}').plaintext;
  const odir = join(work, 'orphan');
  mkdirSync(odir);
  git(odir, ['init', '-q', '-b', 'main']);
  git(odir, ['remote', 'add', 'origin', remote]);
  const o = commit(odir, 'orphan');
  const op = git(odir, ['push', '-q', 'origin', 'main'], orphanToken);
  check(`push ${o.slice(0, 7)} directly to the orphan Artifacts remote`, `${op.code} ${op.err}`, (s) => s.startsWith('0'));
  await sleep(10000);
  const orphanRepo = await api('GET', `/repos/${OWNER}/${ORPHAN}`);
  check(`GET /api/v1/repos/${OWNER}/${ORPHAN} after its push event (${orphanRepo.header})`, orphanRepo.status, 404);
  const orphanEvents = await api('GET', `/repos/${OWNER}/${ORPHAN}/events`);
  check(`GET /api/v1/repos/${OWNER}/${ORPHAN}/events (${orphanEvents.header})`, orphanEvents.status, 404);

  const beforeC = await pushedAt();
  const cSha = commit(dir, 'C');
  const pc = await pushAndWait('after-orphan B→C', dir, `${cSha}:refs/heads/main`, b, cSha, seen);
  const afterC = await pushedAt();
  check('pushedAt moved for the push after the orphan event', afterC, (v) => Number.isFinite(v) && v > beforeC);
  check('after-orphan snapshot effect created', snapshotDetail(pc.event), (s) => s.startsWith('done:created') && s.endsWith(cSha));
  await snapshotReady('after-orphan (C)', cSha, pc.doneAt);

  check('no 5xx anywhere in the run', statuses.filter((s) => s >= 500), (v) => v.length === 0);
} finally {
  if (created && !args.keep) {
    const r = await api('DELETE', `/repos/${OWNER}/${REPO}`);
    console.log(`# cleanup DELETE ${OWNER}/${REPO} -> ${r.status}`);
  }
  if (orphanCreated && !args.keep) {
    const r = wrangler(['artifacts', 'repos', 'delete', ORPHAN, '--namespace', 'default', '-y']);
    console.log(`# cleanup wrangler artifacts repos delete ${ORPHAN} -> ${r.code}`);
  }
  if (tail) {
    await sleep(3000);
    const exited = new Promise((r) => tail.once('exit', r));
    tail.kill('SIGTERM');
    await Promise.race([exited, sleep(5000)]);
    if (tail.exitCode === null && tail.signalCode === null) tail.kill('SIGKILL');
    // The consumer logs one JSON string per message; tail prints it as a JSON string literal.
    let n = 0;
    for (const raw of tailOut.split('\n')) {
      const line = raw.trim().replace(/,$/, '');
      if (!line.startsWith('"{\\"cost\\"')) continue;
      const m = JSON.parse(JSON.parse(line));
      const cost = Object.entries(m.cost).map(([k, v]) => `${k}=${v}`).join(';');
      if (m.workflow) {
        console.log(`# tail workflow=${m.workflow} step=${m.step} cost=${cost}`);
        continue;
      }
      console.log(`# tail ${m.queue} outcome=${m.outcome} attempts=${m.attempts} wf=${m.wf} cost=${cost} effects=${JSON.stringify(m.effects ?? {})}`);
      n++;
    }
    console.log(`# tail captured ${n} consumer log line(s); wrangler tail is best-effort and can miss queue invocations`);
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
