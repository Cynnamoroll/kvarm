/**
 * REST API v1. Authenticated via session cookie (browser) or
 * `Authorization: Bearer forge_pat_...` with the `api` scope (agents/CLIs).
 * Repo lifecycle goes through src/repos/service.ts.
 */

import { Hono, type Context } from 'hono';
import { getRepo, listReposForOwner, type RepoRow } from '../db/repos';
import { findOrCreateUser, getUserById, type UserRow } from '../db/users';
import { getSessionInfo, type SessionInfo } from '../auth/workos';
import { mintPAT, revokePAT, scopesAllow, verifyPAT, type Scope } from '../auth/pat';
import * as svc from '../repos/service';

type App = { Bindings: Env; Variables: { refreshCookies: string[] } };
export const api = new Hono<App>();

const SCOPES: Scope[] = ['read', 'write', 'api', 'ci'];

export interface ApiActor {
  user: UserRow;
  via: 'session' | 'pat';
  patId?: string;
}

/** Resolves the API actor: session cookie first, then Bearer PAT. */
export async function apiActor(c: Context<App>): Promise<ApiActor | null> {
  const session: SessionInfo | null = await getSessionInfo(c.req.raw, c.env);
  if (session) {
    const user = await findOrCreateUser(c.env, session.user);
    if (session.refreshCookies.length > 0) {
      c.set('refreshCookies', session.refreshCookies);
    }
    return { user, via: 'session' };
  }
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    const pat = await verifyPAT(c.env, header.slice('Bearer '.length).trim());
    if (pat && scopesAllow(pat.scopes, 'api')) {
      const user = await getUserById(c.env.DB, pat.userId);
      if (user) return { user, via: 'pat', patId: pat.id };
    }
  }
  return null;
}

/** JSON response that persists refreshed session cookies when present. */
export function actorJson(c: Context<App>, data: unknown, status = 200): Response {
  const res = c.json(data, status as never);
  for (const cookie of c.get('refreshCookies') ?? []) {
    res.headers.append('Set-Cookie', cookie);
  }
  return res;
}

function canRead(repo: RepoRow, actor: ApiActor | null): boolean {
  if (repo.visibility === 'public') return true;
  return actor !== null && (actor.user.login === repo.owner_login || actor.user.is_admin);
}

function canWrite(repo: RepoRow, actor: ApiActor | null): boolean {
  return actor !== null && (actor.user.login === repo.owner_login || actor.user.is_admin);
}

function requireActor(c: Context<App>): Promise<ApiActor | Response> | never;
async function requireActor(c: Context<App>): Promise<ApiActor | Response> {
  const actor = await apiActor(c);
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  return actor;
}

// ---------------------------------------------------------------------------
// Current user + PATs
// ---------------------------------------------------------------------------

api.get('/user', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  return actorJson(c, {
    user: {
      id: actor.user.id,
      login: actor.user.login,
      email: actor.user.email,
      name: actor.user.name,
      isAdmin: actor.user.is_admin,
    },
    via: actor.via,
  });
});

api.get('/user/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  if (actor.via !== 'session') return c.json({ error: 'manage tokens from the web session' }, 403);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, prefix, scopes, created_at, last_used_at FROM pat WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(actor.user.id)
    .all<{
      id: string;
      name: string;
      prefix: string;
      scopes: string;
      created_at: number;
      last_used_at: number | null;
    }>();
  return actorJson(c, {
    tokens: (results ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: JSON.parse(t.scopes) as string[],
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
    })),
  });
});

api.post('/user/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  if (actor.via !== 'session') return c.json({ error: 'manage tokens from the web session' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string; scopes?: string[] };
  const name = (body.name ?? 'token').slice(0, 100);
  const scopes = (body.scopes ?? ['read', 'write', 'api']).filter((s): s is Scope =>
    SCOPES.includes(s as Scope),
  );
  if (scopes.length === 0) return c.json({ error: 'no valid scopes' }, 400);
  const minted = await mintPAT(c.env, actor.user.id, name, scopes);
  return c.json(
    {
      token: minted.token,
      id: minted.id,
      prefix: minted.prefix,
      scopes,
      note: 'store this token now; it is not retrievable later',
    },
    201,
  );
});

