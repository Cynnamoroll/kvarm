#!/usr/bin/env node
/**
 * Live driver for review approvals (m5-review-approvals): VAL-PROTECT-002 and
 * VAL-REVIEW-001..005 against the deployed Worker.
 *
 * Every scenario runs in a fresh public repo owned by KVARM_USER, named
 * `m5-review-<purpose>-<timestamp>`, seeded with real git pushes and deleted
 * afterwards (unless --keep). `forge-org-maint` (KVARM_PAT_MAINT) gets a write
 * grant and is the second human; three agents of KVARM_USER (two `claude`, one
 * `gpt`) get write tokens per repo and are revoked at the end.
 *   unset      no review policy: explicit merge with no approval; enqueue alone lands
 *   policy     N=2: 409 at 0 and 1 approvals, self-review refused (REST + MCP),
 *              duplicate approver not counted, second distinct principal merges;
 *              two distinct agent approvals merge a second change
 *   family     modelFamily on agents and reviews, assignment prefers a different
 *              family, a same-family review still counts
 *   escalate   reviewer-disagreement and review-blocked escalations block merge
 *              and enqueue until a human approves / acknowledges
 *   protected  N agent approvals on a protected target: 409 naming the human
 *              requirement + protected-path escalation; a human approval merges
 *   selection  an arena selection opens final-selection; resolving it merges
 *   exact      protected target: author self-approval refused, enqueue alone
 *              blocked, human approval bound to the head, a pushed head stales
 *              it, reapproval of the new head publishes through the train
 *
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *   node scripts/review-approvals-e2e.mjs [--keep] [--only unset,policy,...]
 * Tokens are read by NAME and never printed. Git runs with
 * `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a secret-free
 * GIT_ASKPASS helper. Exit 0 only when every check held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const { values: opts } = parseArgs({ options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } } });
const BASE = process.env.KVARM_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.KVARM_USER ?? 'cynthia';
const PAT = process.env.KVARM_PAT ?? die('KVARM_PAT is not set');
const MAINT = process.env.KVARM_PAT_MAINT ?? die('KVARM_PAT_MAINT is not set');
const MAINT_LOGIN = 'forge-org-maint';
const TS = Math.floor(Date.now() / 1000);
const PREFIX = 'm5-review';
const only = opts.only ? new Set(opts.only.split(',')) : null;
const results = [];
const costs = [];

function die(msg) {
  console.error(`review-approvals-e2e: ${msg}`);
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
  return { status: res.status, text, json: body, cost: res.headers.get('x-kvarm-cost') };
}

function cost(label, r) {
  costs.push({ label, status: r.status, cost: r.cost });
  return r.cost ?? 'no cost header';
}

const short = (sha) => (sha ? sha.slice(0, 10) : String(sha));

// --- git -----------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'review-approvals-e2e-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: PAT };

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
  for (let i = 0; i < 8; i++) {
    const r = git(['push', '-q', url, ...refspecs], dir);
    if (r.code === 0) return;
    await sleep(3000);
  }
  throw new Error(`push ${refspecs.join(' ')} kept failing`);
}

function writeFiles(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

function commitAll(dir, msg) {
  mustGit(['add', '-A'], dir);
  mustGit(['commit', '-q', '-m', msg], dir);
  return mustGit(['rev-parse', 'HEAD'], dir);
}

function lsRemote(repo, ref) {
  const r = git(['ls-remote', gitUrl(repo), ref], work);
  return r.out.split('\n').find((l) => l.endsWith(`\t${ref}`))?.split('\t')[0] ?? null;
}

const repoPath = (repo) => `/api/v1/repos/${OWNER}/${repo}`;
const gitUrl = (repo) => `${BASE}/${OWNER}/${repo}.git`;

/** main = README; each branch adds its own file on top. */
async function seed(repo, branches) {
  const dir = join(work, repo);
  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main'], dir);
  writeFiles(dir, { 'README.md': `# ${repo}\n` });
  const base = commitAll(dir, 'base');
  const heads = {};
  for (const name of branches) {
    mustGit(['checkout', '-q', '-b', name, base], dir);
    writeFiles(dir, { [`${name}.txt`]: `${name}\n` });
    heads[name] = commitAll(dir, `${name} work`);
  }
  mustGit(['checkout', '-q', 'main'], dir);
  await pushRetry(dir, gitUrl(repo), ['main:refs/heads/main', ...branches.map((b) => `${b}:refs/heads/${b}`)]);
  return { dir, base, heads };
}

