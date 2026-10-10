#!/usr/bin/env node
/**
 * Live driver for Nexus pinned dependencies (nexus-dependencies) against the
 * deployed Worker: VAL-DEP-001..009, VAL-COST-026, VAL-CLI-001/002/003/005
 * and VAL-CROSS-008.
 *
 * Every scenario runs in fresh public repos owned by FORGE_USER, named
 * `nexus-deps-<purpose>-<timestamp>`, seeded with real git pushes and deleted
 * afterwards (unless --keep).
 *   pins      explicit exact pins, same-repo only, depth cap 4 with detach +
 *             re-create, 2- and 3-node cycles with their path, bogus revisions,
 *             cross-repo refusal, and the work counters against a repo with many
 *             unrelated workspaces (VAL-DEP-001..004, VAL-COST-026)
 *   stale     a source push stales the pin without rewriting it, publication
 *             refused, explicit validated repin and detach; abandonment breaks
 *             the pin and leaves the dependent intact (VAL-DEP-005, -006, -008)
 *   satisfy   preserved revision → satisfied → the dependent merges; a source
 *             force-moved before landing → never satisfied (VAL-DEP-007)
 *   train     enqueue B (pinned to A), then A, then unrelated C: B waits with a
 *             machine-readable reason on GET train, C is not blocked, A lands
 *             before B (VAL-DEP-009)
 *   cli       broken pin recovered through `forge deps list/repin` and a
 *             `forge deps detach`, CLI output equal to REST read-backs, the four
 *             CLI failure classes without a TTY, CLI vs REST state for intent,
 *             pin and task claim, `forge status --json` twice with no mutation,
 *             and `forge --help` vs the registry of record (VAL-CROSS-008,
 *             VAL-CLI-001/002/003/005)
 *
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/dependencies-e2e.mjs [--keep] [--only pins,stale,...] [--api-doc <library/api.md>]
 * Tokens are read by NAME and never printed. Git runs with
 * `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a secret-free
 * GIT_ASKPASS helper; CLI runs get stdin closed. Exit 0 only when every
 * check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { OPERATIONS } from '@forge/ops';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, only: { type: 'string' }, 'api-doc': { type: 'string' } } });
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
const PAT = process.env.FORGE_PAT ?? die('FORGE_PAT is not set');
const BOT = process.env.FORGE_PAT_BOT ?? '';
const CLI_BIN = fileURLToPath(new URL('../apps/cli/bin/forge.js', import.meta.url));
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'nexus-deps';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

function die(msg) {
  console.error(`dependencies-e2e: ${msg}`);
  process.exit(2);
}

function check(id, label, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (sha) => (sha ? sha.slice(0, 10) : String(sha));

function parseCost(h) {
  const out = {};
  for (const part of (h ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = /^\d+$/.test(v ?? '') ? Number(v) : v;
  }
  return out;
}

async function http(path, { method = 'GET', json, token = PAT } = {}) {
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
  return { status: res.status, text, json: body, cost: res.headers.get('x-forge-cost') };
}

function cost(label, r) {
  costs.push({ label, status: r.status, cost: r.cost });
  return r.cost ?? 'no cost header';
}

// --- git -----------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'dependencies-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: PAT };

function git(args, cwd) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function mustGit(args, cwd) {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
  return r.out;
}

async function pushRetry(dir, url, refspecs) {
  let last = '';
  for (let i = 0; i < 8; i++) {
    const r = git(['push', '-q', url, ...refspecs], dir);
    if (r.code === 0) return;
    last = r.err;
    await sleep(3000);
  }
  throw new Error(`push ${refspecs.join(' ')} kept failing: ${last}`);
}

function writeFiles(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitOn(dir, from, files, msg) {
  mustGit(['checkout', '-q', '--detach', from], dir);
  writeFiles(dir, files);
  mustGit(['add', '-A'], dir);
  mustGit(['-c', 'user.name=deps-e2e', '-c', 'user.email=deps-e2e@forge.invalid', 'commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

const repoPath = (repo) => `/api/v1/repos/${OWNER}/${repo}`;
const gitUrl = (repo) => `${BASE}/${OWNER}/${repo}.git`;

function lsRemote(repo) {
  const r = git(['ls-remote', gitUrl(repo)], work);
  return Object.fromEntries(
    r.out
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t').reverse()),
  );
}

async function seed(repo) {
  const dir = join(work, repo);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  writeFiles(dir, { 'README.md': `# ${repo}\n` });
  mustGit(['add', '-A'], dir);
  mustGit(['-c', 'user.name=deps-e2e', '-c', 'user.email=deps-e2e@forge.invalid', 'commit', '-q', '-m', 'base'], dir);
  const main = mustGit(['rev-parse', 'HEAD'], dir);
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main']);
  return { repo, dir, main, api: repoPath(repo), full: `${OWNER}/${repo}` };
}

/** Polls until GET workspace reports head `sha` (the push may take a moment to be visible). */
async function recorded(env, id, sha) {
  for (let i = 0; i < 40; i++) {
    const w = await http(`${env.api}/workspaces/${id}`);
    if (w.json?.headSha === sha) return true;
    await sleep(1500);
  }
  return false;
}

/** A workspace with one commit adding `file`, optionally with a review change set. */
async function workspace(env, name, { change = false, files } = {}) {
  const made = await http(`${env.api}/workspaces`, { method: 'POST', json: { task: `deps e2e ${name}`, agent: `agent-${name}` } });
  if (made.status !== 201) throw new Error(`create workspace ${name}: ${made.status} ${made.text.slice(0, 200)}`);
  const w = made.json;
  // The workspace ref starts at the base head, which moves as changes land.
  if (git(['cat-file', '-e', `${w.baseSha}^{commit}`], env.dir).code !== 0) {
    mustGit(['fetch', '-q', gitUrl(env.repo), '+refs/heads/main:refs/remotes/origin/main'], env.dir);
  }
  const head = commitOn(env.dir, w.baseSha, files ?? { [`${name}.txt`]: `${name}\n` }, `${name} work`);
  await pushRetry(env.dir, gitUrl(env.repo), [`${head}:${w.ref}`]);
  await recorded(env, w.id, head);
  let number = null;
  if (change) {
    const cs = await http(`${env.api}/workspaces/${w.id}/change-set`, { method: 'POST', json: { title: `${name} change`, mergePolicy: 'review' } });
    if (cs.status !== 201) throw new Error(`change set ${name}: ${cs.status} ${cs.text.slice(0, 200)}`);
    number = cs.json.number;
  }
  return { id: w.id, ref: w.ref, head, number, name, base: w.baseSha };
}

