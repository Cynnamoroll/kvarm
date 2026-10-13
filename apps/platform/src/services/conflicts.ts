/**
 * Conflict state of change sets and the `resolve-conflict` agent tasks it
 * dispatches (architecture §3 resolve.ts, the stage after the deterministic
 * rules in services/merge.ts).
 *
 * A live change whose head conflicts with its base tip after resolution is
 * `conflicted`: `change_sets.conflicts` stores what was found (head, base
 * tip, conflicting paths) and one live task per change carries the same
 * identity for an agent. The state follows every evaluation of the change's
 * current head (detail and mergeability reads, creation, push processing,
 * merge attempts and the merge train) but is written only when it changes:
 * open -> conflicted, conflicted -> open, or a conflicted change seen at a
 * new head or base tip. A steady read writes nothing.
 *
 * Tasks are retired (`obsolete`) once the change is no longer conflicted:
 * the conflict cleared, or the change closed or merged. A task an agent
 * completed (services/tasks.ts) stays `completed`. Each new task records a
 * `kvarm.task.created` event for external agent runners.
 */

import type { MergeConflict, MergeStatus } from './merge';

export const CONFLICT_LIMITS = {
  /** Conflicts stored and listed per change. */
  conflictsMax: 100,
};

export const RESOLVE_CONFLICT = 'resolve-conflict';

export interface ConflictView {
  path: string;
  kind: string;
  needsRegeneration?: true;
}

/** What `change_sets.conflicts` and a resolve-conflict task's payload record. */
export interface ConflictRecord {
  headSha: string;
  baseSha: string;
  conflicts: ConflictView[];
  truncated?: true;
}

/** The evaluation of a change's head against a base tip, as merge planning reports it. */
export interface ConflictEvaluation {
  status: MergeStatus;
  headSha: string;
  targetSha: string;
  conflicts: readonly MergeConflict[];
}

export function conflictViews(conflicts: readonly MergeConflict[]): { conflicts: ConflictView[]; truncated: boolean } {
  const list = conflicts
    .slice(0, CONFLICT_LIMITS.conflictsMax)
    .map((c) => ({ path: c.path, kind: c.kind, ...(c.needsRegeneration ? { needsRegeneration: true as const } : {}) }));
  return { conflicts: list, truncated: conflicts.length > list.length };
}

export function conflictRecord(m: ConflictEvaluation): ConflictRecord {
  const v = conflictViews(m.conflicts);
  return { headSha: m.headSha, baseSha: m.targetSha, conflicts: v.conflicts, ...(v.truncated ? { truncated: true as const } : {}) };
}

export function parseConflictRecord(json: string | null): ConflictRecord | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<ConflictRecord>;
    if (typeof v.headSha !== 'string' || typeof v.baseSha !== 'string' || !Array.isArray(v.conflicts)) return null;
    return v as ConflictRecord;
  } catch {
    return null;
  }
}

export interface ConflictSubject {
  id: string;
  state: string;
  head_sha: string | null;
  conflicts: string | null;
}

export type ConflictTransition = { kind: 'mark'; record: ConflictRecord } | { kind: 'clear' };

/**
 * The write an evaluation of the change's recorded head calls for, or null
 * (nothing changed, the change is not live, or the evaluation was for
 * another head or was inconclusive).
 */
export function conflictTransition(row: ConflictSubject, m: ConflictEvaluation): ConflictTransition | null {
  if (row.state !== 'open' && row.state !== 'conflicted') return null;
  if (!row.head_sha || m.headSha !== row.head_sha) return null;
  if (m.status === 'conflicts') {
    const record = conflictRecord(m);
    if (row.state === 'conflicted') {
      const stored = parseConflictRecord(row.conflicts);
      if (stored && stored.headSha === record.headSha && stored.baseSha === record.baseSha) return null;
    }
    return { kind: 'mark', record };
  }
  if (row.state === 'conflicted' && (m.status === 'clean' || m.status === 'fast-forward' || m.status === 'up-to-date')) return { kind: 'clear' };
  return null;
}

/**
 * Marks the change conflicted at the record's head and upserts its one live
 * resolve-conflict task (refreshing head, base and conflicts of an existing
 * one). Both are guarded by the change still being live at that head.
 */
