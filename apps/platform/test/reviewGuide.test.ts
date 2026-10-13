import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { defaultTrainDeps, runTrain } from '../src/services/queue';
import { attentionFor, type AttentionFacts } from '../src/services/attention';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'review-guide-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const MAIN = 'refs/heads/main';
const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: { async send() {}, async sendBatch() {} } as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: { async create({ id }: { id?: string }) { return { id: id ?? crypto.randomUUID() }; }, async get(id: string) { return { id }; } } as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;
const tokens = { owner: '', reviewer: '' };
const repoIds: Record<string, string> = {};
const costs: Record<string, CostCounters> = {};
const api = (repo: string, path: string) => `/api/v1/repos/${OWNER}/${repo}${path}`;

async function call(method: string, path: string, token: string, body?: unknown) {
  const ctx = createExecutionContext();
  const response = await worker.fetch!(
    new Request(`https://kvarm.test${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(response.headers.get(COST_HEADER));
  expect(cost, response.headers.get(COST_HEADER) ?? undefined).not.toBeNull();
  return { status: response.status, json: JSON.parse(text) as Record<string, any>, cost: cost! };
}

async function setup(name: string, changedPath = 'src/a.ts', contracts: string[] = []) {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  const now = Date.now();
  const reviewerId = await env.DB.prepare('SELECT id FROM users WHERE login = ?1').bind(`${OWNER}-reviewer`).first<{ id: string }>();
  const ownerId = await env.DB.prepare('SELECT id FROM users WHERE login = ?1').bind(OWNER).first<{ id: string }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`).bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, now),
    env.DB.prepare(`INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, 'write', ?, ?, ?)`)
      .bind(id, reviewerId!.id, ownerId!.id, now, now),
  ]);
  const base = await commit(repo, {
    'README.md': 'base\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    '.kvarm/review.json': JSON.stringify({ contracts }),
  });
  const head = await commit(repo, {
    'README.md': 'base\n',
    'src/a.ts': 'export const a = 2;\n',
    'src/b.ts': 'export const b = 2;\n',
    '.kvarm/review.json': JSON.stringify({ contracts }),
    ...(changedPath.startsWith('apps/platform/migrations/') ? { [changedPath]: 'CREATE TABLE example (id TEXT);\n' } : {}),
  }, [base.sha]);
  repo.refs.set(MAIN, base.sha);
  repo.refs.set('refs/heads/feature', head.sha);
  return { repo, base: base.sha, head: head.sha, repoId: id };
}

async function openChange(name: string, token = tokens.owner) {
  return call('POST', api(name, '/changes'), token, { title: `Review ${name}`, base: 'main', head: 'feature', mergePolicy: 'review' });
}

