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
  /**
   * How many dependents the condition may match. The read then returns up to
   * readMax edges per dependent: a dependent holds at most maxDirect edges
   * (enforced inside the pin write), so no dependent's edges are cut off by
   * another's in a shared read.
   */
  dependents?: number;
}

/**
 * The edges of the dependent workspaces chosen by `scope` (a condition on
 * `w`, the dependent workspace, with its parameters from ?2 on), each with
 * its source's state and its chain depth: one statement. The depth comes
 * from two covering-index hops below the source (the cap allows no more),
 * so the rows read follow the chain, never the repository's size.
 */
export function dependencyRowsStatement(db: D1Database, repoId: string, scope: DependencyScope, ...params: unknown[]): D1PreparedStatement {
  const limit = DEPENDENCY_LIMITS.readMax * Math.max(1, scope.dependents ?? 1);
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
        LIMIT ${limit}`,
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

export interface PreservationRefusal {
  status: 409;
  code: 'DEPENDENCY_NOT_PRESERVED';
  error: string;
  dependencies: DependencyView[];
}

const pinKey = (r: Pick<DependencyRow, 'id' | 'revision'>) => `${r.id}@${r.revision}`;

/**
 * A satisfied pin records that its source landed somewhere; the dependent's
 * own publication must still contain the pinned revision (another target
 * branch, or a base rewound after the landing, would not). Checks every
 * satisfied pin against the exact commit about to be published; a walk that
 * runs out of budget refuses too. `verified` names the pins (id and
 * revision) that were checked.
 */
export async function preservationRefusal(
  reader: CommitReader,
  rows: readonly DependencyRow[] | undefined,
  result: string,
): Promise<{ refusal: PreservationRefusal | null; verified: Set<string> }> {
  const verified = new Set<string>();
  for (const r of rows ?? []) {
    if (!r.satisfied_commit) continue;
    let ok = r.revision === result;
    let truncated = false;
    if (!ok) {
      const v = await isAncestor(reader, r.revision, result, { maxCommitReads: DEPENDENCY_LIMITS.maxCommitReads, concurrency: 4 });
      ok = v.ancestor;
      truncated = !v.ancestor && v.truncated;
    }
    if (!ok) {
      const route = `workspaces/${r.workspace_id}/dependencies/${r.id}`;
      const why = truncated ? 'could not be verified to contain' : 'does not contain';
      return {
        refusal: {
          status: 409,
          code: 'DEPENDENCY_NOT_PRESERVED',
          error: `workspace ${r.workspace_id} depends on workspace ${r.on_workspace} at ${r.revision}, which landed as ${r.satisfied_commit}, but this publication (${result}) ${why} it; update the change's base to include the landed source, or repin (POST ${route}/repin) or detach (DELETE ${route}) the dependency`,
          dependencies: [dependencyView(r)],
        },
        verified,
      };
    }
    verified.add(pinKey(r));
  }
  return { refusal: null, verified };
}

/** True when every satisfied pin in `rows` is one `verified` names (same edge, same revision). */
export function pinsVerified(rows: readonly DependencyRow[] | undefined, verified: ReadonlySet<string>): boolean {
  return (rows ?? []).every((r) => !r.satisfied_commit || verified.has(pinKey(r)));
}

// ---------------------------------------------------------------------------
// Landing a source
// ---------------------------------------------------------------------------
//
// Settling a landed source's pins is bounded per invocation and every
// obligation it creates is durable in D1 before anything acts on it:
//
//   - each page of edges is one batch that writes the edges' new state and,
//     first, a wake-pending mark (fenced_claims kind WAKE_KIND) for each edge
//     it settles, under the same landing/revision fences;
//   - the dependents' wake/resume work (kick a queued dependent's partition,
//     resume an open unqueued `auto` one) is derived from those marks, and a
//     mark is deleted only after its effect succeeded;
//   - pins or marks left past the budget, or effects that failed, are handed
//     to two independent owners (handOffSettlement): a `forge.dependency-settle`
//     message on the forge-events queue and a settlement intent in the
//     MergeLock of the landing's repo + target ref, whose alarm runs the same
//     settlement until nothing fenced to the landing remains.
//
// Any retry (queue redelivery or alarm) re-reads both unsettled pins and
// marks for the exact landing, so "no unsettled pin" is not mistaken for done.

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

