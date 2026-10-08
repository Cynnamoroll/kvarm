#!/usr/bin/env node
/**
 * Live validation driver for confirmed-push freshness at the git gate
 * (VAL-EVENT-002, and the info/refs half that VAL-EVENT-003 reads).
 *
 * As cynthia (FORGE_PAT) it creates a public repo, pushes a seed commit and
 * warms the anonymous tree page and info/refs (v0 and Git-Protocol v2) until
 * they are edge-cache hits. Then, for each round, it commits a README with a
 * unique REFRESH token plus a MARK file, runs `git push`, and immediately
 * polls the anonymous tree page and both info/refs variants in a tight loop,
 * recording when the token (page) and the new head sha (info/refs) first
 * appear. Pass: both within 2.0 s of `git push` returning.
 *
 * It also sends two unconfirmed receive-pack POSTs over raw HTTP: a stale old
 * OID (server `ng`) and a corrupt pack (`unpack` failure). Neither may move
 * `pushedAt` or retire the warm page/info/refs entries (still cache=hit with
 * the previous token).
 *
 * Tokens come from env by NAME (load apps/platform/.dev.vars.validation) and
 * are never printed; git runs with `-c credential.helper=` and a secret-free
 * GIT_ASKPASS helper. Commits use the configured git identity.
 *
 * Usage: node scripts/push-freshness-e2e.mjs [--rounds N] [--keep]
 * Exit 0 when every expectation held, 1 otherwise. The repo is deleted at the
 * end unless --keep.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { rounds: { type: 'string', default: '3' }, keep: { type: 'boolean', default: false } },
});
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
if (!process.env.FORGE_PAT) throw new Error('env FORGE_PAT is not set');
const ROUNDS = Number(args.rounds);
const BOUND_MS = 2000;
const POLL_LIMIT_MS = 15000;

const ts = Date.now();
const REPO = `m4-push-gate-freshness-live-${ts}`;
const PAGE = `/${OWNER}/${REPO}`;
const REFS = `/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`;

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
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

async function http(path, { method = 'GET', headers = {}, body, auth } = {}) {
  const h = { ...headers };
  if (auth === 'bearer') h.Authorization = `Bearer ${process.env.FORGE_PAT}`;
  if (auth === 'basic') h.Authorization = `Basic ${Buffer.from(`x:${process.env.FORGE_PAT}`).toString('base64')}`;
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body, redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  const header = res.headers.get('x-forge-cost');
  return { status: res.status, buf, text: buf.toString('latin1'), header, cost: costOf(header) };
}

const anon = (path, v2 = false) => http(path, v2 ? { headers: { 'Git-Protocol': 'version=2' } } : {});
const api = (method, path, json) =>
  http(`/api/v1${path}`, {
    method,
    auth: 'bearer',
    headers: json === undefined ? {} : { 'content-type': 'application/json' },
    body: json === undefined ? undefined : JSON.stringify(json),
  });

const work = mkdtempSync(join(tmpdir(), 'push-freshness-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const dir = join(work, 'repo');
mkdirSync(dir);

function git(gitArgs, { input, binary = false } = {}) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: process.env.FORGE_PAT };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...gitArgs], {
    cwd: dir,
    env,
    input: input === undefined ? undefined : Buffer.from(input),
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: binary ? r.stdout : r.stdout.trim(), err: String(r.stderr).trim() };
}

function commit(token, i) {
  writeFileSync(join(dir, 'README.md'), `# ${REPO}\n\n${token}\n`);
  writeFileSync(join(dir, `MARK-${ts}-${i}.txt`), `${token}\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-m', token]);
  return git(['rev-parse', 'HEAD']).out;
}

async function push() {
  for (let i = 0; i < 10; i++) {
    const r = git(['push', '-q', 'origin', 'main']);
    if (r.code === 0 || !/503|warming|429/i.test(r.err)) return { ...r, doneAt: Date.now() };
    await sleep(3000);
  }
  return { ...git(['push', '-q', 'origin', 'main']), doneAt: Date.now() };
}

/** Polls until `match` holds, one request in flight; returns the first match's offset from `t0`. */
async function pollUntil(t0, fetchOnce, match) {
  const transcript = [];
  for (;;) {
    const r = await fetchOnce();
    const at = Date.now() - t0;
    const hit = r.status === 200 && match(r.text);
    transcript.push(`+${at}ms ${r.status} ${hit ? 'MATCH' : 'old'} ${r.header}`);
    if (hit) return { at, transcript, first: r };
    if (at > POLL_LIMIT_MS) return { at: Infinity, transcript, first: r };
  }
}

/** Requests until two consecutive cache hits, so the entry is warm in this colo. */
async function warm(label, fetchOnce, match) {
  for (let i = 0; i < 6; i++) {
    const r = await fetchOnce();
    if (r.status === 200 && match(r.text) && r.cost.cache === 'hit') return check(`${label} warm hit ${r.header}`, true, true);
    await sleep(200);
  }
  return check(`${label} warm hit`, false, true);
}

function pkt(s) {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}

/** Unwraps side-band 1 and returns the report-status lines. */
function reportLines(buf) {
  const lines = [];
  const walk = (b, sideband) => {
    let i = 0;
    while (i + 4 <= b.length) {
      const len = parseInt(b.subarray(i, i + 4).toString(), 16);
      if (Number.isNaN(len)) return;
      if (len === 0) {
        i += 4;
        continue;
      }
      const payload = b.subarray(i + 4, i + len);
      i += len;
      if (sideband) {
        if (payload[0] === 1) walk(payload.subarray(1), false);
      } else lines.push(payload.toString().trim());
    }
  };
  walk(buf, buf.length > 4 && buf[4] === 1);
  return lines;
}

