#!/usr/bin/env node
/**
 * Demo harness: four scripted agent principals and one scripted human drive
 * the agent-coordination core end to end through MCP against the live
 * worker, on a fresh repository, with no manual steps and no model calls.
 *
 *   node scripts/demo-harness.mjs [--keep] [--container] [--container-only]
 *
 *   1. agents create workspaces and declare intents          create_workspace
 *   2. the Nexus forecast reports the overlap                forecast
 *   3. agents push attempts and open change sets             git push, create_change_set, get_overlap
 *   4. agent reviewers review; one escalation to a human     assign_reviewer, approve_change,
 *                                                            request_changes, get_reviews, approve_change (human)
 *   5. a composed outcome is published through the queue     compose_candidates, approve_change,
 *                                                            enqueue_change, get_change
 *   6. a textual conflict is dispatched and resolved         create_change_set, list_tasks, claim_task,
 *                                                            git push, complete_task, merge_change
 *   7. a decision is recorded and read back                  record_decision, get_context
 *
 * Principals: alice and bob (authors), carol and dave (reviewers) are agent
 * principals created with create_agent and repo-scoped expiring write tokens
 * (refs/heads/agents/*) minted with create_agent_token; "human" is the owner
 * of KVARM_PAT. The agents' tokens cannot update main, so the human lands
 * changes (enqueue_change, merge_change) and resolves the escalation. Repo
 * creation and deletion are the only REST calls (bootstrap); every workflow
 * step is an MCP tool call or a git push. Agents and their tokens are revoked
 * and the repo is deleted at exit (unless --keep).
 *
 * --container adds the Container CI runner showcase after the seven steps
 * (scripts/lib/container-runner-demo.mjs, isolated so the public-beta
 * Containers surface cannot break the core run); --container-only runs just
 * that showcase.
 *
 * Environment (tokens are read by name and never printed):
 *   KVARM_BASE_URL  platform origin
 *   KVARM_PAT       api-scope PAT of the human principal (ci scope too for --container)
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper that reads the token from the environment.
 * Exit 0 only when every step held.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values: opts } = parseArgs({
  options: {
    keep: { type: 'boolean', default: false },
    container: { type: 'boolean', default: false },
    'container-only': { type: 'boolean', default: false },
  },
});
const BASE = (process.env.KVARM_BASE_URL ?? '').replace(/\/+$/, '');
const PAT = process.env.KVARM_PAT ?? '';
if (!BASE || !PAT) {
  console.error('demo-harness: KVARM_BASE_URL and KVARM_PAT must be set (set -a; . apps/platform/.dev.vars.validation; set +a)');
  process.exit(2);
}

const TS = Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 10) : String(sha));

class StepFailure extends Error {}
function expect(cond, message) {
  if (!cond) throw new StepFailure(message);
}

// ---------------------------------------------------------------------------
// REST bootstrap (repo create/delete only) and MCP principals
// ---------------------------------------------------------------------------

async function rest(path, { method = 'GET', json } = {}) {
  const headers = { Authorization: `Bearer ${PAT}` };
  if (json !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(json === undefined ? {} : { body: JSON.stringify(json) }) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, json: body, cost: res.headers.get('x-kvarm-cost') };
}

/** One MCP client per principal; the Bearer token lives only in the transport headers. */
async function connect(label, token) {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: `demo-harness-${label}`, version: '0.1.0' });
  await client.connect(transport);
  return client;
}

const principals = {};
const timings = {};

/**
 * One tools/call as `who`. Prints one transcript line `who tool -> outcome (ms)`.
 * A refused call fails the step unless `refused` names the expected error code.
 */
async function call(who, tool, args, describe = () => 'ok', { refused } = {}) {
  const p = principals[who];
  let res;
  let data = null;
  let text = '';
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    res = await p.client.callTool({ name: tool, arguments: args });
    text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (res.isError && data?.status === 429 && attempt < 4) {
      await sleep(15_000);
      continue;
    }
    break;
  }
  const ms = Date.now() - t0;
  const isError = res.isError === true;
  if (refused) {
    const ok = isError && data?.code === refused;
    console.log(`  ${who.padEnd(6)} ${tool.padEnd(19)} -> ${ok ? `refused ${data.status} ${data.code}` : `UNEXPECTED ${isError ? `${data?.status} ${data?.code}` : 'success'}`}${ok && describe ? `: ${describe(data)}` : ''} (${fmt(ms)})`);
    expect(ok, `${who} ${tool} should be refused with ${refused}, got ${isError ? `${data?.status} ${data?.code}` : 'success'}`);
    return { data, ms };
  }
  if (isError) {
    console.log(`  ${who.padEnd(6)} ${tool.padEnd(19)} -> FAILED ${text.slice(0, 300)} (${fmt(ms)})`);
    throw new StepFailure(`${who} ${tool} failed: ${data?.status ?? ''} ${data?.code ?? text.slice(0, 200)}`);
  }
  console.log(`  ${who.padEnd(6)} ${tool.padEnd(19)} -> ${describe(data)} (${fmt(ms)})`);
  return { data, ms };
}