/** fenced_claims kind of a dependent's wake-pending mark (subject: wakePrefix(landing) + dependent workspace id; identity: merge commit). */
export const WAKE_KIND = 'dep-wake';

/** One exact landing: the source change, its recorded merge time and merge commit. */
export interface LandingIdentity {
  repoId: string;
  changeSetId: string;
  mergedAt: number;
  mergeCommit: string;
}

/** The subject prefix of one landing's wake marks; its range ends just below `prefix` with the final '/' raised to '0'. */
export const wakePrefix = (id: Pick<LandingIdentity, 'repoId' | 'changeSetId' | 'mergedAt'>) => `${id.repoId}/${id.changeSetId}/${id.mergedAt}/`;
const wakeRange = (id: LandingIdentity): [string, string, number] => {
  const prefix = wakePrefix(id);
  return [prefix, `${prefix.slice(0, -1)}0`, prefix.length + 1];
};

/**
 * Part of the merged-record batch, before satisfyLandedStatement and under
 * the same predicate: a wake-pending mark for each dependent whose pin that
 * statement is about to satisfy.
 */
export function landedWakeMarksStatement(
  db: D1Database,
  repoId: string,
  changeSetId: string,
  pub: { mergeCommit: string; headSha: string },
  mergedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO fenced_claims (kind, subject, generation, identity, state, updated_at)
       SELECT '${WAKE_KIND}', ?6 || d.workspace_id, 0, ?3, 'open', ?4 FROM workspace_dependencies d
        WHERE d.repo_id = ?1 AND d.revision = ?5 AND d.satisfied_commit IS NULL AND d.broken_code IS NULL
          AND d.on_workspace IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'merged' AND w.merged_at = ?4)`,
    )
    .bind(repoId, changeSetId, pub.mergeCommit, mergedAt, pub.headSha, wakePrefix({ repoId, changeSetId, mergedAt }));
}

export interface LandedRow {
  /** `edge`: an unsettled pin (id, revision); `wake`: a wake-pending mark (id = its subject) with what wakes the dependent now. */
  kind: 'edge' | 'wake';
  id: string | null;
  revision: string | null;
  /** The queued dependent's partition to kick. */
  target_ref: string | null;
  /** The open, unqueued `auto` dependent to resume. */
  number: number | null;
}

/** The landed source workspace (merged by the change at `mergedAt`), parameters ?1 repo, ?2 change, ?3 mergedAt. */
const LANDED_SOURCE = `SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'merged' AND w.merged_at = ?3`;

const LANDED_EDGES = `SELECT 'edge' AS kind, d.id, d.revision, NULL AS target_ref, NULL AS number FROM workspace_dependencies d
  WHERE d.repo_id = ?1 AND d.on_workspace IN (${LANDED_SOURCE}) AND d.satisfied_commit IS NULL AND d.broken_code IS NULL
  ORDER BY d.id LIMIT __LIMIT__`;

const limited = (sql: string) => sql.replace('__LIMIT__', String(DEPENDENCY_LIMITS.readMax));

/** Wake marks one invocation acts on (one invocation's settlement budget); one more row is read to tell whether more remain. */
const wakeLimit = () => DEPENDENCY_LIMITS.readMax * SETTLE_LIMITS.maxPages;

/**
 * The landing's wake-pending marks and, for each, what wakes its dependent
 * now: the partition of its active queue entry, or its number when its
 * change is open `auto` and not queued (neither: nothing to wake). Fenced by
 * the landing: the subject range names the change and merge time, the
 * identity the merge commit. Parameters ?1 repo, ?4 merge commit, ?5/?6 the
 * subject range, ?7 where the workspace id starts in the subject.
 */
const WAKE_ROWS = () => `SELECT 'wake' AS kind, f.subject AS id, NULL AS revision,
    (SELECT q.target_ref FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1 LIMIT 1) AS target_ref,
    CASE WHEN c.state = 'open' AND c.merge_policy = 'auto'
          AND NOT EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) THEN c.number END AS number
  FROM fenced_claims f
  LEFT JOIN workspaces dw ON dw.repo_id = ?1 AND dw.id = substr(f.subject, ?7)
  LEFT JOIN change_sets c ON c.id = dw.change_set_id
  WHERE f.kind = '${WAKE_KIND}' AND f.subject >= ?5 AND f.subject < ?6 AND f.identity = ?4
  ORDER BY f.subject LIMIT ${wakeLimit() + 1}`;

/**
 * Last statement of the merged-record batch: the landed source's pins still
 * unsettled (their revision is not the landed head: an ancestry check
 * decides) and the wake marks the batch just recorded, each with its own
 * bound. Indexed by source and by mark subject; returns nothing in a repo
 * without pins.
 */
export function landedDependentsStatement(db: D1Database, repoId: string, changeSetId: string, mergedAt: number, mergeCommit: string): D1PreparedStatement {
  return db
    .prepare(`SELECT * FROM (${limited(LANDED_EDGES)}) UNION ALL SELECT * FROM (${WAKE_ROWS()})`)
    .bind(repoId, changeSetId, mergedAt, mergeCommit, ...wakeRange({ repoId, changeSetId, mergedAt, mergeCommit }));
}

/** The landing's wake marks with what wakes each dependent (see WAKE_ROWS). */
export function wakeStatement(db: D1Database, id: LandingIdentity): D1PreparedStatement {
  return db.prepare(`SELECT * FROM (${WAKE_ROWS()})`).bind(id.repoId, id.changeSetId, id.mergedAt, id.mergeCommit, ...wakeRange(id));
}

/** Deletes the given marks of the landing (after their effects succeeded). */
function clearWakeStatement(db: D1Database, id: LandingIdentity, subjects: readonly string[]): D1PreparedStatement {
  return db
    .prepare(`DELETE FROM fenced_claims WHERE kind = '${WAKE_KIND}' AND identity = ?1 AND subject IN (SELECT value FROM json_each(?2))`)
    .bind(id.mergeCommit, JSON.stringify(subjects));
}

/** Edge pages (readMax edges each) one landing, one continuation message or one alarm wakeup settles. */
export const SETTLE_LIMITS = {
  maxPages: 16,
};

/**
 * Continuation of a landing's pin settlement, on the `forge-events` queue.
 * It names the landing exactly (source change, recorded merge time and merge
 * commit) and the target ref whose MergeLock holds the intent; every read
 * and write it causes is fenced by that identity, so a replay finds nothing
 * pending and a message for another landing matches nothing.
 */
export const SETTLE_MESSAGE = 'forge.dependency-settle';

export interface SettleMessage extends LandingIdentity {
  type: typeof SETTLE_MESSAGE;
  /** The landing's target ref (its MergeLock owns the settlement intent); absent on messages sent before intents existed. */
  ref?: string;
}

export function isSettleMessage(body: unknown): body is SettleMessage {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    b.type === SETTLE_MESSAGE &&
    typeof b.repoId === 'string' &&
    typeof b.changeSetId === 'string' &&
    typeof b.mergedAt === 'number' &&
    Number.isSafeInteger(b.mergedAt) &&
    typeof b.mergeCommit === 'string' &&
    /^[0-9a-f]{40}$/.test(b.mergeCommit) &&
    (b.ref === undefined || (typeof b.ref === 'string' && b.ref.length > 0))
  );
}

export async function sendSettleContinuation(env: Pick<Env, 'EVENTS'>, msg: SettleMessage): Promise<void> {
  await env.EVENTS.send(msg);
}

/**
 * The MergeLock settlement intent (do/mergeLock.ts). `delayMs` is how long
 * the queue fast path has before the alarm runs the settlement itself;
 * `stepMs` re-arms an alarm that made progress with work left; failures
 * back off from `retryBaseMs` and stop after `maxFailures`.
 */
export const SETTLE_INTENT = {
  delayMs: 120_000,
  stepMs: 1_000,
  retryBaseMs: 10_000,
  retryMaxMs: 3_600_000,
  maxFailures: 8,
  /** Inline attempts of the intent write before only the queue send carries the hand-off. */
  writeAttempts: 3,
};

/** Writes (or refreshes) the landing's settlement intent in the MergeLock of its repo + target ref. */
export async function writeSettleIntent(env: Pick<Env, 'MERGE_LOCK'>, msg: SettleMessage & { ref: string }): Promise<void> {
  const stub = env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(`${msg.repoId}:${msg.ref}`));
  const res = await stub.fetch('https://merge-lock/settle-intent', { method: 'POST', body: JSON.stringify(msg) });
  const body = await res.text();
  if (!res.ok) throw new Error(`settlement intent refused (${res.status}): ${body.slice(0, 200)}`);
}

/**
 * Hands the rest of a landing's settlement to both owners: the intent
 * (bounded inline retries) and the queue continuation, which is sent
 * regardless as the fast path. Each owner alone completes the work; throws
 * only when neither could be recorded.
 */
export async function handOffSettlement(env: Pick<Env, 'EVENTS' | 'MERGE_LOCK'>, msg: SettleMessage): Promise<{ intent: boolean; queued: boolean }> {
  let intent = false;
  const ref = msg.ref;
  for (let attempt = 1; ref && !intent && attempt <= SETTLE_INTENT.writeAttempts; attempt++) {
    try {
      await writeSettleIntent(env, { ...msg, ref });
      intent = true;
    } catch (err) {
      console.warn(JSON.stringify({ settleIntentWriteFailed: { repo: msg.repoId, mergeCommit: msg.mergeCommit, attempt, error: String(err).slice(0, 200) } }));
    }
  }
  let queued = false;
  try {
    await sendSettleContinuation(env, msg);
    queued = true;
  } catch (err) {
    console.warn(JSON.stringify({ dependencySettleContinueFailed: { repo: msg.repoId, mergeCommit: msg.mergeCommit, error: String(err).slice(0, 200) } }));
  }
  if (!intent && !queued) throw new Error(`could not hand off the settlement of ${msg.mergeCommit}: neither the intent nor the continuation was recorded`);
  return { intent, queued };
}

/** The landed source of one exact landing, parameters ?1 repo, ?2 change, ?3 mergedAt, ?4 merge commit. */
const SETTLE_SOURCE = `SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'merged' AND w.merged_at = ?3
  AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?2 AND c.repo_id = ?1 AND c.state = 'merged' AND c.merge_commit = ?4 AND c.merged_at = ?3)`;

const SETTLE_EDGES = `SELECT 'edge' AS kind, d.id, d.revision, NULL AS target_ref, NULL AS number FROM workspace_dependencies d
  WHERE d.repo_id = ?1 AND d.on_workspace IN (${SETTLE_SOURCE}) AND d.satisfied_commit IS NULL AND d.broken_code IS NULL
  ORDER BY d.id LIMIT __LIMIT__`;

/** The next page of a landing's unsettled pins. */
export function settleEdgesStatement(db: D1Database, id: LandingIdentity): D1PreparedStatement {
  return db.prepare(limited(SETTLE_EDGES)).bind(id.repoId, id.changeSetId, id.mergedAt, id.mergeCommit);
}

/**
 * First statement of a page's settling batch: the wake marks of the page's
 * edges that the batch's fenced writes are about to settle (same landing
 * fence, same pinned revision, still unsettled), so a mark exists exactly
 * when its edge's settlement commits.
 */
function pageWakeMarksStatement(db: D1Database, id: LandingIdentity, edges: readonly LandedRow[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO fenced_claims (kind, subject, generation, identity, state, updated_at)
       SELECT '${WAKE_KIND}', ?5 || d.workspace_id, 0, ?4, 'open', ?6 FROM workspace_dependencies d
        WHERE d.repo_id = ?1 AND d.id IN (SELECT value FROM json_each(?7)) AND (d.id || '@' || d.revision) IN (SELECT value FROM json_each(?8))
          AND d.satisfied_commit IS NULL AND d.broken_code IS NULL AND d.on_workspace IN (${SETTLE_SOURCE})`,
    )
    .bind(
      id.repoId,
      id.changeSetId,
      id.mergedAt,
      id.mergeCommit,
      wakePrefix(id),
      now,
      JSON.stringify(edges.map((r) => r.id)),
      JSON.stringify(edges.map((r) => `${r.id}@${r.revision}`)),
    );
}

