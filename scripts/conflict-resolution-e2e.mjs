#!/usr/bin/env node
/**
 * Live driver for automatic conflict resolution (m5-conflict-resolution):
 * VAL-CONFLICT-001..006 and the resolve-conflict task listing (GET tasks).
 *
 * Every scenario runs in a fresh public repo owned by KVARM_USER, named
 * `m5-conflict-resolution-<purpose>-<timestamp>`, seeded with real git
 * pushes from one branch point holding `lines.txt` (20 numbered lines), and
 * deleted afterwards (unless --keep):
 *   nonoverlap   main edits line 2, feature line 18 → mergeability clean
 *                (resolved: non-overlapping), merge, clone has both edits
 *   identical    both sides change line 5 identically → clean, line 5 once
 *   whitespace   line 7 indented with four spaces (main) vs a tab (feature)
 *                → clean (resolved: whitespace-only), merged line = main's
 *   addadd       both add both.txt with identical content → one path
 *   policy       draft change stays open (polled), auto change merges itself
 *   conflict     same line, different text → state conflicted with
 *                conflicts [{path, kind}], merge 409, one open
 *                resolve-conflict task; a pushed resolution reopens the
 *                change and retires the task
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/conflict-resolution-e2e.mjs [--keep] [--only nonoverlap,conflict]
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper. Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } } });
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm5-conflict-resolution';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

function die(msg) {
  console.error(`conflict-resolution-e2e: ${msg}`);
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

const work = mkdtempSync(join(tmpdir(), 'conflict-resolution-e2e-'));
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
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitAll(dir, msg) {
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const linesWith = (edits) => LINES.map((l, i) => (edits[i + 1] ?? l) + '\n').join('');
const repoPath = (repo) => `/api/v1/repos/${OWNER}/${repo}`;
const gitUrl = (repo) => `${BASE}/${OWNER}/${repo}.git`;

/** Base commit with lines.txt; main and each branch commit their own files on top of it. */
async function seed(repo, mainFiles, branches) {
  const dir = join(work, repo);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  writeFiles(dir, { 'README.md': `# ${repo}\n`, 'lines.txt': linesWith({}) });
  const base = commitAll(dir, 'base');
  const heads = {};
  for (const [name, files] of Object.entries(branches)) {
    mustGit(['checkout', '-q', '-b', name, base], dir);
    writeFiles(dir, files);
    heads[name] = commitAll(dir, `${name} work`);
  }
  mustGit(['checkout', '-q', 'main'], dir);
  writeFiles(dir, mainFiles);
  const main = commitAll(dir, 'main work');
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', ...Object.keys(branches).map((b) => `${b}:refs/heads/${b}`)]);
  return { dir, base, main, heads };
}

/** A fresh clone of main: file name -> content (top level). */
function cloneMain(repo) {
  const dir = join(work, `${repo}-clone-${Date.now()}`);
  mustGit(['clone', '-q', '--branch', 'main', gitUrl(repo), dir], work);
  const out = {};
  for (const name of readdirSync(dir)) if (name !== '.git') out[name] = readFileSync(join(dir, name), 'utf8');
  return { files: out, head: mustGit(['rev-parse', 'HEAD'], dir), parents: mustGit(['log', '-1', '--format=%P'], dir).split(' ') };
}