async function pushTo(env, ws, files, msg, force = false, from = ws.head) {
  const sha = commitOn(env.dir, from, files, msg);
  await pushRetry(env.dir, gitUrl(env.repo), [`${force ? '+' : ''}${sha}:${ws.ref}`]);
  await recorded(env, ws.id, sha);
  return sha;
}

const pin = (env, from, on, revision) => http(`${env.api}/workspaces/${from}/dependencies`, { method: 'POST', json: { onWorkspace: on, revision } });
const deps = (env, id) => http(`${env.api}/workspaces/${id}/dependencies`);
const repin = (env, id, dep, json) => http(`${env.api}/workspaces/${id}/dependencies/${dep}/repin`, { method: 'POST', json });
const detach = (env, id, dep) => http(`${env.api}/workspaces/${id}/dependencies/${dep}`, { method: 'DELETE' });
const merge = (env, n) => http(`${env.api}/changes/${n}/merge`, { method: 'POST' });
const enqueue = (env, n) => http(`${env.api}/changes/${n}/enqueue`, { method: 'POST' });
const change = (env, n) => http(`${env.api}/changes/${n}`);

async function waitDeps(env, id, pred, ms = 60_000) {
  const t0 = Date.now();
  let r;
  while (Date.now() - t0 < ms) {
    r = await deps(env, id);
    if (pred(r.json?.dependencies ?? [])) return r;
    await sleep(2000);
  }
  return r;
}

async function waitMerged(env, n, ms = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const c = await change(env, n);
    if (c.json?.state === 'merged') return c.json;
    await sleep(3000);
  }
  return null;
}

function forge(args, { json = true } = {}) {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args, ...(json ? ['--json'] : [])], {
    env: { PATH: process.env.PATH, FORGE_BASE_URL: BASE, FORGE_PAT: PAT },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  let data = null;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    data = null;
  }
  return { code: r.status, data, out: r.stdout ?? '', err: (r.stderr ?? '').trim(), timedOut: r.error?.code === 'ETIMEDOUT' };
}

const leaks = (s) => s.includes(PAT) || /forge_pat_[0-9a-f]/.test(s) || /authorization:/i.test(s);

/** Drops fields that legitimately differ between two records (ids, timestamps, the workspaces themselves). */
function comparable(v, drop) {
  if (Array.isArray(v)) return v.map((x) => comparable(x, drop));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !drop.includes(k)).map(([k, x]) => [k, comparable(x, drop)]));
  return v;
}

async function scenario(purpose, body, extra = []) {
  if (only && !only.has(purpose)) return;
  const names = [purpose, ...extra].map((p) => `${PREFIX}-${p}-${TS}`);
  console.log(`\n# ${purpose}: ${names.map((n) => `${OWNER}/${n}`).join(', ')}`);
  const nest = async (i, envs) => {
    if (i === names.length) {
      try {
        await body(...envs);
      } catch (err) {
        check(purpose, `scenario ${purpose} ran to completion`, false, String(err?.stack ?? err).slice(0, 500));
      }
      return;
    }
    const r = await withFixtureRepo({ owner: OWNER, repo: names[i], prefix: PREFIX, http: (p, o) => http(p, o), keep: opts.keep, visibility: 'public', log: console.log }, async () =>
      nest(i + 1, [...envs, await seed(names[i])]),
    );
    if (!r.ok) check(purpose, `fixture repo ${names[i]}`, false, r.reason);
    if (!opts.keep && r.created) {
      const gone = await http(repoPath(names[i]));
      check(purpose, `scratch repo ${names[i]} deleted (owner readback 404)`, gone.status === 404, String(gone.status));
    }
  };
  await nest(0, []);
}

// --- pins: explicit, exact, same-repo, depth cap, cycles, cost -------------------

