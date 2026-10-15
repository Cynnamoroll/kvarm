/**
 * REST API v1. Authenticated via session cookie (browser) or
 * `Authorization: Bearer kvarm_pat_...` with the `api` scope (agents/CLIs).
 * Repo lifecycle goes through src/repos/service.ts.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { listReposForOwner, type RepoRow } from '../db/repos';
import {
  getSessionInfo,
  isSameOriginRequest,
  isUnsafeMethod,
  type SessionInfo,
  type SessionLookup,
} from '../auth/workos';
import { mintPAT, patListStatement, revokePAT, scopesAllow, SCOPES, type PatListRow, type Scope } from '../auth/pat';
import * as svc from '../repos/service';
import type { ServiceResult } from '../repos/service';
import { patActor, type Actor, type RepoNeed } from '../services/authz';
import {
  AGENT_FORBIDDEN,
  resolvePAT,
  resolveRepoAccess,
  type AccessDenied,
  type Credential,
  type RepoAccess,
} from '../services/access';

export type App = {
  Bindings: Env;
  Variables: { refreshCookies: string[]; sessionLookup: SessionLookup };
};
export const api = new Hono<App>();

export type ApiActor = Actor;

export function clientIp(c: Context<App>): string | null {
  return c.req.header('CF-Connecting-IP') ?? null;
}

/** The canonical 401 body: {error, code}. Anonymous callers get this before any 403. */
export function unauthJson(c: Context<App>): Response {
  return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
}

/**
 * Empty bodies read as {}, while malformed JSON and non-object values throw
 * an HTTPException that Hono turns into its response, including nested MCP
 * dispatches that re-enter app.fetch.
 */
export async function jsonBody(c: Context<App>): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new HTTPException(400, {
      res: c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400),
    });
  }
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>;
  throw new HTTPException(400, {
    res: c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400),
  });
}

/** A ServiceResult failure as its API response: {error, code} plus any extra fields the failure carries. */
export function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  const { ok: _ok, status, ...body } = r;
  return c.json(body, status as never);
}

/**
 * The browser session for this request, resolved once: a WorkOS refresh
 * rotates the refresh token, so a second lookup in the same request would
 * redeem a spent one. Cookies it sets are persisted by persistSessionCookies.
 */
export async function requestSession(c: Context<App>): Promise<SessionInfo | null> {
  let lookup = c.get('sessionLookup');
  if (!lookup) {
    lookup = await getSessionInfo(c.req.raw, c.env);
    c.set('sessionLookup', lookup);
    if (lookup.setCookies.length > 0) c.set('refreshCookies', lookup.setCookies);
  }
  return lookup.session;
}

/** Appends the session's Set-Cookie values to whatever response the route produced. */
export const persistSessionCookies: MiddlewareHandler = async (c, next) => {
  await next();
  // Routes that still append the cookies themselves are not doubled.
  const present = new Set(c.res.headers.getSetCookie());
  const cookies = ((c.get('refreshCookies') as string[] | undefined) ?? []).filter((cookie) => !present.has(cookie));
  if (cookies.length === 0) return;
  try {
    for (const cookie of cookies) c.res.headers.append('Set-Cookie', cookie);
  } catch {
    const res = new Response(c.res.body, c.res);
    for (const cookie of cookies) res.headers.append('Set-Cookie', cookie);
    // Hono's res setter merges the previous response's Set-Cookie headers
    // over the new one; clearing first keeps the appended cookies.
    c.res = undefined as unknown as Response;
    c.res = res;
  }
};

/**
 * The presented credential, unverified: session cookie first (its user row is
 * read fresh from D1), then Bearer PAT. A session never authorizes a
 * state-changing request from another origin; such a request falls through
 * to its Bearer token or acts anonymously. PATs are verified by
 * services/access.ts.
 */
export async function requestCredential(c: Context<App>): Promise<Credential> {
  const session = await requestSession(c);
  if (session && (!isUnsafeMethod(c.req.method) || isSameOriginRequest(c.req.raw, c.env))) {
    return { kind: 'session', actor: { user: session.user, via: 'session', scopes: null } };
  }
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) {
    return { kind: 'pat', token: header.slice('Bearer '.length).trim() };
  }
  return { kind: 'anonymous' };
}

type ActorResult = { ok: true; actor: ApiActor | null } | AccessDenied;

/**
 * Resolves the human API actor with authoritative PAT verification. Non-api
 * PATs act as anonymous; unknown, revoked or expired PATs are rejected.
 * Agent tokens are refused here: account-level routes (user, tokens, orgs,
 * repo creation, agent credentials) are human-only, and agents reach repo
 * routes only through authorizeRoute.
 */
