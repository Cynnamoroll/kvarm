/**
 * Agent tasks (`agent_tasks`): work Forge dispatches to agents. Today the
 * only kind is `resolve-conflict` (services/conflicts.ts), created when a
 * change's conflicts survive the deterministic resolution stage.
 *
 *   GET  tasks?status=open|claimed|completed|obsolete|all&kind=&limit=&cursor=
 *   GET  tasks/:id
 *   POST tasks/:id/claim      {agent?, ttlSeconds?}            → {task, workspace, lease}
 *   POST tasks/:id/heartbeat  {agent?, generation, ttlSeconds?} → task
 *   POST tasks/:id/complete   {agent?, generation, sha?, attribution?} → {task, change, headBranch}
 *
 * A claim is an expiring lease fenced by generation and owner
 * (services/fencing.ts, kind `task`): a second claim is refused while the
 * lease is live, a lapsed lease is taken over under the next generation (a
 * dead agent cannot strand a task), and heartbeat and completion must name
 * the current generation and owner, so a superseded holder changes nothing.
 * The lease expiry is mirrored on the task row so listings report a lapsed
 * claim as `open` again.
 *
 * Claiming creates a workspace (services/workspaces.ts) whose ref sits at the
 * conflicting change's head; a reclaim reuses it when the new claimant may
 * act on it. The agent pushes a resolution there with ordinary git (base
 * merged into the head, conflicts resolved). Completion verifies it (moved
 * from the claim base, a descendant of the change's head, merging with the
 * base tip without conflicts), then one D1 batch completes the task, closes
 * the fence and moves the change to the resolution and back to `open`; only
 * then is the change's head branch fast-forwarded to it and the resolution
 * attributed to the claimant. The change then follows its mergePolicy: `auto`
 * merges at once when mergeable (otherwise when its checks complete), `review`
 * waits for an explicit merge, `draft` never merges.
 */

import { isAncestor } from '@forge/gitops';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { attributeCommit, parseAttributionInput, type AttributionInput } from './attribution';
import { credentialMayUpdateRef, type Actor } from './authz';
import { directPushDenial, repoBranchRulesSelect, ruleFromRow, type BranchRule, type BranchRuleRow } from './branchRules';
import {
  autoMerge,
  branchRef,
  changeSelect,
  changeView,
  guarded,
  mergeabilityFor,
  resolveCtx,
  type ChangeRow,
  type ChangeView,
} from './changes';
import { defaultChecksGate } from './checksGate';
import { conflictViews, type ConflictView } from './conflicts';
import { claimFenced, releaseFenced, renewFenced } from './fencing';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { MERGE_BUDGETS, artifactsMergeSources } from './merge';
import { lsRefs } from './refs';
import {
  WORKSPACE_REF_PREFIX,
  WORKSPACE_SELECT,
  agentOwnershipDenial,
  agentWorkspaceDenial,
  liveRefs,
  newId,
  workspaceInsertStatement,
  workspaceOwners,
  workspaceRef,
  workspaceView,
  type WorkspaceRow,
  type WorkspaceView,
} from './workspaces';

export const TASK_STATUSES = ['open', 'claimed', 'completed', 'obsolete'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_LIMITS = {
  pageDefault: 50,
  pageMax: 100,
  /** Claim lease length when the request names none, and the longest allowed (seconds). */
  leaseDefaultSeconds: 600,
  leaseMaxSeconds: 3600,
  agentMax: 100,
};

/** fenced_claims kind of task claims (subject: task id). */
const FENCE_KIND = 'task';
const ZERO_SHA = '0000000000000000000000000000000000000000';
const SHA_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^[0-9a-f-]{36}$/;

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
  claim_workspace_id: string | null;
  lease_expires_at: number | null;
  resolution_sha: string | null;
  completed_by: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  change_number: number | null;
  change_state: string | null;
}

/** A task with what claim and completion need of its change. */
interface TaskDetailRow extends TaskRow {
  change_id: string | null;
  change_head_sha: string | null;
  change_head_ref: string | null;
  change_base_ref: string | null;
}

interface FenceRow {
  generation: number;
  owner: string | null;
  state: 'open' | 'claimed' | 'done';
  expires_at: number | null;
}

export interface TaskLease {
  until: string;
  generation: number;
  /** The claimant's agent identity. */
  holder: string | null;
  expired: boolean;
}

