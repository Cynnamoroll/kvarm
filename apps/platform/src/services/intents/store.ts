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
  /** Push event time; a reconciliation never replaces one from a newer event. */
  eventAt: number;
  now: number;
  truncated: string | null;
  prefixes: number;
}

/** Records an active workspace's observed set and swaps its observed index rows, unless a newer push already did. */
export function observedWriteStatements(db: D1Database, o: ObservedWrite): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active'
                   AND w.observed_event_at = ?3 AND w.observed_head_sha = ?4)`;
  return [
    db
      .prepare(
        `UPDATE workspaces
            SET observed_paths = ?5, observed_base_sha = ?6, observed_head_sha = ?4, observed_event_at = ?3,
                observed_at = ?7, observed_truncated = ?8, observed_prefixes = ?9
          WHERE repo_id = ?1 AND id = ?2 AND status = 'active' AND COALESCE(observed_event_at, 0) <= ?3`,
      )
      .bind(o.repoId, o.workspaceId, o.eventAt, o.headSha, o.pathsJson, o.baseSha, o.now, o.truncated, o.prefixes),
    db
      .prepare(`DELETE FROM workspace_paths WHERE repo_id = ?1 AND workspace_id = ?2 AND kind = 'observed' AND ${guard}`)
      .bind(o.repoId, o.workspaceId, o.eventAt, o.headSha),
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_paths (repo_id, kind, path, workspace_id)
         SELECT ?1, 'observed', j.value, ?2 FROM json_each(?5) j WHERE ${guard}`,
      )
      .bind(o.repoId, o.workspaceId, o.eventAt, o.headSha, o.pathsJson),
  ];
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
