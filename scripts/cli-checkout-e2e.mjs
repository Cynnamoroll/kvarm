#!/usr/bin/env node
/**
 * Live validation driver for `kvarm checkout` (VAL-SNAP-007, VAL-SNAP-008).
 *
 * Sections (all by default, or pick with --only=ready,lazy,private):
 *
 * - ready    public repo with an exec file, symlinks, a >100-byte path, a
 *            unicode name, an empty file and literal backslash/drive-like
 *            POSIX names (`docs/back\slash.txt`, `..\literal.txt`,
 *            `C:notes`) pushed to main. After the eager
 *            build is ready, `kvarm checkout <repo> main <dir>` exits 0,
 *            prints `source: snapshot` and the sha from ls-remote, and
 *            `diff -r -x .git` against a git clone + checkout is empty. The
 *            documented "attach history" recipe (git init, fetch the sha,
 *            reset) gives a clean `git status`, and a commit on a new branch
 *            pushes.
 * - lazy     a fresh non-default branch with a new 1,500-file tree: metadata
 *            stays `absent` (no build without a demand), the first checkout
 *            demands it and prints `source: clone` with a matching tree, the
 *            snapshot reaches ready (trigger demand), and a second checkout
 *            prints `source: snapshot` with a matching tree. Then a new
 *            commit with the identical tree on another fresh branch: its
 *            demand reuses the tarball (reused, objects=0, r2a=0) and its
 *            checkout prints `source: snapshot` once ready.
 * - private  private repo: checkout with KVARM_PAT uses the snapshot; with
 *            KVARM_PAT_NO_API (git scope but no api scope) the API refuses
 *            and checkout clones; without a token checkout exits 1 and
 *            leaves no directory behind.
 *
 * Env (load apps/platform/.dev.vars.validation): KVARM_PAT (cynthia, owner),
 * KVARM_PAT_NO_API. Tokens are never printed; git runs with
 * `-c credential.helper=` and a secret-free GIT_ASKPASS helper, with the
 * configured git identity.
 *
 * Usage: node scripts/cli-checkout-e2e.mjs [--only=...] [--keep]
 * Exit 0 when every check held. Repos are named m4-cli-checkout-<purpose>-<ts>
 * and deleted at the end unless --keep.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: args } = parseArgs({ options: { only: { type: 'string' }, keep: { type: 'boolean', default: false } } });
const BASE = (process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev').replace(/\/+$/, '');
const OWNER = process.env.KVARM_USER ?? 'cynthia';
if (!process.env.KVARM_PAT) throw new Error('env KVARM_PAT is not set');
const SECTIONS = new Set((args.only ?? 'ready,lazy,private').split(','));
const READY_BOUND_MS = 120_000;
const PREFIX = 'm4-cli-checkout';
const KVARM_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'cli', 'bin', 'kvarm.js');
const ts = Date.now();

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(path, { method = 'GET', json, token = process.env.KVARM_PAT } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, cost: res.headers.get('x-kvarm-cost') };
}
const snapPath = (repo, ref) => `/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`;

const work = mkdtempSync(join(tmpdir(), 'cli-checkout-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo forge ;; *) printenv E2E_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(dir, gitArgs) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', E2E_GIT_TOKEN: process.env.KVARM_PAT };
  const r = spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.quotepath=off', ...gitArgs], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Runs the real CLI with only the given token env (never inherited). */
function kvarm(cliArgs, token) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, KVARM_BASE_URL: BASE };
  if (token) env.KVARM_PAT = process.env[token];
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [KVARM_BIN, ...cliArgs], { env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = { code: r.status, stdout: r.stdout ?? '', stderr: (r.stderr ?? '').trim(), ms: Date.now() - t0 };
  console.log(`#   kvarm ${cliArgs.join(' ')} [${token ?? 'no token'}] exit ${out.code} in ${out.ms} ms`);
  for (const line of out.stdout.trim().split('\n')) console.log(`#     stdout: ${line}`);
  for (const line of out.stderr.split('\n').filter(Boolean)) console.log(`#     stderr: ${line}`);
  return out;
}
const field = (stdout, key) => stdout.split('\n').find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2);

async function push(dir, refspec) {
  for (let i = 0; i < 10; i++) {
    const r = git(dir, ['push', '-q', 'origin', refspec]);
    if (r.code === 0 || !/503|warming|429/i.test(r.err)) return r;
    await sleep(3000);
  }
  return git(dir, ['push', '-q', 'origin', refspec]);
}