export interface TaskView {
  id: string;
  kind: string;
  /** `open` also for a claim whose lease ran out: anyone may claim it again. */
  status: TaskStatus;
  change: { number: number; state: string } | null;
  /** The workspace created for the claimant (null until claimed). */
  workspace: string | null;
  /** The workspace the change itself was opened from, if any. */
  changeWorkspace: string | null;
  headSha: string | null;
  baseSha: string | null;
  conflicts?: ConflictView[];
  conflictsTruncated?: true;
  claimedBy: string | null;
  generation: number;
  /** The current (or lapsed) claim; null when unclaimed or completed. */
  lease: TaskLease | null;
  resolutionSha: string | null;
  completedBy: string | null;
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

function leaseOf(r: Pick<TaskRow, 'status' | 'lease_expires_at' | 'generation' | 'claimed_by'>, now: number): TaskLease | null {
  if (r.status !== 'claimed' || r.lease_expires_at === null) return null;
  return { until: iso(r.lease_expires_at)!, generation: r.generation, holder: r.claimed_by, expired: r.lease_expires_at <= now };
}

function taskView(r: TaskRow, now = Date.now()): TaskView {
  const payload = payloadOf(r.payload);
  const lease = leaseOf(r, now);
  return {
    id: r.id,
    kind: r.kind,
    status: lease?.expired ? 'open' : r.status,
    change: r.change_number === null ? null : { number: r.change_number, state: r.change_state! },
    workspace: r.claim_workspace_id,
    changeWorkspace: r.workspace_id,
    headSha: r.head_sha,
    baseSha: r.base_sha,
    ...(payload.conflicts ? { conflicts: payload.conflicts } : {}),
    ...(payload.truncated ? { conflictsTruncated: true as const } : {}),
    claimedBy: r.claimed_by,
    generation: r.generation,
    lease,
    resolutionSha: r.resolution_sha,
    completedBy: r.completed_by,
    createdAt: iso(r.created_at)!,
    updatedAt: iso(r.updated_at)!,
    completedAt: iso(r.completed_at),
  };
}

const TASK_COLUMNS = `t.id, t.kind, t.status, t.claimed_by, t.generation, t.head_sha, t.base_sha, t.payload, t.workspace_id,
       t.claim_workspace_id, t.lease_expires_at, t.resolution_sha, t.completed_by,
       t.created_at, t.updated_at, t.completed_at, c.number AS change_number, c.state AS change_state`;

function detailSelect(db: D1Database, repoId: string, id: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ${TASK_COLUMNS}, c.id AS change_id, c.head_sha AS change_head_sha, c.head_ref AS change_head_ref, c.base_ref AS change_base_ref
         FROM agent_tasks t LEFT JOIN change_sets c ON c.id = t.change_set_id
        WHERE t.repo_id = ?1 AND t.id = ?2`,
    )
    .bind(repoId, id);
}

function claimWorkspaceSelect(db: D1Database, repoId: string, id: string): D1PreparedStatement {
  return db
    .prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ?1 AND w.id = (SELECT t.claim_workspace_id FROM agent_tasks t WHERE t.repo_id = ?1 AND t.id = ?2)`)
    .bind(repoId, id);
}

function fenceSelect(db: D1Database, id: string): D1PreparedStatement {
  return db.prepare('SELECT generation, owner, state, expires_at FROM fenced_claims WHERE kind = ?1 AND subject = ?2').bind(FENCE_KIND, id);
}

type Fail = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

const first = <T>(r: D1Result | undefined): T | null => ((r?.results as T[] | undefined) ?? [])[0] ?? null;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

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
  const now = Date.now();
  // A claim whose lease ran out lists as open (claimable), not as claimed.
  let where: string;
  let extra: unknown[];
  if (status === 'all') {
    where = 't.repo_id = ?1';
    extra = [];
  } else if (status === 'open') {
    where = `t.repo_id = ?1 AND t.status IN ('open', 'claimed') AND (t.status = 'open' OR t.lease_expires_at <= ?5)`;
    extra = [now];
  } else if (status === 'claimed') {
    where = `t.repo_id = ?1 AND t.status = 'claimed' AND (t.lease_expires_at IS NULL OR t.lease_expires_at > ?5)`;
    extra = [now];
  } else {
    where = 't.repo_id = ?1 AND t.status = ?5';
    extra = [status];
  }
  const rows =
    (
      await env.DB.prepare(
        `SELECT ${TASK_COLUMNS}
           FROM agent_tasks t LEFT JOIN change_sets c ON c.id = t.change_set_id
          WHERE ${where} AND (?2 IS NULL OR t.kind = ?2) AND (t.created_at < ?3 OR (t.created_at = ?3 AND t.id < ?4))
          ORDER BY t.created_at DESC, t.id DESC LIMIT ${limit + 1}`,
      )
        .bind(repo.id, kind, beforeAt, beforeId, ...extra)
        .all<TaskRow>()
    ).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: { tasks: page.map((r) => taskView(r, now)), nextCursor: rows.length > limit && last ? `${last.created_at}.${last.id}` : null },
  };
}

