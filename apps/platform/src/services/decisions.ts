/**
 * Agent decision records and the context reader (get_context).
 *
 * A decision names the candidate an agent chose for a task and/or paths, the
 * candidates it rejected (each optionally with its own reason) and why, so a
 * later agent working on the same task or files inherits the reasoning. Rows
 * live in `agent_decisions`, with one `agent_decision_paths` row per path so
 * any of a decision's paths finds it. Context reads are one bounded indexed
 * query, newest first, paged with an opaque cursor.
 *
 * Callers authorize first through the shared authority lookup; nothing here
 * checks access.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { normalizeRepoPath } from './contents';

export const DECISION_LIMITS = {
  /** Paths one decision may name. */
  pathsMax: 100,
  /** Paths one context query may name. */
  queryPathsMax: 20,
  pathMax: 1024,
  rejectedMax: 50,
  idMax: 200,
  taskMax: 200,
  reasonMax: 4000,
  /** Decisions per context page (default and maximum). */
  pageDefault: 20,
  pageMax: 50,
} as const;

export type RejectedCandidate = string | { id: string; reason?: string };

export interface DecisionView {
  id: string;
  task: string | null;
  paths: string[];
  chosen: string;
  rejected: RejectedCandidate[];
  reason: string;
  actor: string;
  agent: { id: string; name: string } | null;
  /** ISO 8601 UTC */
  at: string;
}

export interface ContextPage {
  decisions: DecisionView[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface DecisionContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
}

interface DecisionRow {
  id: string;
  task_id: string | null;
  paths: string;
  chosen_candidate: string;
  rejected_candidates: string;
  reason: string;
  actor: string;
  agent_id: string | null;
  agent_name: string | null;
  at: number;
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;

const fail = (status: number, code: string, error: string): Fail => ({ ok: false, status, code, error });

function view(r: DecisionRow): DecisionView {
  return {
    id: r.id,
    task: r.task_id,
    paths: JSON.parse(r.paths) as string[],
    chosen: r.chosen_candidate,
    rejected: JSON.parse(r.rejected_candidates) as RejectedCandidate[],
    reason: r.reason,
    actor: r.actor,
    agent: r.agent_id && r.agent_name ? { id: r.agent_id, name: r.agent_name } : null,
    at: new Date(r.at).toISOString(),
  };
}

const nonEmpty = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

interface ParsedDecision {
  task: string | null;
  paths: string[];
  chosen: string;
  rejected: RejectedCandidate[];
  reason: string;
}

function parseDecision(input: unknown): ServiceResult<ParsedDecision> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(400, 'INVALID_BODY', 'body must be a JSON object {task?, paths[], chosen, rejected[], reason}');
  }
  const o = input as Record<string, unknown>;
  const L = DECISION_LIMITS;
  if (o.task !== undefined && o.task !== null && !nonEmpty(o.task, L.taskMax)) {
    return fail(422, 'INVALID_TASK', `task must be a non-empty string of at most ${L.taskMax} characters`);
  }
  const task = (o.task as string | null | undefined) ?? null;
  const rawPaths = o.paths ?? [];
  if (!Array.isArray(rawPaths)) return fail(422, 'INVALID_PATH', 'paths must be a list of repository-relative paths');
  if (rawPaths.length > L.pathsMax) {
    return fail(422, 'TOO_MANY_PATHS', `a decision names at most ${L.pathsMax} paths (got ${rawPaths.length}); record several decisions or name a directory`);
  }
  const paths: string[] = [];
  for (const p of rawPaths) {
    const norm = typeof p === 'string' && p.length <= L.pathMax ? normalizeRepoPath(p) : null;
    if (!norm) return fail(422, 'INVALID_PATH', `invalid path ${JSON.stringify(p).slice(0, 120)}; paths are repository-relative without . or .. segments`);
    if (!paths.includes(norm)) paths.push(norm);
  }
  if (task === null && paths.length === 0) {
    return fail(422, 'TASK_OR_PATHS_REQUIRED', 'a decision is linked to a task, to paths, or both');
  }
  if (!nonEmpty(o.chosen, L.idMax)) return fail(422, 'INVALID_CHOSEN', `chosen must be a candidate or change id (1-${L.idMax} characters)`);
  if (!Array.isArray(o.rejected) || o.rejected.length > L.rejectedMax) {
    return fail(422, 'INVALID_REJECTED', `rejected must be a list of at most ${L.rejectedMax} ids or {id, reason} objects`);
  }
  const rejected: RejectedCandidate[] = [];
  for (const r of o.rejected as unknown[]) {
    if (nonEmpty(r, L.idMax)) {
      rejected.push(r);
      continue;
    }
    const obj = r as { id?: unknown; reason?: unknown } | null;
    const ok =
      typeof obj === 'object' &&
      obj !== null &&
      !Array.isArray(obj) &&
      nonEmpty(obj.id, L.idMax) &&
      (obj.reason === undefined || nonEmpty(obj.reason, L.reasonMax));
    if (!ok) return fail(422, 'INVALID_REJECTED', 'each rejected entry is an id or {id, reason?} with non-empty strings');
    rejected.push(obj.reason === undefined ? { id: obj.id as string } : { id: obj.id as string, reason: obj.reason as string });
  }
  if (!nonEmpty(o.reason, L.reasonMax)) return fail(422, 'INVALID_REASON', `reason must be a non-empty string of at most ${L.reasonMax} characters`);
  return { ok: true, value: { task, paths, chosen: o.chosen, rejected, reason: o.reason } };
}

