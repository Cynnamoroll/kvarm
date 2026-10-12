#!/usr/bin/env node
/**
 * Live driver for change requests (m5-change-requests): VAL-CHANGE-001..011,
 * VAL-MERGE-001/002/004/005/009 and VAL-CROSS-005.
 *
 * Every scenario runs in a fresh public repo owned by KVARM_USER,
 * named `m5-change-requests-<purpose>-<timestamp>`, seeded with real git
 * pushes through the platform gate, and deleted afterwards (unless --keep):
 *   crud      create/list/get/patch/close/reopen, refusals, auth, head refresh
 *   number    per-repo numbering (first change is #1 in a second repo)
 *   rating    change rating == compare rating (test deletion + CI config edit)
 *   ff        review policy never auto-merges (90 s poll), then FF merge
 *   threeway  three-way merge read through the Artifacts binding; the merge
 *             tree equals `git merge-tree --write-tree`; fresh clone checks
 *   draft     draft refuses (409), review then merges
 *   auto      auto merges immediately; an auto change with conflicts merges
 *             once a push resolves them
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . ./.env.local; set +a
 *   node scripts/change-requests-e2e.mjs [--keep] [--only crud,ff,...] [--quick]
 * --quick shortens the VAL-MERGE-005 no-auto-merge poll from 90 s to 10 s.
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper. Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({
  options: { keep: { type: 'boolean', default: false }, only: { type: 'string' }, quick: { type: 'boolean', default: false } },
});
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const PAT_BOT = process.env.KVARM_PAT_BOT ?? die('KVARM_PAT_BOT is not set');
const PAT_NO_API = process.env.KVARM_PAT_NO_API ?? die('KVARM_PAT_NO_API is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm5-change-requests';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

function die(msg) {
  console.error(`change-requests-e2e: ${msg}`);
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
  return { status: res.status, text, json: body, cost: res.headers.get('x-kvarm-cost') };
}

function costOf(label, r) {
  costs.push({ label, status: r.status, cost: r.cost });
  return r.cost ?? 'no cost header';
}

const work = mkdtempSync(join(tmpdir(), 'change-requests-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd, token = PAT) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: '0',
      KVARM_E2E_TOKEN: token,
      GIT_AUTHOR_DATE: '2026-10-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-10-01T00:00:00Z',
    },
    encoding: 'utf8',
  });
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

/** A local repo for building branches; commits use the configured git identity. */
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
const numbers = (r) => (r.json?.changes ?? []).map((c) => c.number);

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

