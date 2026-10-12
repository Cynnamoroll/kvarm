#!/usr/bin/env node
/**
 * Live driver for candidate comparison, arenas and composition
 * (m6a-candidates-overlap): VAL-CAND-001..004/006, VAL-COST-015,
 * VAL-WORKFLOW-004, VAL-CROSS-010, VAL-ARENA-001..004, the candidates half of
 * VAL-COST-025, VAL-COMPOSE-001..002 and (m5-guard-check) VAL-CAND-005.
 *
 * Every section runs in a fresh public repo owned by KVARM_USER (cynthia),
 * named `m6a-candidates-overlap-<section>-<timestamp>`, seeded and changed
 * with real git pushes through the platform gate, and deleted afterwards
 * (unless --keep):
 *   cand     forecast → candidates (vs-base == compare, pairwise, ranking,
 *            determinism, overlap from the index, warm art=0) → explicit merge
 *            of one winner → losers open and abandonable → final overlap and
 *            forecast (VAL-CAND-001..004/006, VAL-COST-015, VAL-CROSS-010)
 *   bounds   6 then 12 workspaces on one shared path: constant d1, sub-
 *            quadratic rows read, 8-workspace cap, 422 over the cap, invalid
 *            input, requested-base consistency, abandoned exclusion
 *            (VAL-WORKFLOW-004, VAL-COST-025)
 *   arena    create 3 (and 2, 8; 1 and 9 rejected), ranked candidates with a
 *            separate duplication report, 120 s stasis, recorded selection,
 *            a human resolves the final-selection escalation, winner merged
 *            through its change set, loser abandoned
 *            (VAL-ARENA-001..004)
 *   compose  disjoint composition equal to `git merge-tree --write-tree`,
 *            path selection from conflicting attempts, incompatible and
 *            partially compatible pairs refused with no ref or record
 *            (VAL-COMPOSE-001..002)
 *   gate     two candidates with change sets, so kvarm/guard (the real
 *            checks-gate producer) judges both heads; a required `test` run
 *            reported failing on B and passing on A (POST check-runs, ci
 *            scope) ranks A above B with B's failing check shown (VAL-CAND-005)
 *
 * refs/heads/agents/** is reserved against human pushes, so each section
 * mints a short-lived write agent token (refs/heads/agents/*) for workspace
 * creation and pushes, and revokes it and its scratch agent at section end.
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/candidates-e2e.mjs [--keep] [--only cand,bounds,arena,compose,gate]
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
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm6a-candidates-overlap';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = {};
const scratchAgents = new Set();
const scratchTokens = new Map();

function die(msg) {
  console.error(`candidates-e2e: ${msg}`);
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

const work = mkdtempSync(join(tmpdir(), 'candidates-e2e-'));
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
const SHA = /^[0-9a-f]{40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort();

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
      } finally {
        for (const [tokenId, agentId] of scratchTokens) await http(`/api/v1/agents/${agentId}/tokens/${tokenId}`, { method: 'DELETE' });
        scratchTokens.clear();
        for (const agentId of scratchAgents) await http(`/api/v1/agents/${agentId}`, { method: 'DELETE' });
        scratchAgents.clear();
      }
    },
  );
  if (!r.ok) check(purpose, 'fixture repo', false, r.reason);
  if (!opts.keep && r.created) {
    const gone = await http(repoPath(repo));
    check(purpose, 'scratch repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
  }
}

const SHARED_TXT = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const BASE_FILES = {
  'README.md': 'readme\n',
  'src/app.ts': 'export const app = 1;\n',
  'docs/guide.md': '# guide\n',
  'shared.txt': SHARED_TXT,
};

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

function commitOn(dir, from, files, msg) {
  mustGit(['checkout', '-q', '--detach', from], dir);
  writeFiles(dir, files);
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

function pushTo(dir, url, sha, ref, token = PAT) {
  const r = git(['push', '--porcelain', url, `${sha}:${ref}`], dir, token);
  const okLine = r.out.split('\n').find((l) => l.includes(ref));
  return { ...r, ok: r.code === 0 && Boolean(okLine) && !okLine.startsWith('!'), line: okLine ?? '' };
}

/**
 * Mints a short-lived write agent token for refs/heads/agents/* on `repo`:
 * that namespace is reserved against human pushes, so workspace pushes need an
 * agent principal. The agent and token are revoked when the scenario ends.
 */
async function agentToken(repo, purpose) {
  const agent = await http('/api/v1/agents', { method: 'POST', json: { name: `${PREFIX}-${purpose}-${TS}`, description: `candidates ${purpose} e2e` } });
  if (agent.status !== 201) throw new Error(`create ${purpose} agent -> ${agent.status} ${agent.text}`);
  scratchAgents.add(agent.json.agent.id);
  const minted = await http(`/api/v1/agents/${agent.json.agent.id}/tokens`, {
    method: 'POST',
    json: { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 900 },
  });
  if (minted.status !== 201) throw new Error(`mint ${purpose} agent token -> ${minted.status} ${minted.json?.code ?? ''}`);
  scratchTokens.set(minted.json.id, agent.json.agent.id);
  return minted.json.token;
}

async function createWs(api, body, token = PAT) {
  const r = await http(`${api}/workspaces`, { method: 'POST', json: body, token });
  if (r.status !== 201) throw new Error(`create workspace -> ${r.status} ${r.text}`);
  return r.json;
}

/** Polls GET intent until the Nexus index observed `sha` as the workspace head. */
async function waitObserved(api, id, sha, timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await http(`${api}/workspaces/${id}/intent`);
    if (r.json?.headSha === sha) return r.json;
    await sleep(1500);
  }
  throw new Error(`workspace ${id} never observed ${sha}`);
}

/** Commits `files` on main, pushes them to the workspace ref and waits until the index observed them. */
async function pushWork(env, ws, files, msg, token = PAT) {
  const sha = commitOn(env.dir, env.main, files, msg);
  const r = pushTo(env.dir, env.url, sha, ws.ref, token);
  if (!r.ok) throw new Error(`push ${msg}: ${r.err || r.line}`);
  await waitObserved(env.api, ws.id, sha);
  return sha;
}

const fileKey = (files) => files.map((f) => `${f.status}:${f.path}${f.oldPath ? `<-${f.oldPath}` : ''}`);
const totalsKey = (t) => ({ files: t.files, additions: t.additions, deletions: t.deletions });