/** GET tasks/:id */
export async function getTask(env: Env, repo: RepoRow, id: string): Promise<ServiceResult<TaskView>> {
  const row = ID_RE.test(id) ? await detailSelect(env.DB, repo.id, id).first<TaskDetailRow>() : null;
  if (!row) return fail(404, 'task not found', 'TASK_NOT_FOUND');
  return { ok: true, value: taskView(row) };
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

export interface TaskContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  /** Origin of the request, for the workspace push URL. */
  origin: string;
  branchRules?: BranchRule[];
  waitUntil(p: Promise<unknown>): void;
}

export interface TaskDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
}

export const defaultTaskDeps: TaskDeps = { pusher: (env, repo) => artifactsPusher(env, repo) };

interface Claimant {
  /** The agent identity shown as claimant (claimedBy, workspace agent, attribution). */
  agent: string;
  /** The fencing owner: the principal plus, for a person's token, the agent identity it names. */
  owner: string;
}

type Body = Record<string, unknown>;

function bodyOf(input: unknown): ServiceResult<Body> {
  if (input === undefined || input === null) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  return { ok: true, value: input as Body };
}

/**
 * An agent token is its own claimant. A person's token names the agent it
 * runs (`agent`, default the login), so several agents sharing one token are
 * distinct claimants.
 */
function claimantOf(actor: Actor | null, raw: unknown): ServiceResult<Claimant> {
  if (!actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (actor.agent) return { ok: true, value: { agent: actor.agent.agentName, owner: `agent:${actor.agent.agentId}` } };
  let agent = actor.user.login;
  if (raw !== undefined && raw !== null) {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (v.length === 0 || v.length > TASK_LIMITS.agentMax) return fail(422, `agent must be a string of 1-${TASK_LIMITS.agentMax} characters`, 'INVALID_AGENT');
    agent = v;
  }
  return { ok: true, value: { agent, owner: `user:${actor.user.id}:${agent}` } };
}

function ttlOf(raw: unknown): ServiceResult<number> {
  if (raw === undefined || raw === null) return { ok: true, value: TASK_LIMITS.leaseDefaultSeconds };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > TASK_LIMITS.leaseMaxSeconds) {
    return fail(422, `ttlSeconds must be an integer from 1 to ${TASK_LIMITS.leaseMaxSeconds}`, 'INVALID_TTL');
  }
  return { ok: true, value: raw };
}

function generationOf(raw: unknown): ServiceResult<number> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return fail(422, 'generation is required: the lease generation returned by the claim', 'INVALID_GENERATION');
  }
  return { ok: true, value: raw };
}

/** Why a task can no longer be claimed or completed (null: it can). */
function lifecycleRefusal(row: TaskRow): Fail | null {
  if (row.status === 'completed') {
    return fail(409, `task ${row.id} was already completed by ${row.completed_by ?? 'another agent'} at ${iso(row.completed_at)}`, 'TASK_COMPLETED', {
      task: taskView(row),
    });
  }
  if (row.status === 'obsolete') {
    return fail(409, `task ${row.id} is obsolete: its change is no longer conflicted (resolved, closed or merged)`, 'TASK_OBSOLETE');
  }
  return null;
}

