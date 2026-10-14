#!/usr/bin/env node
/**
 * Live driver for the merge queue / integration train (m5-merge-queue):
 * VAL-QUEUE-007, VAL-COST-022 (live half), VAL-TRAIN-001 (ordinary queue
 * state, stale-expectation 409), VAL-TRAIN-004 (live expected-old race) and
 * the ordinary queue behaviors (concurrent changes land in order with linear
 * first-parent history; a conflicting change is ejected and the next proceeds).
 *
 * Every scenario runs in a fresh public repo owned by KVARM_USER, named
 * `m5-merge-queue-<purpose>-<timestamp>`, seeded with real git pushes and
 * deleted afterwards (unless --keep):
 *   draft   draft enqueue 409 DRAFT, not listed, change open; PATCH review,
 *           enqueue 201, listed, then merged by the train
 *   train   three changes enqueued back to back (one conflicts with the
 *           first): x-kvarm-cost of enqueue and GET queue?limit=10, the
 *           conflicting one ejected, the others merged in FIFO order, linear
 *           first-parent history on main, queue empty afterwards
 *   stale   enqueue with a stale expected headSha / mergePolicy → 409 and no
 *           entry; dequeue of a queued entry or 409 PUBLISHING / 404
 *   race    two `git push --force-with-lease=main:<old>` publishers from the
 *           same expected old ref: exactly one accepted, ls-remote == winner
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . ./.env.local; set +a
 *   node scripts/merge-queue-e2e.mjs [--keep] [--only draft,train,stale,race]
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper. Exit 0 only when every check held.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';
import { parseCost } from './lib/fleet.mjs';
import { writeAskpass } from './lib/live.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } } });
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm5-merge-queue';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

function die(msg) {
  console.error(`merge-queue-e2e: ${msg}`);
  process.exit(2);
}

function check(id, label, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(path, { method = 'GET', json, token = PAT } = {}) {
  const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, text, json: body, cost: res.headers.get('x-kvarm-cost'), retryAfter: res.headers.get('retry-after') };
}

function costOf(label, r) {
  costs.push({ label, status: r.status, cost: r.cost });
  return r.cost ?? 'no cost header';
}

const work = mkdtempSync(join(tmpdir(), 'merge-queue-e2e-'));
const askpass = writeAskpass(work);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: PAT };

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Runs git asynchronously so two pushes can race. */
function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'credential.helper=', ...args], { cwd, env: gitEnv });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
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

function localRepo(name) {
  const dir = join(work, name);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  return dir;
}

