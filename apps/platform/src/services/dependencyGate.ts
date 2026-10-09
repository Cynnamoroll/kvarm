/**
 * Pinned draft dependencies as a publication gate (architecture §11.3).
 *
 * A dependency edge says: workspace `workspace_id` builds on workspace
 * `on_workspace` at exactly `revision`. Its state is derived on every read
 * from the source workspace and from what was recorded when the source
 * landed; the platform never rewrites the pin, the dependent's ref or its
 * base:
 *
 *   satisfied  the source landed and the landed commit contains `revision`
 *              (recorded with the merge, or by the ancestry check after it)
 *   broken     the source was abandoned or deleted, or it landed without
 *              `revision` in the landed commit's ancestry (NOT_PRESERVED)
 *   stale      the source moved past the pinned revision (repin or detach)
 *   active     the source is live at the pinned revision (pending: it has
 *              not landed yet)
 *
 * A change whose workspace has a stale or broken pin is not admitted to the
 * merge queue; any unresolved pin (active included) blocks publication, so
 * a dependent always lands after its source. This module is shared by
 * services/changes.ts (explicit and auto merge), services/queue.ts (enqueue,
 * every train pass and the publication revalidation) and
 * services/dependencies.ts (the edge routes); it imports no service so it
 * can sit below all of them.
 */

import { isAncestor, type CommitReader } from '@forge/gitops';

export const DEPENDENCY_LIMITS = {
  /** Workspaces in the longest chain through any edge (the dependent included). */
  maxDepth: 4,
  /** Direct dependencies of one workspace. */
  maxDirect: 8,
  /** Edges one read returns (list, queue status, publication gate). */
  readMax: 64,
  /** Paths a chain walk returns (the depth cap bounds a chain far below this). */
  walkMax: 64,
  /** Commits the post-landing ancestry check may read. */
  maxCommitReads: 2000,
};

export type DependencyState = 'active' | 'stale' | 'broken' | 'satisfied';

const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * The source workspace's head as edge `d` sees it. While the source is
 * active: the pinned revision, which the pin confirmed live, until a push
 * event newer than the pin (or its last repin) records another position;
 * push events trail the push, so the recorded position alone would report a
 * fresh pin as stale. Once the source ends: the head it ended at.
 */
export function sourceHeadSql(s: string, f: string, d: string): string {
  return `(CASE WHEN ${s}.status != 'active' THEN ${s}.head_sha
                WHEN ${f}.event_at > COALESCE(${d}.repinned_at, ${d}.created_at)
                  THEN COALESCE(NULLIF(${f}.sha, '${ZERO_SHA}'), ${s}.head_sha, ${s}.base_sha)
                ELSE ${d}.revision END)`;
}

export interface DependencyRow {
  id: string;
  workspace_id: string;
  on_workspace: string;
  revision: string;
  created_login: string | null;
  agent_id: string | null;
  created_at: number;
  updated_at: number;
  repinned_at: number | null;
  satisfied_commit: string | null;
  satisfied_at: number | null;
  broken_code: string | null;
  broken_reason: string | null;
  /** The dependent's linked change set. */
  ws_change_set_id: string | null;
  s_status: string | null;
  s_head: string | null;
  depth: number | null;
}

