#!/usr/bin/env node
/**
 * Live validation driver for the retained cached-public regression
 * (VAL-ACCESS-003) and the authority-lookup budgets (VAL-COST-002,
 * VAL-COST-021).
 *
 * As forge-bot it creates a tiny public repo, pushes a marker file, and warms
 * every existing read surface while it is public: REST metadata, the tree page
 * and raw file (edge-cached), info/refs (v0 and v2, edge-cached) and an
 * upload-pack POST that returns the pack. It then flips the repo private with
 * a direct remote D1 UPDATE (`wrangler d1 execute`), so no Worker code runs and
 * nothing is purged — what a colo that never saw the change looks like — and
 * immediately checks that anonymous and unrelated-principal requests are denied
 * with none of the warmed bodies, while the owner keeps reading. Flipping back
 * public then shows the same edge entries were retained (cache=hit) and were
 * never served while private. A second flip uses the documented PATCH.
 *
 * Before the flip it also sends a rejected Bearer to the warm public page and
 * raw file: a previously unseen well-formed token and a just-revoked warmed
 * scratch owner PAT (inserted and then deleted directly in D1, so the cached
 * PAT copy is retained). Pages answer as anonymous from the cache on one
 * authority lookup (d1<=1), while REST and git still return 401. Right after
 * the flip the same kinds of rejected Bearer get 404 on the private pages.
 *
 * Cost: warm public metadata (FORGE_PAT and the owner), warm cached info/refs,
 * warm private personal and private org repo reads, and the first denial after
 * a grant revoke, all from x-forge-cost.
 *
 * Private content: a commit-SHA raw file (and blob page) in a private personal
 * repo and a private org repo is served on repeat from the repo-scoped
 * immutable content cache (cache=hit, art=0, sub=0, do=0, d1<=2) and always
 * with a private Cache-Control. Right after a grant revoke, a direct D1 PAT
 * deletion or a visibility flip the next request is denied with none of the
 * retained bytes, while the still-authorized owner keeps hitting the entry.
 * Anonymous public raw keeps its public Cache-Control.
 *
 * Principals come from env vars by NAME (load apps/platform/.dev.vars.validation):
 * FORGE_PAT_BOT (owner), FORGE_PAT_OUTSIDER (unrelated), FORGE_PAT_MEMBER (org
 * member), FORGE_PAT (cynthia). Tokens are never printed; git runs with
 * `-c credential.helper=` and a secret-free GIT_ASKPASS helper.
 *
 * Usage: node scripts/visibility-flip-e2e.mjs [--keep]
 * Exit 0 when every expectation held, 1 otherwise. Repos are deleted at the
 * end unless --keep; the org has no delete API and is left as inert test data.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const KEEP = process.argv.includes('--keep');
const P = { owner: 'FORGE_PAT_BOT', outsider: 'FORGE_PAT_OUTSIDER', member: 'FORGE_PAT_MEMBER', admin: 'FORGE_PAT' };
for (const k of Object.values(P)) if (!process.env[k]) throw new Error(`env ${k} is not set`);
const OWNER = 'forge-bot';
const MEMBER = 'forge-org-member';

const ts = Date.now();
const PREFIX = 'access-visibility-content-authority';
const FLIP = `${PREFIX}-flip-${ts}`;
const COST = `${PREFIX}-cost-${ts}`;
const PRIV = `${PREFIX}-private-${ts}`;
const ORG = `avc-authority-${ts}`;
const ORGREPO = `${PREFIX}-org-${ts}`;
const MARKER = `avca-marker-${ts}`;
const platformDir = fileURLToPath(new URL('../apps/platform/', import.meta.url));

const results = [];
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  -> ${typeof actual === 'string' ? actual : JSON.stringify(actual)}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString();

function costOf(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = k === 'cache' ? v : Number(v);
  }
  return out;
}

function authHeader(who, kind) {
  if (!who) return {};
  const token = process.env[P[who]];
  return { Authorization: kind === 'basic' ? `Basic ${Buffer.from(`x:${token}`).toString('base64')}` : `Bearer ${token}` };
}

async function http(who, path, { method = 'GET', kind = 'bearer', headers = {}, body, json } = {}) {
  const h = { ...authHeader(who, kind), ...headers };
  if (json !== undefined) h['content-type'] = 'application/json';
  const init = { method, headers: h, redirect: 'manual' };
  if (json !== undefined) init.body = JSON.stringify(json);
  else if (body !== undefined) init.body = body;
  const res = await fetch(`${BASE}${path}`, init);
  const buf = Buffer.from(await res.arrayBuffer());
  const header = res.headers.get('x-forge-cost');
  const cacheControl = res.headers.get('cache-control');
  return { status: res.status, text: buf.toString('latin1'), header, cost: costOf(header), cacheControl, at: stamp() };
}

const api = (who, method, path, json) => http(who, `/api/v1${path}`, { method, json });

const work = mkdtempSync(join(tmpdir(), 'visibility-flip-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(who, args, cwd = work) {
  const env = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: who ? process.env[P[who]] : '' };
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

function pkt(line) {
  return `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
}

/** Minimal protocol-v0 fetch of one commit; the response carries the pack. */
function uploadPack(who, repo, sha) {
  return http(who, `/${OWNER}/${repo}.git/git-upload-pack`, {
    method: 'POST',
    kind: 'basic',
    headers: { 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' },
    body: `${pkt(`want ${sha} ofs-delta\n`)}0000${pkt('done\n')}`,
  });
}

/** Runs SQL on the remote D1 directly; `changes` is from the first statement. */
function d1Exec(sql) {
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'forge', '--remote', '--json', '--command', sql], {
    cwd: platformDir,
    encoding: 'utf8',
  });
  let changes = null;
  try {
    changes = JSON.parse(r.stdout)[0]?.meta?.changes ?? null;
  } catch {
    // reported below
  }
  return { code: r.status, changes, err: r.status === 0 ? '' : r.stderr.slice(-300) };
}

