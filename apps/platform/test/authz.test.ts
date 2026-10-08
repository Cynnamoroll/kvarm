import { env as cfEnv, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import type { RepoRow } from '../src/db/repos';
import type { UserRow } from '../src/db/users';
import { authorizeRepo, scopeCeiling, type Actor } from '../src/services/authz';
import { authorizeGitRequest } from '../src/routes/git';

// Worker secrets (WorkOS) are declared on the global Env but absent in tests.
const env = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';

/** Authorization outcome only; allowed requests would otherwise proxy to Artifacts. */
async function gitAccess(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status?: number; text?: string }> {
  const m = new URL(`${ORIGIN}${path}`).pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/(.+)$/)!;
  const res = await authorizeGitRequest(env, new Request(`${ORIGIN}${path}`, init), m[1]!, m[2]!, m[3]!);
  if (res.ok) return { ok: true };
  return { ok: false, status: res.response.status, text: await res.response.text() };
}

interface Principal {
  user: UserRow;
  tokens: Record<string, string>;
}

const principals: Record<'owner' | 'stranger' | 'root' | 'ghost', Principal> = {} as never;

async function seedUser(login: string, isAdmin: boolean): Promise<UserRow> {
  const user: UserRow = {
    id: crypto.randomUUID(),
    workos_user_id: `test:${login}`,
    login,
    email: `${login}@forge.invalid`,
    name: login,
    avatar_url: null,
    is_admin: isAdmin,
    created_at: Date.now(),
  };
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(user.id, user.workos_user_id, login, user.email, login, isAdmin ? 1 : 0, user.created_at)
    .run();
  return user;
}

async function seedRepo(owner: string, name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(
      crypto.randomUUID(),
      owner,
      name,
      `${owner}--${name}`,
      `https://artifacts.invalid/git/default/${owner}--${name}.git`,
      visibility,
      Date.now(),
    )
    .run();
}

async function tokens(user: UserRow, sets: Record<string, Scope[]>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, scopes] of Object.entries(sets)) {
    out[key] = (await mintPAT(env, user.id, key, scopes)).token;
  }
  return out;
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

const FULL: Scope[] = ['read', 'write', 'api'];
const RECEIVE_BODY = '0000';

beforeAll(async () => {
  const owner = await seedUser('authz-owner', false);
  const stranger = await seedUser('authz-stranger', false);
  const root = await seedUser('authz-root', true);
  const ghost = await seedUser('authz-expired', false);
  principals.owner = {
    user: owner,
    tokens: await tokens(owner, { full: FULL, readOnly: ['read'], apiOnly: ['api'] }),
  };
  principals.stranger = { user: stranger, tokens: await tokens(stranger, { full: [...FULL, 'ci'] }) };
  principals.root = { user: root, tokens: await tokens(root, { full: FULL }) };
  principals.ghost = { user: ghost, tokens: await tokens(ghost, { full: FULL }) };
  await env.DB.prepare('UPDATE pat SET expires_at = ? WHERE user_id = ?').bind(Date.now() - 1000, ghost.id).run();
  await seedRepo('authz-owner', 'secret', 'private');
  await seedRepo('authz-owner', 'open', 'public');
});

function actor(p: Principal, scopes: Scope[]): Actor {
  return { user: p.user, via: 'pat', patId: 'pat', scopes };
}

function repoRow(visibility: 'public' | 'private'): RepoRow {
  return {
    id: 'r',
    owner_login: 'authz-owner',
    name: 'x',
    artifacts_name: 'x',
    artifacts_remote: 'https://artifacts.invalid/x',
    visibility,
    default_branch: 'main',
    description: null,
    fork_parent_id: null,
    stars: 0,
    created_at: 0,
    pushed_at: null,
  };
}