/** Whether `generation` and `claimant` still hold the task's claim (null: they do). */
function fenceRefusal(row: TaskRow, fence: FenceRow | null, generation: number, claimant: Claimant): Fail | null {
  if (!fence || fence.generation !== generation || fence.state !== 'claimed') {
    const current = fence ? ` (current generation ${fence.generation}${fence.state === 'claimed' && row.claimed_by ? `, held by ${row.claimed_by}` : ''})` : '';
    return fail(409, `generation ${generation} of task ${row.id} is no longer current${current}; claim the task again`, 'STALE_GENERATION', {
      currentGeneration: fence?.generation ?? 0,
    });
  }
  if (fence.owner !== claimant.owner) {
    return fail(409, `generation ${generation} of task ${row.id} is held by ${row.claimed_by ?? 'another agent'}, not ${claimant.agent}`, 'NOT_CLAIMANT');
  }
  return null;
}

export interface ClaimOutcome {
  task: TaskView;
  workspace: WorkspaceView;
  lease: TaskLease;
}

/**
 * POST tasks/:id/claim. The fenced claim is taken first; the workspace ref
 * (new claims) is created only by the winner, and a failed ref creation
 * gives the claim back at once.
 */
export function claimTask(cx: TaskContext, id: string, input: unknown, deps: TaskDeps = defaultTaskDeps): Promise<ServiceResult<ClaimOutcome>> {
  return guarded(async () => {
    const body = bodyOf(input);
    if (!body.ok) return body;
    const who = claimantOf(cx.actor, body.value.agent);
    if (!who.ok) return who;
    const ttl = ttlOf(body.value.ttlSeconds);
    if (!ttl.ok) return ttl;
    if (!ID_RE.test(id)) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const db = cx.env.DB;
    const [taskRead, wsRead] = await db.batch([detailSelect(db, cx.repo.id, id), claimWorkspaceSelect(db, cx.repo.id, id)]);
    const row = first<TaskDetailRow>(taskRead);
    if (!row) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const refused = lifecycleRefusal(row);
    if (refused) return refused;
    if (row.change_state !== 'conflicted' || !row.head_sha || !row.change_base_ref) {
      return fail(409, `task ${id}'s change is not conflicted`, 'CHANGE_NOT_CONFLICTED');
    }
    const existing = first<WorkspaceRow>(wsRead);
    const reuse =
      existing && existing.status === 'active' && existing.ref && existing.head_sha === row.head_sha && agentOwnershipDenial(cx.actor, existing) === null
        ? existing
        : null;
    const wsId = reuse?.id ?? newId();
    const ref = reuse?.ref ?? workspaceRef(wsId, `resolve-conflict ${row.change_number}`);
    if (!reuse && cx.actor?.agent && !credentialMayUpdateRef(cx.actor, ref)) {
      return fail(403, 'this agent token may not create refs/heads/agents/<id>/ refs', 'AGENT_REF_FORBIDDEN');
    }

    const now = Date.now();
    const won = await claimFenced(db, { kind: FENCE_KIND, subject: id, owner: who.value.owner, identity: row.head_sha, ttlMs: ttl.value * 1000, now });
    if (!won.ok) {
      if (won.code === 'CLAIM_DONE') return fail(409, `task ${id} was already completed`, 'TASK_COMPLETED');
      const cur = won.current;
      const holder = row.claimed_by ?? 'another agent';
      const lease = cur?.expiresAt ? { until: iso(cur.expiresAt)!, generation: cur.generation, holder: row.claimed_by, expired: false } : null;
      return fail(
        409,
        `task ${id} is claimed by ${holder}${lease ? ` until ${lease.until} (generation ${lease.generation})` : ''}; it can be claimed again once that lease expires`,
        'CLAIMED',
        { claimedBy: row.claimed_by, lease, retryAfterMs: won.retryAfterMs ?? 0 },
      );
    }
    const generation = won.value.generation;
    const until = won.value.expiresAt!;

    if (!reuse) {
      const pushed = await deps.pusher(cx.env, cx.repo).updateRef({ ref, oldOid: ZERO_SHA, newOid: row.head_sha });
      let created = pushed.status === 'ok';
      if (pushed.status === 'unknown') created = (await liveRefs(cx, [ref])).get(ref) === row.head_sha;
      if (!created) {
        await releaseFenced(db, { kind: FENCE_KIND, subject: id, generation, owner: who.value.owner });
        return fail(502, `the task workspace ref could not be created (${pushed.status}${pushed.reason ? `: ${pushed.reason}` : ''})`, 'REF_CREATE_FAILED');
      }
    }

    // The claim is recorded only while this generation and owner still hold the fence and the task still
    // names the change head the workspace was made at: a takeover during the ref I/O leaves no trace.
    const landed = `EXISTS (SELECT 1 FROM agent_tasks t WHERE t.id = ?17 AND t.status = 'claimed' AND t.generation = ?18 AND t.claim_workspace_id = ?19)`;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE agent_tasks SET status = 'claimed', claimed_by = ?3, generation = ?4, lease_expires_at = ?5, claim_workspace_id = ?6, updated_at = ?7
            WHERE repo_id = ?1 AND id = ?2 AND status IN ('open', 'claimed') AND generation < ?4 AND head_sha = ?9
              AND EXISTS (SELECT 1 FROM fenced_claims f WHERE f.kind = '${FENCE_KIND}' AND f.subject = ?2 AND f.generation = ?4 AND f.owner = ?8 AND f.state = 'claimed')
              AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = agent_tasks.change_set_id AND c.state = 'conflicted' AND c.head_sha = ?9)`,
        )
        .bind(cx.repo.id, id, who.value.agent, generation, until, wsId, now, who.value.owner, row.head_sha),
      reuse
        ? db
            .prepare(
              `UPDATE workspaces SET agent = ?3, updated_at = ?4 WHERE repo_id = ?1 AND id = ?2 AND agent_id IS NULL
                 AND ${landed.replace('?17', '?5').replace('?18', '?6').replace('?19', '?2')}`,
            )
            .bind(cx.repo.id, wsId, who.value.agent, now, id, generation)
        : workspaceInsertStatement(
            cx,
            {
              id: wsId,
              ref,
              task: `resolve-conflict #${row.change_number} (task ${id})`,
              agent: who.value.agent,
              base: row.change_base_ref,
              baseSha: row.base_sha ?? row.head_sha,
              headSha: row.head_sha,
            },
            now,
            null,
            null,
            { where: landed, params: [id, generation, wsId] },
          ),
      detailSelect(db, cx.repo.id, id),
      db.prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(cx.repo.id, wsId),
    ]);
    const after = first<TaskDetailRow>(results[2]);
    const ws = first<WorkspaceRow>(results[3]);
    if (!results[0]?.meta.changes || !after || !ws) {
      // The claim was taken over, or the task completed, was retired or followed a new head meanwhile.
      await releaseFenced(db, { kind: FENCE_KIND, subject: id, generation, owner: who.value.owner });
      if (!reuse) {
        const removed = await deps
          .pusher(cx.env, cx.repo)
          .updateRef({ ref, oldOid: row.head_sha, newOid: ZERO_SHA })
          .catch((err: unknown) => ({ status: 'unknown' as const, reason: String(err).slice(0, 200) }));
        if (removed.status !== 'ok') console.warn(JSON.stringify({ taskClaimRefLeft: { repo: cx.repo.id, task: id, ref, status: removed.status } }));
      }
      return (
        (after && lifecycleRefusal(after)) ??
        fail(409, `task ${id} was claimed again or changed while this claim was being set up; claim it again`, 'CLAIM_LOST', {
          currentGeneration: after?.generation ?? null,
        })
      );
    }
    const task = taskView(after, now);
    return { ok: true, value: { task, workspace: workspaceView(ws, cx.repo, cx.origin, reuse ? undefined : row.head_sha), lease: task.lease! } };
  });
}

