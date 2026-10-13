/**
 * WorkOS identities to platform users (architecture §11.1).
 *
 * - A known WorkOS user id signs in as its row.
 * - An unknown one gets a new user whose login derives from the email
 *   local-part under the shared login rules (services/orgs.ts), with a
 *   numeric suffix on collision with any user or organization login.
 * - Existing PAT-only users (created by scripts/mint-pat.mjs, including the
 *   bootstrap admin) are never linked implicitly. Two explicit paths exist:
 *   an instance admin signed in through WorkOS links a login to a WorkOS user
 *   id, or the operator opts into linking by verified email
 *   (WORKOS_LINK_VERIFIED_EMAIL=true), which links only when WorkOS reports
 *   the email verified and exactly one unlinked user carries it.
 * - Sign-in never grants instance admin.
 */

import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { RESERVED_LOGINS, validateOrgLogin } from './orgs';
import { loginCandidate, loginFromEmail, toUserRow, UNLINKED_WORKOS_PREFIX, type UserRow } from '../db/users';
import type { WorkOSIdentity } from '../auth/workos';

/** Login candidates tried before falling back to a random suffix. */
export const LOGIN_CANDIDATES = 20;
export const WORKOS_USER_ID_RE = /^user_[A-Za-z0-9]{8,64}$/;

type RawUser = Omit<UserRow, 'is_admin'> & { is_admin: unknown };

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

export function verifiedEmailLinking(env: Env): boolean {
  return (env.WORKOS_LINK_VERIFIED_EMAIL ?? '').trim().toLowerCase() === 'true';
}

/** An audit row for a link, written only when the link in the same batch took effect. */
function linkedEvent(
  db: D1Database,
  payload: { login: string; method: 'admin' | 'verified-email'; actor: string | null },
  workosUserId: string,
  now: number,
) {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, 'user.identity.linked', ?2, ?3, ?3
        WHERE EXISTS (SELECT 1 FROM users WHERE login = ?4 AND workos_user_id = ?5)`,
    )
    .bind(crypto.randomUUID(), JSON.stringify(payload), now, payload.login, workosUserId);
}

async function byWorkOSId(db: D1Database, workosUserId: string): Promise<UserRow | null> {
  const row = await db.prepare('SELECT * FROM users WHERE workos_user_id = ?').bind(workosUserId).first<RawUser>();
  return row ? toUserRow(row) : null;
}

/** Display fields follow WorkOS; the login never changes after provisioning. */
async function refreshProfile(db: D1Database, user: UserRow, identity: WorkOSIdentity): Promise<UserRow> {
  if (user.email === identity.email && user.name === identity.name && user.avatar_url === identity.avatarUrl) return user;
  await db
    .prepare('UPDATE users SET email = ?, name = ?, avatar_url = ? WHERE id = ?')
    .bind(identity.email, identity.name, identity.avatarUrl, user.id)
    .run();
  return { ...user, email: identity.email, name: identity.name, avatar_url: identity.avatarUrl };
}

async function linkByVerifiedEmail(env: Env, identity: WorkOSIdentity, now: number): Promise<UserRow | null> {
  if (!verifiedEmailLinking(env) || !identity.emailVerified) return null;
  const { results } = await env.DB.prepare(
    `SELECT * FROM users WHERE email = ?1 COLLATE NOCASE AND substr(workos_user_id, 1, ?2) = ?3 LIMIT 2`,
  )
    .bind(identity.email, UNLINKED_WORKOS_PREFIX.length, UNLINKED_WORKOS_PREFIX)
    .all<RawUser>();
  // Ambiguous matches link nothing.
  if (!results || results.length !== 1) return null;
  const target = toUserRow(results[0]!);
  const [updated] = await env.DB.batch([
    env.DB.prepare('UPDATE users SET workos_user_id = ?1 WHERE id = ?2 AND workos_user_id = ?3').bind(
      identity.id,
      target.id,
      target.workos_user_id,
    ),
    linkedEvent(env.DB, { login: target.login, method: 'verified-email', actor: null }, identity.id, now),
  ]);
  if ((updated?.meta?.changes ?? 0) === 0) return null;
  return refreshProfile(env.DB, { ...target, workos_user_id: identity.id }, identity);
}

/** The first free candidate login, judged against the shared user/org namespace. */
async function freeLogin(db: D1Database, base: string, skip: Set<string>): Promise<string | null> {
  const candidates = Array.from({ length: LOGIN_CANDIDATES }, (_, n) => loginCandidate(base, n)).filter(
    (login) => !skip.has(login) && !RESERVED_LOGINS.has(login) && validateOrgLogin(login) === null,
  );
  if (candidates.length === 0) return null;
  const { results } = await db
    .prepare(`SELECT login FROM account_names WHERE login IN (${candidates.map(() => '?').join(', ')})`)
    .bind(...candidates)
    .all<{ login: string }>();
  const taken = new Set((results ?? []).map((r) => r.login.toLowerCase()));
  return candidates.find((login) => !taken.has(login)) ?? null;
}

function randomLogin(base: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${base.slice(0, 39 - 9).replace(/-+$/, '') || 'user'}-${suffix}`;
}