// --- MCP -------------------------------------------------------------------------

async function mcpCall(token, tool, args) {
  let status = null;
  let mcpCost = null;
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      if ((init?.method ?? 'GET') === 'POST') {
        status = res.status;
        mcpCost = res.headers.get('x-kvarm-cost');
      }
      return res;
    },
  });
  const client = new Client({ name: 'review-approvals-e2e', version: '0.1.0' });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { isError: Boolean(res.isError), data, text, status, cost: mcpCost };
  } finally {
    await client.close();
  }
}

// --- principals ------------------------------------------------------------------

const agents = {};

async function createAgents() {
  for (const [key, family] of [
    ['claude', 'claude'],
    ['claude2', 'claude'],
    ['gpt', 'gpt'],
  ]) {
    const r = await http('/api/v1/agents', { method: 'POST', json: { name: `rv-${key}-${TS}`, modelFamily: family, description: 'review-approvals-e2e' } });
    if (r.status !== 201) throw new Error(`create agent ${key}: ${r.status} ${r.text}`);
    agents[key] = { id: r.json.agent.id, name: r.json.agent.name, family: r.json.agent.modelFamily, tokens: {} };
  }
}

async function agentToken(key, repo) {
  const a = agents[key];
  if (a.tokens[repo]) return a.tokens[repo];
  const r = await http(`/api/v1/agents/${a.id}/tokens`, {
    method: 'POST',
    json: { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 3600 },
  });
  if (r.status !== 201) throw new Error(`mint ${key} token: ${r.status} ${r.text}`);
  a.tokens[repo] = r.json.token;
  return r.json.token;
}

async function grantMaint(repo) {
  const r = await http(`${repoPath(repo)}/grants/${MAINT_LOGIN}`, { method: 'PUT', json: { role: 'write' } });
  if (r.status !== 200) throw new Error(`grant ${MAINT_LOGIN}: ${r.status} ${r.text}`);
}

// --- review helpers ---------------------------------------------------------------

const createChange = (repo, head, token = PAT, mergePolicy = 'review') =>
  http(`${repoPath(repo)}/changes`, { method: 'POST', token, json: { title: `Change ${head}`, base: 'main', head, mergePolicy } });
const approve = (repo, n, token, json = {}) => http(`${repoPath(repo)}/changes/${n}/approve`, { method: 'POST', token, json });
const requestChanges = (repo, n, token, json = {}) => http(`${repoPath(repo)}/changes/${n}/request-changes`, { method: 'POST', token, json });
const packet = (repo, n) => http(`${repoPath(repo)}/changes/${n}/reviews`);
const merge = (repo, n) => http(`${repoPath(repo)}/changes/${n}/merge`, { method: 'POST' });
const enqueue = (repo, n, json) => http(`${repoPath(repo)}/changes/${n}/enqueue`, { method: 'POST', ...(json ? { json } : {}) });
const setPolicy = (repo, requiredReviews) => http(`${repoPath(repo)}/review-policy`, { method: 'PUT', json: { requiredReviews } });
const refusal = (r) => `${r.status} ${r.json?.code} "${(r.json?.error ?? '').slice(0, 150)}"`;
const reviewsLine = (p) =>
  (p.json?.reviews ?? []).map((v) => `${v.principal}(${v.reviewer?.agent?.name ?? v.reviewer?.login}, ${v.modelFamily}, diff=${v.differentFamily}) ${v.verdict}@${short(v.headSha)} current=${v.current}`).join('; ');
const escLine = (p) => (p.json?.escalations ?? []).map((e) => `${e.reason}:${e.state}${e.resolution ? `/${e.resolution} by ${e.resolvedBy}` : ''}`).join(', ');

