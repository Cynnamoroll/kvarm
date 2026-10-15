/**
 * Review routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/reviews.ts; the shared authority lookup runs first on every route.
 * Reads follow repo read access; reviews and assignments need the `write`
 * role (humans and agent tokens alike); the review policy is admin-only and
 * escalations are resolved by humans only.
 *
 *   GET  review-policy
 *   PUT  review-policy                          {requiredReviews}
 *   GET  reviews/pending?limit=&cursor=
 *   GET  changes/:number/reviews                the review packet
 *   POST changes/:number/reviews                {verdict, headSha?, body?}
 *   POST changes/:number/approve                {headSha?, body?}
 *   POST changes/:number/request-changes        {headSha?, body?}
 *   POST changes/:number/reviewers/assign       {candidates?}
 *   POST changes/:number/escalations/:id/resolve {note?}
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App, failJson,
  jsonBody} from '../api';
import type { ChangeContext } from '../../services/changes';
import * as reviews from '../../services/reviews';
import * as guide from '../../services/reviewGuide';
import * as impact from '../../services/reviewImpact';
import * as analytics from '../../services/reviewAnalytics';

export const reviewsApi = new Hono<App>();

async function writeContext(
  c: Context<App>,
  opts: { requireActor?: boolean; allowAgent?: boolean } = {},
): Promise<{ denied: Response } | { cx: ChangeContext }> {
  const d = await authorizeRoute(c, 'write', { ...opts, branchRules: true });
  if (!d.ok) return { denied: denyJson(c, d) };
  const cx: ChangeContext = {
    env: c.env,
    repo: d.repo,
    actor: d.actor,
    writeAccess: true,
    branchRules: d.branchRules ?? [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
  return { cx };
}

async function readContext(c: Context<App>, branchRules = false): Promise<{ denied: Response } | { cx: ChangeContext }> {
  const d = await authorizeRoute(c, 'read', { branchRules });
  if (!d.ok) return { denied: denyJson(c, d) };
  return {
    cx: {
      env: c.env,
      repo: d.repo,
      actor: d.actor,
      writeAccess: d.role === 'write' || d.role === 'admin',
      ...(branchRules ? { branchRules: d.branchRules ?? [] } : {}),
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    },
  };
}

reviewsApi.get('/repos/:owner/:repo/review-policy', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await reviews.getReviewPolicy(c.env, d.repo);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.put('/repos/:owner/:repo/review-policy', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  const r = await reviews.setReviewPolicy(c.env, d.repo, d.actor!, await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/reviews/pending', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await reviews.pendingReviews(c.env, d.repo, {
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
    ready: c.req.query('ready'),
  }, (promise) => c.executionCtx.waitUntil(promise));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/changes/:number/reviews', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await reviews.getReviewPacket(c.env, d.repo, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

async function review(c: Context<App>, verdict: reviews.ReviewVerdict | null): Promise<Response> {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await reviews.submitReview(w.cx, c.req.param('number') ?? '', await jsonBody(c), verdict);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, r.value.created ? 201 : 200);
}

reviewsApi.post('/repos/:owner/:repo/changes/:number/reviews', (c) => review(c, null));
reviewsApi.post('/repos/:owner/:repo/changes/:number/approve', (c) => review(c, 'approve'));
reviewsApi.post('/repos/:owner/:repo/changes/:number/request-changes', (c) => review(c, 'request-changes'));

reviewsApi.post('/repos/:owner/:repo/changes/:number/reviewers/assign', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await reviews.assignReviewer(w.cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.post('/repos/:owner/:repo/changes/:number/review-requests', async (c) => {
  const w = await writeContext(c, { requireActor: true, allowAgent: true });
  if ('denied' in w) return w.denied;
  const r = await reviews.requestReview(w.cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, r.value.created ? 201 : 200);
});

reviewsApi.delete('/repos/:owner/:repo/changes/:number/review-requests/:principal', async (c) => {
  const w = await writeContext(c, { requireActor: true, allowAgent: true });
  if ('denied' in w) return w.denied;
  const principal = decodeURIComponent(c.req.param('principal'));
  const r = await reviews.withdrawReviewRequest(w.cx, c.req.param('number'), principal);
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.post('/repos/:owner/:repo/changes/:number/escalations/:id/resolve', async (c) => {
  // Agent tokens pass the authority so the service can name the human requirement.
  const w = await writeContext(c, { requireActor: true, allowAgent: true });
  if ('denied' in w) return w.denied;
  const r = await reviews.resolveEscalation(w.cx, c.req.param('number'), c.req.param('id'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/review/analytics', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const r = await analytics.getReviewAnalytics(c.env, d.repo, c.req.query('days'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/changes/:number/review-guide', async (c) => {
  const rctx = await readContext(c, true);
  if ('denied' in rctx) return rctx.denied;
  const r = await guide.getGuide(rctx.cx, c.req.param('number'), {
    since: c.req.query('since'),
    unacked: c.req.query('unacked'),
    include: c.req.query('include'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/changes/:number/review/impact', async (c) => {
  const rctx = await readContext(c);
  if ('denied' in rctx) return rctx.denied;
  const r = await impact.getReviewImpact(rctx.cx, c.req.param('number'));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.post('/repos/:owner/:repo/changes/:number/review-guide', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await guide.submitGuide(w.cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, r.value.created ? 201 : 200);
});

reviewsApi.post('/repos/:owner/:repo/changes/:number/review-acks', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await guide.ackUnits(w.cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.get('/repos/:owner/:repo/changes/:number/findings', async (c) => {
  const rctx = await readContext(c);
  if ('denied' in rctx) return rctx.denied;
  const r = await guide.listFindings(rctx.cx, c.req.param('number'), {
    status: c.req.query('status'),
    limit: c.req.query('limit'),
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});

reviewsApi.post('/repos/:owner/:repo/changes/:number/findings', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await guide.submitFindings(w.cx, c.req.param('number'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value, r.value.created.length ? 201 : 200);
});

reviewsApi.patch('/repos/:owner/:repo/changes/:number/findings/:id', async (c) => {
  const w = await writeContext(c);
  if ('denied' in w) return w.denied;
  const r = await guide.updateFinding(w.cx, c.req.param('number'), c.req.param('id'), await jsonBody(c));
  if (!r.ok) return failJson(c, r);
  return actorJson(c, r.value);
});
