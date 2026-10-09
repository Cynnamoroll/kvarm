#!/usr/bin/env node
/**
 * Live driver for merge publication (m5-merge-engine).
 *
 * 1. As cynthia (FORGE_PAT) creates a fresh private repo
 *    `m5-merge-engine-live-<timestamp>` (empty).
 * 2. Reads its Artifacts remote and issues a short-lived repo-scoped WRITE
 *    token with `wrangler artifacts repos issue-token` (captured in memory,
 *    passed to the child by environment only, never printed).
 * 3. Runs `apps/platform/test/mergeLive.test.ts` in workerd: GitPusher pushes
 *    main (C1), feature (F1, diverged from C0) and ff-head (FF1 ahead of C1);
 *    services/merge.ts publishes a three-way merge of feature onto
 *    scratch/merge-* and a fast-forward to FF1 onto scratch/ff-*, and a
 *    re-publish of the stale plan is refused.
 * 4. Cross-checks through the platform git gate with real git: a fresh clone
 *    shows the FF ref at FF1; the merge commit has parents [C1, F1], the
 *    Forge committer and the tree `git merge-tree --write-tree main feature`
 *    computes; file contents carry both sides; `git fsck --strict` is clean.
 * 5. Deletes the repo and reads it back as 404.
 *
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper; tokens come from env by NAME (load
 * apps/platform/.dev.vars.validation).
 *
 * Usage: node scripts/merge-live-e2e.mjs [--keep]
 * Exit 0 when every check held, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
if (!process.env.FORGE_PAT) throw new Error('env FORGE_PAT is not set');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM = join(ROOT, 'apps/platform');
const REPO = `m5-merge-engine-live-${Date.now()}`;
const ARTIFACTS_NAME = `${OWNER}--${REPO}`.toLowerCase();

const results = [];
function check(label, ok, detail = '') {
  results.push({ ok: Boolean(ok), label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

async function http(path, { method = 'GET', json } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${process.env.FORGE_PAT}` } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  return { status: res.status, text, cost: res.headers.get('x-forge-cost') };
}

/** Runs wrangler from apps/platform and returns parsed --json output (never printed). */
function wranglerJson(wranglerArgs) {
  const r = spawnSync('npx', ['wrangler', ...wranglerArgs, '--json'], { cwd: PLATFORM, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`wrangler ${wranglerArgs.slice(0, 3).join(' ')} failed (${r.status})`);
  const start = r.stdout.indexOf('{');
  return JSON.parse(r.stdout.slice(start));
}

/** First string value under any of `keys`, searching nested objects. */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) if (typeof obj[k] === 'string') return obj[k];
  for (const v of Object.values(obj)) {
    const found = pick(v, keys);
    if (found) return found;
  }
  return undefined;
}

