import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { resolveRepoAccess } from '../src/services/access';
import { ORIGIN, send } from './helpers/http';
import { seedRepo, seedUser } from './helpers/seed';

const baseEnv = cfEnv as unknown as Env;

function denyingLimiter() {
  const keys: string[] = [];
  return {
    keys,
    binding: {
      async limit({ key }: { key: string }) {
        keys.push(key);
        return { success: false };
      },
    },
  };
}

describe('Git rate-limit response labels', () => {
  it('labels anonymous read limits without exposing the IP key', async () => {
    const owner = `limit-read-${crypto.randomUUID().slice(0, 8)}`;
    const name = `repo-${crypto.randomUUID().slice(0, 8)}`;
    const ip = '203.0.113.41';
    await seedRepo(baseEnv, name, { owner, visibility: 'public', register: false });
    const limiter = denyingLimiter();
    const env = { ...baseEnv, READ_LIMITER: limiter.binding } as unknown as Env;

    const response = await send(
      env,
      new Request(`${ORIGIN}/${owner}/${name}.git/info/refs?service=git-upload-pack`, {
        headers: { 'CF-Connecting-IP': ip },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('x-kvarm-ratelimit')).toBe('git-read');
    expect(limiter.keys).toEqual([`git:read:ip:${ip}`]);
  });

  it('labels preauthorization limits without exposing the IP key', async () => {
    const ip = '203.0.113.42';
    const token = `kvarm_pat_${crypto.randomUUID().replaceAll('-', '').repeat(2)}`;
    const limiter = denyingLimiter();
    const env = { ...baseEnv, WRITE_LIMITER: limiter.binding } as unknown as Env;

    const response = await send(
      env,
      new Request(`${ORIGIN}/limit-preauth/repo.git/info/refs?service=git-upload-pack`, {
        headers: {
          Authorization: `Basic ${btoa(`kvarm:${token}`)}`,
          'CF-Connecting-IP': ip,
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('x-kvarm-ratelimit')).toBe('preauth');
    expect(limiter.keys).toEqual([`preauth:${ip}`]);
  });

  it('labels authenticated write limits without exposing the PAT id', async () => {
    const owner = `limit-write-${crypto.randomUUID().slice(0, 8)}`;
    const name = `repo-${crypto.randomUUID().slice(0, 8)}`;
    const ip = '203.0.113.43';
    const userId = await seedUser(baseEnv, owner);
    const token = (await mintPAT(baseEnv, userId, 'git-rate-limit-test', ['write'])).token;
    await seedRepo(baseEnv, name, { owner, visibility: 'private', register: false });
    const access = await resolveRepoAccess(baseEnv, {
      owner,
      name,
      need: 'write',
      transport: 'git',
      credential: { kind: 'pat', token },
      clientIp: ip,
    });
    expect(access.ok).toBe(true);

    const limiter = denyingLimiter();
    const env = { ...baseEnv, WRITE_LIMITER: limiter.binding } as unknown as Env;
    const response = await send(
      env,
      new Request(`${ORIGIN}/${owner}/${name}.git/info/refs?service=git-receive-pack`, {
        headers: {
          Authorization: `Basic ${btoa(`kvarm:${token}`)}`,
          'CF-Connecting-IP': ip,
        },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('x-kvarm-ratelimit')).toBe('git-write');
    expect(limiter.keys).toHaveLength(1);
    expect(limiter.keys[0]).toMatch(/^git:write:/);
    expect(response.headers.get('x-kvarm-ratelimit')).not.toContain(limiter.keys[0]!);
  });
});