/** Polls a change until it is merged or leaves the queue (bounded client poll). */
async function waitSettled(repo, n, timeoutMs = 120_000) {
  const t0 = Date.now();
  let c = null;
  while (Date.now() - t0 < timeoutMs) {
    c = (await http(`${repoPath(repo)}/changes/${n}`)).json;
    if (c?.state === 'merged' || (c?.state === 'open' && (c?.queueState ?? null) === null && Date.now() - t0 > 3000)) break;
    await sleep(2000);
  }
  return { change: c, ms: Date.now() - t0 };
}

async function waitHead(repo, n, sha, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const c = (await http(`${repoPath(repo)}/changes/${n}`)).json;
    if (c?.headSha === sha) return Date.now() - t0;
    await sleep(1500);
  }
  return null;
}

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

// ---------------------------------------------------------------------------

await createAgents();
for (const a of Object.values(agents)) {
  const r = await http(`/api/v1/agents/${a.id}`);
  check('VAL-REVIEW-003', `agent principal metadata records modelFamily (${a.name})`, r.status === 200 && r.json?.agent?.modelFamily === a.family, `GET agents/${a.id} -> modelFamily=${r.json?.agent?.modelFamily}`);
}

await scenario('unset', async (repo) => {
  const { heads } = await seed(repo, ['one', 'two']);
  const pol = await http(`${repoPath(repo)}/review-policy`);
  const c1 = await createChange(repo, 'one');
  const m = await merge(repo, c1.json?.number);
  const main1 = lsRemote(repo, 'refs/heads/main');
  check(
    'VAL-REVIEW-001',
    'unset policy (default): explicit merge POST merges with no approval gate',
    pol.json?.configured === false && pol.json?.requiredReviews === 0 && m.status === 200 && m.json?.state === 'merged' && main1 === heads.one,
    `policy ${JSON.stringify(pol.json)}; merge ${m.status} ${m.json?.state}; ls-remote main=${short(main1)} head=${short(heads.one)}; cost ${cost('POST merge (no policy)', m)}`,
  );
  const c2 = await createChange(repo, 'two');
  const e = await enqueue(repo, c2.json?.number);
  const settled = await waitSettled(repo, c2.json?.number);
  const main2 = lsRemote(repo, 'refs/heads/main');
  check(
    'VAL-PROTECT-002',
    'no separate-reviewer rule: enqueue alone approves the head and the train lands it (VAL-QUEUE-006 unchanged)',
    e.status === 201 && settled.change?.state === 'merged' && main2 === settled.change?.mergeCommit,
    `enqueue ${e.status} cost ${cost('POST enqueue (no rule)', e)}; merged after ${settled.ms} ms; main=${short(main2)}`,
  );
});

