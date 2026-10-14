/**
 * Flaky required checks (issue #13, services/flakes.ts and the reportJob
 * retry in services/ci.ts): a failed required, non-quarantined runner check
 * gets exactly one automatic second attempt of the same head and tree; a
 * pass on attempt 2 records a flake registry entry with the first attempt's
 * failure as evidence; per-name quarantine keeps checks running but out of
 * the checks gate and the commit-status rollup until restore. Runs through
 * the Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { FakeRepo, commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const seedUser = (login: string) => seedUserBase(env, login, { userIds });
async function seedRepo(name: string) {
  const { id, repo } = await seedRepoBase(env, name, { owner: OWNER, visibility: 'private' });
  const now = Date.now();
  const grant = (login: string, role: 'read' | 'write') =>
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(id, userIds[login], role, now, now)
      .run();
  await grant('fl-reader', 'read');
  await grant('fl-writer', 'write');
  return repo;
}
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const OWNER = 'fl-owner';
const MAIN = 'refs/heads/main';
const FEATURE = 'refs/heads/feature';
const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'module.exports = 1;\n' };
const tok = { owner: '', reader: '', writeRole: '', outsider: '' };
const userIds: Record<string, string> = {};

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const create = (repo: string, body: Record<string, unknown> = {}) =>
  call('POST', `${R(repo)}/changes`, tok.owner, { title: 't', base: 'main', head: 'feature', ...body });
const checksOf = (repo: string, n = 1) => call('GET', `${R(repo)}/changes/${n}/checks`, tok.owner);
const claim = (repo: string, runnerId: string, token = tok.owner) => call('POST', `${R(repo)}/ci/jobs/claim`, token, { runnerId });
const reportJob = (repo: string, id: string, runnerId: string, generation: number, conclusion: 'success' | 'failure', summary: unknown) =>
  call('POST', `${R(repo)}/ci/jobs/${id}/report`, tok.owner, { runnerId, generation, conclusion, summary });

/** main = base; feature = main + edit, with `.kvarm/ci.json` on both sides. */
async function fixture(repo: FakeRepo, configText: string, edit: Record<string, string>) {
  const withConfig = (files: Files): Files => ({ ...files, '.kvarm/ci.json': configText });
  const main = await commit(repo, withConfig(BASE));
  const feature = await commit(repo, withConfig({ ...BASE, ...edit }), [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(FEATURE, feature.sha);
  return { main, feature };
}

const configText = (jobs: Array<{ name: string; run: string; required?: boolean }>) => `${JSON.stringify({ jobs })}\n`;

/**
 * Drives one check to its terminal state: claim, report `first`, and when
 * `first` requeued a retry (required failures do), claim and report `second`.
 */
async function drive(repo: string, name: string, first: 'success' | 'failure', second: 'success' | 'failure', summary: Record<string, unknown> = { exitCode: 1 }) {
  const one = await claim(repo, 'runner-a');
  expect(one.status).toBe(200);
  expect(one.json.job.name).toBe(name);
  const reportedOne = await reportJob(repo, one.json.job.id, 'runner-a', one.json.job.generation, first, summary);
  const two = await claim(repo, 'runner-b');
  if (two.status !== 200) return { reportedOne, reportedTwo: null, secondClaim: two };
  const reportedTwo = await reportJob(repo, two.json.job.id, 'runner-b', two.json.job.generation, second, summary);
  return { reportedOne, reportedTwo, secondClaim: two };
}

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  const ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', all)).token;
  const readerId = await seedUser('fl-reader');
  tok.reader = (await mintPAT(env, readerId, 'reader', ['read', 'api'])).token;
  const writerId = await seedUser('fl-writer');
  tok.writeRole = (await mintPAT(env, writerId, 'writer', all)).token;
  const outsiderId = await seedUser('fl-outsider');
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', all)).token;
});

afterAll(() => restoreFetch());

