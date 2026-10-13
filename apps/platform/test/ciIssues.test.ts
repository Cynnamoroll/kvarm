/**
 * Flakes and quarantine tracked as issues (services/issues.ts wired into
 * services/ci.ts reportJob and services/flakes.ts): a registered flake files
 * or counts on the check's open issue, a quarantine keeps one open, a
 * restore closes it, and a later flake is a recurrence.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

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
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

const ORIGIN = 'https://kvarm.test';
const OWNER = 'ci-iss-owner';
const MAIN = 'refs/heads/main';
const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'module.exports = 1;\n' };
const tok = { owner: '', reader: '', writeRole: '', outsider: '' };
const userIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  userIds[login] = id;
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
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  const now = Date.now();
  const grant = (login: string, role: 'read' | 'write') =>
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .bind(id, userIds[login], role, now, now)
      .run();
  await grant('ci-iss-reader', 'read');
  await grant('ci-iss-writer', 'write');
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
  } catch {}
  return { status: res.status, text, json, cost: cost! };
}


const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const claim = (repo: string, runnerId: string) => call('POST', `${R(repo)}/ci/jobs/claim`, tok.owner, { runnerId });
const reportJob = (repo: string, id: string, runnerId: string, generation: number, conclusion: 'success' | 'failure') =>
  call('POST', `${R(repo)}/ci/jobs/${id}/report`, tok.owner, { runnerId, generation, conclusion, summary: { exitCode: conclusion === 'success' ? 0 : 1 } });
const issues = (repo: string, q = '?state=all') => call('GET', `${R(repo)}/issues${q}`, tok.owner);
const config = `${JSON.stringify({ jobs: [{ name: 'Unit Tests', run: 'npm test', required: true }] })}\n`;

/** One change whose required check fails then passes on its retry (a flake). */
async function flakeOnce(repo: FakeRepo, name: string, branch: string, file: string) {
  const main = repo.refs.get(MAIN)!;
  const head = await commit(repo, { ...BASE, '.kvarm/ci.json': config, [file]: `${file}\n` }, [main]);
  repo.refs.set(`refs/heads/${branch}`, head.sha);
  const created = await call('POST', `${R(name)}/changes`, tok.owner, { title: branch, base: 'main', head: branch });
  expect(created.status).toBe(201);
  const one = await claim(name, 'runner-a');
  expect((await reportJob(name, one.json.job.id, 'runner-a', one.json.job.generation, 'failure')).json.retried).toBe(true);
  const two = await claim(name, 'runner-b');
  const passed = await reportJob(name, two.json.job.id, 'runner-b', two.json.job.generation, 'success');
  expect(passed.status).toBe(200);
  return { head: head.sha, change: created.json.number as number, retryJob: two.json.job };
}

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', all)).token;
  await seedUser('ci-iss-reader');
  await seedUser('ci-iss-writer');
});

afterAll(() => restoreFetch());

describe('flakes and quarantine as issues', () => {
  it('a flake files one issue per check, counts repeats, survives quarantine and closes on restore', async () => {
    const repo = await seedRepo('ci-iss');
    const main = await commit(repo, { ...BASE, '.kvarm/ci.json': config });
    repo.refs.set(MAIN, main.sha);

    const first = await flakeOnce(repo, 'ci-iss', 'f1', 'one.txt');
    let list = (await issues('ci-iss')).json.issues;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      number: 1,
      title: 'Check Unit Tests is flaky',
      source: 'flake',
      fingerprint: 'check:unit tests',
      occurrences: 1,
      state: 'open',
      evidence: { check: 'Unit Tests', sha: first.head },
    });
    expect(list[0].body).toContain('(change #1)');

    // A repeated report of the same retry counts nothing more.
    expect((await reportJob('ci-iss', first.retryJob.id, 'runner-b', first.retryJob.generation, 'success')).status).toBe(409);
    expect((await issues('ci-iss')).json.issues[0].occurrences).toBe(1);

    await flakeOnce(repo, 'ci-iss', 'f2', 'two.txt');
    list = (await issues('ci-iss')).json.issues;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ number: 1, occurrences: 2 });

    // Quarantine keeps the open flake issue as the tracker; no second issue.
    expect((await call('POST', `${R('ci-iss')}/ci/flakes/Unit%20Tests/quarantine`, tok.owner)).status).toBe(200);
    expect((await issues('ci-iss')).json.issues).toHaveLength(1);

    expect((await call('POST', `${R('ci-iss')}/ci/flakes/Unit%20Tests/restore`, tok.owner)).status).toBe(200);
    expect((await call('GET', `${R('ci-iss')}/issues/1`, tok.owner)).json).toMatchObject({ state: 'closed', closedReason: 'restored', closedBy: null });

    // After the restore the next flake is a recurrence: a new issue.
    await flakeOnce(repo, 'ci-iss', 'f3', 'three.txt');
    list = (await issues('ci-iss', '?state=open')).json.issues;
    expect(list).toEqual([expect.objectContaining({ number: 2, source: 'flake', occurrences: 1 })]);
  });

  it('quarantining a check with no open issue files one that tracks it', async () => {
    await seedRepo('ci-iss-q');
    expect((await call('POST', `${R('ci-iss-q')}/ci/flakes/lint/quarantine`, tok.owner)).status).toBe(200);
    const list = (await issues('ci-iss-q')).json.issues;
    expect(list).toEqual([expect.objectContaining({ title: 'Check lint is quarantined', source: 'ci', fingerprint: 'check:lint', state: 'open' })]);
    expect(list[0].body).toContain(`quarantined by ${OWNER}`);
    // Quarantining again keeps the one issue.
    await call('POST', `${R('ci-iss-q')}/ci/flakes/lint/quarantine`, tok.owner);
    expect((await issues('ci-iss-q')).json.issues).toHaveLength(1);
    await call('POST', `${R('ci-iss-q')}/ci/flakes/lint/restore`, tok.owner);
    expect((await issues('ci-iss-q', '?state=closed')).json.issues).toEqual([expect.objectContaining({ closedReason: 'restored' })]);
  });
});