await scenario('policy', async (repo) => {
  await grantMaint(repo);
  const { heads } = await seed(repo, ['feat', 'agentwork']);
  const put = await setPolicy(repo, 2);
  const read = await http(`${repoPath(repo)}/review-policy`);
  check('VAL-REVIEW-001', 'PUT review-policy {requiredReviews:2} and readback', put.status === 200 && read.json?.requiredReviews === 2 && read.json?.configured === true, `${JSON.stringify(read.json)}; PUT cost ${cost('PUT review-policy', put)}`);
  const n = (await createChange(repo, 'feat')).json?.number;
  const m0 = await merge(repo, n);
  check('VAL-REVIEW-001', 'merge with 0 approvals -> 409 naming the required reviews', m0.status === 409 && m0.json?.code === 'REVIEWS_REQUIRED' && /requires 2 approving/.test(m0.json?.error ?? ''), refusal(m0));

  const self = await approve(repo, n, PAT);
  const selfMcp = await mcpCall(PAT, 'approve_change', { repo: `${OWNER}/${repo}`, number: n });
  const after = await packet(repo, n);
  check(
    'VAL-REVIEW-002',
    'author self-review refused (REST and MCP approve_change) and approval count unchanged',
    self.status === 409 && self.json?.code === 'SELF_REVIEW' && selfMcp.isError && /SELF_REVIEW/.test(selfMcp.text) && after.json?.approvals?.count === 0 && (after.json?.reviews ?? []).length === 0,
    `REST ${refusal(self)}; MCP isError=${selfMcp.isError} status=${selfMcp.status} ${selfMcp.text.slice(0, 120)}; approvals=${JSON.stringify(after.json?.approvals)}`,
  );

  const h1 = await approve(repo, n, MAINT, { headSha: heads.feat });
  const m1 = await merge(repo, n);
  check('VAL-REVIEW-001', 'one approval from a second principal -> still 409 naming the unmet requirement', h1.status === 201 && m1.status === 409 && m1.json?.code === 'REVIEWS_REQUIRED' && /1 so far/.test(m1.json?.error ?? ''), `approve ${h1.status} cost ${cost('POST approve (human)', h1)}; merge ${refusal(m1)}`);
  const dup = await approve(repo, n, MAINT, { headSha: heads.feat });
  const m1b = await merge(repo, n);
  check('VAL-REVIEW-001', 'the same principal approving twice counts once (still 409)', dup.status === 200 && dup.json?.created === false && dup.json?.packet?.approvals?.count === 1 && m1b.status === 409, `dup approve ${dup.status} created=${dup.json?.created} count=${dup.json?.packet?.approvals?.count}; merge ${refusal(m1b)}`);

  const gptTok = await agentToken('gpt', repo);
  const viaMcp = await mcpCall(gptTok, 'approve_change', { repo: `${OWNER}/${repo}`, number: n, headSha: heads.feat, body: 'reviewed by gpt' });
  check(
    'VAL-REVIEW-002',
    'agent principal approval (MCP approve_change, agent token) recorded with the agent identity and counted',
    !viaMcp.isError && viaMcp.data?.review?.principal === `agent:${agents.gpt.id}` && viaMcp.data?.review?.reviewer?.agent?.name === agents.gpt.name && viaMcp.data?.packet?.approvals?.count === 2,
    `MCP status=${viaMcp.status} cost ${viaMcp.cost}; review ${JSON.stringify(viaMcp.data?.review?.reviewer)} ${viaMcp.data?.review?.principal} family=${viaMcp.data?.review?.modelFamily}; approvals=${JSON.stringify(viaMcp.data?.packet?.approvals)}`,
  );
  const m2 = await merge(repo, n);
  const main = lsRemote(repo, 'refs/heads/main');
  check('VAL-REVIEW-001', 'second distinct approval -> merged and base moved', m2.status === 200 && m2.json?.state === 'merged' && main === m2.json?.mergeCommit, `merge ${m2.status} ${m2.json?.state}; ls-remote main=${short(main)} mergeCommit=${short(m2.json?.mergeCommit)}`);

  const n2 = (await createChange(repo, 'agentwork')).json?.number;
  const a1 = await approve(repo, n2, await agentToken('claude', repo));
  const a2 = await approve(repo, n2, gptTok);
  const m3 = await merge(repo, n2);
  const p2 = await packet(repo, n2);
  check(
    'VAL-REVIEW-002',
    'two distinct agent approvals satisfy N=2 -> merged',
    a1.status === 201 && a2.status === 201 && m3.status === 200 && m3.json?.state === 'merged' && lsRemote(repo, 'refs/heads/main') === m3.json?.mergeCommit,
    `reviews: ${reviewsLine(p2)}; merge ${m3.status} ${m3.json?.state}; agent approve cost ${cost('POST approve (agent)', a1)}`,
  );
});