await scenario('crud', async (repo) => {
  const dir = localRepo(repo);
  const url = gitUrl(repo);
  writeFiles(dir, { 'README.md': '# crud\n' });
  const m1 = commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'feature-x'], dir);
  writeFiles(dir, { 'notes.txt': 'hello\n' });
  const c1 = commitAll(dir, 'feature');
  await pushRetry(dir, url, ['main:refs/heads/main', 'feature-x:refs/heads/feature-x']);
  const api = repoPath(repo);
  const count = async () => numbers(await http(`${api}/changes?state=all`)).length;

  // VAL-CHANGE-001
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'Add feature', base: 'main', head: 'feature-x' } });
  const tip = lsRemote(url, 'refs/heads/feature-x');
  const v = created.json ?? {};
  check(
    'VAL-CHANGE-001',
    'POST changes -> 201 with number, open, review default, refs, headSha == ls-remote tip',
    created.status === 201 && v.number === 1 && v.state === 'open' && v.mergePolicy === 'review' && v.base === 'main' && v.head === 'feature-x' && v.headSha === tip && tip === c1,
    `${created.status} number=${v.number} state=${v.state} policy=${v.mergePolicy} headSha=${v.headSha} ls-remote=${tip} cost ${costOf('POST changes', created)}`,
  );
  const got = await http(`${api}/changes/1`);
  check(
    'VAL-CHANGE-001',
    'GET changes/1 -> same values',
    got.status === 200 && got.json.number === 1 && got.json.state === 'open' && got.json.mergePolicy === 'review' && got.json.headSha === c1,
    `${got.status} cost ${costOf('GET changes/1 (cold)', got)}`,
  );

  // VAL-CHANGE-005
  const d = (await http(`${api}/changes/1`)).json;
  const warm = await http(`${api}/changes/1`);
  costOf('GET changes/1 (warm)', warm);
  check(
    'VAL-CHANGE-005',
    'detail carries rating {score, level, reasons}, headSha == tip, mergeability clean (fast-forward, mergeable, no conflicts)',
    typeof d.rating?.score === 'number' && ['low', 'medium', 'high'].includes(d.rating?.level) && Array.isArray(d.rating?.reasons) &&
      d.headSha === tip && d.mergeability?.mergeable === true && d.mergeability?.status === 'fast-forward' && d.mergeability?.conflicts?.length === 0,
    `rating=${JSON.stringify(d.rating)} mergeability=${JSON.stringify({ status: d.mergeability?.status, mergeable: d.mergeability?.mergeable, conflicts: d.mergeability?.conflicts, checks: d.mergeability?.checks })} warm cost ${warm.cost}`,
  );

  // VAL-CHANGE-002 / 003
  const before = await count();
  const missHead = await http(`${api}/changes`, { method: 'POST', json: { title: 'x', base: 'main', head: 'no-such-branch' } });
  const missBase = await http(`${api}/changes`, { method: 'POST', json: { title: 'x', base: 'no-such-branch', head: 'feature-x' } });
  check(
    'VAL-CHANGE-002',
    'missing head / missing base -> 404|422 {error}, list unchanged',
    [404, 422].includes(missHead.status) && [404, 422].includes(missBase.status) && missHead.json?.error && missBase.json?.error && (await count()) === before,
    `${missHead.status} ${missHead.text} | ${missBase.status} ${missBase.text} | count ${before} -> ${await count()} cost ${missHead.cost}`,
  );
  const same = await http(`${api}/changes`, { method: 'POST', json: { title: 'x', base: 'main', head: 'main' } });
  check('VAL-CHANGE-003', 'base == head -> 422 {error}, list unchanged', same.status === 422 && same.json?.error && (await count()) === before, `${same.status} ${same.text}`);

  // VAL-CHANGE-010
  const anon = await http(`${api}/changes`, { method: 'POST', json: { title: 'x', base: 'main', head: 'feature-x' }, token: null });
  const noApi = await http(`${api}/changes`, { method: 'POST', json: { title: 'x', base: 'main', head: 'feature-x' }, token: PAT_NO_API });
  check(
    'VAL-CHANGE-010',
    'anonymous POST -> 401; no-api-scope PAT -> 401/403; list unchanged',
    anon.status === 401 && [401, 403].includes(noApi.status) && (await count()) === before,
    `anon ${anon.status} ${anon.text} | no-api ${noApi.status} ${noApi.text} | cost ${anon.cost}`,
  );

  // VAL-CHANGE-011
  const botList = await http(`${api}/changes`, { token: PAT_BOT });
  const botPost = await http(`${api}/changes`, { method: 'POST', json: { title: 'bot', base: 'main', head: 'feature-x' }, token: PAT_BOT });
  const botPatch = await http(`${api}/changes/1`, { method: 'PATCH', json: { title: 'bot' }, token: PAT_BOT });
  const botMerge = await http(`${api}/changes/1/merge`, { method: 'POST', token: PAT_BOT });
  check(
    'VAL-CHANGE-011',
    'forge-bot: GET changes 200 (public), POST 403 {error}, PATCH/merge 403, owner list unchanged',
    botList.status === 200 && botPost.status === 403 && botPost.json?.error && botPatch.status === 403 && botMerge.status === 403 && (await count()) === before,
    `GET ${botList.status} | POST ${botPost.status} ${botPost.text} | PATCH ${botPatch.status} | merge ${botMerge.status} | cost ${botPost.cost}`,
  );

  // VAL-CHANGE-008 + 004
  const closed = await http(`${api}/changes/1`, { method: 'PATCH', json: { state: 'closed' } });
  const closedGet = await http(`${api}/changes/1`);
  const openList = await http(`${api}/changes`);
  const closedList = await http(`${api}/changes?state=closed`);
  check(
    'VAL-CHANGE-008',
    'PATCH state closed -> 200; GET closed; absent from default list; present under ?state=closed',
    closed.status === 200 && closedGet.json.state === 'closed' && !numbers(openList).includes(1) && numbers(closedList).includes(1),
    `${closed.status} state=${closedGet.json.state} open=${numbers(openList)} closed=${numbers(closedList)} cost ${costOf('PATCH changes/1', closed)}`,
  );
  const second = await http(`${api}/changes`, { method: 'POST', json: { title: 'Second', base: 'main', head: 'feature-x' } });
  const defaultList = await http(`${api}/changes`);
  const closedOnly = await http(`${api}/changes?state=closed`);
  check(
    'VAL-CHANGE-004',
    'default list -> only #2 (open); ?state=closed -> only #1',
    second.status === 201 && JSON.stringify(numbers(defaultList)) === '[2]' && JSON.stringify(numbers(closedOnly)) === '[1]',
    `default=${JSON.stringify(numbers(defaultList))} closed=${JSON.stringify(numbers(closedOnly))} list cost ${costOf('GET changes', defaultList)}`,
  );
  check('VAL-CHANGE-009', 'repo A: two creates -> numbers 1, 2', v.number === 1 && second.json?.number === 2, `${v.number}, ${second.json?.number}`);
  const reopened = await http(`${api}/changes/1`, { method: 'PATCH', json: { state: 'open' } });
  const afterReopen = await http(`${api}/changes`);
  check(
    'VAL-CHANGE-008',
    'PATCH state open -> 200, state open, back in the default list',
    reopened.status === 200 && reopened.json.state === 'open' && numbers(afterReopen).includes(1),
    `${reopened.status} state=${reopened.json?.state} default=${JSON.stringify(numbers(afterReopen))}`,
  );

  // VAL-CHANGE-006: push C2 to feature-x, poll <= 60 s.
  writeFiles(dir, { 'notes.txt': 'hello\nagain\n' });
  const c2 = commitAll(dir, 'feature 2');
  const pushedAt = Date.now();
  await pushRetry(dir, url, ['feature-x:refs/heads/feature-x']);
  let seen = null;
  while (Date.now() - pushedAt < 60_000) {
    seen = (await http(`${api}/changes/1`)).json;
    if (seen?.headSha === c2) break;
    await sleep(2000);
  }
  check(
    'VAL-CHANGE-006',
    'push C2 to the head branch -> headSha == C2 within 60 s, change still open',
    seen?.headSha === c2 && seen?.state === 'open' && lsRemote(url, 'refs/heads/feature-x') === c2,
    `C2=${c2} headSha=${seen?.headSha} state=${seen?.state} after ${Date.now() - pushedAt} ms`,
  );

  // VAL-CHANGE-007 on change 2 (head now C2; policy auto merges it at once since nothing is required).
  const head2 = (await http(`${api}/changes/2`)).json.headSha;
  const renamed = await http(`${api}/changes/2`, { method: 'PATCH', json: { title: 'Renamed', mergePolicy: 'auto' } });
  const after = (await http(`${api}/changes/2`)).json;
  check(
    'VAL-CHANGE-007',
    'PATCH {title: Renamed, mergePolicy: auto} -> 200; GET shows both; headSha unchanged',
    renamed.status === 200 && after.title === 'Renamed' && after.mergePolicy === 'auto' && after.headSha === head2,
    `${renamed.status} title=${after.title} policy=${after.mergePolicy} headSha ${head2} -> ${after.headSha} state=${after.state} mergeCommit=${after.mergeCommit} cost ${renamed.cost}`,
  );
  check('VAL-CHANGE-007', 'auto with an empty required set merged immediately (fast-forward to C2)', after.state === 'merged' && lsRemote(url, 'refs/heads/main') === c2, `main=${lsRemote(url, 'refs/heads/main')} (was ${m1})`);
});

