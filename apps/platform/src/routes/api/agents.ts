/**
 * Agent principals and agent tokens under /api/v1/agents. Thin adapters over
 * services/agents.ts. Every route resolves a human actor first, so agent
 * tokens can never list, create or revoke agents or mint credentials.
 */

import { Hono } from 'hono';
import { actorJson, requireActor, type App, failJson,
  jsonBody} from '../api';
import * as agents from '../../services/agents';

export const agentsApi = new Hono<App>();

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

agentsApi.post('/agents', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const res = await agents.createAgent(c.env, actor, {
    owner: str(body.owner) ?? actor.user.login,
    name: str(body.name) ?? '',
    description: str(body.description),
    modelFamily: body.modelFamily,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { agent: agents.agentJson(res.value) }, 201);
});

agentsApi.get('/agents', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const limit = Number(c.req.query('limit'));
  const res = await agents.listAgents(c.env, actor, c.req.query('owner') || actor.user.login, {
    cursor: c.req.query('cursor') || undefined,
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { agents: res.value.agents.map(agents.agentJson), nextCursor: res.value.nextCursor });
});

agentsApi.get('/agents/:id', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await agents.getAgent(c.env, actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { agent: agents.agentJson(res.value) });
});

agentsApi.delete('/agents/:id', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await agents.revokeAgent(c.env, actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { agent: agents.agentJson(res.value) });
});

agentsApi.post('/agents/:id/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await jsonBody(c);
  if (body instanceof Response) return body;
  const res = await agents.mintAgentToken(c.env, actor, c.req.param('id'), {
    repo: str(body.repo) ?? '',
    role: str(body.role) ?? '',
    refs: body.refs,
    expiresIn: body.expiresIn,
    name: str(body.name),
  });
  if (!res.ok) return failJson(c, res);
  const res201 = actorJson(
    c,
    {
      token: res.value.token,
      ...agents.agentTokenJson(res.value.row),
      note: 'store this token now; it is not retrievable later',
    },
    201,
  );
  res201.headers.set('Cache-Control', 'no-store');
  return res201;
});

agentsApi.get('/agents/:id/tokens', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await agents.listAgentTokens(c.env, actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  const now = Date.now();
  return actorJson(c, { tokens: res.value.map((t) => agents.agentTokenJson(t, now)) });
});

agentsApi.delete('/agents/:id/tokens/:tokenId', async (c) => {
  const actor = await requireActor(c);
  if (actor instanceof Response) return actor;
  const res = await agents.revokeAgentToken(c.env, actor, c.req.param('id'), c.req.param('tokenId'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { revoked: res.value.revoked, token: agents.agentTokenJson(res.value.row) });
});
