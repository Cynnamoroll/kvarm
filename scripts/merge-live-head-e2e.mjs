#!/usr/bin/env node
/**
 * Live driver for the merge live-head confirmation: a merge issued right
 * after a push must publish the pushed head or refuse 409 HEAD_MOVED naming
 * it, never the change's previous (recorded) head.
 *
 * One fresh public repo owned by KVARM_USER, named
 * `merge-live-head-confirmation-pushmerge-<timestamp>`, deleted afterwards
 * (unless --keep). Three review changes on their own branches:
 *   force   force-push the head to a rewrite, POST merge at once
 *   ff      push a descendant to the head, POST merge at once
 *   auto    push a descendant, PATCH mergePolicy auto at once
 * Every 409 HEAD_MOVED must name the live sha; the client re-reads the change
 * and merges again. The landed main must contain the newest head and, for
 * the force-push, not the rewritten-away commit.
 *
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/merge-live-head-e2e.mjs [--keep]
 * Tokens are read by NAME and never printed. Git runs with
 * `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a secret-free
 * GIT_ASKPASS helper, with the configured git identity. Exit 0 only when
 * every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const PREFIX = 'merge-live-head-confirmation';
const REPO = `${PREFIX}-pushmerge-${Math.floor(Date.now() / 1000)}`;
const results = [];

function die(msg) {
  console.error(`merge-live-head-e2e: ${msg}`);
  process.exit(2);
}

function check(label, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (sha ? sha.slice(0, 10) : String(sha));

async function http(path, { method = 'GET', json } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${PAT}` } };
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

const work = mkdtempSync(join(tmpdir(), 'merge-live-head-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: PAT };
const dir = join(work, 'repo');
const gitUrl = `${BASE}/${OWNER}/${REPO}.git`;
const api = `/api/v1/repos/${OWNER}/${REPO}`;

function git(args) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd: dir, env: gitEnv, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function mustGit(args) {
  const r = git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}

async function push(refspec) {
  let last = '';
  for (let i = 0; i < 8; i++) {
    const r = git(['push', '-q', gitUrl, refspec]);
    if (r.code === 0) return;
    last = r.err;
    await sleep(3000);
  }
  throw new Error(`push ${refspec} kept failing: ${last}`);
}

function commitOn(from, file, content, msg) {
  mustGit(['checkout', '-q', '--detach', from]);
  writeFileSync(join(dir, file), content);
  mustGit(['add', '-A']);
  mustGit(['commit', '-q', '-m', msg]);
  return mustGit(['rev-parse', 'HEAD']);
}

/** Fetches main and answers whether `sha` is in its history. */
function onMain(sha) {
  mustGit(['fetch', '-q', gitUrl, '+refs/heads/main:refs/remotes/origin/main']);
  return git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']).code === 0;
}

/** A review change on `branch` whose head is one commit on main. */
async function openChange(main, branch) {
  const head = commitOn(main, `${branch}.txt`, `${branch} v1\n`, `${branch} v1`);
  await push(`${head}:refs/heads/${branch}`);
  const r = await http(`${api}/changes`, { method: 'POST', json: { title: branch, base: 'main', head: branch, mergePolicy: 'review' } });
  if (r.status !== 201 || r.json?.headSha !== head) throw new Error(`create change ${branch}: ${r.status} ${r.text.slice(0, 200)}`);
  return { number: r.json.number, head };
}

/** Merges at once; on HEAD_MOVED re-reads the change and merges again (bounded). */
async function mergeNow(number) {
  const moved = [];
  let r = await http(`${api}/changes/${number}/merge`, { method: 'POST' });
  for (let i = 0; i < 40 && r.status === 409 && r.json?.code === 'HEAD_MOVED'; i++) {
    moved.push(r);
    await sleep(1500);
    await http(`${api}/changes/${number}`);
    r = await http(`${api}/changes/${number}/merge`, { method: 'POST' });
  }
  return { final: r, moved };
}