await scenario('number', async (repo) => {
  const dir = localRepo(repo);
  writeFiles(dir, { 'README.md': '# number\n' });
  commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'topic'], dir);
  writeFiles(dir, { 'topic.txt': 'topic\n' });
  commitAll(dir, 'topic');
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', 'topic:refs/heads/topic']);
  const r = await http(`${repoPath(repo)}/changes`, { method: 'POST', json: { title: 'First in B', base: 'main', head: 'topic' } });
  check('VAL-CHANGE-009', 'repo B: first change is number 1', r.status === 201 && r.json.number === 1, `${r.status} number=${r.json?.number}`);
});

await scenario('rating', async (repo) => {
  const dir = localRepo(repo);
  writeFiles(dir, {
    'README.md': '# rating\n',
    'src/app.ts': 'export const answer = 42;\n',
    'test/app.test.ts': "import { answer } from '../src/app';\ntest('answer', () => expect(answer).toBe(42));\n",
    '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  });
  commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'risky'], dir);
  rmSync(join(dir, 'test/app.test.ts'));
  writeFiles(dir, { '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo skipped\n' });
  const head = commitAll(dir, 'drop the test, skip CI');
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', 'risky:refs/heads/risky']);
  const api = repoPath(repo);
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'Risky', base: 'main', head: 'risky' } });
  const change = await http(`${api}/changes/${created.json?.number}`);
  const compare = await http(`${api}/compare/main...${head}`);
  const a = change.json?.rating;
  const b = compare.json?.rating;
  console.log(`      change rating:  ${JSON.stringify(a)}\n      compare rating: ${JSON.stringify(b)}`);
  check(
    'VAL-CROSS-005',
    'change rating == compare rating for the same base/head (score, level, reasons)',
    created.status === 201 && a && b && a.score === b.score && a.level === b.level && JSON.stringify(a.reasons) === JSON.stringify(b.reasons) && a.reasons.length > 0,
    `score ${a?.score}/${b?.score} level ${a?.level}/${b?.level}; compare cost ${compare.cost}; change cost ${change.cost}`,
  );
});

