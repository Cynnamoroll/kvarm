#!/usr/bin/env node
/**
 * Generates and pushes the M3 benchmark fixture ("bench-fixture" in the
 * validation contract) to the live worker.
 *
 * The content is a pure function of the constants below, and commits use a
 * fixed identity and timestamp, so every run produces the same SHAs. The
 * script builds the history locally with `git fast-import`, records the
 * expected change counts from local git, creates the repo through
 * `POST /api/v1/repos` when it does not exist, and pushes only refs whose
 * remote SHA differs (one ref per push, honoring 429/Retry-After).
 *
 *   bench-base   25 dirs x 20 files x 2,000 lines, plus large/huge.txt
 *                (120,000 lines) and large/interleaved.txt (60,000 lines)
 *   bench-head   child of bench-base: every other line of the 500 files
 *                rewritten (1,000 insertions + 1,000 deletions each, ~1M changed
 *                lines in total), a single-line edit in huge.txt, and every
 *                5th line of interleaved.txt rewritten plus 5,000 lines moved
 *   wide-base    orphan: w/aNN/bNNN/fN.txt, 25,000 one-line files in 5,000
 *                leaf directories
 *   wide-head    child of wide-base: every one of the 25,000 files changed
 *   main         = bench-base (a sane default branch; bench-head stays non-default)
 *
 * Usage (from the repo root, validation env loaded):
 *   set -a; . ./.env.local; set +a
 *   node scripts/fixture-1m.mjs [--repo=fixture-1m] [--dry-run] [--force] [--out=docs/benchmarks/fixture-1m.json]
 *
 * --dry-run builds locally and writes the expected-counts record without
 * touching the live worker. --force overwrites remote refs that point at
 * other commits (never needed for an unchanged generator). The PAT
 * (KVARM_PAT) is passed to git through a secret-free GIT_ASKPASS helper and
 * never printed; git runs with `-c credential.helper=`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const REPO = arg('repo', 'fixture-1m');
const root = fileURLToPath(new URL('..', import.meta.url));
const OUT = resolve(root, arg('out', 'docs/benchmarks/fixture-1m.json'));
if (!DRY && !process.env.KVARM_PAT) throw new Error('env KVARM_PAT is not set (load .env.local)');

export const SHAPE = {
  version: 1,
  bench: { dirs: 25, filesPerDir: 20, linesPerFile: 2_000 },
  huge: { path: 'large/huge.txt', lines: 120_000, editLine: 60_000 },
  interleaved: { path: 'large/interleaved.txt', lines: 60_000, rewriteEvery: 5, moveFrom: 30_000, moveCount: 5_000 },
  wide: { top: 50, perTop: 100, filesPerLeaf: 5 },
};
const IDENT = 'fixture-1m <fixture-1m@forge.invalid> 1790000000 +0000';
const pad = (n, w) => String(n).padStart(w, '0');

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

function benchFile(d, f, side) {
  const p = `d${pad(d, 2)}/f${pad(f, 2)}`;
  const out = [];
  for (let i = 0; i < SHAPE.bench.linesPerFile; i++) {
    out[i] = side === 'head' && i % 2 === 1 ? `${p} line ${pad(i, 5)} head rewritten\n` : `${p} line ${pad(i, 5)} base\n`;
  }
  return out.join('');
}

function hugeFile(side) {
  const { lines, editLine } = SHAPE.huge;
  const out = [];
  for (let i = 0; i < lines; i++) out[i] = `huge ${pad(i + 1, 6)} lorem ipsum\n`;
  if (side === 'head') out[editLine - 1] = `huge ${pad(editLine, 6)} edited once\n`;
  return out.join('');
}

function interleavedFile(side) {
  const { lines, rewriteEvery, moveFrom, moveCount } = SHAPE.interleaved;
  const out = [];
  for (let i = 0; i < lines; i++) {
    out[i] = side === 'head' && i % rewriteEvery === 0 ? `mix ${pad(i, 5)} rewritten\n` : `mix ${pad(i, 5)} original\n`;
  }
  if (side === 'head') out.push(...out.splice(moveFrom, moveCount));
  return out.join('');
}

function* wideFiles(side) {
  const { top, perTop, filesPerLeaf } = SHAPE.wide;
  for (let a = 0; a < top; a++) {
    for (let b = 0; b < perTop; b++) {
      for (let k = 0; k < filesPerLeaf; k++) {
        yield [`w/a${pad(a, 2)}/b${pad(b, 3)}/f${k}.txt`, `wide ${pad(a, 2)} ${pad(b, 3)} ${k} ${side}\n`];
      }
    }
  }
}

function* benchFiles(side) {
  for (let d = 0; d < SHAPE.bench.dirs; d++) {
    for (let f = 0; f < SHAPE.bench.filesPerDir; f++) yield [`d${pad(d, 2)}/f${pad(f, 2)}.txt`, benchFile(d, f, side)];
  }
  yield [SHAPE.huge.path, hugeFile(side)];
  yield [SHAPE.interleaved.path, interleavedFile(side)];
}

// ---------------------------------------------------------------------------
// Local build
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'fixture-1m-'));
const local = join(work, 'repo');
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FIXTURE_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, opts = {}) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FIXTURE_GIT_TOKEN: opts.auth ? process.env.KVARM_PAT : '' };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd: opts.cwd ?? local,
    env,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() };
}

function must(r, what) {
  if (r.code !== 0) throw new Error(`${what} failed (${r.code}): ${r.err.slice(0, 500)}`);
  return r.out;
}

async function fastImport() {
  must(git(['init', '-q', '--bare', local], { cwd: work }), 'git init');
  const child = spawn('git', ['fast-import', '--quiet', '--date-format=raw'], { cwd: local, stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => child.on('close', (code) => (code === 0 ? ok() : fail(new Error(`fast-import exited ${code}`)))));
  const write = (s) => (child.stdin.write(s) ? Promise.resolve() : new Promise((r) => child.stdin.once('drain', r)));
  const data = (s) => `data ${Buffer.byteLength(s)}\n${s}\n`;
  const commit = async (ref, mark, from, message, files) => {
    await write(`commit ${ref}\nmark :${mark}\nauthor ${IDENT}\ncommitter ${IDENT}\n${data(message)}`);
    if (from) await write(`from :${from}\n`);
    for (const [path, content] of files) await write(`M 100644 inline ${path}\n${data(content)}`);
    await write('\n');
  };
  await commit('refs/heads/bench-base', 1, null, 'bench-base: 500 files x 2,000 lines + large files', benchFiles('base'));
  await commit('refs/heads/bench-head', 2, 1, 'bench-head: ~1M changed lines', benchFiles('head'));
  await write('reset refs/heads/wide-base\n');
  await commit('refs/heads/wide-base', 3, null, 'wide-base: 25,000 files in 5,000 directories', wideFiles('base'));
  await commit('refs/heads/wide-head', 4, 3, 'wide-head: every file changed', wideFiles('head'));
  await write('reset refs/heads/main\nfrom :1\n\n');
  child.stdin.end();
  await done;
}

function shortstat(a, b) {
  const out = must(git(['diff', '--no-renames', '--shortstat', a, b]), 'diff --shortstat');
  const n = (re) => Number(re.exec(out)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
}

function numstat(a, b, path) {
  const [add, del] = must(git(['diff', '--no-renames', '--numstat', a, b, '--', path]), 'diff --numstat').split('\t');
  return { additions: Number(add), deletions: Number(del) };
}

function blobInfo(ref, path) {
  const bytes = Number(must(git(['cat-file', '-s', `${ref}:${path}`]), 'cat-file -s'));
  const lines = must(git(['cat-file', '-p', `${ref}:${path}`]), 'cat-file -p').split('\n').length;
  return { bytes, lines };
}

const REFS = ['bench-base', 'bench-head', 'wide-base', 'wide-head', 'main'];

function record() {
  const refs = {};
  for (const r of REFS) {
    refs[r] = { sha: must(git(['rev-parse', `refs/heads/${r}`]), 'rev-parse'), tree: must(git(['rev-parse', `refs/heads/${r}^{tree}`]), 'rev-parse tree') };
  }
  const bench = shortstat('bench-base', 'bench-head');
  const widePaths = must(git(['diff', '--no-renames', '--name-only', 'wide-base', 'wide-head']), 'diff --name-only').split('\n').filter(Boolean);
  const leafDirs = new Set(widePaths.map((p) => p.slice(0, p.lastIndexOf('/'))));
  const allDirs = new Set();
  for (const d of leafDirs) for (let i = d.indexOf('/'); i !== -1; i = d.indexOf('/', i + 1)) allDirs.add(d.slice(0, i));
  for (const d of leafDirs) allDirs.add(d);
  return {
    generator: 'scripts/fixture-1m.mjs',
    version: SHAPE.version,
    repo: `${OWNER}/${REPO}`,
    shape: SHAPE,
    refs,
    bench: {
      pair: 'bench-base...bench-head',
      ...bench,
      changedLines: bench.insertions + bench.deletions,
      largest: { path: SHAPE.huge.path, ...blobInfo('bench-head', SHAPE.huge.path), ...numstat('bench-base', 'bench-head', SHAPE.huge.path) },
      interleaved: {
        path: SHAPE.interleaved.path,
        ...blobInfo('bench-head', SHAPE.interleaved.path),
        ...numstat('bench-base', 'bench-head', SHAPE.interleaved.path),
      },
    },
    wide: {
      pair: 'wide-base...wide-head',
      changedPaths: widePaths.length,
      leafDirectories: leafDirs.size,
      directories: allDirs.size,
      treeReadsForFullDiff: 2 + 2 * allDirs.size,
    },
  };
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.KVARM_PAT}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  const text = await res.text();
  return { status: res.status, text, cost: res.headers.get('x-kvarm-cost') };
}

async function ensureRepo() {
  const got = await api(`/api/v1/repos/${OWNER}/${REPO}`);
  if (got.status === 200) {
    console.log(`# repo ${OWNER}/${REPO} exists`);
    return;
  }
  const made = await api('/api/v1/repos', { method: 'POST', body: JSON.stringify({ name: REPO, visibility: 'public' }) });
  if (made.status !== 201) throw new Error(`create ${OWNER}/${REPO}: ${made.status} ${made.text.slice(0, 300)}`);
  console.log(`# created ${OWNER}/${REPO} (${made.cost})`);
}

const remoteUrl = () => `${BASE}/${OWNER}/${REPO}.git`;

async function lsRemote() {
  for (let attempt = 0; ; attempt++) {
    const r = git(['ls-remote', remoteUrl()], { auth: true });
    if (r.code === 0) {
      const map = new Map();
      for (const line of r.out.split('\n').filter(Boolean)) {
        const [sha, name] = line.split('\t');
        map.set(name, sha);
      }
      return map;
    }
    if (attempt >= 8 || !/429|503|warming/i.test(r.err)) throw new Error(`ls-remote failed: ${r.err.slice(0, 300)}`);
    await sleep(5_000 * (attempt + 1));
  }
}

async function pushRef(ref) {
  const spec = `${FORCE ? '+' : ''}refs/heads/${ref}:refs/heads/${ref}`;
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    const r = git(['-c', 'http.postBuffer=524288000', 'push', '--porcelain', remoteUrl(), spec], { auth: true });
    const ms = Date.now() - started;
    if (r.code === 0) {
      console.log(`# pushed ${ref} in ${(ms / 1000).toFixed(1)} s`);
      return;
    }
    // Rate limited or warming: wait (the git gate allows 120 writes/min per PAT).
    if (attempt >= 8 || !/429|503|warming|rate/i.test(r.err)) throw new Error(`push ${ref} failed: ${r.err.slice(0, 500)}`);
    console.log(`# push ${ref} retry ${attempt + 1}: ${r.err.split('\n')[0]?.slice(0, 120)}`);
    await sleep(15_000 * (attempt + 1));
  }
}

try {
  const t0 = Date.now();
  await fastImport();
  console.log(`# built locally in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const rec = record();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(rec, null, 2)}\n`);
  console.log(`# expected counts -> ${OUT}`);
  console.log(JSON.stringify({ refs: Object.fromEntries(Object.entries(rec.refs).map(([k, v]) => [k, v.sha])), bench: rec.bench, wide: rec.wide }, null, 2));
  if (!DRY) {
    await ensureRepo();
    let remote = await lsRemote();
    for (const ref of REFS) {
      const want = rec.refs[ref].sha;
      const have = remote.get(`refs/heads/${ref}`);
      if (have === want) {
        console.log(`# ${ref} already at ${want.slice(0, 12)}`);
        continue;
      }
      if (have && !FORCE) throw new Error(`remote ${ref} is at ${have}, expected ${want}; rerun with --force to overwrite`);
      await pushRef(ref);
    }
    remote = await lsRemote();
    const bad = REFS.filter((r) => remote.get(`refs/heads/${r}`) !== rec.refs[r].sha);
    if (bad.length > 0) throw new Error(`remote refs differ after push: ${bad.join(', ')}`);
    console.log(`# live ${OWNER}/${REPO}: all ${REFS.length} refs match (${((Date.now() - t0) / 1000).toFixed(1)} s total)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