/** POST decisions — one batch: the decision row and its path rows. */
export async function recordDecision(cx: DecisionContext, input: unknown): Promise<ServiceResult<DecisionView>> {
  const parsed = parseDecision(input);
  if (!parsed.ok) return parsed;
  const d = parsed.value;
  const row: DecisionRow = {
    id: crypto.randomUUID(),
    task_id: d.task,
    paths: JSON.stringify(d.paths),
    chosen_candidate: d.chosen,
    rejected_candidates: JSON.stringify(d.rejected),
    reason: d.reason,
    actor: cx.actor?.user.login ?? 'forge',
    agent_id: cx.actor?.agent?.agentId ?? null,
    agent_name: cx.actor?.agent?.agentName ?? null,
    at: Date.now(),
  };
  const db = cx.env.DB;
  await db.batch([
    db
      .prepare(
        `INSERT INTO agent_decisions (id, repo_id, task_id, paths, chosen_candidate, rejected_candidates, reason, actor, agent_id, agent_name, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.id, cx.repo.id, row.task_id, row.paths, row.chosen_candidate, row.rejected_candidates, row.reason, row.actor, row.agent_id, row.agent_name, row.at),
    ...(d.paths.length > 0
      ? [
          db
            .prepare(
              `INSERT INTO agent_decision_paths (decision_id, repo_id, path, at)
               SELECT ?1, ?2, value, ?3 FROM json_each(?4)`,
            )
            .bind(row.id, cx.repo.id, row.at, row.paths),
        ]
      : []),
  ]);
  return { ok: true, value: view(row) };
}

export interface ContextQuery {
  task?: string | undefined;
  /** Raw `path` query values; each may hold several comma-separated paths. */
  paths?: string[];
  limit?: string | undefined;
  cursor?: string | undefined;
}

function encodeCursor(r: DecisionRow): string {
  return btoa(JSON.stringify([r.at, r.id])).replace(/=+$/, '');
}

function decodeCursor(raw: string): { at: number; id: string } | null {
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && typeof v[1] === 'string' && v[1].length <= 64) {
      return { at: v[0] as number, id: v[1] };
    }
  } catch {
    // not one of ours
  }
  return null;
}

/** GET context?task=&path=&limit=&cursor= — decisions for the task or any of the paths, newest first. */
export async function readContext(cx: DecisionContext, q: ContextQuery): Promise<ServiceResult<ContextPage>> {
  const L = DECISION_LIMITS;
  const task = q.task && q.task.length > 0 ? q.task : null;
  if (task !== null && task.length > L.taskMax) return fail(400, 'INVALID_TASK', `task is at most ${L.taskMax} characters`);
  const paths: string[] = [];
  for (const raw of (q.paths ?? []).flatMap((p) => p.split(','))) {
    if (raw === '') continue;
    const norm = raw.length <= L.pathMax ? normalizeRepoPath(raw) : null;
    if (!norm) return fail(400, 'INVALID_PATH', `invalid path ${JSON.stringify(raw).slice(0, 120)}`);
    if (!paths.includes(norm)) paths.push(norm);
    if (paths.length > L.queryPathsMax) {
      return fail(400, 'TOO_MANY_PATHS', `a context query names at most ${L.queryPathsMax} paths; split it into several queries`);
    }
  }
  if (task === null && paths.length === 0) {
    return fail(400, 'CONTEXT_QUERY_REQUIRED', 'name a task (task=) and/or paths (path=a,b or repeated path=)');
  }
  let limit: number = L.pageDefault;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > L.pageMax) return fail(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${L.pageMax}`);
    limit = n;
  }
  let after: { at: number; id: string } | null = null;
  if (q.cursor) {
    after = decodeCursor(q.cursor);
    if (!after) return fail(400, 'INVALID_CURSOR', 'cursor is not a nextCursor from this endpoint');
  }

  // Each branch walks its own index (task, or path) in (at, id) order and stops after one page plus one;
  // the union is re-ordered and capped. A decision's path rows share its `at`, so DISTINCT dedupes them.
  const page = after ? 'AND (at < ?3 OR (at = ?3 AND id < ?4))' : '';
  const pathPage = after ? 'AND (p.at < ?3 OR (p.at = ?3 AND p.decision_id < ?4))' : '';
  const branches: string[] = [];
  if (task !== null) {
    branches.push(
      `SELECT id FROM (SELECT id FROM agent_decisions WHERE repo_id = ?1 AND task_id = ?2 ${page}
        ORDER BY at DESC, id DESC LIMIT ${limit + 1})`,
    );
  }
  if (paths.length > 0) {
    branches.push(
      `SELECT id FROM (SELECT DISTINCT p.decision_id AS id, p.at FROM agent_decision_paths p
        WHERE p.repo_id = ?1 AND p.path IN (SELECT value FROM json_each(?5)) ${pathPage}
        ORDER BY p.at DESC, p.decision_id DESC LIMIT ${limit + 1})`,
    );
  }
  const sql = `SELECT d.id, d.task_id, d.paths, d.chosen_candidate, d.rejected_candidates, d.reason, d.actor, d.agent_id, d.agent_name, d.at
    FROM agent_decisions d
   WHERE d.repo_id = ?1 AND d.id IN (${branches.join(' UNION ')})
   ORDER BY d.at DESC, d.id DESC
   LIMIT ${limit + 1}`;
  // D1 refuses more bind values than the statement's highest ?N.
  const binds = [cx.repo.id, task, after?.at ?? null, after?.id ?? null, JSON.stringify(paths)];
  const used = Math.max(...[...sql.matchAll(/\?(\d)/g)].map((m) => Number(m[1])));
  const rows = (
    await cx.env.DB.prepare(sql)
      .bind(...binds.slice(0, used))
      .all<DecisionRow>()
  ).results;
  const truncated = rows.length > limit;
  const kept = rows.slice(0, limit);
  return {
    ok: true,
    value: { decisions: kept.map(view), truncated, nextCursor: truncated ? encodeCursor(kept[kept.length - 1]!) : null },
  };
}
