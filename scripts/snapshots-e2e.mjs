#!/usr/bin/env node
/**
 * Live validation driver for snapshots (VAL-SNAP-001..006, VAL-COST-008,
 * 009, 010, 024).
 *
 * Sections (all by default, or pick with --only=core,cost,lazy,private,flip,fixture):
 *
 * - core     public repo with an exec file, a symlink, a >100-byte path, a
 *            unicode name and an empty file. Push main, poll
 *            GET snapshots/main every 2 s until 200 ready (≤ 120 s), compare
 *            sha with ls-remote, read it by SHA, the three 404s, cold/warm
 *            metadata cost (warm art=0, d1≤2), the download cost (r2b=1,
 *            r2a=0, art=0, d1≤2), byte count == size, tar -xf and
 *            diff -r -x .git against a git checkout of the sha.
 * - cost     a ≥1,000-file tree (F from git ls-tree) pushed to main:
 *            buildCost.steps ≤ ceil(F/500)+2. Then a fresh workspace ref:
 *            metadata stays `absent` after its push event (no build), an
 *            explicit demand shows 202 building before 200 ready.
 * - lazy     a distinct 20-file workspace tree: push alone builds nothing,
 *            the demand builds it once (steps ≤ 3); a second commit with the
 *            same tree reuses the tarball (steps=1, objects=0) with its own
 *            metadata; a repeated demand starts nothing.
 * - private  private repo: anonymous metadata/download 404, PAT 200 for both.
 * - flip     public repo ready, warm anonymous and outsider metadata and
 *            download, flip to private with a direct remote D1 UPDATE (another
 *            colo, no purge), then the very next anonymous and outsider
 *            requests are 404 while the owner still gets 200; flip back, warm
 *            again and repeat with the owner's PATCH visibility=private.
 *            Needs wrangler on PATH (`. "$HOME/.config/vite-plus/env"`).
 * - fixture  cynthia/fixture-1m (read-only): explicit demand for bench-head,
 *            poll to ready within 15 minutes, download, diff -r against a
 *            clone checked out at the same sha.
 *
 * Env (load apps/platform/.dev.vars.validation): FORGE_PAT (cynthia, owner),
 * FORGE_PAT_OUTSIDER (unrelated principal). Tokens are never printed; git
 * runs with `-c credential.helper=` and a secret-free GIT_ASKPASS helper and
 * uses the configured git identity.
 *
 * Usage: node scripts/snapshots-e2e.mjs [--only=...] [--keep]
 * Exit 0 when every check held. Repos created by the run are deleted unless --keep.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: { only: { type: 'string' }, keep: { type: 'boolean', default: false } },
});
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
if (!process.env.FORGE_PAT) throw new Error('env FORGE_PAT is not set');
const SECTIONS = new Set((args.only ?? 'core,cost,lazy,private,flip,fixture').split(','));
const READY_BOUND_MS = 120_000;
const FIXTURE_BOUND_MS = 15 * 60_000;
const FIXTURE = { repo: 'fixture-1m', ref: 'bench-head', sha: '08333c79998f410b9c40a84cc430ce9762c29ae8' };
const ts = Date.now();

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const statuses = [];
const TOKENS = { owner: 'FORGE_PAT', outsider: 'FORGE_PAT_OUTSIDER' };
async function http(path, { method = 'GET', as = 'owner', json, save } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${process.env[TOKENS[as]]}`;
  if (json !== undefined) headers['content-type'] = 'application/json';
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}${path}`, init);
  const bytes = new Uint8Array(await res.arrayBuffer());
  statuses.push(res.status);
  if (save) writeFileSync(save, bytes);
  let body = null;
  try {
    body = save ? null : JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    body = null;
  }
  return { status: res.status, body, bytes: bytes.length, cost: res.headers.get('x-forge-cost'), headers: res.headers };
}
const snapPath = (repo, ref) => `/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`;
function costOf(header) {
  return Object.fromEntries((header ?? '').split(';').map((kv) => kv.split('=')).map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v]));
}
const brief = (b) => JSON.stringify(b && { state: b.state, sha: b.sha?.slice(0, 12), size: b.size, files: b.files, builtAt: b.builtAt, reused: b.reused });

const work = mkdtempSync(join(tmpdir(), 'snapshots-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo forge ;; *) printenv E2E_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(dir, gitArgs) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', E2E_GIT_TOKEN: process.env.FORGE_PAT };
  const r = spawnSync('git', ['-c', 'credential.helper=', '-c', 'core.quotepath=off', ...gitArgs], { cwd: dir, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const PLATFORM_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'platform');
function d1Exec(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'forge', '--remote', '--json', '--command', sql], { cwd: PLATFORM_DIR, encoding: 'utf8' });
  if (r.status !== 0) console.log(`#   wrangler d1 execute failed: ${(r.stderr ?? '').slice(-300)}`);
  return r.status;
}
function sh(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

async function push(dir, refspec, force = false) {
  for (let i = 0; i < 10; i++) {
    const r = git(dir, ['push', '-q', ...(force ? ['-f'] : []), 'origin', refspec]);
    if (r.code === 0 || !/503|warming|429/i.test(r.err)) return { ...r, doneAt: Date.now() };
    await sleep(3000);
  }
  return { ...git(dir, ['push', '-q', ...(force ? ['-f'] : []), 'origin', refspec]), doneAt: Date.now() };
}

const created = [];
async function createRepo(name, visibility) {
  const r = await http('/api/v1/repos', { method: 'POST', json: { name, visibility } });
  if (check(`create ${visibility} ${OWNER}/${name}`, r.status, 201)) created.push(name);
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

/** Polls metadata every `every` ms until 200 ready (for `sha`) or the bound; returns the transcript. */
async function pollReady(repo, ref, sha, { since = Date.now(), bound = READY_BOUND_MS, every = 2000, as = 'owner' } = {}) {
  const seen = [];
  for (;;) {
    const r = await http(snapPath(repo, ref), { as });
    const at = Date.now() - since;
    const line = `${at}ms ${r.status} ${r.body?.state ?? ''} ${r.body?.sha?.slice(0, 12) ?? ''}`;
    if (seen.at(-1)?.key !== `${r.status}:${r.body?.state}:${r.body?.sha}`) console.log(`#   poll ${ref}: ${line}`);
    seen.push({ key: `${r.status}:${r.body?.state}:${r.body?.sha}`, status: r.status, state: r.body?.state, sha: r.body?.sha });
    if (r.status === 200 && r.body?.state === 'ready' && (!sha || r.body.sha === sha)) return { ok: true, at, body: r.body, seen, cost: r.cost };
    if (r.status >= 500 || r.status === 409 || at > bound) return { ok: false, at, body: r.body, seen, cost: r.cost };
    await sleep(every);
  }
}