await scenario('ff', async (repo) => {
  const dir = localRepo(repo);
  const url = gitUrl(repo);
  writeFiles(dir, { 'README.md': '# ff\n' });
  const m = commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'feature'], dir);
  writeFiles(dir, { 'feature.txt': 'F\n' });
  const f = commitAll(dir, 'feature');
  await pushRetry(dir, url, ['main:refs/heads/main', 'feature:refs/heads/feature']);
  const api = repoPath(repo);
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'FF', base: 'main', head: 'feature' } });
  check('VAL-MERGE-005', 'review change created', created.status === 201 && created.json.mergePolicy === 'review', String(created.status));

  const window = opts.quick ? 10_000 : 90_000;
  const t0 = Date.now();
  let stayedOpen = true;
  let polls = 0;
  while (Date.now() - t0 < window) {
    const s = (await http(`${api}/changes/1`)).json;
    polls++;
    if (s?.state !== 'open' || lsRemote(url, 'refs/heads/main') !== m) stayedOpen = false;
    await sleep(10_000);
  }
  check('VAL-MERGE-005', `review policy: open and main unmoved for ${window / 1000} s`, stayedOpen, `${polls} polls; main=${lsRemote(url, 'refs/heads/main')}`);

  const merged = await http(`${api}/changes/1/merge`, { method: 'POST' });
  const after = (await http(`${api}/changes/1`)).json;
  const mainNow = lsRemote(url, 'refs/heads/main');
  check(
    'VAL-MERGE-001',
    'POST merge (review) -> 2xx; merged; mergeCommit == F; main == F',
    merged.status === 200 && after.state === 'merged' && after.mergeCommit === f && mainNow === f && merged.json?.merge?.kind === 'fast-forward',
    `${merged.status} kind=${merged.json?.merge?.kind} mergeCommit=${after.mergeCommit} F=${f} main=${mainNow} cost ${costOf('POST merge (ff)', merged)}`,
  );
  check('VAL-MERGE-005', 'explicit merge merged and moved the ref', after.state === 'merged' && mainNow !== m);
  const clone = git(['clone', '-q', url, `${repo}-clone`], work);
  const cdir = join(work, `${repo}-clone`);
  const count = git(['rev-list', '--count', 'origin/main'], cdir).out;
  const head = git(['rev-parse', 'origin/main'], cdir).out;
  check('VAL-MERGE-001', 'fresh clone: main == F, no extra commit (2 commits)', clone.code === 0 && head === f && count === '2', `clone ${clone.code} head=${head} commits=${count}`);
  const again = await http(`${api}/changes/1/merge`, { method: 'POST' });
  check('VAL-MERGE-001', 'second merge -> 409 ALREADY_MERGED', again.status === 409 && again.json?.code === 'ALREADY_MERGED', `${again.status} ${again.text}`);
});

