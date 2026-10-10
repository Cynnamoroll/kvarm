/**
 * Check runs under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/checks.ts; the shared authority lookup runs first on every route.
 * The status read follows repo read access; reporting a run needs the
 * `write` role through a `ci`-scope credential (the `ci` transport).
 *
 *   GET  commits/:sha/status
 *   POST check-runs   {headSha, name, status? | conclusion?, detailsUrl?, required?, summary?}
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as checks from '../../services/checks';
import { guarded, resolveCtx, resumeAfterCheck } from '../../services/changes';
import { withLazyRepo } from '../../artifacts/repo';

export const checksApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

checksApi.get('/repos/:owner/:repo/commits/:sha/status', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await checks.commitStatus(c.env, d.repo, c.req.param('sha'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

checksApi.post('/repos/:owner/:repo/check-runs', async (c) => {
  const d = await authorizeRoute(c, 'write', { requireActor: true, allowAgent: true, transport: 'ci' });
  if (!d.ok) return denyJson(c, d);
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
  const r = await guarded(() =>
    withLazyRepo(c.env, d.repo.artifacts_name, (artifacts) => checks.reportCheckRun(resolveCtx({ env: c.env, repo: d.repo, waitUntil }, artifacts), body)),
  );
  if (!r.ok) return failJson(c, r);
  const change = r.value.change;
  if (change && r.value.run.status !== 'queued' && r.value.run.status !== 'running') {
    waitUntil(resumeAfterCheck(c.env, d.repo.id, change, waitUntil));
  }
  return actorJson(c, { run: r.value.run, change: change ? { number: change.number } : null }, 201);
});

checksApi.patch('/repos/:owner/:repo/check-runs/:id', async (c) => {
  const d = await authorizeRoute(c, 'write', { requireActor: true, allowAgent: true, transport: 'ci' });
  if (!d.ok) return denyJson(c, d);
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await checks.updateCheckRun(c.env, d.repo, c.req.param('id'), body);
  if (!r.ok) return failJson(c, r);
  if (r.value.change && r.value.run.status !== 'queued' && r.value.run.status !== 'running') {
    c.executionCtx.waitUntil(resumeAfterCheck(c.env, d.repo.id, r.value.change, (p) => c.executionCtx.waitUntil(p)));
  }
  return actorJson(c, { run: r.value.run, change: r.value.change ? { number: r.value.change.number } : null });
});
