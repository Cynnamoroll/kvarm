/**
 * Review approvals (services/reviews.ts, services/reviewGate.ts): the per-repo
 * review policy, exact-head reviews by distinct human or agent principals,
 * model-family metadata and reviewer assignment, human escalations and the
 * protected-target human requirement, enforced on merge, enqueue and right
 * before train publication. Routes run against the in-memory Artifacts fake;
 * train runs are driven directly.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import type { ChecksGate } from '../src/services/checksGate';
import { defaultTrainDeps, runTrain, type TrainDeps } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'rv-owner';
const MAIN = 'refs/heads/main';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const sent: unknown[] = [];
const fakeEvents = {
  async send(body: unknown) {
    sent.push(body);
  },
  async sendBatch(msgs: Array<{ body: unknown }>) {
    for (const m of msgs) sent.push(m.body);
  },
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', human2: '', human3: '', reader: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

interface Reply {
  status: number;
  json: Record<string, any>;
  cost: CostCounters;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, cost: cost! };
}

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;

interface Agent {
  id: string;
  token: string;
  family: string | null;
}

async function agent(repo: string, name: string, modelFamily: string | null, creator = tok.owner): Promise<Agent> {
  const created = await call('POST', '/api/v1/agents', creator, { name, ...(modelFamily ? { modelFamily } : {}) });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  expect(created.json.agent.modelFamily).toBe(modelFamily);
  const minted = await call('POST', `/api/v1/agents/${created.json.agent.id}/tokens`, creator, {
    repo: `${OWNER}/${repo}`,
    role: 'write',
    refs: ['refs/heads/agents/*'],
  });
  expect(minted.status, JSON.stringify(minted.json)).toBe(201);
  return { id: created.json.agent.id as string, token: minted.json.token as string, family: modelFamily };
}

/** A public repo with main = README and `count` branches b<i> each adding f<i>.txt; writers human2/human3 hold write grants. */
async function setup(name: string, count = 1): Promise<{ repo: FakeRepo; main: string }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
       VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
    ).bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, now),
    ...['rv-human2', 'rv-human3'].map((login) =>
      env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
        id,
        userIds[login],
        'write',
        userIds[OWNER],
        now,
        now,
      ),
    ),
  ]);
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set(MAIN, main.sha);
  for (let i = 1; i <= count; i++) {
    const b = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i}\n` }, [main.sha]);
    repo.refs.set(`refs/heads/b${i}`, b.sha);
    repo.refs.set(`refs/heads/agents/b${i}`, b.sha);
  }
  return { repo, main: main.sha };
}

const createChange = (repo: string, head: string, token = tok.owner, mergePolicy = 'review') =>
  call('POST', api(repo, '/changes'), token, { title: `Change ${head}`, base: 'main', head, mergePolicy });
const setPolicy = (repo: string, requiredReviews: number, token = tok.owner) => call('PUT', api(repo, '/review-policy'), token, { requiredReviews });
const approve = (repo: string, n: number, token: string, body: Record<string, unknown> = {}) => call('POST', api(repo, `/changes/${n}/approve`), token, body);
const requestChanges = (repo: string, n: number, token: string, body: Record<string, unknown> = {}) =>
  call('POST', api(repo, `/changes/${n}/request-changes`), token, body);
const packet = (repo: string, n: number) => call('GET', api(repo, `/changes/${n}/reviews`), tok.owner);
const merge = (repo: string, n: number, token = tok.owner) => call('POST', api(repo, `/changes/${n}/merge`), token);
const enqueue = (repo: string, n: number, token = tok.owner) => call('POST', api(repo, `/changes/${n}/enqueue`), token);
const resolve = (repo: string, n: number, id: string, token: string, body: Record<string, unknown> = {}) =>
  call('POST', api(repo, `/changes/${n}/escalations/${id}/resolve`), token, body);
const openEscalation = async (repo: string, n: number, reason: string) =>
  ((await packet(repo, n)).json.escalations as Array<Record<string, any>>).find((e) => e.reason === reason && e.state === 'open');

function trainDeps(over: Partial<TrainDeps> = {}): TrainDeps {
  return { ...defaultTrainDeps, kick: async () => undefined, ...over };
}

function pushBody(repo: string, ref: string, before: string, after: string) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
}

/** Moves branch b<i> to a new commit and delivers the push event. */
async function moveHead(repo: FakeRepo, name: string, i: number, ref = `refs/heads/b${i}`): Promise<string> {
  const old = repo.refs.get(ref)!;
  const next = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i} v2\n` }, [old]);
  repo.refs.set(ref, next.sha);
  await deliver(pushBody(name, ref, old, next.sha));
  return next.sha;
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.human2 = (await mintPAT(env, await seedUser('rv-human2'), 'h2', FULL)).token;
  tok.human3 = (await mintPAT(env, await seedUser('rv-human3'), 'h3', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('rv-reader'), 'reader', FULL)).token;
});