await scenario('family', async (repo) => {
  await grantMaint(repo);
  const { heads } = await seed(repo, ['agentfeat']);
  await setPolicy(repo, 2);
  const authorTok = await agentToken('claude', repo);
  const c = await createChange(repo, 'agentfeat', authorTok);
  const n = c.json?.number;
  const sameTok = await agentToken('claude2', repo);
  const gptTok = await agentToken('gpt', repo);
  const self = await approve(repo, n, authorTok);
  const asg = await http(`${repoPath(repo)}/changes/${n}/reviewers/assign`, { method: 'POST', json: {} });
  const cands = (asg.json?.candidates ?? []).map((x) => `${x.agent.name}:${x.modelFamily}:diff=${x.differentFamily}:eligible=${x.eligible}${x.ineligibleReason ? `(${x.ineligibleReason})` : ''}`);
  const byId = Object.fromEntries((asg.json?.candidates ?? []).map((x) => [x.agent.id, x]));
  check(
    'VAL-REVIEW-002',
    'an agent author cannot review its own change',
    c.status === 201 && self.status === 409 && self.json?.code === 'SELF_REVIEW',
    `create ${c.status}; self approve ${refusal(self)}`,
  );
  check(
    'VAL-REVIEW-003',
    'assignment over same-family and different-family eligible reviewers -> different family assigned, preference + per-candidate markers reported',
    asg.status === 200 &&
      asg.json?.author?.modelFamily === 'claude' &&
      asg.json?.assigned?.agent?.id === agents.gpt.id &&
      asg.json?.preference?.met === true &&
      byId[agents.claude2.id]?.eligible === true &&
      byId[agents.claude2.id]?.differentFamily === false &&
      byId[agents.gpt.id]?.differentFamily === true &&
      byId[agents.claude.id]?.ineligibleReason === 'author',
    `author=${asg.json?.author?.principal}/${asg.json?.author?.modelFamily} preference=${JSON.stringify(asg.json?.preference)} assigned=${asg.json?.assigned?.agent?.name} candidates=[${cands.join(', ')}] cost ${cost('POST reviewers/assign', asg)}`,
  );
  const same = await approve(repo, n, sameTok, { headSha: heads.agentfeat });
  check(
    'VAL-REVIEW-003',
    'a same-family review submitted directly is accepted and counted',
    same.status === 201 && same.json?.review?.modelFamily === 'claude' && same.json?.review?.differentFamily === false && same.json?.packet?.approvals?.count === 1,
    `${same.status} family=${same.json?.review?.modelFamily} differentFamily=${same.json?.review?.differentFamily} approvals=${JSON.stringify(same.json?.packet?.approvals)}`,
  );
  await approve(repo, n, gptTok, { headSha: heads.agentfeat });
  await approve(repo, n, MAINT, { headSha: heads.agentfeat });
  const p = await packet(repo, n);
  const fams = Object.fromEntries((p.json?.reviews ?? []).map((v) => [v.principal, [v.modelFamily, v.differentFamily]]));
  check(
    'VAL-REVIEW-003',
    'every review exposes principal + modelFamily (human sentinel "human") and the family-difference marker',
    fams[`agent:${agents.claude2.id}`]?.[0] === 'claude' &&
      fams[`agent:${agents.claude2.id}`]?.[1] === false &&
      fams[`agent:${agents.gpt.id}`]?.[0] === 'gpt' &&
      fams[`agent:${agents.gpt.id}`]?.[1] === true &&
      Object.entries(fams).some(([k, v]) => k.startsWith('user:') && v[0] === 'human' && v[1] === true),
    `${reviewsLine(p)}; GET reviews cost ${cost('GET changes/:n/reviews', p)}`,
  );
  const m = await merge(repo, n);
  check('VAL-REVIEW-003', 'the change merges with the counted reviews', m.status === 200 && m.json?.state === 'merged', `${m.status} ${m.json?.state}`);
});

