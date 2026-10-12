/**
 * Organization-owned repositories: creation by owners and maintainers, and a
 * listing filtered to what the viewer may read. Get, update and delete use
 * the ordinary `/repos/:owner/:repo` routes and the shared policy.
 */

import type { RepoRow } from '../db/repos';
import { createRepo, type CreateRepoParams, type ServiceResult } from '../repos/service';
import { isOrgRole, type Actor, type OrgRole } from './authz';
import { canAdministerOrgRepos, getOrg, type OrgRow } from './orgs';

export const ORG_REPO_PAGE_MAX = 100;

export async function createOrgRepo(
  env: Env,
  actor: Actor,
  orgLogin: string,
  p: Omit<CreateRepoParams, 'ownerLogin' | 'ownerOrgId'>,
): Promise<ServiceResult<RepoRow>> {
  const found = await getOrg(env, orgLogin, actor);
  if (!found) return { ok: false, status: 404, error: 'organization not found', code: 'NOT_FOUND' };
  if (!canAdministerOrgRepos(found.role)) {
    return {
      ok: false,
      status: 403,
      error: 'only organization owners and maintainers can create repositories',
      code: 'FORBIDDEN',
    };
  }
  return createRepo(env, { ...p, ownerLogin: found.org.login, ownerOrgId: found.org.id });
}

/**
 * Repos the viewer can read: public ones for everyone, all of them for owners,
 * maintainers and the instance admin, plus private repos a current member
 * holds a grant on. One D1 round trip.
 */
export async function listOrgRepos(
  env: Env,
  orgLogin: string,
  viewer: Actor | null,
  page: { cursor?: string; limit?: number } = {},
): Promise<ServiceResult<{ org: OrgRow; viewerRole: OrgRole | null; repos: RepoRow[]; nextCursor: string | null }>> {
  const limit = Math.max(1, Math.min(ORG_REPO_PAGE_MAX, Math.floor(page.limit ?? 50)));
  const userId = viewer?.user.id ?? null;
  const [head, list] = await env.DB.batch([
    env.DB.prepare(
      `SELECT o.*, (SELECT role FROM org_members WHERE org_id = o.id AND user_id = ?2) AS viewer_role
         FROM orgs o WHERE o.login = ?1`,
    ).bind(orgLogin, userId),
    env.DB.prepare(
      `WITH viewer AS (
         SELECT m.role AS role FROM orgs o JOIN org_members m ON m.org_id = o.id
          WHERE o.login = ?1 AND m.user_id = ?3)
       SELECT r.* FROM repos r
        WHERE r.owner_login = ?1 AND r.name > ?2
          AND EXISTS (SELECT 1 FROM orgs WHERE login = ?1)
          AND (r.visibility = 'public'
               OR ?4 = 1
               OR EXISTS (SELECT 1 FROM viewer WHERE role IN ('owner', 'maintainer'))
               OR (EXISTS (SELECT 1 FROM viewer)
                   AND EXISTS (SELECT 1 FROM repo_grants g WHERE g.repo_id = r.id AND g.user_id = ?3)))
        ORDER BY r.name LIMIT ?5`,
    ).bind(orgLogin, page.cursor ?? '', userId, viewer?.user.is_admin === true ? 1 : 0, limit + 1),
  ]);
  const orgRow = head?.results?.[0] as (OrgRow & { viewer_role: unknown }) | undefined;
  if (!orgRow) return { ok: false, status: 404, error: 'organization not found', code: 'NOT_FOUND' };
  const { viewer_role, ...org } = orgRow;
  const rows = (list?.results ?? []) as RepoRow[];
  const repos = rows.slice(0, limit);
  return {
    ok: true,
    value: {
      org,
      viewerRole: isOrgRole(viewer_role) ? viewer_role : null,
      repos,
      nextCursor: rows.length > limit ? (repos[repos.length - 1]?.name ?? null) : null,
    },
  };
}
