/**
 * Hosted CI (services/hostedCi.ts, containers/ciRunnerSandbox.ts): the
 * opt-in lane in which the platform's Container CI runner drains a
 * repository's queued jobs. The settings route is admin-only; enabling
 * creates the service identity and its write grant, and the drain's
 * bookkeeping (kick coalescing, the alarm-driven drain, the recorded report)
 * is exercised through the real Durable Object. The test pool runs without
 * a container runtime, so a drain that reaches the object records
 * CONTAINER_UNAVAILABLE instead of running jobs.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import type { RepoRow } from '../src/db/repos';
import worker from '../src/index';
import { HOSTED_CI_LOGIN, mintHostedRunnerPat, revokeHostedRunnerPat } from '../src/services/hostedCi';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

class FakeWorkflow {
  created: Array<{ id?: string; params?: unknown }> = [];

  async create(opts: { id?: string }) {
    this.created.push(opts);
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const ORIGIN = 'https://kvarm.test';
const OWNER = 'hc-owner';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';
const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'module.exports = 1;\n' };
const CI = `${JSON.stringify({ jobs: [{ name: 'build', run: 'make', required: true }] })}\n`;
const tok = { owner: '', writer: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  userIds[login] = id;
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  const now = Date.now();
  const grant = (login: string, role: 'read' | 'write') =>
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(id, userIds[login], role, now, now)
      .run();
  await grant('hc-writer', 'write');
  await grant('hc-reader', 'read');
  return repo;
}

interface Reply {
  status: number;
  text: string;
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
  expect(cost).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {}
  return { status: res.status, text, json, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const create = (repo: string, body: Record<string, unknown> = {}) =>
  call('POST', `${R(repo)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature', ...body });
const repoRowOf = (name: string) => env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repoIds[name]).first<RepoRow>() as Promise<RepoRow>;
const stubOf = (name: string) => env.CI_SANDBOX.getByName(repoIds[name]!);

/** main = base with `.kvarm/ci.json`; feature = main + edit. */
async function fixture(repo: FakeRepo, edit: Record<string, string>) {
  const withCi = (files: Files): Files => ({ ...files, '.kvarm/ci.json': CI });
  const main = await commit(repo, withCi(BASE));
  const feature = await commit(repo, withCi({ ...BASE, ...edit }), [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  return { main, feature };
}

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  const ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', all)).token;
  const writerId = await seedUser('hc-writer');
  tok.writer = (await mintPAT(env, writerId, 'writer', all)).token;
  const readerId = await seedUser('hc-reader');
  tok.reader = (await mintPAT(env, readerId, 'reader', ['read', 'api'])).token;
  const outsiderId = await seedUser('hc-outsider');
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', all)).token;
});

afterAll(() => restoreFetch());

describe('hosted CI settings', () => {
  it('enabling is a repo-admin action that creates the service identity and its write grant; disabling removes the grant', async () => {
    const repo = await seedRepo('hc-set');
    await fixture(repo, { 'one.txt': 'one\n' });
    const enable = `${R('hc-set')}/ci/hosted/enable`;
    for (const [token, status] of [
      // requireActor challenges anonymous callers explicitly (401) rather
      // than concealing the repository (404).
      [undefined, 401],
      [tok.outsider, 404],
      [tok.reader, 403],
      [tok.writer, 403],
    ] as const) {
      expect((await call('POST', enable, token)).status).toBe(status);
    }

    const on = await call('POST', enable, tok.owner);
    expect([on.status, on.json]).toEqual([200, { enabled: true }]);
    // The backlog kick rides in the response's own work (do=1), not a
    // second request.
    expect(on.cost.do).toBeLessThanOrEqual(1);
    const row = await env.DB.prepare('SELECT hosted_ci FROM repos WHERE id = ?').bind(repoIds['hc-set']).first<{ hosted_ci: number }>();
    expect(row?.hosted_ci).toBe(1);
    const grant = await env.DB.prepare(
      'SELECT g.role, u.login FROM repo_grants g JOIN users u ON u.id = g.user_id WHERE g.repo_id = ? AND u.login = ?',
    )
      .bind(repoIds['hc-set'], HOSTED_CI_LOGIN)
      .first<{ role: string; login: string }>();
    expect(grant).toEqual({ role: 'write', login: HOSTED_CI_LOGIN });
    const service = await env.DB.prepare('SELECT is_admin FROM users WHERE login = ?').bind(HOSTED_CI_LOGIN).first<{ is_admin: number }>();
    expect(service?.is_admin).toBe(0);

    const view = await call('GET', `${R('hc-set')}/ci/hosted`, tok.reader);
    expect(view.status).toBe(200);
    // The enable already kicked the (empty) backlog drain.
    expect(view.json).toMatchObject({ enabled: true, queued: 0, running: 0, drain: { draining: false, pending: false, kickedAt: expect.any(Number), lastDrain: null } });
    // One authority lookup, the queue counts read, and the Durable Object status call.
    expect(view.cost.d1).toBeLessThanOrEqual(2);
    expect(view.cost.do).toBe(1);

    const off = await call('POST', `${R('hc-set')}/ci/hosted/disable`, tok.owner);
    expect([off.status, off.json]).toEqual([200, { enabled: false }]);
    expect((await call('GET', `${R('hc-set')}/ci/hosted`, tok.reader)).json).toMatchObject({ enabled: false });
    const gone = await env.DB.prepare(
      'SELECT 1 FROM repo_grants g JOIN users u ON u.id = g.user_id WHERE g.repo_id = ? AND u.login = ?',
    )
      .bind(repoIds['hc-set'], HOSTED_CI_LOGIN)
      .first();
    expect(gone).toBeNull();
  });
});

