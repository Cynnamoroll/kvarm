/**
 * Retained cached-public state after a direct D1 visibility flip.
 *
 * The flip is written straight to D1 with no purge, which is what a colo that
 * never saw the PATCH looks like: its repo-row entry, page body, info/refs
 * advertisement and upstream token copy are all still warm and still say
 * "public". Every repo metadata and content response must consult current D1
 * state before any of those is trusted or served.
 */

import { env as cfEnv, exports } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { internalKey, readCachedJson, writeCachedJson } from '../src/cache/internal';
import { COST_HEADER, countingFetch, parseCostHeader, type CostCounters } from '../src/cost/meter';
import type { RepoRow } from '../src/db/repos';
import { infoRefsCacheKey } from '../src/routes/git';
import { resolveRepoAccess } from '../src/services/access';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const OWNER = 'sv-owner';
const OUTSIDER = 'sv-outsider';
const FULL: Scope[] = ['read', 'write', 'api'];

const MARK = {
  meta: 'sv-metadata-marker',
  page: 'sv-page-marker',
  refs: 'sv-refs-marker',
  pack: 'sv-pack-marker',
};

const tok = { owner: '', outsider: '' };
const upstreamCalls: string[] = [];
const originalFetch = globalThis.fetch;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

async function read(res: Response): Promise<{ status: number; text: string; cost: CostCounters }> {
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  return { status: res.status, text: await res.text(), cost: cost! };
}

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  return id;
}

function remoteOf(name: string): string {
  return `https://artifacts.invalid/git/default/${OWNER}--${name}.git`;
}

async function seedRepo(name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, description, created_at) VALUES (?, ?, ?, ?, ?, ?, 'main', ?, ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, name, `${OWNER}--${name}`, remoteOf(name), visibility, MARK.meta, Date.now())
    .run();
}

async function repoRow(name: string): Promise<RepoRow> {
  const row = await env.DB.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?')
    .bind(OWNER, name)
    .first<RepoRow>();
  return row!;
}

/** The repo-row Cache API entry another colo may still hold. */
function retainedRowKey(name: string): Request {
  return internalKey('repo', OWNER, name);
}

async function flipInD1(name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare('UPDATE repos SET visibility = ? WHERE owner_login = ? AND name = ?')
    .bind(visibility, OWNER, name)
    .run();
}

/**
 * Warm public state as a colo would hold it: page body, both info/refs
 * advertisements, a read token copy (so upload-pack reaches the stubbed
 * upstream without an Artifacts mint) and the public repo row itself.
 */