describe('authorizeRepo policy', () => {
  it('conceals private repos from unrelated principals on every transport', async () => {
    for (const transport of ['git', 'api', 'page'] as const) {
      for (const need of ['read', 'write', 'admin'] as const) {
        const d = await authorizeRepo(env, repoRow('private'), actor(principals.stranger, ['read', 'write', 'api', 'ci']), need, transport);
        expect(d).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
      }
    }
  });

  it('treats a missing repo exactly like a concealed private repo', async () => {
    const s = actor(principals.stranger, FULL);
    const missing = await authorizeRepo(env, null, s, 'read', 'git');
    const hidden = await authorizeRepo(env, repoRow('private'), s, 'read', 'git');
    expect(missing).toEqual(hidden);
    expect(await authorizeRepo(env, null, null, 'read', 'git')).toEqual(
      await authorizeRepo(env, repoRow('private'), null, 'read', 'git'),
    );
  });

  it('grants public read to anyone but never write', async () => {
    const s = actor(principals.stranger, FULL);
    expect(await authorizeRepo(env, repoRow('public'), s, 'read', 'git')).toMatchObject({ ok: true, role: 'read' });
    expect(await authorizeRepo(env, repoRow('public'), null, 'read', 'api')).toMatchObject({ ok: true, role: 'read' });
    expect(await authorizeRepo(env, repoRow('public'), s, 'write', 'git')).toMatchObject({ ok: false, status: 403, code: 'FORBIDDEN' });
    expect(await authorizeRepo(env, repoRow('public'), null, 'write', 'git')).toMatchObject({ ok: false, status: 401 });
  });

  it('intersects the owner role with the token scope ceiling', async () => {
    const o = principals.owner;
    expect(await authorizeRepo(env, repoRow('private'), actor(o, FULL), 'write', 'git')).toMatchObject({ ok: true, role: 'write' });
    expect(await authorizeRepo(env, repoRow('private'), actor(o, ['read']), 'read', 'git')).toMatchObject({ ok: true });
    expect(await authorizeRepo(env, repoRow('private'), actor(o, ['read']), 'write', 'git')).toMatchObject({ ok: false, status: 403, code: 'INSUFFICIENT_SCOPE' });
    expect(await authorizeRepo(env, repoRow('private'), actor(o, ['api']), 'read', 'git')).toMatchObject({ ok: false, status: 403, code: 'INSUFFICIENT_SCOPE' });
    expect(await authorizeRepo(env, repoRow('private'), actor(o, ['api']), 'admin', 'api')).toMatchObject({ ok: true, role: 'admin' });
    expect(scopeCeiling(null, 'git')).toBe('admin');
    expect(scopeCeiling(['ci'], 'git')).toBe('none');
  });

  it('keeps the instance admin as an explicit operations role', async () => {
    expect(await authorizeRepo(env, repoRow('private'), actor(principals.root, FULL), 'admin', 'api')).toMatchObject({ ok: true, role: 'admin' });
  });
});