afterAll(() => restoreFetch());

afterEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('review policy', () => {
  it('is unset by default (review merges unchanged), admin-only to change and validated', async () => {
    const { repo } = await setup('policy-unset');
    const unset = await call('GET', api('policy-unset', '/review-policy'), tok.reader);
    expect([unset.status, unset.json]).toEqual([200, { requiredReviews: 0, configured: false, updatedBy: null, updatedAt: null }]);
    expect((await createChange('policy-unset', 'b1')).status).toBe(201);
    const p = await packet('policy-unset', 1);
    expect(p.json).toMatchObject({ satisfied: true, blockers: [], approvals: { count: 0, required: 0 }, escalations: [] });
    expect((await merge('policy-unset', 1)).json.state).toBe('merged');
    expect(repo.refs.get(MAIN)).toBe(repo.refs.get('refs/heads/b1'));

    expect((await setPolicy('policy-unset', 2, tok.human2)).status).toBe(403);
    expect((await setPolicy('policy-unset', 11)).json.code).toBe('INVALID_REQUIRED_REVIEWS');
    expect((await call('PUT', api('policy-unset', '/review-policy'), tok.owner, { requiredReviews: 1.5 })).status).toBe(400);
    const set = await setPolicy('policy-unset', 2);
    expect([set.status, set.json]).toEqual([200, { requiredReviews: 2, configured: true, updatedBy: OWNER, updatedAt: expect.any(String) }]);
    const audit = await env.DB.prepare(`SELECT payload FROM events WHERE type = 'review_policy.updated' AND json_extract(payload, '$.repoId') = ?`)
      .bind(repoIds['policy-unset'])
      .first<{ payload: string }>();
    expect(JSON.parse(audit!.payload)).toMatchObject({ requiredReviews: 2, actor: OWNER });
  });

  it('requires N approvals of the current head from distinct principals other than the author; agents count, repeats do not', async () => {
    const { repo } = await setup('n-distinct');
    const claude = await agent('n-distinct', 'nd-claude', 'claude');
    const gpt = await agent('n-distinct', 'nd-gpt', 'gpt');
    await setPolicy('n-distinct', 2);
    expect((await createChange('n-distinct', 'b1')).status).toBe(201);
    const head = repo.refs.get('refs/heads/b1')!;

    const none = await merge('n-distinct', 1);
    expect([none.status, none.json.code]).toEqual([409, 'REVIEWS_REQUIRED']);
    expect(none.json.review).toMatchObject({ approvals: { count: 0, required: 2 }, openEscalations: [] });

    const self = await approve('n-distinct', 1, tok.owner);
    expect([self.status, self.json.code]).toEqual([409, 'SELF_REVIEW']);

    const first = await approve('n-distinct', 1, claude.token, { headSha: head, body: 'looks right' });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    expect(first.json.review).toMatchObject({
      principal: `agent:${claude.id}`,
      reviewer: { kind: 'agent', login: OWNER, agent: { id: claude.id, name: 'nd-claude' } },
      modelFamily: 'claude',
      differentFamily: true,
      verdict: 'approve',
      headSha: head,
      current: true,
      body: 'looks right',
    });
    expect(first.json.packet).toMatchObject({ approvals: { count: 1, required: 2 }, satisfied: false, author: { kind: 'user', modelFamily: 'human' } });
    const again = await approve('n-distinct', 1, claude.token);
    expect([again.status, again.json.created, again.json.packet.approvals.count]).toEqual([200, false, 1]);
    expect((await merge('n-distinct', 1)).json.code).toBe('REVIEWS_REQUIRED');

    const second = await approve('n-distinct', 1, gpt.token);
    expect(second.json.packet).toMatchObject({ approvals: { count: 2, required: 2 }, satisfied: true });
    // A human non-author counts as one more distinct principal, recorded with the human sentinel family.
    const human = await approve('n-distinct', 1, tok.human2);
    expect(human.json.review).toMatchObject({ principal: `user:${userIds['rv-human2']}`, modelFamily: 'human', differentFamily: false });
    expect(human.json.packet.approvals).toEqual({ count: 3, required: 2, humans: 1, humansRequired: 0 });
    expect((await merge('n-distinct', 1)).json.state).toBe('merged');
  });

  it('rejects malformed reviews and reviews of closed changes', async () => {
    await setup('bad-review');
    await createChange('bad-review', 'b1');
    expect((await call('POST', api('bad-review', '/changes/1/reviews'), tok.human2, { verdict: 'lgtm' })).json.code).toBe('INVALID_VERDICT');
    expect((await approve('bad-review', 1, tok.human2, { headSha: 'abc' })).json.code).toBe('INVALID_HEAD_SHA');
    expect((await approve('bad-review', 9, tok.human2)).status).toBe(404);
    expect((await approve('bad-review', 1, tok.reader)).status).toBe(403);
    const generic = await call('POST', api('bad-review', '/changes/1/reviews'), tok.human2, { verdict: 'request-changes' });
    expect([generic.status, generic.json.review.verdict]).toEqual([201, 'request-changes']);
    await call('PATCH', api('bad-review', '/changes/1'), tok.owner, { state: 'closed' });
    expect((await approve('bad-review', 1, tok.human3)).json.code).toBe('CHANGE_NOT_OPEN');
  });
});