const work = mkdtempSync(join(tmpdir(), 'merge-live-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(gitArgs, cwd = work) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: process.env.FORGE_PAT };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...gitArgs], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function run() {
  const info = wranglerJson(['artifacts', 'repos', 'get', ARTIFACTS_NAME, '--namespace', 'default']);
  const remote = pick(info, ['remote', 'remoteUrl', 'url']);
  check('artifacts remote resolved', typeof remote === 'string' && remote.startsWith('https://'), remote ?? `keys: ${Object.keys(info)}`);
  const issued = wranglerJson(['artifacts', 'repos', 'issue-token', ARTIFACTS_NAME, '--namespace', 'default', '--scope', 'write', '--ttl', '900']);
  const token = pick(issued, ['plaintext', 'token']);
  check('write token issued (not printed)', typeof token === 'string' && token.length > 10, token ? '' : `keys: ${Object.keys(issued)}`);
  if (!remote || !token) return;

  const t0 = Date.now();
  const vt = spawnSync('npx', ['vitest', 'run', '--project', 'platform', 'apps/platform/test/mergeLive.test.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LIVE_MERGE: '1', LIVE_GITWRITE_REMOTE: remote, LIVE_GITWRITE_NAME: ARTIFACTS_NAME, LIVE_GITWRITE_TOKEN: token },
  });
  const out = `${vt.stdout}\n${vt.stderr}`;
  const line = out.split('\n').find((l) => l.includes('{"mergeLive"'));
  const live = line ? JSON.parse(line.slice(line.indexOf('{'))).mergeLive : null;
  const plain = out.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const passed = /Tests\s+1 passed/.test(plain) && vt.status === 0;
  check('workerd merge publication live test passed (1 test, not skipped)', passed && live, `exit ${vt.status}, ${Date.now() - t0} ms`);
  if (!live) {
    console.log(out.split(token).join('<redacted>').split('\n').slice(-40).join('\n'));
    return;
  }
  for (const [name, s] of Object.entries(live.steps)) console.log(`      ${name}: ${JSON.stringify(s)}`);
  console.log(`      merge work: ${JSON.stringify(live.work)}; objects pushed with the merge: ${live.mergeObjects}`);

  const url = `${BASE}/${OWNER}/${REPO}.git`;
  const clone = git(['clone', '-q', url, 'clone']);
  check('git clone through the gate', clone.code === 0, clone.err);
  const dir = join(work, 'clone');
  const scratchMerge = live.scratchMerge.replace('refs/heads/', 'origin/');
  const scratchFf = live.scratchFf.replace('refs/heads/', 'origin/');

  const ffAt = git(['rev-parse', scratchFf], dir).out;
  check('fast-forward: scratch ref moved to the head commit (mergeCommit = head)', ffAt === live.ff1, ffAt);
  const ffAncestor = git(['merge-base', '--is-ancestor', live.c1, ffAt], dir);
  check('fast-forward: previous target is an ancestor of the new value', ffAncestor.code === 0);

  const mergeAt = git(['rev-parse', scratchMerge], dir).out;
  check('three-way: scratch ref points at the published merge commit', mergeAt === live.mergeCommit, mergeAt);
  const parents = git(['rev-list', '--parents', '-n', '1', mergeAt], dir).out.split(' ').slice(1);
  check('three-way: two parents [target C1, head F1]', parents.join(',') === `${live.c1},${live.f1}`, parents.join(','));
  const who = git(['log', '-1', '--format=%cn <%ce>|%an <%ae>', mergeAt], dir).out;
  check('three-way: committed by Forge, authored by the merging user', who === `${live.committer}|Cynthia <cynthia@forge.invalid>`, who);
  const tree = git(['rev-parse', `${mergeAt}^{tree}`], dir).out;
  const gitTree = git(['merge-tree', '--write-tree', 'origin/main', 'origin/feature'], dir);
  check(
    'three-way: tree equals git merge-tree --write-tree main feature',
    gitTree.code === 0 && tree === live.mergeTree && gitTree.out.split('\n')[0] === tree,
    `${tree} vs git ${gitTree.out.split('\n')[0]}`,
  );
  const app = git(['show', `${mergeAt}:src/app.ts`], dir).out;
  check('three-way: src/app.ts carries both sides', app.includes('feature edits line 2') && app.includes('main edits line 9'));
  const files = git(['ls-tree', '-r', '--name-only', mergeAt], dir).out.split('\n');
  check(
    'three-way: rename, adds from both sides',
    files.includes('docs/new-name.md') && !files.includes('docs/old-name.md') && files.includes('main-only.txt') && files.includes('feature/new.txt'),
    files.join(','),
  );
  const fsck = git(['fsck', '--strict'], dir);
  check('git fsck --strict clean', fsck.code === 0, fsck.err);
}

try {
  const r = await withFixtureRepo(
    { owner: OWNER, repo: REPO, prefix: 'm5-merge-engine', http, keep: args.keep, visibility: 'private', log: console.log },
    run,
  );
  if (!r.ok) check('fixture repo', false, r.reason);
  if (!args.keep && r.created) {
    const gone = await http(`/api/v1/repos/${OWNER}/${REPO}`);
    check('repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (repo ${OWNER}/${REPO})`);
process.exit(failed.length === 0 ? 0 : 1);
