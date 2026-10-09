/**
 * Merge queue and bounded integration train (architecture §4
 * services/queue.ts, §9, §11.4, STEER v2 §0.1/§0.3).
 *
 * Enqueue records an immutable candidate for one change in its repository +
 * target-ref partition (FIFO by enqueue sequence) and approves the change's
 * current head; it never touches git. A train run, started by a kick on the
 * `forge-events` queue (services/trainKick.ts), then works the partition:
 *
 *   1. It takes the partition's D1 run claim (one run at a time; a kick that
 *      arrives meanwhile marks the claim dirty so the holder makes another
 *      pass).
 *   2. It composes the first TRAIN_LIMITS.window active entries in order,
 *      each on top of the previous candidate's prepared result (speculation),
 *      and asks the checks-gate about each exact composed tree. Entries whose
 *      checks are pending wait in `checking` (at most runnerCapacity at a
 *      time) or `preparing`. A failing entry is ejected alone; the entries
 *      composed on it are recomposed without it.
 *   3. It publishes `ready` candidates from the head: revalidate the change
 *      (state, policy, approved head, workspace admission), the enqueuer's
 *      authority, branch rules and the checks-gate answer for the exact tree;
 *      then take the short generation-fenced publication lease
 *      (do/mergeLock.ts), push one ref with the expected old value, parse the
 *      report, read the ref back when the outcome is unknown, release the
 *      lease and only then record the change merged. Nothing slow runs under
 *      the lease.
 *
 * Every entry write names the generation it read, so a stale run can never
 * overwrite its successor. Waiting is driven by kicks (enqueue, dequeue, head
 * pushes, lease expiry, check completion) plus a bounded backoff, never by
 * polling the lease.
 */

import { decode, parseTree, type CommitInfo, type GitObject } from '@forge/gitops';
import type { AgentGrant } from '../auth/agentTokens';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { currentMeter, type CostCounters } from '../cost/meter';
import type { RepoRow } from '../db/repos';
import { toUserRow, type UserRow } from '../db/users';
import type { ServiceResult } from '../repos/service';
import { attributeMerge, mergeAttributionDefaults, parseAttributionInput, type AttributionInput } from './attribution';
import { credentialMayUpdateRef, isOrgRole, isRepoNeed, repoRole, type Actor } from './authz';
import { effectivePolicy, ruleFromRow, type BranchRule, type BranchRuleRow } from './branchRules';
import {
  HEAD_MOVED_HOOKS,
  MERGE_POLICIES,
  agentMergeDenial,
  branchPolicyBlock,
  branchRef,
  defaultMergeDeps,
  fail,
  guarded,
  headWorkspaceSelect,
  mergeRefusal,
  mergedRecordStatements,
  parseNumber,
  resolveCtx,
  workspaceAdmissionRefusal,
  type ChangeContext,
  type ChangeRow,
  type Fail,
  type HeadMoved,
  type HeadWorkspace,
  type MergePolicy,
} from './changes';
import type { ChecksGate, RequiredChecks } from './checksGate';
import { conflictRecord, markConflictedStatements } from './conflicts';
import type { GitPusher } from './gitwrite';
import { artifactsMergeSources, prepareMerge, type MergeSources, type PreparedMerge } from './merge';
import { RefStoreUnavailable, lsRefs, type ResolveContext } from './refs';
import { kickTrain } from './trainKick';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Train bounds. Internal configuration (tests lower the admission capacity
 * and runner capacity directly); there is no request-time switch.
 */
export const TRAIN_LIMITS = {
  /** Default speculation window: entries prepared ahead of publication. */
  window: 8,
  /** Prepared candidates whose checks may run at the same time. */
  runnerCapacity: 4,
  /** Active entries per repository; the next enqueue gets 429 with Retry-After. */
  admissionCapacity: 64,
  retryAfterSeconds: 30,
  /** Publication lease time-to-live. */
  leaseTtlMs: 30_000,
  /** How long one run holds the partition before another run may take it over. */
  runClaimMs: 300_000,
  /** Passes per run (each pass composes at most `window` entries). */
  maxPasses: 12,
  backoffBaseSeconds: 5,
  backoffMaxSeconds: 300,
  /** Backoff kicks for an entry before the train stops retrying on its own (a later kick resumes it). */
  maxAttempts: 6,
  listDefault: 50,
  listMax: 100,
};

export function backoffSeconds(attempts: number): number {
  return Math.min(TRAIN_LIMITS.backoffMaxSeconds, TRAIN_LIMITS.backoffBaseSeconds * 2 ** Math.max(0, attempts));
}

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export type QueueState = 'queued' | 'preparing' | 'checking' | 'ready' | 'publishing' | 'published' | 'ejected' | 'stale' | 'dequeued';

interface EntryRow {
  id: string;
  repo_id: string;
  target_ref: string;
  seq: number;
  change_set_id: string;
  change_number: number;
  state: QueueState;
  active: number;
  head_sha: string;
  merge_policy: MergePolicy;
  enqueued_by: string | null;
  enqueuer_login: string | null;
  agent_meta: string | null;
  attribution: string | null;
  enqueued_at: number;
  updated_at: number;
  base_sha: string | null;
  tree_sha: string | null;
  config_id: string | null;
  checks_state: string | null;
  generation: number;
  attempts: number;
  retry_at: number | null;
  lease_generation: number | null;
  merge_commit: string | null;
  previous_sha: string | null;
  reason_code: string | null;
  reason: string | null;
  cost: string | null;
}

const ENTRY_COLUMNS = `q.id, q.repo_id, q.target_ref, q.seq, q.change_set_id, q.change_number, q.state, q.active, q.head_sha,
  q.merge_policy, q.enqueued_by, q.enqueuer_login, q.agent_meta, q.attribution, q.enqueued_at, q.updated_at, q.base_sha,
  q.tree_sha, q.config_id, q.checks_state, q.generation, q.attempts, q.retry_at, q.lease_generation, q.merge_commit,
  q.previous_sha, q.reason_code, q.reason, q.cost`;
const RETURNING_COLUMNS = ENTRY_COLUMNS.replace(/\bq\./g, '');

export interface QueueEntryView {
  id: string;
  number: number;
  /** 1-based place in its target branch's train; null outside a list. */
  position: number | null;
  state: QueueState;
  target: string;
  headSha: string;
  mergePolicy: MergePolicy;
  enqueuedBy: string | null;
  agent: { id: string; name: string } | null;
  enqueuedAt: string;
  updatedAt: string;
  /** Exact composition identity of the last preparation (base, composed tree, check config and state). */
  composition: { baseSha: string; treeSha: string; configId: string | null; checks: string | null } | null;
  generation: number;
  attempts: number;
  reason: { code: string; message: string | null } | null;
  mergeCommit: string | null;
  cost?: unknown;
}

const iso = (ms: number) => new Date(ms).toISOString();
const branchName = (ref: string) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref);

function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function entryView(r: EntryRow, position: number | null = null): QueueEntryView {
  const agent = parseJson<{ agentId: string; agentName: string }>(r.agent_meta);
  const view: QueueEntryView = {
    id: r.id,
    number: r.change_number,
    position,
    state: r.state,
    target: branchName(r.target_ref),
    headSha: r.head_sha,
    mergePolicy: r.merge_policy,
    enqueuedBy: r.enqueuer_login,
    agent: agent ? { id: agent.agentId, name: agent.agentName } : null,
    enqueuedAt: iso(r.enqueued_at),
    updatedAt: iso(r.updated_at),
    composition: r.base_sha && r.tree_sha ? { baseSha: r.base_sha, treeSha: r.tree_sha, configId: r.config_id, checks: r.checks_state } : null,
    generation: r.generation,
    attempts: r.attempts,
    reason: r.reason_code ? { code: r.reason_code, message: r.reason } : null,
    mergeCommit: r.merge_commit,
  };
  if (r.cost) view.cost = parseJson(r.cost);
  return view;
}