describe('retry-then-classify (issue #13)', () => {
  it('requeues exactly one automatic retry of a required failure on the same head and tree, then stops', async () => {
    const repo = await seedRepo('fl-twice');
    const config = configText([{ name: 'build', run: 'make', required: true }]);
    const { feature } = await fixture(repo, config, { 'one.txt': 'one\n' });
    await create('fl-twice');

    const one = await claim('fl-twice', 'runner-a');
    expect(one.json.job).toMatchObject({ name: 'build', sha: feature.sha, treeSha: feature.tree, generation: 1 });
    const failed = await reportJob('fl-twice', one.json.job.id, 'runner-a', 1, 'failure', { exitCode: 1, stderr: 'flaky' });
    expect(failed.status).toBe(200);
    expect(failed.json.retried).toBe(true);
    expect(failed.json.run).toMatchObject({ name: 'build', status: 'queued', attempt: 2, conclusion: null, headSha: feature.sha, treeSha: feature.tree });
    // The queued retry keeps the first attempt's failure as visible evidence.
    expect((await checksOf('fl-twice')).json.checks.find((r: any) => r.name === 'build').summary).toMatchObject({ stderr: 'flaky' });

    const retry = await claim('fl-twice', 'runner-b');
    expect(retry.json.job).toMatchObject({ name: 'build', sha: feature.sha, treeSha: feature.tree, generation: 1 });
    expect(retry.json.job.id).not.toBe(one.json.job.id);
    const failedTwice = await reportJob('fl-twice', retry.json.job.id, 'runner-b', 1, 'failure', { exitCode: 1 });
    expect(failedTwice.json.retried).toBe(false);
    expect(failedTwice.json.run).toMatchObject({ status: 'failure', attempt: 2, conclusion: 'failure' });

    // Never a third attempt: the queue is empty and the check blocks as today.
    expect((await claim('fl-twice', 'runner-c')).status).toBe(204);
    const mergeability = await call('GET', `${R('fl-twice')}/changes/1/mergeability`, tok.owner);
    expect(mergeability.json.mergeability.checks).toMatchObject({ state: 'failure' });
    expect((await call('GET', `${R('fl-twice')}/ci/flakes`, tok.owner)).json.flakes).toHaveLength(0);
  });

  it('records a flake with the first attempt as evidence when the retry passes; a first-attempt pass is never a flake', async () => {
    const repo = await seedRepo('fl-pass');
    const config = configText([{ name: 'test', run: 'pytest', required: true }]);
    const { feature } = await fixture(repo, config, { 'two.txt': 'two\n' });
    await create('fl-pass');

    const { reportedOne, reportedTwo } = await drive('fl-pass', 'test', 'failure', 'success', { exitCode: 1, stderr: 'timeout' });
    expect(reportedOne!.json.retried).toBe(true);
    expect(reportedTwo!.json.retried).toBe(false);
    expect(reportedTwo!.json.run).toMatchObject({ status: 'success', attempt: 2, conclusion: 'success' });
    expect((await call('GET', `${R('fl-pass')}/commits/${feature.sha}/status`, tok.owner)).json).toMatchObject({ state: 'success' });

    const flakes = await call('GET', `${R('fl-pass')}/ci/flakes`, tok.owner);
    expect(flakes.status).toBe(200);
    expect(flakes.json.flakes).toHaveLength(1);
    expect(flakes.json.flakes[0]).toMatchObject({
      name: 'test',
      change: 1,
      headSha: feature.sha,
      treeSha: feature.tree,
      attempt: 2,
      summary: { exitCode: 1, stderr: 'timeout' },
    });
    expect(flakes.json.quarantined).toEqual([]);

    const clean = await seedRepo('fl-clean');
    await fixture(clean, config, { 'three.txt': 'three\n' });
    await create('fl-clean');
    const { reportedTwo: direct } = await drive('fl-clean', 'test', 'success', 'success');
    expect(direct).toBeNull();
    expect((await call('GET', `${R('fl-clean')}/ci/flakes`, tok.owner)).json.flakes).toHaveLength(0);
  });

  it('a non-required failure and a quarantined name conclude at once, without a retry', async () => {
    const optional = await seedRepo('fl-optional');
    await fixture(optional, configText([{ name: 'optional', run: 'lint', required: false }]), { 'four.txt': 'four\n' });
    await create('fl-optional');
    const { reportedOne, reportedTwo } = await drive('fl-optional', 'optional', 'failure', 'failure');
    expect(reportedOne!.json.retried).toBe(false);
    expect(reportedOne!.json.run).toMatchObject({ status: 'failure', attempt: 1, conclusion: 'failure' });
    expect(reportedTwo).toBeNull();

    const quarantined = await seedRepo('fl-q-run');
    const config = configText([{ name: 'flaky', run: 'x', required: true }]);
    const { main } = await fixture(quarantined, config, { 'five.txt': 'five\n' });
    await create('fl-q-run');
    expect((await call('POST', `${R('fl-q-run')}/ci/flakes/flaky/quarantine`, tok.owner)).status).toBe(200);
    // A change opened after the quarantine queues the job with a quarantined check run.
    const second = await commit(quarantined, { ...BASE, '.kvarm/ci.json': config, 'six.txt': 'six\n' }, [main.sha]);
    quarantined.refs.set('refs/heads/feature2', second.sha);
    await create('fl-q-run', { head: 'feature2' });
    const queued = await checksOf('fl-q-run', 2);
    expect(queued.json.checks.find((r: any) => r.name === 'flaky')).toMatchObject({ status: 'queued', quarantined: true, required: true });
    // The job still runs...
    const claimed = await claim('fl-q-run', 'runner-a');
    expect(claimed.json.job).toMatchObject({ name: 'flaky' });
    const terminal = await reportJob('fl-q-run', claimed.json.job.id, 'runner-a', 1, 'failure', { exitCode: 1 });
    expect(terminal.json.retried).toBe(false);
    expect(terminal.json.run).toMatchObject({ status: 'failure', attempt: 1 });
    // ...and never blocks the gate.
    expect((await call('GET', `${R('fl-q-run')}/changes/2/mergeability`, tok.owner)).json.mergeability.checks).toMatchObject({ state: 'success' });
  });
});

