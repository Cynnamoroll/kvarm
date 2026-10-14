import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import worker from '../src/index';
import { groupInbox, type InboxItem } from '../src/services/reviewInbox';
import { commit, fakeArtifacts, fakeRepos, FakeRepo, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'readiness-owner';
const NOW = 1_760_000_000_000;
const repo = new FakeRepo();
let token = '';
let repoId = '';
let authorId = '';
let headSha = '';
const changeIds: Record<string, string> = {};

async function seedChange(number: number, title: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, merge_policy, created_at)
     VALUES (?, ?, ?, ?, 'main', ?, ?, 'open', ?, 'review', ?)`,
  )
    .bind(id, repoId, number, title, `agents/w${number}/work`, headSha, authorId, NOW + number)
    .run();
  changeIds[title] = id;
  return id;
}

beforeAll(async () => {
  installFakeGitRemote();
  const ownerId = crypto.randomUUID();
  authorId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).bind(ownerId, 'test:readiness-owner', OWNER, `${OWNER}@kvarm.invalid`, OWNER, NOW),
    env.DB.prepare(
      'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    ).bind(authorId, 'test:readiness-author', 'readiness-author', 'readiness-author@kvarm.invalid', 'author', NOW),
  ]);
  repoId = crypto.randomUUID();
  const artifactsName = `${OWNER}--readiness`;
  fakeRepos.set(artifactsName, repo);
  const base = await commit(repo, { 'README.md': 'base\n' });
  const head = await commit(repo, { 'README.md': 'base\n', 'ready.ts': 'export {}\n' }, [base.sha]);
  headSha = head.sha;
  repo.refs.set('refs/heads/main', base.sha);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at, pushed_at)
       VALUES (?, ?, 'readiness', ?, 'https://artifacts.invalid/readiness', 'private', 'main', ?, ?)`,
    ).bind(repoId, OWNER, artifactsName, NOW, NOW),
    env.DB.prepare(
      'INSERT INTO review_policies (repo_id, required_reviews, updated_by, updated_at) VALUES (?, 1, ?, ?)',
    ).bind(repoId, ownerId, NOW),
  ]);
  await seedChange(1, 'Ready approval');
  await seedChange(2, 'Conflict blocks approval');
  await env.DB.prepare("UPDATE change_sets SET state = 'conflicted' WHERE id = ?").bind(changeIds['Conflict blocks approval']).run();
  const escalated = await seedChange(3, 'Conflicted escalation remains visible');
  await env.DB.prepare("UPDATE change_sets SET state = 'conflicted' WHERE id = ?").bind(escalated).run();
  await env.DB.prepare(
    `INSERT INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at)
     VALUES (?, ?, ?, 3, 'review-blocked', 'open', ?, 'needs a human', 'system', ?)`,
  )
    .bind(crypto.randomUUID(), repoId, escalated, headSha, NOW)
    .run();
  token = (await mintPAT(env, ownerId, 'readiness', ['read', 'write', 'api'])).token;
});

afterAll(() => restoreFetch());

describe('review inbox readiness', () => {
  it('puts ready items first within an inbox group', () => {
    const item = (ready: boolean) => ({
      requestedForViewer: false,
      reasons: ['approvals-required'],
      readiness: { ready, reason: ready ? null : 'conflicted' },
    }) as unknown as InboxItem;
    const groups = groupInbox([item(false), item(true)]);
    expect(groups[0]?.items.map((entry) => entry.readiness.ready)).toEqual([true, false]);
  });

  it('orders ready approvals first and collapses not-ready approvals without hiding escalations', async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch!(
      new Request(`${ORIGIN}/inbox`, { headers: { Authorization: `Bearer ${token}` } }) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx,
    );
    const text = await response.text();
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const group = text.indexOf('id="g-approvals-required"');
    const details = text.indexOf('<details class="not-ready-group">', group);
    const notReady = text.indexOf('Conflict blocks approval</a>', details);
    const escalation = text.indexOf('Conflicted escalation remains visible');
    expect(notReady).toBeGreaterThan(details);
    expect(escalation).toBeGreaterThan(0);
    expect(escalation).toBeLessThan(details);
    expect(text).toContain('<summary>Not ready yet</summary>');
    expect(text).not.toMatch(/<details class="not-ready-group" open>/);
    expect(text).toContain('<span class="tag tag-pending">conflicted</span>');
    expect(text).toContain('Has conflicts the author must resolve.');
  });
});
