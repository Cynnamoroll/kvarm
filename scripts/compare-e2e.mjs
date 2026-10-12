#!/usr/bin/env node
/**
 * Live validation driver for the compare and diff APIs (VAL-DIFF-001..021,
 * VAL-COST-004..006).
 *
 * As cynthia (KVARM_PAT, instance admin) it creates fresh repos named
 * m3-compare-api-<purpose>-<ts>, builds them with local git, records local
 * git ground truth (diff --numstat/--shortstat/--name-status -M, -U3 hunk
 * headers, ls-tree, ls-remote) and pushes through the git proxy. It then
 * checks every compare/file/commit-diff response against that ground truth
 * and the documented x-kvarm-cost budgets:
 *
 *   fixture   the contract's compare-fixture shape (root commit, main, feature)
 *   private   private repo: anonymous and unrelated callers get the unknown-repo 404
 *   flip      warm public compare + file diff, then a direct D1 flip and an owner
 *             PATCH flip to private: denied immediately, owner keeps reading
 *   bypass    fresh branch pair: admin ?nocache=1 -> bypass, then miss, then hit
 *   huge      a 5 MB text file change (tooLarge), a 60k-line interleaved edit,
 *             and a 200,000-line file removed plus one added (compare, root
 *             commit diff, file diffs and nocache: 200, exact counts)
 *   wide      many changed directories: stats omitted above 300 files, and
 *             read-budget truncation with a reason and totalsComplete false,
 *             never a 5xx
 *
 * Every repo carries content stamped with this run's timestamp, so its tree
 * pairs are new and the first normal compare is a genuine cache miss. Only
 * repos this run created are ever deleted; a failed create aborts the part.
 *
 * Principals by env var NAME (load apps/platform/.dev.vars.validation):
 * KVARM_PAT (owner, admin), KVARM_PAT_BOT (non-admin, unrelated). Tokens are
 * never printed; git runs with `-c credential.helper=` and a secret-free
 * GIT_ASKPASS helper.
 *
 * Usage: node scripts/compare-e2e.mjs [--keep] [--only=fixture,wide,...]
 * Exit 0 when every expectation held, 1 otherwise. Repos are deleted at the
 * end unless --keep.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const KEEP = process.argv.includes('--keep');
const ONLY = (process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length) ?? '').split(',').filter(Boolean);
const P = { owner: 'KVARM_PAT', bot: 'KVARM_PAT_BOT' };
for (const k of Object.values(P)) if (!process.env[k]) throw new Error(`env ${k} is not set`);
const OWNER = 'cynthia';
const ts = Date.now();
const PREFIX = 'm3-compare-api';
const name = (purpose) => `${PREFIX}-${purpose}-${ts}`;
const platformDir = fileURLToPath(new URL('../apps/platform/', import.meta.url));
const runs = (part) => ONLY.length === 0 || ONLY.includes(part);

const results = [];
function check(label, ok, detail = '') {
  results.push({ ok: !!ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  -> ${detail}` : ''}`);
  return !!ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function costOf(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = k === 'cache' ? v : Number(v);
  }
  return out;
}

async function http(who, path, { method = 'GET', json } = {}) {
  const headers = who ? { Authorization: `Bearer ${process.env[P[who]]}` } : {};
  if (json !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const init = { method, headers };
  if (json !== undefined) init.body = JSON.stringify(json);
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON
  }
  const header = res.headers.get('x-kvarm-cost');
  return { status: res.status, text, body, header, cost: costOf(header), cache: res.headers.get('x-kvarm-cache'), ms };
}

const api = (repo, rest) => `/api/v1/repos/${OWNER}/${repo}/${rest}`;
const show = (r) => `${r.status} ${r.ms}ms x-kvarm-cache=${r.cache} ${r.header}`;

const work = mkdtempSync(join(tmpdir(), 'compare-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd, who = null) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: who ? process.env[P[who]] : '' };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status, out: (r.stdout ?? '').replace(/\n$/, ''), err: (r.stderr ?? '').trim() };
}

function write(dir, path, content, mode) {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mode) chmodSync(full, mode);
}

async function push(dir, refs) {
  for (let i = 0; i < 10; i++) {
    const r = git(['push', '-q', 'origin', ...refs], dir, 'owner');
    if (r.code === 0 || !/503|warming/i.test(r.err)) return r;
    await sleep(3000);
  }
  return git(['push', '-q', 'origin', ...refs], dir, 'owner');
}

const created = [];
async function createRepo(repo, visibility) {
  const r = await http('owner', '/api/v1/repos', { method: 'POST', json: { name: repo, visibility } });
  if (!check(`create ${visibility} ${OWNER}/${repo}`, r.status === 201, show(r))) throw new Error(`could not create ${OWNER}/${repo}; refusing to push to a repo this run did not create`);
  created.push(repo);
  const dir = join(work, repo);
  git(['init', '-q', '-b', 'main', dir], work);
  git(['remote', 'add', 'origin', `${BASE}/${OWNER}/${repo}.git`], dir);
  return dir;
}

function commitAll(dir, message) {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir).out;
}

function d1Exec(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'forge', '--remote', '--json', '--command', sql], {
    cwd: platformDir,
    encoding: 'utf8',
  });
  return { code: r.status, err: r.status === 0 ? '' : (r.stderr ?? '').slice(-300) };
}

/** numstat lines keyed by the new path ("-" counts mean binary). */
function numstat(dir, a, b, renames = '-M') {
  const out = {};
  for (const line of git(['diff', '--numstat', renames, a, b], dir).out.split('\n').filter(Boolean)) {
    const [add, del, ...rest] = line.split('\t');
    const p = rest.join('\t');
    const path = p.includes(' => ') ? p.split(' => ')[1] : p;
    out[path] = add === '-' ? { binary: true } : { additions: Number(add), deletions: Number(del) };
  }
  return out;
}