function writeFiles(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
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

/** Branches `names` off one base commit, each adding its own files; returns {base, heads}. */
async function seed(repo, branches) {
  const dir = localRepo(repo);
  writeFiles(dir, { 'README.md': `# ${repo}\n` });
  const base = commitAll(dir, 'base');
  const heads = {};
  for (const [name, files] of Object.entries(branches)) {
    mustGit(['checkout', '-q', '-b', name, base], dir);
    writeFiles(dir, files);
    heads[name] = commitAll(dir, `${name} work`);
  }
  mustGit(['checkout', '-q', 'main'], dir);
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', ...Object.keys(branches).map((b) => `${b}:refs/heads/${b}`)]);
  return { dir, base, heads };
}

/** Polls a change until it leaves `open` or the deadline passes (client-side bounded poll). */
async function waitSettled(api, number, timeoutMs = 120_000) {
  const t0 = Date.now();
  const trace = [];
  let c = null;
  while (Date.now() - t0 < timeoutMs) {
    c = (await http(`${api}/changes/${number}`)).json;
    const s = `${c?.state}/${c?.queueState ?? '-'}`;
    if (trace[trace.length - 1] !== s) trace.push(s);
    // queueState is null once the change has no active entry (published, ejected, stale or dequeued).
    if (c?.state === 'merged' || (c?.state === 'open' && (c?.queueState ?? null) === null && Date.now() - t0 > 3000)) break;
    await sleep(2000);
  }
  return { change: c, ms: Date.now() - t0, trace };
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

await scenario('draft', async (repo) => {
  const { heads } = await seed(repo, { wip: { 'wip.txt': 'wip\n' } });
  const api = repoPath(repo);
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'WIP', base: 'main', head: 'wip', mergePolicy: 'draft' } });
  const n = created.json?.number;
  const refused = await http(`${api}/changes/${n}/enqueue`, { method: 'POST' });
  const queue = await http(`${api}/queue`);
  const still = (await http(`${api}/changes/${n}`)).json;
  check(
    'VAL-QUEUE-007',
    'draft: POST enqueue -> 409 {error, code: DRAFT}; queue does not list it; change open',
    created.status === 201 &&
      refused.status === 409 &&
      refused.json?.code === 'DRAFT' &&
      /draft/i.test(refused.json?.error ?? '') &&
      queue.status === 200 &&
      !(queue.json?.entries ?? []).some((e) => e.number === n) &&
      still?.state === 'open',
    `${refused.status} ${refused.text} cost ${costOf('POST enqueue (draft refusal)', refused)}; queue entries=${(queue.json?.entries ?? []).length}; state=${still?.state}`,
  );
  const toReview = await http(`${api}/changes/${n}`, { method: 'PATCH', json: { mergePolicy: 'review' } });
  const enq = await http(`${api}/changes/${n}/enqueue`, { method: 'POST' });
  const listed = await http(`${api}/queue`);
  const entry = (listed.json?.entries ?? []).find((e) => e.number === n);
  const settled = await waitSettled(api, n);
  check(
    'VAL-QUEUE-007',
    'PATCH to review -> 200; POST enqueue -> 2xx, listed (or already published), then merged by the train',
    toReview.status === 200 &&
      enq.status >= 200 &&
      enq.status < 300 &&
      enq.json?.entry?.number === n &&
      (entry !== undefined || settled.change?.state === 'merged') &&
      settled.change?.state === 'merged' &&
      lsRemote(gitUrl(repo), 'refs/heads/main') === heads.wip,
    `${toReview.status} / enqueue ${enq.status} entry.state=${enq.json?.entry?.state} listed=${entry ? entry.state : 'no (published)'} trace=${settled.trace.join(' > ')} after ${settled.ms} ms`,
  );
});