/** Each candidate's vs-base files and totals against `GET compare/<base>...<branch>`. */
async function compareMatches(api, base, cands) {
  const out = [];
  for (const c of cands) {
    const cmp = await http(`${api}/compare/${base}...${c.branch}`);
    const same = cmp.status === 200 && eq(fileKey(c.vsBase.files), fileKey(cmp.json.files)) && eq(totalsKey(c.vsBase.totals), totalsKey(cmp.json.totals));
    console.log(`  compare/${base}...${c.branch} -> ${cmp.status} files=${JSON.stringify(fileKey(cmp.json?.files ?? []))} totals=${JSON.stringify(cmp.json?.totals)} | candidates: files=${JSON.stringify(fileKey(c.vsBase.files))} totals=${JSON.stringify(c.vsBase.totals)}`);
    out.push({ workspace: c.workspace, same });
  }
  return out;
}

function totalOrder(ranking, ids) {
  const listed = ranking.map((e) => e.workspace);
  return listed.length === ids.length && eq(sorted(listed), sorted(ids)) && ranking.every((e, i) => e.rank === i + 1);
}

// ---------------------------------------------------------------------------

await scenario('cand', async (repo) => {
  const env = await seeded(repo);
  const { api, url, dir } = env;
  const tok = await agentToken(repo, 'cand');
  const A = await createWs(api, { task: 'approach A', agent: 'cand-a', intent: { paths: ['src/'] } }, tok);
  const B = await createWs(api, { task: 'approach B', agent: 'cand-b' }, tok);
  const C = await createWs(api, { task: 'approach C', agent: 'cand-c', intent: { paths: ['src/app.ts'] } }, tok);
  const shaA = await pushWork(env, A, { 'src/app.ts': 'export const app = "A";\n', 'src/a.ts': 'export const a = 1;\n' }, 'A', tok);
  const shaB = await pushWork(env, B, { 'docs/b.md': '# b\n', 'lib/b.ts': 'export const b = 2;\n' }, 'B', tok);
  const shaC = await pushWork(env, C, { 'src/app.ts': 'export const app = "C";\nexport const c = 3;\n', 'src/c.ts': 'export const c = 3;\n' }, 'C', tok);

  // VAL-CROSS-010: the forecast for the shared path shows the overlapping workspaces with a confidence class.
  const f0 = await http(`${api}/forecast?paths=src/app.ts&base=main`, { label: 'GET forecast' });
  const fm = Object.fromEntries((f0.json?.matches ?? []).map((m) => [m.workspace, m.matchKind]));
  console.log(`GET forecast?paths=src/app.ts -> ${f0.status} ${JSON.stringify(fm)}`);
  check('VAL-CROSS-010', 'forecast for src/app.ts lists A and C (each with a match class), not B', f0.status === 200 && fm[A.id] && fm[C.id] && !fm[B.id], JSON.stringify(fm));

  // VAL-CAND-001 / VAL-CAND-002
  const ab = await http(`${api}/candidates?base=main&workspaces=${A.id},${B.id}`, { label: 'GET candidates (2)' });
  console.log(`GET candidates?base=main&workspaces=A,B -> ${ab.status} (x-kvarm-cost ${ab.cost})`);
  const cands = ab.json?.candidates ?? [];
  check('VAL-CAND-001', 'both candidates present in request order with their pushed heads', ab.status === 200 && eq(cands.map((c) => c.workspace), [A.id, B.id]) && cands[0].headSha === shaA && cands[1].headSha === shaB);
  const matches = await compareMatches(api, 'main', cands);
  check('VAL-CAND-001', 'each vs-base file list (path+status) and totals equal GET compare/main...<ref>', matches.length === 2 && matches.every((m) => m.same), JSON.stringify(matches));
  const pair = (ab.json?.pairwise ?? []).find((p) => eq(sorted(p.workspaces), sorted([A.id, B.id])));
  const pairPaths = pair?.files?.map((f) => f.path) ?? [];
  console.log(`pairwise (A,B): ${JSON.stringify(pair)}`);
  check(
    'VAL-CAND-002',
    'pairwise (A,B) lists both sides\' distinct paths (src/a.ts, src/app.ts from A; docs/b.md, lib/b.ts from B)',
    pair && ['src/a.ts', 'src/app.ts', 'docs/b.md', 'lib/b.ts'].every((p) => pairPaths.includes(p)) && pair.fileCount === 4 && pair.truncated === false,
    JSON.stringify(pairPaths),
  );

  // VAL-CAND-003 / VAL-CAND-004 / VAL-COST-015
  const q = `${api}/candidates?base=main&workspaces=${A.id},${B.id},${C.id}`;
  const r1 = await http(q, { label: 'GET candidates (3)' });
  const r2 = await http(q, { label: 'GET candidates (3)' });
  console.log(`GET candidates A,B,C #1 (x-kvarm-cost ${r1.cost})\n  #2 (x-kvarm-cost ${r2.cost})`);
  console.log(`ranking: ${JSON.stringify(r1.json?.ranking)}\nrankingFactors: ${JSON.stringify(r1.json?.rankingFactors)}\noverlap: ${JSON.stringify(r1.json?.overlap)}`);
  const ranking = r1.json?.ranking ?? [];
  const factorNames = r1.json?.rankingFactors ?? [];
  check(
    'VAL-CAND-003',
    'ranking totally orders A, B, C once each with stated factors on every entry',
    r1.status === 200 &&
      r1.json.candidates[2]?.headSha === shaC &&
      totalOrder(ranking, [A.id, B.id, C.id]) &&
      ranking.every((e) => ['checks', 'complete', 'riskScore', 'riskLevel', 'overlapSharedPaths', 'changedLines', 'changedFiles'].every((k) => k in e.factors)) &&
      eq(factorNames, ['checks', 'complete', 'riskScore', 'overlapSharedPaths', 'changedLines', 'changedFiles', 'workspace']),
  );
  const ovPair = (r1.json?.overlap?.pairs ?? []).find((p) => eq(sorted(p.workspaces), sorted([A.id, C.id])));
  const rankOf = Object.fromEntries(ranking.map((e) => [e.workspace, e.factors.overlapSharedPaths]));
  check(
    'VAL-CAND-003',
    'overlap factor comes from the Nexus index: (A,C) share src/app.ts; B shares nothing',
    r1.json?.overlap?.source === 'nexus-index' && eq(ovPair?.paths, ['src/app.ts']) && rankOf[A.id] === 1 && rankOf[C.id] === 1 && rankOf[B.id] === 0 && r1.json.overlap.pairs.length === 1,
    JSON.stringify(rankOf),
  );
  check('VAL-CAND-004', 'two identical calls return byte-identical ranking arrays (and bodies)', eq(r1.json?.ranking, r2.json?.ranking) && r1.text === r2.text);
  // d1 = 3 since kvarm/guard made the checks gate read D1 (library/cost.md, warm candidates row).
  check('VAL-COST-015', 'second identical candidates call: art=0, do=0, d1 <= 3', r2.c.art === 0 && r2.c.do === 0 && r2.c.d1 <= 3, `#1 ${r1.cost} | #2 ${r2.cost}`);
  const o1 = await http(`${api}/workspaces/overlap?base=main`, { label: 'GET workspaces/overlap' });
  const o2 = await http(`${api}/workspaces/overlap?base=main`, { label: 'GET workspaces/overlap' });
  console.log(`GET workspaces/overlap #1 (x-kvarm-cost ${o1.cost}) #2 (x-kvarm-cost ${o2.cost}) -> ${o2.text}`);
  check('VAL-COST-015', 'second identical overlap call: art=0, do=0, d1 <= 2', o2.status === 200 && o2.c.art === 0 && o2.c.do === 0 && o2.c.d1 <= 2, `#1 ${o1.cost} | #2 ${o2.cost}`);

  // VAL-CAND-006 / VAL-CROSS-010: explicit selection of one winner; nothing automatic.
  const cs = {};
  for (const [name, ws] of [['A', A], ['B', B], ['C', C]]) {
    const r = await http(`${api}/workspaces/${ws.id}/change-set`, { method: 'POST', json: { title: `approach ${name}` } });
    cs[name] = r.json?.number;
    console.log(`POST change-set ${name} -> ${r.status} #${r.json?.number} state=${r.json?.state} mergePolicy=${r.json?.mergePolicy}`);
  }
  const r3 = await http(q);
  check('VAL-CROSS-010', 'ranking unchanged after opening change sets (deterministic); nothing auto-selected', eq(r3.json?.ranking?.map((e) => e.workspace), ranking.map((e) => e.workspace)));
  const states0 = await Promise.all(['A', 'B', 'C'].map(async (n) => (await http(`${api}/changes/${cs[n]}`)).json?.state));
  check('VAL-CROSS-010', 'before the explicit merge all three change sets are open', eq(states0, ['open', 'open', 'open']), JSON.stringify(states0));
  const m = await http(`${api}/changes/${cs.A}/merge`, { method: 'POST' });
  console.log(`POST changes/${cs.A}/merge (A, chosen by the caller) -> ${m.status} state=${m.json?.state} mergeCommit=${m.json?.mergeCommit}`);
  const gotB = await http(`${api}/changes/${cs.B}`);
  const gotC = await http(`${api}/changes/${cs.C}`);
  check(
    'VAL-CAND-006',
    'winner A merged; overlapping losers remain live (open or reconciled conflicted)',
    m.status === 200 &&
      m.json?.state === 'merged' &&
      ['open', 'conflicted'].includes(gotB.json?.state) &&
      ['open', 'conflicted'].includes(gotC.json?.state),
    `B=${gotB.json?.state} C=${gotC.json?.state}`,
  );
  const abandonB = await http(`${api}/workspaces/${B.id}/abandon`, { method: 'POST' });
  const wsB = await http(`${api}/workspaces/${B.id}`);
  const wsC = await http(`${api}/workspaces/${C.id}`);
  console.log(`POST workspaces/${B.id}/abandon -> ${abandonB.status} status=${abandonB.json?.status}`);
  check('VAL-CAND-006', 'loser B abandons cleanly; C stays active', abandonB.status === 200 && wsB.json?.status === 'abandoned' && wsC.json?.status === 'active');
  const o3 = await http(`${api}/workspaces/overlap?base=main`);
  console.log(`overlap after merging A: ${o3.text}`);
  check('VAL-CROSS-010', 'after the merge, overlap no longer pairs merged A with the open C', o3.status === 200 && !(o3.json?.pairs ?? []).some((p) => p.workspaces.includes(A.id)));
  const f1 = await http(`${api}/forecast?paths=src/app.ts&base=main`);
  const fm1 = (f1.json?.matches ?? []).map((x) => x.workspace);
  const refs = lsRemoteAll(url);
  mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
  const mainApp = mustGit(['show', 'origin/main:src/app.ts'], dir);
  console.log(`final forecast src/app.ts: ${JSON.stringify(fm1)}; main=${refs['refs/heads/main']?.slice(0, 8)} src/app.ts=${JSON.stringify(mainApp)}`);
  check(
    'VAL-CROSS-010',
    "final forecast lists only the open C (winner A is published on main, its src/app.ts content is A's)",
    eq(fm1, [C.id]) && mainApp === 'export const app = "A";' && refs['refs/heads/main'] === m.json?.mergeCommit,
  );
});