/** POST tasks/:id/heartbeat: extends the holder's lease. */
export function heartbeatTask(cx: TaskContext, id: string, input: unknown): Promise<ServiceResult<TaskView>> {
  return guarded(async () => {
    const body = bodyOf(input);
    if (!body.ok) return body;
    const who = claimantOf(cx.actor, body.value.agent);
    if (!who.ok) return who;
    const generation = generationOf(body.value.generation);
    if (!generation.ok) return generation;
    const ttl = ttlOf(body.value.ttlSeconds);
    if (!ttl.ok) return ttl;
    if (!ID_RE.test(id)) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const db = cx.env.DB;
    const [taskRead, fenceRead] = await db.batch([detailSelect(db, cx.repo.id, id), fenceSelect(db, id)]);
    const row = first<TaskDetailRow>(taskRead);
    if (!row) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const refused = lifecycleRefusal(row) ?? fenceRefusal(row, first<FenceRow>(fenceRead), generation.value, who.value);
    if (refused) return refused;
    const now = Date.now();
    const renewed = await renewFenced(db, { kind: FENCE_KIND, subject: id, generation: generation.value, owner: who.value.owner, ttlMs: ttl.value * 1000, now });
    if (!renewed.ok) return fail(409, `generation ${generation.value} of task ${id} is no longer current; claim the task again`, 'STALE_GENERATION');
    const [, read] = await db.batch([
      db
        .prepare(`UPDATE agent_tasks SET lease_expires_at = ?4, updated_at = ?5 WHERE repo_id = ?1 AND id = ?2 AND status = 'claimed' AND generation = ?3`)
        .bind(cx.repo.id, id, generation.value, renewed.value.expiresAt, now),
      detailSelect(db, cx.repo.id, id),
    ]);
    const after = first<TaskDetailRow>(read);
    if (!after) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    return { ok: true, value: taskView(after, now) };
  });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export interface CompleteOutcome {
  task: TaskView;
  change: ChangeView;
  /** The fast-forward of the change's head branch to the resolution. */
  headBranch: { ref: string; updated: boolean; reason?: string };
}

/** POST tasks/:id/complete */
export function completeTask(cx: TaskContext, id: string, input: unknown, deps: TaskDeps = defaultTaskDeps): Promise<ServiceResult<CompleteOutcome>> {
  return guarded(async () => {
    const body = bodyOf(input);
    if (!body.ok) return body;
    const who = claimantOf(cx.actor, body.value.agent);
    if (!who.ok) return who;
    const generation = generationOf(body.value.generation);
    if (!generation.ok) return generation;
    const expected = body.value.sha;
    if (expected !== undefined && (typeof expected !== 'string' || !SHA_RE.test(expected))) {
      return fail(422, 'sha must be a full 40-character lowercase commit sha', 'INVALID_SHA');
    }
    let attribution: Partial<AttributionInput> | null = null;
    const rawAttribution = body.value.attribution;
    if (rawAttribution !== undefined && rawAttribution !== null) {
      const parsed = parseAttributionInput(rawAttribution, { agent: who.value.agent, session: `forge:task/${id}`, promptHash: null });
      if (!parsed.ok) return parsed;
      attribution = parsed.value;
    }
    if (!ID_RE.test(id)) return fail(404, 'task not found', 'TASK_NOT_FOUND');

    const db = cx.env.DB;
    const [taskRead, wsRead, fenceRead] = await db.batch([detailSelect(db, cx.repo.id, id), claimWorkspaceSelect(db, cx.repo.id, id), fenceSelect(db, id)]);
    const row = first<TaskDetailRow>(taskRead);
    if (!row) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const refused = lifecycleRefusal(row) ?? fenceRefusal(row, first<FenceRow>(fenceRead), generation.value, who.value);
    if (refused) return refused;
    const ws = first<WorkspaceRow>(wsRead);
    if (!ws || ws.status !== 'active' || !ws.ref) return fail(409, `task ${id} has no active workspace; claim it again`, 'WORKSPACE_NOT_ACTIVE');
    if (row.change_state !== 'conflicted' || !row.change_id || !row.change_head_sha || !row.change_head_ref || !row.change_base_ref) {
      return fail(409, `task ${id}'s change is not conflicted`, 'CHANGE_NOT_CONFLICTED');
    }
    const changeId = row.change_id;
    const oldHead = row.change_head_sha;
    const headRef = branchRef(row.change_head_ref);
    const baseRef = branchRef(row.change_base_ref);
    const wsRef = ws.ref;

    const verified = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts): Promise<ServiceResult<{ resolution: string; headTip: string }>> => {
      const ctx = resolveCtx(cx, artifacts);
      const tips = await lsRefs(ctx, [wsRef, headRef, baseRef]);
      const resolution = tips.get(wsRef) ?? null;
      if (!resolution) return fail(409, `the task workspace ref ${wsRef} no longer exists`, 'WORKSPACE_REF_MISSING');
      if (expected !== undefined && expected !== resolution) {
        return fail(409, `${wsRef} points at ${resolution}, not ${expected}; push the resolution to it before completing`, 'RESOLUTION_MISMATCH');
      }
      const claimBase = ws.head_sha ?? ws.base_sha;
      if (resolution === claimBase || resolution === oldHead) {
        return fail(
          409,
          `no resolution was pushed: ${wsRef} still points at the claim base ${resolution}; push the resolved commit (the base merged into the change's head) to it, then complete`,
          'RESOLUTION_NOT_PUSHED',
        );
      }
      // A head branch already at the resolution is a previous attempt whose completion was not recorded.
      if (tips.get(headRef) !== oldHead && tips.get(headRef) !== resolution) {
        return fail(409, `the change's head branch ${headRef} moved; the task follows the new head shortly, retry then`, 'HEAD_MOVED');
      }
      const baseTip = tips.get(baseRef) ?? null;
      if (!baseTip) return fail(409, `base branch ${row.change_base_ref} no longer exists`, 'BASE_NOT_FOUND');
      const anc = await isAncestor(artifactsMergeSources(ctx), oldHead, resolution, {
        maxCommitReads: MERGE_BUDGETS.maxCommitReads,
        concurrency: MERGE_BUDGETS.concurrency,
      });
      if (anc.truncated) return fail(422, `could not verify that ${resolution} contains the change's head ${oldHead}`, 'RESOLUTION_UNVERIFIABLE');
      if (!anc.ancestor) {
        return fail(409, `the resolution ${resolution} does not contain the change's head ${oldHead}; merge the base into the head instead of rewriting it`, 'RESOLUTION_NOT_DESCENDANT');
      }
      const m = await mergeabilityFor(ctx, defaultChecksGate(cx.env), baseTip, resolution);
      if (m.status === 'conflicts') {
        return fail(409, `the resolution still conflicts with ${row.change_base_ref} in ${m.conflicts.length} path(s)`, 'RESOLUTION_CONFLICTS', {
          conflicts: conflictViews(m.conflicts).conflicts,
        });
      }
      if (m.status !== 'clean' && m.status !== 'fast-forward' && m.status !== 'up-to-date') {
        return fail(422, `the resolution cannot be merged into ${row.change_base_ref} (${m.unknownReason ?? m.status})`, 'RESOLUTION_UNVERIFIABLE');
      }
      return { ok: true, value: { resolution, headTip: tips.get(headRef)! } };
    });
    if (!verified.ok) return verified;
    const { resolution, headTip } = verified.value;

    // The completion advances the head branch on the claimant's behalf: the claimant must be allowed to push it
    // (agent token grant and workspace ownership, as the git gate), and protection is read fresh.
    if (cx.actor?.agent) {
      const command = { ref: headRef, oldOid: oldHead, newOid: resolution };
      let denied = credentialMayUpdateRef(cx.actor, headRef) ? null : 'ref outside agent token grant';
      if (!denied && headRef.startsWith(WORKSPACE_REF_PREFIX)) denied = agentWorkspaceDenial(cx.actor, command, await workspaceOwners(cx.env, cx.repo.id, [command]));
      if (denied) return fail(403, `this token may not update the change's head branch ${headRef} (${denied})`, 'HEAD_REF_FORBIDDEN');
    }
    const [rulesRead, fenceNow, taskNow] = await db.batch([repoBranchRulesSelect(db, cx.repo.id), fenceSelect(db, id), detailSelect(db, cx.repo.id, id)]);
    const protectedBy = directPushDenial(((rulesRead?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow), headRef);
    if (protectedBy) {
      return fail(409, `the change's head branch ${headRef} is protected (${protectedBy}); completion cannot fast-forward it`, 'HEAD_REF_PROTECTED');
    }
    const current = first<TaskDetailRow>(taskNow);
    if (!current) return fail(404, 'task not found', 'TASK_NOT_FOUND');
    const lost = lifecycleRefusal(current) ?? fenceRefusal(current, first<FenceRow>(fenceNow), generation.value, who.value);
    if (lost) return lost;
    if (current.change_id !== changeId || (current.change_head_sha !== oldHead && current.change_head_sha !== resolution)) {
      return fail(409, `the change moved while the task was completed; retry`, 'HEAD_MOVED');
    }

    // The head branch moves first; the completion is recorded only once it points at the resolution, so a
    // failed update leaves the task claimed and the same completion retryable.
    if (headTip !== resolution) {
      const pushed = await deps.pusher(cx.env, cx.repo).updateRef({ ref: headRef, oldOid: oldHead, newOid: resolution });
      if (pushed.status !== 'ok') {
        const live = (await liveRefs(cx, [headRef])).get(headRef) ?? null;
        if (live !== resolution) {
          console.warn(JSON.stringify({ taskHeadBranch: { repo: cx.repo.id, task: id, ref: headRef, status: pushed.status, reason: pushed.reason } }));
          if (live !== oldHead) return fail(409, `the change's head branch ${headRef} moved; the task follows the new head shortly, retry then`, 'HEAD_MOVED');
          return fail(
            502,
            `the change's head branch ${headRef} could not be fast-forwarded to the resolution (${pushed.status}${pushed.reason ? `: ${pushed.reason}` : ''}); the task is still claimed by you, retry the completion`,
            'HEAD_UPDATE_FAILED',
          );
        }
      }
    }

    // The fence and the change's head are checked again inside the batch: the first statement lands only if both still hold.
    // The head branch's push event may already have reopened the change at the resolution (retiring the task).
    const now = Date.now();
    const landed = `EXISTS (SELECT 1 FROM agent_tasks t WHERE t.id = ?2 AND t.status = 'completed' AND t.completed_at = ?5 AND t.resolution_sha = ?3)`;
    const results = await db.batch([
      db
        .prepare(
          `UPDATE agent_tasks SET status = 'completed', resolution_sha = ?3, completed_by = ?4, completed_at = ?5, updated_at = ?5, lease_expires_at = NULL
            WHERE repo_id = ?1 AND id = ?2 AND generation = ?6
              AND EXISTS (SELECT 1 FROM fenced_claims f WHERE f.kind = '${FENCE_KIND}' AND f.subject = ?2 AND f.generation = ?6 AND f.owner = ?7 AND f.state = 'claimed')
              AND (
                (status = 'claimed' AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?8 AND c.state = 'conflicted' AND c.head_sha IN (?9, ?3)))
                OR (status IN ('claimed', 'obsolete') AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?8 AND c.state = 'open' AND c.head_sha = ?3))
              )`,
        )
        .bind(cx.repo.id, id, resolution, who.value.agent, now, generation.value, who.value.owner, changeId, oldHead),
      db
        .prepare(
          `UPDATE fenced_claims SET state = 'done', result = ?4, updated_at = ?5
            WHERE kind = '${FENCE_KIND}' AND subject = ?2 AND generation = ?1 AND owner = ?6 AND state = 'claimed' AND ${landed}`,
        )
        .bind(generation.value, id, resolution, JSON.stringify({ resolution }), now, who.value.owner),
      db
        .prepare(
          `UPDATE change_sets SET head_sha = ?3, state = 'open', conflicts = NULL, updated_at = ?5
            WHERE id = ?1 AND state IN ('conflicted', 'open') AND head_sha IN (?4, ?3) AND ${landed}`,
        )
        .bind(changeId, id, resolution, oldHead, now),
      detailSelect(db, cx.repo.id, id),
      changeSelect(db, cx.repo.id, row.change_number!),
    ]);
    const after = first<TaskDetailRow>(results[3]);
    let change = first<ChangeRow>(results[4]);
    if (!results[0]?.meta.changes || !after || !change) {
      if (after) {
        const lifecycle = lifecycleRefusal(after);
        if (lifecycle) return lifecycle;
        const [fence] = await db.batch([fenceSelect(db, id)]);
        const stale = fenceRefusal(after, first<FenceRow>(fence), generation.value, who.value);
        if (stale) return stale;
      }
      return fail(409, `the change moved while the task was completed; retry`, 'HEAD_MOVED');
    }

    const headBranch = { ref: headRef, updated: true };

    const claimantAttribution: AttributionInput = {
      agent: attribution?.agent ?? who.value.agent,
      session: attribution?.session ?? `forge:task/${id}`,
      promptHash: attribution?.promptHash ?? null,
      ...(attribution?.model !== undefined ? { model: attribution.model } : {}),
    };
    await attributeCommit(cx, deps.pusher(cx.env, cx.repo), resolution, claimantAttribution, { replace: attribution !== null });

    if (change.merge_policy === 'auto') {
      change = (await autoMerge({ env: cx.env, repo: cx.repo, actor: cx.actor, branchRules: cx.branchRules ?? [], waitUntil: cx.waitUntil }, change)) ?? change;
    }
    return { ok: true, value: { task: taskView(after, now), change: changeView(change), headBranch } };
  });
}