await scenario('train', async (repo) => {
  const { base, heads } = await seed(repo, {
    one: { 'one.txt': 'one\n', 'README.md': 'one owns the readme\n' },
    two: { 'two.txt': 'two\n', 'README.md': 'two also edits the readme\n' },
    three: { 'three.txt': 'three\n' },
  });
  const api = repoPath(repo);
  const nums = {};
  for (const b of ['one', 'two', 'three']) {
    const c = await http(`${api}/changes`, { method: 'POST', json: { title: `Change ${b}`, base: 'main', head: b } });
    nums[b] = c.json?.number;
  }
  const enq = {};
  for (const b of ['one', 'two', 'three']) {
    enq[b] = await http(`${api}/changes/${nums[b]}/enqueue`, { method: 'POST', json: { headSha: heads[b], mergePolicy: 'review' } });
  }
  const q = await http(`${api}/queue?limit=10`);
  const ec = parseCost(enq.three.cost);
  check(
    'VAL-COST-022',
    'enqueue x-kvarm-cost within d1<=2;rr<=8;rw<=4;art=0;do<=1',
    Object.values(enq).every((r) => r.status === 201) && ec.d1 <= 2 && ec.rr <= 8 && ec.rw <= 4 && ec.art === 0 && (ec.do ?? 0) <= 1,
    ['one', 'two', 'three'].map((b) => `${b}: ${costOf(`POST enqueue (${b})`, enq[b])}`).join(' | '),
  );
  const qc = parseCost(q.cost);
  check(
    'VAL-COST-022',
    'GET queue?limit=10 x-kvarm-cost within d1<=2;rr<=20;rw=0;art=0;do=0',
    q.status === 200 && qc.d1 <= 2 && qc.rr <= 20 && qc.rw === 0 && qc.art === 0 && (qc.do ?? 0) === 0,
    `${costOf('GET queue?limit=10', q)}; entries=${JSON.stringify((q.json?.entries ?? []).map((e) => [e.number, e.position, e.state]))} limits=${JSON.stringify(q.json?.limits)}`,
  );
  check(
    'VAL-TRAIN-001',
    'queue states observable: entries listed in FIFO positions with train states',
    q.status === 200 && (q.json?.entries ?? []).every((e, i) => e.position === i + 1 && ['queued', 'preparing', 'checking', 'ready', 'publishing'].includes(e.state)),
    JSON.stringify((q.json?.entries ?? []).map((e) => `${e.number}@${e.position}:${e.state}`)),
  );
  const s = {};
  for (const b of ['one', 'two', 'three']) s[b] = await waitSettled(api, nums[b]);
  for (const b of ['one', 'two', 'three']) console.log(`      #${nums[b]} (${b}): ${s[b].trace.join(' > ')} in ${s[b].ms} ms reason=${JSON.stringify(s[b].change?.queueState)}`);
  check(
    'VAL-QUEUE',
    'first and third merged; the second (README conflict with the first) ejected and left open',
    s.one.change?.state === 'merged' && s.three.change?.state === 'merged' && s.two.change?.state === 'open' && s.two.change?.queueState === null,
    `one=${s.one.change?.state} two=${s.two.change?.state}/${s.two.change?.queueState} three=${s.three.change?.state}`,
  );
  const after = await http(`${api}/queue`);
  check('VAL-QUEUE', 'queue empty afterwards (the lease and the train are free)', after.status === 200 && (after.json?.entries ?? []).length === 0, `${after.text}`);

  const cdir = join(work, `${repo}-clone`);
  mustGit(['clone', '-q', gitUrl(repo), cdir], work);
  const firstParents = mustGit(['rev-list', '--first-parent', 'main'], cdir).split('\n');
  const three = s.three.change?.mergeCommit;
  const one = s.one.change?.mergeCommit;
  const parentsOfThree = mustGit(['rev-list', '--parents', '-n', '1', three], cdir).split(' ').slice(1);
  check(
    'VAL-QUEUE',
    'linear first-parent history main: base -> merge(one) -> merge(three); three composed on one (no lost update)',
    firstParents.length === 3 && firstParents[2] === base && firstParents[1] === one && firstParents[0] === three && parentsOfThree[0] === one && parentsOfThree[1] === heads.three,
    `first-parent ${firstParents.map((x) => x.slice(0, 8)).join(' <- ')}; parents(three)=${parentsOfThree.map((x) => x.slice(0, 8)).join(',')}`,
  );
  const files = mustGit(['ls-tree', '--name-only', 'main'], cdir).split('\n');
  check('VAL-QUEUE', 'both landed changes present on main, the ejected one absent', files.includes('one.txt') && files.includes('three.txt') && !files.includes('two.txt'), files.join(','));
  const fsck = git(['fsck', '--strict'], cdir);
  check('VAL-QUEUE', 'git fsck --strict clean', fsck.code === 0, fsck.err);
});

