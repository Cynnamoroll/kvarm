/**
 * Job provenance on CI claims (services/ci.ts): what a runner learns about
 * whose code a claimed job runs, so its execution-trust policy can decide
 * before running the command (apps/cli runner `--trust`). Runs through the
 * Worker's routes over the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const seedUser = (login: string) => seedUserBase(env, login);
const seedRepo = async (name: string) => (await seedRepoBase(env, name, { owner: OWNER, visibility: 'private', repoIds })).repo;
const call = (method: string, path: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'prov-owner';
const MAIN = 'refs/heads/main';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

let token = '';
const repoIds: Record<string, string> = {};

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
  const ownerId = await seedUser(OWNER);
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
      agentWritableRef: false,
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
    expect(claimed.json.job.provenance).toMatchObject({ authorKind: 'agent', agentWorkspaceRef: true, agentWritableRef: true, headRef: 'agents/ws-1/fix', agent: null });
  });

  it('marks a head ref that a write agent token was ever granted as agent-writable', async () => {
    await changeWithJob('prov-granted', 'feature/x');
    const agentId = crypto.randomUUID();
    const ownerId = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(OWNER).first<string>('id');
    await env.DB.prepare(
      `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?)`,
    )
      .bind(agentId, ownerId, OWNER, `agent-${agentId.slice(0, 8)}`, ownerId, Date.now())
      .run();
    const grant = (refs: string[] | string, role = 'write', revoked: number | null = null) =>
      env.DB.prepare(
        `INSERT INTO agent_tokens (id, agent_id, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at, revoked_at)
         VALUES (?, ?, 'kvarm_agt_x', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), agentId, crypto.randomUUID(), repoIds['prov-granted'], role, typeof refs === 'string' ? refs : JSON.stringify(refs), ownerId, Date.now(), Date.now() - 1, revoked)
        .run();
    const writable = async () => {
      const claimed = await claim('prov-granted');
      await env.DB.prepare("UPDATE ci_jobs SET status = 'queued' WHERE id = ?").bind(claimed.json.job.id).run();
      expect(claimed.json.job.provenance.authorKind).toBe('human');
      expect(claimed.cost.d1).toBeLessThanOrEqual(2);
      return claimed.json.job.provenance.agentWritableRef as boolean;
    };
    // Other refs, a prefix that stops mid-segment, the bare prefix itself and read tokens never match.
    await grant(['refs/heads/other/*', 'refs/heads/feat/*', 'refs/heads/feature/x/*', 'refs/heads/feature']);
    await grant(['refs/heads/feature/*'], 'read');
    for (let i = 0; i < 250; i++) await grant([`refs/heads/bulk-${i}/*`], 'write', Date.now());
    expect(await writable()).toBe(false);
    // Expired and revoked: the head may still be one the agent pushed before.
    await grant(['refs/heads/feature/*'], 'write', Date.now());
    expect(await writable()).toBe(true);
  });

  it('treats an exact grant and an unreadable grant as agent-writable', async () => {
    await changeWithJob('prov-exact', 'release');
    const agentId = crypto.randomUUID();
    const ownerId = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(OWNER).first<string>('id');
    await env.DB.prepare(`INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at) VALUES (?, 'user', ?, ?, ?, ?, ?)`)
      .bind(agentId, ownerId, OWNER, `agent-${agentId.slice(0, 8)}`, ownerId, Date.now())
      .run();
    const token = (refs: string) =>
      env.DB.prepare(
        `INSERT INTO agent_tokens (id, agent_id, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at)
         VALUES (?, ?, 'kvarm_agt_x', ?, ?, 'write', ?, ?, ?, ?)`,
      )
        .bind(crypto.randomUUID(), agentId, crypto.randomUUID(), repoIds['prov-exact'], refs, ownerId, Date.now(), Date.now() + 60_000)
        .run();
    await token('not json');
    const unreadable = await claim('prov-exact');
    expect(unreadable.json.job.provenance.agentWritableRef).toBe(true);
    await env.DB.prepare("UPDATE ci_jobs SET status = 'queued' WHERE id = ?").bind(unreadable.json.job.id).run();
    await env.DB.prepare('DELETE FROM agent_tokens WHERE repo_id = ?').bind(repoIds['prov-exact']).run();
    await token(JSON.stringify(['refs/heads/release']));
    expect((await claim('prov-exact')).json.job.provenance.agentWritableRef).toBe(true);
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
