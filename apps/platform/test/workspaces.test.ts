/**
 * Agent workspaces (services/workspaces.ts) through the Worker's routes, the
 * git gate and the push queue, over the in-memory Artifacts fake: the
 * workspace ref is created and deleted by the fake receive-pack exactly like
 * the Artifacts remote, and pushes go through the real git gate.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_PACK, ZERO_OID, pktLine, readPktLines } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { getRepoById } from '../src/db/repos';
import { deleteRepo } from '../src/repos/service';
import { createChange, onHeadPushed, type ChangeContext } from '../src/services/changes';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'ws-owner';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return repo;
}

interface Reply {
  status: number;
  json: Record<string, any>;
  cost: CostCounters;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, cost: cost! };
}

const wsPath = (repo: string, rest = '') => `/api/v1/repos/${OWNER}/${repo}/workspaces${rest}`;
const createWs = (repo: string, body: unknown, token = tok.owner) => call('POST', wsPath(repo), token, body);
const getWs = (repo: string, id: string, token: string | undefined = tok.owner) => call('GET', wsPath(repo, `/${id}`), token);
const listWs = (repo: string, q = '', token: string | undefined = tok.owner) => call('GET', wsPath(repo, q), token);
const openChange = (repo: string, id: string, body: unknown, token = tok.owner) =>
  call('POST', wsPath(repo, `/${id}/change-set`), token, body);
const abandon = (repo: string, id: string, token = tok.owner) => call('POST', wsPath(repo, `/${id}/abandon`), token);
const getChange = (repo: string, n: number) => call('GET', `/api/v1/repos/${OWNER}/${repo}/changes/${n}`, tok.owner);

/** One git-receive-pack request through the git gate; returns HTTP status and report-status lines. */
async function gitPush(repo: string, token: string, cmds: string[]): Promise<{ status: number; report: string[] }> {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0report-status agent=git/2.47\n` : `${c}\n`));
  const needsPack = cmds.some((c) => c.split(' ')[1] !== ZERO_OID);
  const body = new Blob([...parts, new TextEncoder().encode('0000'), ...(needsPack ? [EMPTY_PACK] : [])]);
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: new Uint8Array(await body.arrayBuffer()),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const buf = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  if (res.status !== 200) return { status: res.status, report: [] };
  return { status: res.status, report: readPktLines(buf).filter((p) => !p.flush).map((p) => new TextDecoder().decode(p.data).trim()) };
}

function pushEvent(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('forge-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

async function based(repo: FakeRepo) {
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set('refs/heads/main', main.sha);
  return main;
}

async function agentToken(repo: string, name: string, refs = ['refs/heads/agents/*']): Promise<{ token: string; agentId: string }> {
  const agent = await call('POST', '/api/v1/agents', tok.owner, { name });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
    repo: `${OWNER}/${repo}`,
    role: 'write',
    refs,
  });
  expect(minted.status).toBe(201);
  return { token: minted.json.token as string, agentId: agent.json.agent.id as string };
}

async function workspacePush(repo: string, cmds: string[]): Promise<{ status: number; report: string[] }> {
  const agent = await agentToken(repo, `push-${crypto.randomUUID()}`);
  return gitPush(repo, agent.token, cmds);
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  const readerId = await seedUser('ws-reader');
  tok.reader = (await mintPAT(env, readerId, 'reader', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('ws-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('create and read', () => {
  it('creates the namespaced ref server-side at the base head and returns id, ref and pushUrl', async () => {
    const repo = await seedRepo('create');
    const main = await based(repo);
    const r = await createWs('create', { task: 'Fix login', agent: 'claude-code-1' });
    expect(r.status).toBe(201);
    const { id, ref, pushUrl } = r.json as { id: string; ref: string; pushUrl: string };
    expect(id).toMatch(/^[0-9a-z]+$/);
    expect(ref).toBe(`refs/heads/agents/${id}/fix-login`);
    expect(pushUrl).toBe(`${ORIGIN}/${OWNER}/create.git`);
    expect(r.json).toMatchObject({ task: 'Fix login', agent: 'claude-code-1', status: 'active', base: 'main', baseSha: main.sha, headSha: main.sha });
    // The ref exists before any push, at the base head, created with a zero old OID.
    expect(repo.refs.get(ref)).toBe(main.sha);
    expect(repo.calls).toContain(`receivePack:${ref}:${ZERO_OID}->${main.sha}`);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);

    const got = await getWs('create', id);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ id, ref, pushUrl, task: 'Fix login', agent: 'claude-code-1', status: 'active', headSha: main.sha, changeSet: null });
  });

  it('validates input and refuses a missing base before writing anything', async () => {
    const repo = await seedRepo('refuse');
    await based(repo);
    const cases: Array<[unknown, number, string]> = [
      [{ agent: 'a' }, 422, 'INVALID_TASK'],
      [{ task: '   ', agent: 'a' }, 422, 'INVALID_TASK'],
      [{ task: 'x', agent: 7 }, 422, 'INVALID_AGENT'],
      [{ task: 'x', agent: 'a', base: 'bad..name' }, 422, 'INVALID_REF'],
      [{ task: 'x', agent: 'a', base: 'nope' }, 422, 'REF_NOT_FOUND'],
      [[1], 400, 'INVALID_BODY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await createWs('refuse', body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(repo.count('receivePack:')).toBe(0);
    expect((await listWs('refuse', '?status=all')).json.workspaces).toEqual([]);
  });

  it('creates from an explicit base and slugs any task text', async () => {
    const repo = await seedRepo('base');
    const main = await based(repo);
    const dev = await commit(repo, { 'README.md': 'dev\n' }, [main.sha]);
    repo.refs.set('refs/heads/dev', dev.sha);
    const r = await createWs('base', { task: '  Ünïcode / ~weird: task?? ', agent: 'x', base: 'refs/heads/dev' });
    expect(r.status).toBe(201);
    expect(r.json.ref).toMatch(new RegExp(`^refs/heads/agents/${r.json.id}/[a-z0-9-]+$`));
    expect(r.json).toMatchObject({ base: 'dev', baseSha: dev.sha });
    expect(repo.refs.get(r.json.ref)).toBe(dev.sha);
  });

  it('needs write to create and read to view; private repos stay concealed', async () => {
    const repo = await seedRepo('auth');
    await based(repo);
    // Private repos conceal themselves from anonymous callers as well.
    expect((await createWs('auth', { task: 't', agent: 'a' }, '')).status).toBe(404);
    expect((await createWs('auth', { task: 't', agent: 'a' }, tok.outsider)).status).toBe(404);
    await env.DB.prepare(
      'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(repoIds.auth, userIds['ws-reader'], 'read', userIds[OWNER], Date.now(), Date.now())
      .run();
    expect((await createWs('auth', { task: 't', agent: 'a' }, tok.reader)).status).toBe(403);
    const made = await createWs('auth', { task: 't', agent: 'a' });
    expect((await getWs('auth', made.json.id, tok.reader)).status).toBe(200);
    expect((await listWs('auth', '', tok.reader)).json.workspaces).toHaveLength(1);
    expect((await getWs('auth', made.json.id, tok.outsider)).status).toBe(404);
    expect((await getWs('auth', 'nope')).status).toBe(404);
    // A workspace id from another repo is not found here.
    const other = await seedRepo('auth-other');
    await based(other);
    expect((await getWs('auth-other', made.json.id)).status).toBe(404);
  });
});

describe('pushes and change sets', () => {
  it('a push moves the workspace head; base and sibling workspaces are untouched', async () => {
    const repo = await seedRepo('push');
    const main = await based(repo);
    const a = (await createWs('push', { task: 'a', agent: 'one' })).json;
    const b = (await createWs('push', { task: 'b', agent: 'two' })).json;
    const work = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n' }, [main.sha]);
    const pushed = await workspacePush('push', [`${main.sha} ${work.sha} ${a.ref}`]);
    expect(pushed.report).toEqual(['unpack ok', `ok ${a.ref}`]);
    expect(repo.refs.get(a.ref)).toBe(work.sha);
    expect(repo.refs.get(b.ref)).toBe(main.sha);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await getWs('push', a.id)).json.headSha).toBe(work.sha);
    expect((await getWs('push', b.id)).json.headSha).toBe(main.sha);
  });

  it('opens a change set with the default branch as base and review policy, then follows pushes', async () => {
    const repo = await seedRepo('change');
    const main = await based(repo);
    const ws = (await createWs('change', { task: 'fix login', agent: 'claude' })).json;
    const first = await commit(repo, { 'README.md': 'readme\n', 'login.ts': 'v1\n' }, [main.sha]);
    expect((await workspacePush('change', [`${main.sha} ${first.sha} ${ws.ref}`])).report).toContain(`ok ${ws.ref}`);
    await deliver(pushEvent('change', ws.ref, main.sha, first.sha, Date.now()));

    const opened = await openChange('change', ws.id, { title: 'fix login' });
    expect(opened.status).toBe(201);
    const branch = ws.ref.slice('refs/heads/'.length);
    expect(opened.json).toMatchObject({ number: 1, state: 'open', mergePolicy: 'review', base: 'main', head: branch, headSha: first.sha });
    expect((await getWs('change', ws.id)).json).toMatchObject({ changeSet: 1, status: 'active' });
    // The change view links back to its workspace, so the create reply and a later read agree exactly.
    expect(opened.json.workspace).toBe(ws.id);
    const read = await getChange('change', 1);
    expect(Object.keys(read.json)).toEqual(Object.keys(opened.json));
    expect({ ...read.json, mergeability: null }).toEqual({ ...opened.json, mergeability: null });
    const again = await openChange('change', ws.id, { title: 'twice' });
    expect([again.status, again.json.code]).toEqual([409, 'CHANGE_SET_EXISTS']);

    const second = await commit(repo, { 'README.md': 'readme\n', 'login.ts': 'v2\n' }, [first.sha]);
    expect((await workspacePush('change', [`${first.sha} ${second.sha} ${ws.ref}`])).report).toContain(`ok ${ws.ref}`);
    await deliver(pushEvent('change', ws.ref, first.sha, second.sha, Date.now() + 1000));
    expect((await getChange('change', 1)).json).toMatchObject({ number: 1, headSha: second.sha, state: 'open' });
    const changes = await call('GET', `/api/v1/repos/${OWNER}/change/changes?state=all`, tok.owner);
    expect(changes.json.changes).toHaveLength(1);
  });

  it('keeps an explicit merge policy verbatim', async () => {
    const repo = await seedRepo('policy');
    const main = await based(repo);
    const results: Record<string, unknown> = {};
    for (const policy of ['draft', 'auto', 'review'] as const) {
      const ws = (await createWs('policy', { task: policy, agent: 'x' })).json;
      const c = await commit(repo, { 'README.md': 'readme\n', [`${policy}.txt`]: policy }, [repo.refs.get('refs/heads/main') ?? main.sha]);
      expect((await workspacePush('policy', [`${ws.baseSha} ${c.sha} ${ws.ref}`])).report).toContain(`ok ${ws.ref}`);
      const r = await openChange('policy', ws.id, { title: policy, mergePolicy: policy });
      expect(r.status).toBe(201);
      results[policy] = (await getChange('policy', r.json.number)).json.mergePolicy;
      if (policy === 'auto') {
        // Fast-forwardable with no required checks: auto merges at once, and the workspace follows.
        expect((await getWs('policy', ws.id)).json.status).toBe('merged');
      }
    }
    expect(results).toEqual({ draft: 'draft', auto: 'auto', review: 'review' });
    const bad = await openChange('policy', (await createWs('policy', { task: 'z', agent: 'x' })).json.id, { title: 'z', mergePolicy: 'yolo' });
    expect([bad.status, bad.json.code]).toEqual([422, 'INVALID_MERGE_POLICY']);
  });

  it('becomes merged when its change set merges, and the ref is kept', async () => {
    const repo = await seedRepo('merged');
    const main = await based(repo);
    const ws = (await createWs('merged', { task: 'm', agent: 'x' })).json;
    const c = await commit(repo, { 'README.md': 'readme\n', 'm.txt': 'm\n' }, [main.sha]);
    await workspacePush('merged', [`${main.sha} ${c.sha} ${ws.ref}`]);
    const opened = await openChange('merged', ws.id, { title: 'm' });
    const merged = await call('POST', `/api/v1/repos/${OWNER}/merged/changes/${opened.json.number}/merge`, tok.owner);
    expect(merged.status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(c.sha);
    const got = (await getWs('merged', ws.id)).json;
    expect(got).toMatchObject({ status: 'merged', changeSet: opened.json.number, headSha: c.sha });
    expect(got.mergedAt).toEqual(expect.any(String));
    expect(repo.refs.get(ws.ref)).toBe(c.sha);
    const ab = await abandon('merged', ws.id);
    expect([ab.status, ab.json.code]).toEqual([409, 'WORKSPACE_MERGED']);
    expect(repo.refs.get(ws.ref)).toBe(c.sha);
  });
});

describe('list and abandon', () => {
  it('abandon deletes the ref and marks the workspace abandoned; repeating it is harmless', async () => {
    const repo = await seedRepo('abandon');
    const main = await based(repo);
    const ws = (await createWs('abandon', { task: 'gone', agent: 'x' })).json;
    const c = await commit(repo, { 'README.md': 'readme\n', 'g.txt': 'g\n' }, [main.sha]);
    await workspacePush('abandon', [`${main.sha} ${c.sha} ${ws.ref}`]);
    const opened = await openChange('abandon', ws.id, { title: 'gone' });

    const r = await abandon('abandon', ws.id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ws.id, status: 'abandoned', headSha: c.sha });
    expect(repo.refs.has(ws.ref)).toBe(false);
    expect(repo.calls).toContain(`receivePack:${ws.ref}:${c.sha}->${ZERO_OID}`);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await getWs('abandon', ws.id)).json).toMatchObject({ status: 'abandoned', headSha: c.sha });
    expect((await getChange('abandon', opened.json.number)).json.state).toBe('closed');
    const again = await abandon('abandon', ws.id);
    expect([again.status, again.json.status]).toEqual([200, 'abandoned']);
    const late = await openChange('abandon', ws.id, { title: 'late' });
    expect([late.status, late.json.code]).toEqual([409, 'WORKSPACE_NOT_ACTIVE']);
  });

  it('a failed ref write leaves no workspace on create and is retried by a repeated abandon', async () => {
    const repo = await seedRepo('faults');
    const main = await based(repo);
    repo.receivePackStatus = 503;
    const refused = await createWs('faults', { task: 'x', agent: 'a' });
    expect(refused.status).toBe(502);
    expect(refused.json.code).toBe('REF_CREATE_FAILED');
    expect((await listWs('faults')).json.workspaces).toEqual([]);

    repo.receivePackStatus = null;
    const ws = (await createWs('faults', { task: 'y', agent: 'a' })).json;
    repo.receivePackStatus = 503;
    const stuck = await abandon('faults', ws.id);
    expect([stuck.status, stuck.json.code]).toEqual([503, 'REF_DELETE_FAILED']);
    expect((await getWs('faults', ws.id)).json.status).toBe('abandoned');
    expect(repo.refs.get(ws.ref)).toBe(main.sha);

    repo.receivePackStatus = null;
    const retried = await abandon('faults', ws.id);
    expect([retried.status, retried.json.status]).toEqual([200, 'abandoned']);
    expect(repo.refs.has(ws.ref)).toBe(false);
  });

  it('lists newest first with a status filter and a cursor, in one query plus the authority lookup', async () => {
    const repo = await seedRepo('list');
    await based(repo);
    const ids: string[] = [];
    for (const t of ['one', 'two', 'three', 'four']) ids.push((await createWs('list', { task: t, agent: `agent-${t}` })).json.id);
    expect((await abandon('list', ids[1]!)).status).toBe(200);
    await env.DB.prepare("UPDATE workspaces SET status = 'merged' WHERE id = ?").bind(ids[2]).run();

    const all = await listWs('list');
    expect(all.status).toBe(200);
    expect(all.json.workspaces.map((w: { task: string }) => w.task)).toEqual(['four', 'three', 'two', 'one']);
    for (const w of all.json.workspaces) {
      expect(Object.keys(w)).toEqual(expect.arrayContaining(['id', 'task', 'agent', 'status', 'ref', 'headSha', 'createdAt']));
    }
    expect(all.cost.d1).toBeLessThanOrEqual(2);
    expect(all.cost.do).toBe(0);
    expect(all.cost.sub ?? 0).toBe(0);

    const active = await listWs('list', '?status=active');
    expect(active.json.workspaces.map((w: { id: string }) => w.id)).toEqual([ids[3], ids[0]]);
    expect((await listWs('list', '?status=abandoned')).json.workspaces.map((w: { id: string }) => w.id)).toEqual([ids[1]]);
    expect((await listWs('list', '?status=merged')).json.workspaces.map((w: { id: string }) => w.id)).toEqual([ids[2]]);

    const page = await listWs('list', '?limit=3');
    expect(page.json.workspaces).toHaveLength(3);
    expect(page.json.nextCursor).toEqual(expect.any(String));
    const rest = await listWs('list', `?limit=3&cursor=${encodeURIComponent(page.json.nextCursor)}`);
    expect(rest.json.workspaces.map((w: { id: string }) => w.id)).toEqual([ids[0]]);
    expect(rest.json.nextCursor).toBeNull();
    expect((await listWs('list', '?status=bogus')).json.code).toBe('INVALID_STATUS');
    expect((await listWs('list', '?limit=0')).json.code).toBe('INVALID_LIMIT');
    expect((await listWs('list', '?cursor=zzz')).json.code).toBe('INVALID_CURSOR');
  });
});

describe('agent tokens are bound to real workspaces', () => {
  it('an agent creates its own workspace and pushes to it', async () => {
    const repo = await seedRepo('agent-own');
    const main = await based(repo);
    const a = await agentToken('agent-own', 'ws-agent-a');
    const ws = await createWs('agent-own', { task: 'own' }, a.token);
    expect(ws.status).toBe(201);
    expect(ws.json).toMatchObject({ agent: 'ws-agent-a', agentId: a.agentId, status: 'active' });
    const c = await commit(repo, { 'README.md': 'readme\n', 'o.txt': 'o\n' }, [main.sha]);
    const pushed = await gitPush('agent-own', a.token, [`${main.sha} ${c.sha} ${ws.json.ref}`]);
    expect(pushed.report).toEqual(['unpack ok', `ok ${ws.json.ref}`]);
    // More refs inside its own workspace namespace are allowed too.
    const extra = `refs/heads/agents/${ws.json.id}/extra`;
    expect((await gitPush('agent-own', a.token, [`${ZERO_OID} ${c.sha} ${extra}`])).report).toEqual(['unpack ok', `ok ${extra}`]);
    expect((await gitPush('agent-own', a.token, [`${c.sha} ${ZERO_OID} ${extra}`])).report).toEqual(['unpack ok', `ok ${extra}`]);
  });

  it('denies pushes to another agent workspace, unknown ids, inactive workspaces and deleting the workspace ref', async () => {
    const repo = await seedRepo('agent-bind');
    const main = await based(repo);
    const a = await agentToken('agent-bind', 'ws-bind-a');
    const b = await agentToken('agent-bind', 'ws-bind-b');
    const wsA = (await createWs('agent-bind', { task: 'a' }, a.token)).json;
    const wsB = (await createWs('agent-bind', { task: 'b' }, b.token)).json;
    const gone = (await createWs('agent-bind', { task: 'gone' }, a.token)).json;
    expect((await abandon('agent-bind', gone.id, a.token)).status).toBe(200);
    const c = await commit(repo, { 'README.md': 'readme\n', 'x.txt': 'x\n' }, [main.sha]);

    const denied: Array<[string, string]> = [
      [`${main.sha} ${c.sha} ${wsB.ref}`, wsB.ref],
      [`${ZERO_OID} ${c.sha} refs/heads/agents/nosuchworkspace/x`, 'refs/heads/agents/nosuchworkspace/x'],
      [`${ZERO_OID} ${c.sha} ${gone.ref}`, gone.ref],
      [`${main.sha} ${ZERO_OID} ${wsA.ref}`, wsA.ref],
    ];
    for (const [cmd, ref] of denied) {
      const r = await gitPush('agent-bind', a.token, [cmd]);
      expect(r.report[0], cmd).toBe('unpack ok');
      expect(r.report[1], cmd).toMatch(new RegExp(`^ng ${ref} `));
    }
    expect(repo.refs.get(wsB.ref)).toBe(main.sha);
    expect(repo.refs.get(wsA.ref)).toBe(main.sha);
    expect(repo.refs.has(gone.ref)).toBe(false);

    // Another agent cannot abandon or open a change set for a workspace it does not own.
    expect((await abandon('agent-bind', wsB.id, a.token)).json.code).toBe('WORKSPACE_NOT_OWNED');
    expect((await openChange('agent-bind', wsB.id, { title: 'x' }, a.token)).json.code).toBe('WORKSPACE_NOT_OWNED');
    expect(repo.refs.get(wsB.ref)).toBe(main.sha);

    // A person's workspace is usable by an agent whose token grants its namespace.
    const human = (await createWs('agent-bind', { task: 'h', agent: 'ws-bind-a' })).json;
    expect((await gitPush('agent-bind', a.token, [`${main.sha} ${c.sha} ${human.ref}`])).report).toEqual(['unpack ok', `ok ${human.ref}`]);
  });

  it('an agent may create a workspace only when its grant covers the namespace', async () => {
    const repo = await seedRepo('agent-grant');
    await based(repo);
    const narrow = await agentToken('agent-grant', 'ws-narrow', ['refs/heads/scratch/*']);
    const r = await createWs('agent-grant', { task: 'x' }, narrow.token);
    expect([r.status, r.json.code]).toEqual([403, 'AGENT_REF_FORBIDDEN']);
    expect(repo.count('receivePack:')).toBe(0);
  });
});

describe('ownership intersects the agent token ref ceiling', () => {
  it('an owning agent token limited to one workspace cannot abandon, open a change set on or declare intent for its sibling', async () => {
    const repo = await seedRepo('agent-ceiling');
    const main = await based(repo);
    const a = await agentToken('agent-ceiling', 'ws-ceiling-a');
    const wsA = (await createWs('agent-ceiling', { task: 'a' }, a.token)).json;
    const wsB = (await createWs('agent-ceiling', { task: 'b' }, a.token)).json;
    const minted = await call('POST', `/api/v1/agents/${a.agentId}/tokens`, tok.owner, {
      repo: `${OWNER}/agent-ceiling`,
      role: 'write',
      refs: [`refs/heads/agents/${wsB.id}/*`],
    });
    expect(minted.status).toBe(201);
    const narrow = minted.json.token as string;

    // git already refuses the sibling ref for this token; the REST mutations must agree.
    const del = await gitPush('agent-ceiling', narrow, [`${main.sha} ${ZERO_OID} ${wsA.ref}`]);
    expect(del.report[1]).toMatch(new RegExp(`^ng ${wsA.ref} `));
    const ab = await abandon('agent-ceiling', wsA.id, narrow);
    expect([ab.status, ab.json.code]).toEqual([403, 'WORKSPACE_NOT_OWNED']);
    const cs = await openChange('agent-ceiling', wsA.id, { title: 'x' }, narrow);
    expect([cs.status, cs.json.code]).toEqual([403, 'WORKSPACE_NOT_OWNED']);
    const intent = await call('POST', wsPath('agent-ceiling', `/${wsA.id}/intent`), narrow, { paths: ['x.txt'] });
    expect([intent.status, intent.json.code]).toEqual([403, 'WORKSPACE_NOT_OWNED']);
    expect(repo.refs.get(wsA.ref)).toBe(main.sha);
    expect((await getWs('agent-ceiling', wsA.id)).json).toMatchObject({ status: 'active', changeSet: null, declaredPaths: [] });

    // The workspace the token does grant stays fully usable.
    const own = await call('POST', wsPath('agent-ceiling', `/${wsB.id}/intent`), narrow, { paths: ['b.txt'] });
    expect(own.status).toBe(200);
    expect((await abandon('agent-ceiling', wsB.id, narrow)).status).toBe(200);
    expect(repo.refs.has(wsB.ref)).toBe(false);
  });
});

describe('workspace admission comes before automatic publication', () => {
  /** Pauses the first fake-Artifacts call `pick` selects until `release()`; `reached` settles when it is paused. */
  function pauseAt(repo: FakeRepo, pick: (call: string) => boolean) {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const at = new Promise<void>((r) => (reached = r));
    let armed = true;
    repo.hook = async (call) => {
      if (armed && pick(call)) {
        armed = false;
        reached();
        await gate;
      }
    };
    return { reached: at, release };
  }

  async function workspaceWithWork(name: string) {
    const repo = await seedRepo(name);
    const main = await based(repo);
    const ws = (await createWs(name, { task: 'race', agent: 'x' })).json;
    const c = await commit(repo, { 'README.md': 'readme\n', 'race.txt': 'r\n' }, [main.sha]);
    expect((await workspacePush(name, [`${main.sha} ${c.sha} ${ws.ref}`])).report).toContain(`ok ${ws.ref}`);
    return { repo, main, ws, head: c.sha };
  }

  it('a concurrent review change set loses to an auto change set that is preparing its merge', async () => {
    const { repo, ws, head } = await workspaceWithWork('admit-review');
    const pause = pauseAt(repo, (c) => c.startsWith('receivePack:refs/heads/main:'));
    const auto = openChange('admit-review', ws.id, { title: 'auto', mergePolicy: 'auto' });
    await pause.reached;
    const review = await openChange('admit-review', ws.id, { title: 'review' });
    pause.release();
    const won = await auto;
    repo.hook = null;
    expect([review.status, review.json.code]).toEqual([409, 'CHANGE_SET_EXISTS']);
    expect(won.status).toBe(201);
    expect(repo.refs.get('refs/heads/main')).toBe(head);
    expect((await getWs('admit-review', ws.id)).json).toMatchObject({ status: 'merged', changeSet: won.json.number });
    const all = await call('GET', `/api/v1/repos/${OWNER}/admit-review/changes?state=all`, tok.owner);
    expect(all.json.changes.map((c: any) => [c.number, c.state])).toEqual([[won.json.number, 'merged']]);
  });

  it('an abandon while the auto change prepares its merge closes it and nothing is published', async () => {
    const { repo, main, ws } = await workspaceWithWork('admit-abandon');
    let lsRefs = 0;
    // The second ls-refs of the request is the merge's fresh read of the base, before it prepares and sends.
    const pause = pauseAt(repo, (c) => c === 'lsRefs' && ++lsRefs === 2);
    const auto = openChange('admit-abandon', ws.id, { title: 'auto', mergePolicy: 'auto' });
    await pause.reached;
    const ab = await abandon('admit-abandon', ws.id);
    pause.release();
    const res = await auto;
    repo.hook = null;
    expect(ab.status).toBe(200);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect(repo.count('receivePack:refs/heads/main:')).toBe(0);
    expect((await getWs('admit-abandon', ws.id)).json).toMatchObject({ status: 'abandoned' });
    const all = await call('GET', `/api/v1/repos/${OWNER}/admit-abandon/changes?state=all`, tok.owner);
    expect(all.json.changes.map((c: any) => c.state)).toEqual(['closed']);
    expect(res.status === 201 || res.status === 409).toBe(true);
  });

  /** A workspace whose pushed work conflicts with main (both edit README.md). */
  async function workspaceWithConflict(name: string) {
    const { repo, main, ws, head } = await workspaceWithWork(name);
    const moved = await commit(repo, { 'README.md': 'readme on main\n' }, [main.sha]);
    repo.refs.set('refs/heads/main', moved.sha);
    const c = await commit(repo, { 'README.md': 'readme in the workspace\n', 'race.txt': 'r\n' }, [head]);
    expect((await workspacePush(name, [`${head} ${c.sha} ${ws.ref}`])).report).toContain(`ok ${ws.ref}`);
    return { repo, ws };
  }

  const liveTasks = async (name: string) =>
    (
      await env.DB.prepare(`SELECT t.status, c.number FROM agent_tasks t JOIN change_sets c ON c.id = t.change_set_id WHERE t.repo_id = ? AND t.status IN ('open', 'claimed')`)
        .bind(repoIds[name])
        .all<{ status: string; number: number }>()
    ).results ?? [];

  it('a conflicted change set that loses the admission is closed and its task retired', async () => {
    const { repo, ws } = await workspaceWithConflict('admit-conflicted');
    let lsRefs = 0;
    // The first request pauses before it writes its change; the second wins the link meanwhile.
    const pause = pauseAt(repo, (c) => c === 'lsRefs' && ++lsRefs === 1);
    const late = openChange('admit-conflicted', ws.id, { title: 'late' });
    await pause.reached;
    const won = await openChange('admit-conflicted', ws.id, { title: 'won' });
    pause.release();
    const lost = await late;
    repo.hook = null;
    expect([won.status, won.json.state]).toEqual([201, 'conflicted']);
    expect([lost.status, lost.json.code]).toEqual([409, 'CHANGE_SET_EXISTS']);
    const all = await call('GET', `/api/v1/repos/${OWNER}/admit-conflicted/changes?state=all`, tok.owner);
    expect(all.json.changes.map((c: any) => [c.number, c.state]).sort()).toEqual(
      [
        [won.json.number, 'conflicted'],
        [lost.json.closedChange, 'closed'],
      ].sort(),
    );
    expect(await liveTasks('admit-conflicted')).toEqual([{ status: 'open', number: won.json.number }]);
  });

  it('abandoning a workspace retires the live conflict task of its closed change', async () => {
    const { ws } = await workspaceWithConflict('abandon-conflicted');
    const opened = await openChange('abandon-conflicted', ws.id, { title: 'conflicted' });
    expect([opened.status, opened.json.state]).toEqual([201, 'conflicted']);
    expect(await liveTasks('abandon-conflicted')).toHaveLength(1);
    expect((await abandon('abandon-conflicted', ws.id)).status).toBe(200);
    expect((await getChange('abandon-conflicted', opened.json.number)).json.state).toBe('closed');
    expect(await liveTasks('abandon-conflicted')).toEqual([]);
  });

  it('the send-time check refuses an auto change on a workspace branch linked to another change set', async () => {
    const { repo, main, ws } = await workspaceWithWork('admit-send');
    const linked = await openChange('admit-send', ws.id, { title: 'linked review' });
    expect(linked.status).toBe(201);
    const branch = ws.ref.slice('refs/heads/'.length);
    const direct = await call('POST', `/api/v1/repos/${OWNER}/admit-send/changes`, tok.owner, {
      title: 'side door',
      base: 'main',
      head: branch,
      mergePolicy: 'auto',
    });
    expect(direct.status).toBe(201);
    expect(direct.json.state).toBe('open');
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await getWs('admit-send', ws.id)).json).toMatchObject({ status: 'active', changeSet: linked.json.number });
  });

  it('a push-event auto publisher running between the change insert and the workspace admission publishes nothing', async () => {
    const { repo, main, ws, head } = await workspaceWithWork('admit-push-event');
    const repoRow = (await getRepoById(env.DB, repoIds['admit-push-event']!))!;
    const ctx = createExecutionContext();
    const waitUntil = (p: Promise<unknown>) => ctx.waitUntil(p);
    const cx: ChangeContext = { env, repo: repoRow, actor: null, branchRules: [], waitUntil };
    const during: { detail: string; main: string | undefined }[] = [];
    const created = await createChange(
      cx,
      { title: 'auto', base: 'main', head: ws.ref.slice('refs/heads/'.length), mergePolicy: 'auto' },
      {
        admit: async (change) => {
          // The committed open auto change is visible to the push consumer before it is linked.
          const r = await onHeadPushed(env, repoRow.id, [{ id: change.id, number: change.number, policy: 'auto', headSha: head }], head, waitUntil);
          during.push({ detail: r.detail, main: repo.refs.get('refs/heads/main') });
          const [link] = await env.DB.batch([
            env.DB.prepare('UPDATE workspaces SET change_set_id = ?3 WHERE repo_id = ?1 AND id = ?2 AND change_set_id IS NULL').bind(repoRow.id, ws.id, change.id),
          ]);
          return link?.meta.changes ? null : { ok: false as const, status: 409, error: 'lost', code: 'CHANGE_SET_EXISTS' };
        },
      },
    );
    await waitOnExecutionContext(ctx);
    expect(during).toEqual([{ detail: expect.stringMatching(/auto-merged none/), main: main.sha }]);
    // Once admitted, the initiating request's own auto merge publishes and the linked workspace follows it.
    expect(created.ok && created.value.state).toBe('merged');
    expect(repo.refs.get('refs/heads/main')).toBe(head);
    expect((await getWs('admit-push-event', ws.id)).json).toMatchObject({ status: 'merged' });
  });

  it('a change opened outside the change-set route from an unlinked workspace branch never publishes', async () => {
    const { repo, main, ws } = await workspaceWithWork('admit-unlinked');
    const direct = await call('POST', `/api/v1/repos/${OWNER}/admit-unlinked/changes`, tok.owner, {
      title: 'side door',
      base: 'main',
      head: ws.ref.slice('refs/heads/'.length),
      mergePolicy: 'auto',
    });
    expect([direct.status, direct.json.state]).toEqual([201, 'open']);
    const merge = await call('POST', `/api/v1/repos/${OWNER}/admit-unlinked/changes/${direct.json.number}/merge`, tok.owner);
    expect([merge.status, merge.json.code]).toEqual([409, 'WORKSPACE_NOT_LINKED']);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await getWs('admit-unlinked', ws.id)).json).toMatchObject({ status: 'active', changeSet: null });
  });
});

describe('repo delete', () => {
  it('removes the repo workspaces with the repo row', async () => {
    const repo = await seedRepo('delete');
    const main = await based(repo);
    const ws = (await createWs('delete', { task: 'd', agent: 'x' })).json;
    const c = await commit(repo, { 'README.md': 'readme\n', 'd.txt': 'd\n' }, [main.sha]);
    await workspacePush('delete', [`${main.sha} ${c.sha} ${ws.ref}`]);
    await openChange('delete', ws.id, { title: 'd' });
    const row = await getRepoById(env.DB, repoIds.delete!);
    expect((await deleteRepo(env, row!)).ok).toBe(true);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM workspaces WHERE repo_id = ?').bind(repoIds.delete).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
