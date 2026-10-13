/**
 * Organizations, membership, org repositories and per-repo grants under
 * /api/v1. Thin adapters over services/orgs.ts, services/orgRepos.ts and
 * services/grants.ts; repository decisions use the shared policy.
 */

import { Hono, type Context } from 'hono';
import {
  actorJson,
  apiActor,
  authorizeRoute,
  denyJson,
  repoJson,
  requireActor,
  type App,
} from '../api';
import type { ServiceResult } from '../../repos/service';
import { isOrgRole, isRepoNeed } from '../../services/authz';
import * as orgs from '../../services/orgs';
import * as orgRepos from '../../services/orgRepos';
import * as grants from '../../services/grants';

export const tenancyApi = new Hono<App>();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function orgJson(o: orgs.OrgRow) {
  return { login: o.login, name: o.name, createdAt: iso(o.created_at) };
}

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

function pageParams(c: Context<App>): { cursor?: string; limit?: number } {
  const limit = Number(c.req.query('limit'));
  return { cursor: c.req.query('cursor') || undefined, limit: Number.isFinite(limit) && limit > 0 ? limit : undefined };
}

async function jsonBody<T>(c: Context<App>): Promise<Partial<T>> {
  return ((await c.req.json().catch(() => ({}))) ?? {}) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Organizations and membership
// ---------------------------------------------------------------------------

tenancyApi.post('/orgs', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await jsonBody<{ login: string; name: string }>(c);
  const res = await orgs.createOrg(c.env, actor, {
    login: typeof body.login === 'string' ? body.login : '',
    name: typeof body.name === 'string' ? body.name : null,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { org: orgJson(res.value.org), role: res.value.role }, 201);
});

tenancyApi.get('/user/orgs', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const list = await orgs.listUserOrgs(c.env, actor);
  return actorJson(c, { orgs: list });
});

tenancyApi.get('/orgs/:org', async (c) => {
  const who = await apiActor(c);
  if (!who.ok) return denyJson(c, who);
  const found = await orgs.getOrg(c.env, c.req.param('org'), who.actor);
  if (!found) return c.json({ error: 'organization not found', code: 'NOT_FOUND' }, 404);
  return actorJson(c, { org: orgJson(found.org), viewerRole: found.role });
});

tenancyApi.get('/orgs/:org/members', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await orgs.listMembers(c.env, c.req.param('org'), actor, pageParams(c));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, {
    members: res.value.members.map((m) => ({ ...m, createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt) })),
    nextCursor: res.value.nextCursor,
  });
});

tenancyApi.put('/orgs/:org/members/:login', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await jsonBody<{ role: string }>(c);
  if (!isOrgRole(body.role)) {
    return c.json({ error: 'role must be owner, maintainer or member', code: 'INVALID_ROLE' }, 400);
  }
  const res = await orgs.setMember(c.env, actor, c.req.param('org'), c.req.param('login'), body.role);
  if (!res.ok) return failJson(c, res);
  const m = res.value.member;
  return actorJson(c, { member: { ...m, createdAt: iso(m.createdAt), updatedAt: iso(m.updatedAt) } });
});

tenancyApi.delete('/orgs/:org/members/:login', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await orgs.removeMember(c.env, actor, c.req.param('org'), c.req.param('login'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, res.value);
});

// ---------------------------------------------------------------------------
// Organization repositories
// ---------------------------------------------------------------------------

tenancyApi.get('/orgs/:org/repos', async (c) => {
  const who = await apiActor(c);
  if (!who.ok) return denyJson(c, who);
  const res = await orgRepos.listOrgRepos(c.env, c.req.param('org'), who.actor, pageParams(c));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, {
    org: orgJson(res.value.org),
    viewerRole: res.value.viewerRole,
    repos: res.value.repos.map((r) => repoJson(c, r)),
    nextCursor: res.value.nextCursor,
  });
});

tenancyApi.post('/orgs/:org/repos', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await jsonBody<{ name: string; description: string; visibility: string; defaultBranch: string }>(c);
  const res = await orgRepos.createOrgRepo(c.env, actor, c.req.param('org'), {
    name: typeof body.name === 'string' ? body.name : '',
    description: typeof body.description === 'string' ? body.description : null,
    visibility: body.visibility === 'public' ? 'public' : 'private',
    defaultBranch: typeof body.defaultBranch === 'string' ? body.defaultBranch : undefined,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { repo: repoJson(c, res.value) }, 201);
});

// ---------------------------------------------------------------------------
// Per-repo grants (repo admin)
// ---------------------------------------------------------------------------

tenancyApi.get('/repos/:owner/:repo/grants', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const list = await grants.listGrants(c.env, d.repo);
  return actorJson(c, {
    grants: list.map((g) => ({ ...g, createdAt: iso(g.createdAt), updatedAt: iso(g.updatedAt) })),
  });
});

tenancyApi.put('/repos/:owner/:repo/grants/:login', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  const body = await jsonBody<{ role: string }>(c);
  if (!isRepoNeed(body.role)) {
    return c.json({ error: 'role must be read, write or admin', code: 'INVALID_ROLE' }, 400);
  }
  const res = await grants.setGrant(c.env, d.repo, d.actor, c.req.param('login'), body.role);
  if (!res.ok) return failJson(c, res);
  const g = res.value.grant;
  return actorJson(c, { grant: { ...g, createdAt: iso(g.createdAt), updatedAt: iso(g.updatedAt) } });
});

tenancyApi.delete('/repos/:owner/:repo/grants/:login', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  return actorJson(c, await grants.revokeGrant(c.env, d.repo, c.req.param('login')));
});