await scenario('escalate', async (repo) => {
  await grantMaint(repo);
  await seed(repo, ['disagree', 'blocked']);
  await setPolicy(repo, 2);
  const claudeTok = await agentToken('claude', repo);
  const gptTok = await agentToken('gpt', repo);

  const n1 = (await createChange(repo, 'disagree')).json?.number;
  await approve(repo, n1, claudeTok);
  const rc = await requestChanges(repo, n1, gptTok, { body: 'this breaks the parser' });
  const p1 = await packet(repo, n1);
  const m1 = await merge(repo, n1);
  const e1 = await enqueue(repo, n1);
  const esc1 = (p1.json?.escalations ?? []).find((e) => e.reason === 'reviewer-disagreement');
  const byAgent = await http(`${repoPath(repo)}/changes/${n1}/escalations/${esc1?.id}/resolve`, { method: 'POST', token: claudeTok, json: {} });
  check(
    'VAL-REVIEW-004',
    '(a) approval + request-changes -> open reviewer-disagreement; merge and enqueue 409 naming it; an agent cannot resolve',
    esc1?.state === 'open' && m1.status === 409 && m1.json?.code === 'ESCALATION_OPEN' && /reviewer-disagreement/.test(m1.json?.error ?? '') && e1.status === 409 && e1.json?.code === 'ESCALATION_OPEN' && byAgent.status === 403 && byAgent.json?.code === 'HUMAN_REQUIRED',
    `request-changes ${rc.status}; escalation ${JSON.stringify({ id: esc1?.id, reason: esc1?.reason, state: esc1?.state, openedBy: esc1?.openedBy })}; merge ${refusal(m1)}; enqueue ${refusal(e1)}; agent resolve ${refusal(byAgent)}`,
  );
  const human = await approve(repo, n1, MAINT);
  const m1b = await merge(repo, n1);
  check(
    'VAL-REVIEW-004',
    '(a) a human approval of the current head closes the escalation and the change merges',
    human.json?.packet?.escalations?.find((e) => e.reason === 'reviewer-disagreement')?.state === 'resolved' && m1b.status === 200 && m1b.json?.state === 'merged',
    `${escLine({ json: human.json?.packet })}; merge ${m1b.status} ${m1b.json?.state}`,
  );

  const n2 = (await createChange(repo, 'blocked')).json?.number;
  await requestChanges(repo, n2, gptTok, { body: 'blocking' });
  const p2 = await packet(repo, n2);
  const esc2 = (p2.json?.escalations ?? []).find((e) => e.reason === 'review-blocked');
  const m2 = await merge(repo, n2);
  const e2 = await enqueue(repo, n2);
  check(
    'VAL-REVIEW-004',
    '(b) a single blocking review -> open review-blocked; merge and enqueue 409 naming it',
    esc2?.state === 'open' && m2.status === 409 && m2.json?.code === 'ESCALATION_OPEN' && /review-blocked/.test(m2.json?.error ?? '') && e2.json?.code === 'ESCALATION_OPEN',
    `escalation ${esc2?.reason}:${esc2?.state}; merge ${refusal(m2)}; enqueue ${refusal(e2)}`,
  );
  const ack = await http(`${repoPath(repo)}/changes/${n2}/escalations/${esc2?.id}/resolve`, { method: 'POST', json: { resolution: 'acknowledge', note: 'author addressed it' } });
  // The blocking reviewer changes its verdict; with a second approval the change proceeds per its policy.
  await approve(repo, n2, gptTok);
  await approve(repo, n2, claudeTok);
  const m2b = await merge(repo, n2);
  check(
    'VAL-REVIEW-004',
    '(b) a human acknowledge closes the escalation; the change then merges per its policy',
    ack.status === 200 && ack.json?.escalation?.state === 'resolved' && ack.json?.escalation?.resolution === 'acknowledge' && m2b.status === 200 && m2b.json?.state === 'merged',
    `resolve ${ack.status} ${JSON.stringify({ state: ack.json?.escalation?.state, resolution: ack.json?.escalation?.resolution, by: ack.json?.escalation?.resolvedBy })} cost ${cost('POST escalations/:id/resolve', ack)}; merge ${m2b.status} ${m2b.json?.state}`,
  );
  const pend = await http(`${repoPath(repo)}/reviews/pending`);
  check('VAL-REVIEW-004', 'pending reviews read is bounded and empty once both merged', pend.status === 200 && (pend.json?.changes ?? []).length === 0, `cost ${cost('GET reviews/pending', pend)}`);
});

