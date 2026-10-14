/**
 * Path history under /api/v1/repos/:owner/:repo. A thin adapter over
 * services/history.ts: the shared authority decides first; the service then
 * answers from the D1 index and advances it by at most one bounded step.
 *
 *   GET history?path=&limit=&cursor=   commits on the default branch that changed a path
 */

import { Hono } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import { pathHistory } from '../../services/history';

export const historyApi = new Hono<App>();

historyApi.get('/repos/:owner/:repo/history', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await pathHistory(c.env, (p) => c.executionCtx.waitUntil(p), d.repo, {
    path: c.req.query('path'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return c.json({ error: r.error, code: r.code }, r.status as never);
  return actorJson(c, r.value);
});
