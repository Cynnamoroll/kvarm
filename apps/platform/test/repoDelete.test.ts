/**
 * Repo deletion: the DELETE batch is one D1 transaction whose end state must
 * hold no row still referencing a deleted parent (change review requests and
 * carried review files cascade off nothing, forks off nothing), and a repo
 * row whose Artifacts storage is already gone — the half-deleted leftover a
 * failed delete leaves — must purge cleanly and render a clear page.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { call } from './helpers/http';
import { seedRepo, seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'del-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const tok: Record<string, string> = {};

beforeAll(async () => {
  tok.owner = (await mintPAT(env, await seedUser(env, OWNER), 'owner', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

describe('repo deletion', () => {
  it('deletes a repo whose changes still carry review requests and files, storage already gone', async () => {
    const reviewer = await seedUser(env, 'del-reviewer');
    const { id, main } = await seedRepoWithCommit(env, 'harness', { owner: OWNER, visibility: 'private' });
    const changeSet = crypto.randomUUID();
    const review = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at)
         VALUES (?, ?, 1, 'Add a token-bucket rate limit', 'refs/heads/main', 'refs/heads/agents/ws1/atlas', ?, 'open', ?, ?)`,
      ).bind(changeSet, id, main, reviewer, now),
      env.DB.prepare(
        `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'del-reviewer', 'approve', ?, ?)`,
      ).bind(review, id, changeSet, main, `user:${reviewer}`, reviewer, now, now),
      env.DB.prepare('INSERT INTO change_review_files (review_id, path, old_hash, new_hash) VALUES (?, ?, ?, ?)').bind(
        review,
        'src/util.js',
        'f'.repeat(40),
        'e'.repeat(40),
      ),
      env.DB.prepare('INSERT INTO change_review_requests (change_set_id, principal, requested_by, requested_at) VALUES (?, ?, ?, ?)').bind(
        changeSet,
        `user:${reviewer}`,
        reviewer,
        now,
      ),
    ]);
    // Storage already removed, as it is for every leftover a failed delete left.
    await env.ARTIFACTS.delete(`${OWNER}--harness`);
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/harness`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_files WHERE review_id = ?').bind(review).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_requests WHERE change_set_id = ?').bind(changeSet).first()).toEqual({ n: 0 });
  });

  it('deleting a forked parent detaches the forks instead of failing whole', async () => {
    const { id } = await seedRepoWithCommit(env, 'parent', { owner: OWNER, visibility: 'private' });
    const { id: forkId } = await seedRepo(env, 'child-fork', { owner: OWNER, visibility: 'private' });
    await env.DB.prepare('UPDATE repos SET fork_parent_id = ? WHERE id = ?').bind(id, forkId).run();
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/parent`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT fork_parent_id FROM repos WHERE id = ?').bind(forkId).first()).toEqual({ fork_parent_id: null });
  });
});

describe('a repo whose storage is gone', () => {
  it('renders a clear page, not a 500', async () => {
    const { id } = await seedRepoWithCommit(env, 'gone', { owner: OWNER, visibility: 'public' });
    await env.DB.prepare('UPDATE repos SET created_at = created_at - 3600000 WHERE id = ?').bind(id).run();
    await env.ARTIFACTS.delete(`${OWNER}--gone`);
    const res = await call(env, 'GET', `/${OWNER}/gone`);
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer available');
  });

  it('still shows the warming page while a fresh row could be an import settling', async () => {
    await seedRepoWithCommit(env, 'warming', { owner: OWNER, visibility: 'public' });
    await env.ARTIFACTS.delete(`${OWNER}--warming`);
    const res = await call(env, 'GET', `/${OWNER}/warming`);
    expect(res.status).toBe(202);
    expect(res.text).toContain('still being imported');
  });
});
