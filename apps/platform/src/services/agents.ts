/**
 * Durable agent principals and their owner-minted tokens (architecture §11.1).
 *
 * - An agent belongs to one account: a user (managed by that user) or an
 *   organization (managed by its owners, `canManageOrgCredentials`).
 * - Tokens are minted by a managing human for one repository with role
 *   `read` or `write`; write tokens also carry the ref patterns they may
 *   update. The minter must hold at least that role on the repo when minting,
 *   and at request time the token is further capped by the minter's current
 *   role (services/authz.ts), so a later revoke/downgrade of the minter also
 *   narrows the token.
 * - Every token expires. Agents and tokens are revoked, never deleted, and
 *   every mint/revoke appends an `events` row carrying the token prefix only.
 * - Agent credentials can never manage agents or mint tokens: the routes
 *   resolve a human actor first (routes/api.ts `requireActor`).
 *
 * Mutations are one D1 batch whose writes carry their own authorization
 * guard, plus a read that explains a write that changed nothing.
 */

import { isValidRefPattern } from '@forge/gitops';
import { newAgentToken, parseRefList, type AgentRole } from '../auth/agentTokens';
import { patHash } from '../auth/pat';
import type { ServiceResult } from '../repos/service';
import { resolveRepoAccessAs } from './access';
import type { Actor } from './authz';
import { parseModelFamily } from './reviewGate';

export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AGENT_DESCRIPTION_MAX = 500;
export const AGENT_LIST_MAX = 200;
export const AGENT_TOKEN_LIST_MAX = 200;
export const AGENT_TOKEN_MIN_TTL_SECONDS = 60;
export const AGENT_TOKEN_MAX_TTL_SECONDS = 30 * 24 * 3600;
export const AGENT_TOKEN_DEFAULT_TTL_SECONDS = 3600;
export const AGENT_TOKEN_MAX_REFS = 16;

export interface AgentRow {
  id: string;
  owner_kind: 'user' | 'org';
  owner_id: string;
  owner_login: string;
  name: string;
  description: string | null;
  created_by: string;
  created_by_login: string | null;
  created_at: number;
  revoked_at: number | null;
  model_family: string | null;
}

export interface AgentTokenListRow {
  id: string;
  agent_id: string;
  name: string | null;
  prefix: string;
  repo_owner: string;
  repo_name: string;
  role: AgentRole;
  refs: string;
  created_by_login: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  agent_revoked_at: number | null;
}

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

