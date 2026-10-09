#!/usr/bin/env node
/**
 * Live driver for agent workspaces (m6a-workspaces): VAL-WS-001..010 and
 * VAL-COST-016, plus the agent-token binding to workspace ownership.
 *
 * Every scenario runs in a fresh public repo owned by FORGE_USER (cynthia),
 * named `m6a-workspaces-<purpose>-<timestamp>`, seeded with real git pushes
 * through the platform gate, and deleted afterwards (unless --keep):
 *   lifecycle  create (ref exists at the base head before any push), git push
 *              moves the head, isolation from base and a sibling, change set
 *              defaults (base = default branch, review), head refresh on a
 *              further push, merge → workspace merged
 *   policy     explicit mergePolicy auto/draft kept verbatim
 *   list       status filter, abandon deletes the ref, list cost (mixed states)
 *   agent      agent tokens: own workspace push allowed; another agent's
 *              workspace and an unknown workspace id refused
 *
 * Tokens come from env by NAME and are never printed:
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/workspaces-e2e.mjs [--keep] [--only lifecycle,policy,...]
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper; commits use the configured git identity.
 * Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({
  options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } },
});
const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
const PAT = process.env.FORGE_PAT ?? die('FORGE_PAT is not set');
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm6a-workspaces';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];

function die(msg) {
  console.error(`workspaces-e2e: ${msg}`);
  process.exit(2);
}

function check(id, label, ok, detail = '') {
  results.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
  return ok;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const work = mkdtempSync(join(tmpdir(), 'workspaces-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);

function git(args, cwd, token = PAT) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd,
    env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: token },
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

function localRepo(name) {
  const dir = join(work, name);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  return dir;
}

function commitFile(dir, file, content, msg) {
  writeFileSync(join(dir, file), content);
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
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
        check(purpose, `scenario ${purpose} ran to completion`, false, String(err).slice(0, 300));
      }
    },
  );
  if (!r.ok) check(purpose, 'fixture repo', false, r.reason);
  if (!opts.keep && r.created) {
    const gone = await http(repoPath(repo));
    check(purpose, 'scratch repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
  }
}

async function seeded(repo) {
  const dir = localRepo(repo);
  const main = commitFile(dir, 'README.md', `# ${repo}\n`, 'base');
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main']);
  return { dir, main };
}

// ---------------------------------------------------------------------------

await scenario('lifecycle', async (repo) => {
  const { dir, main } = await seeded(repo);
  const api = repoPath(repo);
  const url = gitUrl(repo);

  // VAL-WS-001
  const made = await http(`${api}/workspaces`, { method: 'POST', json: { task: 'fix-login', agent: 'claude-code-1' } });
  const ws = made.json ?? {};
  console.log(`POST workspaces -> ${made.status} ${made.text} (x-forge-cost ${made.cost})`);
  check(
    'VAL-WS-001',
    'create returns 201 with id, ref under refs/heads/agents/<id>/ and a pushUrl',
    made.status === 201 && ws.id && ws.ref?.startsWith(`refs/heads/agents/${ws.id}/`) && ws.pushUrl === url,
    `id=${ws.id} ref=${ws.ref} pushUrl=${ws.pushUrl}`,
  );
  const got = await http(`${api}/workspaces/${ws.id}`);
  console.log(`GET workspaces/${ws.id} -> ${got.status} ${got.text} (x-forge-cost ${got.cost})`);
  check(
    'VAL-WS-001',
    'GET workspaces/:id returns the same record, status active',
    got.status === 200 && got.json?.id === ws.id && got.json?.ref === ws.ref && got.json?.status === 'active' && got.json?.pushUrl === url,
  );

  // VAL-WS-002
  const initial = lsRemoteAll(url);
  console.log(`git ls-remote | agents: ${JSON.stringify(Object.entries(initial).filter(([r]) => r.startsWith('refs/heads/agents/')))}; main=${initial['refs/heads/main']}`);
  check('VAL-WS-002', 'workspace ref advertised before any push, at the base head', initial[ws.ref] === main && initial['refs/heads/main'] === main, `ref=${initial[ws.ref]} main=${initial['refs/heads/main']}`);

  // Sibling workspace for VAL-WS-006.
  const sib = (await http(`${api}/workspaces`, { method: 'POST', json: { task: 'sibling', agent: 'claude-code-2' } })).json;
  const before = lsRemoteAll(url);
  mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
  const logBefore = mustGit(['log', 'origin/main', '-1', '--format=%H %s'], dir);

  // VAL-WS-003
  mustGit(['checkout', '-q', '-b', 'ws-work'], dir);
  const first = commitFile(dir, 'login.ts', 'export const v = 1;\n', 'fix login v1');
  const push1 = git(['push', ws.pushUrl, `HEAD:${ws.ref}`], dir);
  console.log(`git push ${ws.pushUrl} HEAD:${ws.ref} -> exit ${push1.code}\n${push1.err}`);
  const afterPush = await http(`${api}/workspaces/${ws.id}`);
  const after = lsRemoteAll(url);
  check(
    'VAL-WS-003',
    'git push to the workspace ref accepted; workspace headSha and ls-remote follow',
    push1.code === 0 && afterPush.json?.headSha === first && after[ws.ref] === first,
    `pushed=${first} headSha=${afterPush.json?.headSha} ls-remote=${after[ws.ref]} (x-forge-cost ${afterPush.cost})`,
  );

  // VAL-WS-006
  mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
  const logAfter = mustGit(['log', 'origin/main', '-1', '--format=%H %s'], dir);
  const changed = Object.keys({ ...before, ...after }).filter((r) => before[r] !== after[r]);
  console.log(`ls-remote diff: ${JSON.stringify(changed.map((r) => [r, before[r], after[r]]))}`);
  console.log(`git log origin/main -1 before: ${logBefore} | after: ${logAfter}`);
  check(
    'VAL-WS-006',
    'only the pushed workspace ref moved; main and the sibling ref are byte-identical',
    changed.length === 1 && changed[0] === ws.ref && before['refs/heads/main'] === after['refs/heads/main'] && before[sib.ref] === after[sib.ref] && logBefore === logAfter,
    `changed=${changed.join(',')} sibling=${after[sib.ref]}`,
  );

  // VAL-WS-007
  const cs = await http(`${api}/workspaces/${ws.id}/change-set`, { method: 'POST', json: { title: 'fix login' } });
  console.log(`POST change-set -> ${cs.status} (x-forge-cost ${cs.cost}) ${JSON.stringify({ number: cs.json?.number, base: cs.json?.base, head: cs.json?.head, headSha: cs.json?.headSha, state: cs.json?.state, mergePolicy: cs.json?.mergePolicy })}`);
  const n = cs.json?.number;
  const change = await http(`${api}/changes/${n}`);
  const branch = ws.ref.slice('refs/heads/'.length);
  check(
    'VAL-WS-007',
    'change set: head at the workspace head, base main, state open, mergePolicy review',
    cs.status === 201 &&
      change.json?.headSha === first &&
      change.json?.head === branch &&
      change.json?.base === 'main' &&
      change.json?.state === 'open' &&
      change.json?.mergePolicy === 'review',
    `GET changes/${n}: base=${change.json?.base} head=${change.json?.head} headSha=${change.json?.headSha} state=${change.json?.state} mergePolicy=${change.json?.mergePolicy}`,
  );

  // VAL-WS-004
  const second = commitFile(dir, 'login.ts', 'export const v = 2;\n', 'fix login v2');
  const push2 = git(['push', ws.pushUrl, `HEAD:${ws.ref}`], dir);
  console.log(`git push (second) -> exit ${push2.code}`);
  let refreshed = null;
  const t0 = Date.now();
  for (let i = 0; i < 30; i++) {
    refreshed = await http(`${api}/changes/${n}`);
    if (refreshed.json?.headSha === second) break;
    await sleep(3000);
  }
  const all = await http(`${api}/changes?state=all`);
  const forWs = (all.json?.changes ?? []).filter((c) => c.head === branch);
  check(
    'VAL-WS-004',
    'a further push refreshes the change head; still exactly one change set',
    push2.code === 0 && refreshed?.json?.headSha === second && forWs.length === 1,
    `head ${first} -> ${refreshed?.json?.headSha} after ${Math.round((Date.now() - t0) / 1000)} s; changes for workspace=${forWs.length}`,
  );

  // VAL-WS-010
  const merged = await http(`${api}/changes/${n}/merge`, { method: 'POST' });
  console.log(`POST changes/${n}/merge -> ${merged.status} state=${merged.json?.state} mergeCommit=${merged.json?.mergeCommit} (x-forge-cost ${merged.cost})`);
  const wsAfter = await http(`${api}/workspaces/${ws.id}`);
  mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
  const log2 = mustGit(['log', 'origin/main', '-2', '--format=%H %s'], dir);
  console.log(`git log origin/main -2:\n${log2}`);
  check(
    'VAL-WS-010',
    'merging the change set marks the workspace merged; the merge is on main',
    merged.status === 200 && merged.json?.state === 'merged' && wsAfter.json?.status === 'merged' && log2.split('\n')[0]?.startsWith(merged.json?.mergeCommit ?? '-'),
    `workspace status=${wsAfter.json?.status} mergedAt=${wsAfter.json?.mergedAt}`,
  );
});

await scenario('policy', async (repo) => {
  const { dir, main } = await seeded(repo);
  const api = repoPath(repo);
  const seen = {};
  for (const policy of ['draft', 'auto']) {
    const ws = (await http(`${api}/workspaces`, { method: 'POST', json: { task: `policy ${policy}`, agent: 'claude-code-1' } })).json;
    mustGit(['checkout', '-q', '-B', `p-${policy}`, main], dir);
    commitFile(dir, `${policy}.txt`, `${policy}\n`, `policy ${policy}`);
    mustGit(['push', '-q', ws.pushUrl, `HEAD:${ws.ref}`], dir);
    const cs = await http(`${api}/workspaces/${ws.id}/change-set`, { method: 'POST', json: { title: policy === 'auto' ? 'a' : 'b', mergePolicy: policy } });
    const got = await http(`${api}/changes/${cs.json?.number}`);
    console.log(`GET changes/${cs.json?.number} (${policy}) -> ${got.status} mergePolicy=${got.json?.mergePolicy} state=${got.json?.state}`);
    seen[policy] = got.json?.mergePolicy;
  }
  check('VAL-WS-008', 'explicit mergePolicy kept verbatim (auto, draft)', seen.auto === 'auto' && seen.draft === 'draft', JSON.stringify(seen));
});

await scenario('list', async (repo) => {
  const { dir, main } = await seeded(repo);
  const api = repoPath(repo);
  const url = gitUrl(repo);
  const mk = async (task) => (await http(`${api}/workspaces`, { method: 'POST', json: { task, agent: `agent-${task}` } })).json;
  const keep = await mk('keep');
  const drop = await mk('drop');
  const land = await mk('land');
  mustGit(['checkout', '-q', '-b', 'land'], dir);
  commitFile(dir, 'land.txt', 'land\n', 'land');
  mustGit(['push', '-q', land.pushUrl, `HEAD:${land.ref}`], dir);
  const auto = await http(`${api}/workspaces/${land.id}/change-set`, { method: 'POST', json: { title: 'land', mergePolicy: 'auto' } });
  console.log(`auto change-set for ${land.id}: ${auto.status} state=${auto.json?.state}`);

  // VAL-WS-009
  const ab = await http(`${api}/workspaces/${drop.id}/abandon`, { method: 'POST' });
  console.log(`POST workspaces/${drop.id}/abandon -> ${ab.status} ${ab.text} (x-forge-cost ${ab.cost})`);
  const dropGot = await http(`${api}/workspaces/${drop.id}`);
  const refs = lsRemoteAll(url);
  console.log(`git ls-remote | agents: ${JSON.stringify(Object.keys(refs).filter((r) => r.startsWith('refs/heads/agents/')))}`);
  check(
    'VAL-WS-009',
    'abandon succeeds, status abandoned, ref no longer advertised',
    ab.status === 200 && dropGot.json?.status === 'abandoned' && !(drop.ref in refs) && refs[keep.ref] === main,
    `status=${dropGot.json?.status} refPresent=${drop.ref in refs}`,
  );

  // VAL-WS-005
  const active = await http(`${api}/workspaces?status=active`);
  const everything = await http(`${api}/workspaces`);
  console.log(`GET workspaces?status=active -> ${active.status} ${JSON.stringify(active.json?.workspaces?.map((w) => ({ id: w.id, task: w.task, agent: w.agent, status: w.status })))}`);
  console.log(`GET workspaces -> ${everything.status} ${JSON.stringify(everything.json?.workspaces?.map((w) => ({ id: w.id, task: w.task, agent: w.agent, status: w.status })))}`);
  const activeIds = (active.json?.workspaces ?? []).map((w) => w.id);
  const allIds = (everything.json?.workspaces ?? []).map((w) => w.id);
  const shaped = (everything.json?.workspaces ?? []).every((w) => w.id && w.task && w.agent && w.status);
  check(
    'VAL-WS-005',
    'status filter excludes the abandoned workspace; unfiltered list has both; items carry id/task/agent/status',
    activeIds.includes(keep.id) && !activeIds.includes(drop.id) && allIds.includes(keep.id) && allIds.includes(drop.id) && shaped,
    `active=${activeIds.length} all=${allIds.length}`,
  );

  // VAL-COST-016
  const listRes = await fetch(`${BASE}${api}/workspaces`, { headers: { Authorization: `Bearer ${PAT}` } });
  const header = listRes.headers.get('x-forge-cost') ?? '';
  const listed = (await listRes.json()).workspaces ?? [];
  const d1 = Number(/(?:^|;)d1=(\d+)/.exec(header)?.[1] ?? NaN);
  const doCalls = Number(/(?:^|;)do=(\d+)/.exec(header)?.[1] ?? NaN);
  const states = [...new Set(listed.map((w) => w.status))].sort();
  console.log(`GET workspaces x-forge-cost: ${header}; count=${listed.length}; states=${states.join(',')}`);
  check('VAL-COST-016', 'list reports d1 <= 2 and do=0 over >= 3 workspaces in mixed states', d1 <= 2 && doCalls === 0 && listed.length >= 3 && states.length === 3, header);
});

await scenario('agent', async (repo) => {
  const { dir, main } = await seeded(repo);
  const api = repoPath(repo);
  const url = gitUrl(repo);
  const agents = [];
  try {
    const tokens = [];
    for (const who of ['a', 'b']) {
      const ag = await http('/api/v1/agents', { method: 'POST', json: { name: `m6a-ws-${who}-${TS}`, description: 'workspaces e2e' } });
      if (ag.status !== 201) throw new Error(`create agent: ${ag.status} ${ag.text}`);
      agents.push(ag.json.agent.id);
      const t = await http(`/api/v1/agents/${ag.json.agent.id}/tokens`, {
        method: 'POST',
        json: { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 900 },
      });
      if (t.status !== 201) throw new Error(`mint token: ${t.status}`);
      tokens.push(t.json.token);
      console.log(`agent ${who}: ${ag.json.agent.id}, token prefix ${t.json.prefix}`);
    }
    const [ta, tb] = tokens;
    const wa = await http(`${api}/workspaces`, { method: 'POST', json: { task: 'agent a' }, token: ta });
    const wb = await http(`${api}/workspaces`, { method: 'POST', json: { task: 'agent b' }, token: tb });
    check('binding', 'agent tokens create their own workspaces (agentId recorded)', wa.status === 201 && wb.status === 201 && wa.json?.agentId === agents[0] && wb.json?.agentId === agents[1], `a=${wa.json?.ref} b=${wb.json?.ref}`);

    mustGit(['checkout', '-q', '-b', 'agent-a'], dir);
    const sha = commitFile(dir, 'agent.txt', 'a\n', 'agent a work');
    const own = git(['push', url, `HEAD:${wa.json.ref}`], dir, ta);
    const other = git(['push', url, `HEAD:${wb.json.ref}`], dir, ta);
    const ghost = git(['push', url, `HEAD:refs/heads/agents/nosuchworkspace/x`], dir, ta);
    const refs = lsRemoteAll(url);
    console.log(`own push exit ${own.code}; other: ${other.err.split('\n').find((l) => l.includes('rejected')) ?? other.code}; ghost: ${ghost.err.split('\n').find((l) => l.includes('rejected')) ?? ghost.code}`);
    check('binding', "agent pushes to its own workspace ref", own.code === 0 && refs[wa.json.ref] === sha);
    check(
      'binding',
      "agent push to another agent's workspace and to an unknown workspace id is refused; refs unchanged",
      other.code !== 0 && other.err.includes('workspace owned by another agent') && ghost.code !== 0 && ghost.err.includes('no such workspace') && refs[wb.json.ref] === main && !('refs/heads/agents/nosuchworkspace/x' in refs),
    );
    const steal = await http(`${api}/workspaces/${wb.json.id}/abandon`, { method: 'POST', token: ta });
    check('binding', "agent cannot abandon another agent's workspace", steal.status === 403 && steal.json?.code === 'WORKSPACE_NOT_OWNED', `${steal.status} ${steal.json?.code}`);
  } finally {
    for (const id of agents) await http(`/api/v1/agents/${id}`, { method: 'DELETE' });
  }
});

rmSync(work, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
