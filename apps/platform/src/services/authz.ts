/**
 * Repository authorization shared by every transport (git gate, REST, SSR
 * pages, and later MCP). One decision combines:
 *   1. the actor's role on the repo (personal owner, instance admin, org
 *      owner/maintainer, or an explicit per-repo grant),
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
export type OrgRole = 'owner' | 'maintainer' | 'member';

/**
 * Mutable access facts for one actor and repo, read authoritatively from D1
 * (services/access.ts) whenever the decision is not a public read.
 */
export interface AccessFacts {
  /** The repo is owned by an organization rather than a personal account. */
  ownerIsOrg: boolean;
  /** The actor's direct membership role in the org that owns the repo. */
  orgRole: OrgRole | null;
  /** The actor's explicit grant on this repo. */
  grant: RepoNeed | null;
}

export const NO_FACTS: AccessFacts = { ownerIsOrg: false, orgRole: null, grant: null };

export function isOrgRole(v: unknown): v is OrgRole {
  return v === 'owner' || v === 'maintainer' || v === 'member';
}

export function isRepoNeed(v: unknown): v is RepoNeed {
  return v === 'read' || v === 'write' || v === 'admin';
}

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
 * visibility. Org owners and maintainers administer the org's repos; plain
 * members get nothing implicitly, only their explicit grant.
 */
export function repoRole(repo: RepoRow, actor: Actor | null, facts: AccessFacts = NO_FACTS): RepoRole {
  if (!actor) return 'none';
  if (!facts.ownerIsOrg && actor.user.login === repo.owner_login) return 'admin';
  // Instance admin is an explicit operations role; it never bypasses
  // protected-ref policy, which is enforced separately.
  if (actor.user.is_admin === true) return 'admin';
  if (facts.orgRole === 'owner' || facts.orgRole === 'maintainer') return 'admin';
  // Grants on org repos lapse as soon as membership ends, even before the
  // grant rows are cleaned up.
  if (facts.ownerIsOrg && facts.orgRole === null) return 'none';
  return facts.grant ?? 'none';
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
export function effectiveRole(
  repo: RepoRow,
  actor: Actor | null,
  transport: Transport,
  facts: AccessFacts = NO_FACTS,
): { role: RepoRole; uncapped: RepoRole } {
  const own = repoRole(repo, actor, facts);
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

/**
 * `facts` must come from an authoritative read unless the request is a read of
 * a public repo, where visibility alone already decides the outcome.
 */
export async function authorizeRepo(
  _env: Env,
  repo: RepoRow | null,
  actor: Actor | null,
  need: RepoNeed,
  transport: Transport,
  facts: AccessFacts = NO_FACTS,
): Promise<AuthzDecision> {
  if (!repo) return concealed(actor, transport);
  const { role, uncapped } = effectiveRole(repo, actor, transport, facts);
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