interface SettledPages {
  /** Edges this invocation settled (its guarded writes changed them). */
  settled: string[];
  /** The page budget ran out with unsettled pins still listed. */
  left: boolean;
  /** The landing's wake marks as read after the last settling batch (or with the first page when nothing was settled). */
  wake: LandedRow[];
}

/**
 * Settles `first`'s edges and the pages after them, at most
 * SETTLE_LIMITS.maxPages pages of readMax edges: satisfied only when the
 * pinned revision is an ancestor of the landed commit, broken NOT_PRESERVED
 * otherwise; an ancestry walk that runs out of budget is NOT_VERIFIED, never
 * satisfied. Every write is fenced by the landing's identity and the pin's
 * revision and unsettled state, so a concurrent or replayed settlement
 * changes nothing twice; each batch records the settled edges' wake marks
 * first, and the last one re-reads the landing's marks.
 */
async function settlePages(db: D1Database, reader: CommitReader | null, id: LandingIdentity, first: readonly LandedRow[]): Promise<SettledPages> {
  const verdicts = new Map<string, { ancestor: boolean; truncated: boolean }>();
  const seen = new Set<string>();
  const settled: string[] = [];
  let wake = first.filter((r) => r.kind === 'wake' && r.id);
  let wakeCurrent = true;
  let edges = first.filter((r) => r.kind === 'edge' && r.id && r.revision);
  for (let page = 0; edges.length > 0 && page < SETTLE_LIMITS.maxPages; page++) {
    const now = Date.now();
    const writes: D1PreparedStatement[] = [];
    for (const r of edges) {
      seen.add(r.id!);
      let verdict = verdicts.get(r.revision!);
      if (!verdict) {
        verdict = { ancestor: false, truncated: true };
        if (reader) {
          try {
            verdict = await isAncestor(reader, r.revision!, id.mergeCommit, { maxCommitReads: DEPENDENCY_LIMITS.maxCommitReads, concurrency: 4 });
          } catch (err) {
            console.warn(JSON.stringify({ dependencySettle: { repo: id.repoId, edge: r.id, error: String(err).slice(0, 200) } }));
          }
        }
        verdicts.set(r.revision!, verdict);
      }
      const fence = `repo_id = ?1 AND id = ?2 AND satisfied_commit IS NULL AND broken_code IS NULL AND revision = ?5 AND on_workspace IN (${SETTLE_SOURCE.replaceAll('?2', '?6').replaceAll('?3', '?7').replaceAll('?4', '?8')})`;
      if (verdict.ancestor) {
        writes.push(
          db
            .prepare(`UPDATE workspace_dependencies SET satisfied_commit = ?3, satisfied_at = ?4, updated_at = ?4 WHERE ${fence}`)
            .bind(id.repoId, r.id, id.mergeCommit, now, r.revision, id.changeSetId, id.mergedAt, id.mergeCommit),
        );
      } else {
        const [code, message] = verdict.truncated
          ? ['NOT_VERIFIED', `could not verify that the landed commit ${id.mergeCommit} contains the pinned ${r.revision}`]
          : ['NOT_PRESERVED', `the source landed as ${id.mergeCommit}, which does not contain the pinned ${r.revision}`];
        writes.push(
          db
            .prepare(`UPDATE workspace_dependencies SET broken_code = ?3, broken_reason = ?4, updated_at = ?9 WHERE ${fence}`)
            .bind(id.repoId, r.id, code, message, r.revision, id.changeSetId, id.mergedAt, id.mergeCommit, now),
        );
      }
    }
    const full = edges.length >= DEPENDENCY_LIMITS.readMax;
    const last = !full || page === SETTLE_LIMITS.maxPages - 1;
    const batch = [pageWakeMarksStatement(db, id, edges, now), ...writes];
    // The next page rides on the settling batch: the settled edges no longer match, so it returns the ones after them.
    if (full) batch.push(settleEdgesStatement(db, id));
    if (last) batch.push(wakeStatement(db, id));
    const out = await db.batch(batch);
    edges.forEach((r, i) => {
      if (out[i + 1]?.meta.changes) settled.push(r.id!);
    });
    wakeCurrent = last;
    if (last) wake = (out[out.length - 1]?.results as LandedRow[] | undefined) ?? [];
    if (!full) {
      edges = [];
      break;
    }
    edges = ((out[1 + writes.length]?.results as LandedRow[] | undefined) ?? []).filter((r) => r.id && r.revision && !seen.has(r.id));
  }
  // Only when the last page was exactly full and nothing followed it.
  if (!wakeCurrent) wake = ((await wakeStatement(db, id).all<LandedRow>()).results ?? []) as LandedRow[];
  return { settled, left: edges.length > 0, wake };
}