// ---------------------------------------------------------------------------
// git (agent pushes use the agent token, passed by environment only)
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'demo-harness-'));
const askpass = join(work, 'askpass.sh');
writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv DEMO_GIT_TOKEN ;; esac\n');
chmodSync(askpass, 0o700);
const dir = join(work, 'repo');

function git(args, token = PAT) {
  const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', DEMO_GIT_TOKEN: token },
    encoding: 'utf8',
  });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function mustGit(args, token) {
  const r = git(args, token);
  if (r.code !== 0) throw new StepFailure(`git ${args[0]} failed: ${r.err.slice(0, 300)}`);
  return r.out;
}
function writeFiles(files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
function commitOn(from, files, message) {
  mustGit(['checkout', '-q', '--detach', from]);
  writeFiles(files);
  mustGit(['add', '-A']);
  mustGit(['commit', '-q', '-m', message]);
  return mustGit(['rev-parse', 'HEAD']);
}

/** `who` pushes `sha` to `ref` with their own token; prints one transcript line. */
async function push(who, sha, ref) {
  const t0 = Date.now();
  let last = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    last = git(['push', '--porcelain', state.url, `${sha}:${ref}`], principals[who].token);
    const line = last.out.split('\n').find((l) => l.includes(ref)) ?? '';
    if (last.code === 0 && line && !line.startsWith('!')) {
      console.log(`  ${who.padEnd(6)} ${'git push'.padEnd(19)} -> ${short(sha)} to ${ref} (${fmt(Date.now() - t0)})`);
      return;
    }
    await sleep(3000);
  }
  throw new StepFailure(`${who} git push ${ref} failed: ${last?.err.slice(0, 300)}`);
}

function fetchMain() {
  mustGit(['fetch', '-q', state.url, '+refs/heads/main:refs/remotes/origin/main']);
  return mustGit(['rev-parse', 'origin/main']);
}

/** Polls get_intent until the Nexus index observed `sha` as the workspace head (bounded). */
async function waitObserved(who, ws, sha) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    const r = await principals[who].client.callTool({ name: 'get_intent', arguments: { repo: state.repo, workspace: ws.id } });
    let view = null;
    try {
      view = JSON.parse(r.content?.find((c) => c.type === 'text')?.text ?? '');
    } catch {}
    if (!r.isError && view?.headSha === sha) {
      console.log(`  ${who.padEnd(6)} ${'get_intent'.padEnd(19)} -> observed ${short(sha)} on ${ws.id}: ${JSON.stringify(view.observedPaths)} (${fmt(Date.now() - t0)})`);
      return view;
    }
    await sleep(1500);
  }
  throw new StepFailure(`workspace ${ws.id} never observed ${short(sha)} within 90 s`);
}

/** The human enqueues change `number` at `headSha`; `who` polls get_change until the train publishes it (bounded). */
async function enqueueAndWait(who, number, headSha) {
  await call('human', 'enqueue_change', { repo: state.repo, number, headSha, mergePolicy: 'review' }, (d) => `queued #${d.entry.number} state ${d.entry.state}`);
  const t0 = Date.now();
  let polls = 0;
  while (Date.now() - t0 < 240_000) {
    const r = await principals[who].client.callTool({ name: 'get_change', arguments: { repo: state.repo, number } });
    polls++;
    let c = {};
    try {
      c = JSON.parse(r.content?.find((x) => x.type === 'text')?.text ?? '{}');
    } catch {}
    if (c.state === 'merged') {
      console.log(`  ${who.padEnd(6)} ${'get_change'.padEnd(19)} -> #${number} merged as ${short(c.mergeCommit)} after ${polls} polls (${fmt(Date.now() - t0)})`);
      return c;
    }
    expect(!['ejected', 'stale', 'dequeued'].includes(c.queueState), `the train left #${number} ${c.queueState}`);
    await sleep(2000);
  }
  throw new StepFailure(`the train did not publish #${number} within 240 s`);
}

