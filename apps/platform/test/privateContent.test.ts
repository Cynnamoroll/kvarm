/**
 * Immutable private content reuse and response cache scoping.
 *
 * A private file body at a commit SHA is reused from the Cache API, keyed by
 * the repo's internal id + commit + path, but only after the one
 * authoritative D1 lookup has allowed the request. Grants, PATs and
 * visibility are changed directly in D1 (no purge), so the retained body is
 * still in the cache when the next request arrives. Private and
 * credential-authorized responses never advertise a shared-cacheable
 * Cache-Control.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, patHash, type Scope } from '../src/auth/pat';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const ORG = 'pc-org';
const FULL: Scope[] = ['read', 'write', 'api'];
const SHA = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const BLOB = 'c'.repeat(40);
const FILE = 'MARKER.txt';

type Who = 'owner' | 'member' | 'outsider';
const logins: Record<Who, string> = {
  owner: 'pc-owner',
  member: 'pc-member',
  outsider: 'pc-outsider',
};
const ids = {} as Record<Who, string>;
const tok = {} as Record<Who, string>;

/** File bodies by Artifacts repo name, served by the fake binding. */
const files = new Map<string, string>();
const artifactsReads: string[] = [];
const upstreamCalls: string[] = [];
const originalFetch = globalThis.fetch;

function handle(name: string): ArtifactsRepo {
  return {
    async readFile({ ref, path }: { ref: string; path: string }) {
      artifactsReads.push(`${name}:${ref}:${path}`);
      const body = (ref === SHA || ref === 'main') && path === FILE ? files.get(name) : undefined;
      return body === undefined ? null : new Blob([body], { type: 'text/plain' });
    },
    async log({ ref }: { ref?: string } = {}) {
      if (ref !== SHA || !files.has(name)) return [];
      const who = { name: 'pc', email: 'pc@kvarm.invalid' };
      return [
        { hash: SHA, treeHash: TREE, message: 'm', author: who, committer: who, parents: [], authoredAt: 0, committedAt: 0 },
      ];
    },
    async readTree() {
      return [{ name: FILE, mode: '100644', hash: BLOB, type: 'blob' }];
    },
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

const env = {
  ...baseEnv,
  ARTIFACTS: { get: async (name: string) => handle(name) } as unknown as Artifacts,
} as Env;

interface Read {
  status: number;
  text: string;
  cost: CostCounters;
  cacheControl: string | null;
}

async function call(path: string, headers: Record<string, string> = {}, init: RequestInit = {}): Promise<Read> {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  return { status: res.status, text, cost: cost!, cacheControl: res.headers.get('cache-control') };
}

function bearer(who: Who): Record<string, string> {
  return { Authorization: `Bearer ${tok[who]}` };
}

function basic(who: Who): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${tok[who]}`)}` };
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

function artifactsName(owner: string, name: string): string {
  return `${owner}--${name}`;
}

function remoteOf(owner: string, name: string): string {
  return `https://artifacts.invalid/git/default/${artifactsName(owner, name)}.git`;
}

async function seedRepo(
  owner: string,
  name: string,
  visibility: 'public' | 'private',
  body: string,
): Promise<string> {
  const id = crypto.randomUUID();
  files.set(artifactsName(owner, name), body);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at, owner_org_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'main', ?7, (SELECT id FROM orgs WHERE login = ?2))`,
  )
    .bind(id, owner, name, artifactsName(owner, name), remoteOf(owner, name), visibility, Date.now())
    .run();
  return id;
}

async function grantRead(repoId: string, who: Who): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at)
     VALUES (?, ?, 'read', ?, ?, ?)`,
  )
    .bind(repoId, ids[who], ids.owner, Date.now(), Date.now())
    .run();
}

function raw(owner: string, name: string): string {
  return `/${owner}/${name}/raw/${SHA}/${FILE}`;
}

function expectNotPublic(r: Read, label: string): void {
  expect(r.cacheControl, `${label} Cache-Control`).not.toBeNull();
  expect(r.cacheControl!, `${label} Cache-Control`).not.toMatch(/public/i);
  expect(r.cacheControl!, `${label} Cache-Control`).toMatch(/private|no-store/i);
}

/** Cold read, then the warm repeat that must reuse the immutable body. */
async function warm(path: string, headers: Record<string, string>, mark: string): Promise<Read> {
  const cold = await call(path, headers);
  expect(cold.status, `cold ${path}`).toBe(200);
  expect(cold.text).toContain(mark);
  const hot = await call(path, headers);
  expect(hot.status, `warm ${path}`).toBe(200);
  expect(hot.text).toContain(mark);
  return hot;
}

function expectWarmHit(r: Read, label: string): void {
  expect(r.cost, label).toMatchObject({ rw: 0, art: 0, sub: 0, do: 0, cache: 'hit' });
  expect(r.cost.d1, label).toBeLessThanOrEqual(2);
  expect(r.cost.d1, label).toBe(1);
  expect(r.cost.rr, label).toBeLessThanOrEqual(8);
}