function report(label, { final, moved }) {
  if (moved.length) console.log(`${label}: 409 HEAD_MOVED ×${moved.length}, first ${moved[0].text} (x-kvarm-cost ${moved[0].cost})`);
  else console.log(`${label}: no HEAD_MOVED (the push event had already recorded the head)`);
  console.log(`${label}: final ${final.status} mergeCommit=${short(final.json?.mergeCommit)} headSha=${short(final.json?.headSha)} (x-kvarm-cost ${final.cost})`);
}

const r = await withFixtureRepo({ owner: OWNER, repo: REPO, prefix: PREFIX, http, keep: opts.keep, visibility: 'public', log: console.log }, async () => {
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), `# ${REPO}\n`);
  mustGit(['add', '-A']);
  mustGit(['commit', '-q', '-m', 'base']);
  const main = mustGit(['rev-parse', 'HEAD']);
  await push('main:refs/heads/main');
  console.log(`# ${OWNER}/${REPO} main=${short(main)}`);

  // force: the head is force-pushed to a rewrite that does not contain the recorded head.
  const force = await openChange(main, 'force');
  const rewritten = commitOn(main, 'force.txt', 'force rewritten\n', 'force rewritten');
  await push(`+${rewritten}:refs/heads/force`);
  const fm = await mergeNow(force.number);
  report(`force-push ${short(force.head)} -> ${short(rewritten)}, merge #${force.number}`, fm);
  check('force: every HEAD_MOVED names the live rewrite and the recorded head', fm.moved.every((m) => m.json?.headSha === rewritten && m.json?.recordedHead === force.head));
  check('force: the merge lands with the rewrite as its head', fm.final.status === 200 && fm.final.json?.headSha === rewritten);
  check('force: main contains the rewrite and not the rewritten-away commit', onMain(rewritten) && !onMain(force.head));

  // ff: a descendant is pushed; the fast-forward must take the new head.
  const tip = mustGit(['rev-parse', 'refs/remotes/origin/main']);
  const ff = await openChange(tip, 'ff');
  const next = commitOn(ff.head, 'ff.txt', 'ff v2\n', 'ff v2');
  await push(`${next}:refs/heads/ff`);
  const fr = await mergeNow(ff.number);
  report(`push ${short(ff.head)} -> ${short(next)}, merge #${ff.number}`, fr);
  check('ff: every HEAD_MOVED names the pushed head', fr.moved.every((m) => m.json?.headSha === next && m.json?.recordedHead === ff.head));
  check('ff: the merge lands with the pushed head', fr.final.status === 200 && fr.final.json?.headSha === next && onMain(next));

  // auto: PATCH to auto right after a push; it merges only the live head (now, or when the push event lands).
  const tip2 = mustGit(['rev-parse', 'refs/remotes/origin/main']);
  const au = await openChange(tip2, 'auto');
  const next3 = commitOn(au.head, 'auto.txt', 'auto v2\n', 'auto v2');
  await push(`${next3}:refs/heads/auto`);
  const p = await http(`${api}/changes/${au.number}`, { method: 'PATCH', json: { mergePolicy: 'auto' } });
  console.log(`PATCH #${au.number} mergePolicy auto right after push ${short(au.head)} -> ${short(next3)}: ${p.status} state=${p.json?.state} headSha=${short(p.json?.headSha)} mergeCommit=${short(p.json?.mergeCommit)} (x-kvarm-cost ${p.cost})`);
  check('auto: PATCH never merges the previous head', p.status === 200 && !(p.json?.state === 'merged' && p.json?.headSha !== next3));
  let c = p.json;
  for (let i = 0; i < 40 && c?.state !== 'merged'; i++) {
    await sleep(1500);
    c = (await http(`${api}/changes/${au.number}`)).json;
  }
  console.log(`change #${au.number}: state=${c?.state} headSha=${short(c?.headSha)} mergeCommit=${short(c?.mergeCommit)}`);
  check('auto: the change merges with the pushed head', c?.state === 'merged' && c.headSha === next3 && onMain(next3));
});
if (!r.ok) check(`fixture repo ${REPO}`, false, r.reason);
if (!opts.keep && r.created) {
  const gone = await http(api);
  check(`scratch repo ${REPO} deleted (owner readback 404)`, gone.status === 404, String(gone.status));
}
rmSync(work, { recursive: true, force: true });
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
