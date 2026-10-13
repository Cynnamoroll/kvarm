import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, clientIp, denyJson, requestCredential, type App } from '../api';
import { resolvePAT } from '../../services/access';
import { patActor } from '../../services/authz';
import type { ServiceResult } from '../../repos/service';
import * as environments from '../../services/environments';
import * as sandboxes from '../../services/sandboxes';

export const fleetApi = new Hono<App>();

function failJson(c: Context<App>, result: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  const { ok: _ok, status, ...body } = result;
  return c.json(body, status as never);
}

async function routeContext(c: Context<App>, need: 'read' | 'write') {
  const decision = await authorizeRoute(c, need, { branchRules: need === 'write' });
  if (!decision.ok) return { denied: denyJson(c, decision) } as const;
  const base = {
    env: c.env,
    repo: decision.repo,
    actor: decision.actor,
  };
  return {
    envContext: base,
    sandboxContext: {
      ...base,
      origin: new URL(c.req.url).origin,
      waitUntil: (promise: Promise<unknown>) => c.executionCtx.waitUntil(promise),
    },
  } as const;
}

async function body(c: Context<App>): Promise<unknown> {
  return c.req.json().catch(() => undefined);
}

fleetApi.get('/sandboxes/mine', async (c) => {
  const credential = await requestCredential(c);
  let actor = credential.kind === 'session' ? credential.actor : null;
  if (credential.kind === 'pat') {
    const principal = await resolvePAT(c.env, credential.token, clientIp(c));
    if (!principal.ok) return denyJson(c, principal);
    actor = patActor(principal.pat);
  }
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  const limit = Number(c.req.query('limit'));
  const result = await sandboxes.listMySandboxes(c.env, actor, {
    cursor: c.req.query('cursor'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.get('/repos/:owner/:repo/environments', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await environments.listEnvironments(c.env, route.envContext.repo, route.envContext.actor);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, { environments: result.value });
});

fleetApi.post('/repos/:owner/:repo/environments', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  if (input === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const result = await environments.createEnvironment(route.envContext, input);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value, 201);
});

fleetApi.get('/repos/:owner/:repo/environments/:id', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await environments.getEnvironment(c.env, route.envContext.repo, route.envContext.actor, c.req.param('id'));
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.patch('/repos/:owner/:repo/environments/:id', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  if (input === undefined) return c.json({ error: 'body must be JSON', code: 'INVALID_BODY' }, 400);
  const result = await environments.updateEnvironment(route.envContext, c.req.param('id'), input);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.delete('/repos/:owner/:repo/environments/:id', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const result = await environments.archiveEnvironment(route.envContext, c.req.param('id'));
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.get('/repos/:owner/:repo/environments/:id/builds', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await environments.listEnvironmentBuilds(
    c.env,
    route.envContext.repo,
    route.envContext.actor,
    c.req.param('id'),
    Number(c.req.query('limit')) || 50,
  );
  if (!result.ok) return failJson(c, result);
  return actorJson(c, { builds: result.value });
});

fleetApi.get('/repos/:owner/:repo/environments/:id/builds/:buildId', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await environments.getEnvironmentBuild(
    c.env,
    route.envContext.repo,
    route.envContext.actor,
    c.req.param('id'),
    c.req.param('buildId'),
  );
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.post('/repos/:owner/:repo/environments/:id/rebuild', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const result = await environments.rebuildEnvironment(route.envContext, c.req.param('id'));
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value, 202);
});

fleetApi.get('/repos/:owner/:repo/sandboxes', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const limit = Number(c.req.query('limit'));
  const result = await sandboxes.listSandboxes(c.env, route.envContext.repo, route.envContext.actor, {
    cursor: c.req.query('cursor'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
  });
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.post('/repos/:owner/:repo/sandboxes', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400);
  }
  const result = await sandboxes.startSandbox(route.sandboxContext, input as sandboxes.StartSandboxInput);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value, result.value.resumed ? 200 : 201);
});

fleetApi.get('/repos/:owner/:repo/sandboxes/:id', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await sandboxes.getSandbox(c.env, route.envContext.repo, route.envContext.actor, c.req.param('id'));
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.post('/repos/:owner/:repo/sandboxes/:id/stop', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  const discard = Boolean(input && typeof input === 'object' && (input as { discard?: unknown }).discard === true);
  const result = await sandboxes.stopSandbox(route.sandboxContext, c.req.param('id'), { discard });
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.post('/repos/:owner/:repo/sandboxes/:id/exec', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400);
  const result = await sandboxes.execSandbox(route.sandboxContext, c.req.param('id'), input as Parameters<typeof sandboxes.execSandbox>[2]);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.get('/repos/:owner/:repo/sandboxes/:id/files', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const path = c.req.query('path');
  if (!path) return c.json({ error: 'path is required', code: 'INVALID_PATH' }, 400);
  const result = await sandboxes.readSandboxFile(route.sandboxContext, c.req.param('id'), path);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.put('/repos/:owner/:repo/sandboxes/:id/files', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return c.json({ error: 'body must be a JSON object', code: 'INVALID_BODY' }, 400);
  const result = await sandboxes.writeSandboxFile(route.sandboxContext, c.req.param('id'), input as { path: string; content: string });
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});

fleetApi.get('/repos/:owner/:repo/sandboxes/:id/commands', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await sandboxes.listSandboxCommands(c.env, route.envContext.repo, route.envContext.actor, c.req.param('id'));
  if (!result.ok) return failJson(c, result);
  return actorJson(c, { commands: result.value });
});

fleetApi.get('/repos/:owner/:repo/sandbox-approvals', async (c) => {
  const route = await routeContext(c, 'read');
  if ('denied' in route) return route.denied;
  const result = await sandboxes.listSandboxApprovals(c.env, route.envContext.repo, route.envContext.actor);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, { approvals: result.value });
});

fleetApi.post('/repos/:owner/:repo/sandbox-approvals/:approvalId', async (c) => {
  const route = await routeContext(c, 'write');
  if ('denied' in route) return route.denied;
  const input = await body(c);
  const decision = input && typeof input === 'object' ? (input as { decision?: unknown }).decision : undefined;
  if (decision !== 'approve' && decision !== 'deny') return c.json({ error: 'decision must be approve or deny', code: 'INVALID_DECISION' }, 422);
  const result = await sandboxes.decideSandboxApproval(route.sandboxContext, c.req.param('approvalId'), decision);
  if (!result.ok) return failJson(c, result);
  return actorJson(c, result.value);
});