describe('quarantine, restore and visibility (issue #13)', () => {
  it('quarantine takes a failed required check out of the gate and rollup; restore returns it; only repo admins may act', async () => {
    const repo = await seedRepo('fl-gate');
    const { feature } = await fixture(repo, configText([{ name: 'test', run: 'x', required: true }]), { 'six.txt': 'six\n' });
    await create('fl-gate');
    const { reportedTwo } = await drive('fl-gate', 'test', 'failure', 'failure');
    expect(reportedTwo!.json.run.status).toBe('failure');
    const before = await call('GET', `${R('fl-gate')}/changes/1/mergeability`, tok.owner);
    expect(before.json.mergeability.checks).toMatchObject({ state: 'failure' });

    // Authorization: write is not enough, outsiders do not see the repository.
    expect((await call('POST', `${R('fl-gate')}/ci/flakes/test/quarantine`, tok.writeRole)).status).toBe(403);
    expect((await call('POST', `${R('fl-gate')}/ci/flakes/test/quarantine`, tok.outsider)).status).toBe(404);
    expect((await call('POST', `${R('fl-gate')}/ci/flakes/test/quarantine`, tok.reader)).status).toBe(403);
    // Platform-reserved check names cannot be quarantined away.
    const reserved = await call('POST', `${R('fl-gate')}/ci/flakes/${encodeURIComponent('kvarm/guard')}/quarantine`, tok.owner);
    expect([reserved.status, reserved.json.code]).toEqual([422, 'INVALID_CHECK_NAME']);

    const quarantined = await call('POST', `${R('fl-gate')}/ci/flakes/test/quarantine`, tok.owner);
    expect(quarantined.status).toBe(200);
    expect(quarantined.json).toMatchObject({ name: 'test', quarantined: true, checkRuns: expect.any(Number) });
    expect(quarantined.cost.do).toBe(0);

    // The listing shows the quarantine; the run row is visibly quarantined.
    const listing = await call('GET', `${R('fl-gate')}/ci/flakes`, tok.owner);
    expect(listing.json.quarantined).toEqual([expect.objectContaining({ name: 'test', quarantinedBy: OWNER })]);
    expect((await checksOf('fl-gate')).json.checks.find((r: any) => r.name === 'test').quarantined).toBe(true);

    // Quarantined checks never satisfy or block a required-checks gate.
    const during = await call('GET', `${R('fl-gate')}/changes/1/mergeability`, tok.owner);
    expect(during.json.mergeability.checks).toMatchObject({ state: 'success' });
    expect(during.json.mergeability.checks.required.find((r: any) => r.name === 'test')).toBeUndefined();
    expect((await call('GET', `${R('fl-gate')}/commits/${feature.sha}/status`, tok.owner)).json).toMatchObject({ state: 'success' });

    const restore = await call('POST', `${R('fl-gate')}/ci/flakes/test/restore`, tok.owner);
    expect(restore.status).toBe(200);
    expect(restore.json).toMatchObject({ name: 'test', quarantined: false });
    expect((await call('GET', `${R('fl-gate')}/changes/1/mergeability`, tok.owner)).json.mergeability.checks).toMatchObject({ state: 'failure' });
    expect((await call('GET', `${R('fl-gate')}/ci/flakes`, tok.owner)).json.quarantined).toHaveLength(0);
    // Restoring a name that is not quarantined is an explicit 404.
    expect((await call('POST', `${R('fl-gate')}/ci/flakes/test/restore`, tok.owner)).status).toBe(404);
  });

  it('lists the CI job queue for readers, newest first, with claims and leases, within budget', async () => {
    const repo = await seedRepo('fl-jobs');
    await fixture(repo, configText([{ name: 'build', run: 'make', required: true }, { name: 'test', run: 'pytest', required: true }]), {
      'seven.txt': 'seven\n',
    });
    await create('fl-jobs');

    // Anonymous REST callers cannot distinguish a private repository from a missing one.
    const unauthorized = await call('GET', `${R('fl-jobs')}/ci/jobs`);
    expect([unauthorized.status, unauthorized.json.code]).toEqual([404, 'NOT_FOUND']);
    const denied = await call('GET', `${R('fl-jobs')}/ci/jobs`, tok.outsider);
    expect(denied.status).toBe(404);

    const one = await claim('fl-jobs', 'runner-a');
    expect(one.json.job.name).toBe('build');
    await reportJob('fl-jobs', one.json.job.id, 'runner-a', 1, 'success', { exitCode: 0 });

    const jobs = await call('GET', `${R('fl-jobs')}/ci/jobs`, tok.reader);
    expect(jobs.status).toBe(200);
    expect(jobs.json.jobs.map((j: any) => [j.name, j.status])).toEqual([
      ['test', 'queued'],
      ['build', 'success'],
    ]);
    expect(jobs.json.jobs[0]).toMatchObject({ name: 'test', required: true, quarantined: false, change: 1, runnerId: null, leaseUntil: null });
    expect(jobs.json.jobs[1]).toMatchObject({ name: 'build', change: 1, runnerId: 'runner-a', startedAt: expect.any(String), finishedAt: expect.any(String) });
    expect(jobs.json.nextCursor).toBeNull();
    // One authority lookup plus one bounded queue read.
    expect(jobs.cost.d1).toBeLessThanOrEqual(2);
    expect(jobs.cost.do).toBe(0);
  });
});
