/**
 * Agent dispatch of resolve-conflict tasks (services/tasks.ts): claim with an
 * expiring generation/owner-fenced lease and a workspace at the conflicting
 * head, heartbeat, reclaim after expiry, and completion that moves the
 * change to the pushed resolution and then follows its mergePolicy. Runs
 * through the Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode, parseTree } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { recordGuard } from '../src/services/changes';
import { FakeRepo, commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, fakeEvents, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const baseEnv = cfEnv as unknown as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'td-owner';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

/** Waits out a `ttlSeconds: 1` claim lease, with margin, for the reclaim tests. */
const expiredLease = () => new Promise((r) => setTimeout(r, 1100));

const seedUser = (login: string) => seedUserBase(env, login, { userIds });
const seedRepo = async (name: string) => (await seedRepoBase(env, name, { owner: OWNER, visibility: 'public', repoIds })).repo;
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const repoPath = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const createChange = (repo: string, mergePolicy: string) =>
  call('POST', repoPath(repo, '/changes'), tok.owner, { title: `${mergePolicy} change`, base: 'main', head: 'feature', mergePolicy });
const getChange = (repo: string, n = 1) => call('GET', repoPath(repo, `/changes/${n}`), tok.owner);
const getTask = (repo: string, id: string, token: string | undefined = tok.owner) => call('GET', repoPath(repo, `/tasks/${id}`), token);
const claim = (repo: string, id: string, body: Record<string, unknown>, token = tok.owner) => call('POST', repoPath(repo, `/tasks/${id}/claim`), token, body);
const heartbeat = (repo: string, id: string, body: Record<string, unknown>) => call('POST', repoPath(repo, `/tasks/${id}/heartbeat`), tok.owner, body);
const complete = (repo: string, id: string, body: Record<string, unknown>, token = tok.owner) =>
  call('POST', repoPath(repo, `/tasks/${id}/complete`), token, body);

const LINES = Array.from({ length: 20 }, (_, i) => `const line${i + 1} = ${i + 1};`);
const appWith = (edits: Record<number, string>) => LINES.map((l, i) => (edits[i + 1] ?? l) + '\n').join('');
const BASE: Files = { 'src/app.ts': appWith({}), 'README.md': 'readme\n' };
const MAIN_EDIT = { 9: 'const line9 = "main";' };
const FEATURE_EDIT = { 9: 'const line9 = "feature";' };
const RESOLVED = appWith({ 9: 'const line9 = "main" + "feature";' });

/** A genuine conflict on src/app.ts line 9; the change is opened from `feature`. */
async function conflictFixture(repo: FakeRepo) {
  const root = await commit(repo, BASE);
  const main = await commit(repo, { ...BASE, 'src/app.ts': appWith(MAIN_EDIT) }, [root.sha]);
  const feature = await commit(repo, { ...BASE, 'src/app.ts': appWith(FEATURE_EDIT) }, [root.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  return { root, main, feature };
}

/** The resolution an agent pushes: base merged into the conflicting head, line 9 carrying both intents. */
async function resolution(repo: FakeRepo, feature: string, main: string, content = RESOLVED) {
  return commit(repo, { ...BASE, 'src/app.ts': content }, [feature, main]);
}

function commitOf(repo: FakeRepo, sha: string): { tree: string; parents: string[] } {
  const o = repo.objects.get(sha);
  expect(o?.type).toBe('commit');
  const head = decode(o!.content).split('\n\n')[0]!;
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
  };
}

/** Content of `path` in a commit's tree. */
function fileAt(repo: FakeRepo, sha: string, path: string): string | null {
  let tree = commitOf(repo, sha).tree;
  const parts = path.split('/');
  for (const [i, part] of parts.entries()) {
    const found = parseTree(repo.objects.get(tree)!.content).find((e) => e.name === part)?.hash;
    if (!found) return null;
    if (i === parts.length - 1) return decode(repo.objects.get(found)!.content);
    tree = found;
  }
  return null;
}

/** Sets up a conflicted change with `policy` and returns its one open task. */
async function dispatched(name: string, policy: string) {
  const repo = await seedRepo(name);
  const fx = await conflictFixture(repo);
  const created = await createChange(name, policy);
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.state).toBe('conflicted');
  const listed = await call('GET', repoPath(name, '/tasks?status=open'), tok.owner);
  expect(listed.json.tasks).toHaveLength(1);
  return { repo, ...fx, task: listed.json.tasks[0] as Record<string, any> };
}