await scenario('threeway', async (repo) => {
  const dir = localRepo(repo);
  const url = gitUrl(repo);
  const shared = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
  writeFiles(dir, { 'README.md': '# threeway\n', 'shared.txt': `${shared.join('\n')}\n` });
  commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'feature'], dir);
  writeFiles(dir, { 'b.txt': 'B\n', 'shared.txt': `${shared.map((l, i) => (i === 9 ? 'feature edits line 10' : l)).join('\n')}\n` });
  const feature = commitAll(dir, 'feature adds b.txt');
  mustGit(['checkout', '-q', 'main'], dir);
  writeFiles(dir, { 'a.txt': 'A\n', 'shared.txt': `${shared.map((l, i) => (i === 1 ? 'main edits line 2' : l)).join('\n')}\n` });
  const main = commitAll(dir, 'main adds a.txt');
  await pushRetry(dir, url, ['main:refs/heads/main', 'feature:refs/heads/feature']);
  const api = repoPath(repo);
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'Both sides', base: 'main', head: 'feature' } });
  const mb = await http(`${api}/changes/1/mergeability`);
  const m = mb.json?.mergeability;
  check(
    'VAL-MERGE-002',
    'mergeability clean, not fast-forward',
    created.status === 201 && m?.status === 'clean' && m?.mergeable === true && m?.fastForward === false,
    `${JSON.stringify({ status: m?.status, mergeable: m?.mergeable, fastForward: m?.fastForward, treeSha: m?.treeSha })} cost ${costOf('GET mergeability (cold)', mb)}`,
  );
  costOf('GET mergeability (warm)', await http(`${api}/changes/1/mergeability`));
  const merged = await http(`${api}/changes/1/merge`, { method: 'POST' });
  const after = (await http(`${api}/changes/1`)).json;
  const M = after.mergeCommit;
  check(
    'VAL-MERGE-002',
    'POST merge -> merged with a merge commit M',
    merged.status === 200 && after.state === 'merged' && /^[0-9a-f]{40}$/.test(M ?? '') && merged.json?.merge?.kind === 'merge',
    `${merged.status} M=${M} work=${JSON.stringify(merged.json?.merge?.work)} cost ${costOf('POST merge (3-way)', merged)}`,
  );
  const clone = git(['clone', '-q', url, `${repo}-clone`], work);
  const cdir = join(work, `${repo}-clone`);
  check('VAL-MERGE-009', 'fresh git clone completes', clone.code === 0, clone.err);
  const graph = git(['log', '--graph', '--oneline', '-5'], cdir).out;
  console.log(graph.split('\n').map((l) => `      ${l}`).join('\n'));
  const p1 = git(['rev-parse', `${M}^1`], cdir).out;
  const p2 = git(['rev-parse', `${M}^2`], cdir).out;
  const head = git(['rev-parse', 'HEAD'], cdir).out;
  check('VAL-MERGE-002', 'M^1 == pre-merge main, M^2 == feature tip', p1 === main && p2 === feature, `M^1=${p1} M^2=${p2}`);
  const a = git(['show', 'HEAD:a.txt'], cdir).out;
  const b = git(['show', 'HEAD:b.txt'], cdir).out;
  const sharedNow = git(['show', 'HEAD:shared.txt'], cdir).out;
  check(
    'VAL-MERGE-002',
    'tree has a.txt=A, b.txt=B and both edits of shared.txt',
    a === 'A' && b === 'B' && sharedNow.includes('main edits line 2') && sharedNow.includes('feature edits line 10'),
    `a=${a} b=${b}`,
  );
  const tree = git(['rev-parse', `${M}^{tree}`], cdir).out;
  const mt = git(['merge-tree', '--write-tree', main, feature], cdir);
  check(
    'VAL-MERGE-002',
    'merge tree (read through the Artifacts binding) == git merge-tree --write-tree',
    mt.code === 0 && mt.out.split('\n')[0] === tree && tree === m?.treeSha,
    `kvarm ${tree} / git ${mt.out.split('\n')[0]} / mergeability ${m?.treeSha}`,
  );
  check('VAL-MERGE-009', 'HEAD == mergeCommit, merge commit on main (graph shows it)', head === M && graph.includes('Merge change #1'), `HEAD=${head}`);
  check('VAL-MERGE-009', 'a.txt and b.txt present with expected content in the clone', a === 'A' && b === 'B');
  const fsck = git(['fsck', '--strict'], cdir);
  check('VAL-MERGE-009', 'git fsck --strict clean', fsck.code === 0, fsck.err);
});

