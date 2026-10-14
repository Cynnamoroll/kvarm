/**
 * Pinned dependency routes under /api/v1/repos/:owner/:repo. Thin adapters
 * over services/dependencies.ts; the shared authority lookup runs first on
 * every route. Reads follow repo read access; writes need the `write` role
 * through an `api`-scope credential (agent tokens only on their own
 * workspaces).
 *
 *   POST   workspaces/:id/dependencies              {onWorkspace, revision} → 201 edge
 *   GET    workspaces/:id/dependencies              → {dependencies}
 *   POST   workspaces/:id/dependencies/:dep/repin   {revision, onWorkspace?} → edge
 *   DELETE workspaces/:id/dependencies/:dep         → {detached, dependency}
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import * as svc from '../../services/dependencies';
import type { WorkspaceContext } from '../../services/workspaces';

export const dependenciesApi = new Hono<App>();

async function context(c: Context<App>, need: 'read' | 'write') {
  const d = await authorizeRoute(c, need);
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: WorkspaceContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    origin: new URL(c.req.url).origin,
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

const BASE = '/repos/:owner/:repo/workspaces/:id/dependencies';

dependenciesApi.post(BASE, async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  if (body === undefined) return c.json({ error: 'body must be JSON {onWorkspace, revision}', code: 'INVALID_BODY' }, 400);
  const r = await svc.createDependency(w.cx, c.req.param('id'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

dependenciesApi.get(BASE, async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  const r = await svc.listDependencies(c.env, rd.cx.repo.id, c.req.param('id'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

dependenciesApi.post(`${BASE}/:dep/repin`, async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  if (body === undefined) return c.json({ error: 'body must be JSON {revision, onWorkspace?}', code: 'INVALID_BODY' }, 400);
  const r = await svc.repinDependency(w.cx, c.req.param('id'), c.req.param('dep'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

dependenciesApi.delete(`${BASE}/:dep`, async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const r = await svc.detachDependency(w.cx, c.req.param('id'), c.req.param('dep'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
