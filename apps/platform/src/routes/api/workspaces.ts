/**
 * Agent workspace routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/workspaces.ts; the shared authority lookup runs first on every
 * route. Reads follow repo read access; writes need the `write` role through
 * an `api`-scope credential (agent tokens included, bound to their own
 * workspaces by the service).
 *
 *   POST workspaces                    {task, agent?, base?}
 *   GET  workspaces?status=&limit=&cursor=
 *   GET  workspaces/:id
 *   POST workspaces/:id/change-set     {title, body?, base?, mergePolicy?}
 *   POST workspaces/:id/abandon
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as svc from '../../services/workspaces';

export const workspacesApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  const { ok: _ok, status, ...body } = r;
  return c.json(body, status as never);
}

async function context(c: Context<App>, need: 'read' | 'write') {
  const d = await authorizeRoute(c, need, need === 'write' ? { branchRules: true } : {});
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.WorkspaceContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    origin: new URL(c.req.url).origin,
    branchRules: d.branchRules ?? [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

async function jsonBody(c: Context<App>): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

workspacesApi.post('/repos/:owner/:repo/workspaces', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await svc.createWorkspace(w.cx, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

workspacesApi.get('/repos/:owner/:repo/workspaces', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  const r = await svc.listWorkspaces(c.env, rd.cx.repo, rd.cx.origin, {
    status: c.req.query('status'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

workspacesApi.get('/repos/:owner/:repo/workspaces/:id', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  const r = await svc.getWorkspace(rd.cx, c.req.param('id'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

workspacesApi.post('/repos/:owner/:repo/workspaces/:id/change-set', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await svc.openChangeSet(w.cx, c.req.param('id'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

workspacesApi.post('/repos/:owner/:repo/workspaces/:id/abandon', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const r = await svc.abandonWorkspace(w.cx, c.req.param('id'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