function initRepo(name) {
  const dir = join(work, name);
  mkdirSync(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['remote', 'add', 'origin', `${BASE}/${OWNER}/${name}.git`]);
  return dir;
}

function commitAll(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).out;
}

function writeTreeFiles(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# cli checkout ${ts}\n`);
  writeFileSync(join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n');
  chmodSync(join(dir, 'bin', 'tool.sh'), 0o755);
  symlinkSync('README.md', join(dir, 'readme-link'));
  symlinkSync('../README.md', join(dir, 'bin', 'up-link'));
  const long = join(dir, 'd'.repeat(60), 'e'.repeat(60));
  mkdirSync(long, { recursive: true });
  writeFileSync(join(long, `${'n'.repeat(110)}.txt`), 'long path\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'résumé-日本.md'), 'unicode\n');
  writeFileSync(join(dir, 'docs', 'empty.txt'), '');
  writeFileSync(join(dir, 'docs', 'back\\slash.txt'), 'backslash\n');
  writeFileSync(join(dir, '..\\literal.txt'), 'dotdot backslash\n');
  writeFileSync(join(dir, 'C:notes'), 'drive-like\n');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256)));
}

function writeMany(dir, count, salt) {
  for (let i = 0; i < count; i++) {
    const sub = join(dir, 'many', `d${i % 30}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `f${String(i).padStart(5, '0')}.txt`), `file ${i} ${salt}\n${'y'.repeat(300)}\n`);
  }
}

/** Polls metadata until 200 ready for `sha`; logs state changes. */
async function pollReady(repo, ref, sha, bound = READY_BOUND_MS) {
  const t0 = Date.now();
  let last = '';
  for (;;) {
    const r = await http(snapPath(repo, ref));
    const key = `${r.status} ${r.body?.state ?? ''} ${r.body?.sha?.slice(0, 12) ?? ''}`;
    if (key !== last) console.log(`#   poll ${ref}: ${Date.now() - t0}ms ${key}`);
    last = key;
    if (r.status === 200 && r.body?.state === 'ready' && r.body.sha === sha) return { ok: true, ms: Date.now() - t0, body: r.body };
    if (r.status >= 500 || r.status === 409 || Date.now() - t0 > bound) return { ok: false, ms: Date.now() - t0, body: r.body };
    await sleep(2000);
  }
}

/** git clone + checkout of `sha` (ground truth) and `diff -r -x .git`. */
function diffAgainstCheckout(label, name, sha, dir) {
  const truth = join(work, `truth-${label.replace(/[^\w.-]+/g, '_')}`);
  const cl = git(work, ['clone', '-q', '--no-checkout', `${BASE}/${OWNER}/${name}.git`, truth]);
  check(`${label}: ground-truth git clone`, cl.code, 0);
  check(`${label}: ground-truth git checkout ${sha.slice(0, 12)}`, git(truth, ['checkout', '-q', sha]).code, 0);
  const d = spawnSync('diff', ['-r', '-x', '.git', dir, truth], { encoding: 'utf8' });
  check(`${label}: diff -r -x .git <kvarm checkout> <git checkout> is empty`, `${d.status} ${d.stdout}${d.stderr}`.trim(), '0');
}

const http4fixture = (path, init = {}) => http(path, init);

async function sectionReady() {
  const name = `${PREFIX}-ready-${ts}`;
  const res = await withFixtureRepo({ owner: OWNER, repo: name, prefix: PREFIX, http: http4fixture, keep: args.keep, log: console.log }, async () => {
    const dir = initRepo(name);
    writeTreeFiles(dir);
    const sha = commitAll(dir, 'ready fixture');
    check('ready: push main', (await push(dir, 'main')).code, 0);
    const lsRemote = git(dir, ['ls-remote', 'origin', 'refs/heads/main']).out.split(/\s/)[0];
    check('ready: ls-remote main equals the pushed sha', lsRemote, sha);
    const ready = await pollReady(name, 'main', sha);
    check(`ready: snapshots/main ready within ${READY_BOUND_MS / 1000}s (${ready.ms} ms)`, ready.ok, true);

    const out = join(work, 'ready-checkout');
    const r = kvarm(['checkout', `${OWNER}/${name}`, 'main', out], 'KVARM_PAT');
    check('ready: kvarm checkout exit 0', r.code, 0);
    check('ready: stdout first line is `source: snapshot`', r.stdout.split('\n')[0], 'source: snapshot');
    check('ready: printed sha equals ls-remote', field(r.stdout, 'sha'), lsRemote);
    check('ready: printed bytes equal metadata size', Number(field(r.stdout, 'bytes')), ready.body?.size);
    check('ready: snapshot directory has no .git', existsSync(join(out, '.git')), false);
    diffAgainstCheckout('ready', name, sha, out);

    // The documented recipe for committing from a snapshot directory.
    check('ready: recipe git init', git(out, ['init', '-q']).code, 0);
    git(out, ['remote', 'add', 'origin', `${BASE}/${OWNER}/${name}.git`]);
    check('ready: recipe git fetch origin <sha>', git(out, ['fetch', '-q', 'origin', sha]).code, 0);
    check('ready: recipe git reset <sha>', git(out, ['reset', '-q', sha]).code, 0);
    check('ready: git status is clean after the reset', git(out, ['status', '--porcelain']).out, '');
    git(out, ['switch', '-q', '-c', `from-snapshot-${ts}`]);
    writeFileSync(join(out, 'from-snapshot.txt'), 'committed from a snapshot checkout\n');
    const next = commitAll(out, 'commit from a snapshot directory');
    check('ready: push of a commit made on top of the snapshot', (await push(out, `from-snapshot-${ts}`)).code, 0);
    const remote = git(out, ['ls-remote', 'origin', `refs/heads/from-snapshot-${ts}`]).out.split(/\s/)[0];
    check('ready: pushed branch points at the new commit', remote, next);
    check('ready: the new commit has the snapshot commit as parent', git(out, ['rev-parse', `${next}^`]).out, sha);
  });
  if (!res.ok) check(`ready: fixture repo ${name}`, res.reason, 'created');
}

async function sectionLazy() {
  const name = `${PREFIX}-lazy-${ts}`;
  const res = await withFixtureRepo({ owner: OWNER, repo: name, prefix: PREFIX, http: http4fixture, keep: args.keep, log: console.log }, async () => {
    const dir = initRepo(name);
    writeFileSync(join(dir, 'README.md'), `lazy ${ts}\n`);
    const mainSha = commitAll(dir, 'main');
    check('lazy: push main', (await push(dir, 'main')).code, 0);

    const branch = `lazy-${ts}`;
    git(dir, ['switch', '-q', '-c', branch]);
    writeMany(dir, 1500, `${ts}`);
    const sha = commitAll(dir, 'lazy branch, 1,500 new files');
    const tree = git(dir, ['rev-parse', `${sha}^{tree}`]).out;
    check(`lazy: push ${branch}`, (await push(dir, branch)).code, 0);
    console.log(`#   main ${mainSha.slice(0, 12)}, ${branch} ${sha.slice(0, 12)} tree ${tree.slice(0, 12)}`);

    // Give the push event time to be processed; a non-default branch must not build.
    await sleep(10_000);
    const before = await http(snapPath(name, branch));
    check('lazy: before any demand the branch snapshot is 202 absent (no eager build)', `${before.status} ${before.body?.state}`, '202 absent');

    const first = join(work, 'lazy-first');
    const r1 = kvarm(['checkout', `${OWNER}/${name}`, branch, first], 'KVARM_PAT');
    check('lazy: first kvarm checkout exit 0', r1.code, 0);
    check('lazy: first checkout prints `source: clone`', r1.stdout.split('\n')[0], 'source: clone');
    check('lazy: first checkout explains the demanded build on stderr', r1.stderr, (s) => /snapshot (building|absent)/.test(s) && /falling back to git clone/.test(s));
    check('lazy: first checkout sha', field(r1.stdout, 'sha'), sha);
    diffAgainstCheckout('lazy first (clone)', name, sha, first);

    const ready = await pollReady(name, branch, sha);
    check(`lazy: demanded snapshot ready within ${READY_BOUND_MS / 1000}s (${ready.ms} ms after the checkout)`, ready.ok, true);
    check('lazy: ready metadata trigger is demand', ready.body?.trigger, 'demand');
    console.log(`#   ready metadata: ${JSON.stringify({ size: ready.body?.size, files: ready.body?.files, reused: ready.body?.reused, buildCost: ready.body?.buildCost })}`);

    const second = join(work, 'lazy-second');
    const r2 = kvarm(['checkout', `${OWNER}/${name}`, branch, second], 'KVARM_PAT');
    check('lazy: later kvarm checkout exit 0', r2.code, 0);
    check('lazy: later checkout prints `source: snapshot`', r2.stdout.split('\n')[0], 'source: snapshot');
    diffAgainstCheckout('lazy later (snapshot)', name, sha, second);

    // A different commit with the identical tree reuses the tarball.
    const twin = `twin-${ts}`;
    const twinSha = git(dir, ['commit-tree', tree, '-p', sha, '-m', 'same tree, new commit']).out;
    git(dir, ['branch', twin, twinSha]);
    check(`lazy: push ${twin} (same tree, new commit)`, (await push(dir, twin)).code, 0);
    const third = join(work, 'lazy-twin');
    const r3 = kvarm(['checkout', `${OWNER}/${name}`, twin, third], 'KVARM_PAT');
    check('lazy: twin checkout exit 0', r3.code, 0);
    check('lazy: twin checkout sha', field(r3.stdout, 'sha'), twinSha);
    diffAgainstCheckout(`lazy twin (${r3.stdout.split('\n')[0]})`, name, twinSha, third);
    const twinReady = await pollReady(name, twin, twinSha);
    check(`lazy: twin snapshot ready (${twinReady.ms} ms)`, twinReady.ok, true);
    const bc = twinReady.body?.buildCost ?? {};
    check('lazy: twin reuses the identical tree tarball (reused, objects=0, r2a=0, same size)', `${twinReady.body?.reused} ${bc.objects} ${bc.r2a} ${twinReady.body?.size === ready.body?.size}`, 'true 0 0 true');
    const fourth = join(work, 'lazy-twin-again');
    const r4 = kvarm(['checkout', `${OWNER}/${name}`, twin, fourth], 'KVARM_PAT');
    check('lazy: twin checkout after ready prints `source: snapshot`', r4.stdout.split('\n')[0], 'source: snapshot');
    diffAgainstCheckout('lazy twin again', name, twinSha, fourth);
  });
  if (!res.ok) check(`lazy: fixture repo ${name}`, res.reason, 'created');
}

async function sectionPrivate() {
  const name = `${PREFIX}-private-${ts}`;
  const res = await withFixtureRepo({ owner: OWNER, repo: name, prefix: PREFIX, http: http4fixture, keep: args.keep, visibility: 'private', log: console.log }, async () => {
    const dir = initRepo(name);
    writeTreeFiles(dir);
    const sha = commitAll(dir, 'private fixture');
    check('private: push main', (await push(dir, 'main')).code, 0);
    const ready = await pollReady(name, 'main', sha);
    check(`private: snapshots/main ready (${ready.ms} ms)`, ready.ok, true);

    const a = join(work, 'private-pat');
    const r1 = kvarm(['checkout', `${OWNER}/${name}`, 'main', a], 'KVARM_PAT');
    check('private: checkout with KVARM_PAT prints `source: snapshot`', `${r1.code} ${r1.stdout.split('\n')[0]}`, '0 source: snapshot');
    diffAgainstCheckout('private snapshot', name, sha, a);

    if (process.env.KVARM_PAT_NO_API) {
      const b = join(work, 'private-noapi');
      const r2 = kvarm(['checkout', `${OWNER}/${name}`, 'main', b], 'KVARM_PAT_NO_API');
      check('private: checkout with a no-api PAT falls back to `source: clone`', `${r2.code} ${r2.stdout.split('\n')[0]}`, '0 source: clone');
      check('private: no-api fallback reason names the refused token', r2.stderr, (s) => /refused the token \(401/.test(s));
      diffAgainstCheckout('private no-api clone', name, sha, b);
    }

    const c = join(work, 'private-anon');
    const r3 = kvarm(['checkout', `${OWNER}/${name}`, 'main', c], undefined);
    check('private: checkout without a token exits 1', r3.code, 1);
    check('private: anonymous failure leaves no directory', existsSync(c), false);
  });
  if (!res.ok) check(`private: fixture repo ${name}`, res.reason, 'created');
}

try {
  if (SECTIONS.has('ready')) await sectionReady();
  if (SECTIONS.has('lazy')) await sectionLazy();
  if (SECTIONS.has('private')) await sectionPrivate();
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