function lsTree(dir, rev) {
  const out = {};
  for (const line of git(['ls-tree', '-r', rev], dir).out.split('\n').filter(Boolean)) {
    const [meta, path] = line.split('\t');
    const [mode, , hash] = meta.split(' ');
    out[path] = { mode, hash };
  }
  return out;
}

const within = (c, budget) => Object.entries(budget).every(([k, v]) => (k === 'cache' ? c[k] === v : (c[k] ?? NaN) <= v));

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

async function fixtureChecks() {
  const repo = name('fixture');
  const dir = await createRepo(repo, 'public');
  const a = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
  write(dir, 'a.txt', `${a.join('\n')}\n`);
  write(dir, 'keep.txt', `keep me ${ts}\n`);
  const root = commitAll(dir, 'root');
  write(dir, 'gone.txt', 'one\ntwo\nthree\n');
  write(dir, 'old-name.txt', 'renamed content\n');
  write(dir, 'script.sh', '#!/bin/sh\necho hi\n', 0o644);
  write(dir, 'docs/guide.md', 'guide v1\n');
  const main = commitAll(dir, 'main');
  git(['checkout', '-q', '-b', 'feature'], dir);
  write(dir, 'a.txt', `${a.map((l, i) => (i === 19 ? 'line 20 edited' : l)).join('\n')}\n`);
  rmSync(join(dir, 'gone.txt'));
  write(dir, 'new.txt', 'brand\nnew\n');
  writeFileSync(join(dir, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03]));
  git(['mv', 'old-name.txt', 'new-name.txt'], dir);
  chmodSync(join(dir, 'script.sh'), 0o755);
  write(dir, 'docs/guide.md', 'guide v2\nmore\n');
  const feature = commitAll(dir, 'feature');

  const truth = {
    numstat: numstat(dir, 'main', 'feature'),
    shortstat: git(['diff', '--shortstat', '-M', 'main', 'feature'], dir).out.trim(),
    nameStatus: git(['diff', '--name-status', '-M', 'main', 'feature'], dir).out,
    hunk: /@@ -(\d+),(\d+) \+(\d+),(\d+) @@/.exec(git(['diff', '-U3', 'main', 'feature', '--', 'a.txt'], dir).out),
    treeMain: lsTree(dir, 'main'),
    treeFeature: lsTree(dir, 'feature'),
    rootPaths: git(['ls-tree', '-r', '--name-only', root], dir).out.split('\n'),
    parent: git(['rev-parse', 'feature^'], dir).out,
  };
  console.log(`# ground truth: shortstat "${truth.shortstat}"; name-status:\n${truth.nameStatus.replace(/^/gm, '#   ')}`);
  check('fixture: push main and feature', (await push(dir, ['main', 'feature'])).code === 0);
  const lsRemote = git(['ls-remote', `${BASE}/${OWNER}/${repo}.git`, 'refs/heads/feature'], dir, 'owner').out.split('\t')[0];
  check('fixture: ls-remote feature equals local feature', lsRemote === feature, lsRemote);

  // VAL-COST-005, first-ever: no commit or line-count entries exist for this pair yet.
  const firstEver = await http('owner', api(repo, 'compare/main...feature?nocache=1'));
  const fe = firstEver.body ?? {};
  check(`VAL-COST-005 first-ever cold compare: treeReads=${fe.treeReads} blobReads=${fe.blobReads} ${show(firstEver)}`,
    firstEver.status === 200 && firstEver.cache === 'bypass' && Number.isInteger(fe.treeReads) && fe.treeReads >= 1 &&
    Number.isInteger(fe.blobReads) && fe.blobReads >= 0 && firstEver.cost.art <= fe.treeReads + fe.blobReads + 3 && firstEver.cost.d1 <= 2);

  // VAL-DIFF-001 + VAL-DIFF-020 (response 1)
  const r1 = await http(null, api(repo, 'compare/main...feature'));
  const b = r1.body ?? {};
  check(`VAL-DIFF-001 anon compare main...feature ${show(r1)}`, r1.status === 200 &&
    b.base?.ref === 'main' && b.base?.sha === main && /^[0-9a-f]{40}$/.test(b.base?.tree ?? '') &&
    b.head?.ref === 'feature' && b.head?.sha === lsRemote && /^[0-9a-f]{40}$/.test(b.head?.tree ?? '') &&
    Array.isArray(b.files) && b.files.length > 0 && b.totals && b.rating && b.truncated === false && b.totalsComplete === true,
    JSON.stringify({ base: b.base, head: b.head, truncated: b.truncated, totalsComplete: b.totalsComplete, rating: b.rating, totals: b.totals, treeReads: b.treeReads }));
  const malformed = await http(null, api(repo, 'compare/main'));
  check(`VAL-DIFF-001 malformed range compare/main does not route ${show(malformed)}`, malformed.status === 404);

  // VAL-DIFF-020: repeat hit, byte identical; sha-addressed hit with re-rendered refs
  const r2 = await http(null, api(repo, 'compare/main...feature'));
  check(`VAL-DIFF-020 response 1 miss (${r1.cache}), response 2 hit with identical body ${show(r2)}`,
    r1.cache === 'miss' && r2.cache === 'hit' && r2.text === r1.text);
  const r3 = await http(null, api(repo, `compare/${main}...${feature}`));
  const same = (x, y) => ['files', 'totals', 'rating'].every((k) => isDeepStrictEqual(x?.[k], y?.[k]));
  check(`VAL-DIFF-020/002 sha-addressed compare hits the tree-pair entry with sha refs ${show(r3)}`,
    r3.status === 200 && r3.cache === 'hit' && r3.body?.base?.sha === main && r3.body?.head?.sha === feature &&
    r3.body?.base?.ref === main && r3.body?.head?.ref === feature && same(r3.body, b));

  // VAL-DIFF-003/004/005/006
  const byPath = Object.fromEntries((b.files ?? []).map((f) => [f.path, f]));
  check('VAL-DIFF-003 statuses: gone removed (no oldPath), new added, a modified, keep absent',
    byPath['gone.txt']?.status === 'removed' && byPath['gone.txt']?.oldPath === undefined && byPath['new.txt']?.status === 'added' &&
    byPath['a.txt']?.status === 'modified' && !byPath['keep.txt'],
    JSON.stringify((b.files ?? []).map((f) => [f.path, f.status])));
  const rn = byPath['new-name.txt'];
  check('VAL-DIFF-004 exact rename is one entry with oldPath and unchanged blob/mode',
    rn?.status === 'renamed' && rn.oldPath === 'old-name.txt' && rn.oldHash === rn.newHash && rn.oldMode === rn.newMode &&
    !byPath['old-name.txt'], JSON.stringify(rn));
  const sh = byPath['script.sh'];
  check('VAL-DIFF-005 script.sh typechange 100644 -> 100755 with same blob (matches ls-tree)',
    sh?.status === 'typechange' && sh.oldMode === '100644' && sh.newMode === '100755' && sh.oldHash === sh.newHash &&
    truth.treeMain['script.sh']?.mode === '100644' && truth.treeFeature['script.sh']?.mode === '100755', JSON.stringify(sh));
  const hashMismatches = [];
  for (const f of b.files ?? []) {
    const oldPath = f.oldPath ?? f.path;
    const o = truth.treeMain[oldPath];
    const n = truth.treeFeature[f.path];
    if (f.status !== 'added' && (f.oldHash !== o?.hash || f.oldMode !== o?.mode)) hashMismatches.push(`${f.path} old`);
    if (f.status !== 'removed' && (f.newHash !== n?.hash || f.newMode !== n?.mode)) hashMismatches.push(`${f.path} new`);
    if (f.status === 'added' && f.oldHash != null) hashMismatches.push(`${f.path} added has oldHash`);
    if (f.status === 'removed' && f.newHash != null) hashMismatches.push(`${f.path} removed has newHash`);
  }
  check('VAL-DIFF-006 hashes and modes match git ls-tree on both commits', hashMismatches.length === 0, hashMismatches.join(', '));

  // VAL-DIFF-007
  const statMismatches = [];
  for (const [path, want] of Object.entries(truth.numstat)) {
    const f = byPath[path];
    if (want.binary) {
      if (f?.binary !== true || f.additions !== undefined || f.deletions !== undefined) statMismatches.push(path);
    } else if (f?.additions !== want.additions || f?.deletions !== want.deletions) statMismatches.push(path);
  }
  const ss = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(truth.shortstat);
  const totalsOk = Number(ss?.[1]) === b.totals?.files && b.totals?.files === b.files?.length &&
    Number(ss?.[2] ?? 0) === b.totals?.additions && Number(ss?.[3] ?? 0) === b.totals?.deletions;
  check('VAL-DIFF-007 per-file numstat and shortstat totals match git (totalsComplete true)', statMismatches.length === 0 && totalsOk && b.totalsComplete === true,
    `numstat mismatches [${statMismatches.join(', ')}] totals ${JSON.stringify(b.totals)} totalsComplete=${b.totalsComplete} vs "${truth.shortstat}"`);

  // VAL-DIFF-008
  const paths = (b.files ?? []).map((f) => f.path);
  const ordered = await http(null, api(repo, 'compare/main...feature?order=path'));
  check('VAL-DIFF-008 path order ascending, ?order=path identical',
    isDeepStrictEqual([...paths].sort(), paths) && isDeepStrictEqual(ordered.body?.files?.map((f) => f.path), paths), paths.join(' '));

  // VAL-DIFF-009
  const stitched = [];
  let cursor;
  let pages = 0;
  let totalsStable = true;
  let firstPageLen = -1;
  do {
    const page = await http(null, api(repo, `compare/main...feature?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    if (pages === 0) firstPageLen = page.body?.files?.length ?? -1;
    totalsStable &&= isDeepStrictEqual(page.body?.totals, b.totals) && page.body?.totalsComplete === true;
    stitched.push(...(page.body?.files ?? []).map((f) => f.path));
    cursor = page.body?.nextCursor;
    pages++;
  } while (cursor && pages < 20);
  check(`VAL-DIFF-009 limit=3 pages (${pages}) stitch to the full list with whole totals`,
    firstPageLen === 3 && totalsStable && isDeepStrictEqual(stitched, paths), stitched.join(' '));

  // VAL-DIFF-010/011
  const same2 = await http(null, api(repo, 'compare/main...main'));
  check(`VAL-DIFF-010 main...main empty ${show(same2)}`, same2.status === 200 && isDeepStrictEqual(same2.body?.files, []) &&
    isDeepStrictEqual(same2.body?.totals, { files: 0, additions: 0, deletions: 0 }) && same2.body?.truncated === false && same2.body?.totalsComplete === true);
  for (const p of [api(repo, 'compare/main...no-such-branch'), api(repo, 'compare/no-such-branch...feature'), `/api/v1/repos/${OWNER}/no-such-repo-${ts}/compare/main...feature`]) {
    const r = await http(null, p);
    check(`VAL-DIFF-011 404 {error} for ${p.split('/').slice(4).join('/')} ${show(r)}`, r.status === 404 && typeof r.body?.error === 'string', r.text);
  }

  // VAL-DIFF-013/014/015
  const fd = await http(null, api(repo, `compare/main...feature/file?path=${encodeURIComponent('a.txt')}`));
  const h0 = fd.body?.hunks?.[0];
  const linesOk = (h0?.lines ?? []).every((l) => (l.type === 'ins' ? l.newNo && !l.oldNo : l.type === 'del' ? l.oldNo && !l.newNo : l.oldNo && l.newNo));
  check(`VAL-DIFF-013 a.txt hunk header equals git -U3 ${show(fd)}`, fd.status === 200 && fd.body?.path === 'a.txt' && fd.body?.approximate === false &&
    h0?.oldStart === Number(truth.hunk?.[1]) && h0?.oldLines === Number(truth.hunk?.[2]) && h0?.newStart === Number(truth.hunk?.[3]) &&
    h0?.newLines === Number(truth.hunk?.[4]) && linesOk && fd.body?.totalAdditions === truth.numstat['a.txt']?.additions &&
    fd.body?.totalDeletions === truth.numstat['a.txt']?.deletions,
    `git ${truth.hunk?.[0]} api ${JSON.stringify({ oldStart: h0?.oldStart, oldLines: h0?.oldLines, newStart: h0?.newStart, newLines: h0?.newLines })}`);
  const bin = await http(null, api(repo, 'compare/main...feature/file?path=image.bin'));
  check(`VAL-DIFF-014 image.bin binary, no hunks or counts ${show(bin)}`, bin.status === 200 && bin.body?.binary === true &&
    (bin.body?.hunks ?? []).length === 0 && bin.body?.totalAdditions === undefined, bin.text);
  const keep = await http(null, api(repo, 'compare/main...feature/file?path=keep.txt'));
  check(`VAL-DIFF-015 unchanged keep.txt 404 ${show(keep)}`, keep.status === 404 && typeof keep.body?.error === 'string', keep.text);

  // VAL-DIFF-018/019
  const cd = await http(null, api(repo, `commits/${feature}/diff`));
  const viaCompare = await http(null, api(repo, `compare/${truth.parent}...${feature}`));
  const pick = (r) => (r.body?.files ?? []).map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions }));
  check(`VAL-DIFF-018 commit diff equals parent...commit compare ${show(cd)}`, cd.status === 200 && cd.body?.base?.sha === truth.parent &&
    isDeepStrictEqual(pick(cd), pick(viaCompare)));
  const rd = await http(null, api(repo, `commits/${root}/diff`));
  const rootFiles = (rd.body?.files ?? []).map((f) => f.path);
  check(`VAL-DIFF-019 root commit diff lists every root path once as added ${show(rd)}`, rd.status === 200 &&
    isDeepStrictEqual([...rootFiles].sort(), [...truth.rootPaths].sort()) && (rd.body?.files ?? []).every((f) => f.status === 'added'),
    rootFiles.join(' '));

  // VAL-COST-004
  const c1 = await http('owner', api(repo, 'compare/main...feature'));
  const c2 = await http('owner', api(repo, 'compare/main...feature'));
  check(`VAL-COST-004 warm PAT compare ${show(c2)} (first ${show(c1)})`, c2.status === 200 && c2.cache === 'hit' &&
    within(c2.cost, { d1: 1, art: 0, do: 0, sub: 0, cache: 'hit' }));
  const f1 = await http('owner', api(repo, 'compare/main...feature/file?path=a.txt'));
  const f2 = await http('owner', api(repo, 'compare/main...feature/file?path=a.txt'));
  check(`VAL-COST-004 warm PAT file diff ${show(f2)} (first ${show(f1)})`, f2.status === 200 && f2.cache === 'hit' &&
    within(f2.cost, { d1: 1, art: 0, do: 0, sub: 0, cache: 'hit' }));

  // VAL-COST-005
  const cold = await http('owner', api(repo, 'compare/main...feature?nocache=1'));
  const tr = cold.body?.treeReads;
  const br = cold.body?.blobReads;
  check(`VAL-COST-005 admin nocache compare: treeReads=${tr} blobReads=${br} ${show(cold)}`, cold.status === 200 && cold.cache === 'bypass' &&
    Number.isInteger(tr) && tr >= 1 && Number.isInteger(br) && br >= 0 && cold.cost.art <= tr + br + 3 && cold.cost.d1 <= 2);
  for (const who of [null, 'bot']) {
    const r = await http(who, api(repo, 'compare/main...feature?nocache=1'));
    check(`VAL-DIFF-022 spot check: ${who ?? 'anonymous'} nocache served normally, no bypass ${show(r)}`, r.status === 200 && r.cache !== 'bypass');
  }
  return repo;
}

// ---------------------------------------------------------------------------
// private + flip
// ---------------------------------------------------------------------------

async function privateChecks() {
  const repo = name('private');
  const dir = await createRepo(repo, 'private');
  write(dir, 'secret.txt', `private-marker-${ts}\n`);
  commitAll(dir, 'private');
  check('private: push main', (await push(dir, ['main'])).code === 0);
  const unknown = await http(null, `/api/v1/repos/${OWNER}/no-such-repo-${ts}/compare/main...main`);
  for (const who of [null, 'bot']) {
    const r = await http(who, api(repo, 'compare/main...main'));
    check(`VAL-DIFF-012 ${who ?? 'anonymous'} private compare 404 with the unknown-repo body ${show(r)}`,
      r.status === 404 && r.text === unknown.text && within(r.cost, { d1: 1, art: 0, do: 0, sub: 0 }), r.text);
  }
  const owner = await http('owner', api(repo, 'compare/main...main'));
  check(`VAL-DIFF-012 owner PAT private compare 200 ${show(owner)}`, owner.status === 200);
}

async function flipChecks() {
  const repo = name('flip');
  const dir = await createRepo(repo, 'public');
  write(dir, 'f.txt', `flip-marker-${ts} v1\n`);
  commitAll(dir, 'base');
  git(['checkout', '-q', '-b', 'next'], dir);
  write(dir, 'f.txt', `flip-marker-${ts} v2\n`);
  commitAll(dir, 'next');
  check('flip: push main and next', (await push(dir, ['main', 'next'])).code === 0);
  const paths = [api(repo, 'compare/main...next'), api(repo, 'compare/main...next/file?path=f.txt')];
  const unknownFor = async (p) => (await http(null, p.replace(`/${repo}/`, `/no-such-repo-${ts}/`))).text;

  const warmAll = async (label) => {
    for (const p of paths) {
      await http(null, p);
      const w = await http(null, p);
      check(`VAL-DIFF-012 ${label}: warm public ${p.includes('/file') ? 'file diff' : 'compare'} is a hit ${show(w)}`,
        w.status === 200 && w.cache === 'hit' && w.text.includes('f.txt'));
    }
  };
  const deniedAll = async (label) => {
    for (const p of paths) {
      const unknown = await unknownFor(p);
      for (const who of [null, 'bot']) {
        const r = await http(who, p);
        check(`VAL-DIFF-012 ${label}: ${who ?? 'anonymous'} ${p.includes('/file') ? 'file diff' : 'compare'} denied, no body ${show(r)}`,
          r.status === 404 && r.text === unknown && !r.text.includes('f.txt') && within(r.cost, { d1: 1, art: 0, do: 0, sub: 0, cache: 'none' }), r.text);
      }
      const o = await http('owner', p);
      check(`VAL-DIFF-012 ${label}: owner ${p.includes('/file') ? 'file diff' : 'compare'} still 200 ${show(o)}`, o.status === 200 && o.text.includes('f.txt'));
    }
  };

  await warmAll('before direct D1 flip');
  const flip = d1Exec(`UPDATE repos SET visibility = 'private' WHERE owner_login = '${OWNER}' AND name = '${repo}'`);
  check(`flip: direct remote D1 UPDATE to private (no Worker code, no purge) ${flip.err}`, flip.code === 0);
  await deniedAll('after direct D1 flip');

  const back = d1Exec(`UPDATE repos SET visibility = 'public' WHERE owner_login = '${OWNER}' AND name = '${repo}'`);
  check(`flip: direct D1 back to public ${back.err}`, back.code === 0);
  await warmAll('before owner PATCH flip');
  const patch = await http('owner', `/api/v1/repos/${OWNER}/${repo}`, { method: 'PATCH', json: { visibility: 'private' } });
  check(`flip: owner PATCH visibility=private ${show(patch)}`, patch.status === 200 && patch.body?.repo?.visibility === 'private');
  await deniedAll('after owner PATCH flip');
}

// ---------------------------------------------------------------------------
// bypass
// ---------------------------------------------------------------------------

async function bypassChecks() {
  const repo = name('bypass');
  const dir = await createRepo(repo, 'public');
  write(dir, 'n.txt', `bypass ${ts}\n`);
  commitAll(dir, 'base');
  git(['checkout', '-q', '-b', 'topic'], dir);
  write(dir, 'n.txt', `bypass ${ts}\nsecond\n`);
  commitAll(dir, 'topic');
  check('bypass: push main and topic', (await push(dir, ['main', 'topic'])).code === 0);
  const p = api(repo, 'compare/main...topic');
  const one = await http('owner', `${p}?nocache=1`);
  const two = await http('owner', p);
  const three = await http('owner', p);
  check(`VAL-COST-006 bypass -> miss -> hit: ${one.cache}/${one.cost.cache}, ${two.cache}/${two.cost.cache}, ${three.cache}/${three.cost.cache}`,
    one.status === 200 && one.cache === 'bypass' && one.cost.cache === 'bypass' && two.cache === 'miss' && two.cost.cache === 'miss' &&
    three.cache === 'hit' && three.cost.cache === 'hit');
  console.log(`#   1 ${show(one)}\n#   2 ${show(two)}\n#   3 ${show(three)}`);
}

// ---------------------------------------------------------------------------
// huge
// ---------------------------------------------------------------------------

async function hugeChecks() {
  const repo = name('huge');
  const dir = await createRepo(repo, 'public');
  const row = `${'x'.repeat(99)}\n`;
  const n = 60_000;
  write(dir, 'big.txt', `${row.repeat(52_000)}tail a\n`);
  write(dir, 'mix.txt', Array.from({ length: n }, (_, i) => `row ${i}\n`).join(''));
  // ~1.8 MB: under the 4 MB per-file cap, so these are counted, not tooLarge.
  const tall = (tag) => Array.from({ length: 200_000 }, (_, i) => (i === 0 ? `${tag} ${ts}\n` : `${tag}${i}\n`)).join('');
  write(dir, 'tall-old.txt', tall('old'));
  const root = commitAll(dir, 'base');
  git(['checkout', '-q', '-b', 'next'], dir);
  write(dir, 'big.txt', `${row.repeat(52_000)}tail b\n`);
  write(dir, 'mix.txt', Array.from({ length: n }, (_, i) => (i % 3 === 0 ? `row ${i}\n` : `moved ${(i * 7919) % n}\n`)).join(''));
  rmSync(join(dir, 'tall-old.txt'));
  write(dir, 'tall-new.txt', tall('new'));
  commitAll(dir, 'next');
  check('huge: push main and next (5.2 MB file, 200,000-line files)', (await push(dir, ['main', 'next'])).code === 0);
  const big = await http(null, api(repo, 'compare/main...next/file?path=big.txt'));
  check(`VAL-DIFF-016 5 MB file tooLarge, no hunks, body ${big.text.length} B < 64 KB ${show(big)}`,
    big.status === 200 && big.body?.tooLarge === true && (big.body?.hunks ?? []).length === 0 && big.text.length < 64 * 1024 && big.ms < 30_000, big.text.slice(0, 200));
  const mix = await http(null, api(repo, 'compare/main...next/file?path=mix.txt'));
  const want = numstat(dir, 'main', 'next')['mix.txt'];
  check(`VAL-DIFF-017-style 60k-line interleaved edit: approximate=${mix.body?.approximate} truncated=${mix.body?.truncated} +${mix.body?.totalAdditions}/-${mix.body?.totalDeletions} (git +${want?.additions}/-${want?.deletions}) body ${mix.text.length} B ${show(mix)}`,
    mix.status === 200 && mix.body?.totalAdditions > 0 && mix.body?.totalDeletions > 0 && mix.text.length < 10 * 1024 * 1024 && mix.ms < 30_000);
  const list = await http(null, api(repo, 'compare/main...next'));
  check(`huge: compare lists big.txt as tooLarge without counts ${show(list)}`, list.status === 200 &&
    list.body?.files?.find((f) => f.path === 'big.txt')?.tooLarge === true, JSON.stringify(list.body?.files?.map((f) => ({ ...f, risk: undefined }))));

  // 200,000-line files on every compare surface: 200, exact whole-file counts, bounded file-diff output.
  // The platform does exact-hash rename detection only; git -M would pair these two by similarity.
  const truth = numstat(dir, 'main', 'next', '--no-renames');
  const tallOk = (b) => {
    const by = Object.fromEntries((b?.files ?? []).map((f) => [f.path, f]));
    return by['tall-old.txt']?.status === 'removed' && by['tall-old.txt']?.deletions === truth['tall-old.txt']?.deletions &&
      by['tall-new.txt']?.status === 'added' && by['tall-new.txt']?.additions === truth['tall-new.txt']?.additions;
  };
  check(`huge: compare counts the 200,000-line files exactly (git -${truth['tall-old.txt']?.deletions}/+${truth['tall-new.txt']?.additions}) totalsComplete=${list.body?.totalsComplete}`,
    list.status === 200 && tallOk(list.body) && list.body?.totalsComplete === true);
  const tallBypass = await http('owner', api(repo, 'compare/main...next?nocache=1'));
  check(`huge: admin nocache compare with 200,000-line files ${show(tallBypass)}`, tallBypass.status === 200 && tallBypass.cache === 'bypass' && tallOk(tallBypass.body));
  const rootDiff = await http(null, api(repo, `commits/${root}/diff`));
  const rootTall = rootDiff.body?.files?.find((f) => f.path === 'tall-old.txt');
  check(`huge: root commit diff adds the 200,000-line file +${rootTall?.additions} ${show(rootDiff)}`, rootDiff.status === 200 && rootTall?.status === 'added' && rootTall?.additions === 200_000);
  for (const [path, key, want] of [['tall-old.txt', 'totalDeletions', truth['tall-old.txt']?.deletions], ['tall-new.txt', 'totalAdditions', truth['tall-new.txt']?.additions]]) {
    const fdTall = await http(null, api(repo, `compare/main...next/file?path=${path}`));
    const shown = (fdTall.body?.hunks ?? []).reduce((acc, h) => acc + (h.lines?.length ?? 0), 0);
    check(`huge: ${path} file diff ${key}=${fdTall.body?.[key]} (git ${want}) truncated=${fdTall.body?.truncated} lines shown ${shown} body ${fdTall.text.length} B ${show(fdTall)}`,
      fdTall.status === 200 && fdTall.body?.[key] === want && fdTall.body?.truncated === true && shown <= 10_000 && fdTall.text.length < 10 * 1024 * 1024);
  }
}

// ---------------------------------------------------------------------------
// wide
// ---------------------------------------------------------------------------

async function wideChecks() {
  const repo = name('wide');
  const dir = await createRepo(repo, 'public');
  const pairs = [
    ['many', 400, 1],
    ['mid', 950, 1],
    ['wide', 1600, 1],
  ];
  for (const [prefix, dirs] of pairs) for (let i = 0; i < dirs; i++) write(dir, `${prefix}/d${i}/x.txt`, `a ${i}\n`);
  write(dir, 'run.txt', `${ts}\n`);
  commitAll(dir, 'base');
  const branches = [];
  for (const [prefix, dirs] of pairs) {
    git(['checkout', '-q', 'main'], dir);
    git(['checkout', '-q', '-b', `w-${prefix}`], dir);
    for (let i = 0; i < dirs; i++) write(dir, `${prefix}/d${i}/x.txt`, `b ${i}\n`);
    commitAll(dir, prefix);
    branches.push(`w-${prefix}`);
  }
  check('wide: push main and wide branches', (await push(dir, ['main', ...branches])).code === 0);
  for (const [prefix, dirs] of pairs) {
    const r = await http('owner', api(repo, `compare/main...w-${prefix}?nocache=1`));
    const b = r.body ?? {};
    const honest = b.truncated === true
      ? typeof b.truncatedReason === 'string' && b.truncatedReason.length > 0 && b.files?.length < dirs && b.totalsComplete === false && b.totals?.files === b.files?.length
      : b.files?.length === dirs && b.totalsComplete === true;
    check(`VAL-DIFF-021-style ${dirs} changed dirs: files=${b.files?.length} truncated=${b.truncated} reason="${b.truncatedReason ?? ''}" totalsComplete=${b.totalsComplete} statsOmitted=${b.statsOmitted} treeReads=${b.treeReads} totals=${JSON.stringify(b.totals)} ${show(r)}`,
      r.status === 200 && honest && b.statsOmitted === true && (b.files ?? []).every((f) => f.additions === undefined) && r.ms < 30_000);
  }
}

// ---------------------------------------------------------------------------

try {
  console.log(`# ${new Date().toISOString()} base ${BASE}; repos ${PREFIX}-*-${ts}`);
  if (runs('fixture')) await fixtureChecks();
  if (runs('private')) await privateChecks();
  if (runs('flip')) await flipChecks();
  if (runs('bypass')) await bypassChecks();
  if (runs('huge')) await hugeChecks();
  if (runs('wide')) await wideChecks();
} catch (err) {
  check(`driver error: ${err?.stack ?? err}`, false);
} finally {
  if (!KEEP) {
    for (const repo of created) {
      const r = await http('owner', `/api/v1/repos/${OWNER}/${repo}`, { method: 'DELETE' });
      console.log(`# delete ${OWNER}/${repo}: ${r.status}`);
    }
  } else {
    console.log(`# kept: ${created.map((r) => `${OWNER}/${r}`).join(', ')}`);
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
