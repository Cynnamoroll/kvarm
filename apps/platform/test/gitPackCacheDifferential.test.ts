import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { classifyUploadPackRequest } from '../src/git/packCache';
import { ORIGIN, send } from './helpers/http';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { seedRepoWithCommit, seedUser } from './helpers/seed';
import { fixture } from './gitPackCacheDifferential.fixture';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts, GIT_MIRROR_MODE: 'off', GIT_PACK_CACHE: 'on' } as Env;
const OWNER = 'git-pack-cache-differential';
const FULL: Scope[] = ['read', 'write', 'api'];

function bytes(base64: string): Uint8Array {
  const raw = atob(base64);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

beforeAll(() => installFakeGitRemote());
afterAll(() => restoreFetch());

describe('upload-pack cache against system Git fixtures', () => {
  it.skipIf(!fixture)('preserves full, shallow, and blobless fetch responses on cache hits', { timeout: 60_000 }, async () => {
    const ownerId = await seedUser(env, OWNER);
    const token = (await mintPAT(env, ownerId, 'pack-cache-differential', FULL)).token;
    for (const item of fixture!.cases) {
      const repoName = `${item.name}-${crypto.randomUUID().slice(0, 8)}`;
      const seeded = await seedRepoWithCommit(env, repoName, { owner: OWNER, visibility: 'public' });
      let upstreamCalls = 0;
      seeded.repo.gitRemoteHandler = () => {
        upstreamCalls++;
        return new Response(bytes(item.response), {
          headers: { 'content-type': 'application/x-git-upload-pack-result' },
        });
      };
      const request = bytes(item.request);
      const classification = classifyUploadPackRequest(request, 'v2');
      expect(classification.cacheable, item.name).toBe(true);
      expect(classification.sidebandAll, item.name).toBe(true);
      const path = `/${OWNER}/${repoName}.git/git-upload-pack`;
      const req = () => new Request(`${ORIGIN}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-git-upload-pack-request',
          'Git-Protocol': 'version=2',
          Authorization: `Basic ${btoa(`x:${token}`)}`,
        },
        body: request,
      });
      const uncached = await send({ ...env, GIT_PACK_CACHE: 'off' } as Env, req());
      const cold = await send(env, req());
      const warm = await send(env, req());
      expect(cold.bytes, item.name).toEqual(uncached.bytes);
      expect(warm.bytes, item.name).toEqual(uncached.bytes);
      expect(cold.cost.cache).toBe('miss');
      expect(warm.cost.cache).toBe('hit');
      expect(upstreamCalls).toBe(2);
    }
  });
});