export interface WakeEffects {
  kick(ref: string, reason: string): Promise<void>;
  /** Resumes open `auto` dependents whose pins may now all be satisfied (their own merge path re-checks every gate); resolves when done. */
  resume(numbers: number[]): Promise<void>;
}

export interface WakeResult {
  kicked: number;
  resumed: number;
  /** Marks deleted after their effect succeeded (or with nothing left to wake). */
  cleared: number;
  /** An effect or the mark deletion failed: those marks stay for the next owner. */
  failed: boolean;
  /** More marks remain than one invocation acts on. */
  more: boolean;
}

/**
 * Acts on (at most wakeLimit) wake marks: one kick per partition of queued
 * dependents, resumes of open unqueued `auto` dependents in pages of
 * readMax, then one deletion of the marks whose effect succeeded (and of
 * those with nothing to wake). A failed effect keeps its marks.
 */
async function wakeDependents(db: D1Database, id: LandingIdentity, rows: readonly LandedRow[], s: WakeEffects, reason: string): Promise<WakeResult> {
  const r: WakeResult = { kicked: 0, resumed: 0, cleared: 0, failed: false, more: rows.length > wakeLimit() };
  const marks = rows.slice(0, wakeLimit());
  if (marks.length === 0) return r;
  const done: string[] = [];
  const byRef = new Map<string, string[]>();
  const autos: LandedRow[] = [];
  for (const m of marks) {
    if (m.target_ref) byRef.set(m.target_ref, [...(byRef.get(m.target_ref) ?? []), m.id!]);
    else if (m.number !== null) autos.push(m);
    else done.push(m.id!);
  }
  for (const [ref, subjects] of byRef) {
    try {
      await s.kick(ref, reason);
      r.kicked++;
      done.push(...subjects);
    } catch (err) {
      r.failed = true;
      console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
    }
  }
  for (let i = 0; i < autos.length; i += DEPENDENCY_LIMITS.readMax) {
    const page = autos.slice(i, i + DEPENDENCY_LIMITS.readMax);
    try {
      await s.resume(page.map((m) => m.number!));
      r.resumed += page.length;
      done.push(...page.map((m) => m.id!));
    } catch (err) {
      r.failed = true;
      console.warn(JSON.stringify({ dependencyResumeFailed: String(err).slice(0, 200) }));
    }
  }
  if (done.length > 0) {
    try {
      await clearWakeStatement(db, id, done).run();
      r.cleared = done.length;
    } catch (err) {
      r.failed = true;
      console.warn(JSON.stringify({ dependencyWakeClearFailed: { repo: id.repoId, error: String(err).slice(0, 200) } }));
    }
  }
  return r;
}

