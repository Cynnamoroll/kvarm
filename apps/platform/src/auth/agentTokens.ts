/**
 * Agent tokens: owner-minted, expiring credentials for a durable agent
 * principal, scoped to one repository with a `read` or `write` role and, for
 * writes, an explicit list of ref patterns. Stored SHA-256-hashed; the
 * plaintext is returned once at mint time and only the prefix is ever listed
 * or audited.
 *
 * Unlike human PATs, positive agent-token verification is never cached: every
 * request re-reads the token, agent and minting user in the authoritative D1
 * batch (services/access.ts), so expiry and revocation apply to the next
 * request in every colo.
 */

import { toUserRow, type UserRow } from '../db/users';
import type { PATInfo, Scope } from './pat';

export const AGENT_TOKEN_PATTERN = /^kvarm_agt_[0-9a-f]{64}$/;
export const AGENT_TOKEN_PREFIX_LENGTH = 18;

export type AgentRole = 'read' | 'write';

export interface AgentGrant {
  agentId: string;
  agentName: string;
  ownerLogin: string;
  ownerKind: 'user' | 'org';
  tokenId: string;
  repoId: string;
  role: AgentRole;
  /** Ref patterns the token may create, update or delete (write role only). */
  refs: string[];
  expiresAt: number;
}

/** The token's API/git ceiling expressed as PAT scopes; the grant itself is enforced in authz. */
function grantScopes(role: AgentRole): Scope[] {
  return role === 'write' ? ['read', 'write', 'api'] : ['read', 'api'];
}

export function isAgentToken(token: string): boolean {
  return AGENT_TOKEN_PATTERN.test(token);
}

export function newAgentToken(): { token: string; prefix: string } {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  let hex = '';
  for (const b of buf) hex += b.toString(16).padStart(2, '0');
  const token = `kvarm_agt_${hex}`;
  return { token, prefix: token.slice(0, AGENT_TOKEN_PREFIX_LENGTH) };
}

/**
 * The live token with its agent and minting user. Revoked tokens, revoked
 * agents and expired tokens match nothing, so they fail closed exactly like
 * unknown tokens.
 */
export function agentTokenSelect(db: D1Database, hash: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT t.id AS tok_id, t.agent_id AS tok_agent_id, t.repo_id AS tok_repo_id, t.role AS tok_role,
              t.refs AS tok_refs, t.expires_at AS tok_expires_at, t.last_used_at AS tok_last_used_at,
              a.name AS agent_name, a.owner_login AS agent_owner_login, a.owner_kind AS agent_owner_kind, u.*
         FROM agent_tokens t
         JOIN agents a ON a.id = t.agent_id
         JOIN users u ON u.id = t.created_by
        WHERE t.hash = ?1 AND t.revoked_at IS NULL AND a.revoked_at IS NULL AND t.expires_at > ?2`,
    )
    .bind(hash, now);
}

/** Records use at most once per window, matching human PAT stamping. */
export function agentTokenStamp(db: D1Database, hash: string, now: number, intervalMs: number): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE agent_tokens SET last_used_at = ?1 WHERE hash = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)',
    )
    .bind(now, hash, now - intervalMs);
}

export type AgentTokenRow = Omit<UserRow, 'is_admin'> & {
  is_admin: unknown;
  tok_id: string;
  tok_agent_id: string;
  tok_repo_id: string;
  tok_role: string;
  tok_refs: string;
  tok_expires_at: number;
  tok_last_used_at: number | null;
  agent_name: string;
  agent_owner_login: string;
  agent_owner_kind: string;
};

export function parseRefList(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function agentFromRow(row: AgentTokenRow | null | undefined, now: number): PATInfo | null {
  if (!row || row.tok_expires_at <= now) return null;
  if (row.tok_role !== 'read' && row.tok_role !== 'write') return null;
  if (row.agent_owner_kind !== 'user' && row.agent_owner_kind !== 'org') return null;
  const {
    tok_id,
    tok_agent_id,
    tok_repo_id,
    tok_role,
    tok_refs,
    tok_expires_at,
    tok_last_used_at,
    agent_name,
    agent_owner_login,
    agent_owner_kind,
    ...user
  } = row;
  const role: AgentRole = tok_role;
  return {
    id: tok_id,
    userId: user.id,
    scopes: grantScopes(role),
    user: toUserRow(user),
    expiresAt: tok_expires_at,
    lastUsedAt: tok_last_used_at,
    agent: {
      agentId: tok_agent_id,
      agentName: agent_name,
      ownerLogin: agent_owner_login,
      ownerKind: agent_owner_kind,
      tokenId: tok_id,
      repoId: tok_repo_id,
      role,
      refs: role === 'write' ? parseRefList(tok_refs) : [],
      expiresAt: tok_expires_at,
    },
  };
}
