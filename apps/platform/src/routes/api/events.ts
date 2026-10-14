/**
 * Push event log under /api/v1/repos/:owner/:repo. A thin adapter over
 * services/events.ts: the shared authority decides first, then one bounded
 * page query runs.
 */

import { Hono } from 'hono';
import { actorJson, authorizeRoute, clientIp, denyJson, requestCredential, requestSession, type App } from '../api';
import { listPushEvents } from '../../services/events';
import { resolvePAT } from '../../services/access';

export const eventsApi = new Hono<App>();

eventsApi.get('/repos/:owner/:repo/events', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  if (c.req.query('since') !== undefined) {
    const since = c.req.query('since') ?? '0';
    const stub = c.env.REPO_EVENTS.get(c.env.REPO_EVENTS.idFromName(d.repo.id));
    const response = await stub.fetch(`https://repo-events/since?seq=${encodeURIComponent(since)}`);
    return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  const res = await listPushEvents(c.env, d.repo.id, { limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  if (!res.ok) return c.json({ error: res.error, code: res.code }, res.status as never);
  return actorJson(c, res.value);
});

eventsApi.get('/repos/:owner/:repo/live', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const principal = d.actor?.agent ? `agent:${d.actor.agent.agentId}` : `user:${d.actor?.user.id ?? 'anonymous'}`;
  const id = c.env.REPO_EVENTS.idFromName(d.repo.id);
  const stub = c.env.REPO_EVENTS.get(id);
  const credential = await requestCredential(c);
  let expiresAt = Date.now() + 10 * 60 * 1000;
  if (d.actor?.agent) expiresAt = d.actor.agent.expiresAt;
  else if (credential.kind === 'session') expiresAt = (await requestSession(c))?.expiresAt ?? expiresAt;
  else if (credential.kind === 'pat') {
    const verified = await resolvePAT(c.env, credential.token, clientIp(c));
    if (verified.ok) expiresAt = verified.pat.expiresAt ?? Number.MAX_SAFE_INTEGER;
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-kvarm-principal', principal);
  headers.set('x-kvarm-expires-at', String(expiresAt));
  return stub.fetch(new Request(c.req.raw, { headers }));
});