export interface LandedSettlement extends WakeEffects {
  /** The landed change and the time it was recorded merged (identifies the source workspace). */
  source: { changeSetId: string; mergedAt: number };
  /** The landing's target ref (its MergeLock owns the settlement intent). */
  ref: string;
  /** Records the rest with both owners (handOffSettlement). */
  handOff(msg: SettleMessage): Promise<unknown>;
  /** Where the wake phase runs after the response (waitUntil); inline when absent. */
  defer?(p: Promise<unknown>): void;
}

/**
 * After a source landed (the merged-record batch committed): settles its
 * remaining pins in bounded pages, hands the rest to both owners at once
 * when the budget leaves pins unsettled, then wakes the dependents from
 * their marks (deferred when `defer` is given) and hands off anything that
 * wake could not finish. Costs nothing when the batch found no pins or
 * marks. A failed hand-off is logged: the landing itself already happened.
 */
export async function settleLanded(
  db: D1Database,
  reader: CommitReader | null,
  repoId: string,
  rows: readonly LandedRow[] | undefined,
  mergeCommit: string,
  s: LandedSettlement,
): Promise<void> {
  if (!rows || rows.length === 0) return;
  const id: LandingIdentity = { repoId, changeSetId: s.source.changeSetId, mergedAt: s.source.mergedAt, mergeCommit };
  const msg: SettleMessage = { type: SETTLE_MESSAGE, ...id, ref: s.ref };
  const handOff = async (why: string) => {
    console.log(JSON.stringify({ dependencySettleContinues: { repo: repoId, change: id.changeSetId, mergeCommit, why } }));
    await s.handOff(msg).catch((err: unknown) => {
      console.warn(JSON.stringify({ dependencySettleHandOffFailed: { repo: repoId, mergeCommit, error: String(err).slice(0, 200) } }));
    });
  };
  const pages = await settlePages(db, reader, id, rows);
  if (pages.left) await handOff('pins');
  const wake = async () => {
    const w = await wakeDependents(db, id, pages.wake, s, 'dependency-landed');
    if (!pages.left && (w.failed || w.more)) await handOff(w.failed ? 'wake-failed' : 'wake-marks');
  };
  if (s.defer) s.defer(wake());
  else await wake();
}