describe('model families and assignment', () => {
  it('records the agent modelFamily, refuses agent self-review and prefers a different family than the author', async () => {
    await setup('family');
    expect((await call('POST', '/api/v1/agents', tok.owner, { name: 'fam-bad', modelFamily: 'Not Valid' })).json.code).toBe('INVALID_MODEL_FAMILY');
    expect((await call('POST', '/api/v1/agents', tok.owner, { name: 'fam-human', modelFamily: 'human' })).json.code).toBe('INVALID_MODEL_FAMILY');
    const author = await agent('family', 'fam-author', 'claude');
    const sameFamily = await agent('family', 'fam-claude', 'claude');
    const other = await agent('family', 'fam-gpt', 'gpt');
    const unknown = await agent('family', 'fam-none', null);
    expect((await call('GET', `/api/v1/agents/${author.id}`, tok.owner)).json.agent.modelFamily).toBe('claude');

    const created = await createChange('family', 'agents/b1', author.token);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const self = await approve('family', 1, author.token);
    expect([self.status, self.json.code]).toEqual([409, 'SELF_REVIEW']);

    const assigned = await call('POST', api('family', '/changes/1/reviewers/assign'), tok.owner, {});
    expect(assigned.status).toBe(200);
    expect(assigned.json.author).toMatchObject({ kind: 'agent', principal: `agent:${author.id}`, modelFamily: 'claude' });
    // Agent model families are self-declared, so the cross-model claim is labeled declared.
    expect(assigned.json.preference).toEqual({ rule: 'different-model-family', authorModelFamily: 'claude', met: true, evidence: 'declared' });
    expect(assigned.json.assigned).toMatchObject({ principal: `agent:${other.id}`, modelFamily: 'gpt', differentFamily: true, eligible: true });
    const byId = Object.fromEntries((assigned.json.candidates as Array<Record<string, any>>).map((c) => [c.agent.id, c]));
    expect(byId[author.id]).toMatchObject({ eligible: false, ineligibleReason: 'author' });
    expect(byId[sameFamily.id]).toMatchObject({ eligible: true, differentFamily: false, modelFamily: 'claude' });
    expect(byId[unknown.id]).toMatchObject({ eligible: true, differentFamily: false, modelFamily: null });

    // Only same-family candidates: still assigned, and the unmet preference is reported.
    const only = await call('POST', api('family', '/changes/1/reviewers/assign'), tok.owner, { candidates: [sameFamily.id, author.id] });
    expect(only.json.assigned).toMatchObject({ principal: `agent:${sameFamily.id}` });
    expect(only.json.preference.met).toBe(false);

    const same = await approve('family', 1, sameFamily.token);
    expect(same.json.review).toMatchObject({ modelFamily: 'claude', differentFamily: false });
    const diff = await approve('family', 1, other.token);
    expect(diff.json.review).toMatchObject({ modelFamily: 'gpt', differentFamily: true });
    const none = await approve('family', 1, unknown.token);
    expect(none.json.review).toMatchObject({ modelFamily: null, differentFamily: false });
    const after = await call('POST', api('family', '/changes/1/reviewers/assign'), tok.owner, {});
    expect(after.json.assigned).toBeNull();
    expect(byIdOf(after.json.candidates)[other.id]).toMatchObject({ eligible: false, ineligibleReason: 'already-reviewed' });
  });
});

