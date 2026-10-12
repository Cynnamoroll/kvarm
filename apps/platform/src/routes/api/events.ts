/**
 * Push event log under /api/v1/repos/:owner/:repo. A thin adapter over
 * services/events.ts: the shared authority decides first, then one bounded
 * page query runs.
 */

import { Hono } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import { listPushEvents } from '../../services/events';

export const eventsApi = new Hono<App>();

eventsApi.get('/repos/:owner/:repo/events', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const res = await listPushEvents(c.env, d.repo.id, { limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status as never);
  return actorJson(c, res.value);
});