/** Manageability of the agent row named `t` for the user bound at `uid`. */
function manageCond(t: string, uid: string): string {
  return `((${t}.owner_kind = 'user' AND ${t}.owner_id = ${uid})
        OR (${t}.owner_kind = 'org' AND EXISTS (SELECT 1 FROM org_members m
              WHERE m.org_id = ${t}.owner_id AND m.user_id = ${uid} AND m.role = 'owner')))`;
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Appends an audit row only when `guard` holds after the preceding writes in
 * the batch. `binds` start at ?4 and ?5 must be the timestamp.
 */
function auditEvent(db: D1Database, type: string, payload: unknown, now: number, guard: string, binds: unknown[]) {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, ?2, ?3, ?5, ?5 WHERE ${guard}`,
    )
    .bind(crypto.randomUUID(), type, JSON.stringify(payload), ...binds);
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export interface CreateAgentInput {
  owner: string;
  name: string;
  description: string | null;
  /** Model family of the agent (reviews prefer a different family than the author's); unvalidated input. */
  modelFamily?: unknown;
}

const AGENT_SELECT = `SELECT a.id, a.owner_kind, a.owner_id, a.owner_login, a.name, a.description, a.created_by,
       u.login AS created_by_login, a.created_at, a.revoked_at, a.model_family
  FROM agents a LEFT JOIN users u ON u.id = a.created_by`;

export async function createAgent(env: Env, actor: Actor, input: CreateAgentInput): Promise<ServiceResult<AgentRow>> {
  if (!AGENT_NAME_RE.test(input.name)) {
    return fail(400, 'name must be 1-64 lowercase letters, digits, dots, dashes or underscores', 'INVALID_NAME');
  }
  if (input.description !== null && input.description.length > AGENT_DESCRIPTION_MAX) {
    return fail(400, `description must be at most ${AGENT_DESCRIPTION_MAX} characters`, 'INVALID_DESCRIPTION');
  }
  const family = parseModelFamily(input.modelFamily);
  if (!family.ok) return family;
  const modelFamily = family.value;
  const now = Date.now();
  const id = crypto.randomUUID();
  const personal = sameLogin(input.owner, actor.user.login);
  const insert = personal
    ? env.DB.prepare(
        `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, description, created_by, created_at, model_family)
         VALUES (?1, 'user', ?4, ?6, ?2, ?3, ?4, ?5, ?7)
         ON CONFLICT (owner_id, name) DO NOTHING`,
      ).bind(id, input.name, input.description, actor.user.id, now, actor.user.login, modelFamily)
    : env.DB.prepare(
        `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, description, created_by, created_at, model_family)
         SELECT ?1, 'org', o.id, o.login, ?2, ?3, ?4, ?5, ?7 FROM orgs o
          WHERE o.login = ?6
            AND EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id AND m.user_id = ?4 AND m.role = 'owner')
         ON CONFLICT (owner_id, name) DO NOTHING`,
      ).bind(id, input.name, input.description, actor.user.id, now, input.owner, modelFamily);
  const [, , created, diag] = await env.DB.batch([
    insert,
    auditEvent(
      env.DB,
      'agent.created',
      { agentId: id, owner: input.owner, name: input.name, modelFamily, actor: actor.user.login },
      now,
      'EXISTS (SELECT 1 FROM agents WHERE id = ?4)',
      [id, now],
    ),
    env.DB.prepare(`${AGENT_SELECT} WHERE a.id = ?1`).bind(id),
    env.DB.prepare(
      `SELECT (SELECT id FROM orgs WHERE login = ?1) AS org_id,
              (SELECT m.role FROM orgs o JOIN org_members m ON m.org_id = o.id
                WHERE o.login = ?1 AND m.user_id = ?2) AS org_role`,
    ).bind(input.owner, actor.user.id),
  ]);
  const row = created?.results?.[0] as AgentRow | undefined;
  if (row) return { ok: true, value: row };
  if (!personal) {
    const d = diag?.results?.[0] as { org_id: string | null; org_role: string | null } | undefined;
    if (!d?.org_id) return fail(404, 'account not found', 'NOT_FOUND');
    if (d.org_role !== 'owner') return fail(403, 'only organization owners manage agent credentials', 'FORBIDDEN');
  }
  return fail(409, 'an agent with this name already exists for this account', 'NAME_TAKEN');
}

export async function getAgent(env: Env, actor: Actor, id: string): Promise<ServiceResult<AgentRow>> {
  const row = await env.DB.prepare(`${AGENT_SELECT} WHERE a.id = ?1 AND ${manageCond('a', '?2')}`)
    .bind(id, actor.user.id)
    .first<AgentRow>();
  // Agents of accounts the caller does not manage are concealed.
  if (!row) return fail(404, 'agent not found', 'NOT_FOUND');
  return { ok: true, value: row };
}

export async function listAgents(
  env: Env,
  actor: Actor,
  owner: string,
  page: { cursor?: string; limit?: number },
): Promise<ServiceResult<{ agents: AgentRow[]; nextCursor: string | null }>> {
  const limit = Math.min(Math.max(page.limit ?? 100, 1), AGENT_LIST_MAX);
  const [diag, list] = await env.DB.batch([
    env.DB.prepare(
      `SELECT (SELECT id FROM orgs WHERE login = ?1) AS org_id,
              (SELECT m.role FROM orgs o JOIN org_members m ON m.org_id = o.id
                WHERE o.login = ?1 AND m.user_id = ?2) AS org_role`,
    ).bind(owner, actor.user.id),
    env.DB.prepare(
      `${AGENT_SELECT} WHERE a.owner_login = ?1 AND ${manageCond('a', '?2')} AND a.name > ?3
        ORDER BY a.name LIMIT ?4`,
    ).bind(owner, actor.user.id, page.cursor ?? '', limit + 1),
  ]);
  if (!sameLogin(owner, actor.user.login)) {
    const d = diag?.results?.[0] as { org_id: string | null; org_role: string | null } | undefined;
    if (!d?.org_id) return fail(404, 'account not found', 'NOT_FOUND');
    if (d.org_role !== 'owner') return fail(403, 'only organization owners manage agent credentials', 'FORBIDDEN');
  }
  const rows = (list?.results ?? []) as unknown as AgentRow[];
  const more = rows.length > limit;
  const agents = more ? rows.slice(0, limit) : rows;
  return { ok: true, value: { agents, nextCursor: more ? (agents.at(-1)?.name ?? null) : null } };
}

/** Revokes the agent and all its tokens. Idempotent; the record is kept. */
export async function revokeAgent(env: Env, actor: Actor, id: string): Promise<ServiceResult<AgentRow>> {
  const now = Date.now();
  const uid = actor.user.id;
  const [, , , row] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agents SET revoked_at = ?1, revoked_by = ?2
        WHERE id = ?3 AND revoked_at IS NULL AND ${manageCond('agents', '?2')}`,
    ).bind(now, uid, id),
    env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ?1, revoked_by = ?2
        WHERE agent_id = ?3 AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM agents WHERE agents.id = ?3 AND agents.revoked_at = ?1 AND agents.revoked_by = ?2)`,
    ).bind(now, uid, id),
    auditEvent(
      env.DB,
      'agent.revoked',
      { agentId: id, actor: actor.user.login },
      now,
      'EXISTS (SELECT 1 FROM agents WHERE id = ?4 AND revoked_at = ?5 AND revoked_by = ?6)',
      [id, now, uid],
    ),
    env.DB.prepare(`${AGENT_SELECT} WHERE a.id = ?1 AND ${manageCond('a', '?2')}`).bind(id, uid),
  ]);
  const agent = row?.results?.[0] as AgentRow | undefined;
  if (!agent) return fail(404, 'agent not found', 'NOT_FOUND');
  return { ok: true, value: agent };
}

// ---------------------------------------------------------------------------
// Agent tokens
// ---------------------------------------------------------------------------

export interface MintTokenInput {
  repo: string;
  role: string;
  refs: unknown;
  expiresIn: unknown;
  name: string | null;
}

export interface MintedToken {
  token: string;
  row: AgentTokenListRow;
}

type ValidMint = { owner: string; name: string; role: AgentRole; refs: string[]; ttlSeconds: number };

export function validateMint(input: MintTokenInput): ServiceResult<ValidMint> {
  const parts = input.repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return fail(400, 'repo must be "owner/name"', 'INVALID_REPO');
  if (input.role !== 'read' && input.role !== 'write') return fail(400, 'role must be read or write', 'INVALID_ROLE');
  let refs: string[] = [];
  if (input.refs !== undefined && input.refs !== null) {
    if (!Array.isArray(input.refs) || !input.refs.every((r): r is string => typeof r === 'string')) {
      return fail(400, 'refs must be an array of ref patterns', 'INVALID_REFS');
    }
    refs = [...new Set(input.refs)];
  }
  if (input.role === 'write') {
    if (refs.length === 0) return fail(400, 'write tokens need at least one ref pattern', 'INVALID_REFS');
    if (refs.length > AGENT_TOKEN_MAX_REFS) {
      return fail(400, `at most ${AGENT_TOKEN_MAX_REFS} ref patterns`, 'INVALID_REFS');
    }
    const bad = refs.find((r) => !isValidRefPattern(r));
    if (bad !== undefined) {
      return fail(400, 'ref patterns are full ref names or end in /* below refs/<kind>/', 'INVALID_REFS');
    }
  } else if (refs.length > 0) {
    return fail(400, 'read tokens do not take ref patterns', 'INVALID_REFS');
  }
  let ttlSeconds = AGENT_TOKEN_DEFAULT_TTL_SECONDS;
  if (input.expiresIn !== undefined && input.expiresIn !== null) {
    if (
      typeof input.expiresIn !== 'number' ||
      !Number.isInteger(input.expiresIn) ||
      input.expiresIn < AGENT_TOKEN_MIN_TTL_SECONDS ||
      input.expiresIn > AGENT_TOKEN_MAX_TTL_SECONDS
    ) {
      return fail(
        400,
        `expiresIn must be an integer number of seconds between ${AGENT_TOKEN_MIN_TTL_SECONDS} and ${AGENT_TOKEN_MAX_TTL_SECONDS}`,
        'INVALID_EXPIRY',
      );
    }
    ttlSeconds = input.expiresIn;
  }
  if (input.name !== null && input.name.length > 100) return fail(400, 'name must be at most 100 characters', 'INVALID_NAME');
  return { ok: true, value: { owner: parts[0], name: parts[1], role: input.role, refs, ttlSeconds } };
}

const TOKEN_SELECT = `SELECT t.id, t.agent_id, t.name, t.prefix, r.owner_login AS repo_owner, r.name AS repo_name,
       t.role, t.refs, u.login AS created_by_login, t.created_at, t.expires_at, t.revoked_at, t.last_used_at,
       a.revoked_at AS agent_revoked_at
  FROM agent_tokens t
  JOIN agents a ON a.id = t.agent_id
  JOIN repos r ON r.id = t.repo_id
  LEFT JOIN users u ON u.id = t.created_by`;

export async function mintAgentToken(
  env: Env,
  actor: Actor,
  agentId: string,
  input: MintTokenInput,
): Promise<ServiceResult<MintedToken>> {
  const valid = validateMint(input);
  if (!valid.ok) return valid;
  const v = valid.value;
  const agent = await getAgent(env, actor, agentId);
  if (!agent.ok) return agent;
  if (agent.value.revoked_at !== null) return fail(409, 'agent is revoked', 'AGENT_REVOKED');

  // The minter's own current access bounds what the token may carry.
  const access = await resolveRepoAccessAs(env, actor, v.owner, v.name, v.role);
  if (!access.ok) {
    if (access.status === 404 || access.status === 401) return fail(404, 'repository not found', 'NOT_FOUND');
    return fail(403, `your access to this repository does not allow a ${v.role} token`, 'FORBIDDEN');
  }
  const repo = access.repo;
  if (agent.value.owner_kind === 'org' && repo.owner_org_id !== agent.value.owner_id) {
    return fail(422, "organization agents may only receive grants on the organization's repositories", 'REPO_OUTSIDE_ACCOUNT');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const { token, prefix } = newAgentToken();
  const hash = await patHash(token);
  const expiresAt = now + v.ttlSeconds * 1000;
  const [inserted, , row] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at)
       SELECT ?1, a.id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM agents a
        WHERE a.id = ?2 AND a.revoked_at IS NULL AND ${manageCond('a', '?9')}`,
    ).bind(id, agentId, input.name, prefix, hash, repo.id, v.role, JSON.stringify(v.refs), actor.user.id, now, expiresAt),
    auditEvent(
      env.DB,
      'agent.token.created',
      {
        agentId,
        tokenId: id,
        prefix,
        repo: `${repo.owner_login}/${repo.name}`,
        role: v.role,
        refs: v.refs,
        expiresAt: new Date(expiresAt).toISOString(),
        actor: actor.user.login,
      },
      now,
      'EXISTS (SELECT 1 FROM agent_tokens WHERE id = ?4)',
      [id, now],
    ),
    env.DB.prepare(`${TOKEN_SELECT} WHERE t.id = ?1`).bind(id),
  ]);
  const created = row?.results?.[0] as AgentTokenListRow | undefined;
  if (!created || (inserted?.meta?.changes ?? 0) === 0) {
    return fail(409, 'agent is revoked or no longer manageable', 'AGENT_REVOKED');
  }
  return { ok: true, value: { token, row: created } };
}

