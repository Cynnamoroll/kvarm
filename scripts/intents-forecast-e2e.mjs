#!/usr/bin/env node
/**
 * Live driver for Nexus intents, forecasts and active-workspace overlap
 * (nexus-intents-forecast): VAL-INTENT-001..007, VAL-FORECAST-001..005,
 * VAL-OVERLAP-001..004 and the overlap half of VAL-COST-015.
 *
 * Every section runs in a fresh public repo owned by KVARM_USER,
 * named `nexus-intents-forecast-<section>-<timestamp>`, seeded and changed
 * with real git pushes through the platform gate, and deleted afterwards
 * (unless --keep):
 *   intent        declare at creation, replace, invalid input (001), prefix
 *                 declaration vs nested edits (003), cumulative observed set
 *                 (004), net-zero edits (005), push outside the declaration (006)
 *   nonexclusive  three workspaces declaring/pushing the same path (002)
 *   forecast      declared/observed classes with evidence and freshness (001),
 *                 reconciliation after a push and a later push (004), read-only
 *                 and byte-identical (005), empty forecast leaves merges to
 *                 policy and branch rules (003)
 *   paging        limit + cursor to exhaustion vs a large limit, cap error (002)
 *   expire        abandon removes B from forecasts without collateral ref or
 *                 history loss, an idle active declaration stays, a ttl'd
 *                 declaration stops matching after expiry (007)
 *   overlap       pairs with shared paths, no non-overlapping or unpushed
 *                 workspace, base filter, abandon exclusion, second call art=0
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . ./.env.local; set +a
 *   node scripts/intents-forecast-e2e.mjs [--keep] [--only intent,forecast,...]
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper; commits use the configured git identity.
 * Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({
  options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } },
});
const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'nexus-intents-forecast';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = {};

function die(msg) {
  console.error(`intents-forecast-e2e: ${msg}`);
  process.exit(2);
}

function check(id, label, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCost(h) {
  const out = {};
  for (const part of (h ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k.trim()] = Number.isNaN(Number(v)) ? v : Number(v);
  }
  return out;
}

async function http(path, { method = 'GET', json, token = PAT, label } = {}) {
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
  const cost = res.headers.get('x-kvarm-cost');
  if (label) (costs[label] ??= []).push(cost);
  return { status: res.status, text, json: body, cost, c: parseCost(cost) };
}

const work = mkdtempSync(join(tmpdir(), 'intents-forecast-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd, token = PAT) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: token },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function mustGit(args, cwd, token) {
  const r = git(args, cwd, token);
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

/** Every advertised ref → sha. */
function lsRemoteAll(url, token = PAT) {
  const r = git(['ls-remote', url], work, token);
  const out = {};
  for (const line of r.out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha && ref) out[ref] = sha;
  }
  return out;
}

const repoPath = (repo) => `/api/v1/repos/${OWNER}/${repo}`;
const gitUrl = (repo) => `${BASE}/${OWNER}/${repo}.git`;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const SHA = /^[0-9a-f]{40}$/;

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
        check(purpose, `section ${purpose} ran to completion`, false, String(err?.stack ?? err).slice(0, 400));
      }
    },
  );
  if (!r.ok) check(purpose, 'fixture repo', false, r.reason);
  if (!opts.keep && r.created) {
    const gone = await http(repoPath(repo));
    check(purpose, 'scratch repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
  }
}

const BASE_FILES = { 'README.md': 'readme\n', 'src/app.ts': 'export const app = 1;\n', 'docs/guide.md': '# guide\n' };