/**
 * The platform user for a WorkOS identity at sign-in: found, linked (opt-in
 * verified email only) or provisioned.
 */
export async function provisionSessionUser(
  env: Env,
  identity: WorkOSIdentity,
  now = Date.now(),
): Promise<ServiceResult<UserRow>> {
  const existing = await byWorkOSId(env.DB, identity.id);
  if (existing) return { ok: true, value: await refreshProfile(env.DB, existing, identity) };
  const linked = await linkByVerifiedEmail(env, identity, now);
  if (linked) return { ok: true, value: linked };

  const base = loginFromEmail(identity.email);
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 6; attempt++) {
    const login = (attempt < 3 ? await freeLogin(env.DB, base, tried) : null) ?? randomLogin(base);
    tried.add(login);
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, workos_user_id, login, email, name, avatar_url, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
        .bind(id, identity.id, login, identity.email, identity.name, identity.avatarUrl, now)
        .run();
      return {
        ok: true,
        value: {
          id,
          workos_user_id: identity.id,
          login,
          email: identity.email,
          name: identity.name,
          avatar_url: identity.avatarUrl,
          is_admin: false,
          created_at: now,
        },
      };
    } catch (err) {
      const message = String(err);
      if (!message.includes('UNIQUE')) throw err;
      // A concurrent first sign-in of the same person won the insert.
      if (message.includes('workos_user_id')) {
        const raced = await byWorkOSId(env.DB, identity.id);
        if (raced) return { ok: true, value: raced };
      }
      // Otherwise the login (user or org) was claimed in between: next candidate.
    }
  }
  return fail(409, 'could not allocate a login for this account', 'LOGIN_UNAVAILABLE');
}

/**
 * Explicit link by an instance admin signed in through WorkOS: the PAT-only
 * user `login` becomes the account of WorkOS user `workosUserId`. Refused for
 * PATs and agent tokens, for already linked users, and when that WorkOS user
 * already has an account.
 */
export async function linkWorkOSIdentity(
  env: Env,
  actor: Actor,
  login: string,
  workosUserId: string,
  now = Date.now(),
): Promise<ServiceResult<UserRow>> {
  if (actor.agent || actor.via !== 'session' || actor.user.is_admin !== true) {
    return fail(403, 'only an instance admin signed in through WorkOS links accounts', 'FORBIDDEN');
  }
  if (!WORKOS_USER_ID_RE.test(workosUserId)) return fail(400, 'WorkOS user ids look like user_…', 'INVALID_WORKOS_USER_ID');
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET workos_user_id = ?1 WHERE login = ?2 AND substr(workos_user_id, 1, ?3) = ?4`,
      ).bind(workosUserId, login, UNLINKED_WORKOS_PREFIX.length, UNLINKED_WORKOS_PREFIX),
      linkedEvent(env.DB, { login, method: 'admin', actor: actor.user.login }, workosUserId, now),
      env.DB.prepare('SELECT * FROM users WHERE login = ?1').bind(login),
    ]);
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return fail(409, 'that WorkOS user already has an account', 'WORKOS_USER_TAKEN');
    }
    throw err;
  }
  const row = results[2]?.results?.[0] as RawUser | undefined;
  if (!row) return fail(404, 'user not found', 'NOT_FOUND');
  const user = toUserRow(row);
  if (user.workos_user_id !== workosUserId) return fail(409, 'that account is already linked', 'ALREADY_LINKED');
  return { ok: true, value: user };
}
