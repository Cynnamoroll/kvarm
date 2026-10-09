/**
 * D1 statements that maintain the Nexus active index (`workspace_paths`).
 * Callers put them in their own batches so index rows change in the same
 * transaction as the workspace state they reflect.
 */

/** Indexes a just-inserted active workspace's declaration (JSON array of normalized entries). */
export function declaredInsertStatement(db: D1Database, repoId: string, workspaceId: string, pathsJson: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO workspace_paths (repo_id, kind, path, workspace_id)
       SELECT ?1, 'declared', j.value, ?2 FROM json_each(?3) j
        WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active')`,
    )
    .bind(repoId, workspaceId, pathsJson);
}

/**
 * Replaces an active workspace's declaration. The first statement is the
 * guarded row update (its `meta.changes` says whether it landed); the index
 * rows follow only when the row now carries exactly this declaration.
 * `agentId` restricts the update to that agent's own workspace.
 */
export function declarationReplaceStatements(
  db: D1Database,
  p: { repoId: string; workspaceId: string; pathsJson: string; expiresAt: number | null; now: number; agentId: string | null },
): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active'
                   AND w.intent_paths = ?3 AND w.intent_updated_at = ?4)`;
  return [
    db
      .prepare(
        `UPDATE workspaces SET intent_paths = ?3, intent_updated_at = ?4, intent_expires_at = ?5, updated_at = ?4
          WHERE repo_id = ?1 AND id = ?2 AND status = 'active' AND (?6 IS NULL OR agent_id = ?6)`,
      )
      .bind(p.repoId, p.workspaceId, p.pathsJson, p.now, p.expiresAt, p.agentId),
    db
      .prepare(`DELETE FROM workspace_paths WHERE repo_id = ?1 AND workspace_id = ?2 AND kind = 'declared' AND ${guard}`)
      .bind(p.repoId, p.workspaceId, p.pathsJson, p.now),
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_paths (repo_id, kind, path, workspace_id)
         SELECT ?1, 'declared', j.value, ?2 FROM json_each(?3) j WHERE ${guard}`,
      )
      .bind(p.repoId, p.workspaceId, p.pathsJson, p.now),
  ];
}

export interface ObservedWrite {
  repoId: string;
  workspaceId: string;
  pathsJson: string;
  baseSha: string;
  headSha: string;
  /**
   * The push event this set reflects: it lands only while that event still
   * holds the ref position in `repo_refs` (event time, then event id), so a
   * reconciliation finishing after a newer push of the same ref, equal event
   * times included, writes nothing. null: a seed by the service that created
   * the ref, which lands only before any push was reconciled and while the
   * ref position, if any, is still `headSha`.
   */
  event: { id: string; at: number } | null;
  now: number;
  truncated: string | null;
  /** Why changed paths are missing from the set (not merely collapsed); null when every one is covered. */
  omitted: string | null;
  prefixes: number;
}

/** Records an active workspace's observed set and swaps its observed index rows, unless a newer push already did. */
export function observedWriteStatements(db: D1Database, o: ObservedWrite): D1PreparedStatement[] {
  const eventAt = o.event?.at ?? 0;
  const guard = `EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active'
                   AND w.observed_event_at = ?3 AND w.observed_head_sha = ?4)`;
  const order = o.event
    ? `COALESCE(observed_event_at, 0) <= ?3
       AND EXISTS (SELECT 1 FROM repo_refs f WHERE f.repo_id = ?1 AND f.ref = workspaces.ref AND f.event_id = ?11)`
    : `?11 IS NULL AND observed_event_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM repo_refs f WHERE f.repo_id = ?1 AND f.ref = workspaces.ref AND f.sha != ?4)`;
  return [
    db
      .prepare(
        `UPDATE workspaces
            SET observed_paths = ?5, observed_base_sha = ?6, observed_head_sha = ?4, observed_event_at = ?3,
                observed_at = ?7, observed_truncated = ?8, observed_prefixes = ?9, observed_omitted = ?10
          WHERE repo_id = ?1 AND id = ?2 AND status = 'active' AND ${order}`,
      )
      .bind(o.repoId, o.workspaceId, eventAt, o.headSha, o.pathsJson, o.baseSha, o.now, o.truncated, o.prefixes, o.omitted, o.event?.id ?? null),
    db
      .prepare(`DELETE FROM workspace_paths WHERE repo_id = ?1 AND workspace_id = ?2 AND kind = 'observed' AND ${guard}`)
      .bind(o.repoId, o.workspaceId, eventAt, o.headSha),
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_paths (repo_id, kind, path, workspace_id)
         SELECT ?1, 'observed', j.value, ?2 FROM json_each(?5) j WHERE ${guard}`,
      )
      .bind(o.repoId, o.workspaceId, eventAt, o.headSha, o.pathsJson),
  ];
}

/**
 * Marks a just-registered active workspace's observed set as not computed
 * (an omission, so forecast and overlap disclose it) when the creating
 * service could not seed it. Lands only before any push was reconciled; the
 * next reconciled push replaces the set and its omission.
 */
export function observedSeedFailedStatement(db: D1Database, repoId: string, workspaceId: string, reason: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE workspaces SET observed_truncated = ?3, observed_omitted = ?3
        WHERE repo_id = ?1 AND id = ?2 AND status = 'active' AND observed_event_at IS NULL`,
    )
    .bind(repoId, workspaceId, reason);
}

/** Drops a workspace's index rows once it is no longer active (abandon). Code, refs and the row's history stay. */
export function workspaceSignalCleanup(db: D1Database, repoId: string, workspaceId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM workspace_paths WHERE repo_id = ?1 AND workspace_id = ?2
          AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active')`,
    )
    .bind(repoId, workspaceId);
}

/** Drops the index rows of a change set's workspace once it left active (merge). */
export function changeSignalCleanup(db: D1Database, repoId: string, changeSetId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM workspace_paths WHERE repo_id = ?1
          AND workspace_id IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status != 'active')`,
    )
    .bind(repoId, changeSetId);
}

/** For the repo DELETE batch. */
export function repoSignalCleanup(db: D1Database, repoId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM workspace_paths WHERE repo_id = ?').bind(repoId);
}
