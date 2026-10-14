import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import worker from '../src/index';

const env = cfEnv as unknown as Env;
const owner = 'review-analytics-owner';
const repoName = 'review-analytics';
const repoId = crypto.randomUUID();
const userId = crypto.randomUUID();
let token = '';
let measuredCost: unknown;
const analyticsCosts: Record<string, unknown> = {};

async function request(path: string) {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new Request(`https://kvarm.test${path}`, { headers: { Authorization: `Bearer ${token}` } }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const body = await response.json() as Record<string, any>;
  await waitOnExecutionContext(ctx);
  measuredCost = parseCostHeader(response.headers.get(COST_HEADER));
  return { status: response.status, body };
}

beforeAll(async () => {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`,
    ).bind(userId, `test:${owner}`, owner, `${owner}@kvarm.invalid`, owner, now),
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'public', 'main', ?6)`,
    ).bind(repoId, owner, repoName, `${owner}--${repoName}`, `https://artifacts.invalid/${owner}/${repoName}.git`, now),
  ]);
  token = (await mintPAT(env, userId, 'review-analytics', ['read'])).token;

  const createdAt = now - 2 * 86_400_000;
  const ids = ['analytics-change-1', 'analytics-change-2'];
  await env.DB.batch(ids.map((id, index) => env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'main', 'feature', ?5, 'open', ?6, ?7, ?7)`,
  ).bind(id, repoId, index + 1, `Analytics ${index + 1}`, `${index + 1}`.repeat(40), userId, createdAt)));

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at, model_family)
       VALUES ('analytics-agent', 'user', ?1, ?2, 'Verdict agent', ?1, ?3, 'gpt')`,
    ).bind(userId, owner, now),
    env.DB.prepare(
      `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at, model_family)
       VALUES ('analytics-no-verdict', 'user', ?1, ?2, 'No-verdict agent', ?1, ?3, 'opus-4.5')`,
    ).bind(userId, owner, now),
    env.DB.prepare(
      `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at, model_family)
       VALUES ('analytics-unknown', 'user', ?1, ?2, 'Unknown-family agent', ?1, ?3, NULL)`,
    ).bind(userId, owner, now),
  ]);
  const findings = [
    { id: 'finding-human-resolved', change: ids[0]!, status: 'resolved', category: 'bug', principal: `user:${userId}`, agent: null },
    { id: 'finding-human-irrelevant', change: ids[0]!, status: 'irrelevant', category: 'bug', principal: `user:${userId}`, agent: null },
    { id: 'finding-human-open', change: ids[0]!, status: 'open', category: 'bug', principal: `user:${userId}`, agent: null },
    { id: 'finding-agent-wontfix', change: ids[1]!, status: 'wont-fix', category: 'security', principal: 'agent:analytics-agent', agent: 'analytics-agent' },
    { id: 'finding-agent-no-verdict', change: ids[0]!, status: 'open', category: 'security', principal: 'agent:analytics-no-verdict', agent: 'analytics-no-verdict' },
    { id: 'finding-agent-unknown', change: ids[0]!, status: 'open', category: 'security', principal: 'agent:analytics-unknown', agent: 'analytics-unknown' },
  ];
  await env.DB.batch(findings.map((finding) => env.DB.prepare(
    `INSERT INTO review_findings
       (id, change_set_id, opened_head, last_seen_head, path, side, start_line, category, severity, confidence, title,
        fingerprint, status, principal, user_id, agent_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3, 'src/file.ts', 'head', 1, ?4, 'high', 'confirmed', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
  ).bind(
    finding.id, finding.change, finding.change === ids[0] ? '1'.repeat(40) : '2'.repeat(40),
    finding.category, finding.id, finding.id, finding.status, finding.principal, userId, finding.agent, now,
  )));
  await env.DB.batch(ids.map((id, index) => env.DB.prepare(
    `INSERT INTO change_reviews
       (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, agent_id, agent_name, model_family,
        verdict, coverage, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'approve', ?11, ?12, ?12)`,
  ).bind(
    `analytics-review-${index + 1}`, repoId, id, `${index + 1}`.repeat(40),
    index === 0 ? `user:${userId}` : 'agent:analytics-agent', userId, owner,
    index === 0 ? null : 'analytics-agent', index === 0 ? null : 'Analytics agent', index === 0 ? 'human' : 'gpt',
    JSON.stringify(index === 0 ? { units: 4, acked: 2, scrutinizeUnacked: 0 } : { units: 2, acked: 2, scrutinizeUnacked: 0 }),
    createdAt + (index === 0 ? 10 : 30) * 60_000,
  )));
});

describe('review analytics', () => {
  it('aggregates findings and computes change-level medians from hand-built rows', async () => {
    const response = await request(`/api/v1/repos/${owner}/${repoName}/review/analytics`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      days: 30,
      medianFirstVerdictMinutes: 20,
      medianGuideCoverage: 0.75,
      truncated: false,
      groups: expect.arrayContaining([
        {
          filerKind: 'human', modelFamily: 'human', modelFamilyEvidence: 'authenticated', category: 'bug', severity: 'high',
          filed: 3, open: 1, resolved: 1, wontFix: 0, irrelevant: 1, acceptance: 0.5,
        },
        {
          filerKind: 'agent', modelFamily: 'gpt', modelFamilyEvidence: 'declared', category: 'security', severity: 'high',
          filed: 1, open: 0, resolved: 0, wontFix: 1, irrelevant: 0, acceptance: 0,
        },
        {
          filerKind: 'agent', modelFamily: 'opus-4.5', modelFamilyEvidence: 'declared', category: 'security', severity: 'high',
          filed: 1, open: 1, resolved: 0, wontFix: 0, irrelevant: 0, acceptance: null,
        },
        {
          filerKind: 'agent', modelFamily: 'unknown', modelFamilyEvidence: null, category: 'security', severity: 'high',
          filed: 1, open: 1, resolved: 0, wontFix: 0, irrelevant: 0, acceptance: null,
        },
      ]),
    });
    expect(measuredCost).toMatchObject({ art: 0 });
    expect((measuredCost as { d1: number }).d1).toBeLessThanOrEqual(3);
    analyticsCosts.cold = measuredCost;
    const warm = await request(`/api/v1/repos/${owner}/${repoName}/review/analytics`);
    expect(warm.status).toBe(200);
    expect(measuredCost).toMatchObject({ art: 0 });
    expect((measuredCost as { d1: number }).d1).toBeLessThanOrEqual(3);
    analyticsCosts.warm = measuredCost;
    console.log(JSON.stringify({ reviewAnalyticsCosts: analyticsCosts }));
  });

  it('marks the 500-change window truncated', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `WITH RECURSIVE series(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM series WHERE n < 499)
       INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at, updated_at)
       SELECT 'analytics-truncated-' || n, ?1, n + 10, 'Truncated ' || n, 'main', 'feature', printf('%040d', n), 'open', ?2, ?3, ?3 FROM series`,
    ).bind(repoId, userId, now - 86_400_000).run();
    const response = await request(`/api/v1/repos/${owner}/${repoName}/review/analytics?days=30`);
    expect(response.status).toBe(200);
    expect(response.body.truncated).toBe(true);
  });

  it('validates the requested time window', async () => {
    expect((await request(`/api/v1/repos/${owner}/${repoName}/review/analytics?days=0`)).body.code).toBe('INVALID_DAYS');
    expect((await request(`/api/v1/repos/${owner}/${repoName}/review/analytics?days=181`)).body.code).toBe('INVALID_DAYS');
  });
});
