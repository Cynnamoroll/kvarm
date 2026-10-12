/**
 * Explicit per-repo grants (`read`, `write`, `admin`) for named users.
 *
 * Callers authorize the acting principal for repo `admin` first through the
 * shared policy (services/authz.ts). Grants on org repos are limited to the
 * org's current members; personal repos accept any user as a collaborator.
 * Grants are never cached: every private or write decision reads them from D1
 * in the authoritative batch (services/access.ts), so a revoke or downgrade
 * applies to the next request.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor, RepoNeed } from './authz';

export interface RepoGrant {
  login: string;
  role: RepoNeed;
  createdAt: number;
  updatedAt: number;
}

export const GRANT_LIST_MAX = 200;

export async function setGrant(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  targetLogin: string,
  role: RepoNeed,
): Promise<ServiceResult<{ grant: RepoGrant }>> {
  const now = Date.now();
  const [write, diag] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at)
       SELECT ?1, u.id, ?3, ?4, ?5, ?5 FROM users u
        WHERE u.login = ?2
          AND (NOT EXISTS (SELECT 1 FROM orgs WHERE login = ?6)
               OR EXISTS (SELECT 1 FROM orgs o JOIN org_members m ON m.org_id = o.id
                           WHERE o.login = ?6 AND m.user_id = u.id))
       ON CONFLICT (repo_id, user_id) DO UPDATE
         SET role = excluded.role, granted_by = excluded.granted_by, updated_at = excluded.updated_at
       RETURNING role, created_at, updated_at`,
    ).bind(repo.id, targetLogin, role, actor.user.id, now, repo.owner_login),
    env.DB.prepare('SELECT (SELECT id FROM users WHERE login = ?1) AS target_id').bind(targetLogin),
  ]);
  const row = write?.results?.[0] as { role: RepoNeed; created_at: number; updated_at: number } | undefined;
  if (!row) {
    const target = (diag?.results?.[0] as { target_id: string | null } | undefined)?.target_id;
    if (!target) return { ok: false, status: 404, error: 'user not found', code: 'USER_NOT_FOUND' };
    return {
      ok: false,
      status: 422,
      error: 'grants on organization repositories require organization membership',
      code: 'NOT_ORG_MEMBER',
    };
  }
  return {
    ok: true,
    value: { grant: { login: targetLogin, role: row.role, createdAt: row.created_at, updatedAt: row.updated_at } },
  };
}

export async function revokeGrant(env: Env, repo: RepoRow, targetLogin: string): Promise<{ revoked: boolean }> {
  const res = await env.DB.prepare(
    'DELETE FROM repo_grants WHERE repo_id = ? AND user_id = (SELECT id FROM users WHERE login = ?)',
  )
    .bind(repo.id, targetLogin)
    .run();
  return { revoked: (res.meta?.changes ?? 0) > 0 };
}

export async function listGrants(env: Env, repo: RepoRow): Promise<RepoGrant[]> {
  const { results } = await env.DB.prepare(
    `SELECT u.login, g.role, g.created_at, g.updated_at FROM repo_grants g JOIN users u ON u.id = g.user_id
      WHERE g.repo_id = ? ORDER BY u.login LIMIT ?`,
  )
    .bind(repo.id, GRANT_LIST_MAX)
    .all<{ login: string; role: RepoNeed; created_at: number; updated_at: number }>();
  return (results ?? []).map((r) => ({ login: r.login, role: r.role, createdAt: r.created_at, updatedAt: r.updated_at }));
}
