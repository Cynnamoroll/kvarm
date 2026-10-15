/**
 * Guard completeness (architecture §0.3, §11.1): an incomplete kvarm/guard
 * verdict (files past the guard's read budgets) is reported as incomplete
 * everywhere the check is shown, and a branch rule with
 * `guardCompleteness: 'required'` refuses to publish it into a matching ref
 * through the explicit merge and the merge queue. Runs through the
 * Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { effectivePolicy, ruleFromRow, type BranchRule, type BranchRuleRow } from '../src/services/branchRules';
import { branchPolicyBlock } from '../src/services/changes';
import { GUARD_BUDGETS, guardTitle } from '../src/services/checks';
import { defaultTrainDeps, runTrain } from '../src/services/queue';
import { commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, fakeEvents, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const seedUser = (login: string) => seedUserBase(env, login, { userIds });
async function seedRepo(name: string) {
  const { id, repo } = await seedRepoBase(env, name, { owner: OWNER, visibility: 'private', repoIds });
  const now = Date.now();
  await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userIds[REVIEWER], 'write', userIds[OWNER], now, now).run();
  return repo;
}
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'gc-owner';
const REVIEWER = 'gc-reviewer';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const tok = { owner: '', reviewer: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;

const BASE: Files = { 'README.md': '# App\n' };
/** A file the guard reads only up to its per-file prefix: the rest is uninspected. */
const OVERSIZED = 'x'.repeat(GUARD_BUDGETS.maxBytesPerFile + 10) + '\nmore\n';
const pkg = (extra: Record<string, string>) => JSON.stringify({ name: 'app', dependencies: { express: '^4.0.0', ...extra } }, null, 2) + '\n';

/**
 * main = BASE (+ `base`), feature = main + `edit`; optional branch rules
 * created first, then the change, approved by a second human so a
 * protected target's review gate holds.
 */