// ---------------------------------------------------------------------------
// Statements shared by every transition
// ---------------------------------------------------------------------------

const ACTIVE: readonly QueueState[] = ['queued', 'preparing', 'checking', 'ready', 'publishing'];

/**
 * Moves an active entry out of the train (ejected, stale), fenced by
 * generation. The merge_queue_leave trigger frees its admission slot.
 */
function exitStatement(
  db: D1Database,
  e: { repoId: string; id: string; generation: number },
  to: 'ejected' | 'stale',
  code: string,
  message: string,
  now: number,
  states: readonly QueueState[] = ACTIVE,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE merge_queue SET state = ?3, active = 0, generation = generation + 1, reason_code = ?4, reason = ?5, updated_at = ?6
        WHERE repo_id = ?8 AND id = ?1 AND generation = ?2 AND active = 1 AND state IN (SELECT value FROM json_each(?7))`,
    )
    .bind(e.id, e.generation, to, code, message.slice(0, 500), now, JSON.stringify(states), e.repoId);
}

// ---------------------------------------------------------------------------
// Publication lease client (do/mergeLock.ts)
// ---------------------------------------------------------------------------

export type LeaseAcquire =
  | { acquired: true; generation: number; expiresAt: number }
  | { acquired: false; holder: { owner: string; generation: number; expiresAt: number } | null; retryAfterMs: number };

export interface PublicationLease {
  acquire(owner: string, ttlMs: number): Promise<LeaseAcquire>;
  release(owner: string, generation: number): Promise<{ released: boolean; code?: string }>;
}

export function mergeLockLease(env: Env, repoId: string, ref: string): PublicationLease {
  const stub = () => env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(`${repoId}:${ref}`));
  const post = async (path: string, body: unknown) => {
    const res = await stub().fetch(`https://merge-lock${path}`, { method: 'POST', body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    async acquire(owner, ttlMs) {
      return (await post('/acquire', { owner, ttlMs, repoId, ref })) as LeaseAcquire;
    },
    async release(owner, generation) {
      return (await post('/release', { owner, generation })) as { released: boolean; code?: string };
    },
  };
}

// ---------------------------------------------------------------------------
// Train dependencies
// ---------------------------------------------------------------------------

/** What a run records about itself (tests read it as the lease/check timeline). */
export type TrainEvent =
  | { type: 'window'; pass: number; prepared: number; checking: number; states: Array<{ number: number; state: QueueState }> }
  | { type: 'checks'; number: number; treeSha: string; baseSha: string; state: string; leaseHeld: boolean; phase: 'prepare' | 'publish' }
  | { type: 'lease'; op: 'acquire' | 'release'; number: number; ok: boolean; generation: number | null }
  | { type: 'publish'; number: number; status: string; mergeCommit: string; previous: string; cost?: Partial<CostCounters> }
  | { type: 'transition'; number: number; to: QueueState; code?: string };

export interface TrainDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
  gate(env: Env): ChecksGate;
  lease(env: Env, repoId: string, ref: string): PublicationLease;
  kick(env: Env, repoId: string, ref: string, reason: string, delaySeconds?: number): Promise<void>;
  now(): number;
  observe?(e: TrainEvent): void;
}

export const defaultTrainDeps: TrainDeps = {
  pusher: defaultMergeDeps.pusher,
  gate: defaultMergeDeps.gate,
  lease: mergeLockLease,
  kick: (env, repoId, ref, reason, delaySeconds) => kickTrain(env, repoId, ref, reason, delaySeconds),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Enqueue, dequeue, list
// ---------------------------------------------------------------------------

type QueueFail = Fail & { retryAfter?: number; entry?: QueueEntryView; headSha?: string | null };

const SHA_RE = /^[0-9a-f]{40}$/;

interface EnqueueInput {
  headSha: string | null;
  mergePolicy: MergePolicy | null;
  attribution: AttributionInput | null;
}

function parseEnqueue(cx: ChangeContext, number: number, body: unknown): ServiceResult<EnqueueInput> {
  const out: EnqueueInput = { headSha: null, mergePolicy: null, attribution: null };
  if (body === undefined || body === null) return { ok: true, value: out };
  if (typeof body !== 'object' || Array.isArray(body)) return fail(400, 'body must be a JSON object {headSha?, mergePolicy?, attribution?}', 'INVALID_BODY');
  const b = body as Record<string, unknown>;
  if (b.headSha !== undefined && b.headSha !== null) {
    if (typeof b.headSha !== 'string' || !SHA_RE.test(b.headSha)) return fail(422, 'headSha must be a full 40-character commit SHA', 'INVALID_HEAD_SHA');
    out.headSha = b.headSha;
  }
  if (b.mergePolicy !== undefined && b.mergePolicy !== null) {
    if (typeof b.mergePolicy !== 'string' || !(MERGE_POLICIES as readonly string[]).includes(b.mergePolicy)) {
      return fail(422, 'mergePolicy must be review, auto or draft', 'INVALID_POLICY');
    }
    out.mergePolicy = b.mergePolicy as MergePolicy;
  }
  if (b.attribution !== undefined && b.attribution !== null) {
    if (typeof b.attribution !== 'object' || Array.isArray(b.attribution)) {
      return fail(422, 'attribution must be an object {agent?, session?, promptHash?, model?}', 'INVALID_ATTRIBUTION');
    }
    const parsed = parseAttributionInput(b.attribution, mergeAttributionDefaults(cx.actor, number));
    if (!parsed.ok) return fail(parsed.status, parsed.error, parsed.code ?? 'INVALID_ATTRIBUTION');
    out.attribution = parsed.value;
  }
  return { ok: true, value: out };
}

interface EnqueueReadRow {
  c_id: string;
  c_state: string;
  c_policy: MergePolicy;
  c_head: string | null;
  c_base: string;
  a_active: number | null;
}

export interface EnqueueOutcome {
  created: boolean;
  entry: QueueEntryView;
}

/**
 * POST changes/:number/enqueue {headSha?, mergePolicy?, attribution?}.
 * Enqueue is the explicit approval of the change's current head. One D1
 * statement on success: the guarded insert (open, not a draft, at the
 * expected head/policy, not already queued; its merge_queue_admit trigger
 * takes the admission slot or aborts it beyond capacity) returning the new
 * entry. A refusal or an already queued change costs one more read that
 * explains it (an already queued change returns its entry, never a
 * duplicate).
 */
export function enqueueChange(cx: ChangeContext, rawNumber: string, body: unknown, deps: Pick<TrainDeps, 'kick'> = defaultTrainDeps): Promise<ServiceResult<EnqueueOutcome>> {
  return guarded<EnqueueOutcome>(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const parsed = parseEnqueue(cx, number, body);
    if (!parsed.ok) return parsed;
    const input = parsed.value;
    const db = cx.env.DB;
    const id = crypto.randomUUID();
    const now = Date.now();
    const agent = cx.actor?.agent ? JSON.stringify({ agentId: cx.actor.agent.agentId, agentName: cx.actor.agent.agentName, tokenId: cx.actor.agent.tokenId }) : null;
    const seq = now * 1000 + Math.floor(Math.random() * 1000);
    let inserted: D1Result<EntryRow> | undefined;
    try {
      inserted = await db
        .prepare(
          `INSERT OR IGNORE INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, active, head_sha, merge_policy,
             enqueued_by, enqueuer_login, agent_meta, attribution, enqueued_at, updated_at, admission_capacity)
           SELECT ?3, c.repo_id, 'refs/heads/' || c.base_ref, ?12, c.id, c.number, 'queued', 1, c.head_sha, c.merge_policy,
                  ?4, ?5, ?6, ?7, ?8, ?8, ?11
             FROM change_sets c
            WHERE c.repo_id = ?1 AND c.number = ?2 AND c.state = 'open' AND c.merge_policy != 'draft' AND c.head_sha IS NOT NULL
              AND (?9 IS NULL OR c.head_sha = ?9) AND (?10 IS NULL OR c.merge_policy = ?10)
           RETURNING ${RETURNING_COLUMNS}`,
        )
        .bind(
          cx.repo.id,
          number,
          id,
          cx.actor?.user.id ?? null,
          cx.actor?.user.login ?? null,
          agent,
          input.attribution ? JSON.stringify(input.attribution) : null,
          now,
          input.headSha,
          input.mergePolicy,
          TRAIN_LIMITS.admissionCapacity,
          seq,
        )
        .all<EntryRow>();
    } catch (err) {
      if (!String(err).includes('FORGE_QUEUE_FULL')) throw err;
      inserted = undefined;
    }
    const created = inserted?.results?.[0];
    if (created) {
      // An agent token may approve a merge only into a ref it may update.
      const denied = agentMergeDenial(cx.actor, branchName(created.target_ref), 'merge');
      if (denied) {
        await exitStatement(db, { repoId: cx.repo.id, id, generation: 0 }, 'ejected', denied.code ?? 'AGENT_REF_FORBIDDEN', denied.error, Date.now(), ['queued']).run();
        return denied;
      }
      await deps.kick(cx.env, cx.repo.id, created.target_ref, 'enqueue').catch((err: unknown) => {
        console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
      });
      return { ok: true, value: { created: true, entry: entryView(created) } };
    }
    const row = await db
      .prepare(
        `SELECT c.id AS c_id, c.state AS c_state, c.merge_policy AS c_policy, c.head_sha AS c_head, c.base_ref AS c_base,
                a.active AS a_active, ${ENTRY_COLUMNS}
           FROM change_sets c
           LEFT JOIN merge_queue q ON q.change_set_id = c.id AND q.active = 1
           LEFT JOIN merge_admission a ON a.repo_id = c.repo_id
          WHERE c.repo_id = ?1 AND c.number = ?2`,
      )
      .bind(cx.repo.id, number)
      .first<EnqueueReadRow & Partial<EntryRow>>();
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (row.id) {
      const denied = agentMergeDenial(cx.actor, row.c_base, 'merge');
      if (denied) return denied;
      return { ok: true, value: { created: false, entry: entryView(row as EntryRow) } };
    }
    return refusal(row, input);
  });
}

