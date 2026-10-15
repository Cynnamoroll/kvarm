/**
 * Compare and diff routes under /api/v1/repos/:owner/:repo. Thin adapters
 * over services/compare.ts. The shared authority lookup runs before any
 * cache read or Artifacts work; private repos stay concealed (404) from
 * callers who cannot read them.
 *
 *   GET compare/:base...:head            changed files between two commit-ishes
 *   GET compare/:base...:head/file?path= one file's hunks
 *   GET commits/:sha/diff                parent...sha (empty tree for a root commit)
 *
 * Ref names may contain "/", so the range is the rest of the path. Ref names
 * can never contain "..", so the first "..." splits it unambiguously.
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson} from '../api';
import * as svc from '../../services/compare';

export const compareApi = new Hono<App>();

const COMPARE_PREFIX = /^\/api\/v1\/repos\/[^/]+\/[^/]+\/compare\/(.+)$/;

function parseRange(raw: string): { base: string; head: string; file: boolean } | null {
  let rest: string;
  try {
    rest = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const split = rest.indexOf('...');
  if (split <= 0) return null;
  const base = rest.slice(0, split);
  let head = rest.slice(split + 3);
  let file = false;
  if (head.endsWith('/file')) {
    head = head.slice(0, -'/file'.length);
    file = true;
  }
  if (head.length === 0) return null;
  return { base, head, file };
}

function withCacheHeader(res: Response, cache: svc.CacheOutcome, timer?: svc.PhaseTimer): Response {
  res.headers.set('x-kvarm-cache', cache);
  if (timer) res.headers.set('server-timing', timer.header());
  return res;
}

async function compareContext(c: Context<App>) {
  const timer = new svc.PhaseTimer();
  const d = await authorizeRoute(c, 'read');
  timer.mark('auth');
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  // Only a human instance admin may force a cold compute; anyone else's
  // nocache is ignored and served normally.
  const admin = d.actor !== null && !d.actor.agent && d.actor.user.is_admin === true;
  const req: svc.CompareRequest = {
    env: c.env,
    repo: d.repo,
    bypass: admin && c.req.query('nocache') === '1',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
    timer,
  };
  return { req } as const;
}

compareApi.get('/repos/:owner/:repo/compare/*', async (c, next) => {
  const m = COMPARE_PREFIX.exec(new URL(c.req.url).pathname);
  const range = m ? parseRange(m[1]!) : null;
  const path = c.req.query('path');
  // A path without "base...head" is not a compare route.
  if (!range) return next();
  if (range.file && path === undefined) {
    // "/file" without ?path= is a ref name that happens to end in "/file".
    range.head = `${range.head}/file`;
    range.file = false;
  }

  const ctx = await compareContext(c);
  if ('denied' in ctx) return ctx.denied;

  if (range.file) {
    if (!path) return c.json({ error: 'path is required', code: 'INVALID_PATH' }, 400);
    const res = await svc.fileDiff(ctx.req, range.base, range.head, path);
    if (!res.ok) return failJson(c, res);
    return withCacheHeader(actorJson(c, res.value.response), res.value.cache, ctx.req.timer);
  }

  const res = await svc.compare(ctx.req, range.base, range.head, {
    order: c.req.query('order'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!res.ok) return failJson(c, res);
  return withCacheHeader(actorJson(c, res.value.response), res.value.cache, ctx.req.timer);
});

compareApi.get('/repos/:owner/:repo/commits/:sha/diff', async (c) => {
  const ctx = await compareContext(c);
  if ('denied' in ctx) return ctx.denied;
  const res = await svc.commitDiff(ctx.req, c.req.param('sha'), {
    order: c.req.query('order'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!res.ok) return failJson(c, res);
  return withCacheHeader(actorJson(c, res.value.response), res.value.cache, ctx.req.timer);
});
