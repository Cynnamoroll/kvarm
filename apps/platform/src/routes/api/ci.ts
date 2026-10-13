import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as ci from '../../services/ci';
import * as flakes from '../../services/flakes';
import * as hostedCi from '../../services/hostedCi';
import { resumeAfterCheck } from '../../services/changes';

export const ciApi = new Hono<App>();

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>) {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

async function runnerContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'write', { requireActor: true, transport: 'ci' });
  return d.ok ? ({ d } as const) : ({ denied: denyJson(c, d) } as const);
}

async function readContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'read');
  return d.ok ? ({ d } as const) : ({ denied: denyJson(c, d) } as const);
}

async function adminContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  return d.ok ? ({ d } as const) : ({ denied: denyJson(c, d) } as const);
}

const body = (c: Context<App>) => c.req.json().catch(() => undefined);

ciApi.post('/repos/:owner/:repo/ci/jobs/claim', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.claimJob(c.env, x.d.repo, await body(c));
  if (!r.ok) return failJson(c, r);
  if (r.value === null) return new Response(null, { status: 204 });
  return actorJson(c, { job: r.value });
});

ciApi.post('/repos/:owner/:repo/ci/jobs/:id/heartbeat', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.heartbeatJob(c.env, x.d.repo, c.req.param('id'), await body(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { job: r.value });
});

// A requeued retry is a fresh claimable job: wake the hosted drain if the
// repository opted in, without holding the report response.
ciApi.post('/repos/:owner/:repo/ci/jobs/:id/report', async (c) => {
  const x = await runnerContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.reportJob(c.env, x.d.repo, c.req.param('id'), await body(c));
  if (!r.ok) return failJson(c, r);
  if (r.value.retried) c.executionCtx.waitUntil(hostedCi.kickHostedCi(c.env, x.d.repo));
  if (r.value.change) {
    c.executionCtx.waitUntil(resumeAfterCheck(c.env, x.d.repo.id, r.value.change, (p) => c.executionCtx.waitUntil(p)));
  }
  return actorJson(c, { run: r.value.run, change: r.value.change ? { number: r.value.change.number } : null, retried: r.value.retried });
});

ciApi.get('/repos/:owner/:repo/ci/jobs', async (c) => {
  const x = await readContext(c);
  if ('denied' in x) return x.denied;
  const r = await ci.listCiJobs(c.env, x.d.repo, { limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

ciApi.get('/repos/:owner/:repo/ci/flakes', async (c) => {
  const x = await readContext(c);
  if ('denied' in x) return x.denied;
  const r = await flakes.listFlakes(c.env, x.d.repo, { limit: c.req.query('limit'), cursor: c.req.query('cursor') });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

ciApi.post('/repos/:owner/:repo/ci/flakes/:check/quarantine', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  const r = await flakes.quarantineCheck(c.env, x.d.repo, x.d.actor?.user.id ?? null, c.req.param('check'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

ciApi.post('/repos/:owner/:repo/ci/flakes/:check/restore', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  const r = await flakes.restoreCheck(c.env, x.d.repo, c.req.param('check'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

ciApi.get('/repos/:owner/:repo/ci/hosted', async (c) => {
  const x = await readContext(c);
  if ('denied' in x) return x.denied;
  const view = await hostedCi.hostedCiView(c.env, x.d.repo);
  const drain = c.env.CI_SANDBOX ? await c.env.CI_SANDBOX.getByName(x.d.repo.id).status() : null;
  return actorJson(c, { ...view, drain });
});

// Action endpoints in the quarantine/restore style, so every surface names
// what it does: `kvarm ci enable`, MCP enable_ci_hosted.
ciApi.post('/repos/:owner/:repo/ci/hosted/enable', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  const r = await hostedCi.setHostedCi(c.env, x.d.repo, true, x.d.actor?.user.id ?? null);
  if (!r.ok) return failJson(c, r);
  // The row was just written; enabling starts draining any queued backlog.
  c.executionCtx.waitUntil(hostedCi.kickHostedCi(c.env, { id: x.d.repo.id, hosted_ci: 1 }));
  return actorJson(c, r.value);
});

ciApi.post('/repos/:owner/:repo/ci/hosted/disable', async (c) => {
  const x = await adminContext(c);
  if ('denied' in x) return x.denied;
  const r = await hostedCi.setHostedCi(c.env, x.d.repo, false, x.d.actor?.user.id ?? null);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