export interface SettleContinuationResult {
  settled: number;
  continued: boolean;
  kicked: number;
  resumed: number;
  cleared: number;
  /** Fenced work is left for another invocation (pins past the budget, marks past the limit, or failed effects). */
  remaining: boolean;
  failed: boolean;
}

export const emptySettleResult = (): SettleContinuationResult => ({
  settled: 0,
  continued: false,
  kicked: 0,
  resumed: 0,
  cleared: 0,
  remaining: false,
  failed: false,
});

/**
 * One continuation (queue message or MergeLock alarm): the same bounded
 * pages as the landing from `first` (the first unsettled page and the
 * landing's marks, both fenced by the landing identity), then the wake work
 * of every pending mark, then, only when that work all succeeded and made
 * progress with more left, `continueLater` (absent for the alarm, which
 * re-arms itself from `remaining`). A replay or another landing's identity
 * reads nothing and does nothing.
 */
export async function settleContinuation(
  db: D1Database,
  reader: CommitReader | null,
  msg: SettleMessage,
  first: readonly LandedRow[],
  s: WakeEffects & { continueLater?(msg: SettleMessage): Promise<unknown> },
): Promise<SettleContinuationResult> {
  const id: LandingIdentity = { repoId: msg.repoId, changeSetId: msg.changeSetId, mergedAt: msg.mergedAt, mergeCommit: msg.mergeCommit };
  const result = emptySettleResult();
  if (first.length === 0) return result;
  const pages = await settlePages(db, reader, id, first);
  const w = await wakeDependents(db, id, pages.wake, s, 'dependency-settled');
  Object.assign(result, { settled: pages.settled.length, kicked: w.kicked, resumed: w.resumed, cleared: w.cleared, failed: w.failed });
  result.remaining = pages.left || w.more || w.failed;
  const progressed = pages.settled.length > 0 || w.cleared > 0;
  if ((pages.left || w.more) && !w.failed && progressed && s.continueLater) {
    console.log(JSON.stringify({ dependencySettleContinues: { repo: id.repoId, change: id.changeSetId, mergeCommit: id.mergeCommit, why: pages.left ? 'pins' : 'wake-marks' } }));
    await s.continueLater({ ...msg, type: SETTLE_MESSAGE });
    result.continued = true;
  }
  return result;
}

/**
 * Train ejection of a source for a reason that sticks to its head (a merge
 * conflict with the base or a failed required check): the pins on exactly
 * that head of its workspace break with SOURCE_EJECTED, which repin (to the
 * same or a new revision) or detach recovers. Other pins are untouched.
 */
export function ejectedSourceStatement(
  db: D1Database,
  repoId: string,
  changeSetId: string,
  headSha: string,
  cause: string,
  now: number,
  ejected: { queueId: string; generation: number },
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE workspace_dependencies SET broken_code = 'SOURCE_EJECTED', broken_reason = ?4, updated_at = ?5
        WHERE repo_id = ?1 AND revision = ?3 AND satisfied_commit IS NULL AND broken_code IS NULL
          AND on_workspace IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2 AND w.status = 'active')
          AND EXISTS (SELECT 1 FROM merge_queue q WHERE q.id = ?6 AND q.generation = ?7 AND q.state = 'ejected' AND q.reason_code = ?8)`,
    )
    .bind(
      repoId,
      changeSetId,
      headSha,
      `the source's change was ejected from the merge train at ${headSha} (${cause}); repin once it is fixed, or detach`,
      now,
      ejected.queueId,
      ejected.generation,
      cause,
    );
}
