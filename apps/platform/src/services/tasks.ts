/**
 * Agent tasks (`agent_tasks`): work Forge dispatches to agents. Today the
 * only kind is `resolve-conflict` (services/conflicts.ts), created when a
 * change's conflicts survive the deterministic resolution stage. Claiming
 * and completing tasks are separate operations; this module lists them.
 *
 *   GET tasks?status=open|claimed|completed|obsolete|all&kind=&limit=&cursor=
 *
 * Newest first; one bounded indexed range read per page.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { fail } from './changes';
import type { ConflictView } from './conflicts';

export const TASK_STATUSES = ['open', 'claimed', 'completed', 'obsolete'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_LIMITS = { pageDefault: 50, pageMax: 100 };

interface TaskRow {
  id: string;
  kind: string;
  status: TaskStatus;
  claimed_by: string | null;
  generation: number;
  head_sha: string | null;
  base_sha: string | null;
  payload: string | null;
  workspace_id: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  change_number: number | null;
  change_state: string | null;
}

export interface TaskView {
  id: string;
  kind: string;
  status: TaskStatus;
  change: { number: number; state: string } | null;
  workspace: string | null;
  headSha: string | null;
  baseSha: string | null;
  conflicts?: ConflictView[];
  conflictsTruncated?: true;
  claimedBy: string | null;
  generation: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskPage {
  tasks: TaskView[];
  nextCursor: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function payloadOf(json: string | null): { conflicts?: ConflictView[]; truncated?: boolean } {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as { conflicts?: unknown; truncated?: unknown };
    return { ...(Array.isArray(v.conflicts) ? { conflicts: v.conflicts as ConflictView[] } : {}), ...(v.truncated === true ? { truncated: true } : {}) };
  } catch {
    return {};
  }
}

function taskView(r: TaskRow): TaskView {
  const payload = payloadOf(r.payload);
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    change: r.change_number === null ? null : { number: r.change_number, state: r.change_state! },
    workspace: r.workspace_id,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    ...(payload.conflicts ? { conflicts: payload.conflicts } : {}),
    ...(payload.truncated ? { conflictsTruncated: true as const } : {}),
    claimedBy: r.claimed_by,
    generation: r.generation,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    completedAt: iso(r.completed_at),
  };
}

/** `<created_at>.<id>` of the last task on a page. */
const CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})$/;

export async function listTasks(
  env: Env,
  repo: RepoRow,
  q: { status?: string; kind?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<TaskPage>> {
  const status = q.status ?? 'open';
  if (status !== 'all' && !(TASK_STATUSES as readonly string[]).includes(status)) {
    return fail(400, `status must be one of ${[...TASK_STATUSES, 'all'].join(', ')}`, 'INVALID_STATUS');
  }
  const kind = q.kind === undefined || q.kind === '' ? null : q.kind;
  if (kind !== null && !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) return fail(400, 'kind must be a task kind such as resolve-conflict', 'INVALID_KIND');
  let limit = TASK_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > TASK_LIMITS.pageMax) {
      return fail(400, `limit must be an integer from 1 to ${TASK_LIMITS.pageMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let beforeAt = Number.MAX_SAFE_INTEGER;
  let beforeId = '~';
  if (q.cursor !== undefined && q.cursor !== '') {
    const m = CURSOR.exec(q.cursor);
    if (!m) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    beforeAt = Number(m[1]);
    beforeId = m[2]!;
  }
  const where = status === 'all' ? 't.repo_id = ?1' : 't.repo_id = ?1 AND t.status = ?5';
  const stmt = env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.claimed_by, t.generation, t.head_sha, t.base_sha, t.payload, t.workspace_id,
            t.created_at, t.updated_at, t.completed_at, c.number AS change_number, c.state AS change_state
       FROM agent_tasks t LEFT JOIN change_sets c ON c.id = t.change_set_id
      WHERE ${where} AND (?2 IS NULL OR t.kind = ?2) AND (t.created_at < ?3 OR (t.created_at = ?3 AND t.id < ?4))
      ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`,
  );
  const bound = status === 'all' ? stmt.bind(repo.id, kind, beforeAt, beforeId) : stmt.bind(repo.id, kind, beforeAt, beforeId, status);
  const rows = (await bound.all<TaskRow>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: { tasks: page.map(taskView), nextCursor: rows.length > limit && last ? `${last.created_at}.${last.id}` : null },
  };
}