function refusal(row: EnqueueReadRow, input: EnqueueInput): QueueFail {
  if (row.c_state === 'merged') return fail(409, 'the change is already merged', 'ALREADY_MERGED');
  if (row.c_state === 'closed') return fail(409, 'a closed change cannot be enqueued; reopen it first', 'CHANGE_CLOSED');
  if (row.c_state === 'conflicted') {
    return fail(409, 'the change has merge conflicts with its base; push a resolution (see GET tasks) and enqueue again', 'MERGE_CONFLICT');
  }
  if (row.c_state !== 'open') return fail(409, `a ${row.c_state} change cannot be enqueued`, 'CHANGE_NOT_OPEN');
  if (row.c_policy === 'draft') {
    return fail(409, 'the change is a draft (mergePolicy draft) and cannot be enqueued; set mergePolicy to review or auto', 'DRAFT');
  }
  if (!row.c_head) return fail(409, 'the change has no head commit', 'NO_HEAD');
  if (input.headSha !== null && row.c_head !== input.headSha) {
    return { ...fail(409, `the change's head is ${row.c_head}, not the expected ${input.headSha}; review the new head and enqueue again`, 'HEAD_MOVED'), headSha: row.c_head };
  }
  if (input.mergePolicy !== null && row.c_policy !== input.mergePolicy) {
    return fail(409, `the change's mergePolicy is ${row.c_policy}, not the expected ${input.mergePolicy}`, 'POLICY_CHANGED');
  }
  if ((row.a_active ?? 0) >= TRAIN_LIMITS.admissionCapacity) {
    return {
      ...fail(429, `the merge queue of this repository is full (${TRAIN_LIMITS.admissionCapacity} active entries); retry later`, 'QUEUE_FULL'),
      retryAfter: TRAIN_LIMITS.retryAfterSeconds,
    };
  }
  return fail(409, 'the change could not be enqueued; retry', 'ENQUEUE_CONFLICT');
}

export interface DequeueOutcome {
  number: number;
  dequeued: true;
  entry: QueueEntryView;
}

/**
 * DELETE changes/:number/enqueue. One guarded UPDATE takes the active entry
 * out of the train (an entry mid-publication cannot be dequeued; the
 * merge_queue_leave trigger frees its admission slot); a miss costs one
 * read that explains it. The change itself is untouched.
 */
export function dequeueChange(cx: ChangeContext, rawNumber: string, deps: Pick<TrainDeps, 'kick'> = defaultTrainDeps): Promise<ServiceResult<DequeueOutcome>> {
  return guarded<DequeueOutcome>(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const db = cx.env.DB;
    const now = Date.now();
    const row = await db
      .prepare(
        `UPDATE merge_queue SET state = 'dequeued', active = 0, generation = generation + 1, reason_code = 'DEQUEUED', reason = ?4, updated_at = ?3
          WHERE repo_id = ?1 AND id = (SELECT q.id FROM merge_queue q
                       WHERE q.change_set_id = (SELECT c.id FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2)
                         AND q.active = 1 AND q.state != 'publishing')
          RETURNING ${RETURNING_COLUMNS}`,
      )
      .bind(cx.repo.id, number, now, `dequeued by ${cx.actor?.user.login ?? 'unknown'}`)
      .first<EntryRow>();
    if (!row) {
      const why = await db
        .prepare(
          `SELECT c.id, (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS active_state
             FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2`,
        )
        .bind(cx.repo.id, number)
        .first<{ id: string; active_state: string | null }>();
      if (!why) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
      if (why.active_state === 'publishing') return fail(409, 'the change is being published and can no longer be dequeued', 'PUBLISHING');
      return fail(404, 'the change is not in the merge queue', 'NOT_QUEUED');
    }
    const entry = entryView(row);
    await deps.kick(cx.env, cx.repo.id, row.target_ref, 'dequeue').catch((err: unknown) => {
      console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
    });
    return { ok: true, value: { number, dequeued: true, entry } };
  });
}

export interface QueuePage {
  entries: QueueEntryView[];
  truncated: boolean;
  nextCursor: string | null;
  limits: { window: number; runnerCapacity: number; admissionCapacity: number };
}

interface Cursor {
  ref: string;
  seq: number;
  pos: number;
}

function encodeCursor(c: Cursor): string {
  return btoa(JSON.stringify(c)).replace(/=+$/, '');
}

function decodeCursor(raw: string): Cursor | null {
  try {
    const c = JSON.parse(atob(raw)) as Cursor;
    return typeof c.ref === 'string' && Number.isInteger(c.seq) && Number.isInteger(c.pos) ? c : null;
  } catch {
    return null;
  }
}