function byIdOf(cands: Array<Record<string, any>>): Record<string, Record<string, any>> {
  return Object.fromEntries(cands.map((c) => [c.agent.id, c]));
}

describe('escalations', () => {
  it('reviewer disagreement blocks merge and enqueue until a human approves the current head', async () => {
    const { repo, main } = await setup('disagree');
    const claude = await agent('disagree', 'dis-claude', 'claude');
    const gpt = await agent('disagree', 'dis-gpt', 'gpt');
    await setPolicy('disagree', 1);
    await createChange('disagree', 'b1');
    expect((await approve('disagree', 1, claude.token)).json.packet.satisfied).toBe(true);
    const block = await requestChanges('disagree', 1, gpt.token, { body: 'breaks parsing' });
    expect(block.status).toBe(201);
    expect(block.json.packet.escalations).toEqual([
      expect.objectContaining({ reason: 'reviewer-disagreement', state: 'open', openedBy: `agent:${gpt.id}`, headSha: repo.refs.get('refs/heads/b1') }),
    ]);

    const m = await merge('disagree', 1);
    expect([m.status, m.json.code, m.json.review.openEscalations]).toEqual([409, 'ESCALATION_OPEN', ['reviewer-disagreement']]);
    const e = await enqueue('disagree', 1);
    expect([e.status, e.json.code]).toEqual([409, 'ESCALATION_OPEN']);
    expect(repo.refs.get(MAIN)).toBe(main);

    const esc = await openEscalation('disagree', 1, 'reviewer-disagreement');
    const byAgent = await resolve('disagree', 1, esc!.id, claude.token);
    expect([byAgent.status, byAgent.json.code]).toEqual([403, 'HUMAN_REQUIRED']);
    // Another agent approval does not answer for a human.
    await approve('disagree', 1, (await agent('disagree', 'dis-other', 'gemini')).token);
    expect((await merge('disagree', 1)).json.code).toBe('ESCALATION_OPEN');

    const human = await approve('disagree', 1, tok.human2);
    expect(human.json.packet.escalations[0]).toMatchObject({ state: 'resolved', resolution: 'approve', resolvedBy: 'rv-human2' });
    expect(human.json.packet.satisfied).toBe(true);
    expect((await merge('disagree', 1)).json.state).toBe('merged');
  });

  it('a lone request-changes is a block a human acknowledges; a later disagreement escalates again', async () => {
    await setup('blocked');
    const claude = await agent('blocked', 'blk-claude', 'claude');
    const gpt = await agent('blocked', 'blk-gpt', 'gpt');
    await setPolicy('blocked', 1);
    await createChange('blocked', 'b1');
    await requestChanges('blocked', 1, gpt.token);
    const esc = await openEscalation('blocked', 1, 'review-blocked');
    expect(esc).toMatchObject({ detail: 'request-changes by blk-gpt' });
    const m = await merge('blocked', 1);
    expect(m.json.review.blockers.map((b: any) => b.code)).toEqual(['ESCALATION_OPEN', 'REVIEWS_REQUIRED']);

    expect((await resolve('blocked', 1, esc!.id, tok.human2, { resolution: 'nope' })).json.code).toBe('INVALID_RESOLUTION');
    const ack = await resolve('blocked', 1, esc!.id, tok.human2, { resolution: 'acknowledge', note: 'addressed offline' });
    expect(ack.status).toBe(200);
    expect(ack.json.escalation).toMatchObject({ state: 'resolved', resolution: 'acknowledge', resolvedBy: 'rv-human2', note: 'addressed offline' });
    expect((await resolve('blocked', 1, esc!.id, tok.human2)).json.code).toBe('ESCALATION_RESOLVED');
    expect((await resolve('blocked', 1, 'nope', tok.human2)).json.code).toBe('ESCALATION_NOT_FOUND');
    expect((await merge('blocked', 1)).json.code).toBe('REVIEWS_REQUIRED');

    // An approval next to the standing request-changes is a disagreement for a human again.
    const app = await approve('blocked', 1, claude.token);
    expect(app.json.packet.escalations.filter((e: any) => e.state === 'open').map((e: any) => e.reason)).toEqual(['reviewer-disagreement']);
    expect((await merge('blocked', 1)).json.code).toBe('ESCALATION_OPEN');
    await approve('blocked', 1, tok.human3);
    expect((await merge('blocked', 1)).json.state).toBe('merged');
  });

  it('an auto change merges once a review satisfies its gate, not before', async () => {
    const { repo, main } = await setup('auto');
    const claude = await agent('auto', 'auto-claude', 'claude');
    await setPolicy('auto', 1);
    const c = await createChange('auto', 'b1', tok.owner, 'auto');
    expect(c.json.state).toBe('open');
    expect(repo.refs.get(MAIN)).toBe(main);
    const r = await approve('auto', 1, claude.token);
    expect(r.json.packet.state).toBe('merged');
    expect(repo.refs.get(MAIN)).toBe(repo.refs.get('refs/heads/b1'));
  });
});