export function markConflictedStatements(db: D1Database, changeId: string, record: ConflictRecord, now: number): D1PreparedStatement[] {
  const json = JSON.stringify(record);
  const payload = JSON.stringify({ conflicts: record.conflicts, ...(record.truncated ? { truncated: true } : {}) });
  const taskId = crypto.randomUUID();
  return [
    db
      .prepare(
        `UPDATE change_sets SET state = 'conflicted', conflicts = ?3, updated_at = ?4
          WHERE id = ?1 AND state IN ('open', 'conflicted') AND head_sha = ?2`,
      )
      .bind(changeId, record.headSha, json, now),
    taskCreatedEventStatement(db, taskId, changeId, record, now),
    db
      .prepare(
        `INSERT INTO agent_tasks (id, repo_id, kind, change_set_id, workspace_id, status, generation, head_sha, base_sha, payload, created_at, updated_at)
         SELECT ?1, c.repo_id, '${RESOLVE_CONFLICT}', c.id, (SELECT w.id FROM workspaces w WHERE w.change_set_id = c.id LIMIT 1), 'open', 0,
                ?3, ?4, ?5, ?6, ?6
           FROM change_sets c WHERE c.id = ?2 AND c.state = 'conflicted' AND c.head_sha = ?3
         ON CONFLICT (change_set_id, kind) WHERE status IN ('open', 'claimed') DO UPDATE SET
           head_sha = excluded.head_sha, base_sha = excluded.base_sha, payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .bind(taskId, changeId, record.headSha, record.baseSha, payload, now),
  ];
}

export const TASK_CREATED_EVENT = 'kvarm.task.created';

/**
 * The outbound `kvarm.task.created` event (a CloudEvents 1.0 envelope in the
 * events ledger, `processed_at` NULL, which migration 0028's trigger fans out
 * to subscribed webhooks, services/webhooks.ts) for the task the following
 * upsert creates. It must run before that upsert: it is
 * written only while the change has no live task of the kind yet, so a
 * refresh of an existing task records nothing.
 */
function taskCreatedEventStatement(db: D1Database, taskId: string, changeId: string, record: ConflictRecord, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, '${TASK_CREATED_EVENT}',
              json_object('specversion', '1.0', 'id', ?1, 'type', '${TASK_CREATED_EVENT}',
                          'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', ?2, 'time', ?7,
                          'datacontenttype', 'application/json',
                          'data', json_object('task', ?2, 'kind', '${RESOLVE_CONFLICT}', 'repo', r.owner_login || '/' || r.name,
                                              'change', c.number, 'headSha', ?4, 'baseSha', ?5, 'conflicts', json(?6))),
              NULL, ?8
         FROM change_sets c JOIN repos r ON r.id = c.repo_id
        WHERE c.id = ?3 AND c.state = 'conflicted' AND c.head_sha = ?4
          AND NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.change_set_id = c.id AND t.kind = '${RESOLVE_CONFLICT}' AND t.status IN ('open', 'claimed'))`,
    )
    .bind(crypto.randomUUID(), taskId, changeId, record.headSha, record.baseSha, JSON.stringify(record.conflicts), new Date(now).toISOString(), now);
}

/**
 * Retires the live resolve-conflict task of a change that is no longer
 * conflicted (reopened, closed or merged); a no-op while it still is.
 */
export function retireConflictTaskStatement(db: D1Database, repoId: string, number: number, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE agent_tasks SET status = 'obsolete', updated_at = ?3
        WHERE kind = '${RESOLVE_CONFLICT}' AND status IN ('open', 'claimed')
          AND change_set_id = (SELECT c.id FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2 AND c.state != 'conflicted')`,
    )
    .bind(repoId, number, now);
}

/** Reopens a conflicted change at `headSha` and retires its task. */
export function clearConflictStatements(db: D1Database, repoId: string, change: { id: string; number: number }, headSha: string, now: number): D1PreparedStatement[] {
  return [
    db
      .prepare(`UPDATE change_sets SET state = 'open', conflicts = NULL, updated_at = ?3 WHERE id = ?1 AND state = 'conflicted' AND head_sha = ?2`)
      .bind(change.id, headSha, now),
    retireConflictTaskStatement(db, repoId, change.number, now),
  ];
}

export function transitionStatements(
  db: D1Database,
  repoId: string,
  change: { id: string; number: number; head_sha: string },
  t: ConflictTransition,
  now: number,
): D1PreparedStatement[] {
  return t.kind === 'mark' ? markConflictedStatements(db, change.id, t.record, now) : clearConflictStatements(db, repoId, change, change.head_sha, now);
}

/**
 * Applies the transition an evaluation calls for (one D1 batch, none when
 * nothing changed). Returns the change's state and stored conflicts after
 * it, or null when nothing was written or the guarded write did not land.
 */
export async function reconcileConflicts(
  env: Env,
  repoId: string,
  row: ConflictSubject & { number: number },
  m: ConflictEvaluation,
): Promise<{ state: 'open' | 'conflicted'; conflicts: string | null } | null> {
  const t = conflictTransition(row, m);
  if (!t) return null;
  const [first] = await env.DB.batch(transitionStatements(env.DB, repoId, { id: row.id, number: row.number, head_sha: row.head_sha! }, t, Date.now()));
  if (!first?.meta.changes) return null;
  return t.kind === 'mark' ? { state: 'conflicted', conflicts: JSON.stringify(t.record) } : { state: 'open', conflicts: null };
}