await scenario('bounds', async (repo) => {
  const env = await seeded(repo);
  const { api, dir, url, main } = env;
  await pushRetry(dir, url, [`${main}:refs/heads/dev`]);
  const tok = await agentToken(repo, 'bounds');
  const ws = [];
  const addWorkspaces = async (from, to) => {
    for (let i = from; i < to; i++) {
      const w = await createWs(api, { task: `tiny ${i}`, agent: `bound-${i}` }, tok);
      const files = { [`own/f${i}.ts`]: `export const f = ${i};\n` };
      if (i < 9) files['shared/common.ts'] = `export const by = ${i};\n`;
      await pushWork(env, w, files, `tiny ${i}`, tok);
      ws.push(w);
    }
  };
  const measure = async (path, label) => {
    await http(path);
    const r = await http(path, { label });
    return r;
  };
  await addWorkspaces(0, 6);
  const four = ws.slice(0, 4).map((w) => w.id).join(',');
  const c6 = await measure(`${api}/candidates?base=main&workspaces=${four}`, 'GET candidates (4, warm)');
  const ov6 = await measure(`${api}/workspaces/overlap?base=main`, 'GET workspaces/overlap (warm)');
  console.log(`N=6 warm candidates(4): ${c6.cost}\nN=6 warm overlap: ${ov6.cost}`);
  await addWorkspaces(6, 12);
  const c12 = await measure(`${api}/candidates?base=main&workspaces=${four}`, 'GET candidates (4, warm)');
  const ov12 = await measure(`${api}/workspaces/overlap?base=main`, 'GET workspaces/overlap (warm)');
  console.log(`N=12 warm candidates(4): ${c12.cost}\nN=12 warm overlap: ${ov12.cost}`);
  check('VAL-COST-025', 'warm candidates: same d1 at N=6 and N=12, art=0, do=0', c6.c.d1 === c12.c.d1 && c6.c.art === 0 && c12.c.art === 0 && c12.c.do === 0, `${c6.cost} | ${c12.cost}`);
  check('VAL-COST-025', 'warm candidates rows read grow < 4x when N doubles', c12.c.rr < 4 * Math.max(1, c6.c.rr), `rr ${c6.c.rr} -> ${c12.c.rr}`);
  check('VAL-COST-025', 'warm overlap: same d1 at N=6 and N=12, art=0, do=0, rows read < 4x', ov6.c.d1 === ov12.c.d1 && ov12.c.art === 0 && ov12.c.do === 0 && ov12.c.rr < 4 * Math.max(1, ov6.c.rr), `${ov6.cost} | ${ov12.cost}`);

  // VAL-WORKFLOW-004
  const eight = ws.slice(0, 8).map((w) => w.id);
  const c8a = await http(`${api}/candidates?base=main&workspaces=${eight.join(',')}`, { label: 'GET candidates (8)' });
  const c8 = await http(`${api}/candidates?base=main&workspaces=${eight.join(',')}`, { label: 'GET candidates (8)' });
  console.log(`GET candidates (8 = cap) -> ${c8.status} truncated=${c8.json?.truncated} candidates=${c8.json?.candidates?.length} pairwise=${c8.json?.pairwise?.length} overlapPairs=${c8.json?.overlap?.pairs?.length} (cold ${c8a.cost} | warm ${c8.cost})`);
  check(
    'VAL-WORKFLOW-004',
    'at the cap (8): 200, all 8 summarized and ranked, 28 pairwise diffs, truncated:false (nothing omitted)',
    c8.status === 200 && c8.json.candidates.length === 8 && c8.json.ranking.length === 8 && c8.json.pairwise.length === 28 && c8.json.truncated === false && c8.json.overlap.truncated === false,
  );
  check('VAL-COST-025', 'warm 8-candidate call keeps the same d1 as the 4-candidate call, art=0', c8.c.d1 === c12.c.d1 && c8.c.art === 0 && c8.c.do === 0, c8.cost);
  const all12 = ws.map((w) => w.id).join(',');
  const over = await http(`${api}/candidates?base=main&workspaces=${all12}`, { label: 'GET candidates (over cap)' });
  console.log(`GET candidates (12 > cap) -> ${over.status} ${over.text} (x-kvarm-cost ${over.cost})`);
  check('VAL-WORKFLOW-004', '12 workspaces → 422 TOO_MANY_CANDIDATES naming the cap (8), no comparison work (art=0)', over.status === 422 && over.json?.code === 'TOO_MANY_CANDIDATES' && over.json?.limit === 8 && over.json?.requested === 12 && over.c.art === 0);
  const ovAll = await http(`${api}/workspaces/overlap?base=main`);
  const sharedPairs = (ovAll.json?.pairs ?? []).filter((p) => p.paths.includes('shared/common.ts'));
  console.log(`GET workspaces/overlap (12 active, 9 on shared/common.ts) -> ${ovAll.status} pairs=${ovAll.json?.pairs?.length} truncated=${ovAll.json?.truncated} truncatedReason=${ovAll.json?.truncatedReason ?? null} nextCursor=${ovAll.json?.nextCursor ?? null}`);
  check(
    'VAL-WORKFLOW-004',
    'overlap with 12 workspaces: 200, bounded, explicit truncated flag (reason + cursor whenever truncated)',
    ovAll.status === 200 && typeof ovAll.json?.truncated === 'boolean' && (ovAll.json.truncated ? typeof ovAll.json.truncatedReason === 'string' : sharedPairs.length === 36),
    `shared pairs=${sharedPairs.length}`,
  );

  // Invalid input and requested-base consistency.
  const cases = [
    ['no workspaces', `${api}/candidates?base=main`, 400, 'INVALID_WORKSPACES'],
    ['duplicate id', `${api}/candidates?base=main&workspaces=${ws[0].id},${ws[0].id}`, 400, 'DUPLICATE_WORKSPACES'],
    ['malformed id', `${api}/candidates?base=main&workspaces=..%2Fetc`, 400, 'INVALID_WORKSPACES'],
    ['unknown id', `${api}/candidates?base=main&workspaces=${ws[0].id},zzzzzzzzzzzzzzzzzzzzzzzzzz`, 404, 'WORKSPACE_NOT_FOUND'],
    ['missing base', `${api}/candidates?base=nope&workspaces=${ws[0].id}`, 422, 'REF_NOT_FOUND'],
  ];
  for (const [name, path, status, code] of cases) {
    const r = await http(path);
    check('VAL-WORKFLOW-004', `${name} → ${status} ${code}`, r.status === status && r.json?.code === code && typeof r.json?.error === 'string', `${r.status} ${r.text.slice(0, 160)}`);
  }
  const dev = await http(`${api}/candidates?base=dev&workspaces=${ws[0].id}`);
  check('VAL-WORKFLOW-004', 'requested base dev differs from the workspace base: baseMatches false, compared against dev', dev.status === 200 && dev.json.base.ref === 'dev' && dev.json.candidates[0].baseMatches === false && dev.json.candidates[0].workspaceBase === 'main');
  const ab = await http(`${api}/workspaces/${ws[11].id}/abandon`, { method: 'POST' });
  const ex = await http(`${api}/candidates?base=main&workspaces=${ws[10].id},${ws[11].id}`);
  console.log(`abandon ws11 -> ${ab.status}; candidates(ws10, ws11): candidates=${JSON.stringify(ex.json?.candidates?.map((c) => c.workspace))} excluded=${JSON.stringify(ex.json?.excluded)}`);
  check(
    'VAL-WORKFLOW-004',
    'an abandoned workspace is listed in excluded with its reason, never silently dropped',
    ex.status === 200 && eq(ex.json.candidates.map((c) => c.workspace), [ws[10].id]) && eq(ex.json.excluded, [{ workspace: ws[11].id, status: 'abandoned', reason: 'workspace is abandoned' }]) && ex.json.ranking.length === 1,
  );
});

