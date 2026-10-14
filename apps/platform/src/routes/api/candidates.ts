/**
 * Candidate, arena and composition routes under /api/v1/repos/:owner/:repo.
 * Thin adapters over services/candidates.ts and services/compositions.ts;
 * the shared authority lookup runs first on every route. Reads follow repo
 * read access; writes need `write` through an `api`-scope credential.
 *
 *   GET  candidates?base=&workspaces=a,b,c
 *   POST candidates/compose            {base?, workspaces: [id | {workspace, paths?}], paths?, title?, mergePolicy?}
 *   GET  compositions?limit=&cursor=
 *   GET  compositions/:id
 *   POST arenas                        {brief, base?, candidates: 2-8, agent?}
 *   GET  arenas?limit=&cursor=
 *   GET  arenas/:id
 *   GET  arenas/:id/candidates
 *   POST arenas/:id/select             {workspace}
 */

import { Hono, type Context } from 'hono';
import type { ServiceResult } from '../../repos/service';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import * as candidates from '../../services/candidates';
import * as compositions from '../../services/compositions';

export const candidatesApi = new Hono<App>();

async function context(c: Context<App>, need: 'read' | 'write') {
  const d = await authorizeRoute(c, need, need === 'write' ? { branchRules: true } : {});
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: candidates.CandidatesContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    origin: new URL(c.req.url).origin,
    branchRules: d.branchRules ?? [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

function reply<T>(c: Context<App>, r: ServiceResult<T>, status: 200 | 201 = 200): Response {
  return r.ok ? actorJson(c, r.value, status) : failJson(c, r);
}

candidatesApi.get('/repos/:owner/:repo/candidates', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await candidates.candidates(rd.cx, { base: c.req.query('base'), workspaces: c.req.query('workspaces') }));
});

candidatesApi.post('/repos/:owner/:repo/candidates/compose', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  return reply(c, await compositions.compose(w.cx, body), 201);
});

candidatesApi.get('/repos/:owner/:repo/compositions', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await compositions.listCompositions(rd.cx, { limit: c.req.query('limit'), cursor: c.req.query('cursor') }));
});

candidatesApi.get('/repos/:owner/:repo/compositions/:id', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await compositions.getComposition(rd.cx, c.req.param('id')));
});

candidatesApi.post('/repos/:owner/:repo/arenas', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  return reply(c, await candidates.createArena(w.cx, body), 201);
});

candidatesApi.get('/repos/:owner/:repo/arenas', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await candidates.listArenas(rd.cx, { limit: c.req.query('limit'), cursor: c.req.query('cursor') }));
});

candidatesApi.get('/repos/:owner/:repo/arenas/:id', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await candidates.getArena(rd.cx, c.req.param('id')));
});

candidatesApi.get('/repos/:owner/:repo/arenas/:id/candidates', async (c) => {
  const rd = await context(c, 'read');
  if ('denied' in rd) return rd.denied;
  return reply(c, await candidates.arenaCandidates(rd.cx, c.req.param('id')));
});

candidatesApi.post('/repos/:owner/:repo/arenas/:id/select', async (c) => {
  const w = await context(c, 'write');
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  return reply(c, await candidates.selectArena(w.cx, c.req.param('id'), body));
});