await scenario('draft', async (repo) => {
  const dir = localRepo(repo);
  const url = gitUrl(repo);
  writeFiles(dir, { 'README.md': '# draft\n' });
  const m = commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'wip'], dir);
  writeFiles(dir, { 'wip.txt': 'wip\n' });
  const w = commitAll(dir, 'wip');
  await pushRetry(dir, url, ['main:refs/heads/main', 'wip:refs/heads/wip']);
  const api = repoPath(repo);
  const created = await http(`${api}/changes`, { method: 'POST', json: { title: 'WIP', base: 'main', head: 'wip', mergePolicy: 'draft' } });
  const refused = await http(`${api}/changes/1/merge`, { method: 'POST' });
  const still = (await http(`${api}/changes/1`)).json;
  check(
    'VAL-MERGE-004',
    'draft: POST merge -> 409 {error, code} naming the draft policy; state open; main unmoved',
    created.status === 201 && refused.status === 409 && refused.json?.code === 'DRAFT' && /draft/.test(refused.json?.error ?? '') && still.state === 'open' && lsRemote(url, 'refs/heads/main') === m,
    `${refused.status} ${refused.text} cost ${costOf('POST merge (draft refusal)', refused)}`,
  );
  const toReview = await http(`${api}/changes/1`, { method: 'PATCH', json: { mergePolicy: 'review' } });
  const merged = await http(`${api}/changes/1/merge`, { method: 'POST' });
  check(
    'VAL-MERGE-004',
    'PATCH to review -> 200; POST merge -> merged',
    toReview.status === 200 && merged.status === 200 && merged.json?.state === 'merged' && lsRemote(url, 'refs/heads/main') === w,
    `${toReview.status} / ${merged.status} state=${merged.json?.state}`,
  );
});