/**
 * GET queue?limit=&cursor=&base= — active entries of every target branch
 * (or one), in train order: one indexed range read of at most `limit`+1
 * rows, independent of history and of other partitions' length.
 */
export async function listQueue(env: Env, repo: RepoRow, q: { limit?: string; cursor?: string; base?: string }): Promise<ServiceResult<QueuePage>> {
  let limit = TRAIN_LIMITS.listDefault;
  if (q.limit !== undefined) {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > TRAIN_LIMITS.listMax) {
      return fail(400, `limit must be 1-${TRAIN_LIMITS.listMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let cursor: Cursor | null = null;
  if (q.cursor !== undefined && q.cursor !== '') {
    cursor = decodeCursor(q.cursor);
    if (!cursor) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
  }
  const base = q.base ? (q.base.startsWith('refs/heads/') ? q.base : branchRef(q.base)) : null;
  const rows =
    (
      await env.DB.prepare(
        `SELECT ${ENTRY_COLUMNS} FROM merge_queue q
          WHERE q.repo_id = ?1 AND q.active = 1 AND (?2 IS NULL OR q.target_ref = ?2)
            AND (?3 IS NULL OR (q.target_ref, q.seq) > (?3, ?4))
          ORDER BY q.target_ref, q.seq LIMIT ?5`,
      )
        .bind(repo.id, base, cursor?.ref ?? null, cursor?.seq ?? 0, limit + 1)
        .all<EntryRow>()
    ).results ?? [];
  const page = rows.slice(0, limit);
  let pos = cursor?.pos ?? 0;
  let ref = cursor?.ref ?? null;
  const entries = page.map((r) => {
    if (r.target_ref !== ref) {
      ref = r.target_ref;
      pos = 0;
    }
    pos += 1;
    return entryView(r, pos);
  });
  const last = page[page.length - 1];
  return {
    ok: true,
    value: {
      entries,
      truncated: rows.length > limit,
      nextCursor: rows.length > limit && last ? encodeCursor({ ref: last.target_ref, seq: last.seq, pos }) : null,
      limits: { window: TRAIN_LIMITS.window, runnerCapacity: TRAIN_LIMITS.runnerCapacity, admissionCapacity: TRAIN_LIMITS.admissionCapacity },
    },
  };
}

// ---------------------------------------------------------------------------
// Speculative composition
// ---------------------------------------------------------------------------

function parseCommitObject(o: GitObject): CommitInfo {
  const text = decode(o.raw.subarray(o.raw.indexOf(0) + 1));
  const head = text.split('\n\n')[0] ?? '';
  return {
    treeHash: /^tree ([0-9a-f]{40})$/m.exec(head)?.[1] ?? '',
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
  };
}

/** Merge inputs that also see prepared, not yet published candidates (their commits, trees and blobs). */
function overlaySources(inner: MergeSources, objects: Map<string, GitObject>): MergeSources {
  return {
    async readCommit(sha) {
      const o = objects.get(sha);
      return o?.type === 'commit' ? parseCommitObject(o) : inner.readCommit(sha);
    },
    async readTree(hash) {
      const o = objects.get(hash);
      return o?.type === 'tree' ? parseTree(o.raw) : inner.readTree(hash);
    },
    async readBlob(hash) {
      const o = objects.get(hash);
      return o?.type === 'blob' ? o.raw.slice(o.raw.indexOf(0) + 1) : inner.readBlob(hash);
    },
  };
}

// ---------------------------------------------------------------------------
// Train run
// ---------------------------------------------------------------------------

interface WindowRow extends EntryRow {
  c_state: string;
  c_policy: MergePolicy;
  c_head: string | null;
  c_title: string;
  c_head_ref: string;
}

export interface TrainRunResult {
  state: 'idle' | 'busy' | 'waiting' | 'backoff' | 'unavailable' | 'done';
  passes: number;
  published: number[];
  ejected: Array<{ number: number; code: string }>;
  /** Largest number of prepared (preparing/checking/ready) entries in one pass. */
  maxPrepared: number;
  /** Largest number of entries checking at once. */
  maxChecking: number;
  retryAfterSeconds?: number;
}

interface RunClaim {
  owner: string;
  gen: number;
}

async function claimRun(db: D1Database, repoId: string, ref: string, owner: string, now: number): Promise<{ claim: RunClaim | null; until: number | null }> {
  const [, claimed, , read] = await db.batch([
    db.prepare('INSERT OR IGNORE INTO merge_trains (repo_id, target_ref, updated_at) VALUES (?1, ?2, ?3)').bind(repoId, ref, now),
    db
      .prepare(
        `UPDATE merge_trains SET runner = ?3, runner_gen = runner_gen + 1, runner_until = ?4, dirty = 0, updated_at = ?5
          WHERE repo_id = ?1 AND target_ref = ?2 AND (runner IS NULL OR runner_until <= ?5)
          RETURNING runner_gen`,
      )
      .bind(repoId, ref, owner, now + TRAIN_LIMITS.runClaimMs, now),
    db.prepare('UPDATE merge_trains SET dirty = 1 WHERE repo_id = ?1 AND target_ref = ?2 AND runner IS NOT ?3').bind(repoId, ref, owner),
    db.prepare('SELECT runner_until FROM merge_trains WHERE repo_id = ?1 AND target_ref = ?2').bind(repoId, ref),
  ]);
  const gen = (claimed?.results as Array<{ runner_gen: number }> | undefined)?.[0]?.runner_gen;
  const until = (read?.results as Array<{ runner_until: number | null }> | undefined)?.[0]?.runner_until ?? null;
  return { claim: gen === undefined ? null : { owner, gen }, until };
}

/** Releases the run claim unless a kick marked it dirty; then it stays held for another pass. */
async function finishRun(db: D1Database, repoId: string, ref: string, c: RunClaim, now: number, force = false): Promise<'released' | 'again' | 'lost'> {
  const [released, again] = await db.batch([
    db
      .prepare(
        `UPDATE merge_trains SET runner = NULL, runner_until = NULL, dirty = 0, updated_at = ?5
          WHERE repo_id = ?1 AND target_ref = ?2 AND runner = ?3 AND runner_gen = ?4 AND (dirty = 0 OR ?6 = 1)
          RETURNING 1 AS ok`,
      )
      .bind(repoId, ref, c.owner, c.gen, now, force ? 1 : 0),
    db
      .prepare(
        `UPDATE merge_trains SET dirty = 0, runner_until = ?5 + ?6, updated_at = ?5
          WHERE repo_id = ?1 AND target_ref = ?2 AND runner = ?3 AND runner_gen = ?4 AND dirty = 1
          RETURNING 1 AS ok`,
      )
      .bind(repoId, ref, c.owner, c.gen, now, TRAIN_LIMITS.runClaimMs),
  ]);
  if ((released?.results?.length ?? 0) > 0) return 'released';
  if ((again?.results?.length ?? 0) > 0) return 'again';
  return 'lost';
}

function windowStatements(db: D1Database, repoId: string, ref: string): D1PreparedStatement[] {
  return [
    db.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
    db
      .prepare(
        `SELECT b.id, b.pattern, b.required_checks, b.required_approvals, b.created_at, b.updated_at
           FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
      )
      .bind(repoId),
    db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}, c.state AS c_state, c.merge_policy AS c_policy, c.head_sha AS c_head, c.title AS c_title, c.head_ref AS c_head_ref
           FROM merge_queue q JOIN change_sets c ON c.id = q.change_set_id
          WHERE q.repo_id = ?1 AND q.active = 1 AND q.target_ref = ?2
          ORDER BY q.seq LIMIT ?3`,
      )
      .bind(repoId, ref, TRAIN_LIMITS.window),
  ];
}

interface Plan {
  e: WindowRow;
  /** The generation this pass's writes and claims name. */
  generation: number;
  headSha: string;
  next: QueueState;
  prepared?: PreparedMerge;
  checks?: RequiredChecks;
  code?: string;
  message?: string;
  /** False when this pass's guarded write for the entry did not apply. */
  current: boolean;
}

interface PassOutcome {
  progress: boolean;
  published: number[];
  ejected: Array<{ number: number; code: string }>;
  prepared: number;
  checking: number;
  waiting: boolean;
  retryAfterSeconds?: number;
  backoffAttempts?: number;
}

function enqueuerAuthor(e: EntryRow): { name: string; email: string } | undefined {
  const agent = parseJson<{ agentId: string; agentName: string }>(e.agent_meta);
  if (agent) return { name: agent.agentName, email: `${agent.agentId}@agents.forge.invalid` };
  if (e.enqueuer_login) return { name: e.enqueuer_login, email: `${e.enqueuer_login}@users.forge.invalid` };
  return undefined;
}

const EXIT_STATES: Partial<Record<string, 'ejected' | 'stale'>> = {
  ALREADY_MERGED: 'stale',
  HEAD_MOVED: 'stale',
  UP_TO_DATE: 'stale',
  BASE_KEPT_MOVING: 'stale',
};

async function trainPass(
  env: Env,
  ctx: ResolveContext,
  repo: RepoRow,
  rules: BranchRule[],
  ref: string,
  rows: WindowRow[],
  pass: number,
  owner: string,
  deps: TrainDeps,
): Promise<PassOutcome> {
  const db = env.DB;
  const now = deps.now();
  const out: PassOutcome = { progress: false, published: [], ejected: [], prepared: 0, checking: 0, waiting: false };
  const target = (await lsRefs(ctx, [ref])).get(ref) ?? null;
  const gate = deps.gate(env);
  const policy = effectivePolicy(rules, ref);
  const overlay = new Map<string, GitObject>();
  const sources = overlaySources(artifactsMergeSources(ctx), overlay);
  const plans: Plan[] = [];
  const writes: D1PreparedStatement[] = [];
  const writeOwners: Array<Plan | null> = [];
  const push = (plan: Plan | null, ...stmts: D1PreparedStatement[]) => {
    for (const s of stmts) {
      writes.push(s);
      writeOwners.push(plan);
    }
  };
  let base = target;
  let blocked = false;

  for (const e of rows) {
    const plan: Plan = { e, generation: e.generation, headSha: e.head_sha, next: e.state, current: true };
    plans.push(plan);
    const exit = (code: string, message: string) => {
      const to = EXIT_STATES[code] ?? 'ejected';
      plan.next = to;
      plan.code = code;
      plan.message = message;
      push(null, exitStatement(db, { repoId: e.repo_id, id: e.id, generation: plan.generation }, to, code, message, now));
      out.ejected.push({ number: e.change_number, code });
      out.progress = true;
      deps.observe?.({ type: 'transition', number: e.change_number, to, code });
    };

    if (e.state === 'publishing') {
      // A live publisher holds the lease; the partition waits for it (expiry is bounded by the lease TTL).
      if (now - e.updated_at < TRAIN_LIMITS.leaseTtlMs * 2) {
        blocked = true;
        out.waiting = true;
        out.retryAfterSeconds = Math.ceil((TRAIN_LIMITS.leaseTtlMs * 2 - (now - e.updated_at)) / 1000);
        continue;
      }
      // Its publisher is presumed dead: restore progress by recomposing the entry.
      push(
        null,
        db
          .prepare(
            `UPDATE merge_queue SET state = 'queued', generation = generation + 1, updated_at = ?3
              WHERE repo_id = ?4 AND id = ?1 AND generation = ?2 AND state = 'publishing'`,
          )
          .bind(e.id, e.generation, now, e.repo_id),
      );
      plan.generation += 1;
      plan.next = 'queued';
      out.progress = true;
    }
    if (blocked) continue;
    if (!target) {
      exit('BASE_NOT_FOUND', `base branch ${branchName(ref)} no longer exists`);
      continue;
    }
    if (e.c_state === 'merged') {
      exit('ALREADY_MERGED', 'the change was merged outside the queue');
      continue;
    }
    if (e.c_state === 'closed') {
      exit('CHANGE_CLOSED', 'the change was closed');
      continue;
    }
    if (e.c_policy === 'draft') {
      exit('DRAFT', 'the change became a draft (mergePolicy draft)');
      continue;
    }
    if (!e.c_head) {
      exit('NO_HEAD', 'the change has no head commit');
      continue;
    }
    if (e.c_head !== e.head_sha) {
      if (e.c_policy !== 'auto') {
        exit('HEAD_MOVED', `the change's head moved from the approved ${e.head_sha} to ${e.c_head}; enqueue again to approve the new head`);
        continue;
      }
      // An auto change needs no approval: the train follows its head.
      push(
        null,
        db
          .prepare(
            `UPDATE merge_queue SET head_sha = ?3, generation = generation + 1, attempts = 0, updated_at = ?4
              WHERE repo_id = ?5 AND id = ?1 AND generation = ?2 AND active = 1`,
          )
          .bind(e.id, plan.generation, e.c_head, now, e.repo_id),
      );
      plan.generation += 1;
      plan.headSha = e.c_head;
      out.progress = true;
    }

    if (out.prepared >= TRAIN_LIMITS.window) break;
    const p = await prepareMerge(sources, {
      targetSha: base!,
      headSha: plan.headSha,
      message: `Merge change #${e.change_number} from ${e.c_head_ref}\n\n${e.c_title}\n`,
      ...(enqueuerAuthor(e) ? { author: enqueuerAuthor(e)! } : {}),
    });
    if (!p.ok) {
      if (p.code === 'MERGE_READ_FAILED') throw new RefStoreUnavailable(p.error);
      if (base === target) {
        exit(p.code, p.error);
        if (p.code === 'MERGE_CONFLICT' && p.conflicts) {
          // Conflicts with the real base: the change becomes conflicted and its resolve-conflict task is dispatched.
          const record = conflictRecord({ status: 'conflicts', headSha: plan.headSha, targetSha: target, conflicts: p.conflicts });
          push(null, ...markConflictedStatements(db, e.change_set_id, record, now));
        }
        continue;
      }
      // It conflicts only with candidates ahead of it: wait until they publish, then compose on the real base.
      blocked = true;
      plan.next = 'queued';
      continue;
    }
    const checks = await gate.requiredChecksFor({ id: repo.id }, p.value.treeSha, null);
    deps.observe?.({ type: 'checks', number: e.change_number, treeSha: p.value.treeSha, baseSha: p.value.targetSha, state: checks.state, leaseHeld: false, phase: 'prepare' });
    const ruleBlock = branchPolicyBlock(policy, checks);
    if (checks.state === 'failure' || ruleBlock?.code === 'REQUIRED_CHECKS_FAILED') {
      exit('CHECKS_FAILED', ruleBlock?.error ?? 'a required check failed on the composed tree');
      continue;
    }
    if (ruleBlock?.code === 'APPROVALS_REQUIRED') {
      exit('APPROVALS_REQUIRED', ruleBlock.error);
      continue;
    }
    const pending = checks.state === 'pending' || ruleBlock?.code === 'REQUIRED_CHECKS_PENDING';
    if (pending) {
      if (out.checking < TRAIN_LIMITS.runnerCapacity) {
        out.checking += 1;
        plan.next = 'checking';
      } else {
        plan.next = 'preparing';
      }
    } else {
      plan.next = 'ready';
    }
    plan.prepared = p.value;
    plan.checks = checks;
    out.prepared += 1;
    for (const o of p.value.objects) overlay.set(o.hash, o);
    base = p.value.mergeCommit;
  }

  // Record this pass's compositions (one batch, every write fenced by generation).
  for (const plan of plans) {
    const e = plan.e;
    if (plan.next === 'ejected' || plan.next === 'stale') continue;
    const pv = plan.prepared;
    const changed =
      plan.next !== e.state ||
      plan.generation !== e.generation ||
      (pv ? pv.targetSha !== e.base_sha || pv.treeSha !== e.tree_sha || plan.checks?.state !== e.checks_state : e.base_sha !== null);
    if (!changed) continue;
    push(
      plan,
      db
        .prepare(
          `UPDATE merge_queue SET state = ?3, base_sha = ?4, tree_sha = ?5, config_id = ?6, checks_state = ?7, updated_at = ?8
            WHERE repo_id = ?9 AND id = ?1 AND generation = ?2 AND active = 1`,
        )
        .bind(e.id, plan.generation, plan.next, pv?.targetSha ?? null, pv?.treeSha ?? null, plan.checks?.configId ?? null, plan.checks?.state ?? null, now, e.repo_id),
    );
  }
  if (writes.length > 0) {
    const results = await db.batch(writes);
    results.forEach((r, i) => {
      const plan = writeOwners[i];
      if (plan && !r.meta.changes) plan.current = false;
    });
  }
  deps.observe?.({
    type: 'window',
    pass,
    prepared: out.prepared,
    checking: out.checking,
    states: plans.map((p) => ({ number: p.e.change_number, state: p.next })),
  });

  // Publish ready candidates from the head while each sits on the published tip.
  let tip = target;
  for (const plan of plans) {
    if (plan.next === 'ejected' || plan.next === 'stale') continue;
    if (plan.next !== 'ready' || !plan.prepared || !plan.current || plan.prepared.targetSha !== tip) {
      if (plan.next === 'checking' || plan.next === 'preparing') out.waiting = true;
      break;
    }
    const r = await publishCandidate(env, ctx, repo, ref, plan, owner, deps);
    if (r.kind === 'published') {
      out.published.push(plan.e.change_number);
      out.progress = true;
      tip = plan.prepared.mergeCommit;
      continue;
    }
    if (r.kind === 'exited') {
      out.ejected.push({ number: plan.e.change_number, code: r.code });
      out.progress = true;
    } else if (r.kind === 'busy') {
      out.retryAfterSeconds = r.retryAfterSeconds;
      out.backoffAttempts = plan.e.attempts;
    } else if (r.kind === 'retry') {
      out.retryAfterSeconds = backoffSeconds(plan.e.attempts);
      out.backoffAttempts = plan.e.attempts;
      if (plan.e.attempts < 1) out.progress = true;
    } else if (r.kind === 'pending') {
      out.waiting = true;
    } else {
      out.progress = true;
    }
    break;
  }
  return out;
}

