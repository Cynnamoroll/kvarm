/**
 * Nexus intent, forecast and overlap routes under /api/v1/repos/:owner/:repo.
 * Thin adapters over services/intents/forecast.ts; the shared authority
 * lookup runs first on every route. Reads follow repo read access; the
 * declaration write needs `write` through an `api`-scope credential.
 *
 *   GET  workspaces/overlap?base=&limit=&cursor=&semantic=
 *   GET  workspaces/:id/intent
 *   POST workspaces/:id/intent        {paths, prefixes?, ttlSeconds?}
 *   GET  forecast?paths=&base=&limit=&cursor=&exclude=&semantic=
 *
 * Mounted before the workspace routes so `workspaces/overlap` is not read
 * as a workspace id.
 */

import { Hono, type Context } from 'hono';
import type { ServiceResult } from '../../repos/service';
import { actorJson, authorizeRoute, denyJson, type App, failJson} from '../api';
import * as svc from '../../services/intents/forecast';

export const intentsApi = new Hono<App>();

async function context(c: Context<App>, need: 'read' | 'write') {
  const d = await authorizeRoute(c, need);
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.IntentContext = { env: c.env, repo: d.repo, actor: d.actor };
  return { cx } as const;
}

function reply<T>(c: Context<App>, r: ServiceResult<T>): Response {
  return r.ok ? actorJson(c, r.value) : failJson(c, r);
}

intentsApi.get('/repos/:owner/:repo/workspaces/overlap', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await svc.overlap(rd.cx, { base: c.req.query('base'), limit: c.req.query('limit'), cursor: c.req.query('cursor'), semantic: c.req.query('semantic') }));
});

intentsApi.get('/repos/:owner/:repo/workspaces/:id/intent', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await svc.getIntent(rd.cx, c.req.param('id')));
});

intentsApi.post('/repos/:owner/:repo/workspaces/:id/intent', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  return reply(c, await svc.declareIntent(w.cx, c.req.param('id'), body));
});

intentsApi.get('/repos/:owner/:repo/forecast', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(
    c,
    await svc.forecast(rd.cx, {
      paths: c.req.queries('paths'),
      base: c.req.query('base'),
      limit: c.req.query('limit'),
      cursor: c.req.query('cursor'),
      exclude: c.req.query('exclude'),
      semantic: c.req.query('semantic'),
    }),
  );
});