await scenario(
  'pins',
  async (env, other, many) => {
    const [a, b, c] = [await workspace(env, 'a'), await workspace(env, 'b'), await workspace(env, 'c')];
    const ls = lsRemote(env.repo);
    console.log(`workspaces a=${a.id}@${short(a.head)} b=${b.id} c=${c.id}; git ls-remote ${a.ref} -> ${short(ls[a.ref])}`);
    const created = await pin(env, b.id, a.id, a.head);
    console.log(`POST workspaces/${b.id}/dependencies {onWorkspace:${a.id}, revision:${short(a.head)}} -> ${created.status} ${created.text} (x-forge-cost ${cost('create', created)})`);
    check('VAL-DEP-001', 'explicit pin → 201 edge {workspaceId, onWorkspace, revision, state active, depth}', created.status === 201 && created.json?.workspaceId === b.id && created.json?.onWorkspace === a.id && created.json?.revision === a.head && created.json?.state === 'active' && created.json?.depth === 2 && ls[a.ref] === a.head);
    const listB = await deps(env, b.id);
    const listC = await deps(env, c.id);
    console.log(`GET b deps -> ${listB.text} (x-forge-cost ${cost('list', listB)})\nGET c deps -> ${listC.text}`);
    check('VAL-DEP-001', 'GET lists exactly that edge; C (no call) lists none', isDeepStrictEqual(listB.json?.dependencies?.map((d) => d.id), [created.json?.id]) && listC.json?.dependencies?.length === 0);
    const bogus = await pin(env, c.id, a.id, 'f'.repeat(40));
    const missing = await pin(env, c.id, a.id, undefined);
    const ghost = await pin(env, c.id, '0123456789abcdef', a.head);
    console.log(`bogus revision -> ${bogus.status} ${bogus.text}\nmissing revision -> ${missing.status} ${missing.text}\nnonexistent source -> ${ghost.status} ${ghost.text}`);
    check('VAL-DEP-001', 'bogus / missing revision and nonexistent source → 4xx {error, code}, no edge', bogus.status === 422 && bogus.json?.code === 'REVISION_NOT_CURRENT' && bogus.json?.currentRevision === a.head && missing.status >= 400 && missing.status < 500 && missing.json?.code && ghost.status === 404 && (await deps(env, c.id)).json?.dependencies?.length === 0);

    // VAL-DEP-003: 2-cycle and 3-cycle.
    const cyc2 = await pin(env, a.id, b.id, b.head);
    console.log(`2-cycle a→b -> ${cyc2.status} ${cyc2.text} (x-forge-cost ${cost('cycle', cyc2)})`);
    check('VAL-DEP-003', '2-node cycle → 422 naming the path; lists unchanged', cyc2.status === 422 && cyc2.json?.code === 'DEPENDENCY_CYCLE' && isDeepStrictEqual(cyc2.json?.path, [a.id, b.id, a.id]) && (await deps(env, a.id)).json?.dependencies?.length === 0 && (await deps(env, b.id)).json?.dependencies?.length === 1);
    const cb = await pin(env, c.id, b.id, b.head);
    const cyc3 = await pin(env, a.id, c.id, c.head);
    console.log(`c→b -> ${cb.status}; 3-cycle a→c -> ${cyc3.status} ${cyc3.text}`);
    check('VAL-DEP-003', '3-node cycle → 422 naming the path', cb.status === 201 && cyc3.status === 422 && cyc3.json?.code === 'DEPENDENCY_CYCLE' && isDeepStrictEqual(cyc3.json?.path, [a.id, c.id, b.id, a.id]));

    // VAL-DEP-002: chain d1 ← d2 ← d3 ← d4 (depth 4), d5 refused; detach an inner edge and re-create.
    const d = [];
    for (const n of ['d1', 'd2', 'd3', 'd4', 'd5']) d.push(await workspace(env, n));
    const chain = [];
    for (let i = 1; i < 4; i++) chain.push(await pin(env, d[i].id, d[i - 1].id, d[i - 1].head));
    const list4 = await deps(env, d[3].id);
    const deep = await pin(env, d[4].id, d[3].id, d[3].head);
    // Same chain shape as the many-workspace measurement below.
    const dCycle = await pin(env, d[0].id, d[1].id, d[1].head);
    console.log(`chain: ${chain.map((r) => `${r.status} depth=${r.json?.depth}`).join(', ')}; GET d4 deps -> depth ${list4.json?.dependencies?.[0]?.depth} (x-forge-cost ${cost('list depth-4', list4)})\ndepth-5 d5→d4 -> ${deep.status} ${deep.text} (x-forge-cost ${cost('depth reject', deep)})`);
    check('VAL-DEP-002', 'depth-4 chain accepted, GET reports depth 4', chain.every((r) => r.status === 201) && list4.json?.dependencies?.[0]?.depth === 4);
    check('VAL-DEP-002', 'depth 5 → 422 naming the limit and the edge; no edge created', deep.status === 422 && deep.json?.code === 'DEPENDENCY_DEPTH_EXCEEDED' && deep.json?.maxDepth === 4 && deep.json?.edge?.workspaceId === d[4].id && /limited to 4/.test(deep.json?.error ?? '') && (await deps(env, d[4].id)).json?.dependencies?.length === 0);
    const inner = await detach(env, d[1].id, chain[0].json.id);
    const again = await pin(env, d[4].id, d[3].id, d[3].head);
    console.log(`detach d2→d1 -> ${inner.status} (x-forge-cost ${cost('detach', inner)}); d5→d4 again -> ${again.status} depth=${again.json?.depth} (x-forge-cost ${cost('create depth-4', again)})`);
    check('VAL-DEP-002', 'detaching an inner edge allows the edge within the cap', inner.status === 200 && again.status === 201 && again.json?.depth === 4);

    // VAL-DEP-004: cross-repo source.
    const foreign = await workspace(other, 'f');
    const lsBefore = lsRemote(other.repo);
    const cross = await pin(env, c.id, foreign.id, foreign.head);
    const otherList = await deps(other, foreign.id);
    console.log(`cross-repo ${env.repo}/${c.id} → ${other.repo}/${foreign.id} -> ${cross.status} ${cross.text} (x-forge-cost ${cost('cross-repo', cross)})`);
    check('VAL-DEP-004', 'cross-repo pin → 404 {error, code}; no edge in either repo; other repo refs unchanged', cross.status === 404 && cross.json?.code === 'SOURCE_NOT_FOUND' && (await deps(env, c.id)).json?.dependencies?.length === 1 && otherList.json?.dependencies?.length === 0 && isDeepStrictEqual(lsRemote(other.repo), lsBefore));

    // VAL-COST-026: equal d1 and non-growing rr in a repo with many unrelated workspaces.
    const noise = [];
    for (let i = 0; i < 12; i++) noise.push(await http(`${many.api}/workspaces`, { method: 'POST', json: { task: `noise ${i}`, agent: 'noise' } }));
    for (let i = 1; i < noise.length; i += 2) await pin(many, noise[i].json.id, noise[i - 1].json.id, noise[i - 1].json.headSha);
    const m = [];
    for (const n of ['m1', 'm2', 'm3', 'm4', 'm5']) m.push(await workspace(many, n));
    const mChain = [];
    for (let i = 1; i < 4; i++) mChain.push(await pin(many, m[i].id, m[i - 1].id, m[i - 1].head));
    const mDeep = await pin(many, m[4].id, m[3].id, m[3].head);
    const mCycle = await pin(many, m[0].id, m[1].id, m[1].head);
    const mList = await deps(many, m[3].id);
    const mListWarm = await deps(many, m[3].id);
    const listWarm = await deps(env, d[3].id);
    const rows = [
      ['create (depth 4)', chain[2], mChain[2]],
      ['depth-5 reject', deep, mDeep],
      ['cycle reject', dCycle, mCycle],
      ['warm list', listWarm, mListWarm],
    ];
    for (const [label, small, big] of rows) console.log(`${label}: small repo ${small.cost} | many-workspace repo ${big.cost}`);
    const pc = (r) => parseCost(r.cost);
    check('VAL-COST-026', 'the measured cases are the same refusals in both repos', [dCycle, mCycle].every((r) => r.json?.code === 'DEPENDENCY_CYCLE') && [deep, mDeep].every((r) => r.json?.code === 'DEPENDENCY_DEPTH_EXCEEDED'));
    check('VAL-COST-026', 'create / depth reject / cycle reject: d1 ≤ 3, do = 0', rows.slice(0, 3).every(([, s, b]) => [s, b].every((r) => pc(r).d1 <= 3 && pc(r).do === 0)));
    check('VAL-COST-026', 'counters do not grow with unrelated workspaces: equal d1, rr within ±3', rows.every(([, s, b]) => pc(s).d1 === pc(b).d1 && Math.abs(pc(s).rr - pc(b).rr) <= 3));
    check('VAL-COST-026', 'warm list: d1 ≤ 3, art = 0, do = 0', [listWarm, mListWarm, mList].every((r) => pc(r).d1 <= 3 && pc(r).art === 0 && pc(r).do === 0));
    check('VAL-COST-026', 'detach within the write budget: d1 ≤ 3, do = 0', pc(inner).d1 <= 3 && pc(inner).do === 0);
  },
  ['pins-other', 'pins-many'],
);

