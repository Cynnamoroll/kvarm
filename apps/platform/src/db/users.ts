/** Platform users, provisioned lazily on first WorkOS sign-in. */

import type { SessionUser } from '../auth/workos';

export interface UserRow {
  id: string;
  workos_user_id: string;
  login: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  is_admin: boolean;
  created_at: number;
}

export function loginFromEmail(email: string): string {
  const raw = (email.split('@')[0] ?? 'user').toLowerCase();
  const sanitized = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length === 0 ? 'user' : sanitized.slice(0, 39);
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return row ?? null;
}

export async function getUserByLogin(db: D1Database, login: string): Promise<UserRow | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE login = ?')
    .bind(login)
    .first<UserRow>();
  return row ?? null;
}

/**
 * Find-or-create the platform user for a WorkOS identity. Login collisions get
 * a numeric suffix. The first ever user becomes admin (bootstrap owner).
 */
export async function findOrCreateUser(env: Env, session: SessionUser): Promise<UserRow> {
  const existing = await env.DB.prepare('SELECT * FROM users WHERE workos_user_id = ?')
    .bind(session.workosUserId)
    .first<UserRow>();
  if (existing) {
    // Keep display fields fresh from WorkOS.
    if (existing.email !== session.email || existing.name !== session.name) {
      await env.DB.prepare('UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?')
        .bind(session.email, session.name, session.avatarUrl, existing.id)
        .run();
      existing.email = session.email;
      existing.name = session.name;
      existing.avatar_url = session.avatarUrl;
    }
    return existing;
  }

  const base = loginFromEmail(session.email);
  const now = Date.now();
  for (let attempt = 0; attempt < 50; attempt++) {
    const login = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const id = crypto.randomUUID();
      const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
      const isAdmin = (count?.n ?? 0) === 0;
      await env.DB.prepare(
        'INSERT INTO users (id, workos_user_id, login, email, name, avatar_url, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?',
      )
        .bind(
          id,
          session.workosUserId,
          login,
          session.email,
          session.name,
          session.avatarUrl,
          isAdmin ? 1 : 0,
          now,
        )
        .run();
      return {
        id,
        workos_user_id: session.workosUserId,
        login,
        email: session.email,
        name: session.name,
        avatar_url: session.avatarUrl,
        is_admin: isAdmin,
        created_at: now,
      };
    } catch (err) {
      if (String(err).includes('UNIQUE')) continue; // login taken; try suffix
      throw err;
    }
  }
  throw new Error('could not allocate a login for this user');
}
