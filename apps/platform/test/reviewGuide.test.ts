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

async function setup(
  name: string,
  changedPath = 'src/a.ts',
  contracts: string[] = [],
  overrides: { base?: Record<string, string>; head?: Record<string, string> } = {},
) {
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
  const baseFiles = {
    'README.md': 'base\n',
    'src/a.ts': 'export const a = 1;\n',
    'src/b.ts': 'export const b = 1;\n',
    '.kvarm/review.json': JSON.stringify({ contracts }),
    ...overrides.base,
  };
  const headFiles = {
    ...baseFiles,
    'src/a.ts': 'export const a = 2;\n',
    'src/b.ts': 'export const b = 2;\n',
    ...overrides.head,
    ...(changedPath.startsWith('apps/platform/migrations/') ? { [changedPath]: 'CREATE TABLE example (id TEXT);\n' } : {}),
  };
  const base = await commit(repo, baseFiles);
  const head = await commit(repo, headFiles, [base.sha]);
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
  it('lists import consumers and test evidence, and serves warm impact from cache', async () => {
    await setup('impact-flow', 'src/a.ts', ['src/*.ts'], {
      base: {
        'src/use.ts': "import { a } from './a';\nexport const useA = a;\n",
        'tests/a.test.ts': "import { a } from '../src/a';\n",
      },
    });
    await openChange('impact-flow');
    const path = api('impact-flow', '/changes/1/review/impact');
    const cold = await call('GET', path, tokens.owner);
    costs['GET review impact cold'] = cold.cost;
    expect(cold.status).toBe(200);
    const file = (cold.json.files as Array<{ path: string; consumers: Array<{ path: string; line: number; specifier: string; test: boolean }>; affected: Array<{ name: string }>; tests: string[] }>).find((item) => item.path === 'src/a.ts')!;
    expect(file.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'src/use.ts', line: 1, specifier: './a', test: false }),
      expect.objectContaining({ path: 'tests/a.test.ts', line: 1, specifier: '../src/a', test: true }),
    ]));
    expect(file.affected).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'a', path: 'src/use.ts' })]));
    expect(file.tests).toContain('tests/a.test.ts');
    const warm = await call('GET', path, tokens.owner);
    costs['GET review impact warm'] = warm.cost;
    expect(warm.cost.art).toBe(0);
    expect(warm.json).toEqual(cold.json);
  });

  it('resolves package and subpath imports from app workspaces declared at the root', async () => {
    await setup('impact-app-workspace', 'packages/lib/src/index.ts', [], {
      base: {
        'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
        'packages/lib/package.json': JSON.stringify({
          name: '@kvarm/lib',
          exports: { '.': './src/index.ts', './subpath': './src/subpath.ts' },
        }),
        'packages/lib/src/index.ts': 'export const value = 1;\n',
        'packages/lib/src/subpath.ts': 'export const extra = 1;\n',
        'apps/web/package.json': JSON.stringify({ name: 'web' }),
        'apps/web/src/use.ts': "import { value } from '@kvarm/lib';\nimport { extra } from '@kvarm/lib/subpath';\n",
      },
      head: { 'packages/lib/src/index.ts': 'export const value = 2;\n' },
    });
    await openChange('impact-app-workspace');
    const response = await call('GET', api('impact-app-workspace', '/changes/1/review/impact'), tokens.owner);
    const file = (response.json.files as Array<{ path: string; consumers: Array<{ path: string; specifier: string }> }>)
      .find((item) => item.path === 'packages/lib/src/index.ts')!;
    expect(file.consumers).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'apps/web/src/use.ts', specifier: '@kvarm/lib' }),
      expect.objectContaining({ path: 'apps/web/src/use.ts', specifier: '@kvarm/lib/subpath' }),
    ]));
  });

  it('falls back to packages/* when the root manifest has no workspace patterns', async () => {
    await setup('impact-default-workspace', 'packages/lib/src/index.ts', [], {
      base: {
        'package.json': JSON.stringify({ name: 'single-package-root' }),
        'packages/lib/package.json': JSON.stringify({ name: '@kvarm/default-lib' }),
        'packages/lib/src/index.ts': 'export const value = 1;\n',
        'src/use.ts': "import { value } from '@kvarm/default-lib';\n",
      },
      head: { 'packages/lib/src/index.ts': 'export const value = 2;\n' },
    });
    await openChange('impact-default-workspace');
    const response = await call('GET', api('impact-default-workspace', '/changes/1/review/impact'), tokens.owner);
    const file = (response.json.files as Array<{ path: string; consumers: Array<{ path: string; specifier: string }> }>)
      .find((item) => item.path === 'packages/lib/src/index.ts')!;
    expect(file.consumers).toContainEqual(expect.objectContaining({
      path: 'src/use.ts',
      specifier: '@kvarm/default-lib',
    }));
  });

  it('does not resolve package manifests outside root workspace patterns', async () => {
    await setup('impact-nonworkspace-package', 'examples/x/src/index.ts', [], {
      base: {
        'package.json': JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }),
        'apps/web/src/use.ts': "import { example } from '@kvarm/example';\n",
        'examples/x/package.json': JSON.stringify({
          name: '@kvarm/example',
          exports: { '.': './src/index.ts' },
        }),
        'examples/x/src/index.ts': 'export const example = 1;\n',
      },
      head: { 'examples/x/src/index.ts': 'export const example = 2;\n' },
    });
    await openChange('impact-nonworkspace-package');
    const response = await call('GET', api('impact-nonworkspace-package', '/changes/1/review/impact'), tokens.owner);
    const file = (response.json.files as Array<{ path: string; consumers: Array<{ path: string; specifier: string }> }>)
      .find((item) => item.path === 'examples/x/src/index.ts')!;
    expect(file.consumers).not.toContainEqual(expect.objectContaining({
      path: 'apps/web/src/use.ts',
      specifier: '@kvarm/example',
    }));
  });

  it('supports object-form workspaces and recursive trailing patterns', async () => {
    await setup('impact-recursive-workspace', 'packages/group/lib/src/index.ts', [], {
      base: {
        'package.json': JSON.stringify({ workspaces: { packages: ['packages/**'] } }),
        'packages/group/lib/package.json': JSON.stringify({ name: '@kvarm/deep-lib' }),
        'packages/group/lib/src/index.ts': 'export const value = 1;\n',
        'src/use.ts': "import { value } from '@kvarm/deep-lib';\n",
      },
      head: { 'packages/group/lib/src/index.ts': 'export const value = 2;\n' },
    });
    await openChange('impact-recursive-workspace');
    const response = await call('GET', api('impact-recursive-workspace', '/changes/1/review/impact'), tokens.owner);
    const file = (response.json.files as Array<{ path: string; consumers: Array<{ path: string; specifier: string }> }>)
      .find((item) => item.path === 'packages/group/lib/src/index.ts')!;
    expect(file.consumers).toContainEqual(expect.objectContaining({
      path: 'src/use.ts',
      specifier: '@kvarm/deep-lib',
    }));
  });

  it('truncates import impact at the per-file consumer budget', async () => {
    const consumers = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`src/consumer-${index}.ts`, "import { a } from './a';\n"]));
    await setup('impact-truncated', 'src/a.ts', [], { head: consumers });
    await openChange('impact-truncated');
    const response = await call('GET', api('impact-truncated', '/changes/1/review/impact'), tokens.owner);
    const file = (response.json.files as Array<{ path: string; consumers: unknown[]; truncated: boolean }>).find((item) => item.path === 'src/a.ts')!;
    expect(file.consumers).toHaveLength(50);
    expect(file.truncated).toBe(true);
    expect(response.json.truncated).toBe(true);
    expect(response.json.truncatedReason).toContain('consumer-budget');
  });

  it('reports export breaks and requires breaking-impact declarations', async () => {
    const { head } = await setup('export-breaks', 'src/a.ts', ['src/*.ts']);
    await openChange('export-breaks');
    await call('PUT', api('export-breaks', '/review-policy'), tokens.owner, { guideRequired: true });
    const guidePath = api('export-breaks', '/changes/1/review-guide');
    const fallback = await call('GET', guidePath, tokens.owner);
    const changedA = (fallback.json.contracts as { breaks: Array<{ path: string; name: string; change: string; declared: boolean }> }).breaks
      .find((item) => item.path === 'src/a.ts' && item.name === 'a');
    expect(changedA).toMatchObject({ change: 'changed', declared: false });
    const unitKeys = (fallback.json.units as Array<{ key: string }>).map((unit) => unit.key);
    const additive = await call('POST', guidePath, tokens.owner, {
      headSha: head,
      guide: { intent: 'change exports', chapters: [{ id: 'api', title: 'API', tier: 'scrutinize', hunks: unitKeys }], contracts: [{ surface: 'src/*.ts', impact: 'additive' }] },
    });
    expect(additive.status).toBe(201);
    expect(((additive.json.guide as { contracts: { breaks: Array<{ declared: boolean }> } }).contracts).breaks.every((item) => !item.declared)).toBe(true);
    expect(((additive.json.guide as { contracts: { undeclared: string[] } }).contracts).undeclared.some((item) => item.includes('#'))).toBe(true);
    expect((await call('POST', api('export-breaks', '/changes/1/merge'), tokens.owner)).json.code).toBe('CONTRACT_UNDECLARED');
    const breaking = await call('POST', guidePath, tokens.owner, {
      headSha: head,
      guide: { intent: 'change exports', chapters: [{ id: 'api', title: 'API', tier: 'scrutinize', hunks: unitKeys }], contracts: [{ surface: 'src/*.ts', impact: 'breaking' }] },
    });
    expect(breaking.status).toBe(200);
    expect(((breaking.json.guide as { contracts: { breaks: Array<{ declared: boolean }> } }).contracts).breaks.every((item) => item.declared)).toBe(true);
    expect(((breaking.json.guide as { contracts: { undeclared: string[] } }).contracts).undeclared).toEqual([]);
  });

  it('classifies guide evidence against same-head checks and the head tree', async () => {
    const { head, repoId } = await setup('guide-evidence');
    const opened = await openChange('guide-evidence');
    expect(opened.status).toBe(201);
    const change = await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ?1 AND number = 1').bind(repoId).first<{ id: string }>();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, conclusion, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), repoId, change!.id, head, 'unit-tests', 'success', 'success', Date.now()),
      env.DB.prepare(`INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, name, status, conclusion, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), repoId, change!.id, head, 'lint', 'failure', 'failure', Date.now()),
    ]);
    const map = await call('GET', api('guide-evidence', '/changes/1/review-guide'), tokens.owner);
    const unitKeys = (map.json.units as Array<{ key: string }>).map((unit) => unit.key);
    const submitted = await call('POST', api('guide-evidence', '/changes/1/review-guide'), tokens.owner, {
      headSha: head,
      guide: {
        intent: 'verify change',
        chapters: [{ id: 'checks', title: 'Checks', tier: 'read', hunks: unitKeys }],
        evidence: [
          { kind: 'check', ref: 'unit-tests' },
          { kind: 'check', ref: 'lint' },
          { kind: 'check', ref: 'missing-check' },
          { kind: 'test', ref: 'README.md' },
          { kind: 'test', ref: 'src/missing.test.ts' },
          { kind: 'manual', ref: 'manual review' },
        ],
      },
    });
    expect(submitted.status).toBe(201);
    expect((submitted.json.guide as { guide: { evidence: Array<{ ref: string; status: string }> } }).guide.evidence).toEqual([
      { kind: 'check', ref: 'unit-tests', status: 'verified' },
      { kind: 'check', ref: 'lint', status: 'failed' },
      { kind: 'check', ref: 'missing-check', status: 'missing' },
      { kind: 'test', ref: 'README.md', status: 'verified' },
      { kind: 'test', ref: 'src/missing.test.ts', status: 'missing' },
      { kind: 'manual', ref: 'manual review', status: 'unverifiable' },
    ]);
  });

  it('blocks approval until scrutinize units are acknowledged when policy requires it', async () => {
    const { head } = await setup('danger-ack');
    await openChange('danger-ack');
    const policy = await call('PUT', api('danger-ack', '/review-policy'), tokens.owner, { dangerAckRequired: true });
    expect(policy.json.dangerAckRequired).toBe(true);
    expect((await call('GET', api('danger-ack', '/review-policy'), tokens.owner)).json.dangerAckRequired).toBe(true);
    const guidePath = api('danger-ack', '/changes/1/review-guide');
    const map = await call('GET', guidePath, tokens.owner);
    const unitKeys = (map.json.units as Array<{ key: string }>).map((unit) => unit.key);
    await call('POST', guidePath, tokens.owner, {
      headSha: head,
      guide: { intent: 'inspect danger', chapters: [{ id: 'danger', title: 'Danger', tier: 'scrutinize', hunks: unitKeys }] },
    });
    const approvalPath = api('danger-ack', '/changes/1/approve');
    const blocked = await call('POST', approvalPath, tokens.reviewer, { headSha: head });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: 'DANGER_UNACKED', unacked: unitKeys });
    const ack = await call('POST', api('danger-ack', '/changes/1/review-acks'), tokens.reviewer, { headSha: head, keys: unitKeys });
    expect(ack.status).toBe(200);
    expect((await call('POST', approvalPath, tokens.reviewer, { headSha: head })).status).toBe(201);
  });

  it('blocks approvals without cached coverage but still accepts request-changes', async () => {
    const { head } = await setup('danger-ack-no-guide');
    await openChange('danger-ack-no-guide');
    await call('PUT', api('danger-ack-no-guide', '/review-policy'), tokens.owner, { dangerAckRequired: true });
    const changePath = api('danger-ack-no-guide', '/changes/1');
    expect((await call('POST', `${changePath}/request-changes`, tokens.reviewer, { headSha: head })).status).toBe(201);
    const blocked = await call('POST', `${changePath}/approve`, tokens.reviewer, { headSha: head });
    expect(blocked.status).toBe(409);
    expect(blocked.json).toMatchObject({ code: 'DANGER_UNACKED', unacked: [] });
    expect(blocked.json.error).toContain('Fetch the review guide');
    expect(blocked.cost.art).toBe(0);
    expect(blocked.cost.d1).toBeLessThanOrEqual(3);
  });

  it('serves fallback, validates guides, carries acknowledgements, filters since/unacked, and reads config at base', async () => {
    const { repo, head } = await setup('guide-flow');
    expect((await openChange('guide-flow')).status).toBe(201);
    const path = api('guide-flow', '/changes/1/review-guide');
    await call('GET', path, tokens.owner);
    const fallback = await call('GET', path, tokens.owner);
    costs['GET review guide'] = fallback.cost;
    expect(fallback.cost).toMatchObject({ art: 0 });
    expect(fallback.cost.d1).toBeLessThanOrEqual(3);
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
    expect(submitted.cost).toMatchObject({ art: 0 });
    expect(submitted.cost.d1).toBeLessThanOrEqual(4);
    expect(submitted.status).toBe(201);
    expect(submitted.json.guide.coverage.gaps).toBeGreaterThan(0);
    expect(submitted.json.guide.guide.chapters.some((chapter: { id: string }) => chapter.id === 'unguided')).toBe(true);
    const ack = await call('POST', api('guide-flow', '/changes/1/review-acks'), tokens.reviewer, { headSha: head, keys: [first.key] });
    costs['POST review ack'] = ack.cost;
    expect(ack.cost).toMatchObject({ art: 0 });
    expect(ack.cost.d1).toBeLessThanOrEqual(3);
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
    const guidePath = api('finding-flow', '/changes/1/review-guide');
    await call('GET', guidePath, tokens.owner);
    await call('GET', guidePath, tokens.owner);
    const findingsPath = api('finding-flow', '/changes/1/findings');
    const low = { path: 'src/a.ts', startLine: 1, category: 'bug', severity: 'low', confidence: 'investigate', title: 'small issue' };
    const first = await call('POST', findingsPath, tokens.owner, { headSha: head, findings: [low] });
    costs['POST submit findings'] = first.cost;
    expect(first.cost).toMatchObject({ art: 0 });
    expect(first.cost.d1).toBeLessThanOrEqual(3);
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

  it('inherits focused coverage and acknowledgements from an active parent workspace', async () => {
    const { repo, base } = await setup('review-stack-flow');
    const createWorkspace = async (task: string) => {
      const result = await call('POST', api('review-stack-flow', '/workspaces'), tokens.owner, { task, agent: 'stack-agent' });
      expect(result.status).toBe(201);
      return result.json as { id: string; ref: string; baseSha: string };
    };
    const pushWorkspace = async (ws: { ref: string; baseSha: string }, before: string, files: Record<string, string>, parents: string[]) => {
      const next = await commit(repo, files, parents);
      repo.refs.set(ws.ref, next.sha);
      await deliver({
        type: 'cf.artifacts.repo.pushed',
        source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--review-stack-flow` },
        payload: { ref: ws.ref, before, after: next.sha, commits: [], totalCommitsCount: 0, commitsTruncated: false },
        metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
      });
      return next.sha;
    };
    const baseFiles = {
      'README.md': 'base\n',
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 1;\n',
      '.kvarm/review.json': JSON.stringify({ contracts: [] }),
    };
    const aWs = await createWorkspace('stack parent');
    const aHead = await pushWorkspace(aWs, aWs.baseSha, { ...baseFiles, 'src/a.ts': 'export const a = 2;\n' }, [base]);
    const aChange = await call('POST', api('review-stack-flow', `/workspaces/${aWs.id}/change-set`), tokens.owner, {
      title: 'Stack parent',
      mergePolicy: 'review',
    });
    expect(aChange.status).toBe(201);
    const bWs = await createWorkspace('stack child');
    const bHead = await pushWorkspace(
      bWs,
      bWs.baseSha,
      { ...baseFiles, 'src/a.ts': 'export const a = 2;\n', 'src/b.ts': 'export const b = 2;\n' },
      [aHead],
    );
    const pinned = await call('POST', api('review-stack-flow', `/workspaces/${bWs.id}/dependencies`), tokens.owner, {
      onWorkspace: aWs.id,
      revision: aHead,
    });
    expect(pinned.status).toBe(201);
    const bChange = await call('POST', api('review-stack-flow', `/workspaces/${bWs.id}/change-set`), tokens.owner, {
      title: 'Stack child',
      mergePolicy: 'review',
    });
    expect(bChange.status).toBe(201);

    const guidePath = api('review-stack-flow', '/changes/1/review-guide');
    const parentGuide = await call('GET', guidePath, tokens.owner);
    const parentUnit = (parentGuide.json.units as Array<{ key: string; path: string }>).find((unit) => unit.path === 'src/a.ts')!;
    const childPath = api('review-stack-flow', '/changes/2/review-guide');
    const cold = await call('GET', childPath, tokens.owner);
    costs['GET review guide with stack cold'] = cold.cost;
    expect(cold.status).toBe(200);
    expect(cold.json.stack.parents).toEqual([expect.objectContaining({ number: 1, edgeState: 'active', waitingOn: expect.any(String) })]);
    const childUnits = cold.json.units as Array<{ key: string; path: string; inherited?: { change: number }; acked: boolean }>;
    const inherited = childUnits.find((unit) => unit.path === 'src/a.ts')!;
    expect(inherited.key).toBe(parentUnit.key);
    expect(inherited.inherited).toEqual({ change: 1 });
    expect(childUnits.find((unit) => unit.path === 'src/b.ts')?.inherited).toBeUndefined();
    const focused = await call('GET', `${childPath}?since=parent`, tokens.owner);
    expect((focused.json.units as Array<{ path: string }>).map((unit) => unit.path)).toContain('src/b.ts');
    expect((focused.json.units as Array<{ path: string }>).map((unit) => unit.path)).not.toContain('src/a.ts');
    const warm = await call('GET', childPath, tokens.owner);
    costs['GET review guide with stack warm'] = warm.cost;
    expect(warm.cost).toMatchObject({ art: 0 });
    expect(warm.cost.d1).toBeLessThanOrEqual(3);

    await call('PUT', api('review-stack-flow', '/review-policy'), tokens.owner, { dangerAckRequired: true });
    const keys = childUnits.map((unit) => unit.key);
    await call('POST', childPath, tokens.owner, {
      headSha: bHead,
      guide: { intent: 'review every stack unit', chapters: [{ id: 'all', title: 'All', tier: 'scrutinize', hunks: keys }] },
    });
    expect((await call('POST', api('review-stack-flow', '/changes/1/review-acks'), tokens.reviewer, {
      headSha: aHead,
      keys: [parentUnit.key],
    })).status).toBe(200);
    const ownKeys = childUnits.filter((unit) => !unit.inherited).map((unit) => unit.key);
    expect((await call('POST', api('review-stack-flow', '/changes/2/review-acks'), tokens.reviewer, {
      headSha: bHead,
      keys: ownKeys,
    })).status).toBe(200);
    const carried = await call('GET', childPath, tokens.reviewer);
    expect((carried.json.units as Array<{ path: string; acked: boolean }>).find((unit) => unit.path === 'src/a.ts')?.acked).toBe(true);
    const verdictWithParent = await call('POST', api('review-stack-flow', '/changes/2/approve'), tokens.reviewer, { headSha: bHead });
    expect(verdictWithParent.status).toBe(201);
    costs['POST verdict with parent'] = verdictWithParent.cost;
    expect(verdictWithParent.cost).toMatchObject({ art: 0 });
    expect(verdictWithParent.cost.d1).toBeLessThanOrEqual(3);
    const warmVerdictWithParent = await call('POST', api('review-stack-flow', '/changes/2/approve'), tokens.reviewer, { headSha: bHead });
    expect(warmVerdictWithParent.status).toBe(200);
    costs['POST verdict with parent warm'] = warmVerdictWithParent.cost;
    expect(warmVerdictWithParent.cost).toMatchObject({ art: 0 });
    expect(warmVerdictWithParent.cost.d1).toBeLessThanOrEqual(3);
    const parentWithChild = await call('GET', guidePath, tokens.owner);
    expect(parentWithChild.json.stack.children).toEqual([expect.objectContaining({ number: 2, waitingOn: expect.any(String) })]);

    const moved = await pushWorkspace(aWs, aHead, { ...baseFiles, 'src/a.ts': 'export const a = 3;\n' }, [aHead]);
    expect(moved).not.toBe(aHead);
    const stale = await call('GET', childPath, tokens.reviewer);
    expect(stale.json.stack.parents).toEqual([]);
    expect(stale.json.stack.inherited).toBe(0);
    expect((stale.json.units as Array<{ path: string; inherited?: unknown; acked: boolean }>).find((unit) => unit.path === 'src/a.ts'))
      .toMatchObject({ acked: false });
    expect((await call('GET', `${childPath}?since=parent`, tokens.owner)).json.units).toHaveLength(childUnits.length);
  });

  it('prints measured x-kvarm-cost counters for each new endpoint', () => {
    expect(costs).toEqual(expect.objectContaining({
      'GET review impact cold': expect.any(Object),
      'GET review impact warm': expect.any(Object),
      'GET review guide': expect.any(Object),
      'GET review guide with stack cold': expect.any(Object),
      'GET review guide with stack warm': expect.any(Object),
      'POST verdict with parent': expect.any(Object),
      'POST verdict with parent warm': expect.any(Object),
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