// --- stale, repin, detach, broken --------------------------------------------------

await scenario('stale', async (env) => {
  const a = await workspace(env, 'a', { change: true });
  const b = await workspace(env, 'b', { change: true });
  const edge = (await pin(env, b.id, a.id, a.head)).json;
  const r2 = await pushTo(env, a, { 'a.txt': 'a v2\n' }, 'a v2');
  const stale = await waitDeps(env, b.id, (ds) => ds[0]?.state === 'stale');
  const ls = lsRemote(env.repo);
  const [m, q] = [await merge(env, b.number), await enqueue(env, b.number)];
  console.log(`git push ${a.ref} -> ${short(r2)}; GET b deps -> ${stale.text}\nmerge b -> ${m.status} ${m.text}\nenqueue b -> ${q.status} ${q.json?.code}\nls-remote a=${short(ls[a.ref])} b=${short(ls[b.ref])}`);
  check('VAL-DEP-005', 'source push → stale, revision still R (not rewritten)', stale.json?.dependencies?.[0]?.state === 'stale' && stale.json.dependencies[0].revision === a.head && stale.json.dependencies[0].sourceHead === r2);
  check('VAL-DEP-005', 'merge and enqueue refused 409 DEPENDENCY_STALE naming the source; B ref untouched, A at R2', m.status === 409 && m.json?.code === 'DEPENDENCY_STALE' && m.json.error.includes(a.id) && q.status === 409 && q.json?.code === 'DEPENDENCY_STALE' && ls[b.ref] === b.head && ls[a.ref] === r2);

  // VAL-DEP-008: invalid repins leave the pin in force; a valid repin → active at R2.
  const bad = [
    ['not the current revision', await repin(env, b.id, edge.id, { revision: a.head })],
    ['nonexistent revision', await repin(env, b.id, edge.id, { revision: 'e'.repeat(40) })],
    ['malformed revision', await repin(env, b.id, edge.id, { revision: 'xyz' })],
    ['source in another repo / unknown', await repin(env, b.id, edge.id, { onWorkspace: 'fedcba9876543210', revision: r2 })],
  ];
  for (const [label, r] of bad) console.log(`repin (${label}) -> ${r.status} ${r.text}`);
  const still = await deps(env, b.id);
  check('VAL-DEP-008', 'each invalid repin → 4xx {error, code}; the previous pin stays in force', bad.every(([, r]) => r.status >= 400 && r.status < 500 && r.json?.code) && still.json?.dependencies?.[0]?.revision === a.head);
  const ok = await repin(env, b.id, edge.id, { revision: r2 });
  const after = await deps(env, b.id);
  console.log(`repin {revision: R2} -> ${ok.status} ${ok.text} (x-forge-cost ${cost('repin', ok)})\nGET -> ${after.text}`);
  check('VAL-DEP-008', 'explicit repin → active at R2, GET agrees, reports the previous stale pin', ok.status === 200 && ok.json?.state === 'active' && ok.json?.revision === r2 && ok.json?.previous?.state === 'stale' && after.json?.dependencies?.[0]?.revision === r2 && after.json.dependencies[0].state === 'active');
  check('VAL-COST-026', 'repin within the write budget: d1 ≤ 3, do = 0', parseCost(ok.cost).d1 <= 3 && parseCost(ok.cost).do === 0);

  // VAL-DEP-006: abandon the source.
  const before = (await change(env, b.number)).json;
  const ab = await http(`${env.api}/workspaces/${a.id}/abandon`, { method: 'POST' });
  const broken = await deps(env, b.id);
  const [m2, q2] = [await merge(env, b.number), await enqueue(env, b.number)];
  const afterB = (await change(env, b.number)).json;
  const ls2 = lsRemote(env.repo);
  console.log(`abandon a -> ${ab.status}; GET b deps -> ${broken.text}\nmerge b -> ${m2.status} ${m2.text}\nenqueue b -> ${q2.status} ${q2.json?.code}\nchange b before ${before?.state}@${short(before?.headSha)} after ${afterB?.state}@${short(afterB?.headSha)} queueState=${afterB?.queueState}; ls-remote b=${short(ls2[b.ref])}`);
  check('VAL-DEP-006', 'abandonment → broken (SOURCE_ABANDONED)', broken.json?.dependencies?.[0]?.state === 'broken' && broken.json.dependencies[0].reason?.code === 'SOURCE_ABANDONED');
  check('VAL-DEP-006', 'B merge/enqueue 409 DEPENDENCY_BROKEN naming the source; B ref, head, change unchanged', m2.status === 409 && m2.json?.code === 'DEPENDENCY_BROKEN' && m2.json.error.includes(a.id) && q2.status === 409 && afterB?.state === 'open' && afterB.headSha === b.head && before?.headSha === b.head && ls2[b.ref] === b.head);
  const off = await detach(env, b.id, edge.id);
  const empty = await deps(env, b.id);
  const landed = await merge(env, b.number);
  console.log(`detach -> ${off.status} ${off.text}; GET -> ${empty.text}; merge b -> ${landed.status} ${landed.json?.state}`);
  check('VAL-DEP-008', 'explicit detach removes the edge; B then publishes', off.status === 200 && off.json?.detached === true && empty.json?.dependencies?.length === 0 && landed.status === 200);
});