async function create(repo, head, mergePolicy) {
  const r = await http(`${repoPath(repo)}/changes`, { method: 'POST', json: { title: `${head} (${mergePolicy})`, base: 'main', head, mergePolicy } });
  costOf(`POST changes (${repo.replace(`${PREFIX}-`, '').replace(`-${TS}`, '')}, ${mergePolicy})`, r);
  return r;
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

/** Mergeability, merge and a clone of main for a review change that should resolve. */
async function resolvesAndMerges(id, repo, head, expectResolved) {
  const api = repoPath(repo);
  const created = await create(repo, head, 'review');
  const n = created.json?.number;
  const m = await http(`${api}/changes/${n}/mergeability`);
  const mv = m.json?.mergeability;
  check(
    id,
    'GET mergeability → state open, status clean, mergeable, conflicts [] (resolved by the deterministic rules)',
    created.status === 201 &&
      m.status === 200 &&
      m.json?.state === 'open' &&
      mv?.status === 'clean' &&
      mv?.mergeable === true &&
      mv?.conflicts?.length === 0 &&
      JSON.stringify(mv?.resolved) === JSON.stringify(expectResolved),
    `${m.status} state=${m.json?.state} status=${mv?.status} mergeable=${mv?.mergeable} conflicts=${JSON.stringify(mv?.conflicts)} resolved=${JSON.stringify(mv?.resolved)} cost ${costOf(`GET mergeability (${id})`, m)}`,
  );
  const merged = await http(`${api}/changes/${n}/merge`, { method: 'POST' });
  check(
    id,
    'POST merge → 200 state merged (two-parent merge commit)',
    merged.status === 200 && merged.json?.state === 'merged' && merged.json?.merge?.kind === 'merge',
    `${merged.status} state=${merged.json?.state} kind=${merged.json?.merge?.kind} cost ${costOf(`POST merge (${id})`, merged)}`,
  );
  return cloneMain(repo);
}

// ---------------------------------------------------------------------------

await scenario('nonoverlap', async (repo) => {
  const { main } = await seed(repo, { 'lines.txt': linesWith({ 2: 'line 2 main' }) }, { feature: { 'lines.txt': linesWith({ 18: 'line 18 feature' }) } });
  const clone = await resolvesAndMerges('VAL-CONFLICT-001', repo, 'feature', [{ path: 'lines.txt', rule: 'non-overlapping' }]);
  const lines = clone.files['lines.txt'] ?? '';
  check(
    'VAL-CONFLICT-001',
    'clone: lines.txt has BOTH edits and every other line intact; first parent is the old main',
    lines === linesWith({ 2: 'line 2 main', 18: 'line 18 feature' }) && clone.parents[0] === main,
    `line2=${JSON.stringify(lines.split('\n')[1])} line18=${JSON.stringify(lines.split('\n')[17])} lines=${lines.split('\n').length - 1}`,
  );
});

await scenario('identical', async (repo) => {
  await seed(repo, { 'lines.txt': linesWith({ 5: 'line 5 shared' }), 'main.txt': 'main\n' }, { feature: { 'lines.txt': linesWith({ 5: 'line 5 shared' }), 'feature.txt': 'feature\n' } });
  const clone = await resolvesAndMerges('VAL-CONFLICT-002', repo, 'feature', [{ path: 'lines.txt', rule: 'identical-change' }]);
  const lines = clone.files['lines.txt'] ?? '';
  check(
    'VAL-CONFLICT-002',
    'clone: line 5 equals the shared text, once; both sides’ own files present',
    lines.split('\n')[4] === 'line 5 shared' && (lines.match(/line 5 shared/g) ?? []).length === 1 && lines === linesWith({ 5: 'line 5 shared' }) && clone.files['main.txt'] === 'main\n' && clone.files['feature.txt'] === 'feature\n',
    `line5=${JSON.stringify(lines.split('\n')[4])} occurrences=${(lines.match(/line 5 shared/g) ?? []).length}`,
  );
});

await scenario('whitespace', async (repo) => {
  await seed(repo, { 'lines.txt': linesWith({ 7: '    line 7 indented' }) }, { feature: { 'lines.txt': linesWith({ 7: '\tline 7 indented' }) } });
  const clone = await resolvesAndMerges('VAL-CONFLICT-003', repo, 'feature', [{ path: 'lines.txt', rule: 'whitespace-only', hunks: 1 }]);
  const lines = clone.files['lines.txt'] ?? '';
  check(
    'VAL-CONFLICT-003',
    'clone: line 7 equals one whitespace variant (the base branch’s: four spaces); file otherwise intact',
    lines === linesWith({ 7: '    line 7 indented' }),
    `line7=${JSON.stringify(lines.split('\n')[6])}`,
  );
});

await scenario('addadd', async (repo) => {
  await seed(repo, { 'both.txt': 'same\ncontent\n', 'main.txt': 'main\n' }, { feature: { 'both.txt': 'same\ncontent\n', 'feature.txt': 'feature\n' } });
  const clone = await resolvesAndMerges('VAL-CONFLICT-004', repo, 'feature', [{ path: 'both.txt', rule: 'add-add-identical' }]);
  const paths = Object.keys(clone.files).sort();
  check(
    'VAL-CONFLICT-004',
    'clone: exactly one both.txt with the identical content',
    clone.files['both.txt'] === 'same\ncontent\n' && paths.filter((p) => p === 'both.txt').length === 1,
    `both.txt=${JSON.stringify(clone.files['both.txt'])} paths=${paths.join(',')}`,
  );
});

await scenario('policy', async (repo) => {
  const api = repoPath(repo);
  const { main } = await seed(repo, { 'lines.txt': linesWith({ 2: 'line 2 main' }) }, {
    drafty: { 'lines.txt': linesWith({ 18: 'line 18 draft' }) },
    autoed: { 'lines.txt': linesWith({ 10: 'line 10 auto' }) },
  });
  const draft = await create(repo, 'drafty', 'draft');
  const dm = await http(`${api}/changes/${draft.json?.number}/mergeability`);
  const states = new Set();
  for (let i = 0; i < 6; i++) {
    states.add((await http(`${api}/changes/${draft.json?.number}`)).json?.state);
    await sleep(5000);
  }
  const auto = await create(repo, 'autoed', 'auto');
  let autoState = auto.json;
  for (let i = 0; i < 20 && autoState?.state !== 'merged'; i++) {
    await sleep(2000);
    autoState = (await http(`${api}/changes/${auto.json?.number}`)).json;
  }
  const clone = cloneMain(repo);
  // Green checks: kvarm/guard (the checks-gate producer since m5-guard-check) passed on both heads.
  const guardOf = async (n) => (await http(`${api}/changes/${n}/checks`)).json?.checks?.map((c) => `${c.name}:${c.status}`);
  const draftChecks = await guardOf(draft.json?.number);
  const autoChecks = await guardOf(auto.json?.number);
  console.log(`checks: draft ${JSON.stringify(draftChecks)} (gate ${dm.json?.mergeability?.checks?.state}); auto ${JSON.stringify(autoChecks)}`);
  check(
    'VAL-CONFLICT-005',
    'both changes have green required checks (kvarm/guard success; draft gate state success)',
    JSON.stringify(draftChecks) === '["kvarm/guard:success"]' && JSON.stringify(autoChecks) === '["kvarm/guard:success"]' && dm.json?.mergeability?.checks?.state === 'success',
  );
  check(
    'VAL-CONFLICT-005',
    'draft: resolvable (clean, mergeable) yet stays open over a 30 s poll and main is untouched by it',
    draft.status === 201 && dm.json?.mergeability?.status === 'clean' && dm.json?.mergeability?.mergeable === true && states.size === 1 && states.has('open'),
    `draft states=${[...states].join(',')} mergeability=${dm.json?.mergeability?.status}`,
  );
  check(
    'VAL-CONFLICT-005',
    'auto: the resolved change merges itself (mergeCommit set) with both edits on main',
    auto.status === 201 && autoState?.state === 'merged' && /^[0-9a-f]{40}$/.test(autoState?.mergeCommit ?? '') && clone.files['lines.txt'] === linesWith({ 2: 'line 2 main', 10: 'line 10 auto' }) && clone.parents[0] === main,
    `create ${auto.status} state=${auto.json?.state} final=${autoState?.state} mergeCommit=${autoState?.mergeCommit?.slice(0, 8)} create cost ${auto.cost}`,
  );
});

await scenario('conflict', async (repo) => {
  const api = repoPath(repo);
  const { dir, main, heads } = await seed(repo, { 'lines.txt': linesWith({ 9: 'line 9 main' }) }, { feature: { 'lines.txt': linesWith({ 9: 'line 9 feature' }) } });
  const created = await create(repo, 'feature', 'review');
  const n = created.json?.number;
  const d = await http(`${api}/changes/${n}`);
  const m = await http(`${api}/changes/${n}/mergeability`);
  const want = JSON.stringify([{ path: 'lines.txt', kind: 'content' }]);
  check(
    'VAL-CONFLICT-006',
    'GET change → state conflicted, conflicts [{path: lines.txt, kind: content}]; mergeability status conflicts, not mergeable',
    created.status === 201 &&
      created.json?.state === 'conflicted' &&
      d.json?.state === 'conflicted' &&
      JSON.stringify(d.json?.conflicts) === want &&
      m.json?.state === 'conflicted' &&
      m.json?.mergeability?.status === 'conflicts' &&
      m.json?.mergeability?.mergeable === false &&
      JSON.stringify(m.json?.mergeability?.conflicts) === want,
    `create state=${created.json?.state}; GET ${d.status} state=${d.json?.state} conflicts=${JSON.stringify(d.json?.conflicts)} cost ${costOf('GET change (conflicted, steady)', d)}; mergeability ${m.json?.mergeability?.status} cost ${costOf('GET mergeability (conflicted)', m)}`,
  );
  const refused = await http(`${api}/changes/${n}/merge`, { method: 'POST' });
  const ref = git(['ls-remote', gitUrl(repo), 'refs/heads/main'], work).out.split('\t')[0];
  check(
    'VAL-CONFLICT-006',
    'POST merge → 409 {error, code: MERGE_CONFLICT, conflicts}; main unchanged',
    refused.status === 409 && refused.json?.code === 'MERGE_CONFLICT' && typeof refused.json?.error === 'string' && JSON.stringify(refused.json?.conflicts) === want && ref === main,
    `${refused.status} ${refused.text} cost ${costOf('POST merge (conflicted)', refused)}; main=${ref?.slice(0, 8)}`,
  );
  const tasks = await http(`${api}/tasks?status=open`);
  const t = tasks.json?.tasks ?? [];
  check(
    'VAL-CONFLICT-006',
    'GET tasks?status=open → one resolve-conflict task naming change #n, its head and base commits and the conflicts; d1 ≤ 2',
    tasks.status === 200 &&
      t.length === 1 &&
      t[0].kind === 'resolve-conflict' &&
      t[0].status === 'open' &&
      t[0].change?.number === n &&
      t[0].change?.state === 'conflicted' &&
      t[0].headSha === heads.feature &&
      t[0].baseSha === main &&
      JSON.stringify(t[0].conflicts) === want &&
      /(^|;)d1=[12](;|$)/.test(tasks.cost ?? ''),
    `${tasks.status} tasks=${t.length} kind=${t[0]?.kind} change=${JSON.stringify(t[0]?.change)} head=${t[0]?.headSha?.slice(0, 8)} base=${t[0]?.baseSha?.slice(0, 8)} cost ${costOf('GET tasks?status=open', tasks)}`,
  );
  const again = await http(`${api}/changes/${n}`);
  const anon = await http(`${api}/tasks`, { token: null });
  check(
    'VAL-CONFLICT-006',
    'a repeated read writes nothing (rw=0) and keeps one task; anonymous GET tasks on the public repo is allowed',
    /(^|;)rw=0(;|$)/.test(again.cost ?? '') && anon.status === 200 && (anon.json?.tasks ?? []).length === 1,
    `GET change cost ${costOf('GET change (conflicted, repeat)', again)}; anonymous tasks ${anon.status} n=${(anon.json?.tasks ?? []).length}`,
  );

  // Resolve by merging main into feature and pushing: the change reopens and the task is retired.
  mustGit(['checkout', '-q', 'feature'], dir);
  git(['merge', '-q', '--no-edit', 'main'], dir);
  writeFiles(dir, { 'lines.txt': linesWith({ 9: 'line 9 main and feature' }) });
  const fixed = commitAll(dir, 'resolve conflict');
  await pushRetry(dir, gitUrl(repo), ['feature:refs/heads/feature']);
  let after = null;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    after = (await http(`${api}/changes/${n}`)).json;
    if (after?.headSha === fixed && after?.state === 'open') break;
  }
  const retired = await http(`${api}/tasks?status=all`);
  check(
    'VAL-CONFLICT-006',
    'after a pushed resolution: state open, conflicts [], mergeable; the task is obsolete',
    after?.headSha === fixed && after?.state === 'open' && after?.conflicts?.length === 0 && after?.mergeability?.mergeable === true && (retired.json?.tasks ?? []).map((x) => x.status).join() === 'obsolete',
    `head=${after?.headSha?.slice(0, 8)} state=${after?.state} mergeability=${after?.mergeability?.status} tasks=${(retired.json?.tasks ?? []).map((x) => x.status).join()}`,
  );
  const merged = await http(`${api}/changes/${n}/merge`, { method: 'POST' });
  check('VAL-CONFLICT-006', 'the resolved change then merges', merged.status === 200 && merged.json?.state === 'merged', `${merged.status} ${merged.json?.state}`);
});

rmSync(work, { recursive: true, force: true });
console.log('\n# x-kvarm-cost');
for (const c of costs) console.log(`  ${c.label} (${c.status}): ${c.cost}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