function d1Flip(repo, visibility) {
  return d1Exec(`UPDATE repos SET visibility = '${visibility}' WHERE owner_login = '${OWNER}' AND name = '${repo}'`);
}

const randomPat = () => `forge_pat_${randomBytes(32).toString('hex')}`;
const bearerOnly = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const basicOnly = (token) => ({ kind: 'basic', headers: { Authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}` } });

/**
 * Scratch PATs for the owner, inserted directly (as scripts/mint-pat.mjs does)
 * so they can be revoked by a direct D1 DELETE that leaves this colo's cached
 * PAT copy in place. Tokens live only in this process's env, under SCRATCH_*.
 */
const scratchIds = [];
function mintScratchPats(n, from = 0) {
  const rows = [];
  for (let i = from; i < from + n; i++) {
    const token = randomPat();
    const id = randomUUID();
    process.env[`SCRATCH_PAT_${i}`] = token;
    P[`scratch${i}`] = `SCRATCH_PAT_${i}`;
    scratchIds.push(id);
    rows.push(
      `INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at)
         SELECT '${id}', id, 'avca-scratch-${ts}-${i}', '${token.slice(0, 18)}',
                '${createHash('sha256').update(token).digest('hex')}', '["read","write","api"]', ${Date.now()}
           FROM users WHERE login = '${OWNER}'`,
    );
  }
  return d1Exec(rows.join(';\n'));
}

function revokeScratchPats() {
  if (scratchIds.length === 0) return { code: 0, changes: 0, err: '' };
  return d1Exec(`DELETE FROM pat WHERE id IN (${scratchIds.map((id) => `'${id}'`).join(', ')})`);
}

/** One marker commit pushed by the owner; returns its SHA. */
async function seedMarker(owner, repo, file, content) {
  const dir = join(work, `seed-${repo}`);
  git(null, ['init', '-q', '-b', 'main', dir]);
  writeFileSync(join(dir, file), `${content}\n`);
  git(null, ['add', file], dir);
  git(null, ['-c', 'user.name=visibility-flip-e2e', '-c', 'user.email=e2e@forge.invalid', 'commit', '-q', '-m', 'marker'], dir);
  git(null, ['remote', 'add', 'origin', `${BASE}/${owner}/${repo}.git`], dir);
  const pushed = await pushWithRetry(dir);
  return { code: pushed.code, sha: git(null, ['rev-parse', 'HEAD'], dir).out };
}

const privateScope = (cc) => typeof cc === 'string' && /private|no-store/i.test(cc) && !/public/i.test(cc);
const contentHitBudget = { d1: 2, rr: 8, art: 0, sub: 0, do: 0, cache: 'hit' };

/** Repeats an authorized private content read until the immutable entry is warm. */
async function warmPrivateContent(label, who, path, mark) {
  const first = await http(who, path);
  check(`${label}: first read 200 with marker, private Cache-Control "${first.cacheControl}" [${first.at}] ${first.header}`,
    first.status === 200 && first.text.includes(mark) && privateScope(first.cacheControl), true);
  let r;
  for (let i = 0; i < 6; i++) {
    r = await http(who, path);
    if (r.cost.cache === 'hit') break;
    await sleep(1000);
  }
  check(`${label}: warm repeat is a content cache hit, private Cache-Control "${r.cacheControl}" (VAL-COST-021) [${r.at}] ${r.header}`,
    r.status === 200 && r.text.includes(mark) && privateScope(r.cacheControl) && within(r.cost, contentHitBudget), true);
  return r;
}

function assertContentDenied(label, r, mark) {
  check(`${label}: denied with no retained bytes [${r.at}] ${r.header}`,
    r.status === 404 && !r.text.includes(mark) && within(r.cost, { ...deniedBudget, cache: 'none' }), true);
}

async function pushWithRetry(dir) {
  for (let i = 0; i < 10; i++) {
    const r = git('owner', ['push', '-q', 'origin', 'main'], dir);
    if (r.code === 0 || !/503|warming/i.test(r.err)) return r;
    await sleep(3000);
  }
  return git('owner', ['push', '-q', 'origin', 'main'], dir);
}

const within = (c, budget) => Object.entries(budget).every(([k, v]) => (k === 'cache' ? c[k] === v : (c[k] ?? NaN) <= v));
const deniedBudget = { d1: 1, rr: 8, art: 0, do: 0, sub: 0 };

/**
 * Every warmed surface as an unauthorized caller right after a flip: denied,
 * none of the warmed bodies, no cache hit, no Artifacts or upstream work.
 */
async function assertDenied(label, who, sha) {
  const gitStatus = who ? 404 : 401;
  const meta = await http(who, `/api/v1/repos/${OWNER}/${FLIP}`);
  check(`${label}: ${who ?? 'anonymous'} REST metadata denied, no body [${meta.at}] ${meta.header}`,
    meta.status === 404 && !meta.text.includes(FLIP) && within(meta.cost, deniedBudget), true);
  for (const path of [`/${OWNER}/${FLIP}`, `/${OWNER}/${FLIP}/raw/main/MARKER.txt`]) {
    const r = await http(who, path);
    check(`${label}: ${who ?? 'anonymous'} page ${path.slice(OWNER.length + FLIP.length + 2) || '/'} denied [${r.at}] ${r.header}`,
      r.status === 404 && !r.text.includes(MARKER) && !r.text.includes('MARKER.txt') && within(r.cost, { ...deniedBudget, cache: 'none' }), true);
  }
  for (const proto of [null, 'version=2']) {
    const r = await http(who, `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, {
      kind: 'basic',
      headers: proto ? { 'Git-Protocol': proto } : {},
    });
    check(`${label}: ${who ?? 'anonymous'} info/refs ${proto ?? 'v0'} denied, no refs [${r.at}] ${r.header}`,
      r.status === gitStatus && !r.text.includes(sha) && !r.text.includes('refs/heads') && within(r.cost, { ...deniedBudget, cache: 'none' }), true);
  }
  const pack = await uploadPack(who, FLIP, sha);
  check(`${label}: ${who ?? 'anonymous'} upload-pack denied, no pack [${pack.at}] ${pack.header}`,
    pack.status === gitStatus && !pack.text.includes('PACK') && within(pack.cost, deniedBudget), true);
  const ls = git(who, ['ls-remote', `${BASE}/${OWNER}/${FLIP}.git`]);
  check(`${label}: ${who ?? 'anonymous'} git ls-remote discloses no refs`, ls.code !== 0 && !ls.out.includes(sha), true);
  const dir = join(work, `clone-${label.replace(/\W+/g, '-')}-${who ?? 'anon'}`);
  const clone = git(who, ['clone', '-q', `${BASE}/${OWNER}/${FLIP}.git`, dir]);
  check(`${label}: ${who ?? 'anonymous'} git clone fails`, clone.code !== 0, true);
}