// ---------------------------------------------------------------------------
// fixture content
// ---------------------------------------------------------------------------

const UTIL = (rate, retry) => `// Request utilities for the demo service.
export function rateLimit(requests) {
${rate}
}

export function normalize(name) {
  return name.trim().toLowerCase();
}

export function describe(user) {
  return \`\${user.name} <\${user.email}>\`;
}

export function retry(fn) {
${retry}
}
`;
const RATE_BASE = '  return requests;';
const RETRY_BASE = '  return fn();';
const RATE_ALICE = '  // alice: token bucket, 10 requests per window\n  return requests.slice(0, 10);';
const RETRY_BOB = '  // bob: retry transient failures once\n  try {\n    return fn();\n  } catch {\n    return fn();\n  }';
const CONFIG = (limit) => `export const config = {\n  service: 'demo',\n  limit: ${limit},\n  retries: 1,\n};\n`;

const SEED = {
  'README.md': '# demo service\n\nSeeded by scripts/demo-harness.mjs.\n',
  'src/util.js': UTIL(RATE_BASE, RETRY_BASE),
  'src/app.js': "import { rateLimit, retry } from './util.js';\n\nexport const handle = (requests) => retry(() => rateLimit(requests));\n",
  'src/config.js': CONFIG(10),
  'docs/guide.md': '# guide\n\nCall handle() with a list of requests.\n',
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const state = {};
const results = [];
let failed = false;

async function step(n, title, body) {
  if (failed) {
    results.push({ n, title, status: 'skipped', ms: 0 });
    console.log(`\n== Step ${n}/7 ${title}: skipped (an earlier step failed)`);
    return;
  }
  console.log(`\n== Step ${n}/7 ${title}`);
  const t0 = Date.now();
  try {
    const summary = await body();
    const ms = Date.now() - t0;
    results.push({ n, title, status: 'ok', ms, summary });
    console.log(`   step ${n} ok in ${fmt(ms)}: ${summary}`);
  } catch (err) {
    const ms = Date.now() - t0;
    failed = true;
    results.push({ n, title, status: 'FAILED', ms, summary: err instanceof Error ? err.message : String(err) });
    console.log(`   step ${n} FAILED after ${fmt(ms)}: ${err instanceof StepFailure ? err.message : err?.stack ?? err}`);
  }
}

async function setup() {
  console.log('== Setup (REST bootstrap + principals)');
  principals.human = { token: PAT, client: await connect('human', PAT) };
  const me = await call('human', 'get_user', {}, (d) => `human principal is ${d.user.login}${d.user.isAdmin ? ' (instance admin)' : ''}`);
  state.owner = me.data.user.login;
  state.name = `demo-harness-run-${TS}`;
  state.repo = `${state.owner}/${state.name}`;
  state.url = `${BASE}/${state.owner}/${state.name}.git`;
  const t0 = Date.now();
  const made = await rest('/api/v1/repos', { method: 'POST', json: { name: state.name, visibility: 'private', description: 'demo-harness scratch repo' } });
  console.log(`  human  ${'REST POST repos'.padEnd(19)} -> ${made.status} ${state.repo} (private) (${fmt(Date.now() - t0)})`);
  if (made.status !== 201) throw new StepFailure(`repo create failed: ${made.status} ${made.json?.code ?? ''}`);
  state.created = true;

  mkdirSync(dir);
  mustGit(['init', '-q', '-b', 'main']);
  writeFiles(SEED);
  mustGit(['add', '-A']);
  mustGit(['commit', '-q', '-m', 'Seed the demo service']);
  state.seed = mustGit(['rev-parse', 'HEAD']);
  const t1 = Date.now();
  mustGit(['push', '-q', state.url, 'main:refs/heads/main']);
  console.log(`  human  ${'git push'.padEnd(19)} -> seed ${short(state.seed)} to refs/heads/main (${fmt(Date.now() - t1)})`);

  const roster = [
    ['alice', 'claude', 'author: rate limiting'],
    ['bob', 'gpt', 'author: retries'],
    ['carol', 'gemini', 'reviewer'],
    ['dave', 'claude', 'reviewer'],
  ];
  state.agents = [];
  for (const [who, family, role] of roster) {
    const name = `demo-${who}-${TS}`;
    const agent = await call('human', 'create_agent', { name, modelFamily: family, description: `demo-harness ${role}` }, (d) => `agent ${d.agent.name} (${d.agent.modelFamily}) id ${d.agent.id}`);
    state.agents.push(agent.data.agent.id);
    // The minted token is shown once; it is kept in memory and never printed.
    const minted = await call(
      'human',
      'create_agent_token',
      { id: agent.data.agent.id, repo: state.repo, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 3600, name: 'demo-harness' },
      (d) => `write token for ${state.repo} refs/heads/agents/* expiring ${d.expiresAt ?? 'in 1 h'} (kept in memory, not shown)`,
    );
    principals[who] = { token: minted.data.token, agentId: agent.data.agent.id, family, client: await connect(who, minted.data.token) };
  }
}

async function main() {
  await setup();

  await step(1, 'agents create workspaces and declare intents', async () => {
    const w1 = await call('alice', 'create_workspace', { repo: state.repo, task: 'Add a token-bucket rate limit', intent: { paths: ['src/util.js', 'src/limits.js'] } }, (d) => `workspace ${d.id} ${d.ref} declares ${JSON.stringify(d.declaredPaths)}`);
    const w2 = await call('bob', 'create_workspace', { repo: state.repo, task: 'Retry transient failures', intent: { paths: ['src/util.js', 'docs/guide.md'] } }, (d) => `workspace ${d.id} ${d.ref} declares ${JSON.stringify(d.declaredPaths)}`);
    state.w1 = w1.data;
    state.w2 = w2.data;
    expect(state.w1.agentId === principals.alice.agentId && state.w2.agentId === principals.bob.agentId, 'workspaces are owned by their agents');
    return `alice ${state.w1.id} and bob ${state.w2.id} declared intents`;
  });

  await step(2, 'the Nexus forecast reports an overlap', async () => {
    const fc = await call('bob', 'forecast', { repo: state.repo, paths: ['src/util.js', 'docs/guide.md'], exclude: state.w2.id }, (d) => {
      const m = d.matches?.find((x) => x.workspace === state.w1.id);
      return m ? `overlap with ${m.agent}'s workspace ${m.workspace} on ${m.evidence.map((e) => `${e.path} (${e.kind})`).join(', ')}; advisory=${d.advisory}` : `no match (${JSON.stringify(d.matches)})`;
    });
    timings.forecastMs = fc.ms;
    const match = fc.data.matches?.find((m) => m.workspace === state.w1.id);
    expect(match && match.evidence.some((e) => e.path === 'src/util.js' && e.kind === 'declared'), "forecast did not report alice's declared src/util.js");
    return `forecast names alice's workspace on src/util.js (declared) in ${fmt(fc.ms)}`;
  });

  await step(3, 'agents push attempts and open change sets', async () => {
    state.a1 = commitOn(state.seed, { 'src/util.js': UTIL(RATE_ALICE, RETRY_BASE), 'src/limits.js': 'export const WINDOW = 10;\n' }, 'Add a token-bucket rate limit');
    state.b1 = commitOn(state.seed, { 'src/util.js': UTIL(RATE_BASE, RETRY_BOB), 'docs/guide.md': '# guide\n\nCall handle() with a list of requests.\nTransient failures are retried once.\n' }, 'Retry transient failures');
    await push('alice', state.a1, state.w1.ref);
    await push('bob', state.b1, state.w2.ref);
    await waitObserved('alice', state.w1, state.a1);
    await waitObserved('bob', state.w2, state.b1);
    const c1 = await call('alice', 'create_change_set', { repo: state.repo, workspace: state.w1.id, title: 'Add a token-bucket rate limit', mergePolicy: 'review' }, (d) => `change #${d.number} ${d.state} head ${short(d.headSha)}`);
    const c2 = await call('bob', 'create_change_set', { repo: state.repo, workspace: state.w2.id, title: 'Retry transient failures', mergePolicy: 'review' }, (d) => `change #${d.number} ${d.state} head ${short(d.headSha)}`);
    state.c1 = c1.data;
    state.c2 = c2.data;
    expect(state.c1.state === 'open' && state.c2.state === 'open', 'both change sets open');
    const ov = await call('carol', 'get_overlap', { repo: state.repo }, (d) => d.pairs.map((p) => `${p.workspaces.join(' x ')} ${p.matchKind} on ${p.paths.join(', ')}`).join('; ') || 'no pairs');
    expect(ov.data.pairs.some((p) => p.workspaces.includes(state.w1.id) && p.workspaces.includes(state.w2.id) && p.paths.includes('src/util.js')), 'observed overlap pair on src/util.js');
    return `changes #${state.c1.number} and #${state.c2.number} open; observed overlap on src/util.js`;
  });

  await step(4, 'agent reviewers review; one escalation goes to a human', async () => {
    await call('human', 'set_review_policy', { repo: state.repo, requiredReviews: 1 }, (d) => `review policy: ${d.requiredReviews} approving review of the current head`);
    const reviewers = [principals.carol.agentId, principals.dave.agentId];
    const asg1 = await call('alice', 'assign_reviewer', { repo: state.repo, number: state.c1.number, candidates: reviewers }, (d) => `assigned ${d.assigned?.agent?.name} (${d.assigned?.modelFamily}) for a ${d.author.modelFamily} author; different family preferred, met=${d.preference.met}`);
    expect(asg1.data.assigned?.agent?.id === principals.carol.agentId && asg1.data.preference.met, 'carol (different family) assigned to the claude author');
    await call('carol', 'approve_change', { repo: state.repo, number: state.c1.number, headSha: state.a1, body: 'Rate limit looks right.' }, (d) => `approved #${state.c1.number} at ${short(d.review.headSha)}; approvals ${d.packet.approvals.count}/${d.packet.approvals.required}`);
    await call('bob', 'assign_reviewer', { repo: state.repo, number: state.c2.number, candidates: reviewers }, (d) => `assigned ${d.assigned?.agent?.name} (${d.assigned?.modelFamily}); met=${d.preference.met}`);
    await call('carol', 'approve_change', { repo: state.repo, number: state.c2.number, headSha: state.b1, body: 'Retry is fine.' }, (d) => `approved #${state.c2.number}; approvals ${d.packet.approvals.count}/${d.packet.approvals.required}`);
    await call('dave', 'request_changes', { repo: state.repo, number: state.c2.number, headSha: state.b1, body: 'A retry on every error can double-submit writes.' }, (d) => `requested changes on #${state.c2.number}; open escalations ${JSON.stringify(d.packet.escalations.filter((e) => e.state === 'open').map((e) => e.reason))}`);
    const pk = await call('bob', 'get_reviews', { repo: state.repo, number: state.c2.number }, (d) => `escalations ${JSON.stringify(d.escalations.map((e) => ({ id: e.id, reason: e.reason, state: e.state })))}; blockers ${JSON.stringify(d.blockers.map((b) => b.code))}`);
    const open = pk.data.escalations.filter((e) => e.state === 'open');
    expect(open.length === 1 && open[0].reason === 'reviewer-disagreement', 'exactly one open reviewer-disagreement escalation');
    state.escalation = open[0];
    await call('human', 'merge_change', { repo: state.repo, number: state.c2.number }, (d) => (d.error ?? '').slice(0, 120), { refused: 'ESCALATION_OPEN' });
    await call('dave', 'resolve_escalation', { repo: state.repo, number: state.c2.number, id: state.escalation.id }, () => 'agents cannot close an escalation', { refused: 'HUMAN_REQUIRED' });
    // The human minted these agents, so its approval of their change is not independent and
    // does not close the escalation; the human answers it explicitly instead.
    const human = await call(
      'human',
      'resolve_escalation',
      { repo: state.repo, number: state.c2.number, id: state.escalation.id, resolution: 'resolve', note: 'Human decision: retry stays, writes are idempotent here.' },
      (d) => `escalation ${d.escalation.reason} ${d.escalation.state} by ${d.escalation.resolvedBy} (${d.escalation.resolution}); satisfied=${d.packet.satisfied}`,
    );
    expect(human.data.escalation.state === 'resolved' && human.data.packet.satisfied === true, 'the human resolved the escalation and the gate is satisfied');
    const p1 = await call('alice', 'get_reviews', { repo: state.repo, number: state.c1.number }, (d) => `#${state.c1.number}: escalations ${d.escalations.length}, satisfied=${d.satisfied}`);
    const p2 = await call('bob', 'get_reviews', { repo: state.repo, number: state.c2.number }, (d) => `#${state.c2.number}: escalations ${d.escalations.length} (${d.escalations.map((e) => `${e.reason}:${e.state}`).join(', ')}), satisfied=${d.satisfied}`);
    const total = p1.data.escalations.length + p2.data.escalations.length;
    expect(total === 1, `exactly one escalation across the attempts (saw ${total})`);
    return `carol approved both, dave blocked #${state.c2.number}; escalation ${state.escalation.id} resolved by the human`;
  });

  await step(5, 'a composed outcome from both attempts is published through the queue', async () => {
    const comp = await call(
      'alice',
      'compose_candidates',
      { repo: state.repo, workspaces: [state.w1.id, state.w2.id], title: 'Rate limit + retry (composed from both attempts)', mergePolicy: 'review' },
      (d) => `composition ${d.id}: tree ${short(d.treeSha)} commit ${short(d.commitSha)} from ${d.sources.map((s) => `${s.workspace}@${short(s.headSha)}`).join(' + ')}; change #${d.changeSet}; checks ${d.checks.state}`,
    );
    timings.composeMs = comp.ms;
    state.comp = comp.data;
    expect(state.comp.sources.length === 2 && state.comp.conflict === null && Number.isInteger(state.comp.changeSet), 'composed candidate with two sources and a change set');
    await call('carol', 'approve_change', { repo: state.repo, number: state.comp.changeSet, headSha: state.comp.commitSha, body: 'Both pieces compose cleanly.' }, (d) => `approved #${state.comp.changeSet}; approvals ${d.packet.approvals.count}/${d.packet.approvals.required}`);
    await call('dave', 'approve_change', { repo: state.repo, number: state.comp.changeSet, headSha: state.comp.commitSha, body: 'Retry is bounded in the composition.' }, (d) => `approved #${state.comp.changeSet}; escalations ${d.packet.escalations.length}`);
    const t0 = Date.now();
    const landed = await enqueueAndWait('alice', state.comp.changeSet, state.comp.commitSha);
    timings.trainMs = Date.now() - t0;
    const file = await call('human', 'read_file', { repo: state.repo, path: 'src/util.js', ref: 'main' }, (d) => `main src/util.js has alice's rate limit: ${d.content.includes('alice: token bucket')}, bob's retry: ${d.content.includes('bob: retry')}`);
    expect(file.data.content.includes('alice: token bucket') && file.data.content.includes('bob: retry'), 'main carries both attempts');
    await call('alice', 'abandon_workspace', { repo: state.repo, workspace: state.w1.id }, (d) => `${d.id} ${d.status}; #${state.c1.number} superseded by the composition`);
    await call('bob', 'abandon_workspace', { repo: state.repo, workspace: state.w2.id }, (d) => `${d.id} ${d.status}; #${state.c2.number} superseded by the composition`);
    state.mainAfterCompose = landed.mergeCommit;
    return `composition ${state.comp.id} landed as ${short(landed.mergeCommit)} through the train in ${fmt(timings.trainMs)}`;
  });

  await step(6, 'a textual conflict is dispatched as a task, claimed and resolved by an agent', async () => {
    const main1 = fetchMain();
    const w4 = await call('alice', 'create_workspace', { repo: state.repo, task: 'Tighten the request limit', intent: { paths: ['src/config.js'] } }, (d) => `workspace ${d.id}`);
    const w3 = await call('bob', 'create_workspace', { repo: state.repo, task: 'Raise the request limit', intent: { paths: ['src/config.js'] } }, (d) => `workspace ${d.id}`);
    const tight = commitOn(main1, { 'src/config.js': CONFIG(5) }, 'Tighten the request limit to 5');
    const raise = commitOn(main1, { 'src/config.js': CONFIG(25) }, 'Raise the request limit to 25');
    await push('alice', tight, w4.data.ref);
    await push('bob', raise, w3.data.ref);
    await waitObserved('alice', w4.data, tight);
    await waitObserved('bob', w3.data, raise);
    const c4 = await call('alice', 'create_change_set', { repo: state.repo, workspace: w4.data.id, title: 'Tighten the request limit', mergePolicy: 'review' }, (d) => `change #${d.number} ${d.state}`);
    await call('carol', 'approve_change', { repo: state.repo, number: c4.data.number, headSha: tight }, () => `approved #${c4.data.number}`);
    await call('human', 'merge_change', { repo: state.repo, number: c4.data.number }, (d) => `#${d.number} ${d.state} (${d.merge?.kind}) -> main ${short(d.mergeCommit)}`);
    const c3 = await call('bob', 'create_change_set', { repo: state.repo, workspace: w3.data.id, title: 'Raise the request limit', mergePolicy: 'review' }, (d) => `change #${d.number} ${d.state}; conflicts ${JSON.stringify(d.conflicts)}`);
    expect(c3.data.state === 'conflicted' && c3.data.conflicts.some((c) => c.path === 'src/config.js'), 'the change is conflicted on src/config.js');
    const tasks = await call('bob', 'list_tasks', { repo: state.repo, status: 'open', kind: 'resolve-conflict' }, (d) => d.tasks.map((t) => `task ${t.id} for #${t.change?.number} on ${t.conflicts?.map((c) => c.path).join(',')}`).join('; ') || 'none');
    const task = tasks.data.tasks.find((t) => t.change?.number === c3.data.number);
    expect(task, 'a resolve-conflict task was dispatched for the conflicted change');
    state.task = task;
    const claim = await call('bob', 'claim_task', { repo: state.repo, task: task.id, ttlSeconds: 600 }, (d) => `claimed by ${d.task.claimedBy} generation ${d.lease.generation} until ${d.lease.until}; workspace ${d.workspace.id} at ${short(d.workspace.headSha)}`);

    const main2 = fetchMain();
    mustGit(['checkout', '-q', '--detach', raise]);
    const merged = git(['merge', '--no-edit', '-q', 'origin/main']);
    writeFiles({ 'src/config.js': "export const config = {\n  service: 'demo',\n  // resolved: keep the tighter steady limit, allow bursts up to the raised one\n  limit: 5,\n  burst: 25,\n  retries: 1,\n};\n" });
    mustGit(['add', '-A']);
    mustGit(['commit', '-q', '-m', `Resolve src/config.js conflict (task ${task.id})`]);
    const resolution = mustGit(['rev-parse', 'HEAD']);
    console.log(`  bob    ${'git merge'.padEnd(19)} -> origin/main ${short(main2)} into ${short(raise)}: exit ${merged.code} (conflict), resolved as ${short(resolution)}`);
    await push('bob', resolution, claim.data.workspace.ref);
    const done = await call('bob', 'complete_task', { repo: state.repo, task: task.id, generation: claim.data.lease.generation, sha: resolution }, (d) => `task ${d.task.status}; change #${d.change.number} ${d.change.state} at ${short(d.change.headSha)}; head branch updated=${d.headBranch.updated}`);
    expect(done.data.task.status === 'completed' && done.data.change.state === 'open' && done.data.change.headSha === resolution, 'the resolution moved the change out of conflict');
    await call('carol', 'approve_change', { repo: state.repo, number: c3.data.number, headSha: resolution, body: 'Resolution keeps both intents.' }, () => `approved the resolution of #${c3.data.number}`);
    // The resolution is a merge commit, so the semantic guard checks it; the train waits for that.
    const landed = await enqueueAndWait('bob', c3.data.number, resolution);
    const cfg = await call('human', 'read_file', { repo: state.repo, path: 'src/config.js', ref: 'main' }, (d) => `main src/config.js: ${JSON.stringify(d.content.split('\n').filter((l) => /limit|burst/.test(l)).map((l) => l.trim()))}`);
    expect(cfg.data.content.includes('burst: 25'), 'the resolved change landed');
    state.c3 = c3.data.number;
    state.c3Head = raise;
    state.resolution = resolution;
    return `task ${task.id} claimed and completed by bob; #${c3.data.number} landed as ${short(landed.mergeCommit)}`;
  });

  await step(7, 'a decision is recorded and returned by get_context', async () => {
    const decision = {
      repo: state.repo,
      task: state.task.id,
      paths: ['src/config.js'],
      chosen: state.resolution,
      rejected: [
        { id: `#${state.c3}@${short(state.c3Head)}`, reason: 'raising the steady limit to 25 alone defeats the rate limit' },
        { id: 'limit-5-only', reason: 'a hard limit of 5 alone drops legitimate bursts' },
      ],
      reason: 'keep the tighter steady limit and admit bursts up to the raised value',
    };
    await call('bob', 'record_decision', decision, (d) => `decision ${d.id} by agent ${d.agent?.name} (owner ${d.actor}): chosen ${short(d.chosen)}, rejected ${d.rejected.length}`);
    const compDecision = {
      repo: state.repo,
      task: 'rate-limit-and-retry',
      paths: ['src/util.js'],
      chosen: `composition:${state.comp.id}`,
      rejected: [
        { id: `#${state.c1.number}`, reason: 'rate limit alone leaves transient failures unhandled' },
        { id: `#${state.c2.number}`, reason: 'retry alone leaves the service unthrottled' },
      ],
      reason: 'the two attempts touch separate hunks and compose cleanly',
    };
    await call('alice', 'record_decision', compDecision, (d) => `decision ${d.id} by agent ${d.agent?.name} (owner ${d.actor}): chosen ${d.chosen}, rejected ${d.rejected.map((r) => r.id).join(', ')}`);
    const byTask = await call('dave', 'get_context', { repo: state.repo, task: state.task.id }, (d) => d.decisions.map((x) => `chosen ${short(x.chosen)} rejected [${x.rejected.map((r) => `${r.id}: ${r.reason}`).join('; ')}] because ${x.reason}`).join(' | '));
    const byPath = await call('carol', 'get_context', { repo: state.repo, path: ['src/util.js'] }, (d) => d.decisions.map((x) => `chosen ${x.chosen} rejected [${x.rejected.map((r) => r.id).join(', ')}] because ${x.reason}`).join(' | '));
    const t = byTask.data.decisions?.[0];
    const p = byPath.data.decisions?.[0];
    expect(t?.chosen === state.resolution && t.rejected.length === 2 && t.reason === decision.reason && t.agent?.id === principals.bob.agentId, 'get_context(task) returns the conflict decision');
    expect(p?.chosen === compDecision.chosen && p.rejected.length === 2 && p.reason === compDecision.reason, 'get_context(path) returns the composition decision');
    return `get_context(task) and get_context(path) return both decisions with chosen, rejected and reasons`;
  });
}

async function cleanup() {
  console.log('\n== Cleanup');
  for (const [who, p] of Object.entries(principals)) {
    if (who === 'human') continue;
    try {
      await p.client.close();
    } catch {}
  }
  for (const id of state.agents ?? []) {
    try {
      await call('human', 'revoke_agent', { id }, (d) => `agent ${d.agent?.name ?? id} ${d.agent?.status ?? 'revoked'}; its tokens stop working`);
    } catch (err) {
      console.log(`  human  revoke_agent ${id} failed: ${err.message}`);
      failed = true;
    }
  }
  if (state.created && !opts.keep) {
    const del = await rest(`/api/v1/repos/${state.owner}/${state.name}`, { method: 'DELETE' });
    console.log(`  human  ${'REST DELETE repo'.padEnd(19)} -> ${del.status} ${state.repo}`);
    if (del.status !== 200) failed = true;
  } else if (state.created) {
    console.log(`  kept ${state.repo} (--keep)`);
  }
  try {
    await principals.human?.client.close();
  } catch {}
  rmSync(work, { recursive: true, force: true });
}

const started = Date.now();
let containerOk = true;
try {
  if (!opts['container-only']) {
    try {
      await main();
    } catch (err) {
      failed = true;
      console.log(`\nsetup FAILED: ${err instanceof StepFailure ? err.message : err?.stack ?? err}`);
    } finally {
      await cleanup();
    }
  }
  if (opts.container || opts['container-only']) {
    const { runContainerShowcase } = await import('./lib/container-runner-demo.mjs');
    containerOk = await runContainerShowcase({ base: BASE, pat: PAT, ts: TS, keep: opts.keep });
  }
} finally {
  if (!opts['container-only']) {
    console.log('\n== Transcript summary');
    for (const r of results) console.log(`  step ${r.n} ${r.status.padEnd(7)} ${fmt(r.ms).padStart(8)}  ${r.title}`);
    if (timings.forecastMs !== undefined) console.log(`  timings: forecast ${fmt(timings.forecastMs)}, compose ${fmt(timings.composeMs ?? 0)}, train publication ${fmt(timings.trainMs ?? 0)}`);
    const ok = results.filter((r) => r.status === 'ok').length;
    console.log(`  ${ok}/7 steps passed in ${fmt(Date.now() - started)}`);
  }
}
const allOk = (opts['container-only'] || (!failed && results.length === 7 && results.every((r) => r.status === 'ok'))) && containerOk;
process.exit(allOk ? 0 : 1);