export async function listAgentTokens(
  env: Env,
  actor: Actor,
  agentId: string,
): Promise<ServiceResult<AgentTokenListRow[]>> {
  const [agent, list] = await env.DB.batch([
    env.DB.prepare(`SELECT 1 AS ok FROM agents a WHERE a.id = ?1 AND ${manageCond('a', '?2')}`).bind(agentId, actor.user.id),
    env.DB.prepare(
      `${TOKEN_SELECT} WHERE t.agent_id = ?1 AND ${manageCond('a', '?2')} ORDER BY t.created_at DESC LIMIT ?3`,
    ).bind(agentId, actor.user.id, AGENT_TOKEN_LIST_MAX),
  ]);
  if (!agent?.results?.[0]) return fail(404, 'agent not found', 'NOT_FOUND');
  return { ok: true, value: (list?.results ?? []) as unknown as AgentTokenListRow[] };
}

export async function revokeAgentToken(
  env: Env,
  actor: Actor,
  agentId: string,
  tokenId: string,
): Promise<ServiceResult<{ revoked: boolean; row: AgentTokenListRow }>> {
  const now = Date.now();
  const uid = actor.user.id;
  const [update, , row] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = ?1, revoked_by = ?2
        WHERE id = ?3 AND agent_id = ?4 AND revoked_at IS NULL
          AND EXISTS (SELECT 1 FROM agents WHERE agents.id = ?4 AND ${manageCond('agents', '?2')})`,
    ).bind(now, uid, tokenId, agentId),
    auditEvent(
      env.DB,
      'agent.token.revoked',
      { agentId, tokenId, actor: actor.user.login },
      now,
      'EXISTS (SELECT 1 FROM agent_tokens WHERE id = ?4 AND revoked_at = ?5 AND revoked_by = ?6)',
      [tokenId, now, uid],
    ),
    env.DB.prepare(`${TOKEN_SELECT} WHERE t.id = ?1 AND t.agent_id = ?2 AND ${manageCond('a', '?3')}`).bind(
      tokenId,
      agentId,
      uid,
    ),
  ]);
  const token = row?.results?.[0] as AgentTokenListRow | undefined;
  if (!token) return fail(404, 'token not found', 'NOT_FOUND');
  return { ok: true, value: { revoked: (update?.meta?.changes ?? 0) > 0, row: token } };
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function agentJson(a: AgentRow) {
  return {
    id: a.id,
    owner: a.owner_login,
    ownerKind: a.owner_kind,
    name: a.name,
    description: a.description,
    modelFamily: a.model_family ?? null,
    createdBy: a.created_by_login,
    createdAt: iso(a.created_at),
    revokedAt: iso(a.revoked_at),
    status: a.revoked_at === null ? 'active' : 'revoked',
  };
}

export function agentTokenJson(t: AgentTokenListRow, now = Date.now()) {
  const revokedAt = t.revoked_at ?? t.agent_revoked_at;
  return {
    id: t.id,
    agentId: t.agent_id,
    name: t.name,
    prefix: t.prefix,
    repo: `${t.repo_owner}/${t.repo_name}`,
    role: t.role,
    refs: parseRefList(t.refs),
    createdBy: t.created_by_login,
    createdAt: iso(t.created_at),
    expiresAt: iso(t.expires_at),
    revokedAt: iso(revokedAt),
    lastUsedAt: iso(t.last_used_at),
    status: revokedAt !== null ? 'revoked' : t.expires_at <= now ? 'expired' : 'active',
  };
}