type PublishResult =
  | { kind: 'published' }
  | { kind: 'exited'; code: string }
  | { kind: 'busy'; retryAfterSeconds: number }
  | { kind: 'retry' }
  | { kind: 'pending' }
  | { kind: 'lost' };

interface FactsRow extends Omit<UserRow, 'is_admin'> {
  is_admin: unknown;
  facts_org_role: unknown;
  facts_grant: unknown;
}

interface AgentRow {
  token_id: string;
  role: 'read' | 'write';
  refs: string;
  expires_at: number;
  revoked_at: number | null;
  repo_id: string;
  agent_id: string;
  agent_name: string;
  owner_login: string;
  owner_kind: 'user' | 'org';
  agent_revoked_at: number | null;
}

/** The enqueuer as an actor, with its current authority; null when it may no longer publish to `ref`. */
function enqueuerActor(repo: RepoRow, ref: string, facts: FactsRow | undefined, agentRow: AgentRow | undefined, e: EntryRow, now: number): { actor: Actor | null; denied: string | null } {
  if (!e.enqueued_by) return { actor: null, denied: null };
  if (!facts) return { actor: null, denied: 'the enqueuing user no longer exists' };
  const { facts_org_role, facts_grant, ...user } = facts;
  const actor: Actor = { user: toUserRow(user), via: 'pat', scopes: null };
  const role = repoRole(repo, actor, {
    ownerIsOrg: typeof repo.owner_org_id === 'string',
    orgRole: isOrgRole(facts_org_role) ? facts_org_role : null,
    grant: isRepoNeed(facts_grant) ? facts_grant : null,
  });
  if (role !== 'write' && role !== 'admin') return { actor, denied: `${user.login} no longer has write access to the repository` };
  const meta = parseJson<{ tokenId: string }>(e.agent_meta);
  if (meta) {
    if (!agentRow || agentRow.revoked_at !== null || agentRow.agent_revoked_at !== null || agentRow.expires_at <= now || agentRow.repo_id !== repo.id) {
      return { actor, denied: 'the enqueuing agent token was revoked or expired' };
    }
    const grant: AgentGrant = {
      agentId: agentRow.agent_id,
      agentName: agentRow.agent_name,
      ownerLogin: agentRow.owner_login,
      ownerKind: agentRow.owner_kind,
      tokenId: agentRow.token_id,
      repoId: agentRow.repo_id,
      role: agentRow.role,
      refs: parseJson<string[]>(agentRow.refs) ?? [],
      expiresAt: agentRow.expires_at,
    };
    actor.agent = grant;
    if (!credentialMayUpdateRef(actor, ref)) return { actor, denied: `the enqueuing agent token may not update ${ref}` };
  }
  return { actor, denied: null };
}