describe('protected targets', () => {
  it('agent and self approvals never satisfy the human requirement; an independent human approval does', async () => {
    const { repo, main } = await setup('protected', 2);
    const claude = await agent('protected', 'pr-claude', 'claude');
    // Minted by another human: still an agent principal, never the human the rule asks for.
    const gpt = await agent('protected', 'pr-gpt', 'gpt', tok.human3);
    const author = await agent('protected', 'pr-author', 'gemini');
    await setPolicy('protected', 1);
    expect((await call('POST', api('protected', '/branch-rules'), tok.owner, { pattern: 'main', requiredApprovals: 1 })).status).toBe(201);

    // A human-authored change: self-approval is refused, agent approvals count for the policy but not for the human rule.
    await createChange('protected', 'b1');
    expect((await approve('protected', 1, tok.owner)).json.code).toBe('SELF_REVIEW');
    await approve('protected', 1, claude.token);
    await approve('protected', 1, gpt.token);
    const m = await merge('protected', 1);
    expect([m.status, m.json.code]).toEqual([409, 'APPROVALS_REQUIRED']);
    expect(m.json.error).toMatch(/1 approving review/);
    expect(m.json.review).toMatchObject({ approvals: { count: 2, required: 1, humans: 0, humansRequired: 1 }, openEscalations: ['protected-path'] });
    const e = await enqueue('protected', 1);
    expect([e.status, e.json.code]).toEqual([409, 'APPROVALS_REQUIRED']);
    const p = await packet('protected', 1);
    expect(p.json.policy).toMatchObject({ protected: true, humanApprovalsRequired: 1, requiredReviews: 1 });
    expect(p.json.escalations).toEqual([expect.objectContaining({ reason: 'protected-path', state: 'open', openedBy: 'system' })]);
    // A human resolving the escalation is not a human approval.
    await resolve('protected', 1, p.json.escalations[0].id, tok.human2);
    expect((await merge('protected', 1)).json.code).toBe('APPROVALS_REQUIRED');
    expect(repo.refs.get(MAIN)).toBe(main);
    await approve('protected', 1, tok.human2);
    expect((await merge('protected', 1)).json.state).toBe('merged');

    // An agent-authored change: the agent's minting human is not independent of it either.
    expect((await createChange('protected', 'agents/b2', author.token)).status).toBe(201);
    await approve('protected', 2, claude.token);
    const minted = await approve('protected', 2, tok.owner);
    expect(minted.status).toBe(201);
    expect(minted.json.packet.approvals).toMatchObject({ count: 2, humans: 0, humansRequired: 1 });
    expect(minted.json.packet.escalations.filter((x: any) => x.state === 'open').map((x: any) => x.reason)).toEqual(['protected-path']);
    expect((await merge('protected', 2)).json.code).toBe('APPROVALS_REQUIRED');
    const indep = await approve('protected', 2, tok.human3);
    expect(indep.json.packet).toMatchObject({ satisfied: true, approvals: { humans: 1 } });
    expect(indep.json.packet.escalations[0]).toMatchObject({ reason: 'protected-path', state: 'resolved', resolution: 'approve' });
  });
});

