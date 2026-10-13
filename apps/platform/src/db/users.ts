/**
 * Platform users. Ops scripts create PAT-only users; WorkOS sign-in
 * provisions or links them (services/identity.ts).
 */

/**
 * workos_user_id prefix of users created by scripts/mint-pat.mjs, which have
 * no WorkOS identity yet. Only such rows can be linked to one.
 */
export const UNLINKED_WORKOS_PREFIX = 'kvarm-ops:';

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

/** D1 stores is_admin as INTEGER 0/1; every UserRow leaving this module is boolean. */
export function toUserRow(raw: Omit<UserRow, 'is_admin'> & { is_admin: unknown }): UserRow {
  return { ...raw, is_admin: raw.is_admin === true || raw.is_admin === 1 || raw.is_admin === '1' };
}

/**
 * The login base for an email: the lowercased local-part with every run of
 * characters outside [a-z0-9-] turned into one dash, trimmed of dashes and
 * cut to the 39-character login limit. Reserved words and collisions are
 * handled by the caller (services/identity.ts).
 */
export function loginFromEmail(email: string): string {
  const raw = (email.split('@')[0] ?? '').toLowerCase();
  const sanitized = raw.replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const cut = sanitized.slice(0, 39).replace(/-+$/, '');
  return cut.length === 0 ? 'user' : cut;
}

/** The n-th login candidate for a base (n = 0 is the base itself), always within 39 characters. */
export function loginCandidate(base: string, n: number): string {
  if (n === 0) return base;
  const suffix = `-${n + 1}`;
  return `${base.slice(0, 39 - suffix.length).replace(/-+$/, '')}${suffix}`;
}

export async function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return row ? toUserRow(row) : null;
}

export async function getUserByLogin(db: D1Database, login: string): Promise<UserRow | null> {
  const row = await db
    .prepare('SELECT * FROM users WHERE login = ?')
    .bind(login)
    .first<UserRow>();
  return row ? toUserRow(row) : null;
}