/** A raw receive-pack POST with the given old/new and pack bytes. */
function rawPush(oldSha, newSha, pack) {
  const cmd = pkt(Buffer.concat([Buffer.from(`${oldSha} ${newSha} refs/heads/main\0`), Buffer.from('report-status side-band-64k agent=push-freshness-e2e\n')]));
  return http(`/${OWNER}/${REPO}.git/git-receive-pack`, {
    method: 'POST',
    auth: 'basic',
    headers: { 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
    body: Buffer.concat([cmd, Buffer.from('0000'), pack]),
  });
}

let created = false;
try {
  const c = await api('POST', '/repos', { name: REPO, visibility: 'public' });
  created = check(`create public ${OWNER}/${REPO}`, c.status, 201);

  git(['init', '-q', '-b', 'main']);
  git(['remote', 'add', 'origin', `${BASE}/${OWNER}/${REPO}.git`]);
  const seedToken = `REFRESH-seed-${ts}`;
  let head = commit(seedToken, 0);
  check('seed push', (await push()).code, 0);

  let token = seedToken;
  const surfaces = () => [
    { label: 'tree page', fetch: () => anon(PAGE), match: (t, tok) => t.includes(tok) },
    { label: 'info/refs v0', fetch: () => anon(REFS), match: (t, _tok, sha) => t.includes(sha) },
    { label: 'info/refs v2', fetch: () => anon(REFS, true), match: (t) => t.includes('version 2') },
  ];
  for (const s of surfaces()) await warm(`seed ${s.label}`, s.fetch, (t) => s.match(t, token, head));

  for (let i = 1; i <= ROUNDS; i++) {
    const epoch = Date.now();
    token = `REFRESH-${epoch}`;
    head = commit(token, i);
    const pushed = await push();
    check(`round ${i} git push`, pushed.code, 0);
    const t0 = pushed.doneAt;
    console.log(`# round ${i} push completed at ${new Date(t0).toISOString()} head=${head}`);

    const page = await pollUntil(t0, () => anon(PAGE), (t) => t.includes(token));
    const refs = await pollUntil(t0, () => anon(REFS), (t) => t.includes(head));
    for (const line of page.transcript) console.log(`#   page ${line}`);
    for (const line of refs.transcript) console.log(`#   info/refs ${line}`);
    check(`round ${i} VAL-EVENT-002 tree page shows ${token} within ${BOUND_MS} ms`, page.at, (v) => v <= BOUND_MS);
    check(`round ${i} info/refs advertises ${head.slice(0, 12)} within ${BOUND_MS} ms`, refs.at, (v) => v <= BOUND_MS);
    check(`round ${i} first fresh page cost ${page.first.header}`, page.first.cost, (k) => k.d1 <= 1 && k.do === 0);
    check(`round ${i} first fresh info/refs cost ${refs.first.header}`, refs.first.cost, (k) => k.d1 <= 1 && k.do === 0);
    // v2 advertisements carry no ref list; the miss shows its key moved too.
    const v2 = await anon(REFS, true);
    check(`round ${i} info/refs v2 re-fetched under the new generation ${v2.header}`, v2.cost.cache, 'miss');
    for (const s of surfaces()) await warm(`round ${i} ${s.label}`, s.fetch, (t) => s.match(t, token, head));
  }

  // ---- Unconfirmed pushes change nothing ----
  const before = await api('GET', `/repos/${OWNER}/${REPO}`);
  const pushedAtBefore = JSON.parse(before.text).repo?.pushedAt;
  check('pushedAt set by confirmed pushes', pushedAtBefore, (v) => typeof v === 'number' && v > ts);

  const parent = git(['rev-parse', 'HEAD~1']).out;
  writeFileSync(join(dir, 'UNCONFIRMED.txt'), `${ts}\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'unconfirmed']);
  const next = git(['rev-parse', 'HEAD']).out;
  const pack = git(['pack-objects', '--revs', '--stdout', '-q'], { input: `${next}\n^${head}\n`, binary: true }).out;

  const stale = await rawPush(parent, next, pack);
  const staleLines = reportLines(stale.buf);
  console.log(`#   stale-old report: ${JSON.stringify(staleLines)}`);
  check(`stale old OID push answers ng ${stale.header}`, `${stale.status} ${staleLines.find((l) => l.startsWith('ng ')) ?? '(no ng)'}`, (s) => s.startsWith('200 ng refs/heads/main'));

  const corrupt = Buffer.from(pack);
  corrupt.fill(0x5a, 12, Math.min(corrupt.length - 20, 64));
  const failed = await rawPush(head, next, corrupt);
  const failedLines = reportLines(failed.buf);
  console.log(`#   corrupt-pack report: ${JSON.stringify(failedLines)}`);
  check(`corrupt pack does not confirm ${failed.header}`, failedLines.includes('ok refs/heads/main'), false);

  const after = await api('GET', `/repos/${OWNER}/${REPO}`);
  check('pushedAt unchanged after ng and failed pushes', JSON.parse(after.text).repo?.pushedAt, pushedAtBefore);
  const ls = git(['ls-remote', 'origin', 'refs/heads/main']).out.split(/\s+/)[0];
  check('remote main unchanged', ls, head);
  for (const s of surfaces()) {
    const r = await s.fetch();
    check(`${s.label} still served from cache after unconfirmed pushes ${r.header}`, r.cost.cache === 'hit' && s.match(r.text, token, head), true);
  }
} finally {
  if (created && !args.keep) {
    const r = await api('DELETE', `/repos/${OWNER}/${REPO}`);
    console.log(`# cleanup DELETE ${OWNER}/${REPO} -> ${r.status}`);
  }
  rmSync(work, { recursive: true, force: true });
}

const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
process.exit(failedChecks.length === 0 ? 0 : 1);