export interface DependencyView {
  id: string;
  workspaceId: string;
  onWorkspace: string;
  revision: string;
  state: DependencyState;
  /** Workspaces in the longest chain from the dependent down through this edge. */
  depth: number;
  /** The source workspace's recorded head (null when it no longer exists). */
  sourceHead: string | null;
  sourceStatus: string | null;
  /** The landed commit that contains the pinned revision, once satisfied. */
  satisfiedBy: string | null;
  reason: { code: string; message: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  repinnedAt: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function edgeState(r: Pick<DependencyRow, 'revision' | 'on_workspace' | 'satisfied_commit' | 'broken_code' | 'broken_reason' | 's_status' | 's_head'>): {
  state: DependencyState;
  reason: { code: string; message: string } | null;
} {
  if (r.satisfied_commit) return { state: 'satisfied', reason: null };
  if (r.broken_code) return { state: 'broken', reason: { code: r.broken_code, message: r.broken_reason ?? r.broken_code } };
  if (!r.s_status) return { state: 'broken', reason: { code: 'SOURCE_MISSING', message: `workspace ${r.on_workspace} no longer exists` } };
  if (r.s_status === 'abandoned') return { state: 'broken', reason: { code: 'SOURCE_ABANDONED', message: `workspace ${r.on_workspace} was abandoned` } };
  if (r.s_status === 'active' && r.s_head === r.revision) return { state: 'active', reason: null };
  return {
    state: 'stale',
    reason: { code: 'SOURCE_MOVED', message: `workspace ${r.on_workspace} moved from the pinned ${r.revision} to ${r.s_head ?? 'an unknown head'}` },
  };
}

export function dependencyView(r: DependencyRow): DependencyView {
  const { state, reason } = edgeState(r);
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    onWorkspace: r.on_workspace,
    revision: r.revision,
    state,
    depth: r.depth ?? 2,
    sourceHead: r.s_head,
    sourceStatus: r.s_status,
    satisfiedBy: r.satisfied_commit,
    reason,
    createdBy: r.created_login,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    repinnedAt: iso(r.repinned_at),
  };
}

/**
 * Which dependents' edges to read: a condition on `w`, the dependent
 * workspace (parameters from ?2 on). `byChange` drives the read from the
 * change-set index, for conditions on `w.change_set_id`.
 */
export interface DependencyScope {
  where: string;
  byChange?: boolean;
}

/**
 * The edges of the dependent workspaces chosen by `scope` (a condition on
 * `w`, the dependent workspace, with its parameters from ?2 on), each with
 * its source's state and its chain depth: one statement. The depth comes
 * from two covering-index hops below the source (the cap allows no more),
 * so the rows read follow the chain, never the repository's size.
 */
export function dependencyRowsStatement(db: D1Database, repoId: string, scope: DependencyScope, ...params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT d.id, d.workspace_id, d.on_workspace, d.revision, d.created_login, d.agent_id, d.created_at, d.updated_at,
              d.repinned_at, d.satisfied_commit, d.satisfied_at, d.broken_code, d.broken_reason, w.change_set_id AS ws_change_set_id,
              s.status AS s_status, ${sourceHeadSql('s', 'f', 'd')} AS s_head,
              2 + COALESCE((SELECT MAX(1 + (x2.on_workspace IS NOT NULL))
                              FROM workspace_dependencies x1
                              LEFT JOIN workspace_dependencies x2 ON x2.repo_id = x1.repo_id AND x2.workspace_id = x1.on_workspace
                             WHERE x1.repo_id = d.repo_id AND x1.workspace_id = d.on_workspace), 0) AS depth
         FROM workspaces w ${scope.byChange ? 'INDEXED BY idx_ws_change' : ''}
         CROSS JOIN workspace_dependencies d INDEXED BY idx_dep_edge ON d.repo_id = w.repo_id AND d.workspace_id = w.id
         LEFT JOIN workspaces s ON s.repo_id = d.repo_id AND s.id = d.on_workspace
         LEFT JOIN repo_refs f ON f.repo_id = s.repo_id AND f.ref = s.ref
        WHERE w.repo_id = ?1 AND (${scope.where})
        ORDER BY d.created_at, d.id
        LIMIT ${DEPENDENCY_LIMITS.readMax}`,
    )
    .bind(repoId, ...params);
}

/** The pins of the workspace linked to change set `changeSetId`. */
export function changeDependenciesStatement(db: D1Database, repoId: string, changeSetId: string): D1PreparedStatement {
  return dependencyRowsStatement(db, repoId, { where: 'w.change_set_id = ?2', byChange: true }, changeSetId);
}

/** The pins of the workspace linked to change `number`. */
export function changeNumberDependenciesStatement(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return dependencyRowsStatement(
    db,
    repoId,
    { where: 'w.change_set_id = (SELECT c.id FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2)', byChange: true },
    number,
  );
}

/**
 * SQL condition, for a guarded write on change `c`: the change's workspace
 * has no stale or broken pin (enqueue admission).
 */
export function noBlockedPinCondition(c: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM workspaces dw INDEXED BY idx_ws_change
      CROSS JOIN workspace_dependencies dd INDEXED BY idx_dep_edge ON dd.repo_id = dw.repo_id AND dd.workspace_id = dw.id
      LEFT JOIN workspaces ds ON ds.repo_id = dd.repo_id AND ds.id = dd.on_workspace
      LEFT JOIN repo_refs df ON df.repo_id = ds.repo_id AND df.ref = ds.ref
     WHERE dw.change_set_id = ${c}.id AND dw.repo_id = ${c}.repo_id AND dd.satisfied_commit IS NULL
       AND (dd.broken_code IS NOT NULL OR ds.id IS NULL OR ds.status != 'active' OR ${sourceHeadSql('ds', 'df', 'dd')} IS NOT dd.revision))`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export type DependencyGateMode = 'enqueue' | 'publish';

export interface DependencyBlock {
  status: 409;
  code: 'DEPENDENCY_BROKEN' | 'DEPENDENCY_STALE' | 'DEPENDENCY_PENDING';
  error: string;
  dependencies: DependencyView[];
}

const RANK: Record<DependencyState, number> = { broken: 3, stale: 2, active: 1, satisfied: 0 };

/**
 * Why the pins keep a change from the queue (`enqueue`: stale or broken) or
 * from publication (`publish`: any unsatisfied pin), else null. The error
 * names the source workspace and the explicit recovery.
 */
export function dependencyBlock(edges: DependencyView[], mode: DependencyGateMode): DependencyBlock | null {
  const blocking = edges.filter((d) => d.state === 'broken' || d.state === 'stale' || (mode === 'publish' && d.state === 'active'));
  if (blocking.length === 0) return null;
  const worst = blocking.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a));
  const at = `workspace ${worst.workspaceId} depends on workspace ${worst.onWorkspace} at ${worst.revision}`;
  const route = `workspaces/${worst.workspaceId}/dependencies/${worst.id}`;
  if (worst.state === 'broken') {
    return {
      status: 409,
      code: 'DEPENDENCY_BROKEN',
      error: `${at}, which is broken (${worst.reason?.message ?? 'unavailable'}); repin it to a live workspace (POST ${route}/repin {onWorkspace, revision}) or detach it (DELETE ${route})`,
      dependencies: blocking,
    };
  }
  if (worst.state === 'stale') {
    return {
      status: 409,
      code: 'DEPENDENCY_STALE',
      error: `${at}, which is stale (${worst.reason?.message ?? 'the source moved'}); repin it to the source's current revision${worst.sourceHead ? ` ${worst.sourceHead}` : ''} (POST ${route}/repin {revision}) or detach it (DELETE ${route})`,
      dependencies: blocking,
    };
  }
  return {
    status: 409,
    code: 'DEPENDENCY_PENDING',
    error: `${at}, which has not landed yet; merge or enqueue workspace ${worst.onWorkspace}'s change first (an enqueued dependent waits for it in the train), or detach the dependency (DELETE ${route})`,
    dependencies: blocking,
  };
}

