/**
 * Outbound webhooks under /api/v1/repos/:owner/:repo/webhooks. Thin
 * adapters over services/webhooks.ts (architecture §11.5). Every operation
 * is for human repo admins (the instance admin included); agent tokens are
 * refused by the shared policy, and a private repo the caller cannot read
 * answers like a missing one. A hook's secret appears only in the answers
 * to create and rotate-secret, which are never cacheable.
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody,
  unauthJson} from '../api';
import * as hooks from '../../services/webhooks';

export const webhooksApi = new Hono<App>();

function secretJson(c: Context<App>, data: unknown, status = 200): Response {
  const res = actorJson(c, data, status);
  res.headers.set('cache-control', 'no-store');
  return res;
}

const admin = (c: Context<App>) => authorizeRoute(c, 'admin', { requireActor: true });

webhooksApi.get('/repos/:owner/:repo/webhooks', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  return actorJson(c, { webhooks: await hooks.listWebhooks(c.env, d.repo), eventTypes: hooks.WEBHOOK_EVENT_TYPES });
});

webhooksApi.post('/repos/:owner/:repo/webhooks', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return unauthJson(c);
  const body = await jsonBody(c);
  const res = await hooks.createWebhook(c.env, d.repo, d.actor, { url: body.url, events: body.events });
  if (!res.ok) return failJson(c, res);
  return secretJson(c, res.value, 201);
});

webhooksApi.get('/repos/:owner/:repo/webhooks/:id', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  const res = await hooks.getWebhook(c.env, d.repo, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { webhook: res.value });
});

webhooksApi.patch('/repos/:owner/:repo/webhooks/:id', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return unauthJson(c);
  const body = await jsonBody(c);
  const res = await hooks.updateWebhook(c.env, d.repo, d.actor, c.req.param('id'), { url: body.url, events: body.events, active: body.active });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { webhook: res.value });
});

webhooksApi.delete('/repos/:owner/:repo/webhooks/:id', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return unauthJson(c);
  const res = await hooks.deleteWebhook(c.env, d.repo, d.actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { deleted: true, webhook: res.value });
});

webhooksApi.post('/repos/:owner/:repo/webhooks/:id/rotate-secret', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return unauthJson(c);
  const res = await hooks.rotateWebhookSecret(c.env, d.repo, d.actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return secretJson(c, res.value);
});

webhooksApi.post('/repos/:owner/:repo/webhooks/:id/ping', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return unauthJson(c);
  const res = await hooks.pingWebhook(c.env, d.repo, d.actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { delivery: res.value }, 202);
});

webhooksApi.get('/repos/:owner/:repo/webhooks/:id/deliveries', async (c) => {
  const d = await admin(c);
  if (!d.ok) return denyJson(c, d);
  const res = await hooks.listDeliveries(c.env, d.repo, c.req.param('id'), {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    state: c.req.query('state'),
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, res.value);
});
