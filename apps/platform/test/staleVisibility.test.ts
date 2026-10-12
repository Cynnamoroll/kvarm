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
import { mintPAT, patHash, readPatCache, type Scope } from '../src/auth/pat';
import { internalKey, readCachedJson, writeCachedJson } from '../src/cache/internal';
import { COST_HEADER, countingFetch, parseCostHeader, type CostCounters } from '../src/cost/meter';
import type { RepoRow } from '../src/db/repos';
import { pageCacheKey } from '../src/cache/edge';
import { infoRefsCacheKey } from '../src/routes/git';
import { resolveRepoAccess } from '../src/services/access';
import { repoViewGeneration } from '../src/services/pushFreshness';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
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
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
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

/** Edge keys a colo holds for a public repo's branch views at its current generation. */
async function pageKey(name: string, path: string): Promise<Request> {
  return pageCacheKey(new Request(`${ORIGIN}${path}`), await repoViewGeneration(await repoRow(name)));
}

async function refsKey(name: string, gitProtocol: string | null): Promise<Request> {
  const gen = await repoViewGeneration(await repoRow(name));
  return infoRefsCacheKey(remoteOf(name), '?service=git-upload-pack', gitProtocol, gen);
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
  const adv = { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'public, max-age=30' };
  await Promise.all([
    caches.default.put(
      await pageKey(name, `/${OWNER}/${name}`),
      new Response(`<html>${MARK.page}</html>`, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' },
      }),
    ),
    caches.default.put(await refsKey(name, null), new Response(`v0 ${MARK.refs}`, { headers: adv })),
    caches.default.put(await refsKey(name, 'version=2'), new Response(`v2 ${MARK.refs}`, { headers: adv })),
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
  await seedRepo('pages', 'public');
  await seedRepo('concealed', 'private');
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
    expect(await caches.default.match(await pageKey(name, page))).toBeTruthy();
    expect(await caches.default.match(await refsKey(name, null))).toBeTruthy();

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

describe('rejected Bearer on a page falls back to anonymous on the same authority lookup', () => {
  const PAGE_MARK = 'sv-fallback-page-marker';
  const RAW_MARK = 'sv-fallback-raw-marker';

  function unknownPat(): string {
    const hex = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `kvarm_pat_${hex}`;
  }

  /** Retained edge bodies for a page and a raw file, as a colo would hold them. */
  async function warmBodies(name: string): Promise<{ page: string; raw: string }> {
    const page = `/${OWNER}/${name}`;
    const raw = `/${OWNER}/${name}/raw/main/MARKER.txt`;
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60' };
    await caches.default.put(await pageKey(name, page), new Response(`<html>${PAGE_MARK}</html>`, { headers }));
    await caches.default.put(
      await pageKey(name, raw),
      new Response(RAW_MARK, { headers: { 'content-type': 'text/plain', 'cache-control': 'public, max-age=60' } }),
    );
    return { page, raw };
  }

  async function expectAnonymousHit(path: string, token: string, mark: string): Promise<void> {
    const r = await read(await call(path, { headers: bearer(token) }));
    expect(r.status, path).toBe(200);
    expect(r.text).toContain(mark);
    expect(r.cost, path).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0, sub: 0, cache: 'hit' });
    expect(r.cost.rr).toBeLessThanOrEqual(8);
  }

  it('serves the cached public page and raw body to an unknown well-formed Bearer after one lookup', async () => {
    const { page, raw } = await warmBodies('pages');
    await expectAnonymousHit(page, unknownPat(), PAGE_MARK);
    await expectAnonymousHit(raw, unknownPat(), RAW_MARK);
    // Once the rejection is cached the fallback needs no PAT read at all.
    const seen = unknownPat();
    await expectAnonymousHit(page, seen, PAGE_MARK);
    await expectAnonymousHit(raw, seen, RAW_MARK);
    // Malformed tokens are rejected before any lookup and fall back the same way.
    await expectAnonymousHit(page, 'not-a-token', PAGE_MARK);
  });

  it('treats a newly revoked warmed PAT as anonymous on pages, but REST and git still reject it', async () => {
    const { page, raw } = await warmBodies('pages');
    const userId = await seedUser('sv-revoked');
    const minted = await mintPAT(env, userId, 'sv-revoked', FULL);
    const hash = await patHash(minted.token);
    const warm = await read(await call(page, { headers: bearer(minted.token) }));
    expect(warm.status).toBe(200);
    expect(await readPatCache(hash, Date.now())).toMatchObject({ userId });

    // Revoked in another colo: the row is gone, this colo's PAT copy is not.
    await env.DB.prepare('DELETE FROM pat WHERE hash = ?').bind(hash).run();
    expect(await readPatCache(hash, Date.now())).toMatchObject({ userId });
    await expectAnonymousHit(page, minted.token, PAGE_MARK);
    await expectAnonymousHit(raw, minted.token, RAW_MARK);

    const meta = await read(await call(`/api/v1/repos/${OWNER}/pages`, { headers: bearer(minted.token) }));
    expect(meta.status).toBe(401);
    expect(meta.text).not.toContain(MARK.meta);
    const refs = await read(
      await call(`/${OWNER}/pages.git/info/refs?service=git-upload-pack`, { headers: basic(minted.token) }),
    );
    expect(refs.status).toBe(401);

    // REST and git reject a previously unseen token after their single lookup, too.
    const restUnknown = await read(await call(`/api/v1/repos/${OWNER}/pages`, { headers: bearer(unknownPat()) }));
    expect(restUnknown.status).toBe(401);
    expect(restUnknown.cost.d1).toBeLessThanOrEqual(1);
    const gitUnknown = await read(
      await call(`/${OWNER}/pages.git/info/refs?service=git-upload-pack`, { headers: basic(unknownPat()) }),
    );
    expect(gitUnknown.status).toBe(401);
    expect(gitUnknown.cost.d1).toBeLessThanOrEqual(1);
  });

  it('keeps a private page concealed from a rejected Bearer, without a second lookup or a cached body', async () => {
    const { page, raw } = await warmBodies('concealed');
    const userId = await seedUser('sv-revoked-private');
    const minted = await mintPAT(env, userId, 'sv-revoked-private', FULL);
    await call(page, { headers: bearer(minted.token) }).then((r) => r.body?.cancel());
    await env.DB.prepare('DELETE FROM pat WHERE hash = ?').bind(await patHash(minted.token)).run();
    for (const token of [unknownPat(), minted.token, 'not-a-token']) {
      for (const path of [page, raw]) {
        const r = await read(await call(path, { headers: bearer(token) }));
        expect(r.status, path).toBe(404);
        expect(r.text).not.toContain(PAGE_MARK);
        expect(r.text).not.toContain(RAW_MARK);
        expect(r.cost, path).toMatchObject({ do: 0, art: 0, sub: 0, cache: 'none' });
        expect(r.cost.d1, path).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never turns a throttled credential check into an anonymous read', async () => {
    const throttled = {
      ...env,
      WRITE_LIMITER: { limit: async () => ({ success: false }) },
    } as unknown as Env;
    const access = await resolveRepoAccess(throttled, {
      owner: OWNER,
      name: 'pages',
      need: 'read',
      transport: 'page',
      credential: { kind: 'pat', token: unknownPat() },
      clientIp: '203.0.113.9',
      rejectedCredentialAsAnonymous: true,
    });
    expect(access).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
  });
});
