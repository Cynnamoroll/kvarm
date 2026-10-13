/** Guided review pages: the inbox and the review page over the guide service (architecture §0.4.1). */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { toUserRow } from '../src/db/users';
import worker from '../src/index';
import { reviewPageBody } from '../src/render/reviewPage';
import type { ReviewGuideView } from '../src/services/reviewGuide';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'review-page-owner';
const ORIGIN = 'https://kvarm.test';
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

async function pageCall(method: string, path: string, token: string | null, form?: Record<string, string>) {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const init: RequestInit = { method, headers, redirect: 'manual' };
  if (form) init.body = new URLSearchParams(form);
  const response = await worker.fetch!(new Request(`https://kvarm.test${path}`, init) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await response.text();
  await waitOnExecutionContext(ctx);
  return { status: response.status, text, location: response.headers.get('location'), cost: parseCostHeader(response.headers.get(COST_HEADER))! };
}

const pg = (repo: string, rest: string) => `/${OWNER}/${repo}/${rest}`;

describe('guided review pages', () => {
  it('lists changes by whose turn it is and links to the review page', async () => {
    await setup('inbox');
    expect((await openChange('inbox')).status).toBe(201);
    const owner = await pageCall('GET', pg('inbox', 'changes'), tokens.owner);
    expect(owner.status).toBe(200);
    expect(owner.text).toContain('Your turn');
    expect(owner.text).toContain(`href="/${OWNER}/inbox/changes/1"`);
    expect(owner.text).toContain('class="tab active" href="/' + OWNER + '/inbox/changes"');
    const anon = await pageCall('GET', pg('inbox', 'changes'), null);
    expect(anon.status).toBe(200);
    expect(anon.text).toContain('Nothing is waiting on you.');
  });

  it('renders the fallback guide with tiers, inline hunks and ack forms, and acks round-trip', async () => {
    const { head } = await setup('walk');
    await openChange('walk');
    const view = await pageCall('GET', pg('walk', 'changes/1'), tokens.reviewer);
    expect(view.status).toBe(200);
    expect(view.text).toContain('No guide submitted; Kvarm grouped the change by path');
    expect(view.text).toContain('<code>src/a.ts</code>');
    expect(view.text).toContain('export const a = 2;');
    expect(view.text).toMatch(/class="rv-l ins"/);
    expect(view.text).toContain('Mark reviewed');
    expect(view.text).toContain(`name="head" value="${head}"`);
    expect(view.text).toContain('0</span>/');
    const key = /data-key="([^"]+)"/.exec(view.text)![1]!;
    const ack = await pageCall('POST', pg('walk', 'changes/1/ack'), tokens.reviewer, { units: key, head, return: `/${OWNER}/walk/changes/1?view=risk#u-${key}` });
    expect(ack.status, /flash err">([^<]*)/.exec(ack.text)?.[1]).toBe(303);
    expect(ack.location).toBe(`/${OWNER}/walk/changes/1?view=risk#u-${key}`);
    const after = await pageCall('GET', pg('walk', 'changes/1?view=risk'), tokens.reviewer);
    expect(after.text).toContain(`class="rv-unit tier-read acked" id="u-${key}"`);
    expect(after.text).toContain('>Reviewed</button>');
    const offsite = await pageCall('POST', pg('walk', 'changes/1/ack'), tokens.reviewer, { units: key, head, return: 'https://evil.example/' });
    expect(offsite.location).toBe(`/${OWNER}/walk/changes/1`);
  });

  it('hides write controls from anonymous viewers and refuses their posts', async () => {
    await setup('anon');
    await openChange('anon');
    const view = await pageCall('GET', pg('anon', 'changes/1?view=files'), null);
    expect(view.status).toBe(200);
    expect(view.text).not.toContain('Mark reviewed');
    expect(view.text).not.toContain('name="verdict"');
    expect((await pageCall('POST', pg('anon', 'changes/1/ack'), null, { units: 'x' })).status).toBe(404);
    expect((await pageCall('GET', pg('anon', 'changes/9'), null)).status).toBe(404);
  });

  it('requires a valid same-origin session CSRF token for guided-review writes', async () => {
    const { head } = await setup('session-csrf');
    await openChange('session-csrf');
    const authEnv = {
      ...env,
      WORKOS_CLIENT_ID: 'client_fake',
      WORKOS_API_KEY: 'sk_fake_not_a_real_key',
      WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
    } as Env;
    const row = await env.DB.prepare('SELECT * FROM users WHERE login = ?1').bind(OWNER).first<Parameters<typeof toUserRow>[0]>();
    const payload = newSessionPayload(toUserRow(row!), {
      user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
      refreshToken: 'rt_unused',
      sessionId: null,
    });
    const cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
    const browser = async (method: string, path: string, form?: Record<string, string>) => {
      const ctx = createExecutionContext();
      const headers: Record<string, string> = { cookie };
      if (form) {
        headers.origin = ORIGIN;
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const response = await worker.fetch!(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(form ? { body: new URLSearchParams(form) } : {}),
          redirect: 'manual',
        }) as Request<unknown, IncomingRequestCfProperties>,
        authEnv,
        ctx,
      );
      const text = await response.text();
      await waitOnExecutionContext(ctx);
      return { status: response.status, text };
    };
    const page = await browser('GET', pg('session-csrf', 'changes/1'));
    expect(page.status).toBe(200);
    expect(page.text).toContain(`name="_csrf" value="${payload.csrf}"`);

    const missing = await browser('POST', pg('session-csrf', 'changes/1/ack'), { units: 'unit', head });
    expect(missing.status).toBe(403);
    const wrong = await browser('POST', pg('session-csrf', 'changes/1/review'), { _csrf: 'incorrect', verdict: 'approve', head });
    expect(wrong.status).toBe(403);
  });

  it('records a verdict at the shown head and reports a moved head inline', async () => {
    const { head } = await setup('verdict');
    await openChange('verdict');
    const ok = await pageCall('POST', pg('verdict', 'changes/1/review'), tokens.reviewer, { verdict: 'approve', head });
    expect(ok.status).toBe(303);
    const reviews = await call('GET', api('verdict', '/changes/1/reviews'), tokens.owner);
    expect(reviews.json.approvals.count).toBe(1);
    const stale = await pageCall('POST', pg('verdict', 'changes/1/review'), tokens.reviewer, { verdict: 'approve', head: 'a'.repeat(40) });
    expect(stale.status).toBe(200);
    expect(stale.text).toContain('HEAD_MOVED');
  });

  it('keeps the review page within bounded work', async () => {
    await setup('budget');
    await openChange('budget');
    await pageCall('GET', pg('budget', 'changes/1'), tokens.reviewer);
    const warm = await pageCall('GET', pg('budget', 'changes/1'), tokens.reviewer);
    expect(warm.cost.do).toBe(0);
    expect(warm.cost.d1).toBeLessThanOrEqual(6);
    costs.page = warm.cost;
  });
  it('renders stack layers, inherited units and the focused-layer toggle', async () => {
    await setup('stack');
    await openChange('stack');
    const guide = await call('GET', api('stack', '/changes/1/review-guide?include=hunks'), tokens.owner);
    expect(guide.status).toBe(200);
    const view = guide.json as unknown as ReviewGuideView;
    const unit = view.units.find((u) => u.path === 'src/a.ts')!;
    const layer = { number: 7, title: 'Parent layer', state: 'open', headSha: null, edgeState: 'active' as const, waitingOn: 'reviewers' as const, approvals: { have: 0, need: 1 } };
    const stacked: ReviewGuideView = {
      ...view,
      units: view.units.map((u) => (u.key === unit.key ? { ...u, inherited: { change: 7 } } : u)),
      stack: { parents: [layer], children: [{ ...layer, number: 9, title: 'Child layer', edgeState: 'stale' }], inherited: 1 },
    };
    const input = { view: stacked, title: 'Stacked', base: `/${OWNER}/stack`, mode: 'guided' as const, canWrite: true, canReview: true };
    const full = reviewPageBody(input);
    expect(full).toContain('<div class="card-title">Stack</div>');
    expect(full).toContain(`href="/${OWNER}/stack/changes/7">#7</a> Parent layer`);
    expect(full).toContain(`href="/${OWNER}/stack/changes/9">#9</a> Child layer`);
    expect(full).toContain('<span class="chip signal" title="dependency edge">stale</span>');
    expect(full).toContain(`<a class="chip" href="/${OWNER}/stack/changes/7"`);
    expect(full).toContain(`href="/${OWNER}/stack/changes/1?view=guided&amp;since=parent">only this layer</a>`);
    const focused = reviewPageBody({ ...input, focus: true });
    expect(focused).toContain('show all 1 inherited unit too');
    expect(focused).toContain(`name="return" value="/${OWNER}/stack/changes/1?view=guided&amp;since=parent#`);
    const plain = reviewPageBody({ ...input, view: { ...view, stack: { parents: [], children: [], inherited: 0 } } });
    expect(plain).not.toContain('<div class="card-title">Stack</div>');
  });

  it('passes since=parent through to the guide for the focused layer', async () => {
    await setup('focus');
    await openChange('focus');
    const page = await pageCall('GET', pg('focus', 'changes/1?since=parent'), tokens.owner);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<code>src/a.ts</code>');
  });
});