async function warmCaches(name: string): Promise<void> {
  const search = '?service=git-upload-pack';
  const adv = { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'public, max-age=30' };
  await Promise.all([
    caches.default.put(
      new Request(`${ORIGIN}/${OWNER}/${name}`),
      new Response(`<html>${MARK.page}</html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
      }),
    ),
    caches.default.put(infoRefsCacheKey(remoteOf(name), search, null), new Response(`v0 ${MARK.refs}`, { headers: adv })),
    caches.default.put(
      infoRefsCacheKey(remoteOf(name), search, 'version=2'),
      new Response(`v2 ${MARK.refs}`, { headers: adv }),
    ),
    writeCachedJson(internalKey('gittoken', `${OWNER}--${name}`, 'read'), { token: 'fake', expiresAt: Date.now() + 3_600_000 }, 3600),
    writeCachedJson(retainedRowKey(name), await repoRow(name), 60),
  ]);
}

beforeAll(async () => {
  const ownerId = await seedUser(OWNER);
  const outsiderId = await seedUser(OUTSIDER);
  tok.owner = (await mintPAT(env, ownerId, 'sv-owner', FULL)).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'sv-outsider', FULL)).token;
  await seedRepo('flip', 'public');
  await seedRepo('budget', 'public');
  await seedRepo('unflip', 'private');
  // Upstream Artifacts is unavailable hermetically; record any upload-pack or
  // info/refs that gets past authorization instead.
  globalThis.fetch = countingFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    upstreamCalls.push(url.pathname);
    return new Response(`upstream ${MARK.pack}`, { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('retained cached-public row after a direct D1 visibility flip', () => {
  it('denies anonymous and outsider metadata, page, refs and pack reads before any cached body or upstream work', async () => {
    const name = 'flip';
    const meta = `/api/v1/repos/${OWNER}/${name}`;
    const page = `/${OWNER}/${name}`;
    const refs = `/${OWNER}/${name}.git/info/refs?service=git-upload-pack`;
    const pack = `/${OWNER}/${name}.git/git-upload-pack`;
    const packInit = (headers: Record<string, string> = {}): RequestInit => ({
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/x-git-upload-pack-request' },
      body: '0000',
    });

    // Warm every surface while the repo is still public.
    await warmCaches(name);
    for (const headers of [{}, bearer(tok.outsider)]) {
      for (let i = 0; i < 2; i++) {
        const r = await read(await call(meta, { headers }));
        expect(r.status).toBe(200);
        expect(r.text).toContain(MARK.meta);
      }
    }
    const warmPage = await read(await call(page));
    expect(warmPage).toMatchObject({ status: 200, cost: { cache: 'hit' } });
    expect(warmPage.text).toContain(MARK.page);
    const warmRefs = await read(await call(refs));
    expect(warmRefs).toMatchObject({ status: 200, cost: { cache: 'hit', art: 0, sub: 0, do: 0 } });
    expect(warmRefs.text).toContain(MARK.refs);
    const warmPack = await read(await call(pack, packInit()));
    expect(warmPack.status).toBe(200);
    expect(warmPack.text).toContain(MARK.pack);
    const outsiderPack = await read(await call(pack, packInit(basic(tok.outsider))));
    expect(outsiderPack.status).toBe(200);

    // Another colo flips visibility; this colo's caches are untouched.
    await writeCachedJson(retainedRowKey(name), await repoRow(name), 60);
    await flipInD1(name, 'private');
    expect((await readCachedJson<RepoRow>(retainedRowKey(name)))?.visibility).toBe('public');
    expect(await caches.default.match(new Request(`${ORIGIN}${page}`))).toBeTruthy();
    expect(await caches.default.match(infoRefsCacheKey(remoteOf(name), '?service=git-upload-pack', null))).toBeTruthy();

    const upstreamBefore = upstreamCalls.length;
    const deniedBudget = { art: 0, do: 0, sub: 0 };
    for (const [who, headers, gitHeaders, gitStatus] of [
      ['anonymous', {}, {}, 401],
      ['outsider', bearer(tok.outsider), basic(tok.outsider), 404],
    ] as const) {
      const m = await read(await call(meta, { headers }));
      expect(m.status, `${who} metadata`).toBe(404);
      expect(m.text).not.toContain(MARK.meta);
      expect(m.cost).toMatchObject(deniedBudget);
      expect(m.cost.d1).toBeLessThanOrEqual(1);
      expect(m.cost.rr).toBeLessThanOrEqual(8);

      const p = await read(await call(page, { headers }));
      expect(p.status, `${who} page`).toBe(404);
      expect(p.text).not.toContain(MARK.page);
      expect(p.cost).toMatchObject({ ...deniedBudget, cache: 'none' });
      expect(p.cost.d1).toBeLessThanOrEqual(1);

      for (const proto of [{}, { 'Git-Protocol': 'version=2' }] as Record<string, string>[]) {
        const r = await read(await call(refs, { headers: { ...gitHeaders, ...proto } }));
        expect(r.status, `${who} info/refs`).toBe(gitStatus);
        expect(r.text).not.toContain(MARK.refs);
        expect(r.cost).toMatchObject({ ...deniedBudget, cache: 'none' });
        expect(r.cost.d1).toBeLessThanOrEqual(1);
      }

      const k = await read(await call(pack, packInit(gitHeaders)));
      expect(k.status, `${who} upload-pack`).toBe(gitStatus);
      expect(k.text).not.toContain(MARK.pack);
      expect(k.cost).toMatchObject(deniedBudget);
      expect(k.cost.d1).toBeLessThanOrEqual(1);
    }
    expect(upstreamCalls.length).toBe(upstreamBefore);

    // The owner stays authorized on every surface, immediately.
    const ownerMeta = await read(await call(meta, { headers: bearer(tok.owner) }));
    expect(ownerMeta.status).toBe(200);
    expect(JSON.parse(ownerMeta.text)).toMatchObject({ repo: { visibility: 'private', description: MARK.meta } });
    const ownerPage = await resolveRepoAccess(env, {
      owner: OWNER,
      name,
      need: 'read',
      transport: 'page',
      credential: { kind: 'pat', token: tok.owner },
      clientIp: null,
    });
    expect(ownerPage).toMatchObject({ ok: true, role: 'admin', repo: { visibility: 'private' } });
    const ownerRefs = await read(await call(refs, { headers: basic(tok.owner) }));
    expect(ownerRefs.status).toBe(200);
    // Private advertisements are never served from the public cache entry.
    expect(ownerRefs.text).not.toContain(MARK.refs);
    expect(ownerRefs.cost).toMatchObject({ do: 0, sub: 1 });
    const ownerPack = await read(await call(pack, packInit(basic(tok.owner))));
    expect(ownerPack.status).toBe(200);
    expect(ownerPack.text).toContain(MARK.pack);
  });

  it('does not let a retained cached-private row deny a repo that is public again', async () => {
    const name = 'unflip';
    await writeCachedJson(retainedRowKey(name), await repoRow(name), 60);
    await flipInD1(name, 'public');
    const res = await read(await call(`/api/v1/repos/${OWNER}/${name}`));
    expect(res.status).toBe(200);
    expect(res.text).toContain(MARK.meta);
    expect(res.cost.d1).toBe(1);
  });
});

describe('authority lookup on warm public hits', () => {
  it('runs exactly one bounded D1 lookup on warm public metadata, with no writes or DO calls', async () => {
    const meta = `/api/v1/repos/${OWNER}/budget`;
    for (const headers of [{}, bearer(tok.outsider)]) {
      await call(meta, { headers }).then((r) => r.body?.cancel());
      const warm = await read(await call(meta, { headers }));
      expect(warm.status).toBe(200);
      expect(warm.cost).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0, sub: 0 });
      expect(warm.cost.rr).toBeLessThanOrEqual(8);
    }
  });

  it('serves a cached public advertisement only after the lookup, with no Artifacts or upstream work', async () => {
    await warmCaches('budget');
    for (const proto of [null, 'version=2']) {
      const headers: Record<string, string> = proto ? { 'Git-Protocol': proto } : {};
      const res = await read(await call(`/${OWNER}/budget.git/info/refs?service=git-upload-pack`, { headers }));
      expect(res.status).toBe(200);
      expect(res.text).toBe(`${proto ? 'v2' : 'v0'} ${MARK.refs}`);
      expect(res.cost).toMatchObject({ d1: 1, rw: 0, art: 0, do: 0, sub: 0, cache: 'hit' });
      expect(res.cost.rr).toBeLessThanOrEqual(8);
    }
  });
});
