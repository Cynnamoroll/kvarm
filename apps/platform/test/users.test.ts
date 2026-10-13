import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { findOrCreateUser } from '../src/db/users';

const env = cfEnv as unknown as Env;

const session = (n: number) => ({
  workosUserId: `user_${n}`,
  email: `user${n}@example.test`,
  name: `User ${n}`,
  avatarUrl: null,
});

describe('findOrCreateUser', () => {
  it('creates the very first user as the instance admin, later ones as non-admin', async () => {
    const first = await findOrCreateUser(env, session(1));
    expect(first.is_admin).toBe(true);
    const second = await findOrCreateUser(env, session(2));
    expect(second.is_admin).toBe(false);
    expect(second.login).not.toBe(first.login);
  });

  it('is idempotent for the same WorkOS identity and keeps display fields fresh', async () => {
    const a = await findOrCreateUser(env, session(3));
    const b = await findOrCreateUser(env, { ...session(3), name: 'Renamed' });
    expect(b.id).toBe(a.id);
    expect(b.is_admin).toBe(a.is_admin);
    expect(b.name).toBe('Renamed');
  });

  it('suffixed logins do not collide and never grant a second admin', async () => {
    const a = await findOrCreateUser(env, { workosUserId: 'user_4', email: 'ada@example.test', name: null, avatarUrl: null });
    const b = await findOrCreateUser(env, { workosUserId: 'user_5', email: 'ada@example.test', name: null, avatarUrl: null });
    expect(a.login).toBe('ada');
    expect(b.login).toBe('ada-2');
    expect(b.is_admin).toBe(false);
  });
});
