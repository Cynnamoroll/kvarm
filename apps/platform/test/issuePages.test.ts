/**
 * Issue pages (routes/issuePages.ts) through the Worker: list, filters,
 * new-issue and edit forms, link confirmation, escaping, access and the
 * cross-site form check.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'ip-owner';

const env = { ...baseEnv, ARTIFACTS: fakeArtifacts } as Env;
const tok = { owner: '', reader: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public'): Promise<{ repo: FakeRepo; main: string }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set('refs/heads/main', main.sha);
  return { repo, main: main.sha };
}

interface Reply {
  status: number;
  text: string;
  location: string | null;
  json: Record<string, any>;
}

async function request(method: string, path: string, opts: { token?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers };
  let body: BodyInit | undefined;
  if (opts.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.json);
  }
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { method, headers, body, redirect: 'manual' }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // HTML
  }
  return { status: res.status, text, location: res.headers.get('location'), json };
}

const pages = (repo: string, rest = '') => `/${OWNER}/${repo}/issues${rest}`;
const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('ip-reader'), 'reader', FULL)).token;
});

afterAll(() => restoreFetch());

describe('issue pages', () => {
  it('files an issue from the form and shows it, escaping text and rendering Markdown', async () => {
    await seedRepo('form');
    const created = await request('POST', pages('form'), {
      token: tok.owner,
      form: { title: 'Crash <img src=x onerror=alert(1)>', body: '**Steps**\n\n<script>alert(1)</script>', paths: 'src/a.ts\n\n src/b.ts ', fingerprint: '' },
    });
    expect(created.status).toBe(303);
    expect(created.location).toBe(`/${OWNER}/form/issues/1`);

    const shown = await request('GET', pages('form', '/1'), { token: tok.owner });
    expect(shown.status).toBe(200);
    expect(shown.text).toContain('Crash &lt;img src=x onerror=alert(1)&gt;');
    expect(shown.text).not.toContain('<img src=x');
    expect(shown.text).toContain('<strong>Steps</strong>');
    expect(shown.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(shown.text).not.toContain('<script>alert(1)</script>');
    expect(shown.text).toContain(`href="/${OWNER}/form/tree/main/src/a.ts"`);
    expect(shown.text).toContain('Close issue');
    expect((await request('GET', api('form', '/issues/1'), { token: tok.owner })).json).toMatchObject({ paths: ['src/a.ts', 'src/b.ts'], source: 'human' });
  });

  it('lists issues with state and source filters, and shows the form only to writers', async () => {
    await seedRepo('list');
    await request('POST', api('list', '/issues'), { token: tok.owner, json: { title: 'First bug' } });
    await request('POST', api('list', '/issues'), { token: tok.owner, json: { title: 'Second bug', fingerprint: 'fp' } });
    await request('POST', api('list', '/issues'), { token: tok.owner, json: { title: 'Second bug', fingerprint: 'fp' } });
    await request('PATCH', api('list', '/issues/1'), { token: tok.owner, json: { state: 'closed', closedReason: 'not_planned' } });

    const anon = await request('GET', pages('list'));
    expect(anon.status).toBe(200);
    expect(anon.text).toContain('Second bug');
    expect(anon.text).not.toContain('First bug');
    expect(anon.text).toContain('×2');
    expect(anon.text).not.toContain('New issue');
    expect(anon.text).toMatch(/class="tab active" href="\/ip-owner\/list\/issues"/);

    const closed = await request('GET', pages('list', '?state=closed'));
    expect(closed.text).toContain('First bug');
    expect(closed.text).toContain('closed · not planned');
    expect(closed.text).not.toContain('Second bug');
    expect((await request('GET', pages('list', '?state=all&source=agent'))).text).toContain('No issues.');

    expect((await request('GET', pages('list'), { token: tok.owner })).text).toContain('New issue');
  });

  it('counts a repeated fingerprint on the open issue and says so', async () => {
    await seedRepo('dedupe');
    await request('POST', pages('dedupe'), { token: tok.owner, form: { title: 'Flaky login test', fingerprint: 'check:login' } });
    const again = await request('POST', pages('dedupe'), { token: tok.owner, form: { title: 'login test flaked again', fingerprint: 'check:login' } });
    expect(again.status).toBe(303);
    expect(again.location).toMatch(/^\/ip-owner\/dedupe\/issues\/1\?notice=/);
    const shown = await request('GET', again.location!, { token: tok.owner });
    expect(shown.text).toContain('your report was counted on it');
    expect(shown.text).toContain('Reported</span> 2 times');
  });

  it('closes, reopens and edits through the form', async () => {
    await seedRepo('edit');
    await request('POST', api('edit', '/issues'), { token: tok.owner, json: { title: 'Typo' } });
    expect((await request('POST', pages('edit', '/1'), { token: tok.owner, form: { action: 'close', closedReason: 'duplicate' } })).status).toBe(303);
    let shown = await request('GET', pages('edit', '/1'), { token: tok.owner });
    expect(shown.text).toContain('closed · duplicate');
    expect(shown.text).toContain('Reopen issue');
    await request('POST', pages('edit', '/1'), { token: tok.owner, form: { action: 'reopen' } });
    await request('POST', pages('edit', '/1'), { token: tok.owner, form: { action: 'edit', title: 'Typo in README', body: 'line 3' } });
    shown = await request('GET', pages('edit', '/1'), { token: tok.owner });
    expect(shown.text).toContain('Typo in README');
    expect(shown.text).toContain('<p>line 3</p>');
    const bad = await request('POST', pages('edit', '/1'), { token: tok.owner, form: { action: 'edit', title: '' } });
    expect(bad.location).toMatch(/\?error=/);
  });

  it('confirms a link proposed by a branch name, which then closes the issue on merge', async () => {
    const r = await seedRepo('links');
    await request('POST', api('links', '/issues'), { token: tok.owner, json: { title: 'Crash' } });
    const c = await commit(r.repo, { 'README.md': 'readme\n', 'fix.txt': 'fix\n' }, [r.main]);
    r.repo.refs.set('refs/heads/fix/1-crash', c.sha);
    const change = await request('POST', api('links', '/changes'), { token: tok.owner, json: { title: 'Crash fix', base: 'main', head: 'fix/1-crash' } });
    expect(change.status).toBe(201);

    let shown = await request('GET', pages('links', '/1'), { token: tok.owner });
    expect(shown.text).toContain('from the branch name');
    expect(shown.text).toContain('>Confirm</button>');
    const confirmed = await request('POST', pages('links', '/1/links'), { token: tok.owner, form: { change: String(change.json.number), state: 'confirmed' } });
    expect(confirmed.location).toMatch(/notice=/);
    shown = await request('GET', pages('links', '/1'), { token: tok.owner });
    expect(shown.text).toContain('set by hand');
    expect(shown.text).not.toContain('>Confirm</button>');

    expect((await request('POST', api('links', `/changes/${change.json.number}/merge`), { token: tok.owner })).status).toBe(200);
    shown = await request('GET', pages('links', '/1'));
    expect(shown.text).toContain('closed · completed');
    expect(shown.text).toContain(`change <strong>#${change.json.number}</strong> at commit`);
  });

  it('refuses cross-site posts, readers and anonymous writers, and conceals private repositories', async () => {
    await seedRepo('guarded');
    const evil = await request('POST', pages('guarded'), { token: tok.owner, form: { title: 'x' }, headers: { origin: 'https://evil.test' } });
    expect(evil.status).toBe(403);
    const fetched = await request('POST', pages('guarded'), { token: tok.owner, form: { title: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
    expect(fetched.status).toBe(403);
    expect((await request('POST', pages('guarded'), { token: tok.owner, form: { title: 'ok' }, headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' } })).status).toBe(303);
    expect((await request('POST', pages('guarded'), { token: tok.reader, form: { title: 'x' } })).status).toBe(404);
    expect((await request('POST', pages('guarded'), { form: { title: 'x' } })).status).toBe(404);
    expect((await request('GET', api('guarded', '/issues?state=all'), { token: tok.owner })).json.issues.map((i: any) => i.title)).toEqual(['ok']);

    await seedRepo('secret', 'private');
    await request('POST', api('secret', '/issues'), { token: tok.owner, json: { title: 'hidden' } });
    expect((await request('GET', pages('secret'))).status).toBe(404);
    expect((await request('GET', pages('secret', '/1'), { token: tok.reader })).status).toBe(404);
    expect((await request('GET', pages('secret', '/1'), { token: tok.owner })).status).toBe(200);
    expect((await request('GET', pages('guarded', '/99'))).status).toBe(404);
  });
});