function expectDenied(r: Read, mark: string, label: string): void {
  expect(r.status, label).toBe(404);
  expect(r.text, label).not.toContain(mark);
  expect(r.cost, label).toMatchObject({ art: 0, sub: 0, do: 0, cache: 'none' });
  expect(r.cost.d1, label).toBeLessThanOrEqual(1);
  expect(r.cost.rr, label).toBeLessThanOrEqual(8);
}

const repoIds: Record<string, string> = {};

beforeAll(async () => {
  for (const who of Object.keys(logins) as Who[]) {
    ids[who] = await seedUser(logins[who]);
    tok[who] = (await mintPAT(env, ids[who], `pc-${who}`, FULL)).token;
  }
  const orgId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, login, name, created_by, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      orgId,
      ORG,
      ORG,
      ids.owner,
      Date.now(),
    ),
    env.DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'owner', 0, 0)",
    ).bind(orgId, ids.owner),
    env.DB.prepare(
      "INSERT INTO org_members (org_id, user_id, role, created_at, updated_at) VALUES (?, ?, 'member', 0, 0)",
    ).bind(orgId, ids.member),
  ]);
  repoIds.vault = await seedRepo(logins.owner, 'vault', 'private', 'pc-personal-private-marker');
  repoIds.orgVault = await seedRepo(ORG, 'vault', 'private', 'pc-org-private-marker');
  await grantRead(repoIds.orgVault, 'member');
  repoIds.recreated = await seedRepo(logins.owner, 'recreated', 'private', 'pc-original-marker');
  repoIds.twin = await seedRepo(logins.owner, 'twin', 'private', 'pc-twin-marker');
  repoIds.lobby = await seedRepo(logins.owner, 'lobby', 'public', 'pc-public-marker');
  repoIds.flip = await seedRepo(ORG, 'flip', 'public', 'pc-flip-marker');
  // A read token copy lets git requests reach the stubbed upstream without a mint.
  await writeCachedJson(
    internalKey('gittoken', artifactsName(logins.owner, 'vault'), 'read'),
    { token: 'fake', expiresAt: Date.now() + 3_600_000 },
    3600,
  );
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    upstreamCalls.push(url.pathname);
    return new Response('upstream', {
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('warm private content at a commit SHA', () => {
  it('reuses the personal repo body after one authority lookup, with no Artifacts read', async () => {
    const mark = 'pc-personal-private-marker';
    const before = artifactsReads.length;
    const hot = await warm(raw(logins.owner, 'vault'), bearer('owner'), mark);
    expectWarmHit(hot, 'personal raw');
    expect(artifactsReads.length - before).toBe(1);

    // The blob page at the same commit reuses the same immutable body.
    const blob = await call(`/${logins.owner}/vault/blob/${SHA}/${FILE}`, bearer('owner'));
    expect(blob.status).toBe(200);
    expect(blob.text).toContain(mark);
    expectWarmHit(blob, 'personal blob page');
    expect(artifactsReads.length - before).toBe(1);
  });

  it('reuses the org repo body for a member with an explicit read grant', async () => {
    const hot = await warm(raw(ORG, 'vault'), bearer('member'), 'pc-org-private-marker');
    expectWarmHit(hot, 'org raw');
  });

  it('never stores or serves a body for a denied request', async () => {
    const before = artifactsReads.length;
    for (const headers of [{}, bearer('outsider')]) {
      expectDenied(await call(raw(logins.owner, 'twin'), headers), 'pc-twin-marker', 'denied twin');
    }
    expect(artifactsReads.length).toBe(before);
    // The first authorized read is still a miss: nothing was cached for the denied ones.
    const first = await call(raw(logins.owner, 'twin'), bearer('owner'));
    expect(first.status).toBe(200);
    expect(first.cost.cache).not.toBe('hit');
    expectNotPublic(first, 'private raw miss');
  });
});

describe('a retained private body after a direct D1 mutation', () => {
  it('is denied immediately after a grant revoke, PAT revocation or for outsiders, while the owner still hits', async () => {
    const mark = 'pc-org-private-marker';
    const path = raw(ORG, 'vault');
    expectWarmHit(await warm(path, bearer('member'), mark), 'member warm');
    expectWarmHit(await call(path, bearer('owner')), 'owner warm');

    // Revoked in another colo: the grant row is gone, nothing was purged.
    await env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = ?')
      .bind(repoIds.orgVault, ids.member)
      .run();
    expectDenied(await call(path, bearer('member')), mark, 'member after grant revoke');
    expectDenied(await call(path), mark, 'anonymous');
    expectDenied(await call(path, bearer('outsider')), mark, 'outsider');

    // The owner's warmed PAT is deleted directly; its cached copy stays.
    const second = await mintPAT(env, ids.owner, 'pc-owner-2', FULL);
    const ownerHeaders = { Authorization: `Bearer ${second.token}` };
    expectWarmHit(await warm(path, ownerHeaders, mark), 'second owner PAT warm');
    await env.DB.prepare('DELETE FROM pat WHERE hash = ?').bind(await patHash(second.token)).run();
    expectDenied(await call(path, ownerHeaders), mark, 'revoked owner PAT');

    // The body was retained all along: the still-authorized owner hits it.
    const owner = await call(path, bearer('owner'));
    expect(owner.status).toBe(200);
    expect(owner.text).toContain(mark);
    expectWarmHit(owner, 'owner after revocations');
  });

  it('is denied immediately after a public-to-private flip for a member without a grant', async () => {
    const mark = 'pc-flip-marker';
    const path = raw(ORG, 'flip');
    for (const headers of [{}, bearer('member')]) {
      const r = await warm(path, headers, mark);
      expect(r.cost.cache).toBe('hit');
    }
    await env.DB.prepare('UPDATE repos SET visibility = ? WHERE id = ?').bind('private', repoIds.flip).run();
    expectDenied(await call(path), mark, 'anonymous after flip');
    expectDenied(await call(path, bearer('member')), mark, 'member after flip');
    // The org owner reads the now-private body, privately and from the repo-scoped cache.
    const owner = await warm(path, bearer('owner'), mark);
    expectWarmHit(owner, 'owner after flip');
    expectNotPublic(owner, 'owner after flip');
  });
});

describe('content cache key scoping', () => {
  it('keys by internal repo id, so a deleted and recreated repo never serves the old body', async () => {
    const path = raw(logins.owner, 'recreated');
    expectWarmHit(await warm(path, bearer('owner'), 'pc-original-marker'), 'original warm');

    await env.DB.prepare('DELETE FROM repos WHERE id = ?').bind(repoIds.recreated).run();
    repoIds.recreated = await seedRepo(logins.owner, 'recreated', 'private', 'pc-recreated-marker');
    const after = await call(path, bearer('owner'));
    expect(after.status).toBe(200);
    expect(after.text).toContain('pc-recreated-marker');
    expect(after.text).not.toContain('pc-original-marker');
    expect(after.cost.cache).toBe('miss');
    expect(after.cost.art).toBeGreaterThan(0);

    // Another repo at the same commit and path has its own entry.
    const twin = await warm(raw(logins.owner, 'twin'), bearer('owner'), 'pc-twin-marker');
    expect(twin.text).not.toContain('pc-recreated-marker');
    expectWarmHit(twin, 'twin warm');
  });
});

describe('Cache-Control on private and credential-authorized responses', () => {
  it('never advertises public caching for private repo content, metadata or git', async () => {
    expectNotPublic(await call(raw(logins.owner, 'vault'), bearer('owner')), 'private raw hit');
    expectNotPublic(await call(`/${logins.owner}/vault/raw/main/${FILE}`, bearer('owner')), 'private raw branch');
    expectNotPublic(await call(`/${logins.owner}/vault/blob/${SHA}/${FILE}`, bearer('owner')), 'private blob page');
    const tree = await call(`/${logins.owner}/vault/tree/${SHA}`, bearer('owner'));
    expect(tree.status).toBe(200);
    expectNotPublic(tree, 'private tree page');
    const meta = await call(`/api/v1/repos/${logins.owner}/vault`, bearer('owner'));
    expect(meta.status).toBe(200);
    expectNotPublic(meta, 'private metadata');
    const refs = await call(`/${logins.owner}/vault.git/info/refs?service=git-upload-pack`, basic('owner'));
    expect(refs.status).toBe(200);
    expectNotPublic(refs, 'private info/refs');
  });

  it('marks a credential-authorized public response private and keeps anonymous public headers', async () => {
    const path = raw(logins.owner, 'lobby');
    const anonCold = await call(path);
    expect(anonCold.status).toBe(200);
    expect(anonCold.cacheControl).toBe('public, max-age=31536000, immutable');
    const anonHit = await call(path);
    expect(anonHit.cost.cache).toBe('hit');
    expect(anonHit.cacheControl).toMatch(/^public, max-age=31536000/);

    const authed = await call(path, bearer('owner'));
    expect(authed.status).toBe(200);
    expect(authed.text).toContain('pc-public-marker');
    expectNotPublic(authed, 'PAT public raw');
    expectNotPublic(await call(`/api/v1/repos/${logins.owner}/lobby`, bearer('owner')), 'PAT public metadata');

    // Anonymous public metadata keeps its existing (absent) Cache-Control.
    const anonMeta = await call(`/api/v1/repos/${logins.owner}/lobby`);
    expect(anonMeta.status).toBe(200);
    expect(anonMeta.cacheControl).toBeNull();
  });
});