describe('hosted CI credentials', () => {
  it('mints a scoped expiring PAT for the service identity, revokes it, and sweeps the rows of dead drains', async () => {
    await seedRepo('hc-cred');
    const first = await mintHostedRunnerPat(env, await repoRowOf('hc-cred'));
    expect(first.token).toMatch(/^kvarm_pat_[0-9a-f]{64}$/);
    const row = await env.DB.prepare('SELECT p.scopes, p.expires_at, u.login FROM pat p JOIN users u ON u.id = p.user_id WHERE p.id = ?')
      .bind(first.id)
      .first<{ scopes: string; expires_at: number; login: string }>();
    expect(JSON.parse(row?.scopes ?? '[]')).toEqual(['read', 'write', 'api', 'ci']);
    expect(row?.login).toBe(HOSTED_CI_LOGIN);
    expect(row?.expires_at).toBeGreaterThan(Date.now());

    await revokeHostedRunnerPat(env, first);
    expect(await env.DB.prepare('SELECT 1 FROM pat WHERE id = ?').bind(first.id).first()).toBeNull();

    // A drain that died mid-run cannot revoke its own credential: the expiry
    // bounds it and the next mint sweeps it.
    const stale = await mintHostedRunnerPat(env, await repoRowOf('hc-cred'));
    await env.DB.prepare('UPDATE pat SET created_at = ? WHERE id = ?').bind(Date.now() - 3 * 60 * 60 * 1000, stale.id).run();
    await mintHostedRunnerPat(env, await repoRowOf('hc-cred'));
    const swept = await env.DB.prepare('SELECT 1 FROM pat WHERE id = ?').bind(stale.id).first();
    expect(swept).toBeNull();
  });
});

describe('hosted CI drain', () => {
  it('a queued change kicks the drain, and the alarm records the unavailable container runtime', async () => {
    const repo = await seedRepo('hc-drain');
    await fixture(repo, { 'two.txt': 'two\n' });
    await call('POST', `${R('hc-drain')}/ci/hosted/enable`, tok.owner);
    const stub = stubOf('hc-drain');
    // Enabling kicks at once, to drain any backlog that queued while hosted
    // CI was off; this repository has none, so the alarm that follows is a
    // no-op and nothing is recorded.
    const enabledKick = (await stub.status()).kickedAt;
    expect(enabledKick).not.toBeNull();

    // Change creation queues the job and kicks again before the response
    // returns; the drain is armed deterministically. The runtime fires that
    // alarm on its own schedule, so the explicit run below is a backstop
    // and the assertions hold whether or not it already ran.
    await create('hc-drain');
    const kicked = await stub.status();
    expect(kicked.kickedAt).not.toBeNull();
    expect(kicked.kickedAt).toBeGreaterThanOrEqual(enabledKick!);

    // Run the alarm handler once (the scheduled alarm may or may not have
    // fired first): the drain finds the job, finds no container runtime, and
    // records why, so the status answers with evidence instead of silence.
    await runInDurableObject(stub, async (obj) => {
      await obj.alarm!();
    });
    const drained = await stub.status();
    expect(drained.draining).toBe(false);
    expect(drained.pending).toBe(false);
    expect(drained.lastDrain).toMatchObject({ error: { code: 'CONTAINER_UNAVAILABLE' } });

    const view = await call('GET', `${R('hc-drain')}/ci/hosted`, tok.owner);
    expect(view.json).toMatchObject({ enabled: true, queued: 1, drain: { draining: false, lastDrain: { error: { code: 'CONTAINER_UNAVAILABLE' } } } });
  });

  it('kicks coalesce while a drain is running, and a drain is a no-op for disabled or empty repositories', async () => {
    const repo = await seedRepo('hc-coalesce');
    await fixture(repo, { 'three.txt': 'three\n' });
    await call('POST', `${R('hc-coalesce')}/ci/hosted/enable`, tok.owner);
    const stub = stubOf('hc-coalesce');
    // The enable call armed the backlog drain; disarm it so the sequence
    // below is deterministic rather than racing the runtime's own alarm.
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm();
    });
    expect((await stub.kick()).started).toBe(true);
    // That kick armed the runtime's own alarm; disarm it so the coalescing
    // sequence below is deterministic.
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.deleteAlarm();
    });

    // A kick that arrives mid-drain is recorded for the pass that follows.
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.put('draining', Date.now());
    });
    expect(await stub.kick()).toEqual({ started: false, queued: true });
    expect((await stub.status()).pending).toBe(true);

    // The alarm clears the mark and, because the queue was never populated,
    // records nothing: an empty repository is not a drain.
    await runInDurableObject(stub, async (obj) => {
      await obj.alarm!();
    });
    const settled = await stub.status();
    expect(settled).toMatchObject({ draining: false, pending: false, lastDrain: null });
  });

  it('a disabled repository is never drained and never kicked by queueing', async () => {
    const repo = await seedRepo('hc-off');
    await fixture(repo, { 'four.txt': 'four\n' });
    await create('hc-off');
    const status = await stubOf('hc-off').status();
    expect(status.kickedAt).toBeNull();
    expect(status.lastDrain).toBeNull();
    const view = await call('GET', `${R('hc-off')}/ci/hosted`, tok.owner);
    expect(view.json).toMatchObject({ enabled: false, queued: 1, drain: { kickedAt: null } });
  });
});