function pushBody(name: string, before: string, after: string) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${name}` },
    payload: { ref: 'refs/heads/feature', before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
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

beforeAll(async () => {
  installFakeGitRemote();
  for (const login of [OWNER, `${OWNER}-reviewer`]) {
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now()).run();
    const minted = await mintPAT(env, id, login, FULL);
    if (login === OWNER) tokens.owner = minted.token;
    else tokens.reviewer = minted.token;
  }
});
afterAll(() => restoreFetch());

describe('guided review endpoints', () => {
  it('serves fallback, validates guides, carries acknowledgements, filters since/unacked, and reads config at base', async () => {
    const { repo, head } = await setup('guide-flow');
    expect((await openChange('guide-flow')).status).toBe(201);
    const path = api('guide-flow', '/changes/1/review-guide');
    const fallback = await call('GET', path, tokens.owner);
    costs['GET review guide'] = fallback.cost;
    expect(fallback.json.source).toBe('fallback');
    const units = fallback.json.units as Array<{ key: string; path: string; floor: string }>;
    expect(units.length).toBeGreaterThan(1);
    const first = units.find((unit) => unit.path === 'src/a.ts')!;
    const guide = { intent: 'change values', chapters: [{ id: 'main', title: 'Core', tier: 'read', hunks: [first.key] }] };
    const stale = await call('POST', path, tokens.owner, { headSha: '0'.repeat(40), guide });
    expect([stale.status, stale.json.code]).toEqual([409, 'HEAD_MOVED']);
    const unknown = await call('POST', path, tokens.owner, { headSha: head, guide: { ...guide, chapters: [{ ...guide.chapters[0], hunks: ['h_unknown'] }] } });
    expect([unknown.status, unknown.json.code]).toEqual([422, 'INVALID_GUIDE']);
    const submitted = await call('POST', path, tokens.owner, { headSha: head, guide });
    costs['POST submit guide'] = submitted.cost;
    expect(submitted.status).toBe(201);
    expect(submitted.json.guide.coverage.gaps).toBeGreaterThan(0);
    expect(submitted.json.guide.guide.chapters.some((chapter: { id: string }) => chapter.id === 'unguided')).toBe(true);
    const ack = await call('POST', api('guide-flow', '/changes/1/review-acks'), tokens.reviewer, { headSha: head, keys: [first.key] });
    costs['POST review ack'] = ack.cost;
    expect(ack.status).toBe(200);
    const unacked = await call('GET', `${path}?unacked=true`, tokens.reviewer);
    expect((unacked.json.units as Array<{ path: string }>).some((unit) => unit.path === 'src/a.ts')).toBe(false);
    const next = await commit(repo, {
      'README.md': 'base\n',
      'src/a.ts': 'export const a = 2;\n',
      'src/b.ts': 'export const b = 3;\n',
      '.kvarm/review.json': JSON.stringify({ contracts: [], receipts: ['src/**'] }),
    }, [head]);
    repo.refs.set('refs/heads/feature', next.sha);
    await deliver(pushBody('guide-flow', head, next.sha));
    const carried = await call('GET', path, tokens.reviewer);
    expect(carried.json.source).toBe('carried');
    expect((carried.json.units as Array<{ path: string; acked: boolean }>).find((unit) => unit.path === 'src/a.ts')?.acked).toBe(true);
    expect((carried.json.units as Array<{ path: string; floor: string }>).find((unit) => unit.path === 'src/a.ts')?.floor).not.toBe('receipt');
    const since = await call('GET', `${path}?since=${head}`, tokens.owner);
    const sincePaths = (since.json.units as Array<{ path: string }>).map((unit) => unit.path);
    expect(sincePaths).toContain('src/b.ts');
    expect(sincePaths).toContain('.kvarm/review.json');
    expect(sincePaths).not.toContain('src/a.ts');
  });

  it('selects a reviewer-authored guide when the author has not submitted one', async () => {
    const { head } = await setup('reviewer-guide');
    await openChange('reviewer-guide');
    const path = api('reviewer-guide', '/changes/1/review-guide');
    const map = await call('GET', path, tokens.owner);
    const unit = (map.json.units as Array<{ key: string }>)[0]!;
    const guide = await call('POST', path, tokens.reviewer, {
      headSha: head,
      guide: { intent: 'reviewer perspective', chapters: [{ id: 'review', title: 'Review', tier: 'read', hunks: [unit.key] }] },
    });
    expect(guide.status).toBe(201);
    const selected = await call('GET', path, tokens.owner);
    expect(selected.json.source).toBe('reviewer');
  });

  it('deduplicates and suppresses findings, enforces author permissions, and gates merge/train until resolution', async () => {
    const { head } = await setup('finding-flow');
    await openChange('finding-flow');
    const findingsPath = api('finding-flow', '/changes/1/findings');
    const low = { path: 'src/a.ts', startLine: 1, category: 'bug', severity: 'low', confidence: 'investigate', title: 'small issue' };
    const first = await call('POST', findingsPath, tokens.owner, { headSha: head, findings: [low] });
    costs['POST submit findings'] = first.cost;
    const id = first.json.created[0].id as string;
    const duplicate = await call('POST', findingsPath, tokens.reviewer, { headSha: head, findings: [{ ...low, title: ' Small   Issue ' }] });
    expect(duplicate.json.duplicates).toContain(id);
    const update = await call('PATCH', `${findingsPath}/${id}`, tokens.owner, { status: 'irrelevant' });
    costs['PATCH finding'] = update.cost;
    const suppressed = await call('POST', findingsPath, tokens.reviewer, { headSha: head, findings: [low] });
    expect(suppressed.json.suppressed).toContain(id);
    const list = await call('GET', `${findingsPath}?status=all`, tokens.owner);
    costs['GET findings'] = list.cost;
    expect(list.json.findings).toHaveLength(1);

    const blocking = await call('POST', findingsPath, tokens.owner, {
      headSha: head,
      findings: [{ ...low, severity: 'high', confidence: 'confirmed', title: 'critical path is unsafe' }],
    });
    const blockingId = blocking.json.created[0].id as string;
    const mergePath = api('finding-flow', '/changes/1/merge');
    expect((await call('POST', mergePath, tokens.owner)).json.code).toBe('FINDINGS_OPEN');
    expect((await call('PATCH', `${findingsPath}/${blockingId}`, tokens.owner, { status: 'resolved' })).status).toBe(403);
    const resolved = await call('PATCH', `${findingsPath}/${blockingId}`, tokens.reviewer, { status: 'resolved' });
    costs['PATCH finding (resolve)'] = resolved.cost;
    expect(resolved.json.status).toBe('resolved');
    expect((await call('POST', mergePath, tokens.owner)).json.state).toBe('merged');
  });

  it('requires current-head guides and declared contract surfaces, and lists attention', async () => {
    const migration = 'apps/platform/migrations/0999_example.sql';
    const { head, repoId } = await setup('contract-flow', migration, ['apps/platform/migrations/**']);
    await openChange('contract-flow');
    const policy = await call('PUT', api('contract-flow', '/review-policy'), tokens.owner, { guideRequired: true });
    expect(policy.status).toBe(200);
    const mergePath = api('contract-flow', '/changes/1/merge');
    expect((await call('POST', mergePath, tokens.owner)).json.code).toBe('GUIDE_REQUIRED');
    const enqueuePath = api('contract-flow', '/changes/1/enqueue');
    expect((await call('POST', enqueuePath, tokens.owner, { headSha: head })).json.code).toBe('GUIDE_REQUIRED');
    const guidePath = api('contract-flow', '/changes/1/review-guide');
    const map = await call('GET', guidePath, tokens.owner);
    const waiting = await call('GET', api('contract-flow', '/attention?mine=true'), tokens.owner);
    expect(waiting.json.changes).toEqual([expect.objectContaining({ number: 1, yourTurn: true, attention: { waitingOn: 'author', reasons: ['guide-required'] } })]);
    const unit = (map.json.units as Array<{ key: string }>)[0]!;
    const undeclared = await call('POST', guidePath, tokens.owner, {
      headSha: head,
      guide: { intent: 'migration', chapters: [{ id: 'migration', title: 'Migration', tier: 'scrutinize', hunks: [unit.key] }] },
    });
    expect(undeclared.status).toBe(201);
    expect((await call('POST', mergePath, tokens.owner)).json.code).toBe('CONTRACT_UNDECLARED');
    expect((await call('POST', enqueuePath, tokens.owner, { headSha: head })).json.code).toBe('CONTRACT_UNDECLARED');
    const declared = await call('POST', guidePath, tokens.owner, {
      headSha: head,
      guide: { intent: 'migration', chapters: [{ id: 'migration', title: 'Migration', tier: 'scrutinize', hunks: [unit.key] }], contracts: [{ surface: migration, impact: 'additive' }] },
    });
    expect(declared.status).toBe(200);
    expect((await call('POST', enqueuePath, tokens.owner, { headSha: head })).status).toBe(201);
    const published = await runTrain(env, repoId, MAIN, { ...defaultTrainDeps, kick: async () => undefined });
    expect(published.published).toEqual([1]);
    const attention = await call('GET', api('contract-flow', '/attention?mine=true'), tokens.owner);
    costs['GET attention'] = attention.cost;
    expect(Array.isArray(attention.json.changes)).toBe(true);
  });

  it('keeps the queue publication gate aligned with open blocking findings', async () => {
    const { head, repoId } = await setup('queue-finding');
    await openChange('queue-finding');
    const enqueuePath = api('queue-finding', '/changes/1/enqueue');
    expect((await call('POST', enqueuePath, tokens.owner, { headSha: head })).status).toBe(201);
    const findingsPath = api('queue-finding', '/changes/1/findings');
    const submitted = await call('POST', findingsPath, tokens.owner, {
      headSha: head,
      findings: [{ path: 'src/a.ts', startLine: 1, category: 'bug', severity: 'high', confidence: 'confirmed', title: 'queue blocker' }],
    });
    const id = submitted.json.created[0].id as string;
    const deps = { ...defaultTrainDeps, kick: async () => undefined };
    const blocked = await runTrain(env, repoId, MAIN, deps);
    expect(blocked.ejected).toEqual([{ number: 1, code: 'FINDINGS_OPEN' }]);
    expect((await call('PATCH', `${findingsPath}/${id}`, tokens.reviewer, { status: 'resolved' })).status).toBe(200);
    expect((await call('POST', enqueuePath, tokens.owner, { headSha: head })).status).toBe(201);
    const published = await runTrain(env, repoId, MAIN, deps);
    expect(published.published).toEqual([1]);
  });

  it('classifies attention transitions in gate precedence order', () => {
    const base: AttentionFacts = {
      state: 'open',
      escalations: [],
      checksPending: false,
      checksFailing: false,
      blockingFindings: 0,
      requestChanges: false,
      guideRequired: false,
      guidePresent: false,
      undeclared: 0,
      approvals: 1,
      required: 1,
      humans: 0,
      humansRequired: 0,
      mergePolicy: 'review',
    };
    expect(attentionFor({ ...base, escalations: ['protected-path'], checksPending: true }).waitingOn).toBe('human');
    expect(attentionFor({ ...base, checksPending: true, blockingFindings: 1 }).waitingOn).toBe('checks');
    expect(attentionFor({ ...base, blockingFindings: 1 }).waitingOn).toBe('author');
    expect(attentionFor({ ...base, checksFailing: true }).reasons).toEqual(['checks-failing']);
    expect(attentionFor({ ...base, requestChanges: true }).reasons).toEqual(['request-changes']);
    expect(attentionFor({ ...base, guideRequired: true, guidePresent: false }).reasons).toEqual(['guide-required']);
    expect(attentionFor({ ...base, guideRequired: true, guidePresent: true, undeclared: 1 }).reasons).toEqual(['contract-undeclared']);
    expect(attentionFor({ ...base, approvals: 0, required: 2 }).waitingOn).toBe('reviewers');
    expect(attentionFor({ ...base, mergePolicy: 'auto', queueState: 'checking' }).waitingOn).toBe('queue');
    expect(attentionFor({ ...base, state: 'merged', blockingFindings: 1 })).toEqual({ waitingOn: 'none', reasons: [] });
  });

  it('prints measured x-kvarm-cost counters for each new endpoint', () => {
    expect(costs).toEqual(expect.objectContaining({
      'GET review guide': expect.any(Object),
      'POST submit guide': expect.any(Object),
      'POST review ack': expect.any(Object),
      'POST submit findings': expect.any(Object),
      'GET findings': expect.any(Object),
      'PATCH finding (resolve)': expect.any(Object),
      'GET attention': expect.any(Object),
    }));
    console.log(JSON.stringify({ reviewGuideCosts: costs }));
  });
});
