/**
 * Attribution and decision context under /api/v1/repos/:owner/:repo. Thin
 * adapters over services/attribution.ts and services/decisions.ts; the shared
 * authority lookup runs first on every route. Reads follow repo read access;
 * writes need the `write` role through an `api`-scope credential (agent
 * tokens included).
 *
 *   POST commits/:sha/attribution  {agent, session, promptHash, model?, evidence?}
 *   GET  commits/:sha/attribution  (evidence.principal/tokenPrefix only for repo admins)
 *   GET  audit?since=&until=&format=json|ndjson&limit=&cursor=   (admin)
 *   GET/POST provenance-keys, DELETE provenance-keys/:id           (admin)
 *   POST decisions                 {task?, paths[], chosen, rejected[], reason}
 *   GET  context?task=&path=&limit=&cursor=
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import * as attribution from '../../services/attribution';
import * as audit from '../../services/audit';
import * as provenance from '../../services/provenance';
import * as decisions from '../../services/decisions';

export const attributionApi = new Hono<App>();

const invalidBody = (c: Context<App>) => c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);

attributionApi.post('/repos/:owner/:repo/commits/:sha/attribution', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  if (body === undefined) return invalidBody(c);
  const cx = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
  const r = await attribution.setAttribution(cx, c.req.param('sha'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { ...r.value.record, evidence: r.value.evidence }, r.value.replaced ? 200 : 201);
});

attributionApi.get('/repos/:owner/:repo/commits/:sha/attribution', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const cx = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p: Promise<unknown>) => c.executionCtx.waitUntil(p) };
  const r = await attribution.getAttribution(cx, c.req.param('sha'));
  if (!r.ok) return failJson(c, r);
  // The submitting principal id and token prefix are admin-only; a plain reader sees the note's own display name.
  const evidence = attribution.evidenceForReader(r.value.evidence, d.role === 'admin');
  return actorJson(c, { ...r.value, evidence });
});

// Audit export and trusted keys need admin access; anonymous callers get 401 and others the shared concealment answer.
attributionApi.get('/repos/:owner/:repo/audit', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const format = c.req.query('format') ?? 'json';
  if (format !== 'json' && format !== 'ndjson') return c.json({ error: 'format must be json or ndjson', code: 'INVALID_FORMAT' }, 400);
  const r = await audit.readAudit(c.env, d.repo, {
    since: c.req.query('since'),
    until: c.req.query('until'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  if (format === 'json') return actorJson(c, r.value);
  // One record per line, then one page line, so a reader that only sees the body can still continue.
  const page = { page: { since: r.value.since, until: r.value.until, truncated: r.value.truncated, nextCursor: r.value.nextCursor } };
  const body = [...r.value.records.map((x) => JSON.stringify(x)), JSON.stringify(page)].join('\n') + '\n';
  const res = new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  if (r.value.nextCursor) res.headers.set('x-kvarm-next-cursor', r.value.nextCursor);
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
});

attributionApi.get('/repos/:owner/:repo/provenance-keys', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const r = await provenance.listProvenanceKeys(c.env, d.repo);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

attributionApi.post('/repos/:owner/:repo/provenance-keys', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  if (body === undefined) return invalidBody(c);
  const r = await provenance.addProvenanceKey(c.env, d.repo, d.actor!, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

attributionApi.delete('/repos/:owner/:repo/provenance-keys/:id', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const r = await provenance.revokeProvenanceKey(c.env, d.repo, c.req.param('id'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

attributionApi.post('/repos/:owner/:repo/decisions', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
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
