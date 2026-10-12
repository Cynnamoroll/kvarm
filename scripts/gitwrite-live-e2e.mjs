#!/usr/bin/env node
/**
 * Live driver for the server-side git write path (m5-gitops-write-path).
 *
 * 1. As cynthia (KVARM_PAT) creates a fresh private repo
 *    `m5-gitops-write-path-live-<timestamp>` (empty).
 * 2. Reads its Artifacts remote and issues a short-lived repo-scoped WRITE
 *    token with `wrangler artifacts repos issue-token` (captured in memory,
 *    passed to the child by environment only, never printed).
 * 3. Runs `apps/platform/test/gitwriteLive.test.ts` in workerd: the Worker's
 *    GitPusher (services/gitwrite.ts, token via getGitToken's write cache)
 *    creates main with a pack it wrote, creates a scratch ref with the empty
 *    pack, gets `stale ref` (HTTP 200) for create-on-existing, a stale old
 *    OID and a stale delete, fast-forwards, makes a correct-old non-FF
 *    update and deletes the scratch ref.
 * 4. Cross-checks through the platform git gate with real git: a fresh clone
 *    has main at C0 with the expected README, `git fsck` is clean, and
 *    ls-remote shows no scratch ref.
 * 5. Deletes the repo and reads it back as 404.
 *
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper; tokens come from env by NAME (load
 * apps/platform/.dev.vars.validation).
 *
 * Usage: node scripts/gitwrite-live-e2e.mjs [--keep]
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
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
if (!process.env.KVARM_PAT) throw new Error('env KVARM_PAT is not set');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLATFORM = join(ROOT, 'apps/platform');
const REPO = `m5-gitops-write-path-live-${Date.now()}`;
const ARTIFACTS_NAME = `${OWNER}--${REPO}`.toLowerCase();

const results = [];
function check(label, ok, detail = '') {
  results.push({ ok: Boolean(ok), label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

async function http(path, { method = 'GET', json } = {}) {
  const init = { method, headers: { Authorization: `Bearer ${process.env.KVARM_PAT}` } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  return { status: res.status, text, cost: res.headers.get('x-kvarm-cost') };
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

const work = mkdtempSync(join(tmpdir(), 'gitwrite-live-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(gitArgs, cwd = work) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: process.env.KVARM_PAT };
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
  const vt = spawnSync('npx', ['vitest', 'run', '--project', 'platform', 'apps/platform/test/gitwriteLive.test.ts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LIVE_GITWRITE_REMOTE: remote, LIVE_GITWRITE_NAME: ARTIFACTS_NAME, LIVE_GITWRITE_TOKEN: token },
  });
  const out = `${vt.stdout}\n${vt.stderr}`;
  const line = out.split('\n').find((l) => l.includes('{"gitwriteLive"'));
  const live = line ? JSON.parse(line.slice(line.indexOf('{'))).gitwriteLive : null;
  const plain = out.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const passed = /Tests\s+1 passed/.test(plain) && vt.status === 0;
  check('workerd GitPusher live test passed (1 test, not skipped)', passed && live, `exit ${vt.status}, ${Date.now() - t0} ms`);
  if (!live) {
    console.log(out.split(token).join('<redacted>').split('\n').slice(-40).join('\n'));
    return;
  }
  for (const [name, s] of Object.entries(live.steps)) console.log(`      ${name}: ${JSON.stringify(s)}`);

  const url = `${BASE}/${OWNER}/${REPO}.git`;
  const clone = git(['clone', '-q', url, 'clone']);
  check('git clone through the gate', clone.code === 0, clone.err);
  const head = git(['rev-parse', 'HEAD'], join(work, 'clone')).out;
  check('clone main is C0 written by GitPusher', head === live.c0, head);
  const readme = git(['show', 'HEAD:README.md'], join(work, 'clone')).out;
  check('README content matches', readme === 'gitwrite live C0', JSON.stringify(readme));
  const fsck = git(['fsck', '--strict'], join(work, 'clone'));
  check('git fsck --strict clean', fsck.code === 0, fsck.err);
  const lsRemote = git(['ls-remote', url]);
  const refs = lsRemote.out.split('\n').filter(Boolean).map((l) => l.split('\t')[1]);
  check('ls-remote: scratch ref deleted, main kept', !refs.includes(live.scratch) && refs.includes('refs/heads/main'), refs.join(','));
}

try {
  const r = await withFixtureRepo(
    { owner: OWNER, repo: REPO, prefix: 'm5-gitops-write-path', http, keep: args.keep, visibility: 'private', log: console.log },
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