describe('exact-head approvals', () => {
  it('a head movement stales approvals; reapproving the exact new head unblocks', async () => {
    const { repo } = await setup('stale');
    const claude = await agent('stale', 'st-claude', 'claude');
    await setPolicy('stale', 1);
    await createChange('stale', 'b1');
    const old = repo.refs.get('refs/heads/b1')!;
    await approve('stale', 1, claude.token, { headSha: old });
    const next = await moveHead(repo, 'stale', 1);
    const p = await packet('stale', 1);
    expect(p.json).toMatchObject({ headSha: next, approvals: { count: 0, required: 1 }, satisfied: false });
    expect(p.json.reviews).toEqual([expect.objectContaining({ headSha: old, current: false })]);
    expect((await merge('stale', 1)).json.code).toBe('REVIEWS_REQUIRED');
    const late = await approve('stale', 1, claude.token, { headSha: old });
    expect([late.status, late.json.code, late.json.headSha]).toEqual([409, 'HEAD_MOVED', next]);
    expect((await approve('stale', 1, claude.token, { headSha: next })).status).toBe(201);
    expect((await merge('stale', 1)).json).toMatchObject({ state: 'merged', mergeCommit: next });
  });

  it('enqueue approves the head but never stands in for a required review; the train revalidates before publication', async () => {
    const { repo, main } = await setup('train', 2);
    const claude = await agent('train', 'tr-claude', 'claude');
    const gpt = await agent('train', 'tr-gpt', 'gpt');
    await setPolicy('train', 1);
    await createChange('train', 'b1');
    await createChange('train', 'b2');
    const refused = await enqueue('train', 1);
    expect([refused.status, refused.json.code]).toEqual([409, 'REVIEWS_REQUIRED']);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM merge_queue WHERE repo_id = ?').bind(repoIds.train).first<{ n: number }>())!.n).toBe(0);

    await approve('train', 1, claude.token);
    await approve('train', 2, claude.token);
    expect((await enqueue('train', 1)).status).toBe(201);
    expect((await enqueue('train', 2)).status).toBe(201);
    // After enqueue: change 1 gets a blocking review, change 2's reviewer is revoked.
    await requestChanges('train', 1, gpt.token);
    expect((await call('DELETE', `/api/v1/agents/${claude.id}`, tok.owner)).status).toBe(200);
    const run = await runTrain(env, repoIds.train!, MAIN, trainDeps());
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([
      { number: 1, code: 'ESCALATION_OPEN' },
      { number: 2, code: 'REVIEWS_REQUIRED' },
    ]);
    expect(repo.refs.get(MAIN)).toBe(main);

    // A human approval of the exact head (resolving the escalation) and a fresh review requeue both.
    await approve('train', 1, tok.human2, { headSha: repo.refs.get('refs/heads/b1') });
    await approve('train', 2, gpt.token);
    expect((await enqueue('train', 1)).status).toBe(201);
    expect((await enqueue('train', 2)).status).toBe(201);
    const again = await runTrain(env, repoIds.train!, MAIN, trainDeps());
    expect(again.published).toEqual([1, 2]);
  });

  it('a blocking review that lands while checks run stops publication of the checked candidate', async () => {
    const { repo, main } = await setup('late-block');
    const claude = await agent('late-block', 'lb-claude', 'claude');
    const gpt = await agent('late-block', 'lb-gpt', 'gpt');
    await setPolicy('late-block', 1);
    await createChange('late-block', 'b1');
    await approve('late-block', 1, claude.token);
    expect((await enqueue('late-block', 1)).status).toBe(201);
    let reviewed = false;
    const gate: ChecksGate = {
      async requiredChecksFor(_repo, treeSha, configId) {
        if (!reviewed) {
          reviewed = true;
          expect((await requestChanges('late-block', 1, gpt.token)).status).toBe(201);
        }
        return { treeSha, configId, required: [{ name: 'ci/test', state: 'success', producer: 'test' }], state: 'success' };
      },
    };
    const run = await runTrain(env, repoIds['late-block']!, MAIN, trainDeps({ gate: () => gate }));
    expect(reviewed).toBe(true);
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([{ number: 1, code: 'ESCALATION_OPEN' }]);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect((await call('GET', api('late-block', '/changes/1'), tok.owner)).json.state).toBe('open');
  });

  it('enqueue into a protected target needs the human approval; once given it is admitted and published', async () => {
    const { repo } = await setup('train-protected');
    const claude = await agent('train-protected', 'tp-claude', 'claude');
    expect((await call('POST', api('train-protected', '/branch-rules'), tok.owner, { pattern: 'main', requiredApprovals: 1 })).status).toBe(201);
    await createChange('train-protected', 'b1');
    await approve('train-protected', 1, claude.token);
    const e = await enqueue('train-protected', 1);
    expect([e.status, e.json.code, e.json.review.openEscalations]).toEqual([409, 'APPROVALS_REQUIRED', ['protected-path']]);
    await approve('train-protected', 1, tok.human2);
    const ok = await enqueue('train-protected', 1);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const run = await runTrain(env, repoIds['train-protected']!, MAIN, trainDeps());
    expect(run.published).toEqual([1]);
    expect(repo.refs.get(MAIN)).toBe(repo.refs.get('refs/heads/b1'));
  });
});