api.delete('/user/tokens/:id', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const ok = await revokePAT(c.env, c.req.param('id'), actor.user.id);
  return c.json({ revoked: ok });
});

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

api.get('/repos', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const repos = await listReposForOwner(c.env.DB, actor.user.login);
  return actorJson(c, { repos: repos.map((r) => repoJson(c, r)) });
});

api.post('/repos', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    visibility?: string;
    defaultBranch?: string;
  };
  const result = await svc.createRepo(c.env, {
    ownerLogin: actor.user.login,
    name: body.name ?? '',
    description: body.description ?? null,
    visibility: body.visibility === 'public' ? 'public' : 'private',
    defaultBranch: body.defaultBranch,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as never);
  return c.json({ repo: repoJson(c, result.value) }, 201);
});

api.post('/import', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    name?: string;
    branch?: string;
    visibility?: string;
  };
  const name = body.name ?? (body.url ?? '').split('/').pop() ?? '';
  const result = await svc.importRepo(c.env, {
    ownerLogin: actor.user.login,
    sourceUrl: body.url ?? '',
    name,
    branch: body.branch,
    visibility: body.visibility === 'public' ? 'public' : 'private',
  });
  if (!result.ok) return c.json({ error: result.error }, result.status as never);
  return c.json({ repo: repoJson(c, result.value), status: 'importing' }, 201);
});

api.get('/repos/:owner/:repo', async (c) => {
  const actor = await apiActor(c);
  const repo = await getRepo(c.env.DB, c.req.param('owner'), c.req.param('repo'));
  if (!repo || !canRead(repo, actor)) return c.json({ error: 'not found' }, 404);
  return c.json({ repo: repoJson(c, repo) });
});

api.patch('/repos/:owner/:repo', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const repo = await getRepo(c.env.DB, c.req.param('owner'), c.req.param('repo'));
  if (!repo) return c.json({ error: 'not found' }, 404);
  if (!canWrite(repo, actor)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as {
    description?: string;
    visibility?: string;
  };
  const updated = await svc.updateRepo(c.env, repo, {
    description: body.description,
    visibility: body.visibility === 'public' ? 'public' : body.visibility === 'private' ? 'private' : undefined,
  });
  return c.json({ repo: repoJson(c, updated) });
});

api.delete('/repos/:owner/:repo', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const repo = await getRepo(c.env.DB, c.req.param('owner'), c.req.param('repo'));
  if (!repo) return c.json({ error: 'not found' }, 404);
  if (!canWrite(repo, actor)) return c.json({ error: 'forbidden' }, 403);
  const result = await svc.deleteRepo(c.env, repo);
  if (!result.ok) return c.json({ error: result.error }, result.status as never);
  return c.json({ deleted: true });
});

api.post('/repos/:owner/:repo/forks', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const repo = await getRepo(c.env.DB, c.req.param('owner'), c.req.param('repo'));
  if (!repo || !canRead(repo, actor)) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const result = await svc.forkRepo(c.env, repo, actor.user.login, body.name ?? `${repo.name}-fork`);
  if (!result.ok) return c.json({ error: result.error }, result.status as never);
  return c.json({ repo: repoJson(c, result.value) }, 201);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function repoJson(c: Context<App>, r: RepoRow) {
  return {
    id: r.id,
    owner: r.owner_login,
    name: r.name,
    visibility: r.visibility,
    defaultBranch: r.default_branch,
    description: r.description,
    stars: r.stars,
    createdAt: r.created_at,
    pushedAt: r.pushed_at,
    cloneUrl: `${new URL(c.req.url).origin}/${r.owner_login}/${r.name}.git`,
  };
}
