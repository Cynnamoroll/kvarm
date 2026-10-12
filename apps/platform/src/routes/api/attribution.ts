/**
 * Attribution and decision context under /api/v1/repos/:owner/:repo. Thin
 * adapters over services/attribution.ts and services/decisions.ts; the shared
 * authority lookup runs first on every route. Reads follow repo read access;
 * writes need the `write` role through an `api`-scope credential (agent
 * tokens included).
 *
 *   POST commits/:sha/attribution  {agent, session, promptHash, model?}
 *   GET  commits/:sha/attribution
 *   POST decisions                 {task?, paths[], chosen, rejected[], reason}
 *   GET  context?task=&path=&limit=&cursor=
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as attribution from '../../services/attribution';
import * as decisions from '../../services/decisions';

export const attributionApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

async function jsonBody(c: Context<App>): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

const invalidBody = (c: Context<App>) => c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);

attributionApi.post('/repos/:owner/:repo/commits/:sha/attribution', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  if (body === undefined) return invalidBody(c);
  const cx = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
  const r = await attribution.setAttribution(cx, c.req.param('sha'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value.record, r.value.replaced ? 200 : 201);
});

attributionApi.get('/repos/:owner/:repo/commits/:sha/attribution', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const cx = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
  const r = await attribution.getAttribution(cx, c.req.param('sha'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

attributionApi.post('/repos/:owner/:repo/decisions', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  if (body === undefined) return invalidBody(c);
  const r = await decisions.recordDecision({ env: c.env, repo: d.repo, actor: d.actor }, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

attributionApi.get('/repos/:owner/:repo/context', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await decisions.readContext(
    { env: c.env, repo: d.repo, actor: d.actor },
    { task: c.req.query('task'), paths: c.req.queries('path') ?? [], limit: c.req.query('limit'), cursor: c.req.query('cursor') },
  );
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
