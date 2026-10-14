/**
 * Branch rules under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/branchRules.ts. Anyone who can read the repo can see its rules and
 * the effective policy of a ref; only repo admins (including the instance
 * admin, as an explicit audited operations role) manage them.
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import type { ServiceResult } from '../../repos/service';
import * as rules from '../../services/branchRules';

export const branchRulesApi = new Hono<App>();

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function ruleJson(r: rules.BranchRule) {
  return { ...r, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt) };
}

function failJson(c: Context<App>, r: Extract<ServiceResult<unknown>, { ok: false }>): Response {
  return c.json({ error: r.error, code: r.code }, r.status as never);
}

async function jsonBody(c: Context<App>): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

branchRulesApi.get('/repos/:owner/:repo/branch-rules', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  return actorJson(c, { rules: (await rules.listRules(c.env, d.repo)).map(ruleJson) });
});

branchRulesApi.post('/repos/:owner/:repo/branch-rules', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  const body = await jsonBody(c);
  const res = await rules.createRule(c.env, d.repo, d.actor, {
    pattern: body.pattern,
    requiredChecks: body.requiredChecks,
    requiredApprovals: body.requiredApprovals,
    guardCompleteness: body.guardCompleteness,
    agentApprovals: body.agentApprovals,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { rule: ruleJson(res.value) }, 201);
});

branchRulesApi.get('/repos/:owner/:repo/branch-rules/:id', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const res = await rules.getRule(c.env, d.repo, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { rule: ruleJson(res.value) });
});

branchRulesApi.patch('/repos/:owner/:repo/branch-rules/:id', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  const body = await jsonBody(c);
  if (body.pattern !== undefined) {
    return c.json({ error: 'pattern cannot be changed; delete the rule and create a new one', code: 'INVALID_PATTERN' }, 400);
  }
  const res = await rules.updateRule(c.env, d.repo, d.actor, c.req.param('id'), {
    requiredChecks: body.requiredChecks,
    requiredApprovals: body.requiredApprovals,
    guardCompleteness: body.guardCompleteness,
    agentApprovals: body.agentApprovals,
  });
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { rule: ruleJson(res.value) });
});

branchRulesApi.delete('/repos/:owner/:repo/branch-rules/:id', async (c) => {
  const d = await authorizeRoute(c, 'admin', { requireActor: true });
  if (!d.ok) return denyJson(c, d);
  if (!d.actor) return c.json({ error: 'unauthorized', code: 'UNAUTHENTICATED' }, 401);
  const res = await rules.deleteRule(c.env, d.repo, d.actor, c.req.param('id'));
  if (!res.ok) return failJson(c, res);
  return actorJson(c, { deleted: true, rule: ruleJson(res.value.rule) });
});

branchRulesApi.get('/repos/:owner/:repo/branch-policy', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const ref = rules.normalizeRefName(c.req.query('ref'));
  if (!ref) return c.json({ error: 'ref must be a branch name or full ref name', code: 'INVALID_REF' }, 400);
  return actorJson(c, rules.effectivePolicy(await rules.listRules(c.env, d.repo), ref));
});