export function blockFromRows(rows: readonly DependencyRow[] | undefined, mode: DependencyGateMode): DependencyBlock | null {
  if (!rows || rows.length === 0) return null;
  return dependencyBlock(rows.map(dependencyView), mode);
}

// ---------------------------------------------------------------------------
// Landing a source
// ---------------------------------------------------------------------------

/**
 * Part of the merged-record batch: once the change is recorded merged and
 * its workspace followed, every pin of exactly the landed head is satisfied
 * by the landed commit (it is that commit or one of its parents).
 */
export function satisfyLandedStatement(
  db: D1Database,
  repoId: string,
  changeSetId: string,
  pub: { mergeCommit: string; headSha: string },
  mergedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE workspace_dependencies SET satisfied_commit = ?3, satisfied_at = ?4, updated_at = ?4
        WHERE repo_id = ?1 AND revision = ?5 AND satisfied_commit IS NULL AND broken_code IS NULL
          AND on_workspace IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'merged' AND w.merged_at = ?4)`,
    )
    .bind(repoId, changeSetId, pub.mergeCommit, mergedAt, pub.headSha);
}

export interface LandedRow {
  kind: 'edge' | 'kick';
  id: string | null;
  revision: string | null;
  target_ref: string | null;
}

/**
 * Last statement of the merged-record batch: the landed source's pins still
 * unsettled (their revision is not the landed head: an ancestry check
 * decides) and the queue partitions of its queued dependents (to kick).
 * Indexed by source; returns nothing in a repo without pins.
 */
export function landedDependentsStatement(db: D1Database, repoId: string, changeSetId: string, mergedAt: number): D1PreparedStatement {
  const source = `SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'merged' AND w.merged_at = ?3`;
  return db
    .prepare(
      `SELECT 'edge' AS kind, d.id, d.revision, NULL AS target_ref FROM workspace_dependencies d
        WHERE d.repo_id = ?1 AND d.on_workspace IN (${source}) AND d.satisfied_commit IS NULL AND d.broken_code IS NULL
       UNION ALL
       SELECT DISTINCT 'kick' AS kind, NULL, NULL, q.target_ref FROM workspace_dependencies d
         JOIN workspaces dw ON dw.repo_id = d.repo_id AND dw.id = d.workspace_id
         JOIN merge_queue q ON q.change_set_id = dw.change_set_id AND q.active = 1
        WHERE d.repo_id = ?1 AND d.on_workspace IN (${source})
       LIMIT ${DEPENDENCY_LIMITS.readMax}`,
    )
    .bind(repoId, changeSetId, mergedAt);
}

/**
 * After a source landed: settles its remaining pins by ancestry (satisfied
 * only when the pinned revision is an ancestor of the landed commit, broken
 * NOT_PRESERVED otherwise; an ancestry walk that runs out of budget is
 * NOT_VERIFIED, never satisfied) and kicks the partitions where dependents
 * wait. Costs nothing when the batch found no pins.
 */
export async function settleLanded(
  db: D1Database,
  reader: CommitReader | null,
  repoId: string,
  rows: readonly LandedRow[] | undefined,
  mergeCommit: string,
  kick: (ref: string, reason: string) => Promise<void>,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const now = Date.now();
  const writes: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (r.kind !== 'edge' || !r.id || !r.revision) continue;
    let verdict: { ancestor: boolean; truncated: boolean } = { ancestor: false, truncated: true };
    if (reader) {
      try {
        verdict = await isAncestor(reader, r.revision, mergeCommit, { maxCommitReads: DEPENDENCY_LIMITS.maxCommitReads, concurrency: 4 });
      } catch (err) {
        console.warn(JSON.stringify({ dependencySettle: { repo: repoId, edge: r.id, error: String(err).slice(0, 200) } }));
      }
    }
    if (verdict.ancestor) {
      writes.push(
        db
          .prepare(
            `UPDATE workspace_dependencies SET satisfied_commit = ?3, satisfied_at = ?4, updated_at = ?4
              WHERE repo_id = ?1 AND id = ?2 AND satisfied_commit IS NULL AND broken_code IS NULL AND revision = ?5`,
          )
          .bind(repoId, r.id, mergeCommit, now, r.revision),
      );
    } else {
      const [code, message] = verdict.truncated
        ? ['NOT_VERIFIED', `could not verify that the landed commit ${mergeCommit} contains the pinned ${r.revision}`]
        : ['NOT_PRESERVED', `the source landed as ${mergeCommit}, which does not contain the pinned ${r.revision}`];
      writes.push(
        db
          .prepare(
            `UPDATE workspace_dependencies SET broken_code = ?3, broken_reason = ?4, updated_at = ?5
              WHERE repo_id = ?1 AND id = ?2 AND satisfied_commit IS NULL AND broken_code IS NULL AND revision = ?6`,
          )
          .bind(repoId, r.id, code, message, now, r.revision),
      );
    }
  }
  if (writes.length > 0) await db.batch(writes);
  const refs = [...new Set(rows.filter((r) => r.kind === 'kick' && r.target_ref).map((r) => r.target_ref!))];
  for (const ref of refs) {
    await kick(ref, 'dependency-landed').catch((err: unknown) => {
      console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
    });
  }
}
