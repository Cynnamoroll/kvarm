/**
 * Change list and guide-driven review pages through the Worker.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'cp-owner';
const REVIEWER = 'cp-reviewer';
const FULL: Scope[] = ['read', 'write', 'api'];

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
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};
let ownerToken = '';

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedChange(name: string): Promise<{ repo: FakeRepo; head: string }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const repoId = crypto.randomUUID();
  repoIds[name] = repoId;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
  ).bind(repoId, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now()).run();

  const main = await commit(repo, { 'README.md': 'Review me\n', 'src/app.ts': 'export const value = 1;\n' }, [], 'main');
  const head = await commit(repo, {
    'README.md': 'Review this change\n',
    'src/app.ts': 'export const value = 2;\n',
    '.kvarm/review.json': '{"scrutinize":["src/**"]}',
  }, [main.sha], 'change');
  repo.refs.set('refs/heads/main', main.sha);
  repo.refs.set('refs/heads/feature', head.sha);
  const created = await request('POST', `/api/v1/repos/${OWNER}/${name}/changes`, {
    token: ownerToken,
    json: { title: 'Guide-driven change', base: 'main', head: 'feature' },
  });
  expect(created.status).toBe(201);
  const change = await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = 1').bind(repoId).first<{ id: string }>();
  await env.DB.prepare(
    `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, conclusion, created_at)
     VALUES (?, ?, ?, ?, 'example/check', 'success', 'success', ?)`,
  ).bind(crypto.randomUUID(), repoId, change!.id, head.sha, Date.now()).run();
  return { repo, head: head.sha };
}

interface Reply {
  status: number;
  text: string;
  location: string | null;
  json: Record<string, any>;
}

async function request(
  method: string,
  path: string,
  opts: { token?: string; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { method, headers, ...(body ? { body } : {}), redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // HTML response.
  }
  return { status: res.status, text, location: res.headers.get('location'), json };
}

async function browserSession(login: string) {
  const authEnv = {
    ...env,
    WORKOS_CLIENT_ID: 'client_fake',
    WORKOS_API_KEY: 'sk_fake_not_a_real_key',
    WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
  } as Env;
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userIds[login]).first<Parameters<typeof toUserRow>[0]>();
  const payload = newSessionPayload(toUserRow(row!), {
    user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
    refreshToken: 'rt_unused',
    sessionId: null,
  });
  const cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
  const browser = async (path: string, init: RequestInit = {}) => {
    const ctx = createExecutionContext();
    const headers = { cookie, ...(init.headers as Record<string, string> | undefined) };
    const res = await worker.fetch!(
      new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>,
      authEnv,
      ctx,
    );
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    return { status: res.status, text, location: res.headers.get('location') };
  };
  return browser;
}

beforeAll(async () => {
  installFakeGitRemote();
  await seedUser(OWNER);
  await seedUser(REVIEWER);
  ownerToken = (await mintPAT(env, userIds[OWNER]!, 'owner', FULL)).token;
});

afterAll(() => restoreFetch());

describe('change pages', () => {
  it('renders a seeded change in the changes list', async () => {
    await seedChange('list');
    const response = await request('GET', `/${OWNER}/list/changes`);
    expect(response.status).toBe(200);
    expect(response.text).toContain('Guide-driven change');
    expect(response.text).toContain('Needs your review');
    expect(response.text).toContain('passing');
  });

  it('renders guide chapters, tiers, checks and a review form for a signed-in reviewer', async () => {
    await seedChange('detail');
    await env.DB.prepare(
      'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(repoIds.detail, userIds[REVIEWER], 'write', userIds[OWNER], Date.now(), Date.now()).run();

    const browser = await browserSession(REVIEWER);
    const page = await browser(`/${OWNER}/detail/changes/1`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Guide-driven change');
    expect(page.text).toContain('example/check');
    expect(page.text).toContain('Generated guide');
    expect(page.text).toContain('guide-chapter');
    expect(page.text).toContain('<div class="card-title">src/app.ts');
    expect(page.text).toContain('scrutinize');
    expect(page.text).toContain('src');
    expect(page.text).toContain('name="_csrf"');
    expect(page.text).toContain('Request changes');
  });

  it('requires CSRF for a session approve and records the review', async () => {
    await seedChange('csrf');
    await env.DB.prepare(
      'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(repoIds.csrf, userIds[REVIEWER], 'write', userIds[OWNER], Date.now(), Date.now()).run();
    const browser = await browserSession(REVIEWER);
    const path = `/${OWNER}/csrf/changes/1/review`;
    const page = await browser(`/${OWNER}/csrf/changes/1`);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)?.[1];
    expect(csrf).toBeTruthy();
    const headers = { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' };
    const denied = await browser(path, { method: 'POST', headers, body: 'verdict=approve&body=looks+good' });
    expect(denied.status).toBe(403);
    const accepted = await browser(path, {
      method: 'POST',
      headers,
      body: new URLSearchParams({ _csrf: csrf!, verdict: 'approve', body: 'looks good' }).toString(),
    });
    expect(accepted.status).toBe(303);
    expect(await env.DB.prepare('SELECT verdict FROM change_reviews WHERE repo_id = ?').bind(repoIds.csrf).first<{ verdict: string }>())
      .toMatchObject({ verdict: 'approve' });
  });
});