await scenario('stale', async (repo) => {
  const { dir, heads } = await seed(repo, { feat: { 'feat.txt': 'feat\n' }, other: { 'other.txt': 'other\n' } });
  const api = repoPath(repo);
  const c = await http(`${api}/changes`, { method: 'POST', json: { title: 'Feat', base: 'main', head: 'feat' } });
  const n = c.json?.number;
  const wrongHead = await http(`${api}/changes/${n}/enqueue`, { method: 'POST', json: { headSha: heads.other } });
  const wrongPolicy = await http(`${api}/changes/${n}/enqueue`, { method: 'POST', json: { mergePolicy: 'auto' } });
  const q = await http(`${api}/queue`);
  check(
    'VAL-TRAIN-001',
    'stale expected head / policy -> 409 HEAD_MOVED / POLICY_CHANGED, no active candidate',
    wrongHead.status === 409 && wrongHead.json?.code === 'HEAD_MOVED' && wrongPolicy.status === 409 && wrongPolicy.json?.code === 'POLICY_CHANGED' && (q.json?.entries ?? []).length === 0,
    `${wrongHead.status} ${wrongHead.json?.code} (${costOf('POST enqueue (stale head)', wrongHead)}) / ${wrongPolicy.status} ${wrongPolicy.json?.code}; queue=${(q.json?.entries ?? []).length}`,
  );
  // Head moves after approval: the review approval is head-bound.
  const enq = await http(`${api}/changes/${n}/enqueue`, { method: 'POST', json: { headSha: heads.feat } });
  const deq = await http(`${api}/changes/${n}/enqueue`, { method: 'DELETE' });
  check(
    'VAL-TRAIN-001',
    'enqueue/dequeue preserved below capacity: 201 then 200 dequeued, or 409 PUBLISHING / 404 NOT_QUEUED once the train took it',
    enq.status === 201 && (deq.status === 200 ? deq.json?.dequeued === true : (deq.status === 409 && deq.json?.code === 'PUBLISHING') || (deq.status === 404 && deq.json?.code === 'NOT_QUEUED')),
    `enqueue ${enq.status} (${costOf('POST enqueue', enq)}) / dequeue ${deq.status} ${deq.json?.code ?? deq.json?.entry?.state} (${costOf('DELETE enqueue', deq)})`,
  );
  if (deq.status === 200) {
    mustGit(['checkout', '-q', 'feat'], dir);
    writeFiles(dir, { 'feat.txt': 'feat v2\n' });
    const v2 = commitAll(dir, 'feat v2');
    await pushRetry(dir, gitUrl(repo), ['feat:refs/heads/feat']);
    let head = null;
    for (let i = 0; i < 20 && head !== v2; i++) {
      await sleep(2000);
      head = (await http(`${api}/changes/${n}`)).json?.headSha;
    }
    const stale = await http(`${api}/changes/${n}/enqueue`, { method: 'POST', json: { headSha: heads.feat } });
    const fresh = await http(`${api}/changes/${n}/enqueue`, { method: 'POST', json: { headSha: v2 } });
    const settled = await waitSettled(api, n);
    check(
      'VAL-TRAIN-001',
      'after a push, approving the old head -> 409 HEAD_MOVED; approving the current head -> 201 and merged',
      head === v2 && stale.status === 409 && stale.json?.code === 'HEAD_MOVED' && fresh.status === 201 && settled.change?.state === 'merged',
      `head=${head?.slice(0, 8)} stale=${stale.status} fresh=${fresh.status} trace=${settled.trace.join(' > ')}`,
    );
  }
});

await scenario('race', async (repo) => {
  const { dir, base } = await seed(repo, {});
  const url = gitUrl(repo);
  const tips = {};
  for (const name of ['p1', 'p2']) {
    mustGit(['checkout', '-q', '-b', name, base], dir);
    writeFiles(dir, { [`${name}.txt`]: `${name}\n` });
    tips[name] = commitAll(dir, `${name} publication`);
  }
  // Make both packs available first so the race is only the ref update.
  await pushRetry(dir, url, ['p1:refs/heads/p1', 'p2:refs/heads/p2']);
  const [r1, r2] = await Promise.all(
    ['p1', 'p2'].map((name) => gitAsync(['push', '--porcelain', `--force-with-lease=refs/heads/main:${base}`, url, `${name}:refs/heads/main`], dir)),
  );
  const winner = lsRemote(url, 'refs/heads/main');
  const accepted = [r1, r2].filter((r) => r.code === 0).length;
  console.log(`      p1 exit=${r1.code} ${r1.out.split('\n').filter((l) => l.includes('refs/heads/main')).join(' ')} ${r1.code ? r1.err.split('\n').slice(-1)[0] : ''}`);
  console.log(`      p2 exit=${r2.code} ${r2.out.split('\n').filter((l) => l.includes('refs/heads/main')).join(' ')} ${r2.code ? r2.err.split('\n').slice(-1)[0] : ''}`);
  check(
    'VAL-TRAIN-004',
    'two publishers from the same expected old ref: exactly one accepted, the other rejected; ls-remote == the sole winner',
    accepted === 1 && winner === (r1.code === 0 ? tips.p1 : tips.p2),
    `accepted=${accepted} main=${winner?.slice(0, 8)} p1=${tips.p1.slice(0, 8)} p2=${tips.p2.slice(0, 8)}`,
  );
});

rmSync(work, { recursive: true, force: true });
console.log('\n# x-kvarm-cost');
for (const c of costs) console.log(`  ${c.label} (${c.status}): ${c.cost}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