/** Downloads, checks bytes == size, extracts, and diffs against a clone at `sha`. */
async function downloadAndDiff(label, repo, ref, sha, size, cloneUrl) {
  const file = label.replace(/[^\w.-]+/g, '_');
  const tarFile = join(work, `${file}.tar`);
  const dl = await http(`${snapPath(repo, ref)}/download`, { save: tarFile });
  check(`${label} download 200 (${dl.cost})`, dl.status, 200);
  const c = costOf(dl.cost);
  check(`${label} download cost r2b=1 r2a=0 art=0 d1<=2`, `r2b=${c.r2b};r2a=${c.r2a};art=${c.art};d1=${c.d1}`, () => c.r2b === 1 && c.r2a === 0 && c.art === 0 && c.d1 <= 2);
  check(`${label} downloaded bytes ${statSync(tarFile).size} == metadata size ${size}`, statSync(tarFile).size, size);
  const out = join(work, `${file}-x`);
  mkdirSync(out);
  check(`${label} tar -xf exit status`, sh('tar', ['-xf', tarFile, '-C', out]).code, 0);
  // macOS bsdtar rewrites unicode names to NFD, which diff -r reports as
  // "Only in" pairs even for tarballs bsdtar wrote itself; Python's tarfile
  // keeps the archived bytes, so the byte-level comparison uses it.
  const exact = join(work, `${file}-py`);
  const py = sh('python3', ['-c', 'import sys,tarfile; kw={"filter":"tar"} if hasattr(tarfile,"tar_filter") else {}; tarfile.open(sys.argv[1]).extractall(sys.argv[2], **kw)', tarFile, exact]);
  check(`${label} python tarfile extract exit status`, py.code, 0);
  const clone = join(work, `${file}-clone`);
  const cl = git(work, ['clone', '-q', cloneUrl, clone]);
  check(`${label} git clone`, cl.code, 0);
  check(`${label} git checkout ${sha.slice(0, 12)}`, git(clone, ['checkout', '-q', sha]).code, 0);
  const diff = sh('diff', ['-r', '-x', '.git', exact, clone]);
  check(`${label} diff -r -x .git <snapshot> <checkout> is empty`, `${diff.code} ${diff.out}${diff.err}`.trim(), '0');
  const ascii = sh('diff', ['-r', '-x', '.git', '-x', '*[^ -~]*', out, clone]);
  check(`${label} diff -r of the tar -xf tree (ASCII names) is empty`, `${ascii.code} ${ascii.out}${ascii.err}`.trim(), '0');
}

