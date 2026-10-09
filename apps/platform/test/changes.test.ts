/**
 * Change requests (services/changes.ts) through the Worker's routes and push
 * queue, over the in-memory Artifacts fake: ls-refs and receive-pack are
 * served by the fake remote, so merges publish real git objects with a
 * compare-and-swap on the base ref exactly like the Artifacts remote.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import {
  FakeRepo,
  commit,
  fakeArtifacts,
  fakeRepos,
  installFakeGitRemote,
  restoreFetch,
  type Files,
} from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'cr-owner';

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

const tok = { owner: '', noApi: '', bot: '', writer: '', reader: '' };
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

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public'): Promise<FakeRepo> {
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

async function grant(repo: string, login: string, role: 'read' | 'write' | 'admin'): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(repoIds[repo], userIds[login], role, userIds[OWNER], Date.now(), Date.now())
    .run();
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

const path = (repo: string, rest = '') => `/api/v1/repos/${OWNER}/${repo}/changes${rest}`;
const create = (repo: string, body: unknown, token = tok.owner) => call('POST', path(repo), token, body);
const get = (repo: string, n: number, token: string | undefined = tok.owner) => call('GET', path(repo, `/${n}`), token);
const patch = (repo: string, n: number, body: unknown, token = tok.owner) => call('PATCH', path(repo, `/${n}`), token, body);
const merge = (repo: string, n: number, token = tok.owner) => call('POST', path(repo, `/${n}/merge`), token);
const list = (repo: string, q = '', token: string | undefined = tok.owner) => call('GET', path(repo, q), token);

async function rowCount(repo: string): Promise<number> {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ?').bind(repoIds[repo]).first<{ n: number }>();
  return r?.n ?? 0;
}

/** main at M (README); feature = M + one benign file. */
async function linear(repo: FakeRepo, extra: Files = { 'notes.txt': 'hello\n' }) {
  const main = await commit(repo, { 'README.md': 'readme\n' });
  const feature = await commit(repo, { 'README.md': 'readme\n', ...extra }, [main.sha]);
  repo.refs.set('refs/heads/main', main.sha);
  repo.refs.set('refs/heads/feature', feature.sha);
  return { main, feature };
}

/** From a branch point, main adds a.txt and feature adds b.txt. */
async function divergent(repo: FakeRepo) {
  const root = await commit(repo, { 'README.md': 'readme\n' });
  const main = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n' }, [root.sha]);
  const feature = await commit(repo, { 'README.md': 'readme\n', 'b.txt': 'B\n' }, [root.sha]);
  repo.refs.set('refs/heads/main', main.sha);
  repo.refs.set('refs/heads/feature', feature.sha);
  return { root, main, feature };
}

