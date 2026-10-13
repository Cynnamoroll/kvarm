/**
 * Job provenance on CI claims (services/ci.ts): what a runner learns about
 * whose code a claimed job runs, so its execution-trust policy can decide
 * before running the command (apps/cli runner `--trust`). Runs through the
 * Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'prov-owner';
const MAIN = 'refs/heads/main';

class FakeWorkflow {
  async create(opts: { id?: string }) {
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

let token = '';
const repoIds: Record<string, string> = {};

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

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any>; cost: CostCounters }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost).not.toBeNull();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {}, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const CONFIG = JSON.stringify({ version: 1, jobs: [{ name: 'build', run: 'echo ok', required: true }] });
const BASE: Files = { 'README.md': '# App\n', '.kvarm/ci.json': CONFIG };

/** A repository with one open change from `head` and its CI job queued. */
async function changeWithJob(name: string, head = 'feature') {
  const repo = await seedRepo(name);
  const main = await commit(repo, BASE);
  const feature = await commit(repo, { ...BASE, 'feature.txt': 'feature\n' }, [main.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set(`refs/heads/${head}`, feature.sha);
  const created = await call('POST', `${R(name)}/changes`, { title: 't', base: 'main', head });
  expect(created.status).toBe(201);
  return { feature, number: created.json.number as number };
}

const claim = (name: string) => call('POST', `${R(name)}/ci/jobs/claim`, { runnerId: 'provenance-runner' });

beforeAll(async () => {
  installFakeGitRemote();
  const ownerId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(ownerId, `test:${OWNER}`, OWNER, `${OWNER}@kvarm.invalid`, OWNER, Date.now())
    .run();
  token = (await mintPAT(env, ownerId, 'owner', ['read', 'write', 'api', 'ci'])).token;
});

afterAll(() => restoreFetch());

describe('CI claim provenance', () => {
  it('names a human-authored change head, within the claim cost budget', async () => {
    const { feature, number } = await changeWithJob('prov-human');
    const claimed = await claim('prov-human');
    expect(claimed.status).toBe(200);
    expect(claimed.json.job.sha).toBe(feature.sha);
    expect(claimed.json.job.provenance).toEqual({
      changeNumber: number,
      headRef: 'feature',
      commit: 'head',
      authorKind: 'human',
      authorLogin: OWNER,
      agent: null,
      agentWorkspaceRef: false,
    });
    expect(claimed.cost.d1).toBeLessThanOrEqual(2);
  });

  it('marks a change opened by an agent token as agent-authored', async () => {
    await changeWithJob('prov-agent');
    await env.DB.prepare('UPDATE change_sets SET agent_meta = ? WHERE repo_id = ?')
      .bind(JSON.stringify({ agentId: 'agent-1', agentName: 'builder', tokenId: 'tok-1' }), repoIds['prov-agent'])
      .run();
    const claimed = await claim('prov-agent');
    expect(claimed.json.job.provenance).toMatchObject({ authorKind: 'agent', agent: { id: 'agent-1', name: 'builder' }, commit: 'head' });
  });

  it('marks an agent workspace head ref as agent-authored even when a human opened the change', async () => {
    await changeWithJob('prov-workspace', 'agents/ws-1/fix');
    const claimed = await claim('prov-workspace');
    expect(claimed.json.job.provenance).toMatchObject({ authorKind: 'agent', agentWorkspaceRef: true, headRef: 'agents/ws-1/fix', agent: null });
  });

  it('marks a job whose commit is not the change head as prepared', async () => {
    await changeWithJob('prov-prepared');
    await env.DB.prepare('UPDATE change_sets SET head_sha = ? WHERE repo_id = ?').bind('f'.repeat(40), repoIds['prov-prepared']).run();
    const claimed = await claim('prov-prepared');
    expect(claimed.json.job.provenance).toMatchObject({ commit: 'prepared', authorKind: 'human' });
  });

  it('keeps heartbeat responses free of provenance', async () => {
    await changeWithJob('prov-heartbeat');
    const claimed = await claim('prov-heartbeat');
    const beat = await call('POST', `${R('prov-heartbeat')}/ci/jobs/${claimed.json.job.id}/heartbeat`, {
      runnerId: 'provenance-runner',
      generation: claimed.json.job.generation,
    });
    expect(beat.status).toBe(200);
    expect(beat.json.job.provenance).toBeUndefined();
  });
});