describe('pending reviews and budgets', () => {
  it('lists changes short of reviews or with an open escalation, paged', async () => {
    await setup('pending', 3);
    const claude = await agent('pending', 'pe-claude', 'claude');
    const gpt = await agent('pending', 'pe-gpt', 'gpt');
    await setPolicy('pending', 1);
    for (const b of ['b1', 'b2', 'b3']) await createChange('pending', b);
    await approve('pending', 1, claude.token);
    await approve('pending', 2, claude.token);
    await requestChanges('pending', 2, gpt.token);
    const list = await call('GET', api('pending', '/reviews/pending?limit=1'), tok.reader);
    expect(list.status).toBe(200);
    expect(list.json.changes).toEqual([expect.objectContaining({ number: 3, approvals: { count: 0, required: 1 }, openEscalations: [] })]);
    const next = await call('GET', api('pending', `/reviews/pending?limit=5&cursor=${list.json.nextCursor}`), tok.reader);
    expect(next.json.changes).toEqual([expect.objectContaining({ number: 2, approvals: { count: 1, required: 1 }, openEscalations: ['reviewer-disagreement'] })]);
    expect(next.json.nextCursor).toBeNull();
    expect((await call('GET', api('pending', '/reviews/pending?limit=0'), tok.reader)).json.code).toBe('INVALID_LIMIT');
  });

  it('keeps review reads and writes within bounded work', async () => {
    await setup('budget');
    const claude = await agent('budget', 'bu-claude', 'claude');
    await setPolicy('budget', 1);
    await createChange('budget', 'b1');
    const a = await approve('budget', 1, claude.token);
    const p = await packet('budget', 1);
    const pend = await call('GET', api('budget', '/reviews/pending'), tok.owner);
    const assign = await call('POST', api('budget', '/changes/1/reviewers/assign'), tok.owner, {});
    expect(a.cost).toMatchObject({ art: 0, do: 0 });
    expect(a.cost.d1).toBeLessThanOrEqual(3);
    for (const r of [p, pend, assign]) {
      expect(r.cost).toMatchObject({ art: 0, do: 0, rw: 0 });
      expect(r.cost.d1).toBeLessThanOrEqual(2);
    }
  });
});
