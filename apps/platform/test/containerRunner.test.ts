/**
 * Container CI runner showcase route (routes/api/containerRunner.ts): only an
 * instance admin's ci-scoped PAT reaches the CiRunnerSandbox Durable Object;
 * everyone else is refused before it. The test pool runs without a container
 * runtime, so a run that reaches the object answers 503
 * CONTAINER_UNAVAILABLE, and a reset answers with no stored snapshot.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { call as apiCall } from './helpers/http';
import { seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const env = cfEnv as unknown as Env;
const OWNER = 'cr-owner';
const REPO = 'container-runs';
const R = `/api/v1/repos/${OWNER}/${REPO}/ci/container-runs`;
const tok = { admin: '', adminNoCi: '', owner: '', outsider: '' };

const seedUser = (login: string, admin = false) => seedUserBase(env, login, { admin });
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

beforeAll(async () => {
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  const ownerId = await seedUser(OWNER);
  const adminId = await seedUser('cr-admin', true);
  const outsiderId = await seedUser('cr-outsider');
  await seedRepoBase(env, REPO, { owner: OWNER, visibility: 'private', register: false });
  tok.owner = (await mintPAT(env, ownerId, 'owner', all)).token;
  tok.admin = (await mintPAT(env, adminId, 'admin', all)).token;
  tok.adminNoCi = (await mintPAT(env, adminId, 'admin-no-ci', ['read', 'write', 'api'])).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', all)).token;
});

describe('container CI runner route', () => {
  it('refuses anonymous callers, outsiders, PATs without ci scope and non-admin owners before the sandbox', async () => {
    expect((await call('POST', R, undefined, { mode: 'cold' })).status).toBe(401);
    expect((await call('POST', R, tok.outsider, { mode: 'cold' })).status).toBe(404);
    const noCi = await call('POST', R, tok.adminNoCi, { mode: 'cold' });
    expect([noCi.status, noCi.json.code]).toEqual([403, 'INSUFFICIENT_SCOPE']);
    const owner = await call('POST', R, tok.owner, { mode: 'cold' });
    expect([owner.status, owner.json.code]).toEqual([403, 'ADMIN_REQUIRED']);
    const reset = await call('DELETE', `${R}/snapshot`, tok.owner);
    expect([reset.status, reset.json.code]).toEqual([403, 'ADMIN_REQUIRED']);
  });

  it('validates the run mode', async () => {
    for (const body of [{}, { mode: 'hot' }, 'cold', null]) {
      const r = await call('POST', R, tok.admin, body);
      expect([r.status, r.json.code]).toEqual([422, 'INVALID_MODE']);
    }
  });

  it('an admin run reaches the sandbox, which reports that no container runtime is bound', async () => {
    const r = await call('POST', R, tok.admin, { mode: 'cold' });
    expect([r.status, r.json.code]).toEqual([503, 'CONTAINER_UNAVAILABLE']);
    expect(r.text).not.toContain(tok.admin);
    // One authority lookup and one Durable Object call; nothing else on the request path.
    expect(r.cost).toMatchObject({ d1: 1, do: 1, art: 0, q: 0 });
    const warm = await call('POST', R, tok.admin, { mode: 'warm' });
    expect([warm.status, warm.json.code]).toEqual([409, 'NO_SNAPSHOT']);
  });

  it('an admin reset clears the stored workspace snapshot', async () => {
    const r = await call('DELETE', `${R}/snapshot`, tok.admin);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reset: true, snapshot: null });
  });
});
