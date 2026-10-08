/**
 * Repository authorization shared by every transport (git gate, REST, SSR
 * pages, and later MCP). One decision combines:
 *   1. the actor's role on the repo (owner, instance admin; org membership and
 *      explicit grants extend `repoRole`),
 *   2. the credential ceiling (PAT scopes for the transport; sessions are
 *      bounded only by the role),
 *   3. public visibility, which grants read to everyone.
 * Private repos the actor cannot read are concealed: the caller sees the same
 * response as for a repo that does not exist.
 */

import type { RepoRow } from '../db/repos';
import type { UserRow } from '../db/users';
import type { PATInfo, Scope } from '../auth/pat';

export type RepoRole = 'none' | 'read' | 'write' | 'admin';
export type Transport = 'git' | 'api' | 'page';
export type RepoNeed = Exclude<RepoRole, 'none'>;

export interface Actor {
  user: UserRow;
  via: 'session' | 'pat';
  patId?: string;
  /** PAT scopes; null for browser sessions, which carry the user's full authority. */
  scopes: Scope[] | null;
}

export type AuthzDenyCode = 'UNAUTHENTICATED' | 'NOT_FOUND' | 'INSUFFICIENT_SCOPE' | 'FORBIDDEN';

export type AuthzDecision =
  | { ok: true; role: RepoRole; repo: RepoRow }
  | { ok: false; status: 401 | 403 | 404; error: string; code: AuthzDenyCode };

export function patActor(pat: PATInfo): Actor {
  return { user: pat.user, via: 'pat', patId: pat.id, scopes: pat.scopes };
}

const RANK: Record<RepoRole, number> = { none: 0, read: 1, write: 2, admin: 3 };

function atLeast(role: RepoRole, need: RepoRole): boolean {
  return RANK[role] >= RANK[need];
}

function minRole(a: RepoRole, b: RepoRole): RepoRole {
  return RANK[a] <= RANK[b] ? a : b;
}

function maxRole(a: RepoRole, b: RepoRole): RepoRole {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * The actor's own role on the repo, ignoring credential scopes and public
 * visibility. Async so membership/grant lookups can join it without changing
 * callers.
 */
export async function repoRole(_env: Env, repo: RepoRow, actor: Actor | null): Promise<RepoRole> {
  if (!actor) return 'none';
  if (actor.user.login === repo.owner_login) return 'admin';
  // Instance admin is an explicit operations role; it never bypasses
  // protected-ref policy, which is enforced separately.
  if (actor.user.is_admin === true) return 'admin';
  return 'none';
}

/** Highest role a credential may exercise on the given transport. */
export function scopeCeiling(scopes: Scope[] | null, transport: Transport): RepoRole {
  if (scopes === null) return 'admin';
  if (transport === 'git') {
    if (scopes.includes('write')) return 'write';
    if (scopes.includes('read')) return 'read';
    return 'none';
  }
  return scopes.includes('api') ? 'admin' : 'none';
}

/** Effective role: role ∩ credential ceiling, plus public read for everyone. */
export async function effectiveRole(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  transport: Transport,
): Promise<{ role: RepoRole; uncapped: RepoRole }> {
  const own = await repoRole(env, repo, actor);
  const publicRole: RepoRole = repo.visibility === 'public' ? 'read' : 'none';
  const capped = actor ? minRole(own, scopeCeiling(actor.scopes, transport)) : 'none';
  return { role: maxRole(capped, publicRole), uncapped: maxRole(own, publicRole) };
}

function concealed(actor: Actor | null, transport: Transport): AuthzDecision {
  // Git clients only send credentials after a 401 challenge, so anonymous git
  // callers are challenged for both missing and private repos alike.
  if (!actor && transport === 'git') {
    return { ok: false, status: 401, error: 'authentication required', code: 'UNAUTHENTICATED' };
  }
  return { ok: false, status: 404, error: 'not found', code: 'NOT_FOUND' };
}

export async function authorizeRepo(
  env: Env,
  repo: RepoRow | null,
  actor: Actor | null,
  need: RepoNeed,
  transport: Transport,
): Promise<AuthzDecision> {
  if (!repo) return concealed(actor, transport);
  const { role, uncapped } = await effectiveRole(env, repo, actor, transport);
  if (atLeast(role, need)) return { ok: true, role, repo };
  if (!atLeast(uncapped, 'read')) return concealed(actor, transport);
  if (!actor) {
    return { ok: false, status: 401, error: 'authentication required', code: 'UNAUTHENTICATED' };
  }
  if (atLeast(uncapped, need)) {
    return { ok: false, status: 403, error: 'insufficient token scope', code: 'INSUFFICIENT_SCOPE' };
  }
  return { ok: false, status: 403, error: 'forbidden', code: 'FORBIDDEN' };
}