async function agentToken(repo: string, name: string, refs = ['refs/heads/agents/*']): Promise<{ token: string; agentId: string }> {
  const agent = await call('POST', '/api/v1/agents', tok.owner, { name });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, { repo: `${OWNER}/${repo}`, role: 'write', refs });
  expect(minted.status).toBe(201);
  return { token: minted.json.token as string, agentId: agent.json.agent.id as string };
}

async function workspaceCount(name: string): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE repo_id = ?').bind(repoIds[name]).first<{ n: number }>())!.n;
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('td-reader'), 'reader', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('td-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('records one kvarm.task.created event per dispatched task (outbound for external agent runners)', async () => {
    const { task } = await dispatched('event', 'review');
    await getChange('event');
    await call('POST', repoPath('event', '/changes/1/merge'), tok.owner);
    const rows = (
      await env.DB.prepare(`SELECT payload FROM events WHERE type = 'kvarm.task.created' AND json_extract(payload, '$.subject') = ?`)
        .bind(task.id)
        .all<{ payload: string }>()
    ).results;
    expect(rows).toHaveLength(1);
    const event = JSON.parse(rows[0]!.payload);
    expect(event).toMatchObject({
      specversion: '1.0',
      type: 'kvarm.task.created',
      source: `/repos/${OWNER}/event`,
      subject: task.id,
      data: { task: task.id, kind: 'resolve-conflict', repo: `${OWNER}/event`, change: 1, headSha: task.headSha, baseSha: task.baseSha },
    });
    expect(new Date(event.time).toISOString()).toBe(event.time);
  });
});

describe('claim', () => {
  it('creates a workspace at the conflicting head, records the claimant with a lease and refuses a second live claim (VAL-DISPATCH-002/007)', async () => {
    const { repo, feature, task } = await dispatched('claim', 'review');
    const c = await claim('claim', task.id, { agent: 'claude-code-1', ttlSeconds: 120 });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const ws = c.json.workspace;
    expect(ws).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{16}$/), ref: expect.stringMatching(/^refs\/heads\/agents\/[0-9a-f]{16}\/resolve-conflict-1$/), headSha: feature.sha, base: 'main', agent: 'claude-code-1', status: 'active' });
    expect(repo.refs.get(ws.ref)).toBe(feature.sha);
    expect(c.json.task).toMatchObject({ id: task.id, status: 'claimed', claimedBy: 'claude-code-1', generation: 1, workspace: ws.id, change: { number: 1, state: 'conflicted' } });
    expect(c.json.task.lease).toMatchObject({ generation: 1, holder: 'claude-code-1', expired: false });
    const until = Date.parse(c.json.task.lease.until);
    expect(until).toBeGreaterThan(Date.now() + 100_000);
    expect(c.json.lease).toEqual(c.json.task.lease);

    const second = await claim('claim', task.id, { agent: 'claude-code-2' });
    expect([second.status, second.json.code]).toEqual([409, 'CLAIMED']);
    expect(second.json.error).toContain('claude-code-1');
    expect(second.json).toMatchObject({ claimedBy: 'claude-code-1', lease: { generation: 1 } });
    expect(second.json.retryAfterMs).toBeGreaterThan(0);

    const got = await getTask('claim', task.id);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ status: 'claimed', claimedBy: 'claude-code-1', generation: 1, workspace: ws.id, lease: { generation: 1 } });
    expect(await workspaceCount('claim')).toBe(1);
    expect((await call('GET', repoPath('claim', '/tasks?status=claimed'), tok.owner)).json.tasks.map((t: any) => t.id)).toEqual([task.id]);
    expect((await call('GET', repoPath('claim', '/tasks?status=open'), tok.owner)).json.tasks).toEqual([]);
  });

  it('needs write access; readers and outsiders are refused, unknown tasks are 404', async () => {
    const { task } = await dispatched('claim-access', 'review');
    await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(repoIds['claim-access'], userIds['td-reader'], 'read', userIds[OWNER], Date.now(), Date.now())
      .run();
    expect((await claim('claim-access', task.id, { agent: 'r' }, tok.reader)).status).toBe(403);
    expect((await getTask('claim-access', task.id, tok.reader)).status).toBe(200);
    expect((await claim('claim-access', task.id, { agent: 'o' }, tok.outsider)).status).toBe(403);
    const missing = await claim('claim-access', crypto.randomUUID(), { agent: 'a' });
    expect([missing.status, missing.json.code]).toEqual([404, 'TASK_NOT_FOUND']);
    expect((await getTask('claim-access', 'not-a-task')).json.code).toBe('TASK_NOT_FOUND');
    const bad = await claim('claim-access', task.id, { agent: 'a', ttlSeconds: 0 });
    expect([bad.status, bad.json.code]).toEqual([422, 'INVALID_TTL']);
    expect(await workspaceCount('claim-access')).toBe(0);
  });

  it('heartbeat extends a live lease; a wrong generation or claimant is refused', async () => {
    const { task } = await dispatched('heartbeat', 'review');
    const c = await claim('heartbeat', task.id, { agent: 'claude-code-1', ttlSeconds: 30 });
    const before = Date.parse(c.json.task.lease.until);
    const hb = await heartbeat('heartbeat', task.id, { agent: 'claude-code-1', generation: 1, ttlSeconds: 600 });
    expect(hb.status, JSON.stringify(hb.json)).toBe(200);
    expect(Date.parse(hb.json.lease.until)).toBeGreaterThan(before);
    expect(hb.json).toMatchObject({ status: 'claimed', generation: 1, claimedBy: 'claude-code-1' });
    const stale = await heartbeat('heartbeat', task.id, { agent: 'claude-code-1', generation: 7 });
    expect([stale.status, stale.json.code]).toEqual([409, 'STALE_GENERATION']);
    const other = await heartbeat('heartbeat', task.id, { agent: 'someone-else', generation: 1 });
    expect([other.status, other.json.code]).toEqual([409, 'NOT_CLAIMANT']);
    const missingGen = await heartbeat('heartbeat', task.id, { agent: 'claude-code-1' });
    expect([missingGen.status, missingGen.json.code]).toEqual([422, 'INVALID_GENERATION']);
  });
});