// --- satisfied only when the revision is preserved -----------------------------------

await scenario(
  'satisfy',
  async (env, other) => {
    const a = await workspace(env, 'a', { change: true });
    const b = await workspace(env, 'b', { change: true });
    await pin(env, b.id, a.id, a.head);
    const pending = await merge(env, b.number);
    const ma = await merge(env, a.number);
    mustGit(['fetch', '-q', gitUrl(env.repo), '+refs/heads/main:refs/remotes/origin/main'], env.dir);
    const anc = git(['merge-base', '--is-ancestor', a.head, 'origin/main'], env.dir).code === 0;
    const sat = await waitDeps(env, b.id, (ds) => ds[0]?.state === 'satisfied');
    const mb = await merge(env, b.number);
    console.log(`merge b before a -> ${pending.status} ${pending.json?.code}; merge a -> ${ma.status} ${ma.json?.mergeCommit}; is-ancestor R main=${anc}; GET b deps -> ${sat.text}; merge b -> ${mb.status} ${mb.json?.mergeCommit}`);
    check('VAL-DEP-007', '(a) R preserved in the landed ancestry → satisfied, B publishes', pending.status === 409 && pending.json?.code === 'DEPENDENCY_PENDING' && ma.status === 200 && anc && sat.json?.dependencies?.[0]?.state === 'satisfied' && mb.status === 200);

    const a2 = await workspace(other, 'a', { change: true });
    const b2 = await workspace(other, 'b', { change: true });
    await pin(other, b2.id, a2.id, a2.head);
    // A's head is force-moved to a commit that does not contain R, then A lands.
    const rewritten = await pushTo(other, a2, { 'a.txt': 'a rewritten\n' }, 'a rewritten', true, other.main);
    // Merge immediately after the push. Until the push event records the rewrite, the merge confirms the live
    // head branch and refuses 409 HEAD_MOVED naming it; the client re-reads the change and merges again.
    let ma2 = await merge(other, a2.number);
    const movedReplies = [];
    for (let i = 0; i < 40 && ma2.status === 409 && ma2.json?.code === 'HEAD_MOVED'; i++) {
      movedReplies.push(ma2);
      await sleep(1500);
      await change(other, a2.number);
      ma2 = await merge(other, a2.number);
    }
    if (movedReplies.length) console.log(`merge a right after the force-push -> 409 HEAD_MOVED ×${movedReplies.length}: ${movedReplies[0].text} (x-forge-cost ${cost('head moved', movedReplies[0])})`);
    else console.log('merge a right after the force-push -> no HEAD_MOVED (the push event had already recorded the rewrite)');
    check('VAL-DEP-007', '(b) an immediate merge after the force-push never publishes the previous head: HEAD_MOVED names the live rewrite', movedReplies.every((r) => r.json?.headSha === rewritten && r.json?.recordedHead === a2.head));
    mustGit(['fetch', '-q', gitUrl(other.repo), '+refs/heads/main:refs/remotes/origin/main2'], other.dir);
    const anc2 = git(['merge-base', '--is-ancestor', a2.head, 'origin/main2'], other.dir).code === 0;
    check('VAL-DEP-007', '(b) the landed commit contains the force-pushed head', ma2.status === 200 && git(['merge-base', '--is-ancestor', rewritten, 'origin/main2'], other.dir).code === 0);
    const notSat = await waitDeps(other, b2.id, (ds) => ds[0]?.state === 'broken', 30_000);
    const mb2 = await merge(other, b2.number);
    console.log(`force-push a -> ${short(rewritten)}; merge a -> ${ma2.status}; is-ancestor R main=${anc2}; GET b deps -> ${notSat.text}; merge b -> ${mb2.status} ${mb2.json?.code}`);
    check('VAL-DEP-007', '(b) R not in the landed ancestry → never satisfied (broken NOT_PRESERVED), B refused', ma2.status === 200 && !anc2 && notSat.json?.dependencies?.[0]?.state !== 'satisfied' && notSat.json?.dependencies?.[0]?.reason?.code === 'NOT_PRESERVED' && mb2.status === 409);
  },
  ['satisfy-rewrite'],
);

// --- train: dependency order, unrelated work unaffected -------------------------------

