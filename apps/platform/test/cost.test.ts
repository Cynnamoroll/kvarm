import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, patCacheKey, patHash, revokePAT, PAT_STAMP_INTERVAL_MS, type Scope } from '../src/auth/pat';
import { CostMeter, COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { resolveRepoAccess } from '../src/services/access';
import type { RepoRow } from '../src/db/repos';
import { infoRefsCacheKey } from '../src/routes/git';
import { repoViewGeneration } from '../src/services/pushFreshness';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { parseServerTiming, request } from './helpers/http';
import { seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const call = (path: string, init: RequestInit = {}) => request(env, path, init);
const seedUser = (login: string) => seedUserBase(env, login);
const seedRepo = async (name: string, visibility: 'public' | 'private' = 'public') => {
  await seedRepoBase(env, name, { owner: OWNER, visibility });
  return `https://artifacts.invalid/git/default/${OWNER}--${name}.git`;
};

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'cost-owner';
const FULL: Scope[] = ['read', 'write', 'api'];

async function costOf(res: Response): Promise<CostCounters> {
  const parsed = parseCostHeader(res.headers.get(COST_HEADER));
  expect(parsed, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  if (!res.bodyUsed) await res.body?.cancel();
  return parsed!;
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

let userId = '';

async function freshToken(scopes: Scope[] = FULL): Promise<{ id: string; token: string }> {
  const minted = await mintPAT(env, userId, `cost-${crypto.randomUUID().slice(0, 8)}`, scopes);
  return { id: minted.id, token: minted.token };
}

let openRemote = '';

beforeAll(async () => {
  userId = await seedUser(OWNER);
  openRemote = await seedRepo('open', 'public');
  await seedRepo('secret', 'private');
  await seedRepo('flip', 'public');
  installFakeGitRemote();
});

afterAll(() => {
  restoreFetch();
});

describe('x-kvarm-cost on every surface', () => {
  it('stamps health, API, git gate, repo pages and fallbacks with a well-formed header', async () => {
    const { token } = await freshToken();
    for (const [path, init] of [
      ['/healthz', {}],
      [`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) }],
      [`/api/v1/repos/${OWNER}/secret`, {}],
      [`/${OWNER}/open.git/info/refs?service=git-upload-pack`, {}],
      [`/${OWNER}/secret.git/info/refs?service=git-upload-pack`, {}],
      [`/${OWNER}/open`, {}],
      ['/definitely/not/a/route/here', {}],
    ] as const) {
      const res = await call(path, init);
      const value = res.headers.get(COST_HEADER);
      expect(parseCostHeader(value), `${path} -> ${value}`).not.toBeNull();
      expect(value).not.toContain(OWNER);
      expect(value).not.toContain('kvarm_pat_');
      await res.body?.cancel();
    }
  });

  it('reports zero work for /healthz', async () => {
    expect(await costOf(await call('/healthz'))).toEqual({
      d1: 0, rr: 0, rw: 0, art: 0, do: 0, r2a: 0, r2b: 0, q: 0, sub: 0, cache: 'none',
    });
  });
});

describe('warm authenticated public metadata read', () => {
  it('pays one D1 authority lookup per request and writes only on the first use', async () => {
    const { token } = await freshToken();
    const cold = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) });
    expect(cold.status).toBe(200);
    const coldCost = await costOf(cold);
    expect(coldCost.d1).toBe(1);
    expect(coldCost.rw).toBe(1); // first use stamps last_used_at
    const warm = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) });
    expect(warm.status).toBe(200);
    const warmCost = await costOf(warm);
    expect(warmCost).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0 });
    expect(warmCost.rr).toBeLessThanOrEqual(8);
  });

  it('runs the authority lookup on warm anonymous public reads', async () => {
    await call(`/api/v1/repos/${OWNER}/open`).then((r) => r.body?.cancel());
    const warm = await call(`/api/v1/repos/${OWNER}/open`);
    expect(warm.status).toBe(200);
    expect(await costOf(warm)).toMatchObject({ d1: 1, rw: 0, do: 0 });
  });
});

describe('last_used_at throttling', () => {
  it('writes at most once per PAT per window, even on cold cache misses', async () => {
    const { id, token } = await freshToken();
    const lastUsed = () => env.DB.prepare('SELECT last_used_at FROM pat WHERE id = ?').bind(id).first<{ last_used_at: number | null }>();
    const hash = await patHash(token);

    await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) }).then((r) => r.body?.cancel());
    const first = (await lastUsed())?.last_used_at;
    expect(first).toBeTypeOf('number');

    // Cold again inside the window: the conditional stamp writes nothing.
    await caches.default.delete(patCacheKey(hash));
    const again = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) });
    expect(await costOf(again)).toMatchObject({ d1: 1, rw: 0 });
    expect((await lastUsed())?.last_used_at).toBe(first);

    // Outside the window the next authoritative read stamps once more.
    await env.DB.prepare('UPDATE pat SET last_used_at = ? WHERE id = ?').bind(Date.now() - PAT_STAMP_INTERVAL_MS - 1000, id).run();
    await caches.default.delete(patCacheKey(hash));
    const stale = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(token) });
    expect(await costOf(stale)).toMatchObject({ d1: 1, rw: 1 });
    expect((await lastUsed())?.last_used_at).toBeGreaterThan(first!);
  });
});

describe('private reads stay authoritative and bounded', () => {
  it('re-validates the PAT and repo row on every private read in one D1 round trip', async () => {
    const { token } = await freshToken();
    await call(`/api/v1/repos/${OWNER}/secret`, { headers: bearer(token) }).then((r) => r.body?.cancel());
    const warm = await call(`/api/v1/repos/${OWNER}/secret`, { headers: bearer(token) });
    expect(warm.status).toBe(200);
    const cost = await costOf(warm);
    expect(cost).toMatchObject({ d1: 1, rw: 0, do: 0, art: 0 });
    expect(cost.rr).toBeLessThanOrEqual(8);
  });

  it('denies anonymous reads of a private repo with one bounded lookup and no other work', async () => {
    await call(`/api/v1/repos/${OWNER}/secret`).then((r) => r.body?.cancel());
    const res = await call(`/api/v1/repos/${OWNER}/secret`);
    expect(res.status).toBe(404);
    const cost = await costOf(res);
    expect(cost).toMatchObject({ d1: 1, rw: 0, art: 0, do: 0, sub: 0 });
    expect(cost.rr).toBeLessThanOrEqual(8);
  });
});

describe('PAT revocation', () => {
  it('denies the next REST and git request after DELETE /user/tokens/:id', async () => {
    const victim = await freshToken();
    const admin = await freshToken();
    for (let i = 0; i < 2; i++) {
      const res = await call(`/api/v1/repos/${OWNER}/secret`, { headers: bearer(victim.token) });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    const gitWarm = await call(`/${OWNER}/secret.git/info/refs?service=git-upload-pack`, { headers: basic(victim.token) });
    expect(gitWarm.status).not.toBe(401);
    await gitWarm.body?.cancel();

    // Token management is session-only: a PAT bearer is refused, and the
    // revocation itself goes through the same service the route calls.
    const revoke = await call(`/api/v1/user/tokens/${victim.id}`, { method: 'DELETE', headers: bearer(admin.token) });
    expect(revoke.status).toBe(403);
    expect(await revoke.json()).toEqual({ error: 'manage tokens from the web session', code: 'SESSION_REQUIRED' });
    expect(await revokePAT(env, victim.id, userId)).toBe(true);

    const rest = await call(`/api/v1/repos/${OWNER}/secret`, { headers: bearer(victim.token) });
    expect(rest.status).toBe(401);
    const body = await rest.text();
    expect(body).not.toContain('secret');
    const git = await call(`/${OWNER}/secret.git/info/refs?service=git-upload-pack`, { headers: basic(victim.token) });
    expect(git.status).toBe(401);
    const pub = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(victim.token) });
    expect(pub.status).toBe(401);
    await pub.body?.cancel();
  });

  it('denies private and write access even while another colo still caches the PAT', async () => {
    const victim = await freshToken();
    for (const path of [`/api/v1/repos/${OWNER}/secret`, `/api/v1/repos/${OWNER}/open`]) {
      const res = await call(path, { headers: bearer(victim.token) });
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    // Revoke in D1 only, leaving this colo's cache entry in place.
    await env.DB.prepare('DELETE FROM pat WHERE id = ?').bind(victim.id).run();

    const priv = await call(`/api/v1/repos/${OWNER}/secret`, { headers: bearer(victim.token) });
    expect(priv.status).toBe(401);
    expect(await priv.text()).not.toContain('secret');
    const gitRead = await call(`/${OWNER}/secret.git/info/refs?service=git-upload-pack`, { headers: basic(victim.token) });
    expect(gitRead.status).toBe(401);
    const gitWrite = await call(`/${OWNER}/open.git/info/refs?service=git-receive-pack`, { headers: basic(victim.token) });
    expect(gitWrite.status).toBe(401);
    const patch = await call(`/api/v1/repos/${OWNER}/open`, {
      method: 'PATCH',
      headers: { ...bearer(victim.token), 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'stale token edit' }),
    });
    expect(patch.status).toBe(401);
  });
});

describe('failed-auth amplification', () => {
  it('rejects malformed tokens without D1 and caches unknown-token rejections', async () => {
    const malformed = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer('kvarm_pat_short') });
    expect(malformed.status).toBe(401);
    expect(await costOf(malformed)).toMatchObject({ d1: 0 });

    const unknown = `kvarm_pat_${'ab'.repeat(32)}`;
    const first = await call(`/api/v1/repos/${OWNER}/open`, { headers: bearer(unknown) });
    expect(first.status).toBe(401);
    expect((await costOf(first)).d1).toBe(1);
    const second = await call(`/${OWNER}/open.git/info/refs?service=git-upload-pack`, { headers: basic(unknown) });
    expect(second.status).toBe(401);
    expect(await costOf(second)).toMatchObject({ d1: 0 });
  });

  it('throttles uncached PAT lookups per client before any D1 query', async () => {
    const m = new CostMeter();
    const denyAll = { limit: async () => ({ success: false }) };
    const throttled = m.wrapEnv(
      new Proxy(env, { get: (t, p) => (p === 'WRITE_LIMITER' ? denyAll : Reflect.get(t, p)) }),
    );
    const res = await resolveRepoAccess(throttled, {
      owner: OWNER,
      name: 'open',
      need: 'read',
      transport: 'api',
      credential: { kind: 'pat', token: `kvarm_pat_${'cd'.repeat(32)}` },
      clientIp: '203.0.113.9',
    });
    expect(res).toMatchObject({ ok: false, status: 429, code: 'RATE_LIMITED' });
    expect(m.d1).toBe(0);
  });
});

describe('visibility update', () => {
  it('applies a PATCH to the very next anonymous request', async () => {
    const owner = await freshToken();
    for (let i = 0; i < 2; i++) {
      const res = await call(`/api/v1/repos/${OWNER}/flip`);
      expect(res.status).toBe(200);
      await res.body?.cancel();
    }
    const patch = await call(`/api/v1/repos/${OWNER}/flip`, {
      method: 'PATCH',
      headers: { ...bearer(owner.token), 'content-type': 'application/json' },
      body: JSON.stringify({ visibility: 'private' }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { repo: { visibility: string } }).repo.visibility).toBe('private');
    expect(await costOf(patch)).toMatchObject({ d1: 2 });

    const anon = await call(`/api/v1/repos/${OWNER}/flip`);
    expect(anon.status).toBe(404);
    await anon.body?.cancel();
    const page = await call(`/${OWNER}/flip`);
    expect(page.status).toBe(404);
    await page.body?.cancel();
  });
});

describe('git gate', () => {
  it('serves warm public info/refs from cache before any token mint or upstream fetch, per Git-Protocol', async () => {
    const search = '?service=git-upload-pack';
    const v0 = 'v0-advertisement';
    const v2 = 'v2-advertisement';
    const row = await env.DB.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?').bind(OWNER, 'open').first<RepoRow>();
    const gen = await repoViewGeneration(row!);
    for (const [proto, body] of [[null, v0], ['version=2', v2]] as const) {
      await caches.default.put(
        infoRefsCacheKey(openRemote, search, proto, gen),
        new Response(body, { headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'public, max-age=30' } }),
      );
    }
    const plain = await call(`/${OWNER}/open.git/info/refs${search}`);
    expect(plain.status).toBe(200);
    expect(await plain.clone().text()).toBe(v0);
    const timing = parseServerTiming(plain.headers.get('server-timing'));
    expect(timing.has('auth')).toBe(true);
    expect(timing.get('cache')).toMatchObject({ desc: 'hit-edge' });
    expect(timing.has('total')).toBe(true);
    expect(timing.has('upstream')).toBe(false);
    const plainCost = await costOf(plain);
    expect(plainCost).toEqual({ d1: 1, rr: plainCost.rr, rw: 0, art: 0, do: 0, r2a: 0, r2b: 0, q: 0, sub: 0, cache: 'hit' });
    expect(plainCost.rr).toBeLessThanOrEqual(8);

    const proto2 = await call(`/${OWNER}/open.git/info/refs${search}`, { headers: { 'Git-Protocol': 'version=2' } });
    expect(await proto2.clone().text()).toBe(v2);
    expect(await costOf(proto2)).toMatchObject({ art: 0, sub: 0, do: 0, cache: 'hit' });
  });

  it('includes Server-Timing on a private-repository 401', async () => {
    const denied = await call(`/${OWNER}/secret.git/info/refs?service=git-upload-pack`);
    expect(denied.status).toBe(401);
    const timing = parseServerTiming(denied.headers.get('server-timing'));
    expect(timing.has('auth')).toBe(true);
    expect(timing.get('cache')).toMatchObject({ desc: 'none' });
    expect(timing.has('total')).toBe(true);
  });

  it('never calls a Durable Object, including authenticated writes', async () => {
    const { token } = await freshToken();
    for (const [path, init] of [
      [`/${OWNER}/open.git/info/refs?service=git-receive-pack`, { headers: basic(token) }],
      [`/${OWNER}/secret.git/info/refs?service=git-upload-pack`, { headers: basic(token) }],
      [`/${OWNER}/open.git/info/refs?service=git-upload-pack&nocache=${crypto.randomUUID()}`, {}],
    ] as const) {
      const res = await call(path, init);
      expect(res.status, path).not.toBe(401);
      expect((await costOf(res)).do, path).toBe(0);
    }
  });
});