// W1 and W2 edit distant lines of this file: they still share src/auth.ts in the
// duplication report, but W2 merges cleanly after W1, so the loser stays open.
const AUTH_TS = ['export const auth = "v0";', ...Array.from({ length: 8 }, (_, i) => `// note ${i + 1}`), 'export const mode = "base";'].join('\n') + '\n';

await scenario('arena', async (repo) => {
  const env = await seeded(repo, { ...BASE_FILES, 'src/auth.ts': AUTH_TS });
  const { api, url, main, dir } = env;
  const arenasCount = async () => (await http(`${api}/arenas?limit=100`)).json?.arenas?.length;
  const wsCount = async () => (await http(`${api}/workspaces?limit=100`)).json?.workspaces?.length;

  // The agent creates the arena (and so its workspaces) and pushes; selection,
  // the final-selection confirmation and the merge stay with the human PAT.
  const tok = await agentToken(repo, 'arena');

  // VAL-ARENA-001
  const mk = await http(`${api}/arenas`, { method: 'POST', json: { brief: 'Refactor auth module', base: 'main', candidates: 3 }, token: tok, label: 'POST arenas (3)' });
  const arena = mk.json ?? {};
  console.log(`POST arenas {candidates:3} -> ${mk.status} (x-kvarm-cost ${mk.cost}) id=${arena.id} state=${arena.state} workspaces=${JSON.stringify(arena.workspaces?.map((w) => ({ id: w.id, ref: w.ref, headSha: w.headSha?.slice(0, 8), arena: w.arena })))}`);
  const refs0 = lsRemoteAll(url);
  check(
    'VAL-ARENA-001',
    '201 {id, brief, base, state:open} with 3 workspace records, refs/heads/agents/<id>/… at the base head, pushUrl',
    mk.status === 201 &&
      arena.brief === 'Refactor auth module' &&
      arena.base === 'main' &&
      arena.state === 'open' &&
      arena.workspaces?.length === 3 &&
      arena.workspaces.every((w) => w.ref.startsWith(`refs/heads/agents/${w.id}/`) && refs0[w.ref] === main && w.baseSha === main && w.pushUrl === url && w.status === 'active' && w.arena === arena.id),
  );
  const g = await http(`${api}/arenas/${arena.id}`, { label: 'GET arenas/:id' });
  check('VAL-ARENA-001', 'GET arenas/:id returns the same record', g.status === 200 && g.text === JSON.stringify(arena), g.cost);
  const nA = await arenasCount();
  const nW = await wsCount();
  for (const n of [1, 9]) {
    const r = await http(`${api}/arenas`, { method: 'POST', json: { brief: 'out of bounds', base: 'main', candidates: n }, token: tok });
    const after = [await arenasCount(), await wsCount()];
    check('VAL-ARENA-001', `candidates:${n} → 4xx {error} with no arena row and no workspace`, r.status >= 400 && r.status < 500 && typeof r.json?.error === 'string' && eq(after, [nA, nW]), `${r.status} ${r.text}; arenas ${nA}->${after[0]} workspaces ${nW}->${after[1]}`);
  }
  const refsMid = lsRemoteAll(url);
  check('VAL-ARENA-001', 'rejected requests created no refs', Object.keys(refsMid).length === Object.keys(refs0).length);
  for (const n of [2, 8]) {
    const r = await http(`${api}/arenas`, { method: 'POST', json: { brief: `bounds ${n}`, base: 'main', candidates: n }, token: tok, label: `POST arenas (${n})` });
    check('VAL-ARENA-001', `candidates:${n} accepted with ${n} workspaces`, r.status === 201 && r.json?.workspaces?.length === n, `${r.status} (x-kvarm-cost ${r.cost})`);
  }

  // VAL-ARENA-002
  const [W1, W2, W3] = arena.workspaces;
  await pushWork(env, W1, { 'src/auth.ts': AUTH_TS.replace('"v0"', '"v1"'), 'src/w1.ts': 'export const w1 = 1;\n' }, 'W1 refactor', tok);
  await pushWork(env, W2, { 'src/auth.ts': AUTH_TS.replace('"base";\n', '"v2";\nexport const extra = 2;\n') }, 'W2 refactor', tok);
  await pushWork(env, W3, { 'lib/auth/index.ts': 'export const auth = "v3";\n' }, 'W3 refactor', tok);
  const q = `${api}/arenas/${arena.id}/candidates`;
  const c1 = await http(q, { label: 'GET arenas/:id/candidates' });
  const c2 = await http(q, { label: 'GET arenas/:id/candidates' });
  console.log(`GET arenas/:id/candidates #1 (x-kvarm-cost ${c1.cost}) #2 (x-kvarm-cost ${c2.cost})\nranking: ${JSON.stringify(c1.json?.ranking)}\nduplication: ${JSON.stringify(c1.json?.duplication)}`);
  const ids = [W1.id, W2.id, W3.id];
  const ac = c1.json?.candidates ?? [];
  const arenaMatches = await compareMatches(api, 'main', ac);
  check('VAL-ARENA-002', 'every candidate present; vs-base summaries equal GET compare/main...<ref>', c1.status === 200 && eq(ac.map((c) => c.workspace), ids) && arenaMatches.every((m) => m.same), JSON.stringify(arenaMatches));
  const ranking = c1.json?.ranking ?? [];
  check(
    'VAL-ARENA-002',
    'ranking orders all 3 once each with stated factors, and no overlap factor (duplication is not a ranking input)',
    totalOrder(ranking, ids) &&
      ranking.every((e) => 'checks' in e.factors && 'riskScore' in e.factors && !('overlapSharedPaths' in e.factors)) &&
      !c1.json.rankingFactors.includes('overlapSharedPaths') &&
      c1.json.overlap === undefined,
  );
  const dup = c1.json?.duplication ?? {};
  check(
    'VAL-ARENA-002',
    'duplication report lists exactly the (W1,W2) pair sharing src/auth.ts, with the documented threshold',
    dup.minSharedPaths === 1 && dup.source === 'nexus-index' && dup.pairs?.length === 1 && eq(sorted(dup.pairs[0].workspaces), sorted([W1.id, W2.id])) && eq(dup.pairs[0].paths, ['src/auth.ts']),
  );
  check('VAL-ARENA-002', 'repeated call is byte-identical; warm call art=0, do=0', c1.text === c2.text && c2.c.art === 0 && c2.c.do === 0, c2.cost);

  // VAL-ARENA-004: change sets open, no caller action for 120 s.
  const cs = {};
  for (const w of arena.workspaces) {
    const r = await http(`${api}/workspaces/${w.id}/change-set`, { method: 'POST', json: { title: `candidate ${w.id}` } });
    cs[w.id] = r.json?.number;
  }
  const snapshot = async () => ({
    arena: (await http(`${api}/arenas/${arena.id}`)).text,
    changes: await Promise.all(ids.map(async (id) => (await http(`${api}/changes/${cs[id]}`)).json?.state)),
    workspaces: (await http(`${api}/workspaces?limit=100`)).json?.workspaces?.map((w) => `${w.id}:${w.status}:${w.arena}`).sort(),
    main: lsRemoteAll(url)['refs/heads/main'],
  });
  const s0 = await snapshot();
  console.log(`stasis start: changes=${JSON.stringify(s0.changes)} main=${s0.main.slice(0, 8)} arena state=${JSON.parse(s0.arena).state}; polling 120 s`);
  let still = true;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await sleep(20_000);
    const s = await snapshot();
    if (!eq(s, s0)) {
      still = false;
      console.log(`state changed during the window: ${JSON.stringify(s)}`);
      break;
    }
  }
  check('VAL-ARENA-004', '120 s without caller action: no merge, no new/abandoned workspace, arena unchanged, base unmoved', still && eq(s0.changes, ['open', 'open', 'open']) && s0.main === main);

  // VAL-ARENA-003
  const sel = await http(`${api}/arenas/${arena.id}/select`, { method: 'POST', json: { workspace: W1.id }, label: 'POST arenas/:id/select' });
  console.log(`POST arenas/:id/select {workspace:W1} -> ${sel.status} selection=${JSON.stringify(sel.json?.selection)} state=${sel.json?.state} (x-kvarm-cost ${sel.cost})`);
  check(
    'VAL-ARENA-003',
    '200 recording {selectedWorkspace, selectedBy, selectedAt}',
    sel.status === 200 && sel.json?.selection?.selectedWorkspace === W1.id && sel.json.selection.selectedBy?.login === OWNER && ISO.test(sel.json.selection.selectedAt),
  );
  const t1 = Date.now();
  let quiet = true;
  while (Date.now() - t1 < 60_000) {
    await sleep(15_000);
    const s = await snapshot();
    if (!eq(s.changes, ['open', 'open', 'open']) || s.main !== main) quiet = false;
  }
  check('VAL-ARENA-003', '60 s after selection: all change sets still open and base unmoved (selection is not an action)', quiet);
  // The selection opens a final-selection escalation on the winner's change set; the normal review path has a human confirm it.
  const esc = ((await http(`${api}/changes/${cs[W1.id]}/reviews`)).json?.escalations ?? []).find((e) => e.reason === 'final-selection' && e.state === 'open');
  const confirm = await http(`${api}/changes/${cs[W1.id]}/escalations/${esc?.id}/resolve`, { method: 'POST', json: { resolution: 'resolve', note: 'selection confirmed' } });
  console.log(`final-selection escalation ${esc?.id} (opened by ${esc?.openedBy}) -> human resolve ${confirm.status} state=${confirm.json?.escalation?.state}`);
  const mg = await http(`${api}/changes/${cs[W1.id]}/merge`, { method: 'POST' });
  mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
  const head = mustGit(['log', 'origin/main', '-1', '--format=%H %P'], dir);
  console.log(`POST changes/${cs[W1.id]}/merge -> ${mg.status} state=${mg.json?.state}${mg.status === 200 ? '' : ` ${mg.text.slice(0, 300)}`}; origin/main: ${head}`);
  check('VAL-ARENA-003', 'winner merged through its change set; merge commit on main', mg.status === 200 && mg.json?.state === 'merged' && head.startsWith(mg.json?.mergeCommit ?? '-') && head.includes(main));
  const losers = await Promise.all(
    [W2, W3].map(async (w) => ({ change: (await http(`${api}/changes/${cs[w.id]}`)).json?.state, status: (await http(`${api}/workspaces/${w.id}`)).json?.status })),
  );
  check('VAL-ARENA-003', 'losers: change sets open, workspaces active', losers.every((l) => l.change === 'open' && l.status === 'active'), JSON.stringify(losers));
  const ab = await http(`${api}/workspaces/${W3.id}/abandon`, { method: 'POST' });
  const after = await http(`${api}/arenas/${arena.id}`);
  const st = Object.fromEntries((after.json?.workspaces ?? []).map((w) => [w.id, w.status]));
  console.log(`abandon W3 -> ${ab.status}; GET arena: state=${after.json?.state} selection=${JSON.stringify(after.json?.selection)} statuses=${JSON.stringify(st)}`);
  check(
    'VAL-ARENA-003',
    'loser abandon succeeds; arena exposes the selection (W1 merged, W2 active, W3 abandoned)',
    ab.status === 200 && after.json?.state === 'selected' && after.json?.selection?.selectedWorkspace === W1.id && st[W1.id] === 'merged' && st[W2.id] === 'active' && st[W3.id] === 'abandoned',
  );
});