function meterSnapshot(): CostCounters | null {
  return currentMeter()?.snapshot() ?? null;
}

function costDelta(a: CostCounters | null, b: CostCounters | null): Partial<CostCounters> | undefined {
  if (!a || !b) return undefined;
  return { d1: b.d1 - a.d1, rr: b.rr - a.rr, rw: b.rw - a.rw, art: b.art - a.art, do: b.do - a.do, q: b.q - a.q, sub: b.sub - a.sub };
}

/**
 * Publishes one ready candidate: revalidate and claim (one batch), ask the
 * gate about the exact tree, take the lease, push one ref with the expected
 * old value, release, then record. The lease covers only the write
 * credential, the pack and the receive-pack exchange.
 */
async function publishCandidate(env: Env, ctx: ResolveContext, repo: RepoRow, ref: string, plan: Plan, owner: string, deps: TrainDeps): Promise<PublishResult> {
  const db = env.DB;
  const e = plan.e;
  const pv = plan.prepared!;
  const start = meterSnapshot();
  const now = deps.now();
  const claimedGen = plan.generation + 1;
  const agentMeta = parseJson<{ tokenId: string }>(e.agent_meta);
  const [claim, change, ws, facts, agentRes, rulesRes] = await db.batch([
    db
      .prepare(
        `UPDATE merge_queue SET state = 'publishing', generation = generation + 1, updated_at = ?3
          WHERE repo_id = ?4 AND id = ?1 AND generation = ?2 AND state = 'ready' AND active = 1 RETURNING generation`,
      )
      .bind(e.id, plan.generation, now, repo.id),
    db.prepare('SELECT id, number, state, merge_policy, head_sha, base_ref FROM change_sets WHERE id = ?').bind(e.change_set_id),
    headWorkspaceSelect(db, repo.id, e.change_number),
    db
      .prepare(
        `SELECT u.*,
                (SELECT m.role FROM org_members m WHERE m.org_id = ?2 AND m.user_id = u.id) AS facts_org_role,
                (SELECT g.role FROM repo_grants g WHERE g.repo_id = ?3 AND g.user_id = u.id) AS facts_grant
           FROM users u WHERE u.id = ?1`,
      )
      .bind(e.enqueued_by, repo.owner_org_id ?? null, repo.id),
    db
      .prepare(
        `SELECT t.id AS token_id, t.role, t.refs, t.expires_at, t.revoked_at, t.repo_id, a.id AS agent_id, a.name AS agent_name,
                a.owner_login, a.owner_kind, a.revoked_at AS agent_revoked_at
           FROM agent_tokens t JOIN agents a ON a.id = t.agent_id WHERE t.id = ?1`,
      )
      .bind(agentMeta?.tokenId ?? null),
    db
      .prepare(
        `SELECT b.id, b.pattern, b.required_checks, b.required_approvals, b.created_at, b.updated_at
           FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
      )
      .bind(repo.id),
  ]);
  if ((claim?.results?.length ?? 0) === 0) return { kind: 'lost' };
  const fenced = { repoId: repo.id, id: e.id, generation: claimedGen };
  const exit = async (code: string, message: string): Promise<PublishResult> => {
    const to = EXIT_STATES[code] ?? 'ejected';
    await exitStatement(db, fenced, to, code, message, deps.now(), ['publishing']).run();
    deps.observe?.({ type: 'transition', number: e.change_number, to, code });
    return { kind: 'exited', code };
  };
  const back = async (state: 'ready' | 'queued' | 'checking', attempts = 0): Promise<void> => {
    await db
      .prepare(
        `UPDATE merge_queue SET state = ?3, attempts = attempts + ?4, updated_at = ?5
          WHERE repo_id = ?6 AND id = ?1 AND generation = ?2 AND state = 'publishing'`,
      )
      .bind(e.id, claimedGen, state, attempts, deps.now(), repo.id)
      .run();
  };

  const row = (change?.results as ChangeRow[] | undefined)?.[0] ?? null;
  const refused = mergeRefusal(row, 'explicit', e.head_sha) ?? workspaceAdmissionRefusal(row!, (ws?.results as HeadWorkspace[] | undefined)?.[0] ?? null);
  if (refused) return exit(refused.code ?? 'REFUSED', refused.error);
  const who = enqueuerActor(repo, ref, (facts?.results as FactsRow[] | undefined)?.[0], (agentRes?.results as AgentRow[] | undefined)?.[0], e, now);
  if (who.denied) return exit('AUTHORIZATION_REVOKED', who.denied);
  const rules = ((rulesRes?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow);
  const checks = await deps.gate(env).requiredChecksFor({ id: repo.id }, pv.treeSha, null);
  deps.observe?.({ type: 'checks', number: e.change_number, treeSha: pv.treeSha, baseSha: pv.targetSha, state: checks.state, leaseHeld: false, phase: 'publish' });
  const block = branchPolicyBlock(effectivePolicy(rules, ref), checks);
  if (checks.state === 'failure' || block?.code === 'REQUIRED_CHECKS_FAILED') return exit('CHECKS_FAILED', block?.error ?? 'a required check failed on the composed tree');
  if (block?.code === 'APPROVALS_REQUIRED') return exit('APPROVALS_REQUIRED', block.error);
  if (checks.state === 'pending' || block) {
    await back('checking');
    return { kind: 'pending' };
  }

  const lease = deps.lease(env, repo.id, ref);
  const acq = await lease.acquire(owner, TRAIN_LIMITS.leaseTtlMs);
  deps.observe?.({ type: 'lease', op: 'acquire', number: e.change_number, ok: acq.acquired, generation: acq.acquired ? acq.generation : (acq.holder?.generation ?? null) });
  if (!acq.acquired) {
    await back('ready', 1);
    return { kind: 'busy', retryAfterSeconds: Math.max(1, Math.ceil(acq.retryAfterMs / 1000)) };
  }
  let status: string;
  try {
    const update = await deps.pusher(env, repo).prepareUpdate({ ref, oldOid: pv.targetSha, newOid: pv.mergeCommit }, pv.objects);
    const r = await update.send();
    status = r.status;
    if (r.status !== 'ok' && r.status !== 'stale' && r.status !== 'rejected') {
      // The update may have landed: the ref decides.
      const nowRef = (await lsRefs(ctx, [ref]).catch(() => new Map<string, string | null>())).get(ref);
      status = nowRef === pv.mergeCommit ? 'ok' : 'unknown';
    }
  } catch (err) {
    if (!(err instanceof RefStoreUnavailable)) {
      await lease.release(owner, acq.generation).catch(() => undefined);
      throw err;
    }
    status = 'unavailable';
  }
  const rel = await lease.release(owner, acq.generation).catch(() => ({ released: false }));
  deps.observe?.({ type: 'lease', op: 'release', number: e.change_number, ok: rel.released, generation: acq.generation });
  deps.observe?.({ type: 'publish', number: e.change_number, status, mergeCommit: pv.mergeCommit, previous: pv.targetSha });

  if (status === 'stale') {
    if (e.attempts + 1 >= TRAIN_LIMITS.maxAttempts) return exit('BASE_KEPT_MOVING', `${ref} kept moving during ${TRAIN_LIMITS.maxAttempts} publication attempts`);
    await back('queued', 1);
    return { kind: 'retry' };
  }
  if (status === 'rejected') return exit('PUBLISH_REJECTED', 'the git store rejected the update');
  if (status !== 'ok') {
    await back('queued', 1);
    return { kind: 'retry' };
  }

  const mergedAt = deps.now();
  const cost = costDelta(start, meterSnapshot());
  const recordCost = cost ? { ...cost, d1: (cost.d1 ?? 0) + 1 } : null;
  const [entryWrite, changeWrite] = await db.batch([
    db
      .prepare(
        `UPDATE merge_queue SET state = 'published', active = 0, merge_commit = ?3, previous_sha = ?4, lease_generation = ?5, cost = ?6,
                updated_at = ?7, reason_code = NULL, reason = NULL
          WHERE repo_id = ?8 AND id = ?1 AND generation = ?2 AND state = 'publishing'`,
      )
      .bind(e.id, claimedGen, pv.mergeCommit, pv.targetSha, acq.generation, recordCost ? JSON.stringify(recordCost) : null, mergedAt, repo.id),
    ...mergedRecordStatements(db, repo.id, { id: e.change_set_id, number: e.change_number }, { mergeCommit: pv.mergeCommit, targetSha: pv.targetSha, headSha: e.head_sha }, mergedAt),
  ]);
  if (!entryWrite?.meta.changes || !changeWrite?.meta.changes) {
    console.warn(JSON.stringify({ trainRecord: { repo: repo.id, number: e.change_number, mergeCommit: pv.mergeCommit, entry: entryWrite?.meta.changes, change: changeWrite?.meta.changes } }));
  }
  deps.observe?.({ type: 'publish', number: e.change_number, status: 'recorded', mergeCommit: pv.mergeCommit, previous: pv.targetSha, ...(cost ? { cost: recordCost! } : {}) });
  console.log(JSON.stringify({ trainPublished: { repo: repo.id, ref, number: e.change_number, kind: pv.kind, mergeCommit: pv.mergeCommit, leaseGeneration: acq.generation, cost: costDelta(start, meterSnapshot()) } }));
  if (pv.kind === 'merge') {
    // A Forge merge commit carries the enqueuing principal; a fast-forward publishes the author's commit untouched.
    const input = parseJson<AttributionInput>(e.attribution);
    await attributeMerge({ env, repo, actor: who.actor, waitUntil: ctx.waitUntil }, ctx.artifacts as LazyRepo, deps.pusher(env, repo), {
      changeNumber: e.change_number,
      mergeCommit: pv.mergeCommit,
      input,
    });
  }
  return { kind: 'published' };
}

/**
 * One train run for a repository + target-ref partition (the queue consumer
 * calls this for each kick). Bounded: at most `maxPasses` passes of at most
 * `window` compositions each; leftover work is re-kicked, waiting work is
 * re-kicked only with a bounded backoff.
 */
export async function runTrain(env: Env, repoId: string, ref: string, deps: TrainDeps = defaultTrainDeps): Promise<TrainRunResult> {
  const owner = crypto.randomUUID();
  const result: TrainRunResult = { state: 'idle', passes: 0, published: [], ejected: [], maxPrepared: 0, maxChecking: 0 };
  const { claim, until } = await claimRun(env.DB, repoId, ref, owner, deps.now());
  if (!claim) {
    result.state = 'busy';
    if (until !== null && until > deps.now()) {
      // The holder sees the dirty mark; a kick at its claim's expiry covers a holder that died.
      result.retryAfterSeconds = Math.ceil((until - deps.now()) / 1000) + 1;
      await deps.kick(env, repoId, ref, 'run-claim-expiry', result.retryAfterSeconds);
    }
    return result;
  }
  const waitUntil: Promise<unknown>[] = [];
  try {
    for (let pass = 0; pass < TRAIN_LIMITS.maxPasses; pass++) {
      result.passes = pass + 1;
      const [repoRes, rulesRes, windowRes] = await env.DB.batch(windowStatements(env.DB, repoId, ref));
      const repo = (repoRes?.results as RepoRow[] | undefined)?.[0];
      const rows = (windowRes?.results as WindowRow[] | undefined) ?? [];
      if (!repo || rows.length === 0) {
        const fin = await finishRun(env.DB, repoId, ref, claim, deps.now());
        if (fin === 'again') continue;
        result.state = result.published.length + result.ejected.length > 0 ? 'done' : 'idle';
        return result;
      }
      const rules = ((rulesRes?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow);
      let outcome: PassOutcome;
      try {
        outcome = await withLazyRepo(env, repo.artifacts_name, (artifacts) =>
          trainPass(env, resolveCtx({ env, repo, waitUntil: (p) => waitUntil.push(p) }, artifacts), repo, rules, ref, rows, pass, owner, deps),
        );
      } catch (err) {
        if (!(err instanceof RefStoreUnavailable)) throw err;
        await finishRun(env.DB, repoId, ref, claim, deps.now(), true);
        result.state = 'unavailable';
        result.retryAfterSeconds = backoffSeconds(1);
        await deps.kick(env, repoId, ref, 'storage-unavailable', result.retryAfterSeconds);
        return result;
      }
      result.published.push(...outcome.published);
      result.ejected.push(...outcome.ejected);
      result.maxPrepared = Math.max(result.maxPrepared, outcome.prepared);
      result.maxChecking = Math.max(result.maxChecking, outcome.checking);
      if (outcome.progress && outcome.retryAfterSeconds === undefined) continue;
      if (outcome.retryAfterSeconds !== undefined) {
        // Lease held elsewhere, a live publisher or a moved/unknown target: retry later with a bounded delay.
        await finishRun(env.DB, repoId, ref, claim, deps.now(), true);
        result.state = 'backoff';
        result.retryAfterSeconds = Math.min(TRAIN_LIMITS.backoffMaxSeconds, outcome.retryAfterSeconds);
        if ((outcome.backoffAttempts ?? 0) < TRAIN_LIMITS.maxAttempts) await deps.kick(env, repoId, ref, 'backoff', result.retryAfterSeconds);
        return result;
      }
      // No progress: the head waits for checks. Check completion kicks the train; a bounded backstop covers a lost kick.
      const fin = await finishRun(env.DB, repoId, ref, claim, deps.now());
      if (fin === 'again') continue;
      result.state = 'waiting';
      const head = rows[0]!;
      if (outcome.waiting && head.attempts < TRAIN_LIMITS.maxAttempts) {
        result.retryAfterSeconds = backoffSeconds(head.attempts);
        await env.DB.prepare('UPDATE merge_queue SET attempts = attempts + 1 WHERE repo_id = ?1 AND id = ?2 AND active = 1').bind(repoId, head.id).run();
        await deps.kick(env, repoId, ref, 'checks-backstop', result.retryAfterSeconds);
      }
      return result;
    }
    // Passes exhausted with work left: hand over to a fresh run.
    await finishRun(env.DB, repoId, ref, claim, deps.now(), true);
    result.state = 'done';
    await deps.kick(env, repoId, ref, 'continue');
    return result;
  } finally {
    await Promise.allSettled(waitUntil);
  }
}

/** Kicks every partition of a repo that has active entries (check producers call this when a check run completes). */
export async function kickRepoTrains(env: Env, repoId: string, reason: string, deps: Pick<TrainDeps, 'kick'> = defaultTrainDeps): Promise<number> {
  const rows =
    (await env.DB.prepare('SELECT DISTINCT target_ref FROM merge_queue WHERE repo_id = ? AND active = 1 LIMIT 20').bind(repoId).all<{ target_ref: string }>()).results ?? [];
  for (const r of rows) await deps.kick(env, repoId, r.target_ref, reason);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Head pushes of queued changes
// ---------------------------------------------------------------------------

/**
 * A push moved a queued change's head. Review approvals were for the old
 * head: the entry goes stale (enqueue again to approve the new head). An
 * auto change keeps its place and the train recomposes it on the new head.
 * Costs nothing for changes that are not queued.
 */
export async function onQueuedHeadMoved(e: HeadMoved, deps: Pick<TrainDeps, 'kick'> = defaultTrainDeps): Promise<void> {
  const queued = e.change.queuedHead;
  if (!queued || queued === e.headSha) return;
  const db = e.env.DB;
  const now = Date.now();
  const active = `SELECT q.id FROM merge_queue q WHERE q.change_set_id = ?1 AND q.active = 1 AND q.state != 'publishing'`;
  let ref: string | null;
  if (e.change.policy === 'auto') {
    const row = await db
      .prepare(
        `UPDATE merge_queue SET head_sha = ?2, state = 'queued', generation = generation + 1, attempts = 0, base_sha = NULL, tree_sha = NULL,
                checks_state = NULL, updated_at = ?3
          WHERE repo_id = ?4 AND id = (${active}) RETURNING target_ref`,
      )
      .bind(e.change.id, e.headSha, now, e.repoId)
      .first<{ target_ref: string }>();
    ref = row?.target_ref ?? null;
  } else {
    const row = await db
      .prepare(
        `UPDATE merge_queue SET state = 'stale', active = 0, generation = generation + 1, reason_code = 'HEAD_MOVED',
                reason = ?3, updated_at = ?2
          WHERE repo_id = ?4 AND id = (${active}) RETURNING target_ref`,
      )
      .bind(e.change.id, now, `the head moved from the approved ${queued} to ${e.headSha}; enqueue again to approve the new head`, e.repoId)
      .first<{ target_ref: string }>();
    ref = row?.target_ref ?? null;
  }
  if (ref) await deps.kick(e.env, e.repoId, ref, 'head-moved');
}

HEAD_MOVED_HOOKS.push((e) => onQueuedHeadMoved(e));