describe('git gate', () => {
  const upload = '/authz-owner/secret.git/info/refs?service=git-upload-pack';
  const receiveAdv = '/authz-owner/secret.git/info/refs?service=git-receive-pack';
  const receive = '/authz-owner/secret.git/git-receive-pack';

  it('denies an unrelated principal clone, advertisement and push of a private repo as not found', async () => {
    const t = principals.stranger.tokens.full!;
    const missing = await call('/authz-owner/no-such-repo.git/info/refs?service=git-upload-pack', { headers: basic(t) });
    const missingBody = await missing.text();
    for (const [path, method] of [
      [upload, 'GET'],
      [receiveAdv, 'GET'],
      ['/authz-owner/secret.git/git-upload-pack', 'POST'],
      [receive, 'POST'],
      ['/authz-owner/secret/HEAD', 'GET'],
    ] as const) {
      const res = await call(path, {
        method,
        headers: { ...basic(t), 'content-type': 'application/x-git-receive-pack-request' },
        body: method === 'POST' ? RECEIVE_BODY : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.text()).toBe(missingBody);
    }
    expect(missing.status).toBe(404);
  });

  it('challenges anonymous callers identically for private and missing repos', async () => {
    const priv = await call(upload);
    const missing = await call('/authz-owner/no-such-repo.git/info/refs?service=git-upload-pack');
    expect(priv.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(priv.headers.get('www-authenticate')).toBe(missing.headers.get('www-authenticate'));
    const push = await call('/authz-owner/open.git/git-receive-pack', { method: 'POST', body: RECEIVE_BODY });
    expect(push.status).toBe(401);
  });

  it('denies unauthorized pushes to a public repo while keeping public reads', async () => {
    const t = principals.stranger.tokens.full!;
    const push = await call('/authz-owner/open.git/git-receive-pack', { method: 'POST', headers: basic(t), body: RECEIVE_BODY });
    expect(push.status).toBe(403);
    const adv = await call('/authz-owner/open.git/info/refs?service=git-receive-pack', { headers: basic(t) });
    expect(adv.status).toBe(403);
    expect(await gitAccess('/authz-owner/open.git/info/refs?service=git-upload-pack', { headers: basic(t) })).toEqual({ ok: true });
    expect(await gitAccess('/authz-owner/open.git/info/refs?service=git-upload-pack')).toEqual({ ok: true });
    expect(await gitAccess('/authz-owner/open.git/git-upload-pack', { method: 'POST', body: '0000' })).toEqual({ ok: true });
  });

  it('lets the owner and instance admin read and push, bounded by token scope', async () => {
    const { full, readOnly, apiOnly } = principals.owner.tokens;
    for (const path of [upload, receiveAdv]) {
      expect(await gitAccess(path, { headers: basic(full!) }), path).toEqual({ ok: true });
    }
    expect(await gitAccess(receive, { method: 'POST', headers: basic(full!), body: RECEIVE_BODY })).toEqual({ ok: true });
    expect(await gitAccess(receive, { method: 'POST', headers: basic(principals.root.tokens.full!), body: RECEIVE_BODY })).toEqual({ ok: true });
    expect(await gitAccess(upload, { headers: basic(readOnly!) })).toEqual({ ok: true });
    const scoped = await call(receive, { method: 'POST', headers: basic(readOnly!), body: RECEIVE_BODY });
    expect(scoped.status).toBe(403);
    expect(await scoped.text()).toBe('insufficient token scope\n');
    expect((await call(upload, { headers: basic(apiOnly!) })).status).toBe(403);
  });

  it('fails closed for unknown and expired tokens', async () => {
    expect((await call(upload, { headers: basic(`forge_pat_${'0'.repeat(64)}`) })).status).toBe(401);
    expect((await call('/authz-owner/open.git/info/refs?service=git-upload-pack', { headers: basic(principals.ghost.tokens.full!) })).status).toBe(401);
  });
});

describe('REST and pages', () => {
  it('conceals the private repo from an unrelated principal on REST', async () => {
    const h = bearer(principals.stranger.tokens.full!);
    const get = await call('/api/v1/repos/authz-owner/secret', { headers: h });
    expect(get.status).toBe(404);
    const body = await get.text();
    expect(body).not.toContain('secret.git');
    const missing = await call('/api/v1/repos/authz-owner/no-such-repo', { headers: h });
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(body);
    const patch = await call('/api/v1/repos/authz-owner/secret', {
      method: 'PATCH',
      headers: { ...h, 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(patch.status).toBe(404);
    const del = await call('/api/v1/repos/authz-owner/secret', { method: 'DELETE', headers: h });
    expect(del.status).toBe(404);
    const fork = await call('/api/v1/repos/authz-owner/secret/forks', { method: 'POST', headers: h });
    expect(fork.status).toBe(404);
    const row = await env.DB.prepare("SELECT visibility FROM repos WHERE owner_login = 'authz-owner' AND name = 'secret'").first<{ visibility: string }>();
    expect(row?.visibility).toBe('private');
  });

  it('forbids non-admin mutation of a visible public repo', async () => {
    const patch = await call('/api/v1/repos/authz-owner/open', {
      method: 'PATCH',
      headers: { ...bearer(principals.stranger.tokens.full!), 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'pwned' }),
    });
    expect(patch.status).toBe(403);
    expect(await patch.json()).toEqual({ error: 'forbidden', code: 'FORBIDDEN' });
  });

  it('preserves owner and instance-admin REST access', async () => {
    for (const p of [principals.owner, principals.root]) {
      const res = await call('/api/v1/repos/authz-owner/secret', { headers: bearer(p.tokens.full!) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { repo: { name: string; visibility: string } };
      expect(json.repo).toMatchObject({ name: 'secret', visibility: 'private' });
    }
    const patch = await call('/api/v1/repos/authz-owner/secret', {
      method: 'PATCH',
      headers: { ...bearer(principals.owner.tokens.full!), 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'owner edit' }),
    });
    expect(patch.status).toBe(200);
  });

  it('hides the private repo page from anonymous and unrelated viewers', async () => {
    for (const path of ['/authz-owner/secret', '/authz-owner/secret/tree/main', '/authz-owner/secret/settings']) {
      const anon = await call(path);
      expect(anon.status, path).toBe(404);
      const stranger = await call(path, { headers: bearer(principals.stranger.tokens.full!) });
      expect(stranger.status, path).toBe(404);
    }
  });
});

describe('GET /api/v1/user', () => {
  it('returns isAdmin as a boolean for admin and non-admin principals', async () => {
    const admin = (await (await call('/api/v1/user', { headers: bearer(principals.root.tokens.full!) })).json()) as { user: { isAdmin: unknown } };
    const user = (await (await call('/api/v1/user', { headers: bearer(principals.stranger.tokens.full!) })).json()) as { user: { isAdmin: unknown } };
    expect(admin.user.isAdmin).toBe(true);
    expect(user.user.isAdmin).toBe(false);
  });
});