/** main and feature edit the same line of README differently. */
async function conflicting(repo: FakeRepo) {
  const root = await commit(repo, { 'README.md': 'one\n' });
  const main = await commit(repo, { 'README.md': 'main\n' }, [root.sha]);
  const feature = await commit(repo, { 'README.md': 'feature\n' }, [root.sha]);
  repo.refs.set('refs/heads/main', main.sha);
  repo.refs.set('refs/heads/feature', feature.sha);
  return { root, main, feature };
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

function treeNames(repo: FakeRepo, tree: string): Record<string, string> {
  const o = repo.objects.get(tree);
  expect(o?.type).toBe('tree');
  const out: Record<string, string> = {};
  let off = 0;
  const c = o!.content;
  while (off < c.length) {
    const sp = c.indexOf(0x20, off);
    const nul = c.indexOf(0, sp);
    const name = decode(c.subarray(sp + 1, nul));
    const hash = [...c.subarray(nul + 1, nul + 21)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const blob = repo.objects.get(hash);
    out[name] = blob?.type === 'blob' ? decode(blob.content) : `<${blob?.type ?? 'missing'}>`;
    off = nul + 21;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Push events
// ---------------------------------------------------------------------------

function pushBody(repo: string, ref: string, before: string, after: string, at: number) {
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

async function effectDetail(repo: string, effect: string): Promise<{ state: string; detail: string | null } | null> {
  return env.DB.prepare(
    `SELECT x.state, x.detail FROM push_event_effects x JOIN push_events p ON p.id = x.event_id
      WHERE p.repo_id = ? AND x.effect = ? ORDER BY p.event_at DESC LIMIT 1`,
  )
    .bind(repoIds[repo], effect)
    .first<{ state: string; detail: string | null }>();
}

beforeAll(async () => {
  installFakeGitRemote();
  const ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  tok.noApi = (await mintPAT(env, ownerId, 'no-api', ['read', 'write'])).token;
  tok.bot = (await mintPAT(env, await seedUser('cr-bot'), 'bot', FULL)).token;
  tok.writer = (await mintPAT(env, await seedUser('cr-writer'), 'writer', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('cr-reader'), 'reader', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('create, read, list', () => {
  it('creates a change with the review default, the head tip and per-repo numbers', async () => {
    const repo = await seedRepo('create');
    const { main, feature } = await linear(repo);
    const r = await create('create', { title: 'Add feature', base: 'main', head: 'feature' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({
      number: 1,
      title: 'Add feature',
      state: 'open',
      mergePolicy: 'review',
      base: 'main',
      head: 'feature',
      headSha: feature.sha,
      baseSha: main.sha,
      author: OWNER,
      mergeCommit: null,
    });
    expect(r.json.rating).toMatchObject({ score: expect.any(Number), level: expect.stringMatching(/^(low|medium|high)$/) });

    const again = await get('create', 1);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ number: 1, state: 'open', mergePolicy: 'review', headSha: feature.sha });

    expect((await create('create', { title: 'Second', base: 'main', head: 'refs/heads/feature' })).json.number).toBe(2);
    const other = await seedRepo('create-other');
    await linear(other);
    expect((await create('create-other', { title: 'Other repo', base: 'main', head: 'feature' })).json.number).toBe(1);
    expect((await create('create', { title: 'Third', base: 'main', head: 'feature' })).json.number).toBe(3);
  });

  it('missing branches and base == head are refused before anything is written', async () => {
    const repo = await seedRepo('refuse');
    await linear(repo);
    const cases: Array<[unknown, number, string]> = [
      [{ title: 'x', base: 'main', head: 'no-such-branch' }, 422, 'REF_NOT_FOUND'],
      [{ title: 'x', base: 'no-such-branch', head: 'feature' }, 422, 'REF_NOT_FOUND'],
      [{ title: 'x', base: 'main', head: 'main' }, 422, 'SAME_REF'],
      [{ title: 'x', base: 'main', head: 'refs/heads/main' }, 422, 'SAME_REF'],
      [{ title: '', base: 'main', head: 'feature' }, 422, 'INVALID_TITLE'],
      [{ title: 'x', base: 'main', head: 'feature', mergePolicy: 'yolo' }, 422, 'INVALID_MERGE_POLICY'],
      [{ title: 'x', base: 'main', head: 'bad..name' }, 422, 'INVALID_REF'],
      [{ title: 'x', base: 'refs/tags/v1', head: 'feature' }, 422, 'INVALID_REF'],
    ];
    for (const [body, status, code] of cases) {
      const r = await create('refuse', body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
      expect(typeof r.json.error).toBe('string');
    }
    expect(await rowCount('refuse')).toBe(0);
    expect((await list('refuse')).json.changes).toEqual([]);
    expect((await create('refuse', { title: 'ok', base: 'main', head: 'feature' })).json.number).toBe(1);
  });

  it('lists by state, newest first, with a cursor', async () => {
    const repo = await seedRepo('list');
    await linear(repo);
    for (const t of ['one', 'two', 'three']) expect((await create('list', { title: t, base: 'main', head: 'feature' })).status).toBe(201);
    expect((await patch('list', 1, { state: 'closed' })).status).toBe(200);

    const open = await list('list');
    expect(open.json.changes.map((c: { number: number }) => c.number)).toEqual([3, 2]);
    expect((await list('list', '?state=closed')).json.changes.map((c: { number: number }) => c.number)).toEqual([1]);
    expect((await list('list', '?state=merged')).json.changes).toEqual([]);
    const all = await list('list', '?state=all&limit=2');
    expect(all.json.changes.map((c: { number: number }) => c.number)).toEqual([3, 2]);
    expect(all.json.nextCursor).toBe('2');
    const rest = await list('list', '?state=all&limit=2&cursor=2');
    expect(rest.json.changes.map((c: { number: number }) => c.number)).toEqual([1]);
    expect(rest.json.nextCursor).toBeNull();
    expect((await list('list', '?state=bogus')).status).toBe(400);
    expect((await list('list', '?limit=0')).status).toBe(400);
  });

  it('updates title and policy, closes and reopens; the head never moves on PATCH', async () => {
    const repo = await seedRepo('patch');
    const { feature } = await linear(repo);
    await create('patch', { title: 'Add feature', base: 'main', head: 'feature' });

    const renamed = await patch('patch', 1, { title: 'Renamed', mergePolicy: 'draft', body: 'details' });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ title: 'Renamed', mergePolicy: 'draft', body: 'details', headSha: feature.sha });
    expect((await get('patch', 1)).json).toMatchObject({ title: 'Renamed', mergePolicy: 'draft', headSha: feature.sha });

    expect((await patch('patch', 1, { state: 'closed' })).json.state).toBe('closed');
    expect((await get('patch', 1)).json.state).toBe('closed');
    expect((await list('patch')).json.changes).toEqual([]);
    expect((await list('patch', '?state=closed')).json.changes).toHaveLength(1);
    expect((await patch('patch', 1, { state: 'open' })).json.state).toBe('open');
    expect((await list('patch')).json.changes.map((c: { number: number }) => c.number)).toEqual([1]);

    expect((await patch('patch', 1, {})).json.code).toBe('EMPTY_PATCH');
    expect((await patch('patch', 1, { state: 'merged' })).json.code).toBe('INVALID_STATE');
    expect((await patch('patch', 1, { mergePolicy: 'later' })).json.code).toBe('INVALID_MERGE_POLICY');
    expect((await patch('patch', 9, { title: 'x' })).status).toBe(404);
    expect((await get('patch', 9)).status).toBe(404);
    expect((await get('patch', 0)).status).toBe(404);
  });
});

describe('authorization', () => {
  it('writes need an api-scope credential with the write role; public reads stay open', async () => {
    const repo = await seedRepo('auth');
    await linear(repo);
    const body = { title: 'x', base: 'main', head: 'feature' };

    expect((await create('auth', body, '')).status).toBe(401);
    const noApi = await create('auth', body, tok.noApi);
    // A PAT without the api scope is no API credential at all.
    expect([noApi.status, noApi.json.code]).toEqual([401, 'UNAUTHENTICATED']);
    const bot = await create('auth', body, tok.bot);
    expect(bot.status).toBe(403);
    expect(typeof bot.json.error).toBe('string');
    expect(await rowCount('auth')).toBe(0);

    expect((await create('auth', body)).status).toBe(201);
    expect((await list('auth', '', tok.bot)).status).toBe(200);
    expect((await list('auth', '', '')).json.changes).toHaveLength(1);
    expect((await get('auth', 1, tok.bot)).status).toBe(200);
    for (const r of [await patch('auth', 1, { title: 'bot' }, tok.bot), await merge('auth', 1, tok.bot)]) expect(r.status).toBe(403);

    await grant('auth', 'cr-writer', 'write');
    await grant('auth', 'cr-reader', 'read');
    const granted = await create('auth', body, tok.writer);
    expect([granted.status, granted.json.author]).toEqual([201, 'cr-writer']);
    expect((await create('auth', body, tok.reader)).status).toBe(403);
    expect(await rowCount('auth')).toBe(2);
  });

  it('a private repo hides its changes from outsiders', async () => {
    const repo = await seedRepo('private', 'private');
    await linear(repo);
    expect((await create('private', { title: 'x', base: 'main', head: 'feature' })).status).toBe(201);
    expect((await list('private', '', '')).status).toBe(404);
    expect((await get('private', 1, tok.bot)).status).toBe(404);
    expect((await create('private', { title: 'x', base: 'main', head: 'feature' }, tok.bot)).status).toBe(404);
  });

  it('an agent token may open changes but merges only into refs it may update', async () => {
    const repo = await seedRepo('agent');
    const { main } = await linear(repo);
    const agent = await call('POST', '/api/v1/agents', tok.owner, { name: 'cr-agent' });
    expect(agent.status).toBe(201);
    const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
      repo: `${OWNER}/agent`,
      role: 'write',
      refs: ['refs/heads/agents/*'],
    });
    expect(minted.status).toBe(201);
    const t = minted.json.token as string;

    const opened = await create('agent', { title: 'by agent', base: 'main', head: 'feature' }, t);
    expect(opened.status).toBe(201);
    expect(opened.json.agent).toMatchObject({ name: 'cr-agent' });
    expect((await create('agent', { title: 'auto', base: 'main', head: 'feature', mergePolicy: 'auto' }, t)).json.code).toBe(
      'AGENT_REF_FORBIDDEN',
    );
    expect((await patch('agent', 1, { mergePolicy: 'auto' }, t)).json.code).toBe('AGENT_REF_FORBIDDEN');
    expect((await merge('agent', 1, t)).json.code).toBe('AGENT_REF_FORBIDDEN');
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await get('agent', 1)).json.state).toBe('open');
  });
});

describe('detail: rating, mergeability, checks', () => {
  it('the rating equals the compare rating for the same base and head', async () => {
    const repo = await seedRepo('rating');
    const base: Files = {
      'README.md': 'readme\n',
      'src/app.ts': 'export const x = 1;\n',
      'test/app.test.ts': 'test("x", () => {});\n',
      '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
    };
    const main = await commit(repo, base);
    const { 'test/app.test.ts': _gone, ...rest } = base;
    const feature = await commit(repo, { ...rest, '.github/workflows/ci.yml': 'on: [push, pull_request]\njobs: {}\n' }, [main.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/feature', feature.sha);

    const created = await create('rating', { title: 'risky', base: 'main', head: 'feature' });
    const detail = await get('rating', 1);
    const compare = await call('GET', `/api/v1/repos/${OWNER}/rating/compare/main...${feature.sha}`, tok.owner);
    expect(compare.status).toBe(200);
    expect(detail.json.rating).toEqual(compare.json.rating);
    expect(created.json.rating).toEqual(compare.json.rating);
    expect(detail.json.rating.reasons.length).toBeGreaterThan(0);
    expect(detail.json.rating.score).toBeGreaterThan(0);
  });

  it('reports a fast-forward as mergeable and a conflict as not, with the conflicting paths', async () => {
    const repo = await seedRepo('mergeable');
    const { main, feature } = await linear(repo);
    await create('mergeable', { title: 'ff', base: 'main', head: 'feature' });
    const d = await get('mergeable', 1);
    expect(d.json.headSha).toBe(feature.sha);
    expect(d.json.mergeability).toMatchObject({
      status: 'fast-forward',
      mergeable: true,
      fastForward: true,
      conflicts: [],
      targetSha: main.sha,
      headSha: feature.sha,
      treeSha: feature.tree,
      checks: { state: 'success', required: [] },
    });
    expect(d.json.checks).toEqual([]);

    const c = await seedRepo('conflicted');
    await conflicting(c);
    await create('conflicted', { title: 'conflict', base: 'main', head: 'feature' });
    const m = await call('GET', path('conflicted', '/1/mergeability'), tok.owner);
    expect(m.status).toBe(200);
    expect(m.json.mergeability).toMatchObject({
      status: 'conflicts',
      mergeable: false,
      fastForward: false,
      conflicts: [{ path: 'README.md', kind: expect.any(String) }],
      treeSha: null,
    });
    const refused = await merge('conflicted', 1);
    expect([refused.status, refused.json.code]).toEqual([409, 'MERGE_CONFLICT']);
    expect(refused.json.conflicts).toEqual([{ path: 'README.md', kind: expect.any(String) }]);
    expect((await get('conflicted', 1)).json.state).toBe('open');
  });

  it('detail D1 cost stays constant as check runs accumulate', async () => {
    const repo = await seedRepo('cost');
    await linear(repo);
    await create('cost', { title: 'cost', base: 'main', head: 'feature' });
    await get('cost', 1);
    const before = await get('cost', 1);
    const changeId = (await env.DB.prepare('SELECT id, head_sha FROM change_sets WHERE repo_id = ?').bind(repoIds.cost).first<{ id: string; head_sha: string }>())!;
    const stmts = Array.from({ length: 120 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, conclusion, created_at)
         VALUES (?, ?, ?, ?, ?, 'success', 'success', ?)`,
      ).bind(crypto.randomUUID(), repoIds.cost, changeId.id, changeId.head_sha, `check-${i}`, Date.now() + i),
    );
    await env.DB.batch(stmts);
    const after = await get('cost', 1);
    expect(after.json.checks).toHaveLength(100);
    expect(after.json.checks[0].name).toBe('check-119');
    expect(after.cost.d1).toBe(before.cost.d1);
    expect(after.cost.d1).toBeLessThanOrEqual(2);
    const checks = await call('GET', path('cost', '/1/checks'), tok.owner);
    expect(checks.json.checks).toHaveLength(100);
    expect(checks.cost.d1).toBeLessThanOrEqual(2);
    expect((await list('cost')).cost.d1).toBeLessThanOrEqual(2);
  });
});

describe('merge', () => {
  it('fast-forward moves the base to the head and records the head as mergeCommit', async () => {
    const repo = await seedRepo('ff');
    const { feature } = await linear(repo);
    const objects = repo.objects.size;
    await create('ff', { title: 'ff', base: 'main', head: 'feature' });
    const r = await merge('ff', 1);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'merged', mergeCommit: feature.sha, merge: { kind: 'fast-forward', mergeCommit: feature.sha } });
    expect(repo.refs.get('refs/heads/main')).toBe(feature.sha);
    expect(repo.objects.size).toBe(objects);
    expect((await get('ff', 1)).json).toMatchObject({ state: 'merged', mergeCommit: feature.sha, mergedAt: expect.any(String), mergeability: null });
    expect((await list('ff', '?state=merged')).json.changes).toHaveLength(1);

    expect((await merge('ff', 1)).json.code).toBe('ALREADY_MERGED');
    expect([(await patch('ff', 1, { state: 'closed' })).status, (await get('ff', 1)).json.state]).toEqual([409, 'merged']);
  });

  it('three-way merge publishes a two-parent commit holding both sides', async () => {
    const repo = await seedRepo('threeway');
    const { main, feature } = await divergent(repo);
    await create('threeway', { title: 'both', base: 'main', head: 'feature' });
    const m = await get('threeway', 1);
    expect(m.json.mergeability).toMatchObject({ status: 'clean', mergeable: true, fastForward: false });

    const r = await merge('threeway', 1);
    expect(r.status).toBe(200);
    const mc = r.json.mergeCommit as string;
    expect(r.json).toMatchObject({ state: 'merged', merge: { kind: 'merge', previous: main.sha, treeSha: m.json.mergeability.treeSha } });
    expect(repo.refs.get('refs/heads/main')).toBe(mc);
    const c = commitOf(repo, mc);
    expect(c.parents).toEqual([main.sha, feature.sha]);
    expect(c.tree).toBe(m.json.mergeability.treeSha);
    expect(treeNames(repo, c.tree)).toEqual({ 'README.md': 'readme\n', 'a.txt': 'A\n', 'b.txt': 'B\n' });
    expect(decode(repo.objects.get(mc)!.content)).toMatch(/^author cr-owner <cr-owner@forge\.invalid> /m);
  });

  it('a draft never merges; switching to review allows the explicit merge', async () => {
    const repo = await seedRepo('draft');
    const { main, feature } = await linear(repo);
    expect((await create('draft', { title: 'wip', base: 'main', head: 'feature', mergePolicy: 'draft' })).json.mergePolicy).toBe('draft');
    const refused = await merge('draft', 1);
    expect([refused.status, refused.json.code]).toEqual([409, 'DRAFT']);
    expect(refused.json.error).toMatch(/draft/);
    expect((await get('draft', 1)).json.state).toBe('open');
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);

    expect((await patch('draft', 1, { mergePolicy: 'review' })).status).toBe(200);
    expect((await merge('draft', 1)).json).toMatchObject({ state: 'merged', mergeCommit: feature.sha });
  });

  it('closed changes refuse to merge until reopened', async () => {
    const repo = await seedRepo('closed');
    await linear(repo);
    await create('closed', { title: 'x', base: 'main', head: 'feature' });
    await patch('closed', 1, { state: 'closed' });
    expect((await merge('closed', 1)).json.code).toBe('CHANGE_CLOSED');
    await patch('closed', 1, { state: 'open' });
    expect((await merge('closed', 1)).json.state).toBe('merged');
  });

  it('auto merges as soon as the change is mergeable (immediately with an empty required set)', async () => {
    const repo = await seedRepo('auto');
    const { feature } = await linear(repo);
    const r = await create('auto', { title: 'auto', base: 'main', head: 'feature', mergePolicy: 'auto' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ state: 'merged', mergePolicy: 'auto', mergeCommit: feature.sha });
    expect(repo.refs.get('refs/heads/main')).toBe(feature.sha);

    const second = await seedRepo('auto-patch');
    const s = await linear(second);
    await create('auto-patch', { title: 'later', base: 'main', head: 'feature' });
    expect(second.refs.get('refs/heads/main')).toBe(s.main.sha);
    expect((await patch('auto-patch', 1, { mergePolicy: 'auto' })).json).toMatchObject({ state: 'merged', mergeCommit: s.feature.sha });
  });

  it('branch rules on the base gate merges: approvals and required checks', async () => {
    const repo = await seedRepo('rules');
    const { main } = await linear(repo);
    await create('rules', { title: 'x', base: 'main', head: 'feature' });
    const rule = await call('POST', `/api/v1/repos/${OWNER}/rules/branch-rules`, tok.owner, { pattern: 'main', requiredApprovals: 1 });
    expect(rule.status).toBe(201);
    const blocked = await merge('rules', 1);
    expect([blocked.status, blocked.json.code]).toEqual([409, 'APPROVALS_REQUIRED']);
    expect(blocked.json.error).toMatch(/1 approving review/);

    const ruleId = rule.json.id ?? rule.json.rule?.id;
    expect((await call('PATCH', `/api/v1/repos/${OWNER}/rules/branch-rules/${ruleId}`, tok.owner, { requiredApprovals: 0, requiredChecks: ['ci'] })).status).toBe(200);
    const pending = await merge('rules', 1);
    expect([pending.status, pending.json.code]).toEqual([409, 'REQUIRED_CHECKS_PENDING']);
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await get('rules', 1)).json.state).toBe('open');
  });

  it('an unconfirmed publication leaves the change open and the base unmoved', async () => {
    const repo = await seedRepo('unknown');
    const { main } = await divergent(repo);
    await create('unknown', { title: 'x', base: 'main', head: 'feature' });
    repo.receivePackStatus = 503;
    const r = await merge('unknown', 1);
    expect([r.status, r.json.code]).toEqual([502, 'PUBLISH_UNKNOWN']);
    repo.receivePackStatus = 403;
    expect((await merge('unknown', 1)).json.code).toBe('PUBLISH_REJECTED');
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
    expect((await get('unknown', 1)).json.state).toBe('open');
    repo.receivePackStatus = null;
    expect((await merge('unknown', 1)).json.state).toBe('merged');
  });

  it('re-plans once when the base moved between planning and publication', async () => {
    const repo = await seedRepo('moving');
    const { main, feature } = await divergent(repo);
    await create('moving', { title: 'x', base: 'main', head: 'feature' });
    // The first receive-pack sees a newer main than ls-refs reported.
    const moved = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n', 'c.txt': 'C\n' }, [main.sha]);
    let first = true;
    const origCalls = repo.calls.push.bind(repo.calls);
    repo.calls.push = (...items: string[]) => {
      if (first && items.some((i) => i.startsWith('receivePack:'))) {
        first = false;
        repo.refs.set('refs/heads/main', moved.sha);
      }
      return origCalls(...items);
    };
    const r = await merge('moving', 1);
    expect(r.status).toBe(200);
    const c = commitOf(repo, r.json.mergeCommit);
    expect(c.parents).toEqual([moved.sha, feature.sha]);
    expect(treeNames(repo, c.tree)).toEqual({ 'README.md': 'readme\n', 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' });
  });
});

describe('head refresh on push', () => {
  it('a push moves the head; an older event never rolls it back; review changes stay open', async () => {
    const repo = await seedRepo('refresh');
    const { main, feature } = await linear(repo);
    const created = Date.now();
    await create('refresh', { title: 'x', base: 'main', head: 'feature' });

    const c2 = await commit(repo, { 'README.md': 'readme\n', 'notes.txt': 'hello\nmore\n' }, [feature.sha]);
    repo.refs.set('refs/heads/feature', c2.sha);
    await deliver(pushBody('refresh', 'refs/heads/feature', feature.sha, c2.sha, created + 5_000));
    expect((await get('refresh', 1)).json).toMatchObject({ headSha: c2.sha, state: 'open' });
    expect(await effectDetail('refresh', 'change-hooks')).toMatchObject({ state: 'done', detail: 'heads #1' });

    // The push that created the branch, delivered late, is older than the change.
    await deliver(pushBody('refresh', 'refs/heads/feature', '0'.repeat(40), feature.sha, created - 60_000));
    expect((await get('refresh', 1)).json.headSha).toBe(c2.sha);

    // Other branches and deletes leave the head alone.
    await deliver(pushBody('refresh', 'refs/heads/main', main.sha, main.sha, created + 6_000));
    await deliver(pushBody('refresh', 'refs/heads/feature', c2.sha, '0'.repeat(40), created + 7_000));
    expect((await get('refresh', 1)).json).toMatchObject({ headSha: c2.sha, state: 'open' });
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);
  });

  it('closed and merged changes keep their head', async () => {
    const repo = await seedRepo('refresh-closed');
    const { feature } = await linear(repo);
    const created = Date.now();
    await create('refresh-closed', { title: 'x', base: 'main', head: 'feature' });
    await patch('refresh-closed', 1, { state: 'closed' });
    const c2 = await commit(repo, { 'README.md': 'readme\n', 'notes.txt': 'v2\n' }, [feature.sha]);
    repo.refs.set('refs/heads/feature', c2.sha);
    await deliver(pushBody('refresh-closed', 'refs/heads/feature', feature.sha, c2.sha, created + 5_000));
    expect((await get('refresh-closed', 1)).json.headSha).toBe(feature.sha);
  });

  it('an auto change merges when a push makes it mergeable', async () => {
    const repo = await seedRepo('refresh-auto');
    const { main, feature } = await conflicting(repo);
    const created = Date.now();
    const r = await create('refresh-auto', { title: 'x', base: 'main', head: 'feature', mergePolicy: 'auto' });
    expect(r.json.state).toBe('open');
    expect(repo.refs.get('refs/heads/main')).toBe(main.sha);

    // Resolve by merging main into feature.
    const resolved = await commit(repo, { 'README.md': 'resolved\n' }, [feature.sha, main.sha]);
    repo.refs.set('refs/heads/feature', resolved.sha);
    await deliver(pushBody('refresh-auto', 'refs/heads/feature', feature.sha, resolved.sha, created + 5_000));
    expect((await get('refresh-auto', 1)).json).toMatchObject({ state: 'merged', headSha: resolved.sha, mergeCommit: resolved.sha });
    expect(repo.refs.get('refs/heads/main')).toBe(resolved.sha);
    expect(await effectDetail('refresh-auto', 'change-hooks')).toMatchObject({ state: 'done', detail: 'heads #1; auto-merged #1' });
  });
});

describe('repo delete', () => {
  it('removes the changes and their check runs with the repo', async () => {
    const repo = await seedRepo('delete');
    await linear(repo);
    await create('delete', { title: 'x', base: 'main', head: 'feature' });
    const row = (await env.DB.prepare('SELECT id, head_sha FROM change_sets WHERE repo_id = ?').bind(repoIds.delete).first<{ id: string; head_sha: string }>())!;
    await env.DB.prepare(
      `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, created_at) VALUES (?, ?, ?, ?, 'ci', 'queued', ?)`,
    )
      .bind(crypto.randomUUID(), repoIds.delete, row.id, row.head_sha, Date.now())
      .run();
    const del = await call('DELETE', `/api/v1/repos/${OWNER}/delete`, tok.owner);
    expect(del.status).toBeLessThan(300);
    expect(await rowCount('delete')).toBe(0);
    const runs = await env.DB.prepare('SELECT COUNT(*) AS n FROM check_runs WHERE repo_id = ?').bind(repoIds.delete).first<{ n: number }>();
    expect(runs?.n).toBe(0);
  });
});