export async function apiActor(c: Context<App>): Promise<ActorResult> {
  const cred = await requestCredential(c);
  if (cred.kind === 'anonymous') return { ok: true, actor: null };
  if (cred.kind === 'session') return { ok: true, actor: cred.actor };
  const res = await resolvePAT(c.env, cred.token, clientIp(c));
  if (!res.ok) return res;
  if (res.pat.agent) return AGENT_FORBIDDEN;
  return { ok: true, actor: scopesAllow(res.pat.scopes, 'api') ? patActor(res.pat) : null };
}

/** JSON response; refreshed session cookies are added by persistSessionCookies. */
export function actorJson(c: Context<App>, data: unknown, status = 200): Response {
  return c.json(data, status as never);
}

/** Resolves the caller and :owner/:repo, then applies the shared repository policy. */
export async function authorizeRoute(
  c: Context<App>,
  need: RepoNeed,
  opts: { requireActor?: boolean; allowAgent?: boolean; branchRules?: boolean; transport?: 'api' | 'ci' } = {},
): Promise<RepoAccess> {
  return resolveRepoAccess(c.env, {
    owner: c.req.param('owner') ?? '',
    name: c.req.param('repo') ?? '',
    need,
    transport: opts.transport ?? 'api',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    requireActor: opts.requireActor,
    allowAgent: opts.allowAgent,
    branchRules: opts.branchRules,
  });
}

export function denyJson(c: Context<App>, d: AccessDenied): Response {
  if (d.status === 429) {
    return c.json({ error: d.error, code: d.code }, 429, { 'Retry-After': '60' });
  }
  return c.json({ error: d.error, code: d.code }, d.status);
}

export async function requireActor(c: Context<App>): Promise<ApiActor | Response> {
  const res = await apiActor(c);
  if (!res.ok) return denyJson(c, res);
  if (!res.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  return res.actor;
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
      isAdmin: actor.user.is_admin === true,
    },
    via: actor.via,
  });
});

api.get('/user/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  if (actor.via !== 'session') return c.json({ error: 'manage tokens from the web session', code: 'SESSION_REQUIRED' }, 403);
  const { results } = await patListStatement(c.env.DB, actor.user.id).all<PatListRow>();
  return actorJson(c, {
    tokens: (results ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      prefix: t.prefix,
      scopes: JSON.parse(t.scopes) as string[],
      createdAt: new Date(t.created_at).toISOString(),
      lastUsedAt: t.last_used_at === null ? null : new Date(t.last_used_at).toISOString(),
    })),
  });
});

api.post('/user/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  if (actor.via !== 'session') return c.json({ error: 'manage tokens from the web session', code: 'SESSION_REQUIRED' }, 403);
  const body = await jsonBody(c);
  if (typeof body.name !== 'string' || !Array.isArray(body.scopes)) {
    return c.json({ error: 'body must be a JSON object {name, scopes}', code: 'INVALID_BODY' }, 400);
  }
  const name = body.name.slice(0, 100);
  const scopes = body.scopes.filter((s): s is Scope => SCOPES.includes(s as Scope));
  if (scopes.length === 0) return c.json({ error: 'no valid scopes', code: 'INVALID_SCOPES' }, 400);
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
  if (actor.via !== 'session') return c.json({ error: 'manage tokens from the web session', code: 'SESSION_REQUIRED' }, 403);
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
  const body = (await jsonBody(c)) as {
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
  if (!result.ok) return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status as never);
  return c.json({ repo: repoJson(c, result.value) }, 201);
});

api.post('/import', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = (await jsonBody(c)) as {
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
  if (!result.ok) return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status as never);
  return c.json({ repo: repoJson(c, result.value), status: 'importing' }, 201);
});

api.get('/repos/:owner/:repo', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  return c.json({ repo: repoJson(c, d.repo) });
});

api.patch('/repos/:owner/:repo', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const repo = d.repo;
  const body = (await jsonBody(c)) as {
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
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const result = await svc.deleteRepo(c.env, d.repo);
  if (!result.ok) return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status as never);
  return c.json({ deleted: true });
});

api.post('/repos/:owner/:repo/forks', async (c) => {
  const d = await authorizeRoute(c, 'read', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  const repo = d.repo;
  const body = (await jsonBody(c)) as { name?: string };
  const result = await svc.forkRepo(c.env, repo, d.actor.user.login, body.name ?? `${repo.name}-fork`);
  if (!result.ok) return c.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, result.status as never);
  return c.json({ repo: repoJson(c, result.value) }, 201);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function repoJson(c: Context<App>, r: RepoRow) {
  return {
    id: r.id,
    owner: r.owner_login,
    name: r.name,
    visibility: r.visibility,
    defaultBranch: r.default_branch,
    description: r.description,
    stars: r.stars,
    createdAt: new Date(r.created_at).toISOString(),
    pushedAt: r.pushed_at === null ? null : new Date(r.pushed_at).toISOString(),
    cloneUrl: `${new URL(c.req.url).origin}/${r.owner_login}/${r.name}.git`,
  };
}
