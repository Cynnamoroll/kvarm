/**
 * Revert and incident webhook routes under /api/v1/repos/:owner/:repo. Thin
 * adapters over services/reverts.ts and services/incidents.ts.
 *
 *   POST   reverts                    {sha | changeNumber, reason?, base?, title?, mergePolicy?} → 201 {revert, change}
 *   GET    incidents/webhook          (repo admins) whether a secret exists, its fingerprint and generation
 *   POST   incidents/webhook/rotate   (repo admins) → 201 with the new secret, shown once
 *   DELETE incidents/webhook          (repo admins)
 *   POST   incidents                  CloudEvents 1.0 delivery, authenticated by its HMAC signature only
 *                                     → 201 opened | 200 duplicate event id | 401 unverified (nothing written)
 */

import { concat } from '@kvarm/gitops';
import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, clientIp, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as incidents from '../../services/incidents';
import * as reverts from '../../services/reverts';

export const revertsApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  const { ok: _ok, status, ...body } = r;
  return c.json(body, status as never);
}

revertsApi.post('/repos/:owner/:repo/reverts', async (c) => {
  const d = await authorizeRoute(c, 'write', { branchRules: true });
  if (!d.ok) return denyJson(c, d);
  const body = await c.req.json().catch(() => undefined);
  if (body === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const r = await reverts.createRevert(
    { env: c.env, repo: d.repo, actor: d.actor, branchRules: d.branchRules ?? [], waitUntil: (p) => c.executionCtx.waitUntil(p) },
    body,
  );
  return r.ok ? actorJson(c, r.value, 201) : failJson(c, r);
});

async function adminContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: incidents.IncidentAdminContext = { env: c.env, repo: d.repo, userId: d.actor?.user.id ?? null };
  return { cx } as const;
}

revertsApi.get('/repos/:owner/:repo/incidents/webhook', async (c) => {
  const a = await adminContext(c);
  if ('denied' in a) return a.denied;
  const r = await incidents.getIncidentWebhook(a.cx);
  return r.ok ? actorJson(c, r.value) : failJson(c, r);
});

revertsApi.post('/repos/:owner/:repo/incidents/webhook/rotate', async (c) => {
  const a = await adminContext(c);
  if ('denied' in a) return a.denied;
  const r = await incidents.rotateIncidentSecret(a.cx);
  if (!r.ok) return failJson(c, r);
  const res = actorJson(c, r.value, 201);
  res.headers.set('cache-control', 'no-store');
  return res;
});

revertsApi.delete('/repos/:owner/:repo/incidents/webhook', async (c) => {
  const a = await adminContext(c);
  if ('denied' in a) return a.denied;
  const r = await incidents.deleteIncidentWebhook(a.cx);
  return r.ok ? actorJson(c, r.value) : failJson(c, r);
});

/** The request body, or null once it passes `max` bytes (the rest is never buffered, declared length or not). */
async function readBounded(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

revertsApi.post('/repos/:owner/:repo/incidents', async (c) => {
  // The signature covers the exact bytes, so the body is read raw and bounded before anything parses it.
  const body = await readBounded(c.req.raw, incidents.INCIDENT_LIMITS.maxBodyBytes);
  if (body === null) {
    return c.json({ error: `the body exceeds ${incidents.INCIDENT_LIMITS.maxBodyBytes} bytes`, code: 'BODY_TOO_LARGE' }, 413);
  }
  const r = await incidents.receiveIncident(
    {
      owner: c.req.param('owner'),
      name: c.req.param('repo'),
      headers: c.req.raw.headers,
      body,
      clientIp: clientIp(c),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    },
    c.env,
  );
  if (!r.ok) return failJson(c, r);
  return c.json(r.value, r.value.duplicate ? 200 : 201);
});
