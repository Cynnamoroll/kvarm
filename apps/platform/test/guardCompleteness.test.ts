/**
 * Guard completeness (architecture §0.3): an incomplete kvarm/guard
 * verdict (files past the guard's read budgets) is reported as incomplete
 * everywhere the check is shown. Runs through the Worker's routes over the
 * in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import worker from '../src/index';
import { GUARD_BUDGETS } from '../src/services/checks';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'gc-owner';
const REVIEWER = 'gc-reviewer';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const fakeEvents = {
  async send() {},
  async sendBatch() {},
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const tok = { owner: '', reviewer: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
       VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
    ).bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, now),
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
      id,
      userIds[REVIEWER],
      'write',
      userIds[OWNER],
      now,
      now,
    ),
  ]);
  return repo;
}

interface Reply {
  status: number;
  json: Record<string, any>;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  expect(parseCostHeader(res.headers.get(COST_HEADER))).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;

const BASE: Files = { 'README.md': '# App\n' };
/** A file the guard reads only up to its per-file prefix: the rest is uninspected. */
const OVERSIZED = 'x'.repeat(GUARD_BUDGETS.maxBytesPerFile + 10) + '\nmore\n';
const pkg = (extra: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', ...extra } }, null, 2) + '\n';

/**
 * main = BASE (+ `base`), feature = main + `edit`; optional branch rules
 * created first, then the change, approved by a second human so a
 * protected target's review gate holds.
 */
async function scenario(name: string, edit: Files, rules: Array<Record<string, unknown>>, base: Files = {}) {
  const repo = await seedRepo(name);
  const main = await commit(repo, { ...BASE, ...base });
  const feature = await commit(repo, { ...BASE, ...base, ...edit }, [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  for (const rule of rules) {
    const r = await call('POST', `${R(name)}/branch-rules`, tok.owner, rule);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  const created = await call('POST', `${R(name)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  if (rules.length > 0) {
    const approved = await call('POST', `${R(name)}/changes/1/approve`, tok.reviewer, {});
    expect(approved.status, JSON.stringify(approved.json)).toBe(201);
  }
  return { repo, main, feature };
}

const merge = (name: string) => call('POST', `${R(name)}/changes/1/merge`, tok.owner);

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api'];
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', all)).token;
  tok.reviewer = (await mintPAT(env, await seedUser(REVIEWER), 'reviewer', all)).token;
});

afterAll(() => restoreFetch());

describe('guard completeness: the check shows what it did not inspect', () => {
  it('guard completeness: an incomplete neutral guard says so on the check run, the commit status and mergeability', async () => {
    const { feature } = await scenario('gc-surface', { 'big.txt': OVERSIZED }, []);
    const run = (await call('GET', `${R('gc-surface')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run).toMatchObject({ name: 'kvarm/guard', status: 'success', conclusion: 'neutral' });
    expect(run.summary).toMatchObject({
      version: 'guard/v1',
      complete: false,
      uninspected: { count: 1, listTruncated: false, paths: [{ path: 'big.txt', reason: 'prefix-only' }] },
    });
    expect(run.summary.title).toMatch(/^incomplete: 1 changed file\(s\) not fully inspected/);

    const status = (await call('GET', `${R('gc-surface')}/commits/${feature.sha}/status`, tok.owner)).json;
    expect(status).toMatchObject({ state: 'success', incomplete: ['kvarm/guard'] });

    const detail = (await call('GET', `${R('gc-surface')}/changes/1`, tok.owner)).json;
    expect(detail.mergeability.checks.required).toEqual([expect.objectContaining({ name: 'kvarm/guard', state: 'success', incomplete: true, uninspected: 1 })]);
  });

  it('guard completeness: files past the per-change file budget are reported as over-file-budget', async () => {
    const edit: Files = {};
    for (let i = 0; i <= GUARD_BUDGETS.maxFiles; i++) edit[`f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
    await scenario('gc-many', edit, []);
    const run = (await call('GET', `${R('gc-many')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run.conclusion).toBe('neutral');
    expect(run.summary.complete).toBe(false);
    expect(run.summary.uninspected).toMatchObject({ count: 1, paths: [{ path: `f${GUARD_BUDGETS.maxFiles}.txt`, reason: 'over-file-budget' }] });
  });

  it('guard completeness: a clean, fully inspected guard is complete with a passing title and no incomplete marker', async () => {
    const { feature } = await scenario('gc-clean', { 'notes.txt': 'clean\n' }, []);
    const run = (await call('GET', `${R('gc-clean')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run.summary).toMatchObject({ conclusion: 'success', complete: true });
    expect(run.summary.uninspected).toBeUndefined();
    const status = (await call('GET', `${R('gc-clean')}/commits/${feature.sha}/status`, tok.owner)).json;
    expect(status.incomplete).toEqual([]);
  });
});