function writeTreeFiles(dir) {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# snapshots ${ts}\n`);
  writeFileSync(join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n');
  chmodSync(join(dir, 'bin', 'tool.sh'), 0o755);
  symlinkSync('README.md', join(dir, 'readme-link'));
  const long = join(dir, 'd'.repeat(60), 'e'.repeat(60));
  mkdirSync(long, { recursive: true });
  writeFileSync(join(long, `${'n'.repeat(110)}.txt`), 'long path\n');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'résumé-日本.md'), 'unicode\n');
  writeFileSync(join(dir, 'docs', 'empty.txt'), '');
  writeFileSync(join(dir, 'bin.dat'), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256)));
}

function writeMany(dir, count, salt) {
  for (let i = 0; i < count; i++) {
    const sub = join(dir, `d${i % 20}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, `f${String(i).padStart(5, '0')}.txt`), `file ${i} ${salt}\n${'x'.repeat(200)}\n`);
  }
}

async function waitEvent(repo, after, bound = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < bound) {
    const r = await http(`/api/v1/repos/${OWNER}/${repo}/events?limit=100`);
    const hit = r.body?.events?.find((e) => e.after === after && e.completedAt);
    if (hit) return hit;
    await sleep(1000);
  }
  return null;
}

try {
  // ---------------------------------------------------------------- core
  if (SECTIONS.has('core')) {
    console.log('# core: VAL-SNAP-001/003/004, VAL-COST-009/010');
    const name = `m4-snapshot-builder-core-${ts}`;
    const dir = await createRepo(name, 'public');
    writeTreeFiles(dir);
    const sha = commitAll(dir, 'snapshot core');
    const p = await push(dir, 'main');
    check(`push main ${sha.slice(0, 12)}`, p.code, 0);
    const ready = await pollReady(name, 'main', sha, { since: p.doneAt });
    check(`VAL-SNAP-001 main ready within 120 s (${ready.at} ms) ${brief(ready.body)}`, ready.ok, true);
    console.log(`#   ready body ${JSON.stringify(ready.body)}`);
    const ls = git(dir, ['ls-remote', 'origin', 'refs/heads/main']).out.split(/\s+/)[0];
    check('metadata sha equals git ls-remote refs/heads/main', ready.body?.sha, ls);
    check('size > 0 and files > 0 and builtAt set', ready.body, (b) => b?.size > 0 && b?.files > 0 && typeof b?.builtAt === 'string');
    const bySha = await http(snapPath(name, sha));
    check(`GET snapshots/<sha> 200 ready, same size (${bySha.cost})`, `${bySha.status} ${bySha.body?.state} ${bySha.body?.size}`, `200 ready ${ready.body?.size}`);

    check('VAL-SNAP-003 GET snapshots/no-such-ref', (await http(snapPath(name, 'no-such-ref'))).status, 404);
    check('VAL-SNAP-003 GET snapshots/no-such-ref/download', (await http(`${snapPath(name, 'no-such-ref')}/download`)).status, 404);
    check('VAL-SNAP-003 GET repos/<owner>/no-such-repo/snapshots/main', (await http(`/api/v1/repos/${OWNER}/no-such-repo-${ts}/snapshots/main`)).status, 404);

    const cold = await http(snapPath(name, 'main'));
    const warm = await http(snapPath(name, 'main'));
    console.log(`#   metadata cold x-forge-cost: ${cold.cost}`);
    console.log(`#   metadata warm x-forge-cost: ${warm.cost}`);
    const w = costOf(warm.cost);
    check('VAL-COST-009 warm metadata 200 with art=0 and d1<=2', `${warm.status} art=${w.art} d1=${w.d1}`, () => warm.status === 200 && w.art === 0 && w.d1 <= 2);
    await downloadAndDiff('VAL-SNAP-004/VAL-COST-010', name, 'main', sha, ready.body?.size, `${BASE}/${OWNER}/${name}.git`);
  }

  // ---------------------------------------------------------------- cost
  if (SECTIONS.has('cost')) {
    console.log('# cost: VAL-COST-008 and VAL-SNAP-002');
    const name = `m4-snapshot-builder-cost-${ts}`;
    const dir = await createRepo(name, 'public');
    writeMany(dir, 1200, 'base');
    const sha = commitAll(dir, 'many files');
    const F = Number(git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).out.split('\n').filter(Boolean).length);
    const bound = Math.ceil(F / 500) + 2;
    console.log(`#   F=${F} files, step bound ceil(F/500)+2 = ${bound}`);
    const p = await push(dir, 'main');
    check(`push main ${sha.slice(0, 12)} with F=${F}`, p.code, 0);
    const ready = await pollReady(name, 'main', sha, { since: p.doneAt });
    check(`main ready (${ready.at} ms)`, ready.ok, true);
    console.log(`#   buildCost ${JSON.stringify(ready.body?.buildCost)}`);
    check(`VAL-COST-008 buildCost.steps ${ready.body?.buildCost?.steps} <= ${bound}`, ready.body?.buildCost?.steps, (s) => typeof s === 'number' && s <= bound);
    check('buildCost exposes R2 and Artifacts counters', ready.body?.buildCost, (b) => b && typeof b.r2a === 'number' && typeof b.art === 'number' && b.objects === 1);

    // VAL-SNAP-002: a fresh workspace ref, no build until demanded.
    const ref = `agents/snap-${ts}`;
    git(dir, ['checkout', '-q', '-b', ref]);
    writeMany(dir, 1200, 'workspace');
    const wsha = commitAll(dir, 'workspace edit');
    const wp = await push(dir, ref);
    check(`push ${ref} ${wsha.slice(0, 12)}`, wp.code, 0);
    const ev = await waitEvent(name, wsha);
    const effect = ev?.effects?.find((e) => e.effect === 'snapshot');
    check('workspace push event processed with a lazy snapshot effect', `${effect?.state}:${effect?.detail}`, (s) => s.startsWith('skipped:lazy'));
    const before = await http(snapPath(name, ref));
    check(`no build started before the demand: GET ${ref} -> 202 absent (${before.cost})`, `${before.status} ${before.body?.state}`, '202 absent');
    const demand = await http(snapPath(name, ref), { method: 'POST' });
    check(`VAL-SNAP-002 POST demand -> 202 building (${demand.cost})`, `${demand.status} ${demand.body?.state} started=${demand.body?.started}`, '202 building started=true');
    const poll = await pollReady(name, ref, wsha, { every: 500 });
    const building = poll.seen.filter((s) => s.status === 202 && s.state === 'building').length;
    check(`VAL-SNAP-002 ${building} poll(s) saw 202 building before 200 ready (${poll.at} ms)`, building > 0 && poll.ok, true);
    check('no 404 during the build window', poll.seen.some((s) => s.status === 404), false);
    check(`workspace buildCost.steps ${poll.body?.buildCost?.steps} <= ${bound}`, poll.body?.buildCost?.steps, (s) => s <= bound);
    const wsBySha = await http(snapPath(name, wsha));
    check('workspace snapshot addressable by commit SHA', `${wsBySha.status} ${wsBySha.body?.state}`, '200 ready');
  }

  // ---------------------------------------------------------------- lazy
  if (SECTIONS.has('lazy')) {
    console.log('# lazy: VAL-COST-024');
    const name = `m4-snapshot-builder-lazy-${ts}`;
    const dir = await createRepo(name, 'public');
    writeFileSync(join(dir, 'README.md'), 'main\n');
    const msha = commitAll(dir, 'main');
    const mp = await push(dir, 'main');
    const mready = await pollReady(name, 'main', msha, { since: mp.doneAt });
    check(`default-branch push built eagerly (${mready.at} ms) buildCost=${JSON.stringify(mready.body?.buildCost)}`, mready.ok && mready.body?.trigger === 'push', true);
    check('default-branch steps <= ceil(1/500)+2', mready.body?.buildCost?.steps, (s) => s <= 3);

    const ref1 = `agents/lazy-a-${ts}`;
    git(dir, ['checkout', '-q', '-b', ref1]);
    sh('rm', ['-f', join(dir, 'README.md')]);
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `w${String(i).padStart(2, '0')}.txt`), `workspace ${i}\n`);
    const w1 = commitAll(dir, '20-file workspace tree');
    const files = git(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).out.split('\n').length;
    check('workspace tree has 20 files', files, 20);
    await push(dir, ref1);
    await waitEvent(name, w1);
    const absent = await http(snapPath(name, ref1));
    check('workspace push alone created no snapshot (absent)', `${absent.status} ${absent.body?.state}`, '202 absent');
    const d1 = await http(snapPath(name, ref1), { method: 'POST' });
    check(`first demand starts the build (${d1.cost})`, d1.body?.started, true);
    const r1 = await pollReady(name, ref1, w1, { every: 1000 });
    console.log(`#   ${ref1} metadata ${JSON.stringify(r1.body)}`);
    check('demanded 20-file tree built once: steps <= 3, objects=1', r1.body?.buildCost, (b) => b?.steps <= 3 && b.objects === 1 && b.reused === false);

    const ref2 = `agents/lazy-b-${ts}`;
    git(dir, ['checkout', '-q', '-b', ref2]);
    const w2 = commitAll(dir, 'same tree, new commit');
    check('second commit has the same tree', git(dir, ['rev-parse', `${w2}^{tree}`]).out, git(dir, ['rev-parse', `${w1}^{tree}`]).out);
    await push(dir, ref2);
    const d2 = await http(snapPath(name, ref2), { method: 'POST' });
    check(`demand for the same tree (${d2.cost})`, d2.status === 200 || d2.status === 202, true);
    const r2 = await pollReady(name, ref2, w2, { every: 1000 });
    console.log(`#   ${ref2} metadata ${JSON.stringify(r2.body)}`);
    check('same tree reuses the tarball: reused, steps=1, objects=0, r2a=0', r2.body, (b) => b?.reused === true && b.buildCost?.steps === 1 && b.buildCost?.objects === 0 && b.buildCost?.r2a === 0);
    check('separate commit metadata with the same tree and size', `${r2.body?.sha !== r1.body?.sha} ${r2.body?.tree === r1.body?.tree} ${r2.body?.size === r1.body?.size}`, 'true true true');
    const again = await http(snapPath(name, ref1), { method: 'POST' });
    check('repeated demand starts nothing and keeps metadata', `${again.status} started=${again.body?.started} builtAt=${again.body?.builtAt === r1.body?.builtAt}`, '200 started=false builtAt=true');
  }

  // ---------------------------------------------------------------- private
  if (SECTIONS.has('private')) {
    console.log('# private: VAL-SNAP-006 (private repo)');
    const name = `m4-snapshot-builder-private-${ts}`;
    const dir = await createRepo(name, 'private');
    writeTreeFiles(dir);
    const sha = commitAll(dir, 'private');
    const p = await push(dir, 'main');
    check('push private main', p.code, 0);
    const ev = await waitEvent(name, sha);
    check('private push processed by the event pipeline (snapshot effect created)', ev?.effects?.find((e) => e.effect === 'snapshot')?.detail ?? '', (s) => s.startsWith('created'));
    const ready = await pollReady(name, 'main', sha, { since: p.doneAt });
    check(`PAT metadata 200 ready (${ready.at} ms)`, ready.ok, true);
    check('anonymous GET snapshots/main', (await http(snapPath(name, 'main'), { as: null })).status, 404);
    check('anonymous GET snapshots/main/download', (await http(`${snapPath(name, 'main')}/download`, { as: null })).status, 404);
    const dl = await http(`${snapPath(name, 'main')}/download`, { save: join(work, 'private.tar') });
    check(`PAT download 200, ${dl.bytes} bytes == size`, `${dl.status} ${dl.bytes === ready.body?.size}`, '200 true');
  }

  // ---------------------------------------------------------------- flip
  if (SECTIONS.has('flip')) {
    console.log('# flip: VAL-SNAP-006 (stale cached-public regression)');
    if (!process.env.FORGE_PAT_OUTSIDER) throw new Error('env FORGE_PAT_OUTSIDER is not set');
    const name = `m4-snapshot-builder-flip-${ts}`;
    const dir = await createRepo(name, 'public');
    writeTreeFiles(dir);
    const sha = commitAll(dir, 'flip');
    const p = await push(dir, 'main');
    const ready = await pollReady(name, 'main', sha, { since: p.doneAt });
    check(`public main ready (${ready.at} ms)`, ready.ok, true);
    const warmAll = async (phase) => {
      for (const as of [null, 'outsider']) {
        for (let i = 0; i < 2; i++) {
          const m = await http(snapPath(name, 'main'), { as });
          const d = await http(`${snapPath(name, 'main')}/download`, { as });
          check(`${phase}: warm ${as ?? 'anonymous'} #${i + 1}: metadata ${m.status}, download ${d.status} ${d.bytes} bytes`, `${m.status} ${d.status}`, '200 200');
        }
      }
    };
    const deniedAll = async (phase) => {
      for (const as of [null, 'outsider']) {
        const m = await http(snapPath(name, 'main'), { as });
        const d = await http(`${snapPath(name, 'main')}/download`, { as });
        check(`${phase}: ${as ?? 'anonymous'} metadata denied without body (${m.cost})`, `${m.status} ${m.body?.size === undefined}`, '404 true');
        check(`${phase}: ${as ?? 'anonymous'} download denied without tar bytes (${d.cost})`, `${d.status} ${costOf(d.cost).r2b}`, '404 0');
      }
      const om = await http(snapPath(name, 'main'));
      const od = await http(`${snapPath(name, 'main')}/download`);
      check(`${phase}: owner metadata and download still 200`, `${om.status} ${od.status} ${od.bytes === ready.body?.size}`, '200 200 true');
    };
    // A direct D1 write simulates another colo flipping the repo: no Worker
    // code runs and nothing is purged, so any retained cached-public state
    // would still be served here.
    await warmAll('before direct D1 flip');
    const where = `owner_login = '${OWNER}' AND name = '${name}'`;
    check('direct remote D1 UPDATE visibility=private (no Worker code, no purge)', d1Exec(`UPDATE repos SET visibility = 'private' WHERE ${where}`), 0);
    await deniedAll('after direct D1 flip');
    check('direct remote D1 UPDATE back to public', d1Exec(`UPDATE repos SET visibility = 'public' WHERE ${where}`), 0);
    await warmAll('before owner PATCH flip');
    const flip = await http(`/api/v1/repos/${OWNER}/${name}`, { method: 'PATCH', json: { visibility: 'private' } });
    check('owner PATCH visibility=private', flip.status, 200);
    await deniedAll('after owner PATCH flip');
  }

  // ---------------------------------------------------------------- fixture
  if (SECTIONS.has('fixture')) {
    console.log('# fixture: VAL-SNAP-005 (cynthia/fixture-1m, read-only)');
    const t0 = Date.now();
    const demand = await http(snapPath(FIXTURE.repo, FIXTURE.ref), { method: 'POST' });
    console.log(`#   demand ${demand.status} ${JSON.stringify(demand.body)} (${demand.cost})`);
    check('explicit demand accepted', demand.status === 200 || demand.status === 202, true);
    const ready = await pollReady(FIXTURE.repo, FIXTURE.ref, FIXTURE.sha, { since: t0, bound: FIXTURE_BOUND_MS, every: 5000 });
    console.log(`#   ready metadata ${JSON.stringify(ready.body)}`);
    check(`bench-head ready within 15 min (${ready.at} ms after the demand)`, ready.ok, true);
    check('zero 5xx during polling', ready.seen.some((s) => s.status >= 500), false);
    await downloadAndDiff('VAL-SNAP-005', FIXTURE.repo, FIXTURE.ref, FIXTURE.sha, ready.body?.size, `${BASE}/${OWNER}/${FIXTURE.repo}.git`);
  }

  check('no 5xx anywhere in the run', statuses.filter((s) => s >= 500), (v) => v.length === 0);
} finally {
  if (!args.keep) {
    for (const name of created) {
      const r = await http(`/api/v1/repos/${OWNER}/${name}`, { method: 'DELETE' });
      console.log(`# cleanup DELETE ${OWNER}/${name} -> ${r.status}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