await scenario('train', async (env) => {
  const a = await workspace(env, 'a', { change: true });
  const b = await workspace(env, 'b', { change: true });
  const c = await workspace(env, 'c', { change: true });
  await pin(env, b.id, a.id, a.head);
  const qb = await enqueue(env, b.number);
  await sleep(4000);
  const waiting = await http(`${env.api}/train`);
  const wb = waiting.json?.entries?.find((e) => e.number === b.number);
  console.log(`enqueue b -> ${qb.status}; GET train -> b waiting ${JSON.stringify(wb?.waiting)} state=${wb?.state} (x-forge-cost ${cost('train', waiting)})`);
  check('VAL-DEP-009', 'B enqueued first waits with a machine-readable reason on GET train', qb.status === 201 && wb?.waiting?.code === 'DEPENDENCY_PENDING' && wb.state === 'queued');
  const qa = await enqueue(env, a.number);
  const qc = await enqueue(env, c.number);
  const [ma, mc, mb] = [await waitMerged(env, a.number), await waitMerged(env, c.number), await waitMerged(env, b.number)];
  mustGit(['fetch', '-q', gitUrl(env.repo), '+refs/heads/main:refs/remotes/origin/main'], env.dir);
  const log = mustGit(['log', '--first-parent', '--format=%H %s', 'origin/main'], env.dir).split('\n');
  const pos = (sha) => log.findIndex((l) => l.startsWith(sha ?? '-'));
  const sat = await deps(env, b.id);
  const tree = mustGit(['ls-tree', '--name-only', 'origin/main'], env.dir).split('\n');
  console.log(`enqueue a -> ${qa.status}, c -> ${qc.status}\nmerged: a ${short(ma?.mergeCommit)} c ${short(mc?.mergeCommit)} b ${short(mb?.mergeCommit)}\ngit log --first-parent main:\n  ${log.join('\n  ')}\nGET b deps -> ${sat.json?.dependencies?.[0]?.state}; tree ${tree.join(',')}`);
  check('VAL-DEP-009', 'all three land with distinct merge commits; A before B on first-parent main', ma && mb && mc && new Set([ma.mergeCommit, mb.mergeCommit, mc.mergeCommit]).size === 3 && pos(ma.mergeCommit) > pos(mb.mergeCommit) && pos(mb.mergeCommit) >= 0);
  check('VAL-DEP-009', "B's pin satisfied; A's result in B's ancestry; every file on main", sat.json?.dependencies?.[0]?.state === 'satisfied' && git(['merge-base', '--is-ancestor', a.head, mb?.mergeCommit ?? 'x'], env.dir).code === 0 && ['a.txt', 'b.txt', 'c.txt'].every((f) => tree.includes(f)));
  check('VAL-DEP-009', 'C was not held behind B (it landed while or before B waited)', Boolean(mc) && pos(mc.mergeCommit) > pos(mb?.mergeCommit));
});

// --- CLI: recovery, failures, parity, status, help ------------------------------------

