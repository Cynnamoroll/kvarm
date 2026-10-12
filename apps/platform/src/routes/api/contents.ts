/**
 * Tree listings and file reads under /api/v1/repos/:owner/:repo. Thin
 * adapters over services/contents.ts; the shared authority lookup runs
 * before any Artifacts or cache work, and private repos stay concealed.
 *
 *   GET tree?ref=&path=       directory entries at a ref (git ls-tree shape)
 *   GET contents?path=&ref=   one file at a ref (utf-8 or base64)
 */

import { Hono } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import * as svc from '../../services/contents';

export const contentsApi = new Hono<App>();

contentsApi.get('/repos/:owner/:repo/tree', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await svc.readTreeView(c.env, d.repo, c.req.query('ref') || d.repo.default_branch, c.req.query('path') ?? '');
  if (!r.ok) return c.json({ error: r.error, code: r.code }, r.status as never);
  return actorJson(c, r.value);
});

contentsApi.get('/repos/:owner/:repo/contents', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const ref = c.req.query('ref') || d.repo.default_branch;
  const r = await svc.readFileView(c.env, c.executionCtx, d.repo, ref, c.req.query('path') ?? '');
  if (!r.ok) return c.json({ error: r.error, code: r.code }, r.status as never);
  return actorJson(c, r.value);
});
