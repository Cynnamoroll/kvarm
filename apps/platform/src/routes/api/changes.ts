/**
 * Change request routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/changes.ts; the shared authority lookup runs first on every route.
 * Reads follow repo read access (anonymous on public repos); writes need the
 * `write` role through an `api`-scope credential, so anonymous callers get
 * 401 and principals without a write role or scope get 403.
 *
 *   POST  changes                       {title, body?, base, head, mergePolicy?}
 *   GET   changes?state=&limit=&cursor=
 *   GET   changes/:number               detail: rating, mergeability, check runs
 *   PATCH changes/:number               {title?, body?, mergePolicy?, state?: open|closed}
 *   POST  changes/:number/merge
 *   GET   changes/:number/mergeability
 *   GET   changes/:number/checks
 *   POST  changes/:number/enqueue       {headSha?, mergePolicy?, attribution?} → 201 new | 200 already queued
 *   DELETE changes/:number/enqueue
 *   GET   queue?limit=&cursor=&base=
 *   GET   train?limit=&base=               live train with each entry's pins and waiting reason
 *   GET   tasks?status=&kind=&limit=&cursor=   agent tasks (resolve-conflict)
 *   GET   tasks/:id
 *   POST  tasks/:id/claim               {agent?, ttlSeconds?} → {task, workspace, lease}
 *   POST  tasks/:id/heartbeat           {agent?, generation, ttlSeconds?}
 *   POST  tasks/:id/complete            {agent?, generation, sha?, attribution?} → {task, change, headBranch}
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import * as svc from '../../services/changes';
import * as queue from '../../services/queue';
import * as tasks from '../../services/tasks';

export const changesApi = new Hono<App>();

async function readContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.ChangeContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    writeAccess: d.role === 'write' || d.role === 'admin',
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

async function writeContext(c: Context<App>) {
  const d = await authorizeRoute(c, 'write', { branchRules: true });
  if (!d.ok) return { denied: denyJson(c, d) } as const;
  const cx: svc.ChangeContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    branchRules: d.branchRules ?? [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx } as const;
}

changesApi.post('/repos/:owner/:repo/changes', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  const r = await svc.createChange(w.cx, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

changesApi.get('/repos/:owner/:repo/changes', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.listChanges(c.env, rd.cx.repo, {
    state: c.req.query('state'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/changes/:number', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.getChange(rd.cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.patch('/repos/:owner/:repo/changes/:number', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const body = await jsonBody(c);
  const r = await svc.updateChange(w.cx, c.req.param('number'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.post('/repos/:owner/:repo/changes/:number/merge', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await svc.mergeChange(w.cx, c.req.param('number'), svc.defaultMergeDeps, await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { ...r.value.change, merge: r.value.merge });
});

changesApi.post('/repos/:owner/:repo/changes/:number/enqueue', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const cx: svc.ChangeContext = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p) => c.executionCtx.waitUntil(p) };
  const r = await queue.enqueueChange(cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) {
    const retryAfter = (r as { retryAfter?: unknown }).retryAfter;
    if (r.status === 429 && typeof retryAfter === 'number') c.header('Retry-After', String(retryAfter));
    return failJson(c, r);
  }
  return actorJson(c, r.value, r.value.created ? 201 : 200);
});

changesApi.delete('/repos/:owner/:repo/changes/:number/enqueue', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const cx: svc.ChangeContext = { env: c.env, repo: d.repo, actor: d.actor, waitUntil: (p) => c.executionCtx.waitUntil(p) };
  const r = await queue.dequeueChange(cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/queue', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await queue.listQueue(c.env, rd.cx.repo, { limit: c.req.query('limit'), cursor: c.req.query('cursor'), base: c.req.query('base') });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/train', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await queue.trainStatus(c.env, rd.cx.repo, { limit: c.req.query('limit'), base: c.req.query('base') });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/tasks', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await tasks.listTasks(c.env, rd.cx.repo, {
    status: c.req.query('status'),
    kind: c.req.query('kind'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/tasks/:id', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await tasks.getTask(c.env, rd.cx.repo, c.req.param('id'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

async function taskContext(c: Context<App>) {
  const w = await writeContext(c);
  if ('denied' in w) return { denied: w.denied } as const;
  const cx: tasks.TaskContext = { ...w.cx, origin: new URL(c.req.url).origin };
  return { cx } as const;
}

changesApi.post('/repos/:owner/:repo/tasks/:id/claim', async (c) => {
  const t = await taskContext(c);
  if ('denied' in t) return t.denied;
  const r = await tasks.claimTask(t.cx, c.req.param('id'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.post('/repos/:owner/:repo/tasks/:id/heartbeat', async (c) => {
  const t = await taskContext(c);
  if ('denied' in t) return t.denied;
  const r = await tasks.heartbeatTask(t.cx, c.req.param('id'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.post('/repos/:owner/:repo/tasks/:id/complete', async (c) => {
  const t = await taskContext(c);
  if ('denied' in t) return t.denied;
  const r = await tasks.completeTask(t.cx, c.req.param('id'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/changes/:number/mergeability', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.getMergeability(rd.cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

changesApi.get('/repos/:owner/:repo/changes/:number/checks', async (c) => {
  const rd = await readContext(c);
  if ('denied' in rd) return rd.denied;
  const r = await svc.listChangeChecks(c.env, rd.cx.repo, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