await scenario('cli', async (env) => {
  // VAL-CROSS-008: broken → CLI list → CLI repin to a live source → publication; and a detach.
  const a = await workspace(env, 'a', { change: true });
  const b = await workspace(env, 'b', { change: true });
  const e = await workspace(env, 'e', { change: true });
  const edge = (await pin(env, b.id, a.id, a.head)).json;
  const edgeE = (await pin(env, e.id, a.id, a.head)).json;
  await http(`${env.api}/workspaces/${a.id}/abandon`, { method: 'POST' });
  const refused = await merge(env, b.number);
  const listed = forge(['deps', 'list', env.full, b.id]);
  console.log(`abandon a; merge b -> ${refused.status} ${refused.json?.code}\nforge deps list -> exit ${listed.code} ${listed.out.trim()}`);
  check('VAL-CROSS-008', 'broken pin: merge refused 409 with the reason; forge deps list shows the broken edge', refused.status === 409 && refused.json?.code === 'DEPENDENCY_BROKEN' && listed.code === 0 && listed.data?.dependencies?.[0]?.state === 'broken');
  const blocked = forge(['queue', 'add', env.full, String(b.number)]);
  console.log(`forge queue add -> exit ${blocked.code}\n${blocked.err}`);
  const c = await workspace(env, 'c', { change: true });
  const moved = forge(['deps', 'repin', env.full, b.id, edge.id, '--on-workspace', c.id, '--revision', c.head]);
  const rest = await deps(env, b.id);
  console.log(`forge deps repin --on-workspace ${c.id} --revision ${short(c.head)} -> exit ${moved.code} ${moved.out.trim()}\nREST GET -> ${rest.text}`);
  check('VAL-CROSS-008', 'the CLI names the recovery commands on the refusal', blocked.code === 1 && blocked.err.includes(`forge deps repin ${env.full} ${b.id} ${edge.id}`) && blocked.err.includes('forge deps detach'));
  const { previous: _p, ...printed } = moved.data ?? {};
  check('VAL-CROSS-008', 'repin through the CLI reports broken → active; REST read-back equals what the CLI printed', moved.code === 0 && moved.data?.previous?.state === 'broken' && moved.data?.state === 'active' && isDeepStrictEqual(rest.json?.dependencies, [printed]));
  for (const n of [c.number, b.number]) await enqueue(env, n);
  const [mc, mb] = [await waitMerged(env, c.number), await waitMerged(env, b.number)];
  mustGit(['fetch', '-q', gitUrl(env.repo), '+refs/heads/main:refs/remotes/origin/main', `+${b.ref}:refs/remotes/origin/b`], env.dir);
  const bRef = mustGit(['rev-parse', 'refs/remotes/origin/b'], env.dir);
  console.log(`train: c ${short(mc?.mergeCommit)} b ${short(mb?.mergeCommit)}; b ref ${short(bRef)} (before ${short(b.head)})`);
  check('VAL-CROSS-008', "B publishes after the explicit repin with C's result in its ancestry; B's commits unchanged", Boolean(mb) && git(['merge-base', '--is-ancestor', c.head, mb.mergeCommit], env.dir).code === 0 && git(['merge-base', '--is-ancestor', b.head, mb.mergeCommit], env.dir).code === 0 && bRef === b.head);
  const off = forge(['deps', 'detach', env.full, e.id, edgeE.id]);
  const me = await merge(env, e.number);
  console.log(`forge deps detach -> exit ${off.code} ${off.out.trim()}; merge e -> ${me.status}`);
  check('VAL-CROSS-008', 'after an explicit CLI detach the other dependent publishes with no constraint', off.code === 0 && off.data?.detached === true && (await deps(env, e.id)).json?.dependencies?.length === 0 && me.status === 200);

  // VAL-CLI-002: four failure classes, stdin closed, no token in output (on live workspaces: b, c and e have landed).
  const [f, g] = [await workspace(env, 'f'), await workspace(env, 'g')];
  const fails = [
    ['unknown repo', forge(['deps', 'list', `${OWNER}/${PREFIX}-nope-${TS}`, f.id])],
    ['stale revision', forge(['deps', 'add', env.full, f.id, '--on-workspace', g.id, '--revision', 'f'.repeat(40)])],
    ['invalid argument', forge(['deps', 'add', env.full, f.id, '--bogus', 'x'])],
  ];
  if (BOT) {
    const r = spawnSync(process.execPath, [CLI_BIN, 'deps', 'add', env.full, f.id, '--on-workspace', g.id, '--revision', g.head, '--json'], {
      env: { PATH: process.env.PATH, FORGE_BASE_URL: BASE, FORGE_PAT: BOT },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    fails.splice(1, 0, ['principal without permission', { code: r.status, out: r.stdout ?? '', err: (r.stderr ?? '').trim(), botLeak: (r.stdout + r.stderr).includes(BOT) }]);
  }
  for (const [label, r] of fails) console.log(`forge (${label}) -> exit ${r.code}\n  stderr: ${r.err.split('\n').join('\n          ')}`);
  check('VAL-CLI-002', `${fails.length} failure classes exit nonzero with the cause and a hint, without a prompt (stdin closed)`, fails.every(([, r]) => r.code !== 0 && !r.timedOut && /hint: |run "forge help/.test(r.err)));
  check('VAL-CLI-002', 'the stale revision failure names the current revision', fails.find(([l]) => l === 'stale revision')[1].err.includes(`--revision ${g.head}`));
  check('VAL-CLI-002', 'no token or Authorization header in any output', fails.every(([, r]) => !leaks(r.out + r.err) && !r.botLeak));

  // VAL-CLI-003: CLI vs REST for intent, pin and task claim.
  const [x1, x2, s1, s2] = [await workspace(env, 'x1'), await workspace(env, 'x2'), await workspace(env, 's1'), await workspace(env, 's2')];
  const intentCli = forge(['intent', 'set', env.full, x1.id, '--paths', 'src/a.ts', '--paths', 'docs/', '--ttl-seconds', '600']);
  const intentRest = await http(`${env.api}/workspaces/${x2.id}/intent`, { method: 'POST', json: { paths: ['src/a.ts', 'docs/'], ttlSeconds: 600 } });
  const intentBack = await http(`${env.api}/workspaces/${x1.id}/intent`);
  const pinCli = forge(['deps', 'add', env.full, x1.id, '--on-workspace', s1.id, '--revision', s1.head]);
  const pinRest = await pin(env, x2.id, s2.id, s2.head);
  const pinBack = await deps(env, x1.id);
  const dropPin = ['id', 'workspaceId', 'onWorkspace', 'revision', 'sourceHead', 'createdAt', 'updatedAt'];
  console.log(`forge intent set -> exit ${intentCli.code} ${JSON.stringify(intentCli.data)}\nREST intent -> ${intentRest.status} ${intentRest.text}\nforge deps add -> exit ${pinCli.code} ${JSON.stringify(pinCli.data)}\nREST pin -> ${pinRest.status} ${pinRest.text}`);
  // The observed half of an intent view follows each workspace's own pushes (x1.txt vs x2.txt), so the declaration is compared.
  const declaration = (v) => v && { status: v.status, base: v.base, declaredPaths: v.declaredPaths, declaredExpired: v.declaredExpired, declared: v.matches?.map((m) => m.declared), indexDeclared: v.index?.declared, advisory: v.advisory };
  const declaredAt = (v) => v && { ...declaration(v), declaredAt: v.declaredAt, declaredExpiresAt: v.declaredExpiresAt };
  console.log(`intent declaration: CLI ${JSON.stringify(declaredAt(intentCli.data))}\n  REST read-back ${JSON.stringify(declaredAt(intentBack.json))}\n  REST-made ${JSON.stringify(declaration(intentRest.json))}`);
  check('VAL-CLI-003', 'intent: CLI declaration = REST read-back (incl. timestamps) = the REST-made declaration (except ids/timestamps)', intentCli.code === 0 && intentRest.status === 200 && isDeepStrictEqual(declaredAt(intentCli.data), declaredAt(intentBack.json)) && isDeepStrictEqual(declaration(intentCli.data), declaration(intentRest.json)));
  check('VAL-CLI-003', 'pin: CLI edge = REST read-back; revision/depth/state equal to the REST-created edge', pinCli.code === 0 && isDeepStrictEqual(pinBack.json?.dependencies, [pinCli.data]) && isDeepStrictEqual(comparable(pinCli.data, dropPin), comparable(pinRest.json, dropPin)) && pinCli.data?.revision === s1.head);
  // Two genuine conflicts give two resolve-conflict tasks.
  const k1 = await workspace(env, 'k1', { change: false, files: { 'shared.txt': 'k1\n' } });
  const k2 = await workspace(env, 'k2', { change: false, files: { 'shared.txt': 'k2\n' } });
  mustGit(['fetch', '-q', gitUrl(env.repo), '+refs/heads/main:refs/remotes/origin/main'], env.dir);
  const mainNew = commitOn(env.dir, 'refs/remotes/origin/main', { 'shared.txt': 'main\n' }, 'main shared');
  await pushRetry(env.dir, gitUrl(env.repo), [`${mainNew}:refs/heads/main`]);
  await sleep(3000);
  for (const k of [k1, k2]) await http(`${env.api}/workspaces/${k.id}/change-set`, { method: 'POST', json: { title: `${k.name} conflict`, mergePolicy: 'review' } });
  let tasks = [];
  for (let i = 0; i < 20 && tasks.length < 2; i++) {
    tasks = (await http(`${env.api}/tasks?status=open&kind=resolve-conflict`)).json?.tasks ?? [];
    if (tasks.length < 2) await sleep(2000);
  }
  const claimCli = forge(['task', 'claim', env.full, tasks[0]?.id ?? 'none', '--agent', 'cli-agent', '--ttl-seconds', '120']);
  const claimRest = await http(`${env.api}/tasks/${tasks[1]?.id ?? 'none'}/claim`, { method: 'POST', json: { agent: 'cli-agent', ttlSeconds: 120 } });
  const claimBack = await http(`${env.api}/tasks/${tasks[0]?.id ?? 'none'}`);
  const view = (t) => t && { status: t.status, claimedBy: t.claimedBy, generation: t.generation, holder: t.lease?.holder, expired: t.lease?.expired, kind: t.kind };
  console.log(`tasks ${tasks.map((t) => t.id).join(',')}\nforge task claim -> exit ${claimCli.code} ${JSON.stringify(view(claimCli.data?.task))}\nREST claim -> ${claimRest.status} ${JSON.stringify(view(claimRest.json?.task))}\nREST read-back -> ${JSON.stringify(view(claimBack.json))}`);
  check('VAL-CLI-003', 'task claim: claimant and lease generation equal across CLI, REST read-back and the REST-made claim', claimCli.code === 0 && claimRest.status === 200 && isDeepStrictEqual(view(claimCli.data?.task), view(claimBack.json)) && isDeepStrictEqual(view(claimCli.data?.task), view(claimRest.json?.task)));

  // VAL-CLI-005: status twice, no mutation, reads only.
  await enqueue(env, (await workspace(env, 'q', { change: true })).number);
  await sleep(1000);
  const snap = async () => ({
    ls: lsRemote(env.repo),
    changes: (await http(`${env.api}/changes?state=all&limit=100`)).json,
    workspaces: (await http(`${env.api}/workspaces?status=all&limit=100`)).json,
    queue: (await http(`${env.api}/queue`)).json,
  });
  const stable = (s) => comparable(s, ['updatedAt', 'lease', 'expiresAt', 'retryAt']);
  const before = await snap();
  const st1 = forge(['status', env.full]);
  const st2 = forge(['status', env.full]);
  const after = await snap();
  const reads = await Promise.all([`${env.api}/workspaces?status=active&limit=100`, `${env.api}/train?limit=100`, `${env.api}/tasks?status=open&limit=100`].map((p) => http(p)));
  console.log(`forge status --json x2 -> exit ${st1.code}/${st2.code}; ${st1.out.length} bytes; workspaces=${st1.data?.workspaces?.length} pins=${st1.data?.workspaces?.reduce((n, w) => n + (w.dependencies?.length ?? 0), 0)} train=${st1.data?.train?.entries?.length} tasks=${st1.data?.tasks?.tasks?.length}\nunderlying reads: ${reads.map((r) => r.cost).join(' | ')}`);
  check('VAL-CLI-005', 'two runs exit 0 with parseable JSON that agrees on state (only volatile timestamps differ)', st1.code === 0 && st2.code === 0 && st1.data && isDeepStrictEqual(stable(st1.data), stable(st2.data)) && st1.data.train?.entries?.length >= 1 && st1.data.workspaces.some((w) => w.dependencies?.length > 0));
  check('VAL-CLI-005', 'no mutation: ls-remote, changes, workspaces and queue unchanged; underlying reads q=0', isDeepStrictEqual(stable(before), stable(after)) && reads.every((r) => r.status === 200 && parseCost(r.cost).q === 0 && parseCost(r.cost).rw === 0));

  // VAL-CLI-001: help lists the finite command set; the registry of record documents it.
  const help = forge(['--help'], { json: false });
  const perCommand = OPERATIONS.map((op) => [op, forge([...op.command, '--help'], { json: false })]);
  const statusHelp = forge(['status', '--help'], { json: false });
  check('VAL-CLI-001', 'forge --help lists every registry command, checkout and status', help.code === 0 && OPERATIONS.every((op) => help.out.includes(op.command.join(' '))) && /\n {2}status <owner\/repo>/.test(help.out) && /\n {2}checkout /.test(help.out));
  check('VAL-CLI-001', 'every command prints usage text with its REST route and MCP tool', perCommand.every(([op, r]) => r.code === 0 && r.out.includes(`usage: forge ${op.command.join(' ')}`) && r.out.includes(`MCP tool: ${op.name}`) && r.out.includes(op.description)) && statusHelp.out.includes('usage: forge status'));
  const doc = opts['api-doc'];
  if (doc && existsSync(doc)) {
    const rows = [...readFileSync(doc, 'utf8').matchAll(/^\| [a-z-]+ \| `([a-z_]+)` \| `forge ([a-z-]+ [a-z-]+)` \|/gm)].map((m) => [m[1], m[2]]);
    const documented = new Map(rows);
    const missing = OPERATIONS.filter((op) => documented.get(op.name) !== op.command.join(' ')).map((op) => op.name);
    const extra = rows.filter(([n]) => !OPERATIONS.some((op) => op.name === n)).map(([n]) => n);
    console.log(`registry of record ${doc}: ${rows.length} rows; missing/mismatched ${missing.join(',') || 'none'}; undocumented extras ${extra.join(',') || 'none'}`);
    check('VAL-CLI-001', 'library/api.md documents every command with its MCP tool, and nothing else', missing.length === 0 && extra.length === 0 && rows.length === OPERATIONS.length);
  } else {
    console.log('(--api-doc not given: skipping the library/api.md comparison)');
  }
});

rmSync(work, { recursive: true, force: true });
console.log('\n# costs');
for (const c of costs) console.log(`${c.label}: ${c.status} ${c.cost}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
