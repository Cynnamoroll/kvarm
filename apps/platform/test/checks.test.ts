/**
 * Check runs (services/checks.ts): the kvarm/guard run recorded on change
 * creation and head refresh, its findings and redaction, the commit status
 * rollup, reported runs through the ci transport, and the check-runs
 * producer as the checks gate of merges. Runs through the Worker's routes
 * and push queue over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { CHECK_LIMITS, GUARD_BUDGETS, checkRunsProducer } from '../src/services/checks';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'ck-owner';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';

class FakeWorkflow {
  created: Array<{ id?: string; params?: unknown }> = [];

  async create(opts: { id?: string }) {
    this.created.push(opts);
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const tok = { owner: '', ci: '', ciOnly: '', noCi: '', reader: '' };
const repoIds: Record<string, string> = {};

// Fake credentials, assembled so no literal token sits in the source.
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
const KVARM_PAT = 'kvarm_pat_' + 'fedcba9876543210'.repeat(4);

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return repo;
}

interface Reply {
  status: number;
  text: string;
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
  expect(cost).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, text, json, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const create = (repo: string, body: Record<string, unknown> = {}) =>
  call('POST', `${R(repo)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature', ...body });
const checksOf = (repo: string, n = 1) => call('GET', `${R(repo)}/changes/${n}/checks`, tok.owner);
const report = (repo: string, body: unknown, token = tok.ci) => call('POST', `${R(repo)}/check-runs`, token, body);

/** main = `base`; feature = main + `edit` (files mapped to null are deleted). */
async function fixture(repo: FakeRepo, base: Files, edit: Record<string, string | null>) {
  const main = await commit(repo, base);
  const next: Files = { ...base };
  for (const [p, v] of Object.entries(edit)) {
    if (v === null) delete next[p];
    else next[p] = v;
  }
  const feature = await commit(repo, next, [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  return { main, feature };
}

function pushBody(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'module.exports = 1;\n' };

beforeAll(async () => {
  installFakeGitRemote();
  const ownerId = await seedUser(OWNER);
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  tok.owner = (await mintPAT(env, ownerId, 'owner', all)).token;
  tok.ci = tok.owner;
  tok.ciOnly = (await mintPAT(env, ownerId, 'ci-only', ['ci'])).token;
  tok.noCi = (await mintPAT(env, ownerId, 'no-ci', ['read', 'write', 'api'])).token;
  const readerId = await seedUser('ck-reader');
  tok.reader = (await mintPAT(env, readerId, 'reader', all)).token;
});

afterAll(() => restoreFetch());

describe('kvarm/guard on creation and head refresh', () => {
  it('records one guard run at creation and a new one when the head moves; the status shows only the guard (VAL-GUARD-001/006)', async () => {
    const repo = await seedRepo('refresh');
    const { feature } = await fixture(repo, BASE, { 'README.md': '# App\n\nMore words.\n' });
    const created = await create('refresh');
    expect(created.status).toBe(201);
    expect(created.json.checks).toMatchObject([{ name: 'kvarm/guard', headSha: feature.sha, status: 'success', conclusion: 'success' }]);

    const first = await checksOf('refresh');
    expect(first.json.checks).toHaveLength(1);
    expect(first.json.checks[0]).toMatchObject({
      name: 'kvarm/guard',
      headSha: feature.sha,
      treeSha: feature.tree,
      status: 'success',
      conclusion: 'success',
      required: true,
      quarantined: false,
      attempt: 1,
      summary: { conclusion: 'success', findings: [], version: 'guard/v2' },
    });

    const next = await commit(repo, { ...BASE, 'README.md': '# App\n\nEven more words.\n' }, [feature.sha]);
    repo.refs.set(FEATURE, next.sha);
    const push = pushBody('refresh', FEATURE, feature.sha, next.sha, Date.now() + 1_000);
    await deliver(push);
    await deliver(push);
    const second = await checksOf('refresh');
    expect(second.json.checks.map((c: any) => [c.name, c.headSha, c.status])).toEqual([
      ['kvarm/guard', next.sha, 'success'],
      ['kvarm/guard', feature.sha, 'success'],
    ]);

    const status = await call('GET', `${R('refresh')}/commits/${next.sha}/status`, tok.owner);
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ sha: next.sha, state: 'success', total: 1, checks: [{ name: 'kvarm/guard', headSha: next.sha }] });
    expect(status.cost.d1).toBe(2);
    const none = await call('GET', `${R('refresh')}/commits/${'0'.repeat(40)}/status`, tok.owner);
    expect(none.json).toMatchObject({ state: 'none', total: 0, checks: [] });
    expect((await call('GET', `${R('refresh')}/commits/nope/status`, tok.owner)).json.code).toBe('INVALID_SHA');
    expect((await call('GET', `${R('refresh')}/commits/${next.sha}/status`)).status).toBe(404);
  });
});