describe('dead agents cannot strand a task', () => {
  it('an expired claim is re-dispensed with the next generation and the same workspace; the stale holder cannot complete (VAL-WORKFLOW-001/002)', async () => {
    const { repo, main, feature, task } = await dispatched('reclaim', 'review');
    const first = await claim('reclaim', task.id, { agent: 'claude-code-1', ttlSeconds: 1 });
    expect(first.status).toBe(200);
    await expiredLease();

    const got = await getTask('reclaim', task.id);
    expect(got.json).toMatchObject({ status: 'open', claimedBy: 'claude-code-1', lease: { generation: 1, expired: true } });
    expect((await call('GET', repoPath('reclaim', '/tasks?status=open'), tok.owner)).json.tasks.map((t: any) => t.id)).toEqual([task.id]);

    const second = await claim('reclaim', task.id, { agent: 'claude-code-2', ttlSeconds: 120 });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.task).toMatchObject({ status: 'claimed', claimedBy: 'claude-code-2', generation: 2, lease: { generation: 2, expired: false } });
    expect(second.json.workspace.id).toBe(first.json.workspace.id);
    expect(await workspaceCount('reclaim')).toBe(1);

    // Agent one comes back, pushes and tries to complete with its old generation.
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(first.json.workspace.ref, res.sha);
    const stale = await complete('reclaim', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([stale.status, stale.json.code]).toEqual([409, 'STALE_GENERATION']);
    expect(stale.json.error).toMatch(/generation 1/);
    const after = await getTask('reclaim', task.id);
    expect(after.json).toMatchObject({ status: 'claimed', claimedBy: 'claude-code-2', generation: 2, workspace: first.json.workspace.id });
    const change = await getChange('reclaim');
    expect(change.json).toMatchObject({ state: 'conflicted', headSha: feature.sha });
    expect(repo.refs.get(FEATURE)).toBe(feature.sha);

    // Agent two completes the same pushed resolution under its own generation.
    const done = await complete('reclaim', task.id, { agent: 'claude-code-2', generation: 2 });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.task).toMatchObject({ status: 'completed', generation: 2, claimedBy: 'claude-code-2', resolutionSha: res.sha });
  });
});