await scenario('protected', async (repo) => {
  await grantMaint(repo);
  const { heads } = await seed(repo, ['guarded']);
  await setPolicy(repo, 2);
  const rule = await http(`${repoPath(repo)}/branch-rules`, { method: 'POST', json: { pattern: 'main', requiredApprovals: 1 } });
  const n = (await createChange(repo, 'guarded')).json?.number;
  await approve(repo, n, await agentToken('claude', repo), { headSha: heads.guarded });
  await approve(repo, n, await agentToken('gpt', repo), { headSha: heads.guarded });
  const p = await packet(repo, n);
  const m = await merge(repo, n);
  const e = await enqueue(repo, n);
  check(
    'VAL-REVIEW-005',
    'N=2 agent approvals (claude + gpt) on a protected target: merge/enqueue 409 naming the human requirement',
    rule.status === 201 && p.json?.approvals?.count === 2 && m.status === 409 && m.json?.code === 'APPROVALS_REQUIRED' && /human principal/.test(m.json?.error ?? '') && e.status === 409 && e.json?.code === 'APPROVALS_REQUIRED',
    `approvals=${JSON.stringify(p.json?.approvals)}; merge ${refusal(m)}; enqueue ${refusal(e)} cost ${cost('POST enqueue (refused: human required)', e)}`,
  );
  check(
    'VAL-REVIEW-004',
    '(c) a change targeting a ref covered by a branch rule has an open protected-path escalation, named in the refusal',
    (p.json?.escalations ?? []).some((x) => x.reason === 'protected-path' && x.state === 'open') && (m.json?.review?.openEscalations ?? []).includes('protected-path'),
    `${escLine(p)}; refusal openEscalations=${JSON.stringify(m.json?.review?.openEscalations)}`,
  );
  const h = await approve(repo, n, MAINT, { headSha: heads.guarded });
  const m2 = await merge(repo, n);
  const p2 = await packet(repo, n);
  check(
    'VAL-REVIEW-005',
    'a human approval of the current head satisfies the requirement (and closes protected-path) -> merged',
    h.status === 201 && m2.status === 200 && m2.json?.state === 'merged' && lsRemote(repo, 'refs/heads/main') === m2.json?.mergeCommit,
    `merge ${m2.status} ${m2.json?.state}; ${escLine(p2)}`,
  );
  check('VAL-REVIEW-005', 'approval identities: two agent principals + the human, each with its head SHA', (p2.json?.reviews ?? []).length === 3 && (p2.json?.reviews ?? []).every((v) => v.headSha === heads.guarded), reviewsLine(p2));
});

await scenario('selection', async (repo) => {
  const dir = (await seed(repo, [])).dir;
  const arena = await http(`${repoPath(repo)}/arenas`, { method: 'POST', json: { brief: 'pick one', candidates: 2 } });
  const ws = arena.json?.workspaces?.[0];
  mustGit(['checkout', '-q', '-b', 'cand', 'main'], dir);
  writeFiles(dir, { 'cand.txt': 'candidate\n' });
  const sha = commitAll(dir, 'candidate');
  await pushRetry(dir, gitUrl(repo), [`cand:${ws.ref.startsWith('refs/') ? ws.ref : `refs/heads/${ws.ref}`}`]);
  const cs = await http(`${repoPath(repo)}/workspaces/${ws.id}/change-set`, { method: 'POST', json: { title: 'candidate a' } });
  const n = cs.json?.number;
  const sel = await http(`${repoPath(repo)}/arenas/${arena.json?.id}/select`, { method: 'POST', json: { workspace: ws.id } });
  const p = await packet(repo, n);
  const esc = (p.json?.escalations ?? []).find((e) => e.reason === 'final-selection');
  const m = await merge(repo, n);
  check(
    'VAL-REVIEW-004',
    '(d) an arena selection naming a winner opens final-selection; the winner merge 409 names it',
    sel.status === 200 && esc?.state === 'open' && m.status === 409 && m.json?.code === 'ESCALATION_OPEN' && /final-selection/.test(m.json?.error ?? ''),
    `select ${sel.status}; escalation ${esc?.reason}:${esc?.state} openedBy=${esc?.openedBy}; merge ${refusal(m)}; head=${short(sha)}`,
  );
  const res = await http(`${repoPath(repo)}/changes/${n}/escalations/${esc?.id}/resolve`, { method: 'POST', json: { resolution: 'resolve', note: 'selection confirmed' } });
  const m2 = await merge(repo, n);
  check(
    'VAL-REVIEW-004',
    '(d) a human resolve confirms the selection; the winner merges',
    res.status === 200 && res.json?.escalation?.state === 'resolved' && m2.status === 200 && m2.json?.state === 'merged' && lsRemote(repo, 'refs/heads/main') === m2.json?.mergeCommit,
    `resolve ${res.status} by ${res.json?.escalation?.resolvedBy}; merge ${m2.status} ${m2.json?.state}`,
  );
});

