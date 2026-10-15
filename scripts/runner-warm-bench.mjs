/**
 * Live warm-workdir check and claim->report benchmark for `kvarm runner`.
 *
 * Creates a scratch repository holding a small TypeScript + vitest project
 * whose CI job installs its dependencies (`npm install`) and then type-checks
 * and tests. Each sample pushes a new head (one file modified, one added, one
 * deleted) and runs `kvarm runner --once` against it, alternating a cold job
 * (`--fresh`: empty workdir, full install) with a warm job (the next commit
 * synced into the same workdir, node_modules reused). After every job the
 * workdir's tracked state is compared with `git archive` of that commit, and
 * the runner's own claim->report span is collected. A final section runs two
 * runner processes concurrently and checks they hold different slots.
 *
 * Usage (after loading .env.local):
 *   node scripts/runner-warm-bench.mjs [--samples 5] [--isolated-npm-cache] [--snapshot-ready] [--keep]
 *
 * By default npm installs from the machine's npm cache (~/.npm). With
 * --isolated-npm-cache the job keeps its npm cache in .cache/npm inside the
 * workdir, so a cold job downloads every package from the registry, as a
 * fresh CI machine would, while a warm job keeps it. A job claimed right after
 * its push usually finds the snapshot still building and uses the clone
 * fallback; --snapshot-ready demands the snapshot and waits until it is ready
 * before running the runner, so the snapshot path is measured instead.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { kvarmBin } from './lib/kvarm-bin.mjs';

const { values } = parseArgs({ options: { samples: { type: 'string', default: '5' }, keep: { type: 'boolean', default: false }, 'isolated-npm-cache': { type: 'boolean', default: false }, 'snapshot-ready': { type: 'boolean', default: false } } });
const SAMPLES = Number(values.samples);
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const PAT = process.env.KVARM_PAT;
const OWNER = process.env.KVARM_USER ?? 'admin';
if (!PAT) throw new Error('KVARM_PAT is required');
if (!Number.isInteger(SAMPLES) || SAMPLES < 1) throw new Error('--samples must be a positive integer');
const repo = `ci-runner-warm-workdir-bench-${Math.floor(Date.now() / 1000)}`;
const R = `/api/v1/repos/${OWNER}/${repo}`;
const root = mkdtempSync(join(tmpdir(), 'kvarm-warm-bench-'));
const work = join(root, 'work');
const workRoot = join(root, 'runner');
const slotWork = (n) => join(workRoot, OWNER, repo, `slot-${n}`, 'work');
const askpass = join(root, 'askpass.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = new Set(['node_modules', '.cache', '.git']);
const results = [];

writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function check(label, ok, detail = '') {
  results.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`);
}
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
function run(cmd, args, cwd = work) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: PAT }, encoding: 'buffer', maxBuffer: 256 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout;
}
const git = (args) => run('git', ['-c', 'credential.helper=', ...args]).toString('utf8').trim();

async function waitQueued(name, sha, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await api(`${R}/changes/1/checks`);
    if (got.json?.checks?.some((c) => c.name === name && c.headSha === sha && c.status === 'queued')) return;
    await sleep(500);
  }
  throw new Error(`${name} at ${sha} was never queued`);
}

async function snapshotReady(sha, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const got = await api(`${R}/snapshots/${sha}`, { method: 'POST' });
    if (got.json?.state === 'ready') return;
    await sleep(1_000);
  }
  throw new Error(`snapshot for ${sha} never became ready`);
}

function runner(extra = []) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(kvarmBin(), ['runner', '--repo', `${OWNER}/${repo}`, '--once', '--workdir', workRoot, ...extra], {
      env: { ...process.env, KVARM_BASE_URL: BASE, KVARM_PAT: PAT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`runner exited ${code}: ${stderr}`));
      const span = /reported (\w+) for \S+ \(\S+\) in (\d+) ms/.exec(stdout);
      resolve({
        stdout,
        stderr,
        conclusion: span?.[1],
        claimToReportMs: span ? Number(span[2]) : NaN,
        processMs: Date.now() - started,
        workdir: /workdir: (\w+)/.exec(stdout)?.[1],
      });
    });
  });
}

/** Path -> type/exec-bit/content hash, skipping cache directories and a clone-fallback .git. */
function treeState(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      if (SKIP.has(name)) continue;
      const path = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out[path] = `link:${readlinkSync(join(dir, path))}`;
      else if (st.isDirectory()) {
        out[path] = 'dir';
        walk(path);
      } else out[path] = `file:${st.mode & 0o111 ? 'x' : '-'}:${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

function expectedTree(sha) {
  const dest = mkdtempSync(join(root, 'expected-'));
  const tar = run('git', ['archive', '--format=tar', sha]);
  const r = spawnSync('tar', ['-x', '-C', dest], { input: tar });
  if (r.status !== 0) throw new Error(`tar -x: ${r.stderr}`);
  const state = treeState(dest);
  rmSync(dest, { recursive: true, force: true });
  return state;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

let created = false;
const samples = { cold: [], warm: [] };
try {
  const made = await api('/api/v1/repos', { method: 'POST', body: { name: repo, visibility: 'public' } });
  if (made.status !== 201) throw new Error(`repo create ${made.status}: ${made.text}`);
  created = true;
  mkdirSync(join(work, '.kvarm'), { recursive: true });
  mkdirSync(join(work, 'src'), { recursive: true });
  mkdirSync(join(work, 'notes'), { recursive: true });
  git(['init', '-q', '-b', 'main']);
  writeFileSync(
    join(work, 'package.json'),
    `${JSON.stringify({ name: 'warm-bench', private: true, type: 'module', scripts: { test: 'tsc --noEmit -p . && vitest run' }, devDependencies: { typescript: '5.9.3', vitest: '4.1.11' } }, null, 2)}\n`,
  );
  writeFileSync(join(work, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { strict: true, module: 'nodenext', target: 'es2022', noEmit: true, types: [] }, include: ['src'] }, null, 2)}\n`);
  writeFileSync(join(work, '.gitignore'), 'node_modules\n');
  writeFileSync(join(work, 'src', 'value.ts'), 'export const value = 0;\n');
  writeFileSync(join(work, 'src', 'value.test.ts'), "import { expect, test } from 'vitest';\nimport { value } from './value.js';\ntest('value', () => expect(typeof value).toBe('number'));\n");
  writeFileSync(join(work, 'notes', 'n-0.md'), 'note 0\n');
  writeFileSync(join(work, '.kvarm', 'ci.json'), `${JSON.stringify({ jobs: [{ name: 'build', run: `npm install --no-audit --no-fund --prefer-offline${values['isolated-npm-cache'] ? ' --cache .cache/npm' : ''} && npm test`, required: true, timeoutSeconds: 600 }] })}\n`);
  run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'fixture']);
  git(['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(work, 'src', 'value.ts'), 'export const value = 1;\n');
  git(['commit', '-q', '-am', 'head 1']);
  let head = git(['rev-parse', 'HEAD']);
  const url = `${BASE}/${OWNER}/${repo}.git`;
  git(['push', '-q', url, 'main', 'feature']);
  const change = await api(`${R}/changes`, { method: 'POST', body: { title: 'warm bench', base: 'main', head: 'feature', mergePolicy: 'review' } });
  if (change.status !== 201) throw new Error(`change create ${change.status}: ${change.text}`);

  for (let i = 1; i <= SAMPLES * 2; i++) {
    const cold = i % 2 === 1;
    if (i > 1) {
      writeFileSync(join(work, 'src', 'value.ts'), `export const value = ${i};\n`);
      rmSync(join(work, 'notes', `n-${i - 1}.md`), { force: true });
      writeFileSync(join(work, 'notes', `n-${i}.md`), `note ${i}\n`);
      git(['add', '-A']);
      git(['commit', '-q', '-m', `head ${i}`]);
      head = git(['rev-parse', 'HEAD']);
      git(['push', '-q', url, 'feature']);
    }
    await waitQueued('build', head);
    if (values['snapshot-ready']) await snapshotReady(head);
    const r = await runner(cold ? ['--fresh'] : []);
    const checks = await api(`${R}/changes/1/checks`);
    const run1 = checks.json?.checks?.find((c) => c.name === 'build' && c.headSha === head);
    const npmLine = /(added \d+ packages[^\n]*|up to date[^\n]*)/.exec(run1?.summary?.stdout ?? '')?.[1] ?? '';
    const same = JSON.stringify(treeState(slotWork(0))) === JSON.stringify(expectedTree(head));
    const cached = existsSync(join(slotWork(0), 'node_modules', 'vitest', 'package.json'));
    check(
      `sample ${i} ${cold ? 'cold (--fresh)' : 'warm'}`,
      r.conclusion === 'success' && run1?.status === 'success' && r.workdir === (cold ? 'fresh' : 'warm') && same && cached && (cold ? /added/.test(npmLine) : /up to date/.test(npmLine)),
      `source=${run1?.summary?.source} workdir=${r.workdir} claim->report=${r.claimToReportMs}ms process=${r.processMs}ms tracked==git-archive:${same} node_modules kept:${cached} npm:"${npmLine}"`,
    );
    (cold ? samples.cold : samples.warm).push(r.claimToReportMs);
  }

  writeFileSync(join(work, '.kvarm', 'ci.json'), `${JSON.stringify({ jobs: [{ name: 'a', run: 'sleep 4', required: true }, { name: 'b', run: 'sleep 4', required: true }] })}\n`);
  git(['commit', '-q', '-am', 'two jobs']);
  head = git(['rev-parse', 'HEAD']);
  git(['push', '-q', url, 'feature']);
  await waitQueued('a', head);
  await waitQueued('b', head);
  const both = Promise.all([runner(), runner()]);
  let bothLocked = false;
  const lock = (n) => join(workRoot, OWNER, repo, `slot-${n}.lock`);
  for (let t = 0; t < 80 && !bothLocked; t++) {
    bothLocked = existsSync(lock(0)) && existsSync(lock(1));
    if (!bothLocked) await sleep(100);
  }
  const pair = await both;
  check(
    'concurrent runners hold different slots',
    bothLocked && pair.every((p) => p.conclusion === 'success') && !existsSync(lock(0)) && !existsSync(lock(1)),
    `slot-0 and slot-1 locked together: ${bothLocked}; conclusions ${pair.map((p) => p.conclusion).join(',')}; locks released after exit`,
  );

  console.log(`\ncold (--fresh, npm install) claim->report ms: ${samples.cold.join(', ')}; median ${median(samples.cold)}`);
  console.log(`warm (synced workdir, node_modules reused) claim->report ms: ${samples.warm.join(', ')}; median ${median(samples.warm)}`);
} finally {
  if (created && !values.keep) {
    const deleted = await api(R, { method: 'DELETE' });
    check('scratch repo deleted', deleted.status === 200, String(deleted.status));
  }
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
if (results.some((x) => !x)) process.exitCode = 1;