describe('agent tokens', () => {
  it('claim as the token’s agent; a reclaim by another agent gets its own workspace; a narrow token cannot claim', async () => {
    const { repo, feature, task } = await dispatched('agents', 'review');
    const narrow = await agentToken('agents', 'td-narrow', ['refs/heads/scratch/*']);
    const denied = await claim('agents', task.id, {}, narrow.token);
    expect([denied.status, denied.json.code]).toEqual([403, 'AGENT_REF_FORBIDDEN']);

    const a = await agentToken('agents', 'td-agent-a');
    const b = await agentToken('agents', 'td-agent-b');
    const first = await claim('agents', task.id, { agent: 'ignored', ttlSeconds: 1 }, a.token);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.task.claimedBy).toBe('td-agent-a');
    expect(first.json.workspace).toMatchObject({ agentId: a.agentId, agent: 'td-agent-a', headSha: feature.sha });
    expect((await claim('agents', task.id, {}, b.token)).json.code).toBe('CLAIMED');
    await expiredLease();

    const second = await claim('agents', task.id, {}, b.token);
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    expect(second.json.task).toMatchObject({ claimedBy: 'td-agent-b', generation: 2 });
    expect(second.json.workspace.id).not.toBe(first.json.workspace.id);
    expect(second.json.workspace).toMatchObject({ agentId: b.agentId, headSha: feature.sha });
    expect(repo.refs.get(second.json.workspace.ref)).toBe(feature.sha);
    const stale = await complete('agents', task.id, { generation: 1 }, a.token);
    expect(stale.json.code).toBe('STALE_GENERATION');
    const notMine = await heartbeat('agents', task.id, { generation: 2 });
    expect(notMine.json.code).toBe('NOT_CLAIMANT');
  });
});

