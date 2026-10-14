/**
 * The `sandboxes`/`agent_tokens` write helpers shared by the sandbox service
 * (services/sandboxes.ts) and the AgentSandbox durable object, so a status
 * transition is written the same way in both layers. A transition that
 * detaches token_id is always issued together with the token's revoke in one
 * DB.batch — never as two sequential .run() calls.
 */

/** Idempotent revoke of one agent token: paired with every transition that clears sandboxes.token_id. */
export function revokeAgentTokenStatement(db: D1Database, tokenId: string | null, at: number): D1PreparedStatement {
  return db.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1').bind(tokenId, at);
}

/**
 * One `sandboxes` row update. `set` is the SET fragment (its parameters start
 * at ?2), `binds` covers ?2.. in order, `allowedFrom` the statuses the
 * transition accepts (rendered as `AND status IN (…)`), and `extraGuard` an
 * optional raw `AND …` predicate for correlated checks (e.g. token_id = ?N).
 */
export function updateSandboxStatement(
  db: D1Database,
  id: string,
  set: string,
  binds: readonly (string | number | null)[],
  allowedFrom?: readonly string[],
  extraGuard = '',
): D1PreparedStatement {
  const status = allowedFrom?.length ? ` AND status IN (${allowedFrom.map((s) => `'${s}'`).join(',')})` : '';
  const extra = extraGuard ? ` AND ${extraGuard}` : '';
  return db.prepare(`UPDATE sandboxes SET ${set} WHERE id = ?1${status}${extra}`).bind(id, ...binds);
}