await scenario('auto', async (repo) => {
  const dir = localRepo(repo);
  const url = gitUrl(repo);
  writeFiles(dir, { 'README.md': 'one\n' });
  const root = commitAll(dir, 'base');
  mustGit(['checkout', '-q', '-b', 'quick'], dir);
  writeFiles(dir, { 'quick.txt': 'quick\n' });
  const quick = commitAll(dir, 'quick');
  mustGit(['checkout', '-q', '-b', 'clash', root], dir);
  writeFiles(dir, { 'README.md': 'clash\n' });
  const clash = commitAll(dir, 'clash');
  await pushRetry(dir, url, ['main:refs/heads/main', 'quick:refs/heads/quick', 'clash:refs/heads/clash']);
  const api = repoPath(repo);

  const auto = await http(`${api}/changes`, { method: 'POST', json: { title: 'Auto', base: 'main', head: 'quick', mergePolicy: 'auto' } });
  check(
    'VAL-MERGE-005',
    'auto policy with an empty required set merges at creation (contrast with review)',
    auto.status === 201 && auto.json.state === 'merged' && auto.json.mergeCommit === quick && lsRemote(url, 'refs/heads/main') === quick,
    `${auto.status} state=${auto.json?.state} cost ${costOf('POST changes (auto, merges)', auto)}`,
  );

  // main moved to `quick`; make main conflict with clash, then resolve by pushing a merge.
  mustGit(['checkout', '-q', 'main'], dir);
  mustGit(['merge', '-q', '--ff-only', 'quick'], dir);
  writeFiles(dir, { 'README.md': 'main\n' });
  const mainTip = commitAll(dir, 'main edits README');
  await pushRetry(dir, url, ['main:refs/heads/main']);
  const pending = await http(`${api}/changes`, { method: 'POST', json: { title: 'Clash', base: 'main', head: 'clash', mergePolicy: 'auto' } });
  const mb = (await http(`${api}/changes/${pending.json?.number}/mergeability`)).json?.mergeability;
  check(
    'VAL-MERGE-005',
    'auto change with conflicts stays open',
    pending.status === 201 && pending.json.state === 'open' && pending.json.headSha === clash && mb?.status === 'conflicts' && lsRemote(url, 'refs/heads/main') === mainTip,
    `state=${pending.json?.state} mergeability=${mb?.status} conflicts=${JSON.stringify(mb?.conflicts)}`,
  );
  mustGit(['checkout', '-q', 'clash'], dir);
  git(['merge', '-q', 'main'], dir);
  writeFiles(dir, { 'README.md': 'resolved\n' });
  const resolved = commitAll(dir, 'resolve');
  const t0 = Date.now();
  await pushRetry(dir, url, ['clash:refs/heads/clash']);
  let s = null;
  while (Date.now() - t0 < 60_000) {
    s = (await http(`${api}/changes/${pending.json.number}`)).json;
    if (s?.state === 'merged') break;
    await sleep(2000);
  }
  check(
    'VAL-MERGE-005',
    'pushing a resolution refreshes the head and the auto change merges',
    s?.state === 'merged' && s?.headSha === resolved && lsRemote(url, 'refs/heads/main') === resolved,
    `state=${s?.state} headSha=${s?.headSha} mergeCommit=${s?.mergeCommit} after ${Date.now() - t0} ms`,
  );
  const events = await http(`${api}/events?limit=3`);
  const hooks = (events.json?.events ?? []).map((e) => e.effects?.find((x) => x.effect === 'change-hooks')).filter(Boolean);
  console.log(`      change-hooks effects: ${JSON.stringify(hooks.map((h) => `${h.state}: ${h.detail}`))}`);
});

rmSync(work, { recursive: true, force: true });
console.log('\n# x-kvarm-cost');
for (const c of costs) console.log(`  ${c.label} (${c.status}): ${c.cost}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
