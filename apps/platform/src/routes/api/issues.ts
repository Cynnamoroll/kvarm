/**
 * Issue routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/issues.ts; the shared authority lookup runs first on every route.
 * Reads follow repo read access (anonymous on public repos); writes need the
 * `write` role through an `api`-scope credential (agent tokens included).
 *
 *   POST  issues                  {title, body?, paths?, fingerprint?, evidence?} → 201 filed | 200 counted on the open issue
 *   GET   issues?state=&source=&limit=&cursor=
 *   GET   issues/:number          the issue and its links
 *   PATCH issues/:number          {title?, body?, paths?, state?, closedReason?}
 *   POST  issues/:number/comments {body} → 201 the comment
 *   POST  issues/:number/dispatch a fix-issue agent task → 201 created | 200 the live one
 *   GET   changes/:number/issues  issues linked to the change (or its workspace) and whether each will close
 *   POST  changes/:number/issues  {issue, kind?, state?} confirm or reject a link
 */

import { Hono } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import * as svc from '../../services/issues';
import { getTask } from '../../services/tasks';

export const issuesApi = new Hono<App>();

issuesApi.post('/repos/:owner/:repo/issues', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  const r = await svc.createIssue({ env: c.env, repo: d.repo, actor: d.actor }, body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, { ...r.value.issue, created: r.value.created }, r.value.created ? 201 : 200);
});

issuesApi.get('/repos/:owner/:repo/issues', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await svc.listIssues(c.env, d.repo, {
    state: c.req.query('state'),
    source: c.req.query('source'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

issuesApi.get('/repos/:owner/:repo/issues/:number', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await svc.getIssue({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

issuesApi.patch('/repos/:owner/:repo/issues/:number', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  const r = await svc.updateIssue({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

issuesApi.post('/repos/:owner/:repo/issues/:number/comments', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  const r = await svc.createComment({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, 201);
});

issuesApi.get('/repos/:owner/:repo/changes/:number/issues', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await svc.listChangeIssues({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

issuesApi.post('/repos/:owner/:repo/changes/:number/issues', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const body = await jsonBody(c);
  const r = await svc.linkIssue({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'), body);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

issuesApi.post('/repos/:owner/:repo/issues/:number/dispatch', async (c) => {
  const d = await authorizeRoute(c, 'write');
  if (!d.ok) return denyJson(c, d);
  const r = await svc.dispatchIssue({ env: c.env, repo: d.repo, actor: d.actor }, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  const task = await getTask(c.env, d.repo, r.value.task);
  if (!task.ok) return failJson(c, task);
  return actorJson(c, { task: task.value, created: r.value.created }, r.value.created ? 201 : 200);
});
