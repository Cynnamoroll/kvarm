/**
 * The signed-in dashboard's Nexus field (services/nexusField.ts): live
 * declared paths and intents from the viewer's repositories, drawn in the
 * landing field's layout, and an explanatory empty state.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import { areaOf } from '../src/services/nexusField';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { call } from './helpers/http';
import { FakeWorkflow, seedRepoWithCommit, seedUser } from './helpers/seed';

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  WORKOS_CLIENT_ID: 'client_fake',
  WORKOS_API_KEY: 'sk_fake_not_a_real_key',
  WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
} as Env;

beforeAll(() => installFakeGitRemote());
afterAll(() => restoreFetch());

async function signedIn(login: string): Promise<{ cookie: string; token: string }> {
  const id = await seedUser(env, login);
  const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Parameters<typeof toUserRow>[0]>();
  const payload = newSessionPayload(toUserRow(row!), {
    user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
    refreshToken: 'rt_unused',
    sessionId: null,
  });
  const cookie = (await sessionCookie(env, payload)).split(';')[0]!;
  const { token } = await mintPAT(env, id, 'nexus-test', ['read', 'write', 'api']);
  return { cookie, token };
}

const dashboard = (cookie: string) => call(env, 'GET', '/', { headers: { cookie, accept: 'text/html' } });

describe('areaOf', () => {
  it('groups paths by their two leading directories', () => {
    expect(areaOf('packages/zod/src/v4/classic/tests/x.ts')).toBe('packages/zod/');
    expect(areaOf('packages/zod/src/v4/')).toBe('packages/zod/');
    expect(areaOf('src/app.ts')).toBe('src/');
    expect(areaOf('docs/')).toBe('docs/');
    expect(areaOf('README.md')).toBe('README.md');
  });
});

describe('dashboard Nexus field', () => {
  it('explains the field when no agent workspace is active', async () => {
    const { cookie } = await signedIn('nexus-empty');
    await seedRepoWithCommit(env, 'quiet', { owner: 'nexus-empty', visibility: 'private' });
    const res = await dashboard(cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="panel m-agent k-nexus"');
    expect(res.text).toContain('No active agent workspaces in your repositories yet.');
  });

  it('draws declared areas and intents from the viewer’s repositories', async () => {
    const login = 'nexus-live';
    const { cookie, token } = await signedIn(login);
    await seedRepoWithCommit(env, 'zodlike', { owner: login, visibility: 'public', files: { 'README.md': 'r\n', 'packages/zod/src/index.ts': 'x\n' } });
    const ws = (task: string, agent: string, paths: string[]) =>
      call(env, 'POST', `/api/v1/repos/${login}/zodlike/workspaces`, { token, body: { task, agent, intent: { paths } } });
    expect((await ws('Widen z.iso.datetime offset coverage', 'atlas', ['packages/zod/src/v4/classic/tests/'])).status).toBe(201);
    expect((await ws('Compare z.record() strictness', 'kestrel', ['packages/zod/src/v4/classic/'])).status).toBe(201);
    expect((await ws('Draft migration notes', 'kestrel', ['docs/'])).status).toBe(201);

    const res = await dashboard(cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Nexus · field');
    expect(res.text).toContain('3 active workspaces');
    // Both agents declared under packages/zod/, so it is the largest, multi-agent tile.
    expect(res.text).toMatch(/<a class="t t-xl k2" href="\/nexus-live\/zodlike\/activity"><b>packages\/zod\/<\/b><span>atlas, kestrel · declared paths<\/span><\/a>/);
    expect(res.text).toContain('<b>docs/</b>');
    expect(res.text).toContain('Widen z.iso.datetime offset coverage');
    expect(res.text).toContain('packages/zod/src/v4/classic/tests/ · atlas');
    expect(res.text).toContain('No overlapping workspaces reported.');
  });

  it('never lists another account’s workspaces', async () => {
    const { cookie } = await signedIn('nexus-other');
    const res = await dashboard(cookie);
    expect(res.text).not.toContain('Widen z.iso.datetime offset coverage');
    expect(res.text).toContain('No active agent workspaces in your repositories yet.');
  });
});