describe('complete', () => {
  it('requires the pushed resolution, moves the change to it, keeps review open, and completes once (VAL-DISPATCH-003/006, VAL-WORKFLOW-003)', async () => {
    const { repo, main, feature, task } = await dispatched('complete', 'review');
    const c = await claim('complete', task.id, { agent: 'claude-code-1' });
    const ws = c.json.workspace;

    const early = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([early.status, early.json.code]).toEqual([409, 'RESOLUTION_NOT_PUSHED']);
    expect(early.json.error).toContain(ws.ref);

    // A commit on the head that keeps only one side still conflicts with the base.
    const oneSided = await commit(repo, { ...BASE, 'src/app.ts': appWith({ 9: 'const line9 = "feature v2";' }) }, [feature.sha]);
    repo.refs.set(ws.ref, oneSided.sha);
    const conflicting = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([conflicting.status, conflicting.json.code]).toEqual([409, 'RESOLUTION_CONFLICTS']);
    expect(conflicting.json.conflicts).toEqual([{ path: 'src/app.ts', kind: 'content' }]);

    // Content resolved on top of the base alone does not contain the change's head.
    const detached = await commit(repo, { ...BASE, 'src/app.ts': RESOLVED }, [main.sha]);
    repo.refs.set(ws.ref, detached.sha);
    const notDescendant = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([notDescendant.status, notDescendant.json.code]).toEqual([409, 'RESOLUTION_NOT_DESCENDANT']);

    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(ws.ref, res.sha);
    const mismatch = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1, sha: oneSided.sha });
    expect([mismatch.status, mismatch.json.code]).toEqual([409, 'RESOLUTION_MISMATCH']);
    expect((await getChange('complete')).json).toMatchObject({ state: 'conflicted', headSha: feature.sha });

    const done = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1, sha: res.sha });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.task).toMatchObject({ status: 'completed', resolutionSha: res.sha, completedAt: expect.any(String), lease: null });
    expect(done.json.change).toMatchObject({ number: 1, state: 'open', mergePolicy: 'review', headSha: res.sha, conflicts: [] });
    expect(repo.refs.get(FEATURE)).toBe(res.sha);
    expect(repo.refs.get(MAIN)).toBe(main.sha);

    const again = await complete('complete', task.id, { agent: 'claude-code-1', generation: 1, sha: res.sha });
    expect([again.status, again.json.code]).toEqual([409, 'TASK_COMPLETED']);
    const other = await complete('complete', task.id, { agent: 'claude-code-2', generation: 1 });
    expect([other.status, other.json.code]).toEqual([409, 'TASK_COMPLETED']);
    const reclaim = await claim('complete', task.id, { agent: 'claude-code-2' });
    expect([reclaim.status, reclaim.json.code]).toEqual([409, 'TASK_COMPLETED']);
    expect(await workspaceCount('complete')).toBe(1);

    const view = await getChange('complete');
    expect(view.json).toMatchObject({ state: 'open', headSha: res.sha, mergeability: { status: 'fast-forward' } });
    expect((await getTask('complete', task.id)).json).toMatchObject({ status: 'completed', completedBy: 'claude-code-1' });

    // The resolution carries the completing agent's attribution.
    const attr = await call('GET', repoPath('complete', `/commits/${res.sha}/attribution`), tok.owner);
    expect(attr.status).toBe(200);
    expect(attr.json).toMatchObject({ agent: 'claude-code-1', session: `kvarm:task/${task.id}`, actor: OWNER });

    // Review: open until the explicit merge, which waits for the resolution's kvarm/guard run (recorded by the
    // head branch's push event).
    const unchecked = await call('POST', repoPath('complete', '/changes/1/merge'), tok.owner);
    expect([unchecked.status, unchecked.json.code]).toEqual([409, 'REQUIRED_CHECKS_PENDING']);
    expect(unchecked.json.error).toContain('kvarm/guard');
    const changeId = (await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = 1').bind(repoIds['complete']).first<{ id: string }>())!.id;
    expect(await recordGuard(env, repoIds['complete']!, changeId, res.sha)).toBe('recorded');
    const merged = await call('POST', repoPath('complete', '/changes/1/merge'), tok.owner);
    expect(merged.json.state).toBe('merged');
    expect(fileAt(repo, repo.refs.get(MAIN)!, 'src/app.ts')).toBe(RESOLVED);
    expect((await getTask('complete', task.id)).json.status).toBe('completed');
  });

  it('an auto change merges right after completion with the resolved content on base (VAL-DISPATCH-004)', async () => {
    const { repo, main, feature, task } = await dispatched('complete-auto', 'auto');
    const c = await claim('complete-auto', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    const done = await complete('complete-auto', task.id, { agent: 'claude-code-1', generation: 1, attribution: { session: 'sess-1', model: 'm1' } });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.change).toMatchObject({ state: 'merged', mergeCommit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(repo.refs.get(MAIN)).toBe(done.json.change.mergeCommit);
    expect(fileAt(repo, repo.refs.get(MAIN)!, 'src/app.ts')).toBe(RESOLVED);
    expect((await getTask('complete-auto', task.id)).json.status).toBe('completed');
    const attr = await call('GET', repoPath('complete-auto', `/commits/${done.json.change.mergeCommit}/attribution`), tok.owner);
    expect(attr.json).toMatchObject({ agent: 'claude-code-1', session: 'sess-1', model: 'm1' });
  });

  it('a draft change stays an unmerged draft after completion (VAL-DISPATCH-005)', async () => {
    const { repo, main, feature, task } = await dispatched('complete-draft', 'draft');
    const c = await claim('complete-draft', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    const done = await complete('complete-draft', task.id, { agent: 'claude-code-1', generation: 1 });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.change).toMatchObject({ state: 'open', mergePolicy: 'draft', headSha: res.sha, mergeCommit: null });
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect((await getChange('complete-draft')).json).toMatchObject({ state: 'open', mergePolicy: 'draft' });
  });

  it('a successful draft/review completion stays within d1 <= 6, do = 0, sub <= 5 and still notes the resolution (VAL-COST-027)', async () => {
    for (const [name, policy, agent] of [
      ['cost-draft', 'draft', false],
      ['cost-review-agent', 'review', true],
    ] as const) {
      const { repo, main, feature, task } = await dispatched(name, policy);
      const token = agent ? (await agentToken(name, `td-${name}`, ['refs/heads/agents/*', FEATURE])).token : tok.owner;
      const c = await claim(name, task.id, agent ? {} : { agent: 'claude-code-1' }, token);
      expect(c.status, JSON.stringify(c.json)).toBe(200);
      const res = await resolution(repo, feature.sha, main.sha);
      repo.refs.set(c.json.workspace.ref, res.sha);
      const pushedAt = async () => (await env.DB.prepare('SELECT pushed_at AS p FROM repos WHERE id = ?').bind(repoIds[name]).first<{ p: number | null }>())!.p ?? 0;
      // A pushed_at ahead of the clock makes each freshness write exactly +1.
      const before = Date.now() + 1e9;
      await env.DB.prepare('UPDATE repos SET pushed_at = ? WHERE id = ?').bind(before, repoIds[name]).run();
      const done = await complete(name, task.id, agent ? { generation: 1 } : { agent: 'claude-code-1', generation: 1 }, token);
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json.change).toMatchObject({ state: 'open', mergePolicy: policy, headSha: res.sha });
      expect(repo.refs.get(FEATURE)).toBe(res.sha);
      expect(done.cost, name).toMatchObject({ do: 0 });
      expect(done.cost.d1, name).toBeLessThanOrEqual(6);
      expect(done.cost.sub, name).toBeLessThanOrEqual(5);
      // Both the head-branch and the notes updates still advance the view generation.
      expect(await pushedAt(), name).toBe(before + 2);
      // The attribution note and its ledger event are both still written.
      const attr = await call('GET', repoPath(name, `/commits/${res.sha}/attribution`), tok.owner);
      expect(attr.status, name).toBe(200);
      const ledger = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'attribution.set' AND json_extract(payload, '$.commit') = ?`)
        .bind(res.sha)
        .first<{ n: number }>();
      expect(ledger!.n, name).toBe(1);
      expect((await getTask(name, task.id)).json).toMatchObject({ status: 'completed', resolutionSha: res.sha });
    }
  });

  it('a task whose change moved on is not completed against the old head', async () => {
    const { repo, main, feature, task } = await dispatched('complete-moved', 'review');
    const c = await claim('complete-moved', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    // Someone pushes to the change's branch directly before the push event lands.
    const other = await commit(repo, { ...BASE, 'src/app.ts': appWith({ 9: 'const line9 = "feature v3";' }) }, [feature.sha]);
    repo.refs.set(FEATURE, other.sha);
    const moved = await complete('complete-moved', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([moved.status, moved.json.code]).toEqual([409, 'HEAD_MOVED']);
    expect((await getTask('complete-moved', task.id)).json.status).toBe('claimed');
  });
});

describe('completion authority over the head branch', () => {
  it('an agent token outside the head branch grant cannot advance it through completion', async () => {
    const { repo, main, feature, task } = await dispatched('complete-scope', 'auto');
    const agent = await agentToken('complete-scope', 'td-scoped');
    const c = await claim('complete-scope', task.id, {}, agent.token);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    const denied = await complete('complete-scope', task.id, { generation: 1 }, agent.token);
    expect([denied.status, denied.json.code]).toEqual([403, 'HEAD_REF_FORBIDDEN']);
    expect(repo.refs.get(FEATURE)).toBe(feature.sha);
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect((await getTask('complete-scope', task.id)).json).toMatchObject({ status: 'claimed', generation: 1 });
    expect((await getChange('complete-scope')).json).toMatchObject({ state: 'conflicted', headSha: feature.sha });
  });

  it('a protected head branch is not fast-forwarded by completion', async () => {
    const { repo, main, feature, task } = await dispatched('complete-protected', 'review');
    const c = await claim('complete-protected', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    expect((await call('POST', repoPath('complete-protected', '/branch-rules'), tok.owner, { pattern: 'feature' })).status).toBe(201);
    const denied = await complete('complete-protected', task.id, { agent: 'claude-code-1', generation: 1 });
    expect([denied.status, denied.json.code]).toEqual([409, 'HEAD_REF_PROTECTED']);
    expect(repo.refs.get(FEATURE)).toBe(feature.sha);
    expect((await getTask('complete-protected', task.id)).json.status).toBe('claimed');
  });
});

describe('completion confirms the head branch', () => {
  it('a failed head-branch update leaves the task claimed and retryable; the retry lands and an auto change merges', async () => {
    const { repo, main, feature, task } = await dispatched('complete-retry', 'auto');
    const c = await claim('complete-retry', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    repo.hook = async (call) => {
      if (call.startsWith(`receivePack:${FEATURE}:`)) repo.receivePackStatus = 503;
    };
    const failed = await complete('complete-retry', task.id, { agent: 'claude-code-1', generation: 1 });
    repo.hook = null;
    repo.receivePackStatus = null;
    expect([failed.status, failed.json.code]).toEqual([502, 'HEAD_UPDATE_FAILED']);
    expect(repo.refs.get(FEATURE)).toBe(feature.sha);
    expect((await getTask('complete-retry', task.id)).json).toMatchObject({ status: 'claimed', generation: 1 });
    expect((await getChange('complete-retry')).json).toMatchObject({ state: 'conflicted', headSha: feature.sha });

    const done = await complete('complete-retry', task.id, { agent: 'claude-code-1', generation: 1 });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.headBranch).toMatchObject({ ref: FEATURE, updated: true });
    expect(done.json.change).toMatchObject({ state: 'merged' });
    expect(fileAt(repo, repo.refs.get(MAIN)!, 'src/app.ts')).toBe(RESOLVED);
  });

  it('a retry after the head branch already moved to the resolution finalizes instead of answering HEAD_MOVED', async () => {
    const { repo, main, feature, task } = await dispatched('complete-landed', 'review');
    const c = await claim('complete-landed', task.id, { agent: 'claude-code-1' });
    const res = await resolution(repo, feature.sha, main.sha);
    repo.refs.set(c.json.workspace.ref, res.sha);
    // A previous attempt advanced the branch but did not record the completion.
    repo.refs.set(FEATURE, res.sha);
    const done = await complete('complete-landed', task.id, { agent: 'claude-code-1', generation: 1 });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.change).toMatchObject({ state: 'open', headSha: res.sha });
    expect((await getTask('complete-landed', task.id)).json.status).toBe('completed');
  });
});

describe('claims are fenced across the workspace ref creation', () => {
  /** Pauses the n-th workspace ref creation until released. */
  function pauseCreations(repo: FakeRepo, count: number) {
    const gates = Array.from({ length: count }, () => {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const at = new Promise<void>((r) => (reached = r));
      return { gate, at, release, reached };
    });
    let n = 0;
    repo.hook = async (call) => {
      if (!call.startsWith('receivePack:refs/heads/agents/')) return;
      const g = gates[n++];
      if (!g) return;
      g.reached();
      await g.gate;
    };
    return gates;
  }

  const agentRefs = (repo: FakeRepo) => [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/agents/'));

  it('a holder whose lease was taken over during its ref creation persists nothing', async () => {
    const { repo, task } = await dispatched('claim-takeover', 'review');
    const [slow] = pauseCreations(repo, 1);
    const first = claim('claim-takeover', task.id, { agent: 'claude-code-1', ttlSeconds: 1 });
    await slow!.at;
    await expiredLease();
    const second = await claim('claim-takeover', task.id, { agent: 'claude-code-2', ttlSeconds: 120 });
    expect(second.status, JSON.stringify(second.json)).toBe(200);
    slow!.release();
    const lost = await first;
    repo.hook = null;
    expect(lost.status).toBe(409);
    expect((await getTask('claim-takeover', task.id)).json).toMatchObject({ status: 'claimed', claimedBy: 'claude-code-2', generation: 2, workspace: second.json.workspace.id });
    expect(await workspaceCount('claim-takeover')).toBe(1);
    expect(agentRefs(repo)).toEqual([second.json.workspace.ref]);
  });

  it('a superseded holder finishing first cannot record its claim over the current generation', async () => {
    const { repo, task } = await dispatched('claim-order', 'review');
    const [a, b] = pauseCreations(repo, 2);
    const first = claim('claim-order', task.id, { agent: 'claude-code-1', ttlSeconds: 1 });
    await a!.at;
    await expiredLease();
    const second = claim('claim-order', task.id, { agent: 'claude-code-2', ttlSeconds: 120 });
    await b!.at;
    a!.release();
    const lost = await first;
    expect(lost.status).toBe(409);
    expect((await getTask('claim-order', task.id)).json.claimedBy).not.toBe('claude-code-1');
    b!.release();
    const won = await second;
    repo.hook = null;
    expect(won.status, JSON.stringify(won.json)).toBe(200);
    expect((await getTask('claim-order', task.id)).json).toMatchObject({ status: 'claimed', claimedBy: 'claude-code-2', generation: 2 });
    expect(await workspaceCount('claim-order')).toBe(1);
  });
});