function writeFiles(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    if (content === null) {
      rmSync(full, { force: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
}

/** A local clone-free repo with `main` pushed to the remote. */
async function seeded(repo, files = BASE_FILES) {
  const dir = join(work, repo);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  writeFiles(dir, files);
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', 'base'], dir);
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main']);
  return { dir, main: mustGit(['rev-parse', 'HEAD'], dir), url: gitUrl(repo), api: repoPath(repo) };
}

/** Commits `files` (null deletes) on top of `from` (detached) and returns the new sha. */
function commitOn(dir, from, files, msg) {
  mustGit(['checkout', '-q', '--detach', from], dir);
  writeFiles(dir, files);
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

/** git push <sha>:<ref>; returns {code, err, ok} where ok means the ref was updated. */
function pushTo(dir, url, sha, ref) {
  const r = git(['push', '--porcelain', url, `${sha}:${ref}`], dir);
  const okLine = r.out.split('\n').find((l) => l.includes(ref));
  return { ...r, ok: r.code === 0 && Boolean(okLine) && !okLine.startsWith('!'), line: okLine ?? '' };
}

async function createWs(api, body) {
  const r = await http(`${api}/workspaces`, { method: 'POST', json: body, label: body.intent ? 'POST workspaces (with intent)' : undefined });
  if (r.status !== 201) throw new Error(`create workspace -> ${r.status} ${r.text}`);
  return r.json;
}

/** Polls GET intent until the observed head equals `sha`; returns {view, seconds}. */
async function waitObserved(api, id, sha, timeoutMs = 60_000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await http(`${api}/workspaces/${id}/intent`, { label: 'GET workspaces/:id/intent' });
    if (last.json?.headSha === sha) return { view: last.json, seconds: (Date.now() - t0) / 1000 };
    await sleep(1500);
  }
  return { view: last?.json ?? null, seconds: null };
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------

await scenario('intent', async (repo) => {
  const { dir, main, url, api } = await seeded(repo);

  // VAL-INTENT-001
  const a = await createWs(api, { task: 'intent create', agent: 'nexus-a', intent: { paths: ['src/', 'docs/guide.md'] } });
  const g1 = await http(`${api}/workspaces/${a.id}/intent`, { label: 'GET workspaces/:id/intent' });
  console.log(`GET intent -> ${g1.status} ${g1.text} (x-kvarm-cost ${g1.cost})`);
  check(
    'VAL-INTENT-001',
    'creation intent round-trips through GET intent (normalized, sorted) with observed base/head and truncation fields',
    g1.status === 200 &&
      eq(g1.json.declaredPaths, ['docs/guide.md', 'src/']) &&
      eq(g1.json.observedPaths, []) &&
      g1.json.baseSha === main &&
      g1.json.headSha === main &&
      g1.json.observedTruncated === false &&
      a.declaredPaths !== undefined,
    `declared=${JSON.stringify(g1.json?.declaredPaths)} baseSha=${g1.json?.baseSha?.slice(0, 8)} headSha=${g1.json?.headSha?.slice(0, 8)}`,
  );
  const up = await http(`${api}/workspaces/${a.id}/intent`, { method: 'POST', json: { paths: ['lib/'] }, label: 'POST workspaces/:id/intent' });
  console.log(`POST intent {paths:[lib/]} -> ${up.status} (x-kvarm-cost ${up.cost})`);
  const g2 = await http(`${api}/workspaces/${a.id}/intent`);
  check('VAL-INTENT-001', 'POST intent replaces the declaration (no merge with the previous one)', up.status === 200 && eq(g2.json?.declaredPaths, ['lib/']), JSON.stringify(g2.json?.declaredPaths));
  for (const bad of [{ paths: ['/etc/passwd'] }, { paths: ['src/../secret'] }, { paths: [] }]) {
    const r = await http(`${api}/workspaces/${a.id}/intent`, { method: 'POST', json: bad });
    const after = await http(`${api}/workspaces/${a.id}/intent`);
    check(
      'VAL-INTENT-001',
      `invalid ${JSON.stringify(bad.paths)} → 422 {error, code} and the declaration is unchanged`,
      r.status === 422 && r.json?.code === 'INVALID_INTENT' && typeof r.json?.error === 'string' && eq(after.json?.declaredPaths, ['lib/']),
      `${r.status} ${r.text}`,
    );
  }
  const badCreate = await http(`${api}/workspaces`, { method: 'POST', json: { task: 'bad', intent: { paths: ['../x'] } } });
  check('VAL-INTENT-001', 'creation with an invalid intent → 422 INVALID_INTENT', badCreate.status === 422 && badCreate.json?.code === 'INVALID_INTENT', `${badCreate.status} ${badCreate.json?.code}`);

  // VAL-INTENT-003
  const p = await createWs(api, { task: 'prefix', agent: 'nexus-p', intent: { paths: ['src/'] } });
  const p0 = (await http(`${api}/workspaces/${p.id}/intent`)).json;
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/deep/nested/f${i}.ts`, `export const f${i} = ${i};\n`]));
  files['src/deep/nested/file.ts'] = 'export const nested = true;\n';
  const pc = commitOn(dir, main, files, 'nested edits');
  const pp = pushTo(dir, url, pc, p.ref);
  console.log(`git push ${pc.slice(0, 8)}:${p.ref} -> exit ${pp.code} ${pp.line}`);
  const pw = await waitObserved(api, p.id, pc);
  const pv = pw.view ?? {};
  const pm = pv.matches?.find((m) => m.declared === 'src/');
  console.log(`GET intent after push (${pw.seconds}s): declared=${JSON.stringify(pv.declaredPaths)} index=${JSON.stringify(pv.index)} matches[src/]=${pm?.observed?.length} observed`);
  check(
    'VAL-INTENT-003',
    'prefix `src/` stays one declared index row before and after 13 nested edits, and matches src/deep/nested/file.ts',
    pp.ok &&
      eq(pv.declaredPaths, ['src/']) &&
      p0.index?.declared === 1 &&
      pv.index?.declared === 1 &&
      pm?.observed.includes('src/deep/nested/file.ts') &&
      eq(pv.outsideDeclaration, []),
    `index before=${JSON.stringify(p0.index)} after=${JSON.stringify(pv.index)}`,
  );

  // VAL-INTENT-004
  const c = await createWs(api, { task: 'cumulative', agent: 'nexus-c' });
  const c1 = commitOn(dir, main, { 'a.txt': 'a\n' }, 'C1 a.txt');
  pushTo(dir, url, c1, c.ref);
  await waitObserved(api, c.id, c1);
  const c2 = commitOn(dir, c1, { 'b.txt': 'b\n' }, 'C2 b.txt');
  pushTo(dir, url, c2, c.ref);
  const cw = (await waitObserved(api, c.id, c2)).view ?? {};
  console.log(`C1=${c1} C2=${c2} observedPaths=${JSON.stringify(cw.observedPaths)} headSha=${cw.headSha}`);
  check('VAL-INTENT-004', 'observedPaths is the cumulative base→head set {a.txt, b.txt} with headSha == C2', eq(cw.observedPaths, ['a.txt', 'b.txt']) && cw.headSha === c2 && cw.baseSha === main);

  // VAL-INTENT-005
  const n = await createWs(api, { task: 'net zero', agent: 'nexus-n' });
  const n1 = commitOn(dir, main, { 'tmp.txt': 'tmp\n', 'keep.txt': 'keep\n' }, 'add tmp + keep');
  pushTo(dir, url, n1, n.ref);
  const nw1 = (await waitObserved(api, n.id, n1)).view ?? {};
  const n2 = commitOn(dir, n1, { 'tmp.txt': null }, 'delete tmp');
  pushTo(dir, url, n2, n.ref);
  const nw2 = (await waitObserved(api, n.id, n2)).view ?? {};
  console.log(`after add: ${JSON.stringify(nw1.observedPaths)}; after delete: ${JSON.stringify(nw2.observedPaths)} headSha=${nw2.headSha}`);
  check('VAL-INTENT-005', 'tmp.txt (added then deleted) leaves the observed set; keep.txt stays; headSha == C2', eq(nw1.observedPaths, ['keep.txt', 'tmp.txt']) && eq(nw2.observedPaths, ['keep.txt']) && nw2.headSha === n2);

  // VAL-INTENT-006
  const d = await createWs(api, { task: 'docs only', agent: 'nexus-d', intent: { paths: ['docs/'] } });
  const d1 = commitOn(dir, main, { 'src/billing.ts': 'export const bill = 1;\n' }, 'billing outside declaration');
  const dp = pushTo(dir, url, d1, d.ref);
  console.log(`git push (outside declaration) -> exit ${dp.code} ${dp.line}`);
  const dv = (await waitObserved(api, d.id, d1)).view ?? {};
  console.log(`GET intent: declared=${JSON.stringify(dv.declaredPaths)} observed=${JSON.stringify(dv.observedPaths)} outsideDeclaration=${JSON.stringify(dv.outsideDeclaration)} advisory=${dv.advisory}`);
  check(
    'VAL-INTENT-006',
    'push outside `docs/` accepted; src/billing.ts observed and listed in outsideDeclaration (advisory)',
    dp.ok && lsRemoteAll(url)[d.ref] === d1 && eq(dv.observedPaths, ['src/billing.ts']) && eq(dv.outsideDeclaration, ['src/billing.ts']) && dv.advisory === true && eq(dv.declaredPaths, ['docs/']),
  );
});

await scenario('nonexclusive', async (repo) => {
  const { dir, main, url, api } = await seeded(repo);
  const made = [];
  for (const [name, intent] of [['A', { paths: ['src/'] }], ['B', { paths: ['src/'] }], ['C', undefined]]) {
    const r = await http(`${api}/workspaces`, { method: 'POST', json: { task: `share ${name}`, agent: `nexus-${name}`, ...(intent ? { intent } : {}) } });
    console.log(`POST workspaces ${name} -> ${r.status} declaredPaths=${JSON.stringify(r.json?.declaredPaths)}`);
    made.push({ name, status: r.status, ws: r.json });
  }
  check('VAL-INTENT-002', 'all three creations succeed (overlapping declarations coexist)', made.every((m) => m.status === 201));
  const shas = {};
  for (const m of made) {
    const sha = commitOn(dir, main, { 'src/a.ts': `export const by = '${m.name}';\n` }, `edit src/a.ts as ${m.name}`);
    const r = pushTo(dir, url, sha, m.ws.ref);
    console.log(`push ${m.name} -> exit ${r.code} ${r.line}`);
    shas[m.name] = sha;
    check('VAL-INTENT-002', `push by ${m.name} to src/a.ts accepted`, r.ok, r.line || r.err);
  }
  const refs = lsRemoteAll(url);
  check('VAL-INTENT-002', 'every workspace ref advanced to its own commit', made.every((m) => refs[m.ws.ref] === shas[m.name]));
  for (const m of made) {
    const v = (await waitObserved(api, m.ws.id, shas[m.name])).view ?? {};
    const raw = JSON.stringify(v);
    check(
      'VAL-INTENT-002',
      `${m.name}: independent declaration, status active, no lock/claim field`,
      eq(v.declaredPaths, m.name === 'C' ? [] : ['src/']) && v.status === 'active' && eq(v.observedPaths, ['src/a.ts']) && !/lock|claim|blocked/i.test(raw),
      `declared=${JSON.stringify(v.declaredPaths)} observed=${JSON.stringify(v.observedPaths)}`,
    );
  }
});

await scenario('forecast', async (repo) => {
  const { dir, main, url, api } = await seeded(repo);

  // VAL-FORECAST-001
  const a = await createWs(api, { task: 'declared src', agent: 'nexus-a', intent: { paths: ['src/'] } });
  const b = await createWs(api, { task: 'observed src/b.ts', agent: 'nexus-b' });
  const b1 = commitOn(dir, main, { 'src/b.ts': 'export const b = 1;\n' }, 'add src/b.ts');
  pushTo(dir, url, b1, b.ref);
  await waitObserved(api, b.id, b1);
  const f1 = await http(`${api}/forecast?paths=src/b.ts&base=main`, { label: 'GET forecast' });
  console.log(`GET forecast?paths=src/b.ts&base=main -> ${f1.status} ${f1.text} (x-kvarm-cost ${f1.cost})`);
  const ma = f1.json?.matches?.find((m) => m.workspace === a.id);
  const mb = f1.json?.matches?.find((m) => m.workspace === b.id);
  const refs1 = lsRemoteAll(url);
  check(
    'VAL-FORECAST-001',
    'A matches as declared with `src/` evidence; B as observed with src/b.ts; each with revision and ISO/sha freshness',
    f1.status === 200 &&
      ma?.matchKind === 'declared' &&
      ma.evidence.some((e) => e.kind === 'declared' && e.path === 'src/' && e.query === 'src/b.ts') &&
      ISO.test(ma.declaredAt) &&
      ma.revision === refs1[a.ref] &&
      mb?.matchKind === 'observed' &&
      mb.evidence.some((e) => e.kind === 'observed' && e.path === 'src/b.ts') &&
      mb.revision === refs1[b.ref] &&
      SHA.test(mb.observedHeadSha) &&
      ISO.test(mb.observedAt),
    `A rev=${ma?.revision?.slice(0, 8)} (ls-remote ${refs1[a.ref]?.slice(0, 8)}), B rev=${mb?.revision?.slice(0, 8)} (ls-remote ${refs1[b.ref]?.slice(0, 8)})`,
  );

  // VAL-FORECAST-004
  const cWs = await createWs(api, { task: 'feature', agent: 'nexus-c' });
  const dWs = await createWs(api, { task: 'declares src', agent: 'nexus-d', intent: { paths: ['src/'] } });
  const c1 = commitOn(dir, main, { 'src/feature/new.ts': 'export const v = 1;\n' }, 'add feature');
  const cp = pushTo(dir, url, c1, cWs.ref);
  console.log(`git push src/feature/new.ts -> ${cp.line}`);
  const q = `${api}/forecast?paths=src/feature/new.ts&base=main`;
  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < 60_000) {
    const r = await http(q);
    const m = r.json?.matches?.find((x) => x.workspace === cWs.id);
    if (m?.matchKind === 'observed' && m.observedHeadSha === c1) {
      seen = r;
      break;
    }
    await sleep(1500);
  }
  const lag = (Date.now() - t0) / 1000;
  const md = seen?.json?.matches?.find((x) => x.workspace === dWs.id);
  check('VAL-FORECAST-004', `C appears as observed with observedHeadSha == pushed sha within 60 s (${lag}s)`, seen !== null);
  check('VAL-FORECAST-004', 'D (declared src/) appears for the same query as declared', md?.matchKind === 'declared');
  const r1 = await http(q);
  const r2 = await http(q);
  check('VAL-FORECAST-004', 'two identical calls return the same match set and order', r1.text === r2.text && r1.json.matches.length >= 2, `${r1.json?.matches?.map((m) => m.workspace).join(',')}`);
  const c2 = commitOn(dir, c1, { 'src/feature/new.ts': 'export const v = 2;\n' }, 'feature v2');
  pushTo(dir, url, c2, cWs.ref);
  const t1 = Date.now();
  let advanced = null;
  while (Date.now() - t1 < 60_000) {
    const r = await http(q);
    const m = r.json?.matches?.find((x) => x.workspace === cWs.id);
    if (m?.observedHeadSha === c2) {
      advanced = m;
      break;
    }
    await sleep(1500);
  }
  check('VAL-FORECAST-004', `a later push advances C's revision to the new head (${(Date.now() - t1) / 1000}s)`, advanced?.revision === c2, `${c1.slice(0, 8)} → ${advanced?.revision?.slice(0, 8)}`);

  // VAL-FORECAST-005
  const snap = async () => ({
    refs: lsRemoteAll(url),
    changes: (await http(`${api}/changes?state=all`)).text,
    workspaces: (await http(`${api}/workspaces`)).text,
  });
  const before = await snap();
  const q5 = `${api}/forecast?paths=src/b.ts,docs/guide.md&base=main`;
  const x1 = await http(q5);
  const x2 = await http(q5);
  const after = await snap();
  console.log(`forecast twice: ${x1.status}/${x2.status}, ${x1.json?.matches?.length} matches, identical=${x1.text === x2.text}`);
  check('VAL-FORECAST-005', 'two forecasts are byte-identical (order, evidence, freshness)', x1.status === 200 && x1.text === x2.text);
  check('VAL-FORECAST-005', 'refs, change list and workspace list unchanged by the forecasts', eq(before, after));

  // VAL-FORECAST-003
  const e = await http(`${api}/forecast?paths=never/touched.txt&base=main`);
  console.log(`empty forecast -> ${e.status} ${e.text}`);
  check(
    'VAL-FORECAST-003',
    'empty forecast: 200, matches [], truncated false, advisory marker with note',
    e.status === 200 && eq(e.json?.matches, []) && e.json?.truncated === false && e.json?.advisory === true && /not proof/.test(e.json?.advisoryNote ?? ''),
  );
  mustGit(['checkout', '-q', '--detach', main], dir);
  const x = commitOn(dir, main, { 'never/touched.txt': 'x\n' }, 'touch never');
  await pushRetry(dir, url, [`${x}:refs/heads/feat-x`]);
  const ch1 = await http(`${api}/changes`, { method: 'POST', json: { title: 'touch never', base: 'main', head: 'feat-x', mergePolicy: 'auto' } });
  console.log(`POST changes (auto, no required checks) -> ${ch1.status} state=${ch1.json?.state}`);
  check('VAL-FORECAST-003', 'auto change on that path merges (nothing in the forecast blocks it)', ch1.status === 201 && ch1.json?.state === 'merged');
  const y = commitOn(
    dir,
    x,
    {
      'never/touched.txt': 'y\n',
      '.kvarm/ci.json': `${JSON.stringify({ jobs: [{ name: 'forecast-fail', run: 'exit 1', required: true }] })}\n`,
    },
    'touch never again',
  );
  await pushRetry(dir, url, [`${y}:refs/heads/feat-y`]);
  const ch2 = await http(`${api}/changes`, { method: 'POST', json: { title: 'touch never again', base: 'main', head: 'feat-y', mergePolicy: 'auto' } });
  const runner = spawnSync(process.execPath, ['apps/cli/bin/kvarm.js', 'runner', '--repo', `${OWNER}/${repo}`, '--once'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, KVARM_BASE_URL: BASE, KVARM_PAT: PAT },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const mg = await http(`${api}/changes/${ch2.json?.number}/merge`, { method: 'POST' });
  console.log(`POST changes -> ${ch2.status} state=${ch2.json?.state}; runner -> ${runner.status} ${runner.stdout.trim()}; merge -> ${mg.status} ${mg.json?.code}`);
  check(
    'VAL-FORECAST-003',
    'with a failing required CI check the change stays open and merge is REQUIRED_CHECKS_FAILED (the forecast approves nothing)',
    ch2.json?.state === 'open' && runner.status === 0 && mg.status === 409 && mg.json?.code === 'REQUIRED_CHECKS_FAILED' && /forecast-fail/.test(mg.json?.error ?? ''),
  );
});

await scenario('paging', async (repo) => {
  const { api } = await seeded(repo);
  const ids = [];
  for (let i = 0; i < 7; i++) ids.push((await createWs(api, { task: `page ${i}`, agent: `nexus-${i}`, intent: { paths: [i % 2 ? 'lib/' : 'lib/x.ts'] } })).id);
  const all = await http(`${api}/forecast?paths=lib/x.ts&limit=100`);
  const full = all.json?.matches?.map((m) => m.workspace) ?? [];
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const r = await http(`${api}/forecast?paths=lib/x.ts&limit=3${cursor ? `&cursor=${cursor}` : ''}`, { label: 'GET forecast' });
    pages.push(r.json);
    console.log(`page ${i}: ${r.json?.matches?.map((m) => m.workspace).join(',')} truncated=${r.json?.truncated} nextCursor=${r.json?.nextCursor} (x-kvarm-cost ${r.cost})`);
    cursor = r.json?.nextCursor;
    if (!cursor) break;
  }
  const union = pages.flatMap((p) => p.matches.map((m) => m.workspace));
  check('VAL-FORECAST-002', 'limit=100 returns all 7 workspaces, truncated false', full.length === 7 && all.json.truncated === false && eq([...full].sort(), [...ids].sort()));
  check(
    'VAL-FORECAST-002',
    'small pages are explicitly truncated with a reason and cursor; the last page is not',
    pages.length === 3 &&
      pages.slice(0, -1).every((p) => p.truncated === true && typeof p.truncatedReason === 'string' && p.nextCursor && p.matches.length === 3) &&
      pages.at(-1).truncated === false &&
      pages.at(-1).nextCursor === null,
  );
  check('VAL-FORECAST-002', 'union of pages == the large-limit set, no duplicates', eq(union, full) && new Set(union).size === union.length, `${union.length} vs ${full.length}`);
  const over = await http(`${api}/forecast?paths=${Array.from({ length: 21 }, (_, i) => `p${i}.ts`).join(',')}`);
  console.log(`21 paths -> ${over.status} ${over.text}`);
  check('VAL-FORECAST-002', 'over-cap paths (21 > 20) → 422 TOO_MANY_PATHS with the limit', over.status === 422 && over.json?.code === 'TOO_MANY_PATHS' && over.json?.limit === 20);
  const badLimit = await http(`${api}/forecast?paths=a.ts&limit=101`);
  check('VAL-FORECAST-002', 'over-cap limit → 400 INVALID_LIMIT', badLimit.status === 400 && badLimit.json?.code === 'INVALID_LIMIT');
});

await scenario('expire', async (repo) => {
  const { dir, main, url, api } = await seeded(repo);
  const b = await createWs(api, { task: 'to abandon', agent: 'nexus-b' });
  const idle = await createWs(api, { task: 'idle declared', agent: 'nexus-idle', intent: { paths: ['src/'] } });
  const ttl = await createWs(api, { task: 'ttl', agent: 'nexus-ttl', intent: { paths: ['ttl/'], ttlSeconds: 60 } });
  const ttlAt = Date.now();
  const b1 = commitOn(dir, main, { 'src/gone.ts': 'export const gone = 1;\n' }, 'B work');
  pushTo(dir, url, b1, b.ref);
  await pushRetry(dir, url, [`${b1}:refs/heads/keep-b`]);
  await waitObserved(api, b.id, b1);
  const cs = await http(`${api}/workspaces/${b.id}/change-set`, { method: 'POST', json: { title: 'B change' } });
  const fq = `${api}/forecast?paths=src/gone.ts&base=main`;
  const f0 = await http(fq);
  const ws0 = f0.json?.matches?.map((m) => `${m.workspace}:${m.matchKind}`);
  console.log(`change-set -> ${cs.status} #${cs.json?.number}; forecast before abandon: ${JSON.stringify(ws0)}`);
  check('VAL-INTENT-007', 'before abandon B matches (observed) and the idle workspace matches (declared)', ws0?.includes(`${b.id}:observed`) && ws0?.includes(`${idle.id}:declared`));
  const refsBefore = lsRemoteAll(url);
  const ab = await http(`${api}/workspaces/${b.id}/abandon`, { method: 'POST' });
  const f1 = await http(fq);
  const ws1 = f1.json?.matches?.map((m) => m.workspace);
  const refsAfter = lsRemoteAll(url);
  const gotB = await http(`${api}/workspaces/${b.id}`);
  const intentB = await http(`${api}/workspaces/${b.id}/intent`);
  const removed = Object.keys(refsBefore).filter((r) => !(r in refsAfter));
  console.log(`abandon -> ${ab.status}; forecast after: ${JSON.stringify(ws1)}; removed refs: ${JSON.stringify(removed)}; B status=${gotB.json?.status}`);
  check('VAL-INTENT-007', 'after abandon B is absent from the forecast; the idle active workspace still matches', ab.status === 200 && !ws1?.includes(b.id) && ws1?.includes(idle.id));
  check('VAL-INTENT-007', 'B record readable with status abandoned, its observed history kept', gotB.json?.status === 'abandoned' && eq(intentB.json?.observedPaths, ['src/gone.ts']) && eq(intentB.json?.index, { declared: 0, observed: 0 }));
  check('VAL-INTENT-007', "only B's own ref was removed; B's commit stays reachable on keep-b", eq(removed, [b.ref]) && refsAfter['refs/heads/keep-b'] === b1 && refsAfter['refs/heads/main'] === main);
  const chg = await http(`${api}/changes/${cs.json?.number}`);
  check('VAL-INTENT-007', "the change set opened earlier keeps B's head commit", chg.json?.headSha === b1, `state=${chg.json?.state} headSha=${chg.json?.headSha?.slice(0, 8)}`);

  const wait = ttlAt + 62_000 - Date.now();
  if (wait > 0) {
    console.log(`waiting ${Math.ceil(wait / 1000)} s for the 60 s ttl declaration to expire`);
    await sleep(wait);
  }
  const ft = await http(`${api}/forecast?paths=ttl/x.ts`);
  const it = await http(`${api}/workspaces/${ttl.id}/intent`);
  const fi = await http(fq);
  console.log(`after ttl: forecast ttl/x.ts -> ${JSON.stringify(ft.json?.matches?.map((m) => m.workspace))}; intent declaredExpired=${it.json?.declaredExpired} declaredPaths=${JSON.stringify(it.json?.declaredPaths)}`);
  check(
    'VAL-INTENT-007',
    'an expired declaration stops matching but stays readable on the still-active workspace; the idle (no ttl) declaration still matches',
    eq(ft.json?.matches, []) && it.json?.declaredExpired === true && eq(it.json?.declaredPaths, ['ttl/']) && it.json?.status === 'active' && fi.json?.matches?.some((m) => m.workspace === idle.id),
  );
});

await scenario('overlap', async (repo) => {
  const { dir, main, url, api } = await seeded(repo);
  await pushRetry(dir, url, [`${main}:refs/heads/dev`]);
  const A = await createWs(api, { task: 'A app', agent: 'nexus-a' });
  const B = await createWs(api, { task: 'B app', agent: 'nexus-b' });
  const C = await createWs(api, { task: 'C docs', agent: 'nexus-c' });
  const D = await createWs(api, { task: 'D idle', agent: 'nexus-d' });
  const E = await createWs(api, { task: 'E app on dev', agent: 'nexus-e', base: 'dev' });
  const pushes = [
    [A, { 'src/app.ts': 'export const app = "A";\n', 'src/a-only.ts': 'a\n' }],
    [B, { 'src/app.ts': 'export const app = "B";\n' }],
    [C, { 'docs/guide.md': '# guide C\n' }],
    [E, { 'src/app.ts': 'export const app = "E";\n' }],
  ];
  for (const [ws, files] of pushes) {
    const sha = commitOn(dir, main, files, `${ws.task}`);
    const r = pushTo(dir, url, sha, ws.ref);
    if (!r.ok) throw new Error(`push ${ws.task}: ${r.err}`);
    await waitObserved(api, ws.id, sha);
  }
  const refs = lsRemoteAll(url);
  console.log(`git ls-remote: D ${D.ref} = ${refs[D.ref]} (main ${refs['refs/heads/main']})`);
  const o1 = await http(`${api}/workspaces/overlap?base=main`, { label: 'GET workspaces/overlap' });
  const o2 = await http(`${api}/workspaces/overlap?base=main`, { label: 'GET workspaces/overlap' });
  console.log(`GET workspaces/overlap?base=main -> ${o1.status} ${o1.text}\n  x-kvarm-cost #1 ${o1.cost}\n  x-kvarm-cost #2 ${o2.cost}`);
  const pairs = o1.json?.pairs ?? [];
  const ab = pairs.find((p) => eq([...p.workspaces].sort(), [A.id, B.id].sort()));
  const inAny = (id) => pairs.some((p) => p.workspaces.includes(id));
  check('VAL-OVERLAP-001', '(A,B) pair present and names src/app.ts', o1.status === 200 && ab?.paths.includes('src/app.ts') && !ab.paths.includes('src/a-only.ts'), JSON.stringify(ab?.paths));
  check('VAL-OVERLAP-002', 'C is in no pair; no pair has zero shared paths', !inAny(C.id) && pairs.every((p) => p.paths.length > 0 && p.pathCount > 0));
  check('VAL-OVERLAP-004', 'D (ref at the base head, no changes) is in no pair', refs[D.ref] === main && !inAny(D.id));
  check('VAL-OVERLAP-004', 'E (same path, base dev) is not paired against main workspaces', !inAny(E.id) && pairs.length === 1);
  const od = await http(`${api}/workspaces/overlap?base=dev`);
  check('VAL-OVERLAP-004', 'overlap?base=dev has no pairs (E alone on dev)', od.status === 200 && od.json?.base === 'dev' && eq(od.json?.pairs, []));
  check('VAL-COST-015', 'overlap: both calls art=0, d1 ≤ 2, do=0 (served from the index, no tree reads)', o1.c.art === 0 && o2.c.art === 0 && o2.c.d1 <= 2 && o2.c.do === 0, `${o1.cost} | ${o2.cost}`);
  const aband = await http(`${api}/workspaces/${A.id}/abandon`, { method: 'POST' });
  const o3 = await http(`${api}/workspaces/overlap?base=main`);
  console.log(`abandon A -> ${aband.status}; overlap after: ${o3.text}`);
  check('VAL-OVERLAP-003', 'after abandoning A no pair contains A', aband.status === 200 && !(o3.json?.pairs ?? []).some((p) => p.workspaces.includes(A.id)));
});

rmSync(work, { recursive: true, force: true });
console.log('\n# cost headers by endpoint');
for (const [k, v] of Object.entries(costs)) console.log(`${k}: ${[...new Set(v)].slice(0, 4).join(' | ')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