async function scenario(name: string, edit: Files, rules: Array<Record<string, unknown>>, base: Files = {}) {
  const repo = await seedRepo(name);
  const main = await commit(repo, { ...BASE, ...base });
  const feature = await commit(repo, { ...BASE, ...base, ...edit }, [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  for (const rule of rules) {
    const r = await call('POST', `${R(name)}/branch-rules`, tok.owner, rule);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  const created = await call('POST', `${R(name)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  if (rules.length > 0) {
    const approved = await call('POST', `${R(name)}/changes/1/approve`, tok.reviewer, {});
    expect(approved.status, JSON.stringify(approved.json)).toBe(201);
  }
  return { repo, main, feature };
}

const merge = (name: string) => call('POST', `${R(name)}/changes/1/merge`, tok.owner);

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api'];
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', all)).token;
  tok.reviewer = (await mintPAT(env, await seedUser(REVIEWER), 'reviewer', all)).token;
});

afterAll(() => restoreFetch());

describe('guard completeness: the check shows what it did not inspect', () => {
  it('guard completeness: an incomplete neutral guard says so on the check run, the commit status and mergeability', async () => {
    const { feature } = await scenario('gc-surface', { 'big.txt': OVERSIZED }, []);
    const run = (await call('GET', `${R('gc-surface')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run).toMatchObject({ name: 'kvarm/guard', status: 'success', conclusion: 'neutral' });
    expect(run.summary).toMatchObject({
      version: 'guard/v2',
      complete: false,
      uninspected: { count: 1, listTruncated: false, paths: [{ path: 'big.txt', reason: 'prefix-only' }] },
    });
    expect(run.summary.title).toMatch(/^incomplete: 1 changed file\(s\) not fully inspected/);

    const status = (await call('GET', `${R('gc-surface')}/commits/${feature.sha}/status`, tok.owner)).json;
    expect(status).toMatchObject({ state: 'success', incomplete: ['kvarm/guard'] });

    const detail = (await call('GET', `${R('gc-surface')}/changes/1`, tok.owner)).json;
    expect(detail.mergeability.checks.required).toEqual([expect.objectContaining({ name: 'kvarm/guard', state: 'success', incomplete: true, uninspected: 1 })]);
  });

  it('guard completeness: files past the per-change file budget are reported as over-file-budget', async () => {
    const edit: Files = {};
    for (let i = 0; i <= GUARD_BUDGETS.maxFiles; i++) edit[`f${String(i).padStart(3, '0')}.txt`] = `file ${i}\n`;
    await scenario('gc-many', edit, []);
    const run = (await call('GET', `${R('gc-many')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run.conclusion).toBe('neutral');
    expect(run.summary.complete).toBe(false);
    expect(run.summary.uninspected).toMatchObject({ count: 1, paths: [{ path: `f${GUARD_BUDGETS.maxFiles}.txt`, reason: 'over-file-budget' }] });
  });

  it('guard completeness: a clean, fully inspected guard is complete with a passing title and no incomplete marker', async () => {
    const { feature } = await scenario('gc-clean', { 'notes.txt': 'clean\n' }, []);
    const run = (await call('GET', `${R('gc-clean')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run.summary).toMatchObject({ conclusion: 'success', complete: true });
    expect(run.summary.uninspected).toBeUndefined();
    const status = (await call('GET', `${R('gc-clean')}/commits/${feature.sha}/status`, tok.owner)).json;
    expect(status.incomplete).toEqual([]);
  });
});

describe('guard completeness: binary sides', () => {
  it('guard completeness: a binary file replaced by text is scanned as new text, not skipped as binary', async () => {
    const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE';
    await scenario('gc-binary-old', { 'data.txt': `aws_key=${AWS_KEY}\n` }, [], { 'data.txt': 'bin\u0000ary\n' });
    const run = (await call('GET', `${R('gc-binary-old')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run.conclusion).toBe('failure');
    expect(run.summary.findings).toEqual([expect.objectContaining({ rule: 'secret/aws-access-key', path: 'data.txt', line: 1 })]);
  });
});

describe('guard completeness: branch rules', () => {
  it('guard completeness: rules default to advisory and validate the setting', async () => {
    await seedRepo('gc-rules');
    const created = await call('POST', `${R('gc-rules')}/branch-rules`, tok.owner, { pattern: 'main' });
    expect(created.json.rule.guardCompleteness).toBe('advisory');
    const bad = await call('POST', `${R('gc-rules')}/branch-rules`, tok.owner, { pattern: 'dev', guardCompleteness: 'strict' });
    expect([bad.status, bad.json.code]).toEqual([400, 'INVALID_GUARD_COMPLETENESS']);
    const patched = await call('PATCH', `${R('gc-rules')}/branch-rules/${created.json.rule.id}`, tok.owner, { guardCompleteness: 'required' });
    expect([patched.status, patched.json.rule.guardCompleteness]).toEqual([200, 'required']);
    const policy = (await call('GET', `${R('gc-rules')}/branch-policy?ref=main`, tok.owner)).json;
    expect(policy.guardCompleteness).toBe('required');
    const free = (await call('GET', `${R('gc-rules')}/branch-policy?ref=scratch`, tok.owner)).json;
    expect(free.guardCompleteness).toBe('advisory');
    const audit = await env.DB.prepare("SELECT payload FROM events WHERE type = 'branch_rule.updated' AND payload LIKE ?")
      .bind(`%${created.json.rule.id}%`)
      .first<{ payload: string }>();
    expect(JSON.parse(audit!.payload)).toMatchObject({ guardCompleteness: 'required' });
  });

  it('guard completeness: the union of matching rules requires completeness when any one does', () => {
    const rule = (id: string, pattern: string, guardCompleteness: 'advisory' | 'required'): BranchRule => ({
      id,
      pattern,
      requiredChecks: [],
      requiredApprovals: 0,
      agentApprovals: 'never',
      guardCompleteness,
      createdBy: null,
      createdAt: 0,
      updatedBy: null,
      updatedAt: 0,
    });
    const rules = [rule('a', 'refs/heads/main', 'advisory'), rule('b', 'refs/heads/*', 'required')];
    expect(effectivePolicy(rules, 'refs/heads/main').guardCompleteness).toBe('required');
    expect(effectivePolicy([rules[0]!], 'refs/heads/main').guardCompleteness).toBe('advisory');
    expect(effectivePolicy(rules, 'refs/tags/v1').guardCompleteness).toBe('advisory');
  });

  it('guard completeness: a rule row read without the column fails closed to required', () => {
    const row = { id: 'r', pattern: 'refs/heads/main', required_checks: '[]', required_approvals: 0, created_at: 0, updated_at: 0 } as unknown as BranchRuleRow;
    expect(ruleFromRow(row).guardCompleteness).toBe('required');
    expect(ruleFromRow({ ...row, guard_completeness: 'advisory' }).guardCompleteness).toBe('advisory');
  });

  it('guard completeness: the refusal comes before pending required checks and names an unknown count plainly', () => {
    const policy = effectivePolicy(
      [{ id: 'r', pattern: 'refs/heads/main', requiredChecks: ['ci/test'], requiredApprovals: 0, agentApprovals: 'never', guardCompleteness: 'required', createdBy: null, createdAt: 0, updatedBy: null, updatedAt: 0 }],
      MAIN,
    );
    const checks = {
      treeSha: 't',
      configId: null,
      state: 'pending' as const,
      required: [
        { name: 'ci/test', state: 'pending' as const, producer: 'ci' },
        { name: 'kvarm/guard', state: 'success' as const, producer: 'check-runs', incomplete: true as const, uninspected: 0 },
      ],
    };
    const block = branchPolicyBlock(policy, checks);
    expect(block?.code).toBe('GUARD_INCOMPLETE');
    expect(block?.error).toContain('part of the change was not fully inspected');
    const advisory = branchPolicyBlock({ ...policy, guardCompleteness: 'advisory' }, checks);
    expect(advisory?.code).toBe('REQUIRED_CHECKS_PENDING');

    // A failed check is reported as the failure, not as incompleteness.
    const failed = { ...checks, state: 'failure' as const, required: [{ ...checks.required[0]!, state: 'failure' as const }, checks.required[1]!] };
    expect(branchPolicyBlock(policy, failed)?.code).toBe('REQUIRED_CHECKS_FAILED');
    const treeFailure = { ...failed, required: [{ name: 'ci/other', state: 'failure' as const, producer: 'ci' }, checks.required[1]!] };
    expect(branchPolicyBlock({ ...policy, requiredChecks: [] }, treeFailure)).toBeNull();

    // A gate answer without any kvarm/guard verdict never satisfies a required rule.
    const noGuard = { ...checks, state: 'success' as const, required: [{ name: 'ci/test', state: 'success' as const, producer: 'ci' }] };
    expect(branchPolicyBlock(policy, noGuard)?.code).toBe('REQUIRED_CHECKS_PENDING');
    expect(branchPolicyBlock({ ...policy, guardCompleteness: 'advisory' }, noGuard)).toBeNull();
  });

  it('guard completeness: the title of a truncated list with every listed file read does not claim a count of zero', () => {
    const title = guardTitle({ conclusion: 'neutral', findings: [], complete: false, uninspected: { count: 0, listTruncated: true, paths: [] } });
    expect(title).toMatch(/^incomplete: the change list was truncated/);
    expect(title).not.toContain('0 changed');
  });

  it('guard completeness: incomplete guard + advisory rule merges', async () => {
    const { repo, feature } = await scenario('gc-advisory', { 'big.txt': OVERSIZED }, [{ pattern: 'main' }]);
    const merged = await merge('gc-advisory');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(repo.refs.get(MAIN)).toBe(feature.sha);
  });

  it('guard completeness: incomplete guard + required rule is blocked with GUARD_INCOMPLETE', async () => {
    const { repo, main } = await scenario('gc-required', { 'big.txt': OVERSIZED }, [{ pattern: 'main', guardCompleteness: 'required' }]);
    const blocked = await merge('gc-required');
    expect([blocked.status, blocked.json.code]).toEqual([409, 'GUARD_INCOMPLETE']);
    expect(blocked.json.error).toContain('kvarm/guard');
    expect(blocked.json.error).toContain('1 changed file(s)');
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect((await call('GET', `${R('gc-required')}/changes/1`, tok.owner)).json.state).toBe('open');
  });

  it('guard completeness: complete guard + required rule merges', async () => {
    const { repo, feature } = await scenario('gc-complete', { 'notes.txt': 'clean\n' }, [{ pattern: 'main', guardCompleteness: 'required' }]);
    const merged = await merge('gc-complete');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(repo.refs.get(MAIN)).toBe(feature.sha);
  });

  it('guard completeness: an advisory-only neutral finding + required rule merges', async () => {
    const { repo } = await scenario(
      'gc-neutral',
      { 'package.json': pkg({ mylib: 'github:someone/mylib' }) },
      [{ pattern: 'main', guardCompleteness: 'required' }],
      { 'package.json': pkg({}) },
    );
    const run = (await call('GET', `${R('gc-neutral')}/changes/1/checks`, tok.owner)).json.checks[0];
    expect(run).toMatchObject({ conclusion: 'neutral', summary: { complete: true } });
    const merged = await merge('gc-neutral');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(repo.refs.get(MAIN)).not.toBeUndefined();
  });

  it('guard completeness: a ref matching no rule keeps today\'s behavior (incomplete merges)', async () => {
    const { repo, feature } = await scenario('gc-norule', { 'big.txt': OVERSIZED }, []);
    const other = await call('POST', `${R('gc-norule')}/branch-rules`, tok.owner, { pattern: 'release/*', guardCompleteness: 'required' });
    expect(other.status).toBe(201);
    const merged = await merge('gc-norule');
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(repo.refs.get(MAIN)).toBe(feature.sha);
  });

  it('guard completeness: an advisory rule and a required rule on the same ref block together', async () => {
    const { repo, main } = await scenario('gc-union', { 'big.txt': OVERSIZED }, [{ pattern: 'main' }, { pattern: 'refs/heads/*', guardCompleteness: 'required' }]);
    const blocked = await merge('gc-union');
    expect([blocked.status, blocked.json.code]).toEqual([409, 'GUARD_INCOMPLETE']);
    expect(repo.refs.get(MAIN)).toBe(main.sha);
  });

  it('guard completeness: the merge queue ejects an incomplete guard bound for a required ref and lands a complete one', async () => {
    const repo = await seedRepo('gc-queue');
    const main = await commit(repo, BASE);
    repo.refs.set(MAIN, main.sha);
    const big = await commit(repo, { ...BASE, 'big.txt': OVERSIZED }, [main.sha]);
    const small = await commit(repo, { ...BASE, 'small.txt': 'small\n' }, [main.sha]);
    repo.refs.set('refs/heads/big', big.sha);
    repo.refs.set('refs/heads/small', small.sha);
    expect((await call('POST', `${R('gc-queue')}/branch-rules`, tok.owner, { pattern: 'main', guardCompleteness: 'required' })).status).toBe(201);
    for (const [n, head] of [[1, 'big'], [2, 'small']] as const) {
      expect((await call('POST', `${R('gc-queue')}/changes`, tok.owner, { title: head, base: 'main', head })).json.number).toBe(n);
      expect((await call('POST', `${R('gc-queue')}/changes/${n}/approve`, tok.reviewer, {})).status).toBe(201);
      const queued = await call('POST', `${R('gc-queue')}/changes/${n}/enqueue`, tok.owner);
      expect(queued.status, JSON.stringify(queued.json)).toBe(201);
    }
    const run = await runTrain(env, repoIds['gc-queue']!, MAIN, { ...defaultTrainDeps, kick: async () => {} });
    expect(run.ejected).toEqual([{ number: 1, code: 'GUARD_INCOMPLETE' }]);
    expect(run.published).toEqual([2]);
    expect(repo.refs.get(MAIN)).not.toBe(main.sha);
  });

  it('guard completeness: a rule raised to required while the queue prepares the pack ejects the incomplete head before sending', async () => {
    const repo = await seedRepo('gc-queue-late');
    const main = await commit(repo, BASE);
    repo.refs.set(MAIN, main.sha);
    const big = await commit(repo, { ...BASE, 'big.txt': OVERSIZED }, [main.sha]);
    repo.refs.set('refs/heads/big', big.sha);
    const rule = await call('POST', `${R('gc-queue-late')}/branch-rules`, tok.owner, { pattern: 'main' });
    expect((await call('POST', `${R('gc-queue-late')}/changes`, tok.owner, { title: 'big', base: 'main', head: 'big' })).status).toBe(201);
    expect((await call('POST', `${R('gc-queue-late')}/changes/1/approve`, tok.reviewer, {})).status).toBe(201);
    expect((await call('POST', `${R('gc-queue-late')}/changes/1/enqueue`, tok.owner)).status).toBe(201);
    let raised = false;
    const run = await runTrain(env, repoIds['gc-queue-late']!, MAIN, {
      ...defaultTrainDeps,
      kick: async () => {},
      pusher(e, r) {
        const real = defaultTrainDeps.pusher(e, r);
        return {
          listRefs: () => real.listRefs(),
          updateRef: (command, objects) => real.updateRef(command, objects),
          async prepareUpdate(command, objects) {
            const prepared = await real.prepareUpdate(command, objects);
            if (!raised) {
              raised = true;
              const patched = await call('PATCH', `${R('gc-queue-late')}/branch-rules/${rule.json.rule.id}`, tok.owner, { guardCompleteness: 'required' });
              expect(patched.status).toBe(200);
            }
            return prepared;
          },
        };
      },
    });
    expect(raised).toBe(true);
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([{ number: 1, code: 'GUARD_INCOMPLETE' }]);
    expect(repo.count('receivePack:')).toBe(0);
    expect(repo.refs.get(MAIN)).toBe(main.sha);
  });
});