await scenario('exact', async (repo) => {
  await grantMaint(repo);
  const { dir, heads } = await seed(repo, ['reviewed']);
  const rule = await http(`${repoPath(repo)}/branch-rules`, { method: 'POST', json: { pattern: 'main', requiredApprovals: 1 } });
  const n = (await createChange(repo, 'reviewed')).json?.number;
  const self = await approve(repo, n, PAT, { headSha: heads.reviewed });
  const eq = await enqueue(repo, n, { headSha: heads.reviewed });
  check(
    'VAL-PROTECT-002',
    'author self-approval refused; enqueue alone does not satisfy the separate-reviewer rule',
    rule.status === 201 && self.status === 409 && self.json?.code === 'SELF_REVIEW' && eq.status === 409 && eq.json?.code === 'APPROVALS_REQUIRED',
    `self ${refusal(self)}; enqueue ${refusal(eq)}`,
  );
  const h1 = await approve(repo, n, MAINT, { headSha: heads.reviewed });
  check(
    'VAL-PROTECT-002',
    'a different human principal approval is attached to the current head SHA',
    h1.status === 201 && h1.json?.review?.reviewer?.login === MAINT_LOGIN && h1.json?.review?.headSha === heads.reviewed && h1.json?.packet?.approvals?.humans === 1,
    `reviewer ${h1.json?.review?.principal} (${h1.json?.review?.reviewer?.login}) headSha=${h1.json?.review?.headSha} humans=${h1.json?.packet?.approvals?.humans}`,
  );
  mustGit(['checkout', '-q', 'reviewed'], dir);
  writeFiles(dir, { 'reviewed.txt': 'reviewed v2\n' });
  const next = commitAll(dir, 'second head');
  await pushRetry(dir, gitUrl(repo), ['reviewed:refs/heads/reviewed']);
  const lag = await waitHead(repo, n, next);
  const p = await packet(repo, n);
  const eq2 = await enqueue(repo, n);
  const late = await approve(repo, n, MAINT, { headSha: heads.reviewed });
  check(
    'VAL-PROTECT-002',
    'pushing a new head stales the approval: publication blocked, an approval of the old head is refused',
    lag !== null && p.json?.approvals?.humans === 0 && (p.json?.reviews ?? []).every((v) => v.current === false) && eq2.status === 409 && eq2.json?.code === 'APPROVALS_REQUIRED' && late.status === 409 && late.json?.code === 'HEAD_MOVED',
    `head ${short(heads.reviewed)} -> ${short(next)} seen after ${lag} ms; ${reviewsLine(p)}; enqueue ${refusal(eq2)}; old-head approve ${refusal(late)}`,
  );
  const h2 = await approve(repo, n, MAINT, { headSha: next });
  const eq3 = await enqueue(repo, n, { headSha: next });
  const settled = await waitSettled(repo, n);
  const main = lsRemote(repo, 'refs/heads/main');
  const fresh = join(work, `${repo}-clone`);
  mustGit(['clone', '-q', gitUrl(repo), fresh], work);
  const graph = mustGit(['log', '--graph', '--format=%h %s', '-5', 'origin/main'], fresh);
  check(
    'VAL-PROTECT-002',
    'a separate approval of the new head publishes through the train; main is the merged change',
    h2.status === 201 && eq3.status === 201 && settled.change?.state === 'merged' && main === settled.change?.mergeCommit && (main === next || graph.includes(short(next).slice(0, 7))),
    `approve ${h2.status} @${short(next)}; enqueue ${eq3.status} cost ${cost('POST enqueue (approved protected)', eq3)}; merged after ${settled.ms} ms; main=${short(main)}\n${graph}`,
  );
});

for (const a of Object.values(agents)) {
  const r = await http(`/api/v1/agents/${a.id}`, { method: 'DELETE' });
  console.log(`revoke agent ${a.name}: ${r.status}`);
}
rmSync(work, { recursive: true, force: true });
console.log('\n# x-kvarm-cost');
for (const c of costs) console.log(`  ${c.label} (${c.status}): ${c.cost}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