describe('guard findings', () => {
  it('fails a planted secret with path, line and rule, redacted everywhere, and blocks the merge (VAL-GUARD-002/007)', async () => {
    const repo = await seedRepo('secret');
    const { main } = await fixture(repo, BASE, { 'secrets.txt': `aws_key=${AWS_KEY}\nkvarm_token=${KVARM_PAT}\n` });
    const created = await create('secret');
    expect(created.status).toBe(201);
    const checks = await checksOf('secret');
    const run = checks.json.checks[0];
    expect(run).toMatchObject({ name: 'kvarm/guard', status: 'failure', conclusion: 'failure' });
    expect(run.summary.findings).toEqual([
      expect.objectContaining({ path: 'secrets.txt', line: 1, rule: 'secret/aws-access-key', message: expect.any(String) }),
      expect.objectContaining({ path: 'secrets.txt', line: 2, rule: 'secret/kvarm-token', message: expect.any(String) }),
    ]);

    const detail = await call('GET', `${R('secret')}/changes/1`, tok.owner);
    expect(detail.json.mergeability.checks).toMatchObject({ state: 'failure', required: [{ name: 'kvarm/guard', state: 'failure' }] });
    const status = await call('GET', `${R('secret')}/commits/${run.headSha}/status`, tok.owner);
    expect(status.json.state).toBe('failure');
    for (const text of [created.text, checks.text, detail.text, status.text]) {
      expect(text).not.toContain(AWS_KEY);
      expect(text).not.toContain(KVARM_PAT);
    }
    const stored = await env.DB.prepare('SELECT summary FROM check_runs WHERE repo_id = ?').bind(repoIds.secret).all<{ summary: string }>();
    for (const r of stored.results ?? []) expect(r.summary).not.toContain(AWS_KEY);

    const merge = await call('POST', `${R('secret')}/changes/1/merge`, tok.owner);
    expect([merge.status, merge.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    expect(merge.json.error).toContain('kvarm/guard');
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect((await call('GET', `${R('secret')}/changes/1`, tok.owner)).json.state).toBe('open');
  });

  it('fails CI gaming, a deleted test and flags a typosquatted dependency (VAL-GUARD-003/004/005)', async () => {
    const ci = (run: string) => JSON.stringify({ jobs: [{ name: 'test', run }] }, null, 2) + '\n';
    const gaming = await seedRepo('gaming');
    await fixture(gaming, { ...BASE, '.kvarm/ci.json': ci('npm test') }, { '.kvarm/ci.json': ci('npm test || true') });
    await create('gaming');
    const g = (await checksOf('gaming')).json.checks.find((r: any) => r.name === 'kvarm/guard');
    expect(g.status).toBe('failure');
    expect(g.summary.findings).toEqual([expect.objectContaining({ path: '.kvarm/ci.json', rule: 'ci-gaming/or-true', line: 5 })]);

    const deleted = await seedRepo('deleted');
    await fixture(deleted, { ...BASE, 'tests/app.test.js': "test('x', () => {});\n" }, { 'tests/app.test.js': null });
    await create('deleted');
    const d = (await checksOf('deleted')).json.checks[0];
    expect(d.status).toBe('failure');
    expect(d.summary.findings).toEqual([expect.objectContaining({ path: 'tests/app.test.js', rule: 'ci-gaming/test-deleted' })]);

    const deps = await seedRepo('deps');
    const pkg = (extra: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', ...extra } }, null, 2) + '\n';
    await fixture(deps, { ...BASE, 'package.json': pkg({}) }, { 'package.json': pkg({ lodahs: '^1.0.0' }) });
    await create('deps');
    const p = (await checksOf('deps')).json.checks[0];
    expect(p.summary.findings).toEqual([expect.objectContaining({ path: 'package.json', rule: 'dependency/typosquat', message: expect.stringContaining('lodahs') })]);
  });

  it('reads at most the per-file budget of an oversized file and reports the rest as unscanned', async () => {
    const repo = await seedRepo('big');
    const big = 'x'.repeat(GUARD_BUDGETS.maxBytesPerFile + 10) + `\naws=${AWS_KEY}\n`;
    await fixture(repo, BASE, { 'big.txt': big });
    await create('big');
    const run = (await checksOf('big')).json.checks[0];
    expect(run).toMatchObject({ status: 'success', conclusion: 'neutral' });
    expect(run.summary.findings).toEqual([expect.objectContaining({ rule: 'guard/incomplete', path: 'big.txt' })]);
    expect(run.summary.scanned.bytes).toBeLessThanOrEqual(GUARD_BUDGETS.maxBytesPerFile);
  });
});

describe('the guard as the checks gate', () => {
  it('selects the guard by change and head and rejects a verdict for a different guard base', async () => {
    const repo = await seedRepo('guard-identity');
    const { feature } = await fixture(repo, BASE, { 'secrets.txt': `aws_key=${AWS_KEY}\n` });
    repo.refs.set('refs/heads/copy', feature.sha);
    expect((await create('guard-identity')).status).toBe(201);
    expect((await create('guard-identity', { base: 'feature', head: 'copy' })).status).toBe(201);
    const rows =
      (
        await env.DB.prepare(
          `SELECT c.id AS change_id, k.id AS run_id, k.summary
             FROM change_sets c JOIN check_runs k ON k.change_set_id = c.id
            WHERE c.repo_id = ? AND k.name = 'kvarm/guard'
            ORDER BY c.number`,
        )
          .bind(repoIds['guard-identity'])
          .all<{ change_id: string; run_id: string; summary: string }>()
      ).results ?? [];
    expect(rows).toHaveLength(2);
    await env.DB.batch([
      env.DB.prepare(`UPDATE check_runs SET created_at = 100 WHERE id = ?`).bind(rows[0]!.run_id),
      env.DB.prepare(`UPDATE check_runs SET created_at = 200 WHERE id = ?`).bind(rows[1]!.run_id),
    ]);
    const baseTree = (JSON.parse(rows[0]!.summary) as { baseTree: string }).baseTree;
    const cleanBaseTree = (JSON.parse(rows[1]!.summary) as { baseTree: string }).baseTree;
    const crowded: D1PreparedStatement[] = [];
    for (let number = 3; number <= 100; number++) {
      const changeId = crypto.randomUUID();
      crowded.push(
        env.DB.prepare(
          `INSERT INTO change_sets
             (id, repo_id, number, title, base_ref, head_ref, head_sha, state, merge_policy, kind, created_at, updated_at, head_event_at)
           VALUES (?, ?, ?, ?, 'main', ?, ?, 'open', 'review', 'change', ?, ?, ?)`,
        ).bind(changeId, repoIds['guard-identity'], number, `shared ${number}`, `shared-${number}`, feature.sha, number, number, number),
        env.DB.prepare(
          `INSERT INTO check_runs
             (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, summary, attempt, required, quarantined, created_at)
           VALUES (?, ?, ?, ?, ?, 'kvarm/guard', 'success', 'success', ?, 1, 1, 0, ?)`,
        ).bind(crypto.randomUUID(), repoIds['guard-identity'], changeId, feature.sha, feature.tree, rows[0]!.summary, 200 + number),
      );
    }
    await env.DB.batch(crowded);
    const blocked = await call('POST', `${R('guard-identity')}/changes/1/merge`, tok.owner);
    expect([blocked.status, blocked.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    const gate = checkRunsProducer(env);
    const [first, second, staleBase] = await Promise.all([
      gate.requiredChecksFor(
        { id: repoIds['guard-identity']! },
        feature.tree,
        null,
        { changeId: rows[0]!.change_id, headSha: feature.sha, guardBaseTree: baseTree },
      ),
      gate.requiredChecksFor(
        { id: repoIds['guard-identity']! },
        feature.tree,
        null,
        { changeId: rows[1]!.change_id, headSha: feature.sha, guardBaseTree: cleanBaseTree },
      ),
      gate.requiredChecksFor(
        { id: repoIds['guard-identity']! },
        feature.tree,
        null,
        { changeId: rows[0]!.change_id, headSha: feature.sha, guardBaseTree: 'f'.repeat(40) },
      ),
    ]);
    expect(first.find((c) => c.name === 'kvarm/guard')?.state).toBe('failure');
    expect(second.find((c) => c.name === 'kvarm/guard')?.state).toBe('success');
    expect(staleBase.find((c) => c.name === 'kvarm/guard')).toMatchObject({ state: 'pending' });
    expect(first).toContainEqual({ name: 'kvarm/checks-window', state: 'pending' });
  });

  it('answers a base-tree question from the run judged against that base, not only the newest run', async () => {
    const repo = await seedRepo('guard-rejudge');
    const { main, feature } = await fixture(repo, BASE, { 'secrets.txt': `aws_key=${AWS_KEY}\n` });
    expect((await create('guard-rejudge')).status).toBe(201);
    const rows =
      (
        await env.DB.prepare(
          `SELECT c.id AS change_id, k.id AS run_id, k.summary, k.created_at
             FROM change_sets c JOIN check_runs k ON k.change_set_id = c.id
            WHERE c.repo_id = ? AND k.name = 'kvarm/guard'`,
        )
          .bind(repoIds['guard-rejudge'])
          .all<{ change_id: string; run_id: string; summary: string; created_at: number }>()
      ).results ?? [];
    expect(rows).toHaveLength(1);
    const run = rows[0]!;
    const summary = JSON.parse(run.summary) as Record<string, unknown> & { baseTree: string; conclusion: string };
    expect(summary.baseTree).toBe(main.tree);
    expect(summary.conclusion).toBe('failure');

    // A later re-judge of the same head against a different base tree, exactly
    // as a landing stacked base produces. It is the newest run of the head.
    const otherTree = 'e'.repeat(40);
    await env.DB.prepare(
      `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, summary, attempt, required, quarantined, created_at)
       VALUES (?, ?, ?, ?, ?, 'kvarm/guard', 'success', 'success', ?, 1, 1, 0, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        repoIds['guard-rejudge'],
        run.change_id,
        feature.sha,
        feature.tree,
        JSON.stringify({ ...summary, baseTree: otherTree, conclusion: 'success', findings: [], title: 'passed' }),
        run.created_at + 1,
      )
      .run();

    const gate = checkRunsProducer(env);
    const [oldBase, newBase, unknown] = await Promise.all([
      gate.requiredChecksFor({ id: repoIds['guard-rejudge']! }, feature.tree, null, {
        changeId: run.change_id,
        headSha: feature.sha,
        guardBaseTree: summary.baseTree,
      }),
      gate.requiredChecksFor({ id: repoIds['guard-rejudge']! }, feature.tree, null, {
        changeId: run.change_id,
        headSha: feature.sha,
        guardBaseTree: otherTree,
      }),
      gate.requiredChecksFor({ id: repoIds['guard-rejudge']! }, feature.tree, null, {
        changeId: run.change_id,
        headSha: feature.sha,
        guardBaseTree: 'f'.repeat(40),
      }),
    ]);
    // The publication's plan names the base tree: its own run answers, even
    // though a newer run judged the head against a different base exists.
    expect(oldBase.find((c) => c.name === 'kvarm/guard')).toMatchObject({ state: 'failure', runId: run.run_id });
    expect(newBase.find((c) => c.name === 'kvarm/guard')).toMatchObject({ state: 'success' });
    expect(unknown.find((c) => c.name === 'kvarm/guard')).toMatchObject({ state: 'pending' });
  });

  it('marks a full exact-tree result window pending without penalizing an under-full tree', async () => {
    const repo = await seedRepo('checks-window');
    const { feature } = await fixture(repo, BASE, { 'feature.txt': 'feature\n' });
    expect((await create('checks-window')).status).toBe(201);
    const change = await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = 1')
      .bind(repoIds['checks-window'])
      .first<{ id: string }>();
    const guard = await env.DB.prepare(`SELECT summary FROM check_runs WHERE change_set_id = ? AND name = 'kvarm/guard'`)
      .bind(change!.id)
      .first<{ summary: string }>();
    const baseTree = (JSON.parse(guard!.summary) as { baseTree: string }).baseTree;
    const fullTree = 'd'.repeat(40);
    const shortTree = 'e'.repeat(40);
    const inserts: D1PreparedStatement[] = [];
    for (const [tree, count] of [
      [fullTree, CHECK_LIMITS.gateRowsPerTree],
      [shortTree, CHECK_LIMITS.gateRowsPerTree - 1],
    ] as const) {
      for (let i = 0; i < count; i++) {
        inserts.push(
          env.DB.prepare(
            `INSERT INTO check_runs
               (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, attempt, required, quarantined, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'success', 'success', 1, 1, 0, ?)`,
          ).bind(crypto.randomUUID(), repoIds['checks-window'], change!.id, feature.sha, tree, `ci/${tree[0]}-${i}`, i),
        );
      }
    }
    await env.DB.batch(inserts);
    const subject = { changeId: change!.id, headSha: feature.sha, guardBaseTree: baseTree };
    const gate = checkRunsProducer(env);
    const [full, short] = await Promise.all([
      gate.requiredChecksFor({ id: repoIds['checks-window']! }, fullTree, null, subject),
      gate.requiredChecksFor({ id: repoIds['checks-window']! }, shortTree, null, subject),
    ]);
    expect(full).toContainEqual({ name: 'kvarm/checks-window', state: 'pending' });
    expect(short).not.toContainEqual(expect.objectContaining({ name: 'kvarm/checks-window' }));
  });

  it('an auto change with a failing guard stays open; the clean head pushed over it merges on its own (VAL-MERGE-006)', async () => {
    const repo = await seedRepo('auto');
    const { feature } = await fixture(repo, BASE, { 'secrets.txt': `aws_key=${AWS_KEY}\n` });
    const created = await create('auto', { mergePolicy: 'auto' });
    expect(created.json).toMatchObject({ state: 'open', mergeCommit: null });
    const clean = await commit(repo, { ...BASE, 'notes.txt': 'clean\n' }, [feature.sha]);
    repo.refs.set(FEATURE, clean.sha);
    await deliver(pushBody('auto', FEATURE, feature.sha, clean.sha, Date.now() + 1_000));
    const after = await call('GET', `${R('auto')}/changes/1`, tok.owner);
    expect(after.json).toMatchObject({ state: 'merged', mergeCommit: clean.sha });
    expect(repo.refs.get(MAIN)).toBe(clean.sha);
  });
});

describe('reported check runs', () => {
  it('needs the ci scope, reserves kvarm/ names, and validates the body', async () => {
    const repo = await seedRepo('report-auth');
    const { feature } = await fixture(repo, BASE, { 'notes.txt': 'n\n' });
    const body = { headSha: feature.sha, name: 'test', conclusion: 'success' };
    expect((await report('report-auth', body, tok.noCi)).json.code).toBe('INSUFFICIENT_SCOPE');
    expect((await report('report-auth', body, tok.reader)).status).toBe(404);
    expect((await report('report-auth', body, '')).status).toBe(401);
    expect((await report('report-auth', { ...body, name: 'kvarm/guard' })).json.code).toBe('RESERVED_CHECK_NAME');
    expect((await report('report-auth', { ...body, headSha: 'abc' })).json.code).toBe('INVALID_SHA');
    expect((await report('report-auth', { ...body, conclusion: 'meh' })).json.code).toBe('INVALID_CONCLUSION');
    expect((await report('report-auth', { ...body, headSha: 'f'.repeat(40) })).json.code).toBe('COMMIT_NOT_FOUND');
    const ok = await report('report-auth', body, tok.ciOnly);
    expect(ok.status).toBe(201);
    expect(ok.json.run).toMatchObject({ name: 'test', headSha: feature.sha, treeSha: feature.tree, status: 'success', conclusion: 'success', required: true });
    expect(ok.json.change).toBeNull();
  });

  it('a running required check holds an auto change; its success merges it (resume after check)', async () => {
    const repo = await seedRepo('report-auto');
    const { feature } = await fixture(repo, BASE, { 'notes.txt': 'n\n' });
    expect((await report('report-auto', { headSha: feature.sha, name: 'test', status: 'running' })).status).toBe(201);
    const created = await create('report-auto', { mergePolicy: 'auto' });
    expect(created.json).toMatchObject({ state: 'open' });
    const held = await call('GET', `${R('report-auto')}/changes/1/mergeability`, tok.owner);
    expect(held.json.mergeability.checks).toMatchObject({ state: 'pending' });
    const done = await report('report-auto', { headSha: feature.sha, name: 'test', conclusion: 'success' });
    expect(done.json.change).toEqual({ number: 1 });
    expect((await call('GET', `${R('report-auto')}/changes/1`, tok.owner)).json).toMatchObject({ state: 'merged', mergeCommit: feature.sha });
  });

  it('a failing non-required run does not block, a failing required run does', async () => {
    const repo = await seedRepo('report-required');
    const { feature } = await fixture(repo, BASE, { 'notes.txt': 'n\n' });
    await create('report-required');
    await report('report-required', { headSha: feature.sha, name: 'optional', conclusion: 'failure', required: false });
    const m1 = await call('GET', `${R('report-required')}/changes/1/mergeability`, tok.owner);
    expect(m1.json.mergeability.checks.state).toBe('success');
    await report('report-required', { headSha: feature.sha, name: 'test', conclusion: 'failure' });
    const m2 = await call('GET', `${R('report-required')}/changes/1/mergeability`, tok.owner);
    expect(m2.json.mergeability.checks).toMatchObject({ state: 'failure' });
    const refused = await call('POST', `${R('report-required')}/changes/1/merge`, tok.owner);
    expect([refused.status, refused.json.code]).toEqual([409, 'REQUIRED_CHECKS_FAILED']);
    expect(refused.json.error).toContain('test');
    const status = await call('GET', `${R('report-required')}/commits/${feature.sha}/status`, tok.owner);
    expect(status.json).toMatchObject({ state: 'failure', total: 3 });
  });

  it('change detail D1 is the same with 1 and 6 check runs (VAL-COST-011)', async () => {
    const repo = await seedRepo('detail-cost');
    const main = await commit(repo, BASE);
    const a = await commit(repo, { ...BASE, 'a.txt': 'a\n' }, [main.sha]);
    const b = await commit(repo, { ...BASE, 'b.txt': 'b\n' }, [main.sha]);
    repo.refs.set(MAIN, main.sha);
    repo.refs.set('refs/heads/a', a.sha);
    repo.refs.set('refs/heads/b', b.sha);
    await create('detail-cost', { head: 'a' });
    await create('detail-cost', { head: 'b' });
    for (let i = 0; i < 5; i++) await report('detail-cost', { headSha: b.sha, name: `job-${i}`, conclusion: 'success' });
    expect((await checksOf('detail-cost', 1)).json.checks).toHaveLength(1);
    expect((await checksOf('detail-cost', 2)).json.checks).toHaveLength(6);
    await call('GET', `${R('detail-cost')}/changes/1`, tok.owner);
    await call('GET', `${R('detail-cost')}/changes/2`, tok.owner);
    const one = await call('GET', `${R('detail-cost')}/changes/1`, tok.owner);
    const six = await call('GET', `${R('detail-cost')}/changes/2`, tok.owner);
    expect(six.json.mergeability.checks.required).toHaveLength(6);
    expect(one.cost.d1).toBe(six.cost.d1);
    expect(six.cost.d1).toBeLessThanOrEqual(3);
  });
});

describe('CI pipeline runner', () => {
  const ci = (jobs: Array<{ name: string; run: string; required?: boolean }>) => `${JSON.stringify({ jobs })}\n`;

  it('queues ci.json jobs, fences lease takeover and reports exact-head results within budget (VAL-CI-001/005/006/007, VAL-COST-012)', async () => {
    const repo = await seedRepo('ci-runner');
    const config = ci([
      { name: 'build', run: 'cat ci-marker.txt', required: true },
      { name: 'optional', run: 'exit 1', required: false },
    ]);
    const { feature } = await fixture(
      repo,
      { ...BASE, '.kvarm/ci.json': config },
      { '.kvarm/ci.json': config, 'ci-marker.txt': 'marker-at-head\n' },
    );
    const snapshotWorkflow = env.SNAPSHOT_BUILDER as unknown as FakeWorkflow;
    const snapshotCalls = snapshotWorkflow.created.length;
    const created = await create('ci-runner', { mergePolicy: 'review' });
    expect(created.status).toBe(201);
    expect(snapshotWorkflow.created).toHaveLength(snapshotCalls);
    const queued = await checksOf('ci-runner');
    expect(queued.json.checks.map((r: any) => [r.name, r.status, r.required, r.attempt, r.headSha, r.treeSha])).toEqual([
      ['optional', 'queued', false, 1, feature.sha, feature.tree],
      ['build', 'queued', true, 1, feature.sha, feature.tree],
      ['kvarm/guard', 'success', true, 1, feature.sha, feature.tree],
    ]);

    const claimPath = `${R('ci-runner')}/ci/jobs/claim`;
    const denied = await call('POST', claimPath, tok.noCi, { runnerId: 'wrong-scope' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('INSUFFICIENT_SCOPE');

    const first = await call('POST', claimPath, tok.ci, { runnerId: 'runner-a' });
    expect(first.status).toBe(200);
    expect(first.json.job).toMatchObject({
      name: 'build',
      command: 'cat ci-marker.txt',
      sha: feature.sha,
      treeSha: feature.tree,
      generation: 1,
      runnerId: 'runner-a',
      leaseSeconds: 120,
    });
    expect(first.cost.d1).toBeLessThanOrEqual(2);
    expect(first.cost.do).toBe(0);
    expect(first.cost.q).toBe(0);
    expect(snapshotWorkflow.created).toHaveLength(snapshotCalls + 1);
    expect((await checksOf('ci-runner')).json.checks.find((r: any) => r.name === 'build')).toMatchObject({
      status: 'running',
      startedAt: expect.any(String),
    });

    const guardId = queued.json.checks.find((r: any) => r.name === 'kvarm/guard').id;
    const buildId = queued.json.checks.find((r: any) => r.name === 'build').id;
    expect((await call('PATCH', `${R('ci-runner')}/check-runs/${guardId}`, tok.ci, { conclusion: 'failure' })).json.code).toBe('RESERVED_CHECK_RUN');
    expect((await call('PATCH', `${R('ci-runner')}/check-runs/${buildId}`, tok.ci, { conclusion: 'failure' })).json.code).toBe('RESERVED_CHECK_RUN');

    await env.DB.prepare('UPDATE ci_jobs SET lease_until = ? WHERE id = ?').bind(Date.now() - 1, first.json.job.id).run();
    const expiredHeartbeat = await call('POST', `${R('ci-runner')}/ci/jobs/${first.json.job.id}/heartbeat`, tok.ci, {
      runnerId: 'runner-a',
      generation: 1,
    });
    expect(expiredHeartbeat.status).toBe(409);
    const expiredReport = await call('POST', `${R('ci-runner')}/ci/jobs/${first.json.job.id}/report`, tok.ci, {
      runnerId: 'runner-a',
      generation: 1,
      conclusion: 'failure',
    });
    expect(expiredReport.status).toBe(409);
    const second = await call('POST', claimPath, tok.ci, { runnerId: 'runner-b' });
    expect(second.status).toBe(200);
    expect(second.json.job).toMatchObject({ id: first.json.job.id, generation: 2, runnerId: 'runner-b', sha: feature.sha });

    const stale = await call('POST', `${R('ci-runner')}/ci/jobs/${first.json.job.id}/report`, tok.ci, {
      runnerId: 'runner-a',
      generation: 1,
      conclusion: 'failure',
      summary: { output: 'late' },
    });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('STALE_GENERATION');

    const heartbeat = await call('POST', `${R('ci-runner')}/ci/jobs/${first.json.job.id}/heartbeat`, tok.ci, {
      runnerId: 'runner-b',
      generation: 2,
    });
    expect(heartbeat.status).toBe(200);
    expect(Date.parse(heartbeat.json.job.leaseUntil)).toBeGreaterThan(Date.now() + 110_000);

    const report = await call('POST', `${R('ci-runner')}/ci/jobs/${first.json.job.id}/report`, tok.ci, {
      runnerId: 'runner-b',
      generation: 2,
      conclusion: 'success',
      summary: { output: 'marker-at-head' },
    });
    expect(report.status).toBe(200);
    expect(report.json.run).toMatchObject({ name: 'build', status: 'success', conclusion: 'success', summary: { output: 'marker-at-head' } });
    expect(report.cost.d1).toBeLessThanOrEqual(2);
    expect(report.cost.do).toBe(0);
    expect(report.cost.q).toBe(0);

    const status = await call('GET', `${R('ci-runner')}/commits/${feature.sha}/status`, tok.owner);
    expect(status.json).toMatchObject({ state: 'success' });
    expect(status.json.checks.find((r: any) => r.name === 'build')).toMatchObject({ status: 'success', summary: { output: 'marker-at-head' } });
  });

  it('counts report summaries in UTF-8 bytes and reclaims the same job after an oversized report expires', async () => {
    const repo = await seedRepo('ci-summary-bytes');
    const config = ci([{ name: 'test', run: 'echo ok', required: true }]);
    await fixture(repo, { ...BASE, '.kvarm/ci.json': config }, { '.kvarm/ci.json': config, 'one.txt': 'one\n' });
    await create('ci-summary-bytes');
    const claimPath = `${R('ci-summary-bytes')}/ci/jobs/claim`;
    const first = await call('POST', claimPath, tok.ci, { runnerId: 'runner-a' });
    expect(first.status).toBe(200);

    const accepted = await call('POST', `${R('ci-summary-bytes')}/ci/jobs/${first.json.job.id}/report`, tok.ci, {
      runnerId: 'runner-a',
      generation: 1,
      conclusion: 'success',
      summary: { output: '漢'.repeat(21_000) },
    });
    expect(accepted.status).toBe(200);

    const secondChange = await create('ci-summary-bytes');
    expect(secondChange.status).toBe(201);
    const second = await call('POST', claimPath, tok.ci, { runnerId: 'runner-b' });
    expect(second.status).toBe(200);
    const oversized = await call('POST', `${R('ci-summary-bytes')}/ci/jobs/${second.json.job.id}/report`, tok.ci, {
      runnerId: 'runner-b',
      generation: 1,
      conclusion: 'failure',
      summary: { output: '漢'.repeat(21_846) },
    });
    expect([oversized.status, oversized.json.code]).toEqual([422, 'SUMMARY_TOO_LARGE']);
    await env.DB.prepare('UPDATE ci_jobs SET lease_until = ? WHERE id = ?').bind(Date.now() - 1, second.json.job.id).run();
    const reclaimed = await call('POST', claimPath, tok.ci, { runnerId: 'runner-c' });
    expect(reclaimed.status).toBe(200);
    expect(reclaimed.json.job).toMatchObject({ id: second.json.job.id, generation: 2, runnerId: 'runner-c' });
  });

  it('queues a fresh job set after the change head moves (VAL-CI-002)', async () => {
    const repo = await seedRepo('ci-refresh');
    const config = ci([{ name: 'test', run: 'echo ok', required: true }]);
    const { feature } = await fixture(repo, { ...BASE, '.kvarm/ci.json': config }, { '.kvarm/ci.json': config, 'one.txt': 'one\n' });
    await create('ci-refresh');
    const next = await commit(repo, { ...BASE, '.kvarm/ci.json': config, 'two.txt': 'two\n' }, [feature.sha]);
    repo.refs.set(FEATURE, next.sha);
    await deliver(pushBody('ci-refresh', FEATURE, feature.sha, next.sha, Date.now() + 1_000));
    const checks = await checksOf('ci-refresh');
    expect(checks.json.checks.filter((r: any) => r.name === 'test').map((r: any) => [r.headSha, r.status])).toEqual([
      [next.sha, 'queued'],
      [feature.sha, 'queued'],
    ]);
  });

  it('queues and requires CI on the exact merge tree when the base advanced (VAL-MERGE-003/007)', async () => {
    const repo = await seedRepo('ci-merge-tree');
    const config = ci([{ name: 'merge-test', run: 'test -f base-moved.txt', required: true }]);
    const { main, feature } = await fixture(repo, { ...BASE, '.kvarm/ci.json': config }, { '.kvarm/ci.json': config, 'feature.txt': 'feature\n' });
    await create('ci-merge-tree');
    const headClaim = await call('POST', `${R('ci-merge-tree')}/ci/jobs/claim`, tok.ci, { runnerId: 'head' });
    await call('POST', `${R('ci-merge-tree')}/ci/jobs/${headClaim.json.job.id}/report`, tok.ci, {
      runnerId: 'head',
      generation: headClaim.json.job.generation,
      conclusion: 'success',
    });
    const movedBase = await commit(repo, { ...BASE, '.kvarm/ci.json': config, 'base-moved.txt': 'base\n' }, [main.sha]);
    repo.refs.set(MAIN, movedBase.sha);

    const pending = await call('POST', `${R('ci-merge-tree')}/changes/1/merge`, tok.owner);
    expect([pending.status, pending.json.code]).toEqual([409, 'REQUIRED_CHECKS_PENDING']);
    const exact = await call('POST', `${R('ci-merge-tree')}/ci/jobs/claim`, tok.ci, { runnerId: 'merge-tree' });
    expect(exact.json.job.sha).not.toBe(feature.sha);
    expect(exact.json.job.name).toBe('merge-test');
    await call('POST', `${R('ci-merge-tree')}/ci/jobs/${exact.json.job.id}/report`, tok.ci, {
      runnerId: 'merge-tree',
      generation: exact.json.job.generation,
      conclusion: 'success',
    });
    const merged = await call('POST', `${R('ci-merge-tree')}/changes/1/merge`, tok.owner);
    expect(merged.status).toBe(200);
    expect(merged.json).toMatchObject({ state: 'merged', mergeCommit: exact.json.job.sha });
  });

  it('rejects an invalid CI config before persisting a change', async () => {
    const repo = await seedRepo('ci-invalid-create');
    await fixture(repo, { ...BASE, '.kvarm/ci.json': '{bad' }, { 'feature.txt': 'feature\n' });
    const refused = await create('ci-invalid-create');
    expect([refused.status, refused.json.code]).toEqual([422, 'INVALID_CI_CONFIG']);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ?').bind(repoIds['ci-invalid-create']).first('n')).toBe(0);
  });

});
