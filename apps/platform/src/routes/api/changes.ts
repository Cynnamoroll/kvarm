/**
 * Change request routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/changes.ts; the shared authority lookup runs first on every route.
 * Reads follow repo read access (anonymous on public repos); writes need the
 * `write` role through an `api`-scope credential, so anonymous callers get
 * 401 and principals without a write role or scope get 403.
 *
 *   POST  changes                       {title, body?, base, head, mergePolicy?}
 *   GET   changes?state=&limit=&cursor=
 *   GET   changes/:number               detail: rating, mergeability, check runs
 *   PATCH changes/:number               {title?, body?, mergePolicy?, state?: open|closed}
 *   POST  changes/:number/merge
 *   GET   changes/:number/mergeability
 *   GET   changes/:number/checks
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as svc from '../../services/changes';

export const changesApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  const { ok: _ok, status, ...body } = r;
  return c.json(body, status as never);
}

async function readContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.ChangeContext = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p) => c.executionCtx.waitUntil(p) };
  return { cx } as const;
}

async function writeContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'write', { branchRules: true });
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.ChangeContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    branchRules: d.branchRules ?? [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

async function jsonBody(c: Context<App>): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

changesApi.post('/repos/:owner/:repo/changes', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await svc.createChange(w.cx, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

changesApi.get('/repos/:owner/:repo/changes', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.listChanges(c.env, rd.cx.repo, {
    state: c.req.query('state'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/changes/:number', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.getChange(rd.cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.patch('/repos/:owner/:repo/changes/:number', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await svc.updateChange(w.cx, c.req.param('number'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.post('/repos/:owner/:repo/changes/:number/merge', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await svc.mergeChange(w.cx, c.req.param('number'), svc.defaultMergeDeps, await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { ...r.value.change, merge: r.value.merge });
});

changesApi.get('/repos/:owner/:repo/changes/:number/mergeability', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.getMergeability(rd.cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/changes/:number/checks', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.listChangeChecks(c.env, rd.cx.repo, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