await scenario('compose', async (repo) => {
  const env = await seeded(repo);
  const { api, url, main, dir } = env;
  const tok = await agentToken(repo, 'compose');
  const A = await createWs(api, { task: 'compose A', agent: 'comp-a' }, tok);
  const B = await createWs(api, { task: 'compose B', agent: 'comp-b' }, tok);
  const shaA = await pushWork(env, A, { 'src/a.ts': 'export const a = "A";\n' }, 'A edits src/a.ts', tok);
  const shaB = await pushWork(env, B, { 'docs/b.md': '# B\n' }, 'B edits docs/b.md', tok);

  // VAL-COMPOSE-001
  const mk = await http(`${api}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [A.id, B.id] }, label: 'POST candidates/compose' });
  const k = mk.json ?? {};
  console.log(`POST candidates/compose {A,B} -> ${mk.status} (x-kvarm-cost ${mk.cost}) ${JSON.stringify({ id: k.id, base: k.base, baseSha: k.baseSha, treeSha: k.treeSha, commitSha: k.commitSha, sources: k.sources, ref: k.workspace?.ref, changeSet: k.changeSet, checks: k.checks, conflict: k.conflict })}`);
  check(
    'VAL-COMPOSE-001',
    '201 composed candidate: id, base, tree sha, sources A and B, its own workspace ref and change set',
    mk.status === 201 &&
      k.base === 'main' &&
      k.baseSha === main &&
      SHA.test(k.treeSha) &&
      eq(k.sources.map((s) => [s.workspace, s.headSha]), [[A.id, shaA], [B.id, shaB]]) &&
      k.workspace?.ref?.startsWith(`refs/heads/agents/${k.workspace.id}/`) &&
      Number.isInteger(k.changeSet) &&
      k.conflict === null &&
      k.checks?.required?.some((c) => c.name === 'kvarm/guard' && c.producer === 'check-runs'),
  );
  const rb = await http(`${api}/compositions/${k.id}`, { label: 'GET compositions/:id' });
  check('VAL-COMPOSE-001', 'GET compositions/:id reads back the same record', rb.status === 200 && rb.text === mk.text, rb.cost);
  const cmp = await http(`${api}/compare/main...${k.workspace?.branch}`);
  const paths = (cmp.json?.files ?? []).map((f) => f.path);
  console.log(`GET compare/main...${k.workspace?.branch} -> ${cmp.status} files=${JSON.stringify(fileKey(cmp.json?.files ?? []))}`);
  check('VAL-COMPOSE-001', 'compare main...<composed ref> lists exactly the union {docs/b.md, src/a.ts}', cmp.status === 200 && eq(paths, ['docs/b.md', 'src/a.ts']));
  const refs = lsRemoteAll(url);
  mustGit(['fetch', '-q', url, `+${k.workspace.ref}:refs/remotes/composed`], dir);
  const fetchedTree = mustGit(['rev-parse', 'refs/remotes/composed^{tree}'], dir);
  const mergeTree = mustGit(['merge-tree', '--write-tree', shaA, shaB], dir);
  const parent = mustGit(['rev-parse', 'refs/remotes/composed^'], dir);
  const show = [mustGit(['show', 'refs/remotes/composed:src/a.ts'], dir), mustGit(['show', 'refs/remotes/composed:docs/b.md'], dir), mustGit(['show', 'refs/remotes/composed:src/app.ts'], dir)];
  console.log(`ls-remote ${k.workspace.ref} = ${refs[k.workspace.ref]}; fetched tree ${fetchedTree}; git merge-tree --write-tree A B = ${mergeTree}; parent ${parent.slice(0, 8)}; contents ${JSON.stringify(show)}`);
  check(
    'VAL-COMPOSE-001',
    'fresh fetch: tree == record tree == git merge-tree --write-tree; both edits intact; base content elsewhere unchanged; parent is base',
    refs[k.workspace.ref] === k.commitSha && fetchedTree === k.treeSha && mergeTree === k.treeSha && parent === main && eq(show, ['export const a = "A";', '# B', 'export const app = 1;']),
  );

  // Compatible pieces chosen by path from attempts that conflict as a whole.
  const C = await createWs(api, { task: 'compose C', agent: 'comp-c' }, tok);
  const D = await createWs(api, { task: 'compose D', agent: 'comp-d' }, tok);
  await pushWork(env, C, { 'src/app.ts': 'export const app = "C";\n', 'docs/c.md': '# C\n' }, 'C', tok);
  await pushWork(env, D, { 'src/app.ts': 'export const app = "D";\n', 'lib/d.ts': 'export const d = 4;\n' }, 'D', tok);
  const pick = await http(`${api}/candidates/compose`, {
    method: 'POST',
    json: { base: 'main', workspaces: [{ workspace: C.id, paths: ['src/app.ts'] }, { workspace: D.id, paths: ['lib/'] }] },
    label: 'POST candidates/compose',
  });
  const pickCmp = await http(`${api}/compare/main...${pick.json?.workspace?.branch}`);
  console.log(`compose C[src/app.ts] + D[lib/] -> ${pick.status} sources=${JSON.stringify(pick.json?.sources?.map((s) => [s.workspace, s.paths]))}; compare files=${JSON.stringify(fileKey(pickCmp.json?.files ?? []))}`);
  mustGit(['fetch', '-q', url, `+${pick.json?.workspace?.ref}:refs/remotes/picked`], dir);
  const pickedApp = mustGit(['show', 'refs/remotes/picked:src/app.ts'], dir);
  check(
    'VAL-COMPOSE-001',
    'selected paths compose: C\'s src/app.ts + D\'s lib/d.ts only (docs/c.md and D\'s src/app.ts left out)',
    pick.status === 201 && eq(pickCmp.json?.files?.map((f) => f.path), ['lib/d.ts', 'src/app.ts']) && pickedApp === 'export const app = "C";',
  );

  // VAL-COMPOSE-002
  const E = await createWs(api, { task: 'compose E', agent: 'comp-e' }, tok);
  const F = await createWs(api, { task: 'compose F', agent: 'comp-f' }, tok);
  await pushWork(env, E, { 'shared.txt': SHARED_TXT.replace('line 2\n', 'line 2 by E\n'), 'src/app.ts': 'export const app = "E";\n' }, 'E', tok);
  await pushWork(env, F, { 'shared.txt': SHARED_TXT.replace('line 11\n', 'line 11 by F\n'), 'src/app.ts': 'export const app = "F";\n' }, 'F', tok);
  const before = { list: (await http(`${api}/compositions?limit=100`)).json?.compositions?.length, refs: lsRemoteAll(url) };
  const bad = await http(`${api}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [C.id, D.id] }, label: 'POST candidates/compose (conflict)' });
  console.log(`compose C+D (same line of src/app.ts) -> ${bad.status} ${bad.text} (x-kvarm-cost ${bad.cost})`);
  check(
    'VAL-COMPOSE-002',
    '409 COMPOSITION_CONFLICT, textual kind, report names src/app.ts with the conflicting workspaces and hunks',
    bad.status === 409 &&
      bad.json?.code === 'COMPOSITION_CONFLICT' &&
      bad.json?.conflictKind === 'textual' &&
      eq(bad.json?.incompatible, ['src/app.ts']) &&
      bad.json?.conflicts?.some((c) => c.path === 'src/app.ts' && c.workspace === D.id && eq(c.with, [C.id]) && Number.isInteger(c.hunks)),
  );
  const part = await http(`${api}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [E.id, F.id] } });
  console.log(`compose E+F (shared.txt mergeable, src/app.ts conflicting) -> ${part.status} ${part.text}`);
  check('VAL-COMPOSE-002', 'partially compatible pair → 409 naming only src/app.ts (shared.txt merges cleanly, no silent partial composition)', part.status === 409 && eq(part.json?.incompatible, ['src/app.ts']) && part.json.conflicts.every((c) => c.path !== 'shared.txt'));
  const unmatched = await http(`${api}/candidates/compose`, { method: 'POST', json: { base: 'main', workspaces: [{ workspace: C.id, paths: ['nothing/here.ts'] }, D.id] } });
  check('VAL-COMPOSE-002', 'a selected path matching no change → 422 SELECTION_UNMATCHED naming it', unmatched.status === 422 && unmatched.json?.code === 'SELECTION_UNMATCHED' && eq(unmatched.json?.unmatched, [{ workspace: C.id, path: 'nothing/here.ts' }]), unmatched.text);
  const after = { list: (await http(`${api}/compositions?limit=100`)).json?.compositions?.length, refs: lsRemoteAll(url) };
  const newRefs = Object.keys(after.refs).filter((r) => !(r in before.refs));
  console.log(`after refused compositions: compositions ${before.list} -> ${after.list}; new refs ${JSON.stringify(newRefs)}`);
  check('VAL-COMPOSE-002', 'no composition record and no ref created by the refused requests', after.list === before.list && newRefs.length === 0 && eq(after.refs, before.refs));
});

await scenario('gate', async (repo) => {
  const env = await seeded(repo);
  const { api } = env;
  const agent = await http('/api/v1/agents', { method: 'POST', json: { name: `${PREFIX}-gate-${TS}`, description: 'candidates gate e2e' } });
  if (agent.status !== 201) throw new Error(`create gate agent -> ${agent.status} ${agent.text}`);
  scratchAgents.add(agent.json.agent.id);
  const minted = await http(`/api/v1/agents/${agent.json.agent.id}/tokens`, {
    method: 'POST',
    json: { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 900 },
  });
  if (minted.status !== 201) throw new Error(`mint gate agent token -> ${minted.status} ${minted.text}`);
  const agentToken = minted.json.token;
  const A = await createWs(api, { task: 'gate A' }, agentToken);
  const B = await createWs(api, { task: 'gate B' }, agentToken);
  // Structurally alike edits, so nothing but the reported checks separates them.
  const shaA = await pushWork(env, A, { 'src/a.ts': 'export const a = 1;\n' }, 'A', agentToken);
  const shaB = await pushWork(env, B, { 'src/b.ts': 'export const b = 1;\n' }, 'B', agentToken);
  for (const [name, ws] of [['A', A], ['B', B]]) {
    const r = await http(`${api}/workspaces/${ws.id}/change-set`, { method: 'POST', json: { title: `gate ${name}` } });
    console.log(`POST workspaces/${ws.id}/change-set -> ${r.status} #${r.json?.number} checks=${JSON.stringify(r.json?.checks?.map((c) => [c.name, c.headSha?.slice(0, 8), c.status]))}`);
    if (r.status !== 201) throw new Error(`change set ${name} -> ${r.status} ${r.text}`);
  }
  const q = `${api}/candidates?base=main&workspaces=${A.id},${B.id}`;
  const view = (r) =>
    Object.fromEntries((r.json?.candidates ?? []).map((c) => [c.workspace === A.id ? 'A' : 'B', { state: c.checks?.state, required: c.checks?.required?.map((k) => `${k.name}:${k.state}:${k.producer}`) }]));
  const order = (r) => (r.json?.ranking ?? []).map((e) => (e.workspace === A.id ? 'A' : 'B'));
  const before = await http(q, { label: 'GET candidates (gate)' });
  console.log(`before reports: ${before.status} checks=${JSON.stringify(view(before))} ranking=${JSON.stringify(order(before))} (x-kvarm-cost ${before.cost})`);
  check(
    'VAL-CAND-005',
    'kvarm/guard is the real producer: both candidates carry kvarm/guard:success from check-runs before any report',
    before.status === 200 && ['A', 'B'].every((k) => view(before)[k]?.state === 'success' && eq(view(before)[k].required, ['kvarm/guard:success:check-runs'])),
    JSON.stringify(view(before)),
  );

  const failB = await http(`${api}/check-runs`, { method: 'POST', json: { headSha: shaB, name: 'test', conclusion: 'failure' }, label: 'POST check-runs' });
  const passA = await http(`${api}/check-runs`, { method: 'POST', json: { headSha: shaA, name: 'test', conclusion: 'success' }, label: 'POST check-runs' });
  console.log(`POST check-runs test=failure on B ${shaB.slice(0, 8)} -> ${failB.status} ${JSON.stringify(failB.json?.run && { name: failB.json.run.name, status: failB.json.run.status, required: failB.json.run.required })} (x-kvarm-cost ${failB.cost})`);
  console.log(`POST check-runs test=success on A ${shaA.slice(0, 8)} -> ${passA.status} (x-kvarm-cost ${passA.cost})`);
  check('VAL-CAND-005', 'required test runs recorded on both heads with the ci-scope PAT (201)', failB.status === 201 && passA.status === 201 && failB.json?.run?.required === true);
  const after = await http(q, { label: 'GET candidates (gate)' });
  const ranking = after.json?.ranking ?? [];
  const entryB = ranking.find((e) => e.workspace === B.id);
  console.log(`after reports: checks=${JSON.stringify(view(after))}\nranking=${JSON.stringify(ranking.map((e) => ({ ws: e.workspace === A.id ? 'A' : 'B', rank: e.rank, checks: e.factors.checks, failingChecks: e.factors.failingChecks })))}`);
  check(
    'VAL-CAND-005',
    "A (guard + test passing) ranks strictly above B (test failing); B's entry shows the failing check",
    after.status === 200 && eq(order(after), ['A', 'B']) && entryB?.factors?.checks === 'failure' && eq(entryB?.factors?.failingChecks, ['test']),
  );
  check(
    'VAL-CAND-005',
    "B's checks list kvarm/guard success from check-runs alongside test failure",
    eq(view(after).B?.required, ['kvarm/guard:success:check-runs', 'test:failure:check-runs']) && view(after).A?.state === 'success',
    JSON.stringify(view(after)),
  );
  const status = await http(`${api}/commits/${shaB}/status`, { label: 'GET commits/:sha/status' });
  console.log(`GET commits/${shaB.slice(0, 8)}/status -> ${status.status} state=${status.json?.state} checks=${JSON.stringify(status.json?.checks?.map((c) => [c.name, c.status]))} (x-kvarm-cost ${status.cost})`);
  check('VAL-CAND-005', "B's commit status rolls up to failure over kvarm/guard and test", status.status === 200 && status.json?.state === 'failure' && status.json?.total === 2);
});

rmSync(work, { recursive: true, force: true });
console.log('\n# cost headers by endpoint');
for (const [k, v] of Object.entries(costs)) console.log(`${k}: ${[...new Set(v)].slice(0, 4).join(' | ')}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