async function assertOwnerReads(label, sha) {
  const meta = await http('owner', `/api/v1/repos/${OWNER}/${FLIP}`);
  check(`${label}: owner REST metadata 200 private [${meta.at}] ${meta.header}`,
    meta.status === 200 && JSON.parse(meta.text).repo?.visibility === 'private', true);
  const pg = await http('owner', `/${OWNER}/${FLIP}/raw/main/MARKER.txt`);
  check(`${label}: owner raw page 200 with marker`, pg.status === 200 && pg.text.includes(MARKER), true);
  const refs = await http('owner', `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, { kind: 'basic' });
  check(`${label}: owner info/refs 200 uncached [${refs.at}] ${refs.header}`,
    refs.status === 200 && refs.text.includes(sha) && refs.cost.cache !== 'hit' && refs.cost.do === 0, true);
  const pack = await uploadPack('owner', FLIP, sha);
  check(`${label}: owner upload-pack returns the pack ${pack.header}`, pack.status === 200 && pack.text.includes('PACK'), true);
  const dir = join(work, `owner-${label.replace(/\W+/g, '-')}`);
  const clone = git('owner', ['clone', '-q', `${BASE}/${OWNER}/${FLIP}.git`, dir]);
  let content = '';
  try {
    content = readFileSync(join(dir, 'MARKER.txt'), 'utf8').trim();
  } catch {
    // reported by the check
  }
  check(`${label}: owner git clone reads the marker`, clone.code === 0 && content === MARKER, true);
}

const created = [];
try {
  console.log(`# ${stamp()} repos ${OWNER}/${FLIP}, ${COST}, ${PRIV}; org ${ORG}/${ORGREPO}`);
  for (const [name, visibility] of [[FLIP, 'public'], [COST, 'public'], [PRIV, 'private']]) {
    const r = await api('owner', 'POST', '/repos', { name, visibility });
    if (check(`create ${visibility} ${name}`, r.status, 201)) created.push(`${OWNER}/${name}`);
  }

  // Seed the flip repo with one marker commit.
  const seed = join(work, 'seed');
  git(null, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'MARKER.txt'), `${MARKER}\n`);
  git(null, ['add', 'MARKER.txt'], seed);
  git(null, ['-c', 'user.name=visibility-flip-e2e', '-c', 'user.email=e2e@forge.invalid', 'commit', '-q', '-m', 'marker'], seed);
  const sha = git(null, ['rev-parse', 'HEAD'], seed).out;
  git(null, ['remote', 'add', 'origin', `${BASE}/${OWNER}/${FLIP}.git`], seed);
  check('owner pushes marker commit', (await pushWithRetry(seed)).code, 0);

  // ---- Warm every surface while public ----
  console.log(`# ${stamp()} warming public surfaces`);
  for (const who of [null, 'outsider']) {
    await http(who, `/api/v1/repos/${OWNER}/${FLIP}`);
    const warm = await http(who, `/api/v1/repos/${OWNER}/${FLIP}`);
    check(`warm: ${who ?? 'anonymous'} REST metadata 200 [${warm.at}] ${warm.header}`,
      warm.status === 200 && within(warm.cost, { d1: 1, rr: 8, rw: 0, do: 0 }), true);
  }
  for (const path of [`/${OWNER}/${FLIP}`, `/${OWNER}/${FLIP}/raw/main/MARKER.txt`]) {
    let r;
    for (let i = 0; i < 6; i++) {
      r = await http(null, path);
      if (r.cost.cache === 'hit') break;
      await sleep(1000);
    }
    check(`warm: anonymous page ${path} served from edge cache after the lookup [${r.at}] ${r.header}`,
      r.status === 200 && r.text.includes(path.endsWith('.txt') ? MARKER : 'MARKER.txt') && within(r.cost, { d1: 1, rr: 8, art: 0, do: 0, cache: 'hit' }), true);
  }
  for (const proto of [null, 'version=2']) {
    let r;
    for (let i = 0; i < 6; i++) {
      r = await http(null, `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, { headers: proto ? { 'Git-Protocol': proto } : {} });
      if (r.cost.cache === 'hit') break;
      await sleep(1000);
    }
    check(`warm: anonymous info/refs ${proto ?? 'v0'} cache hit (VAL-COST-002 cached advertisement) [${r.at}] ${r.header}`,
      r.status === 200 && within(r.cost, { d1: 1, rr: 8, rw: 0, art: 0, do: 0, sub: 0, cache: 'hit' }), true);
  }
  const shaRaw = `/${OWNER}/${FLIP}/raw/${sha}/MARKER.txt`;
  await http(null, shaRaw);
  const publicRaw = await http(null, shaRaw);
  check(`warm: anonymous public commit-SHA raw keeps public Cache-Control "${publicRaw.cacheControl}" ${publicRaw.header}`,
    publicRaw.status === 200 && (publicRaw.cacheControl ?? '').startsWith('public, max-age=31536000'), true);
  const patRaw = await http('outsider', shaRaw);
  check(`warm: PAT-authorized public raw is private-scoped "${patRaw.cacheControl}" ${patRaw.header}`,
    patRaw.status === 200 && patRaw.text.includes(MARKER) && privateScope(patRaw.cacheControl), true);
  for (const who of [null, 'outsider']) {
    const pack = await uploadPack(who, FLIP, sha);
    check(`warm: ${who ?? 'anonymous'} upload-pack returns the pack [${pack.at}] ${pack.header}`,
      pack.status === 200 && pack.text.includes('PACK') && within(pack.cost, { d1: 1, rr: 8, do: 0 }), true);
  }
  const anonClone = git(null, ['clone', '-q', `${BASE}/${OWNER}/${FLIP}.git`, join(work, 'anon-public')]);
  check('warm: anonymous git clone of the public repo', anonClone.code, 0);

  // ---- Rejected Bearer on warm public pages: anonymous outcome on one lookup ----
  console.log(`# ${stamp()} rejected-Bearer page fallback`);
  const pagePaths = [`/${OWNER}/${FLIP}`, `/${OWNER}/${FLIP}/raw/main/MARKER.txt`];
  const pageMark = (path) => (path.endsWith('.txt') ? MARKER : 'MARKER.txt');
  const hitBudget = { d1: 1, rr: 8, rw: 0, art: 0, do: 0, sub: 0, cache: 'hit' };
  const minted = mintScratchPats(2);
  check(`scratch owner PATs inserted directly in D1 ${minted.err}`, minted.code === 0 && minted.changes === 1, true);
  for (const who of ['scratch0', 'scratch1']) {
    const r = await http(who, `/api/v1/repos/${OWNER}/${FLIP}`);
    check(`fallback: ${who} warmed (REST metadata 200) ${r.header}`, r.status, 200);
  }
  for (const path of pagePaths) {
    const r = await http(null, path, bearerOnly(randomPat()));
    check(`fallback: unknown well-formed Bearer page ${path.slice(OWNER.length + FLIP.length + 2) || '/'} anonymous hit [${r.at}] ${r.header}`,
      r.status === 200 && r.text.includes(pageMark(path)) && within(r.cost, hitBudget), true);
  }
  const revoke = revokeScratchPats();
  check(`fallback: scratch PATs revoked by direct D1 DELETE (cached PAT copies retained) [${stamp()}] ${revoke.err}`,
    revoke.code === 0 && revoke.changes === 2, true);
  for (const path of pagePaths) {
    const r = await http('scratch0', path);
    check(`fallback: newly revoked warmed PAT page ${path.slice(OWNER.length + FLIP.length + 2) || '/'} anonymous hit [${r.at}] ${r.header}`,
      r.status === 200 && r.text.includes(pageMark(path)) && within(r.cost, hitBudget), true);
  }
  const revokedRest = await http('scratch0', `/api/v1/repos/${OWNER}/${FLIP}`);
  check(`fallback: revoked PAT REST metadata still 401 ${revokedRest.header}`,
    revokedRest.status === 401 && !revokedRest.text.includes(FLIP), true);
  const revokedGit = await http('scratch0', `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, { kind: 'basic' });
  check(`fallback: revoked PAT git info/refs still 401 ${revokedGit.header}`, revokedGit.status === 401 && !revokedGit.text.includes(sha), true);
  const unknownRest = await http(null, `/api/v1/repos/${OWNER}/${FLIP}`, bearerOnly(randomPat()));
  check(`fallback: unknown Bearer REST metadata 401 ${unknownRest.header}`,
    unknownRest.status === 401 && !unknownRest.text.includes(FLIP) && within(unknownRest.cost, deniedBudget), true);
  const unknownGit = await http(null, `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, basicOnly(randomPat()));
  check(`fallback: unknown basic git info/refs 401 ${unknownGit.header}`,
    unknownGit.status === 401 && !unknownGit.text.includes(sha) && within(unknownGit.cost, deniedBudget), true);

  // ---- Flip 1: direct D1 update, nothing purged ----
  const flip = d1Flip(FLIP, 'private');
  check(`flip 1: direct remote D1 UPDATE visibility=private (no Worker, no purge) [${stamp()}] ${flip.err}`, flip.code === 0 && flip.changes === 1, true);
  const t0 = Date.now();
  // A rejected Bearer, even the owner's own just-revoked PAT, is anonymous and sees nothing private.
  for (const [label, opts] of [['revoked owner PAT', {}], ['unknown Bearer', null]]) {
    for (const path of pagePaths) {
      const r = opts ? await http('scratch1', path, opts) : await http(null, path, bearerOnly(randomPat()));
      check(`flip 1: ${label} private page ${path.slice(OWNER.length + FLIP.length + 2) || '/'} concealed [${r.at}] ${r.header}`,
        r.status === 404 && !r.text.includes(MARKER) && !r.text.includes('MARKER.txt') && within(r.cost, { ...deniedBudget, cache: 'none' }), true);
    }
  }
  for (const who of [null, 'outsider']) await assertDenied('flip 1', who, sha);
  await assertOwnerReads('flip 1', sha);
  check('flip 1: all denials and owner reads ran inside the 60 s warm window', Date.now() - t0 < 60_000, true);

  // ---- Retention: the same edge entries come back once public again ----
  const back = await api('owner', 'PATCH', `/repos/${OWNER}/${FLIP}`, { visibility: 'public' });
  check(`owner PATCH back to public ${back.header}`, back.status, 200);
  const retained = await http(null, `/${OWNER}/${FLIP}/raw/main/MARKER.txt`);
  check(`retained raw page entry is a cache hit again once public (it survived the private window unserved) ${retained.header}`,
    retained.status === 200 && retained.cost.cache === 'hit', true);
  const retainedRefs = await http(null, `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`);
  check(`retained info/refs entry still present ${retainedRefs.header}`, retainedRefs.status, 200);

  // ---- Flip 2: the owner's documented PATCH ----
  const patch = await api('owner', 'PATCH', `/repos/${OWNER}/${FLIP}`, { visibility: 'private' });
  check(`flip 2: owner PATCH visibility=private [${patch.at}] ${patch.header}`, patch.status === 200 && JSON.parse(patch.text).repo?.visibility === 'private', true);
  for (const who of [null, 'outsider']) await assertDenied('flip 2', who, sha);
  await assertOwnerReads('flip 2', sha);

  // ---- Private content at a commit SHA on the flipped repo ----
  console.log(`# ${stamp()} private content cache`);
  await warmPrivateContent('flipped repo owner commit-SHA raw', 'owner', shaRaw, MARKER);
  for (const who of [null, 'outsider']) {
    assertContentDenied(`flipped repo ${who ?? 'anonymous'} commit-SHA raw`, await http(who, shaRaw), MARKER);
  }
  const refsScope = await http('owner', `/${OWNER}/${FLIP}.git/info/refs?service=git-upload-pack`, { kind: 'basic' });
  check(`private info/refs Cache-Control "${refsScope.cacheControl}"`, refsScope.status === 200 && privateScope(refsScope.cacheControl), true);
  const metaScope = await http('owner', `/api/v1/repos/${OWNER}/${FLIP}`);
  check(`private REST metadata Cache-Control "${metaScope.cacheControl}"`, metaScope.status === 200 && privateScope(metaScope.cacheControl), true);

  // ---- VAL-COST-002: warm authenticated public metadata ----
  for (const who of ['admin', 'owner']) {
    const first = await api(who, 'GET', `/repos/${OWNER}/${COST}`);
    const warm = await api(who, 'GET', `/repos/${OWNER}/${COST}`);
    check(`VAL-COST-002 ${who === 'admin' ? 'FORGE_PAT' : 'owner'} warm public metadata: first ${first.status} ${first.header} | warm`,
      `${warm.status} ${warm.header}`, () => first.status === 200 && warm.status === 200 && within(warm.cost, { d1: 1, rr: 8, rw: 0, do: 0 }));
  }

  // ---- VAL-COST-021: warm private personal content, then PAT revocation ----
  const PRIV_MARK = `avca-private-${ts}`;
  const privSeed = await seedMarker(OWNER, PRIV, 'PRIVATE.txt', PRIV_MARK);
  check('owner pushes private personal marker commit', privSeed.code, 0);
  const privRaw = `/${OWNER}/${PRIV}/raw/${privSeed.sha}/PRIVATE.txt`;
  await warmPrivateContent('VAL-COST-021 personal owner commit-SHA raw', 'owner', privRaw, PRIV_MARK);
  const privBlob = await http('owner', `/${OWNER}/${PRIV}/blob/${privSeed.sha}/PRIVATE.txt`);
  check(`VAL-COST-021 personal blob page reuses the immutable body "${privBlob.cacheControl}" ${privBlob.header}`,
    privBlob.status === 200 && privBlob.text.includes(PRIV_MARK) && privateScope(privBlob.cacheControl) && within(privBlob.cost, contentHitBudget), true);
  for (const who of [null, 'outsider']) {
    assertContentDenied(`personal ${who ?? 'anonymous'} commit-SHA raw`, await http(who, privRaw), PRIV_MARK);
  }
  const privMinted = mintScratchPats(1, 2);
  check(`scratch owner PAT for private content inserted directly in D1 ${privMinted.err}`, privMinted.code === 0 && privMinted.changes === 1, true);
  await warmPrivateContent('VAL-COST-021 personal scratch PAT commit-SHA raw', 'scratch2', privRaw, PRIV_MARK);
  const privRevoke = revokeScratchPats();
  check(`scratch PAT revoked by direct D1 DELETE [${stamp()}] ${privRevoke.err}`, privRevoke.code === 0 && privRevoke.changes === 1, true);
  assertContentDenied('VAL-COST-021 personal first read after PAT revocation', await http('scratch2', privRaw), PRIV_MARK);
  const privRetained = await http('owner', privRaw);
  check(`personal owner still hits the retained entry ${privRetained.header}`,
    privRetained.status === 200 && privRetained.text.includes(PRIV_MARK) && within(privRetained.cost, contentHitBudget), true);

  // ---- VAL-COST-021: warm private personal and org reads, then revoke ----
  await api('owner', 'GET', `/repos/${OWNER}/${PRIV}`);
  const privWarm = await api('owner', 'GET', `/repos/${OWNER}/${PRIV}`);
  check('VAL-COST-021 private personal warm read', `${privWarm.status} ${privWarm.header}`,
    () => privWarm.status === 200 && within(privWarm.cost, { d1: 2, rr: 8, do: 0, art: 0, sub: 0 }));

  check('create org', (await api('owner', 'POST', '/orgs', { login: ORG, name: 'visibility authority e2e' })).status, 201);
  check('add member', (await api('owner', 'PUT', `/orgs/${ORG}/members/${MEMBER}`, { role: 'member' })).status, 200);
  const mk = await api('owner', 'POST', `/orgs/${ORG}/repos`, { name: ORGREPO, visibility: 'private' });
  if (check('create private org repo', mk.status, 201)) created.push(`${ORG}/${ORGREPO}`);
  check('grant member read', (await api('owner', 'PUT', `/repos/${ORG}/${ORGREPO}/grants/${MEMBER}`, { role: 'read' })).status, 200);
  await api('member', 'GET', `/repos/${ORG}/${ORGREPO}`);
  const orgWarm = await api('member', 'GET', `/repos/${ORG}/${ORGREPO}`);
  check('VAL-COST-021 private org warm read (member with grant)', `${orgWarm.status} ${orgWarm.header}`,
    () => orgWarm.status === 200 && within(orgWarm.cost, { d1: 2, rr: 8, do: 0, art: 0, sub: 0 }));
  const ORG_MARK = `avca-org-private-${ts}`;
  const orgSeed = await seedMarker(ORG, ORGREPO, 'ORG.txt', ORG_MARK);
  check('org owner pushes private org marker commit', orgSeed.code, 0);
  const orgRaw = `/${ORG}/${ORGREPO}/raw/${orgSeed.sha}/ORG.txt`;
  await warmPrivateContent('VAL-COST-021 org member (read grant) commit-SHA raw', 'member', orgRaw, ORG_MARK);
  assertContentDenied('org outsider commit-SHA raw', await http('outsider', orgRaw), ORG_MARK);
  check('revoke member grant', (await api('owner', 'DELETE', `/repos/${ORG}/${ORGREPO}/grants/${MEMBER}`)).status, 200);
  assertContentDenied('VAL-COST-021 org member first content read after grant revoke', await http('member', orgRaw), ORG_MARK);
  const orgRetained = await http('owner', orgRaw);
  check(`org owner still hits the retained entry "${orgRetained.cacheControl}" ${orgRetained.header}`,
    orgRetained.status === 200 && orgRetained.text.includes(ORG_MARK) && privateScope(orgRetained.cacheControl) && within(orgRetained.cost, contentHitBudget), true);
  const revoked = await api('member', 'GET', `/repos/${ORG}/${ORGREPO}`);
  check('VAL-COST-021 first read after revoke denied without the warmed body', `${revoked.status} ${revoked.header}`,
    () => revoked.status === 404 && !revoked.text.includes(ORGREPO) && within(revoked.cost, deniedBudget));
} finally {
  const leftover = revokeScratchPats();
  if (leftover.changes) console.log(`# cleanup removed ${leftover.changes} scratch PAT rows`);
  if (!KEEP) {
    for (const repo of created) {
      const r = await api('owner', 'DELETE', `/repos/${repo}`);
      console.log(`# cleanup DELETE ${repo} -> ${r.status}`);
    }
  }
  rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
