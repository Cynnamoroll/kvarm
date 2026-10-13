/**
 * Merge queue and bounded integration train (architecture §4
 * services/queue.ts, §9, §11.4, STEER v2 §0.1/§0.3).
 *
 * Enqueue records an immutable candidate for one change in its repository +
 * target-ref partition (FIFO by enqueue sequence) and approves the change's
 * current head; it never touches git. A train run, started by a kick on the
 * `kvarm-events` queue (services/trainKick.ts), then works the partition:
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
 *      (do/mergeLock.ts) and record the publication intent with the claim,
 *      push one ref with the expected old value, parse the report, record
 *      the change merged in one batch that resolves the intent, and release
 *      the lease. An unknown outcome is reconciled from the actual ref, now
 *      or by a later pass after a crash. Nothing slow runs under the lease.
 *
 * Every entry write names the generation it read, so a stale run can never
 * overwrite its successor. Waiting is driven by kicks (enqueue, dequeue, head
 * pushes, lease expiry, check completion) plus a bounded backoff, never by
 * polling the lease.
 */

import { ZERO_OID, isAncestor, type CommitReader, type GitObject } from '@kvarm/gitops';
import type { AgentGrant } from '../auth/agentTokens';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { CostSpan, currentMeter, withCostSpan, type CostCounters } from '../cost/meter';
import type { RepoRow } from '../db/repos';
import { toUserRow, type UserRow } from '../db/users';
import type { ServiceResult } from '../repos/service';
import { attributeMerge, mergeAttributionDefaults, parseAttributionInput, type AttributionInput } from './attribution';
import { credentialMayUpdateRef, isOrgRole, isRepoNeed, repoRole, type Actor } from './authz';
import { BRANCH_RULE_COLUMNS, effectivePolicy, ruleFromRow, type BranchPolicy, type BranchRule, type BranchRuleRow } from './branchRules';
import {
  HEAD_MOVED_HOOKS,
  MERGE_POLICIES,
  agentMergeDenial,
  branchPolicyBlock,
  branchRef,
  defaultMergeDeps,
  dependencyRefusal,
  fail,
  guarded,
  liveHeadRefusal,
  memoGate,
  mergeRefusal,
  mergedRecordStatements,
  parseNumber,
  recordGuard,
  resolveCtx,
  resumeAutoDependents,
  reviewRefusal,
  workspaceAdmissionRefusal,
  type ChangeContext,
  type ChangeRow,
  type Fail,
  type HeadMoved,
  type MergePolicy,
} from './changes';
import { guardPending } from './checks';
import type { ChecksGate, RequiredChecks } from './checksGate';
import {
  blockFromRows,
  changeNumberDependenciesStatement,
  dependencyRowsStatement,
  dependencyView,
  ejectedSourceStatement,
  handOffSettlement,
  headWorkspacePins,
  headWorkspacePinsStatement,
  noBlockedPinCondition,
  pinsVerified,
  preservationRefusal,
  settleLanded,
  type DependencyBlock,
  type DependencyRow,
  type DependencyView,
  type HeadWorkspacePinRow,
  type LandedRow,
} from './dependencyGate';
import { conflictRecord, markConflictedStatements } from './conflicts';
import type { GitPusher } from './gitwrite';
import { artifactsMergeSources, overlaySources, prepareMerge, type MergeSources, type PreparedMerge } from './merge';
import { RefStoreUnavailable, lsRefs, type ResolveContext } from './refs';
import { parseReviewFacts, recordMissingEscalation, reviewFactsColumns, reviewGate, reviewGuardCondition, type ReviewFactsRow } from './reviewGate';
import { kickTrain } from './trainKick';
import { hasCiJobs, queueExactTreeCi, type CiConfigMemo } from './ci';

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
  /**
   * Entries a pass reads: the window plus room for entries that wait on a
   * pinned dependency (skipped without composing, never ejected).
   */
  readAhead: 16,
  backoffBaseSeconds: 5,
  backoffMaxSeconds: 300,
  /** Backoff kicks for an entry before the train stops retrying on its own (a later kick resumes it). */
  maxAttempts: 6,
  listDefault: 50,
  listMax: 100,
  /** Entries shown of the exit history (ejected, stale, dequeued), newest first. */
  exitsDefault: 20,
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
  principal: string | null;
}

const ENTRY_COLUMNS = `q.id, q.repo_id, q.target_ref, q.seq, q.change_set_id, q.change_number, q.state, q.active, q.head_sha,
  q.merge_policy, q.enqueued_by, q.enqueuer_login, q.agent_meta, q.attribution, q.enqueued_at, q.updated_at, q.base_sha,
  q.tree_sha, q.config_id, q.checks_state, q.generation, q.attempts, q.retry_at, q.lease_generation, q.merge_commit,
  q.previous_sha, q.reason_code, q.reason, q.cost, q.principal`;

/**
 * Per-principal fairness of one pass's read-ahead (arrival order in, train
 * order out). Entries already composed (preparing/checking/ready/publishing)
 * keep their place so earlier compositions stay valid; the queued rest is
 * ordered by (how many entries of the same principal precede it, arrival), so
 * a burst from one principal cannot hold another principal's entry behind
 * the whole burst. Each principal's own entries stay in arrival order, and
 * entries beyond the read-ahead keep plain arrival order.
 */
export function fairOrder<T extends { seq: number; state: string; principal: string | null; id: string }>(rows: readonly T[]): T[] {
  const inFlight = rows.filter((r) => r.state !== 'queued');
  const seen = new Map<string, number>();
  for (const r of inFlight) {
    const p = r.principal ?? `entry:${r.id}`;
    seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  const ranked = rows
    .filter((r) => r.state === 'queued')
    .map((r) => {
      const p = r.principal ?? `entry:${r.id}`;
      const rank = seen.get(p) ?? 0;
      seen.set(p, rank + 1);
      return { r, rank };
    })
    .sort((a, b) => a.rank - b.rank || a.r.seq - b.r.seq);
  return [...inFlight, ...ranked.map((x) => x.r)];
}
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
  /**
   * Called at each step of a publication and of its reconciliation, before
   * the step's effect is taken further. Tests inject faults here (a throw is
   * the Worker dying at that point); production passes nothing.
   */
  checkpoint?(step: PublicationCheckpoint, number: number): void | Promise<void>;
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
 * Enqueue is the explicit approval of the change's current head; it never
 * stands in for the reviews, escalations or human approvals the review gate
 * requires. One D1 statement on success in a repo without branch rules: the
 * guarded insert (open, not a draft, at the expected head/policy, not already
 * queued, review gate satisfied; its merge_queue_admit trigger takes the
 * admission slot or aborts it beyond capacity) returning the new entry. A
 * refusal or an already queued change costs one more batch that explains it
 * and reads the branch rules (an already queued change returns its entry,
 * never a duplicate); a repo with branch rules then retries the insert once
 * with the target's human requirement bound.
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
    const principal = cx.actor?.agent ? `agent:${cx.actor.agent.agentId}` : cx.actor ? `user:${cx.actor.user.id}` : null;
    const seq = now * 1000 + Math.floor(Math.random() * 1000);
    // `target` null: the branch rules are unread and the guard admits only a repo without rules.
    const tryInsert = async (target: BranchPolicy | null): Promise<EntryRow | 'full' | undefined> => {
      try {
        const res = await db
          .prepare(
            `INSERT OR IGNORE INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, active, head_sha, merge_policy,
               enqueued_by, enqueuer_login, agent_meta, attribution, enqueued_at, updated_at, admission_capacity, principal)
             SELECT ?3, c.repo_id, 'refs/heads/' || c.base_ref, ?12, c.id, c.number, 'queued', 1, c.head_sha, c.merge_policy,
                    ?4, ?5, ?6, ?7, ?8, ?8, ?11, ?15
               FROM change_sets c
              WHERE c.repo_id = ?1 AND c.number = ?2 AND c.state = 'open' AND c.merge_policy != 'draft' AND c.head_sha IS NOT NULL
                AND (?9 IS NULL OR c.head_sha = ?9) AND (?10 IS NULL OR c.merge_policy = ?10)
                AND ${reviewGuardCondition('c', '?13', '?14')}
                AND ${noBlockedPinCondition('c')}
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
            target ? target.requiredApprovals : null,
            target?.protected ? 1 : 0,
            principal,
          )
          .all<EntryRow>();
        return res.results?.[0];
      } catch (err) {
        if (!String(err).includes('KVARM_QUEUE_FULL')) throw err;
        return 'full';
      }
    };
    const admitted = async (created: EntryRow): Promise<ServiceResult<EnqueueOutcome>> => {
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
    };
    const queueFull = (): QueueFail => ({
      ...fail(429, `the merge queue of this repository is full (${TRAIN_LIMITS.admissionCapacity} active entries); retry later`, 'QUEUE_FULL'),
      retryAfter: TRAIN_LIMITS.retryAfterSeconds,
    });
    const first = await tryInsert(null);
    if (first && first !== 'full') return admitted(first);
    const [readRes, rulesRes, pinsRes] = await db.batch([
      db
        .prepare(
          `SELECT c.id AS c_id, c.state AS c_state, c.merge_policy AS c_policy, c.head_sha AS c_head, c.base_ref AS c_base,
                  a.active AS a_active, ${ENTRY_COLUMNS}, ${reviewFactsColumns('c')}
             FROM change_sets c
             LEFT JOIN merge_queue q ON q.change_set_id = c.id AND q.active = 1
             LEFT JOIN merge_admission a ON a.repo_id = c.repo_id
            WHERE c.repo_id = ?1 AND c.number = ?2`,
        )
        .bind(cx.repo.id, number),
      db
        .prepare(
          `SELECT ${BRANCH_RULE_COLUMNS}
             FROM branch_rules b WHERE b.repo_id = ?1 LIMIT 50`,
        )
        .bind(cx.repo.id),
      changeNumberDependenciesStatement(db, cx.repo.id, number),
    ]);
    const row = (readRes?.results as (EnqueueReadRow & Partial<EntryRow> & ReviewFactsRow)[] | undefined)?.[0];
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    // An already queued change answers with its entry only while it could be enqueued now as the caller expects.
    const refused = refusal(row, input);
    if (refused) return refused;
    if (row.id) {
      const denied = agentMergeDenial(cx.actor, row.c_base, 'merge');
      if (denied) return denied;
      return { ok: true, value: { created: false, entry: entryView(row as EntryRow) } };
    }
    // A stale or broken pin keeps the change out of the queue; a pending one is admitted and waits in the train.
    const pinned = dependencyRefusal(pinsRes?.results as DependencyRow[] | undefined, 'enqueue');
    if (pinned) return pinned;
    // Enqueue approves the head for the merge policy; it never stands in for the reviews or the human a policy requires.
    const rules = ((rulesRes?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow);
    const target = effectivePolicy(rules, branchRef(row.c_base));
    const review = await reviewRefusal(cx.env, row.c_id, parseReviewFacts(row), target);
    if (review) return review;
    if (first === 'full' || (row.a_active ?? 0) >= TRAIN_LIMITS.admissionCapacity) return queueFull();
    // A repo with branch rules is admitted once the rules are known and its review gate holds.
    if (rules.length > 0) {
      const second = await tryInsert(target);
      if (second === 'full') return queueFull();
      if (second) return admitted(second);
    }
    return fail(409, 'the change could not be enqueued; retry', 'ENQUEUE_CONFLICT');
  });
}

function refusal(row: EnqueueReadRow, input: EnqueueInput): QueueFail | null {
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
  return null;
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

export interface TrainStatusEntry extends QueueEntryView {
  /** Why the entry cannot publish yet because of its pins (null: nothing to wait for). */
  waiting: { code: string; message: string; dependencies: string[] } | null;
  dependencies: DependencyView[];
}

export interface TrainStatus {
  entries: TrainStatusEntry[];
  /** Every pin of the listed entries' workspaces. */
  dependencies: DependencyView[];
  truncated: boolean;
  limits: QueuePage['limits'];
}

/**
 * GET train?base=&limit= — the live train with each entry's pins and the
 * reason it waits: one batch of two indexed reads (the active entries and
 * their workspaces' edges); never writes and never kicks.
 */
export async function trainStatus(env: Env, repo: RepoRow, q: { limit?: string; base?: string }): Promise<ServiceResult<TrainStatus>> {
  let limit = TRAIN_LIMITS.listDefault;
  if (q.limit !== undefined) {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > TRAIN_LIMITS.listMax) {
      return fail(400, `limit must be 1-${TRAIN_LIMITS.listMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  const base = q.base ? (q.base.startsWith('refs/heads/') ? q.base : branchRef(q.base)) : null;
  const db = env.DB;
  const live = `SELECT q.change_set_id FROM merge_queue q WHERE q.repo_id = ?1 AND q.active = 1 AND (?2 IS NULL OR q.target_ref = ?2)
                 ORDER BY q.target_ref, q.seq LIMIT ?3`;
  const [entriesRes, pinsRes] = await db.batch([
    db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM merge_queue q
          WHERE q.repo_id = ?1 AND q.active = 1 AND (?2 IS NULL OR q.target_ref = ?2)
          ORDER BY q.target_ref, q.seq LIMIT ?3`,
      )
      .bind(repo.id, base, limit + 1),
    dependencyRowsStatement(db, repo.id, { where: `w.change_set_id IN (${live})`, byChange: true, dependents: limit }, base, limit),
  ]);
  const rows = ((entriesRes?.results as EntryRow[] | undefined) ?? []).slice(0, limit);
  const pins = pinsByChange(pinsRes?.results as DependencyRow[] | undefined);
  const all: DependencyView[] = [];
  let pos = 0;
  let ref: string | null = null;
  const entries = rows.map((r): TrainStatusEntry => {
    if (r.target_ref !== ref) {
      ref = r.target_ref;
      pos = 0;
    }
    pos += 1;
    const edges = (pins.get(r.change_set_id) ?? []).map(dependencyView);
    all.push(...edges);
    const block = blockFromRows(pins.get(r.change_set_id), 'publish');
    return {
      ...entryView(r, pos),
      waiting: block ? { code: block.code, message: block.error, dependencies: block.dependencies.map((d) => d.id) } : null,
      dependencies: edges,
    };
  });
  return {
    ok: true,
    value: {
      entries,
      dependencies: all,
      truncated: (entriesRes?.results?.length ?? 0) > limit,
      limits: { window: TRAIN_LIMITS.window, runnerCapacity: TRAIN_LIMITS.runnerCapacity, admissionCapacity: TRAIN_LIMITS.admissionCapacity },
    },
  };
}

/** An entry that left the train without publishing, with the reason recorded on exit. */
export interface TrainExitView extends QueueEntryView {
  exitedAt: string;
}

export interface TrainExits {
  exits: TrainExitView[];
  truncated: boolean;
}

/**
 * GET train exits (the train view's history): entries of `ejected`, `stale`
 * and `dequeued` state, newest first — one indexed range scan over
 * idx_mq_exits, bounded by its limit, independent of the exit history's
 * length. Published entries stay out: landing is success, not an exit.
 */
export async function listTrainExits(env: Env, repo: RepoRow, q: { limit?: string; base?: string }): Promise<ServiceResult<TrainExits>> {
  let limit = TRAIN_LIMITS.exitsDefault;
  if (q.limit !== undefined) {
    if (!/^\d{1,3}$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > TRAIN_LIMITS.listMax) {
      return fail(400, `limit must be 1-${TRAIN_LIMITS.listMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  const base = q.base ? (q.base.startsWith('refs/heads/') ? q.base : branchRef(q.base)) : null;
  const rows =
    (
      await env.DB.prepare(
        `SELECT ${ENTRY_COLUMNS} FROM merge_queue q INDEXED BY idx_mq_exits
          WHERE q.repo_id = ?1 AND q.active = 0 AND q.state IN ('ejected', 'stale', 'dequeued')
            AND (?2 IS NULL OR q.target_ref = ?2)
          ORDER BY q.updated_at DESC LIMIT ?3`,
      )
        .bind(repo.id, base, limit + 1)
        .all<EntryRow>()
    ).results ?? [];
  return {
    ok: true,
    value: {
      exits: rows.slice(0, limit).map((r) => ({ ...entryView(r), exitedAt: iso(r.updated_at) })),
      truncated: rows.length > limit,
    },
  };
}

// ---------------------------------------------------------------------------
// Train run
// ---------------------------------------------------------------------------

interface WindowRow extends EntryRow, ReviewFactsRow {
  c_state: string;
  c_policy: MergePolicy;
  c_head: string | null;
  c_title: string;
  c_head_ref: string;
  /** The prepared commit the CI jobs of the recorded composed tree run on (null when none are queued). */
  ci_staged: string | null;
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
  /** Metered work of each pass (window read through its release or hand-off), when a cost meter is active. */
  passCosts?: Array<Partial<CostCounters>>;
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

/**
 * The entries a pass reads: the first readAhead entries in arrival order with
 * no unsatisfied pin, plus the first readAhead with one (they only record
 * their wait, since a pin that is not yet satisfied cannot clear within the
 * pass). Waiting dependents therefore never fill the window and hide a later
 * prerequisite or unrelated work. Bound as ?1 repo, ?2 target, ?3 readAhead.
 */
const WINDOW_IDS = (() => {
  const unsatisfied = `EXISTS (SELECT 1 FROM workspaces pw INDEXED BY idx_ws_change
      JOIN workspace_dependencies pd ON pd.repo_id = pw.repo_id AND pd.workspace_id = pw.id
     WHERE pw.change_set_id = q.change_set_id AND pw.repo_id = q.repo_id AND pd.satisfied_commit IS NULL)`;
  const part = (cond: string) =>
    `SELECT * FROM (SELECT q.id FROM merge_queue q WHERE q.repo_id = ?1 AND q.active = 1 AND q.target_ref = ?2 AND ${cond} ORDER BY q.seq LIMIT ?3)`;
  return `${part(`NOT ${unsatisfied}`)} UNION ALL ${part(unsatisfied)}`;
})();

function windowStatements(db: D1Database, repoId: string, ref: string): D1PreparedStatement[] {
  return [
    db.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
    db
      .prepare(
        `SELECT ${BRANCH_RULE_COLUMNS}
           FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
      )
      .bind(repoId),
    // ci_staged: the earliest CI job of the recorded tree (the staged commit). SQLite takes a bare column from the
    // MIN() row, which reads the (repo, tree) index range once instead of reading it and then sorting it.
    db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}, c.state AS c_state, c.merge_policy AS c_policy, c.head_sha AS c_head, c.title AS c_title, c.head_ref AS c_head_ref,
                ${reviewFactsColumns('c')},
                CASE WHEN q.tree_sha IS NOT NULL THEN
                  (SELECT head_sha FROM (SELECT j.head_sha, MIN(j.created_at) FROM ci_jobs j INDEXED BY idx_ci_jobs_tree
                    WHERE j.repo_id = q.repo_id AND j.tree_sha = q.tree_sha AND j.change_set_id = q.change_set_id))
                END AS ci_staged
           FROM merge_queue q JOIN change_sets c ON c.id = q.change_set_id
          WHERE q.id IN (${WINDOW_IDS})
          ORDER BY q.seq`,
      )
      .bind(repoId, ref, TRAIN_LIMITS.readAhead),
    // The pins of the entries read above (their workspaces' dependency edges with their states).
    dependencyRowsStatement(
      db,
      repoId,
      { where: `w.change_set_id IN (SELECT q.change_set_id FROM merge_queue q WHERE q.id IN (${WINDOW_IDS}))`, byChange: true, dependents: 2 * TRAIN_LIMITS.readAhead },
      ref,
      TRAIN_LIMITS.readAhead,
    ),
  ];
}

function pinsByChange(rows: readonly DependencyRow[] | undefined): Map<string, DependencyRow[]> {
  const out = new Map<string, DependencyRow[]>();
  for (const r of rows ?? []) {
    if (!r.ws_change_set_id) continue;
    const list = out.get(r.ws_change_set_id) ?? [];
    list.push(r);
    out.set(r.ws_change_set_id, list);
  }
  return out;
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
  /** The unresolved pin the entry waits on (it stays queued, skipped, never ejected). */
  wait?: DependencyBlock;
  /** Satisfied pins (id@revision) whose revision the prepared merge commit was checked to contain. */
  verifiedPins?: Set<string>;
  /** This exact prepared merge commit is retained by a temporary CI ref. */
  ciPrepared?: boolean;
  /** False when this pass's guarded write for the entry did not apply. */
  current: boolean;
  /** The entry's generation and state as stored right now (writes this pass already applied, not the batched ones). */
  stored: { generation: number; state: QueueState };
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
  /**
   * The entry a waiting pass charges its checks backstop to: the first entry
   * of the pass's (fair) order that does not wait on a pin, else the first
   * entry. A dependent waiting on an unlanded source can stay at the head
   * of arrival order indefinitely; charging it would spend the bounded
   * backstop budget for every entry behind it.
   */
  backstop?: { id: string; attempts: number };
}

function enqueuerAuthor(e: EntryRow): { name: string; email: string } | undefined {
  const agent = parseJson<{ agentId: string; agentName: string }>(e.agent_meta);
  if (agent) return { name: agent.agentName, email: `${agent.agentId}@agents.kvarm.invalid` };
  if (e.enqueuer_login) return { name: e.enqueuer_login, email: `${e.enqueuer_login}@users.kvarm.invalid` };
  return undefined;
}

/** Ejections that stick to the exact head (pins on it break; see ejectedSourceStatement). */
const EJECTS_PINS: ReadonlySet<string> = new Set(['MERGE_CONFLICT', 'CHECKS_FAILED', 'GUARD_INCOMPLETE']);

const EXIT_STATES: Partial<Record<string, 'ejected' | 'stale'>> = {
  ALREADY_MERGED: 'stale',
  HEAD_MOVED: 'stale',
  UP_TO_DATE: 'stale',
  BASE_KEPT_MOVING: 'stale',
};

/** States a pass records only after the entry was composed (and, with a CI config, staged) on its recorded base and tree. */
const PREPARED: ReadonlySet<QueueState> = new Set(['preparing', 'checking', 'ready']);

function stagedCommitMatches(
  c: { treeHash: string; parents: string[] } | null,
  pv: { targetSha: string; headSha: string; treeSha: string },
): boolean {
  return c !== null && c.treeHash === pv.treeSha && c.parents.length === 2 && c.parents[0] === pv.targetSha && c.parents[1] === pv.headSha;
}

async function trainPass(
  env: Env,
  ctx: ResolveContext,
  repo: RepoRow,
  rules: BranchRule[],
  ref: string,
  rows: WindowRow[],
  pins: Map<string, DependencyRow[]>,
  pass: number,
  owner: string,
  deps: TrainDeps,
  rejudged: Set<string>,
  configs: CiConfigMemo,
): Promise<PassOutcome> {
  const db = env.DB;
  const now = deps.now();
  const out: PassOutcome = { progress: false, published: [], ejected: [], prepared: 0, checking: 0, waiting: false };
  // One ls-refs round trip reads the target tip and every window entry's live head branch.
  const tips = await lsRefs(ctx, [ref, ...new Set(rows.map((r) => branchRef(r.c_head_ref)))]);
  const target = tips.get(ref) ?? null;
  // Publication re-asks about the tree it prepared in this pass; the memo answers without another lookup.
  const gate = memoGate(deps.gate(env));
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
  let reconciled = 0;

  for (const e of rows) {
    const plan: Plan = { e, generation: e.generation, headSha: e.head_sha, next: e.state, current: true, stored: { generation: e.generation, state: e.state } };
    plans.push(plan);
    const exit = (code: string, message: string) => {
      const to = EXIT_STATES[code] ?? 'ejected';
      plan.next = to;
      plan.code = code;
      plan.message = message;
      push(null, exitStatement(db, { repoId: e.repo_id, id: e.id, generation: plan.generation }, to, code, message, now));
      if (EJECTS_PINS.has(code)) {
        push(null, ejectedSourceStatement(db, e.repo_id, e.change_set_id, plan.headSha, code, now, { queueId: e.id, generation: plan.generation + 1 }));
      }
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
      // Its publisher is presumed dead. A bounded number of crashed publications is reconciled per pass; the rest wait.
      if (reconciled >= RECONCILE_LIMITS.perPass) {
        blocked = true;
        out.waiting = true;
        out.retryAfterSeconds ??= backoffSeconds(0);
        continue;
      }
      reconciled += 1;
      const intent = await pendingIntent(db, e);
      if (intent) {
        // The pass's one ls-refs already read the target: reconciliation reads no ref of its own.
        const r = await reconcileIntent(env, sources, e, intent, target, deps);
        out.progress = true;
        if (r.outcome === 'completed') {
          plan.next = 'published';
          if (r.recorded.entryWritten) {
            out.published.push(e.change_number);
            await afterReconciled(env, ctx, repo, e, intent, r.recorded, deps);
          }
          continue;
        }
        if (!r.applied) {
          // Another writer resolved it first: this pass leaves the entry alone and the next one reads what it became.
          blocked = true;
          out.waiting = true;
          continue;
        }
        if (r.exited) {
          plan.next = 'stale';
          plan.code = r.exited;
          out.ejected.push({ number: e.change_number, code: r.exited });
          continue;
        }
        // The abandonment wait (twice the lease TTL) was this attempt's backoff; the spent attempt counts from here on.
        e.attempts += 1;
        plan.generation = intent.generation + 1;
        plan.stored = { generation: plan.generation, state: 'queued' };
        plan.next = 'queued';
      } else {
        // No intent: the publisher died before it could send, so nothing was published. Recompose the entry.
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
    const headRef = branchRef(e.c_head_ref);
    const moved = liveHeadRefusal(headRef, plan.headSha, tips.get(headRef));
    if (moved) {
      if (e.c_policy !== 'auto') {
        exit('HEAD_MOVED', `${headRef} moved from the approved ${plan.headSha} to ${moved.headSha}; enqueue again to approve the new head`);
        continue;
      }
      // The auto change follows its new head once its push event records it (that event kicks the train); the partition waits until then.
      plan.next = 'queued';
      blocked = true;
      out.waiting = true;
      continue;
    }

    // Reviews and escalations of the head being composed; an unmet requirement ejects (review and enqueue again).
    const review = reviewGate(parseReviewFacts(e), policy);
    if (review.block) {
      for (const reason of review.missing) push(null, recordMissingEscalation(db, e.change_set_id, reason, now));
      exit(review.block.code, review.block.error);
      continue;
    }

    // An unresolved pin: the entry keeps its place and waits for its source; the entries behind it go on.
    const wait = blockFromRows(pins.get(e.change_set_id), 'publish');
    if (wait) {
      plan.next = 'queued';
      plan.wait = wait;
      out.waiting = true;
      continue;
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
      // Only with no batched write pending for the entry, so the record's fence names what is stored.
      // Every reconciliation that sends an entry back spends an attempt, so an entry with none has no intent to find.
      if (p.code === 'UP_TO_DATE' && base === target && plan.generation === plan.stored.generation && e.attempts > 0) {
        if (await lateLanding(env, ctx, repo, sources, plan, target, deps)) {
          plan.next = 'published';
          out.published.push(e.change_number);
          out.progress = true;
          continue;
        }
      }
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
      out.waiting = true;
      continue;
    }
    if (p.value.kind === 'merge') {
      const pv = p.value;
      const stagedIdentity = (sha: string) => sources.readCommit(sha).then((c) => stagedCommitMatches(c, pv));
      // An earlier pass composed exactly this (target, head, tree) under the same generation and staged it: its
      // prepared commit, staging ref and queued jobs still stand, and the head's config cannot have changed.
      const recorded =
        e.ci_staged !== null &&
        PREPARED.has(e.state) &&
        plan.generation === e.generation &&
        e.head_sha === pv.headSha &&
        e.base_sha === pv.targetSha &&
        e.tree_sha === pv.treeSha
          ? e.ci_staged
          : null;
      if (recorded !== null && (await stagedIdentity(recorded))) {
        plan.ciPrepared = true;
        pv.mergeCommit = recorded;
      } else {
        const configured = await hasCiJobs(env, repo.artifacts_name, pv.headSha, configs);
        if (!configured.ok) {
          exit(configured.code ?? 'INVALID_CI_CONFIG', configured.error);
          continue;
        }
        if (configured.value) {
          plan.ciPrepared = true;
          // Reuse the immutable prepared commit staged by an earlier pass. A
          // freshly prepared commit can have the same tree and parents but a
          // different timestamp, while the completed checks name the staged SHA.
          const checkRef = `refs/heads/kvarm-ci/${e.id}/${pv.treeSha}`;
          const live = (await lsRefs(ctx, [checkRef])).get(checkRef) ?? null;
          if (live !== null) {
            const expected =
              e.tree_sha === pv.treeSha
                ? e.ci_staged
                : await env.DB.prepare(
                    'SELECT head_sha FROM ci_jobs WHERE repo_id = ?1 AND change_set_id = ?2 AND tree_sha = ?3 ORDER BY created_at LIMIT 1',
                  )
                    .bind(repo.id, e.change_set_id, pv.treeSha)
                    .first<string>('head_sha');
            if (live !== expected || !(await stagedIdentity(live))) {
              throw new RefStoreUnavailable(`prepared CI ref ${checkRef} has an invalid commit identity`);
            }
            pv.mergeCommit = live;
          } else {
            const staged = await deps.pusher(env, repo).updateRef({ ref: checkRef, oldOid: ZERO_OID, newOid: pv.mergeCommit }, pv.objects);
            if (staged.status !== 'ok') throw new RefStoreUnavailable(`prepared CI ref could not be created: ${staged.reason ?? staged.status}`);
          }
          const queued = await queueExactTreeCi(env, repo, e.change_set_id, pv.headSha, pv.mergeCommit, pv.treeSha, configs);
          if (!queued.ok) {
            exit(queued.code ?? 'CI_QUEUE_FAILED', queued.error);
            continue;
          }
        }
      }
    }
    let kept: Awaited<ReturnType<typeof preservationRefusal>>;
    try {
      kept = await preservationRefusal(overlaySources(sources, new Map(p.value.objects.map((o) => [o.hash, o]))), pins.get(e.change_set_id), p.value.mergeCommit);
    } catch (err) {
      throw err instanceof RefStoreUnavailable ? err : new RefStoreUnavailable(`pin ancestry read failed: ${String(err).slice(0, 200)}`);
    }
    if (kept.refusal) {
      exit(kept.refusal.code, kept.refusal.error);
      continue;
    }
    plan.verifiedPins = kept.verified;
    const guardBase = await sources.readCommit(p.value.mergeBase);
    if (!guardBase) throw new RefStoreUnavailable(`merge base ${p.value.mergeBase} could not be read`);
    const subject = { changeId: e.change_set_id, headSha: p.value.headSha, guardBaseTree: guardBase.treeHash };
    const checks = await gate.requiredChecksFor({ id: repo.id }, p.value.treeSha, null, subject);
    deps.observe?.({ type: 'checks', number: e.change_number, treeSha: p.value.treeSha, baseSha: p.value.targetSha, state: checks.state, leaseHeld: false, phase: 'prepare' });
    const rejudgeKey = `${e.change_set_id}:${p.value.headSha}:${guardBase.treeHash}`;
    if (guardPending(checks) && !rejudged.has(rejudgeKey)) {
      // A head judged against an older merge base (its stacked base landed) is never judged again by a push.
      rejudged.add(rejudgeKey);
      ctx.waitUntil(
        recordGuard(env, repo.id, e.change_set_id, p.value.headSha, { rejudgeBaseTree: guardBase.treeHash })
          .then((r) => (r === 'recorded' ? deps.kick(env, repo.id, ref, 'guard-recorded') : undefined))
          .catch((err: unknown) => console.warn(JSON.stringify({ guardRejudgeFailed: { repo: repo.id, change: e.change_number, error: String(err).slice(0, 200) } }))),
      );
    }
    const ruleBlock = branchPolicyBlock(policy, checks);
    if (ruleBlock?.code === 'GUARD_INCOMPLETE' && checks.state !== 'failure') {
      exit('GUARD_INCOMPLETE', ruleBlock.error);
      continue;
    }
    if (checks.state === 'failure' || ruleBlock?.code === 'REQUIRED_CHECKS_FAILED') {
      exit('CHECKS_FAILED', ruleBlock?.error ?? 'a required check failed on the composed tree');
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
  const head = plans.find((p) => !p.wait) ?? plans[0];
  if (head) out.backstop = { id: head.e.id, attempts: head.e.attempts };

  // Record this pass's compositions (one batch, every write fenced by generation).
  for (const plan of plans) {
    const e = plan.e;
    if (plan.next === 'ejected' || plan.next === 'stale' || plan.next === 'published') continue;
    const pv = plan.prepared;
    const waitCode = plan.wait?.code ?? null;
    const changed =
      plan.next !== e.state ||
      plan.generation !== e.generation ||
      waitCode !== e.reason_code ||
      (plan.wait && plan.wait.error.slice(0, 500) !== e.reason) ||
      (pv ? pv.targetSha !== e.base_sha || pv.treeSha !== e.tree_sha || plan.checks?.state !== e.checks_state : e.base_sha !== null);
    if (!changed) continue;
    push(
      plan,
      db
        .prepare(
          `UPDATE merge_queue SET state = ?3, base_sha = ?4, tree_sha = ?5, config_id = ?6, checks_state = ?7, updated_at = ?8,
                  reason_code = ?10, reason = ?11
            WHERE repo_id = ?9 AND id = ?1 AND generation = ?2 AND active = 1`,
        )
        .bind(
          e.id,
          plan.generation,
          plan.next,
          pv?.targetSha ?? null,
          pv?.treeSha ?? null,
          plan.checks?.configId ?? null,
          plan.checks?.state ?? null,
          now,
          e.repo_id,
          waitCode,
          plan.wait ? plan.wait.error.slice(0, 500) : null,
        ),
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
    if (plan.next === 'ejected' || plan.next === 'stale' || plan.next === 'published' || plan.wait) continue;
    if (plan.next !== 'ready' || !plan.prepared || !plan.current || plan.prepared.targetSha !== tip) {
      if (plan.next === 'checking' || plan.next === 'preparing') out.waiting = true;
      break;
    }
    const span = new CostSpan();
    const r = await withCostSpan(span, () => publishCandidate(env, ctx, repo, rules, ref, plan, owner, deps, gate, span));
    if (r.kind === 'published') {
      out.published.push(plan.e.change_number);
      out.progress = true;
      // A publication reconciled under a later commit leaves the ref there: the next candidate recomposes on it.
      tip = r.tip ?? plan.prepared.mergeCommit;
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
    } else if (r.kind === 'unresolved') {
      // Not charged to the entry's attempts: this kick is what reconciles the pending intent.
      out.retryAfterSeconds = Math.ceil((TRAIN_LIMITS.leaseTtlMs * 2) / 1000) + 1;
    } else {
      out.progress = true;
    }
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Publication intents and reconciliation (architecture §11.4)
// ---------------------------------------------------------------------------

/** Events-ledger type of a publication whose outcome was decided from the actual ref. */
export const PUBLICATION_RECONCILED_EVENT = 'kvarm.queue.publication_reconciled';

export const RECONCILE_LIMITS = {
  /** Crashed publications one pass reconciles; more wait for the next pass. */
  perPass: 4,
  /** Commit reads per walk recognizing a publication under the current tip. */
  maxCommitReads: 64,
  /** Earlier reconciled intents of an entry checked for a late landing (one walk each at most). */
  lateIntents: 4,
  /**
   * A publisher does not send with less lease time left than this, so a
   * push in flight outlives its lease only when the send itself stalls (the
   * late-landing check covers that residual).
   */
  sendMarginMs: 5_000,
};

/** Steps a fault can be injected at (TrainDeps.checkpoint). */
export type PublicationCheckpoint = 'intent-recorded' | 'pushed' | 'recorded' | 'reconcile-decided';

type IntentState = 'pending' | 'published' | 'reconciled' | 'not_applied' | 'moved' | 'withdrawn';

interface IntentRow {
  repo_id: string;
  queue_id: string;
  generation: number;
  target_ref: string;
  old_sha: string;
  new_sha: string;
  head_sha: string;
  tree_sha: string;
  kind: 'fast-forward' | 'merge';
  attempt: number;
  lease_generation: number;
  ci_prepared: number;
  state: IntentState;
  observed_sha: string | null;
  created_at: number;
  resolved_at: number | null;
}

/**
 * Written in the claim's batch right after the claim, and only when the
 * claim updated its row (`changes()` names the statement before this one in
 * the batch's transaction), so the intent costs no extra read.
 */
function intentInsertStatement(db: D1Database, i: Omit<IntentRow, 'state' | 'observed_sha' | 'resolved_at'>): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO merge_publication_intents (repo_id, queue_id, generation, target_ref, old_sha, new_sha, head_sha, tree_sha, kind, attempt,
                                              lease_generation, ci_prepared, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
        WHERE changes() = 1
       ON CONFLICT DO NOTHING`,
    )
    .bind(i.repo_id, i.queue_id, i.generation, i.target_ref, i.old_sha, i.new_sha, i.head_sha, i.tree_sha, i.kind, i.attempt, i.lease_generation, i.ci_prepared, i.created_at);
}

/** Resolves a pending intent while its entry is still `publishing` at the intent's generation (put it before the entry's own write). */
function intentResolveStatement(db: D1Database, i: IntentRow, to: IntentState, observed: string | null, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE merge_publication_intents SET state = ?4, observed_sha = ?5, resolved_at = ?6
        WHERE repo_id = ?1 AND queue_id = ?2 AND generation = ?3 AND state = 'pending'
          AND EXISTS (SELECT 1 FROM merge_queue q WHERE q.repo_id = ?1 AND q.id = ?2 AND q.generation = ?3 AND q.state = 'publishing')`,
    )
    .bind(i.repo_id, i.queue_id, i.generation, to, observed, now);
}

/**
 * The ledger record of one reconciliation outcome (a CloudEvents envelope,
 * `processed_at` NULL until a delivery picks it up). Its id names the intent
 * and the outcome, so a repeated reconciliation can never record it twice;
 * it is written only when this batch resolved the intent to `state`.
 */
function reconciledEventStatement(
  db: D1Database,
  i: IntentRow,
  changeNumber: number,
  outcome: 'completed' | 'not_applied' | 'moved',
  state: IntentState,
  observed: string | null,
  now: number,
): D1PreparedStatement {
  const id = `pubrec:${i.queue_id}:${i.generation}:${outcome}`;
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, '${PUBLICATION_RECONCILED_EVENT}',
              json_object('specversion', '1.0', 'id', ?1, 'type', '${PUBLICATION_RECONCILED_EVENT}',
                          'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', ?2, 'time', ?3,
                          'datacontenttype', 'application/json',
                          'data', json_object('repo', r.owner_login || '/' || r.name, 'change', ?4, 'queueId', ?2, 'ref', ?5,
                                              'generation', ?6, 'attempt', ?7, 'oldSha', ?8, 'newSha', ?9, 'observedSha', ?10,
                                              'outcome', ?11)),
              NULL, ?12
         FROM repos r
        WHERE r.id = ?13
          AND EXISTS (SELECT 1 FROM merge_publication_intents i WHERE i.repo_id = ?13 AND i.queue_id = ?2 AND i.generation = ?6
                         AND i.state = ?14 AND i.resolved_at = ?12)
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, i.queue_id, iso(now), changeNumber, i.target_ref, i.generation, i.attempt, i.old_sha, i.new_sha, observed, outcome, now, i.repo_id, state);
}

interface Recorded {
  /** This call moved the entry to `published` (false: another writer already resolved it). */
  entryWritten: boolean;
  changeWritten: boolean;
  mergedAt: number;
  landed: LandedRow[] | undefined;
}

/**
 * Records a confirmed publication: the entry becomes `published`, the change
 * merged (pins satisfied, workspace retired), and the intent is resolved, in
 * one D1 batch fenced by the entry's generation and state. A second
 * recording of the same publication (a late publisher, a repeated
 * reconciliation) writes nothing.
 */
async function recordPublication(
  db: D1Database,
  e: EntryRow,
  i: IntentRow,
  fence: { generation: number; state: QueueState },
  via: { kind: 'push'; cost: Partial<CostCounters> | null } | { kind: 'reconcile'; observed: string | null },
  now: number,
  /** False only when the publisher read that no workspace is linked to the change (then no pin can need settling). */
  dependents = true,
): Promise<Recorded> {
  const reconciled = via.kind === 'reconcile';
  const record = mergedRecordStatements(
    db,
    e.repo_id,
    { id: e.change_set_id, number: e.change_number },
    { mergeCommit: i.new_sha, targetSha: i.old_sha, headSha: i.head_sha },
    now,
    { queueId: e.id, generation: fence.generation },
    { dependents },
  );
  const to: IntentState = reconciled ? 'reconciled' : 'published';
  const results = await db.batch([
    db
      .prepare(
        `UPDATE merge_queue SET state = 'published', active = 0, merge_commit = ?3, previous_sha = ?4, lease_generation = ?5, cost = ?6,
                updated_at = ?7, reason_code = ?10, reason = ?11
          WHERE repo_id = ?8 AND id = ?1 AND generation = ?2 AND state = ?9 AND active = 1`,
      )
      .bind(
        e.id,
        fence.generation,
        i.new_sha,
        i.old_sha,
        i.lease_generation,
        via.kind === 'push' && via.cost ? JSON.stringify(via.cost) : null,
        now,
        e.repo_id,
        fence.state,
        reconciled ? 'PUBLICATION_RECONCILED' : null,
        reconciled ? `the ref was found at this publication after its record was lost (attempt generation ${i.generation})` : null,
      ),
    db
      .prepare(
        `UPDATE merge_publication_intents SET state = ?4, observed_sha = ?5, resolved_at = ?6
          WHERE repo_id = ?1 AND queue_id = ?2 AND generation = ?3 AND state IN ('pending', 'not_applied', 'moved')
            AND EXISTS (SELECT 1 FROM merge_queue q WHERE q.repo_id = ?1 AND q.id = ?2 AND q.generation = ?7 AND q.state = 'published'
                           AND q.merge_commit = ?8 AND q.updated_at = ?6)`,
      )
      .bind(i.repo_id, i.queue_id, i.generation, to, reconciled ? via.observed : null, now, fence.generation, i.new_sha),
    ...record,
    ...(reconciled ? [reconciledEventStatement(db, i, e.change_number, 'completed', to, via.observed, now)] : []),
  ]);
  return {
    entryWritten: (results[0]?.meta.changes ?? 0) > 0,
    changeWritten: (results[2]?.meta.changes ?? 0) > 0,
    mergedAt: now,
    landed: dependents ? (results[1 + record.length]?.results as LandedRow[] | undefined) : undefined,
  };
}

function enqueuerFactsStatements(db: D1Database, repo: RepoRow, e: EntryRow): [D1PreparedStatement, D1PreparedStatement] {
  const agentMeta = parseJson<{ tokenId: string }>(e.agent_meta);
  return [
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
  ];
}

/** The enqueuer as an actor for a reconciled record's attribution (its authority no longer matters: the ref already moved). */
async function enqueuerOf(db: D1Database, repo: RepoRow, e: EntryRow, now: number): Promise<Actor | null> {
  const [facts, agent] = await db.batch(enqueuerFactsStatements(db, repo, e));
  return enqueuerActor(repo, e.target_ref, (facts?.results as FactsRow[] | undefined)?.[0], (agent?.results as AgentRow[] | undefined)?.[0], e, now).actor;
}

/**
 * What follows a recorded publication, whoever recorded it: pin settlement
 * of the landing, the merge commit's attribution note, and removal of the
 * temporary CI ref. Runs only for the writer that moved the entry to
 * `published`, so it runs once per publication, and never under the lease.
 * `actor` is asked for only when a merge commit is noted.
 */
async function afterPublication(
  env: Env,
  ctx: ResolveContext,
  repo: RepoRow,
  e: EntryRow,
  i: IntentRow,
  rec: Recorded,
  actor: () => Promise<Actor | null>,
  deps: TrainDeps,
): Promise<void> {
  await settleLanded(env.DB, artifactsMergeSources(ctx), repo.id, rec.landed, i.new_sha, {
    source: { changeSetId: e.change_set_id, mergedAt: rec.mergedAt },
    ref: i.target_ref,
    kick: (r, reason) => deps.kick(env, repo.id, r, reason),
    resume: (numbers) => resumeAutoDependents(env, repo.id, numbers, ctx.waitUntil),
    handOff: (msg) => handOffSettlement(env, msg),
    defer: ctx.waitUntil,
  });
  if (!rec.changeWritten) {
    console.warn(JSON.stringify({ trainRecord: { repo: repo.id, number: e.change_number, mergeCommit: i.new_sha, entry: rec.entryWritten, change: rec.changeWritten } }));
  }
  if (i.kind !== 'merge') return;
  // A Kvarm merge commit carries the enqueuing principal; a fast-forward publishes the author's commit untouched.
  await attributeMerge({ env, repo, actor: await actor(), waitUntil: ctx.waitUntil }, ctx.artifacts as LazyRepo, deps.pusher(env, repo), {
    changeNumber: e.change_number,
    mergeCommit: i.new_sha,
    input: parseJson<AttributionInput>(e.attribution),
  });
  if (i.ci_prepared === 1) {
    const checkRef = `refs/heads/kvarm-ci/${e.id}/${i.tree_sha}`;
    ctx.waitUntil(
      deps
        .pusher(env, repo)
        .updateRef({ ref: checkRef, oldOid: i.new_sha, newOid: ZERO_OID }, [])
        .then((r) => {
          if (r.status !== 'ok') console.warn(JSON.stringify({ ciPreparedRefCleanup: { repo: repo.id, ref: checkRef, status: r.status } }));
        })
        .catch((err) => console.warn(JSON.stringify({ ciPreparedRefCleanup: { repo: repo.id, ref: checkRef, error: String(err) } }))),
    );
  }
}

/**
 * The follow-up of a publication this caller completed by reconciliation
 * (`late`: recognized under a later tip). `actor`: the enqueuer the caller
 * already read; otherwise it is read when a merge commit is noted.
 */
async function afterReconciled(
  env: Env,
  ctx: ResolveContext,
  repo: RepoRow,
  e: EntryRow,
  i: IntentRow,
  rec: Recorded,
  deps: TrainDeps,
  late = false,
  actor?: Actor | null,
): Promise<void> {
  deps.observe?.({ type: 'publish', number: e.change_number, status: 'reconciled', mergeCommit: i.new_sha, previous: i.old_sha });
  console.log(JSON.stringify({ trainPublicationReconciled: { repo: repo.id, ref: i.target_ref, number: e.change_number, outcome: 'completed', generation: i.generation, ...(late ? { late } : {}) } }));
  await afterPublication(env, ctx, repo, e, i, rec, async () => (actor !== undefined ? actor : enqueuerOf(env.DB, repo, e, deps.now())), deps);
}

type Reconciled =
  | { outcome: 'completed'; recorded: Recorded }
  | { outcome: 'not_applied' | 'moved'; applied: boolean; exited: string | null };

/**
 * Decides a pending publication from the actual ref (`observed`, read by
 * the caller: one ref per intent). At the intent's new value, or with the
 * new value under it (a bounded walk: someone built on the landed
 * publication), the record is completed exactly like a confirmed push. At
 * its old value the push did not happen and the entry goes back to the
 * train with one more attempt. At any other value someone else moved the
 * ref, so the entry recomposes on it (or goes stale as BASE_KEPT_MOVING once
 * its attempts are spent, unless the walk was cut short) and nothing is
 * overwritten. Every write is fenced by the intent's generation, so a stale
 * or repeated reconciliation writes nothing. The caller runs the follow-up
 * of a completion it wrote (afterReconciled), outside any lease.
 */
async function reconcileIntent(env: Env, reader: CommitReader, e: EntryRow, i: IntentRow, observed: string | null, deps: TrainDeps): Promise<Reconciled> {
  const db = env.DB;
  let landed = observed === i.new_sha;
  let unverified = false;
  // A new value the store does not have was never published (its pack never arrived): no walk can find it.
  if (!landed && observed !== null && observed !== i.old_sha && (await reader.readCommit(i.new_sha)) !== null) {
    const v = await isAncestor(reader, i.new_sha, observed, { maxCommitReads: RECONCILE_LIMITS.maxCommitReads, concurrency: 4 });
    landed = v.ancestor;
    unverified = v.truncated;
  }
  await deps.checkpoint?.('reconcile-decided', e.change_number);
  if (landed) {
    const recorded = await recordPublication(db, e, i, { generation: i.generation, state: 'publishing' }, { kind: 'reconcile', observed }, deps.now());
    return { outcome: 'completed', recorded };
  }
  const outcome = observed === i.old_sha ? 'not_applied' : 'moved';
  // A walk cut short cannot rule out that the publication landed: the entry stays in the train, where a later
  // composition can still recognize it (lateLanding).
  const exhausted = outcome === 'moved' && !unverified && e.attempts + 1 >= TRAIN_LIMITS.maxAttempts;
  const now = deps.now();
  const why =
    outcome === 'not_applied'
      ? `the publication to ${i.target_ref} did not happen (the ref still holds ${i.old_sha}); retrying`
      : `${i.target_ref} was moved to ${observed ?? 'nothing'} by another writer before the publication was confirmed; recomposing`;
  const entryWrite = exhausted
    ? exitStatement(db, { repoId: e.repo_id, id: e.id, generation: i.generation }, 'stale', 'BASE_KEPT_MOVING', `${i.target_ref} kept moving during ${TRAIN_LIMITS.maxAttempts} publication attempts`, now, ['publishing'])
    : db
        .prepare(
          `UPDATE merge_queue SET state = 'queued', generation = generation + 1, attempts = attempts + 1, reason_code = ?3, reason = ?4, updated_at = ?5
            WHERE repo_id = ?6 AND id = ?1 AND generation = ?2 AND state = 'publishing'`,
        )
        .bind(e.id, i.generation, outcome === 'not_applied' ? 'PUBLICATION_NOT_APPLIED' : 'PUBLICATION_MOVED', why, now, e.repo_id);
  const [resolved] = await db.batch([
    intentResolveStatement(db, i, outcome, observed, now),
    entryWrite,
    reconciledEventStatement(db, i, e.change_number, outcome, outcome, observed, now),
  ]);
  const applied = (resolved?.meta.changes ?? 0) > 0;
  if (applied) {
    console.log(JSON.stringify({ trainPublicationReconciled: { repo: e.repo_id, ref: i.target_ref, number: e.change_number, outcome, generation: i.generation } }));
    if (exhausted) deps.observe?.({ type: 'transition', number: e.change_number, to: 'stale', code: 'BASE_KEPT_MOVING' });
  }
  return { outcome, applied, exited: applied && exhausted ? 'BASE_KEPT_MOVING' : null };
}

/** The pending intent of a `publishing` entry at its current generation, if its publisher wrote one. */
function pendingIntent(db: D1Database, e: EntryRow): Promise<IntentRow | null> {
  return db
    .prepare(`SELECT * FROM merge_publication_intents WHERE repo_id = ?1 AND queue_id = ?2 AND generation = ?3 AND state = 'pending'`)
    .bind(e.repo_id, e.id, e.generation)
    .first<IntentRow>();
}

/**
 * An entry whose head is already in the target may be its own publication
 * that landed after reconciliation saw the ref elsewhere (a push that
 * outlived its lease). Only intents reconciliation resolved from a ref read
 * qualify (`observed_sha` set); a definite `stale` or `rejected` reply proved
 * its push never applied. The newest few for this head and ref are checked:
 * a new value at or under the tip (a bounded walk each) completes that
 * record, exactly once.
 */
async function lateLanding(env: Env, ctx: ResolveContext, repo: RepoRow, sources: MergeSources, plan: Plan, tip: string, deps: TrainDeps): Promise<boolean> {
  const e = plan.e;
  const rows =
    (
      await env.DB.prepare(
        `SELECT * FROM merge_publication_intents
          WHERE repo_id = ?1 AND queue_id = ?2 AND state IN ('not_applied', 'moved') AND observed_sha IS NOT NULL AND target_ref = ?3 AND head_sha = ?4
          ORDER BY generation DESC LIMIT ?5`,
      )
        .bind(e.repo_id, e.id, e.target_ref, plan.headSha, RECONCILE_LIMITS.lateIntents)
        .all<IntentRow>()
    ).results ?? [];
  let found = rows.find((i) => i.new_sha === tip) ?? null;
  for (const i of found ? [] : rows) {
    if ((await isAncestor(sources, i.new_sha, tip, { maxCommitReads: RECONCILE_LIMITS.maxCommitReads, concurrency: 4 })).ancestor) {
      found = i;
      break;
    }
  }
  if (!found) return false;
  await deps.checkpoint?.('reconcile-decided', e.change_number);
  const recorded = await recordPublication(env.DB, e, found, plan.stored, { kind: 'reconcile', observed: tip }, deps.now());
  if (!recorded.entryWritten) return false;
  await afterReconciled(env, ctx, repo, e, found, recorded, deps, true);
  return true;
}

type PublishResult =
  | { kind: 'published'; tip?: string }
  | { kind: 'exited'; code: string }
  | { kind: 'busy'; retryAfterSeconds: number }
  | { kind: 'retry' }
  | { kind: 'pending' }
  /** Sent, but neither the reply nor a read-back settled it: the entry keeps its claim with the intent pending. */
  | { kind: 'unresolved' }
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

function spanSnapshot(span: CostSpan): CostCounters | null {
  return currentMeter() ? span.snapshot() : null;
}

function costDelta(a: CostCounters | null, b: CostCounters | null): Partial<CostCounters> | undefined {
  if (!a || !b) return undefined;
  return { d1: b.d1 - a.d1, rr: b.rr - a.rr, rw: b.rw - a.rw, art: b.art - a.art, do: b.do - a.do, q: b.q - a.q, sub: b.sub - a.sub };
}

/**
 * Publishes one ready candidate: ask the gate about the exact tree (no
 * lease), take the lease, prepare the push (write credential and pack),
 * then claim and revalidate in one batch: the change (state, policy, the
 * composed head, workspace admission), the enqueuer's authority, the current
 * branch rules against the gate's answer, reviews and pins. One ls-refs
 * confirms the target tip and the head branch; the publication intent is
 * recorded; then the one ref update with the expected old value, the record
 * (which resolves the intent in the same batch) and only then the release.
 * A reply that does not say ok, stale or rejected is never guessed at: the
 * ref is read back and the intent reconciled from it, or left pending for a
 * later pass when even that read fails. Every result write is fenced by the
 * claimed generation, so a publisher whose entry was reconciled meanwhile
 * records nothing. The lease covers the write credential, the pack, the
 * revalidation, the receive-pack exchange and the one record batch.
 */
async function publishCandidate(
  env: Env,
  ctx: ResolveContext,
  repo: RepoRow,
  rules: readonly BranchRule[],
  ref: string,
  plan: Plan,
  owner: string,
  deps: TrainDeps,
  gate: ChecksGate,
  span: CostSpan,
): Promise<PublishResult> {
  const db = env.DB;
  const e = plan.e;
  const pv = plan.prepared!;
  // The span, not the meter: an earlier publication's deferred wake may run on the same meter meanwhile.
  const start = spanSnapshot(span);
  const claimedGen = plan.generation + 1;
  // Before the claim the entry is `ready` at the pass's generation; after it, `publishing` at the claimed one.
  let fence = { generation: plan.generation, state: 'ready' as QueueState };
  // Written with the claim; any way out before the send withdraws it in the same batch as the entry's own write.
  let intent: IntentRow | null = null;
  let sent = false;
  const withdraw = (): D1PreparedStatement[] => (intent && !sent ? [intentResolveStatement(db, intent, 'withdrawn', null, deps.now())] : []);
  const exit = async (code: string, message: string, extra: D1PreparedStatement[] = withdraw()): Promise<PublishResult> => {
    const to = EXIT_STATES[code] ?? 'ejected';
    const out = exitStatement(db, { repoId: repo.id, id: e.id, generation: fence.generation }, to, code, message, deps.now(), [fence.state]);
    const pins = EJECTS_PINS.has(code) ? [ejectedSourceStatement(db, repo.id, e.change_set_id, plan.headSha, code, deps.now(), { queueId: e.id, generation: fence.generation + 1 })] : [];
    if (extra.length + pins.length > 0) await db.batch([...extra, out, ...pins]);
    else await out.run();
    deps.observe?.({ type: 'transition', number: e.change_number, to, code });
    return { kind: 'exited', code };
  };
  const backStatement = (state: 'ready' | 'queued' | 'checking', attempts = 0) =>
    db
      .prepare(
        `UPDATE merge_queue SET state = ?3, attempts = attempts + ?4, updated_at = ?5
          WHERE repo_id = ?6 AND id = ?1 AND generation = ?2 AND state = ?7`,
      )
      .bind(e.id, fence.generation, state, attempts, deps.now(), repo.id, fence.state);
  const back = async (state: 'ready' | 'queued' | 'checking', attempts = 0): Promise<void> => {
    const extra = withdraw();
    if (extra.length > 0) await db.batch([...extra, backStatement(state, attempts)]);
    else await backStatement(state, attempts).run();
  };

  const guardBase = await artifactsMergeSources(ctx).readCommit(pv.mergeBase);
  if (!guardBase) throw new RefStoreUnavailable(`merge base ${pv.mergeBase} could not be read`);
  const checks = await gate.requiredChecksFor(
    { id: repo.id },
    pv.treeSha,
    null,
    { changeId: e.change_set_id, headSha: pv.headSha, guardBaseTree: guardBase.treeHash },
  );
  deps.observe?.({ type: 'checks', number: e.change_number, treeSha: pv.treeSha, baseSha: pv.targetSha, state: checks.state, leaseHeld: false, phase: 'publish' });
  const checksVerdict = async (policy: BranchPolicy): Promise<PublishResult | null> => {
    const block = branchPolicyBlock(policy, checks);
    if (block?.code === 'GUARD_INCOMPLETE' && checks.state !== 'failure') return exit('GUARD_INCOMPLETE', block.error);
    if (checks.state === 'failure' || block?.code === 'REQUIRED_CHECKS_FAILED') return exit('CHECKS_FAILED', block?.error ?? 'a required check failed on the composed tree');
    if (checks.state === 'pending' || block) {
      await back('checking');
      return { kind: 'pending' };
    }
    return null;
  };
  const early = await checksVerdict(effectivePolicy(rules, ref));
  if (early) return early;

  const lease = deps.lease(env, repo.id, ref);
  const acq = await lease.acquire(owner, TRAIN_LIMITS.leaseTtlMs);
  deps.observe?.({ type: 'lease', op: 'acquire', number: e.change_number, ok: acq.acquired, generation: acq.acquired ? acq.generation : (acq.holder?.generation ?? null) });
  if (!acq.acquired) {
    await back('ready', 1);
    return { kind: 'busy', retryAfterSeconds: Math.max(1, Math.ceil(acq.retryAfterMs / 1000)) };
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    const rel = await lease.release(owner, acq.generation).catch(() => ({ released: false }));
    deps.observe?.({ type: 'lease', op: 'release', number: e.change_number, ok: rel.released, generation: acq.generation });
  };

  let status = 'unavailable';
  let who: { actor: Actor | null; denied: string | null } = { actor: null, denied: null };
  let linked = true;
  /** The ref read back after an inconclusive reply (undefined: not read, or the read failed). */
  let observed: string | null | undefined;
  let recorded: Recorded | null = null;
  let reconciled: Reconciled | null = null;
  try {
    let update: Awaited<ReturnType<GitPusher['prepareUpdate']>> | null = null;
    try {
      update = await deps.pusher(env, repo).prepareUpdate({ ref, oldOid: pv.targetSha, newOid: pv.mergeCommit }, pv.objects);
    } catch (err) {
      if (!(err instanceof RefStoreUnavailable)) throw err;
    }
    if (!update) {
      await release();
      await back('queued', 1);
      return { kind: 'retry' };
    }

    // Everything above may have taken a while: the claim and every publication fact are read now.
    // The change row carries its review facts, and the head workspace read carries its pins: each row is read once.
    // The publication intent is durable from the claim on, so a crash from here on is reconciled, never guessed at.
    const candidate: IntentRow = {
      repo_id: repo.id,
      queue_id: e.id,
      generation: claimedGen,
      target_ref: ref,
      old_sha: pv.targetSha,
      new_sha: pv.mergeCommit,
      head_sha: plan.headSha,
      tree_sha: pv.treeSha,
      kind: pv.kind,
      attempt: e.attempts,
      lease_generation: acq.generation,
      ci_prepared: plan.ciPrepared ? 1 : 0,
      state: 'pending',
      observed_sha: null,
      created_at: deps.now(),
      resolved_at: null,
    };
    const [claim, written, change, wsPins, facts, agentRes, rulesRes] = await db.batch([
      db
        .prepare(
          `UPDATE merge_queue SET state = 'publishing', generation = generation + 1, updated_at = ?3
            WHERE repo_id = ?4 AND id = ?1 AND generation = ?2 AND state = 'ready' AND active = 1 RETURNING generation`,
        )
        .bind(e.id, plan.generation, deps.now(), repo.id),
      intentInsertStatement(db, candidate),
      db
        .prepare(`SELECT c.id, c.number, c.state, c.merge_policy, c.head_sha, c.base_ref, ${reviewFactsColumns('c')} FROM change_sets c WHERE c.id = ?1`)
        .bind(e.change_set_id),
      // A change's head ref never changes, so the pass's read of it names the same workspace.
      headWorkspacePinsStatement(db, repo.id, branchRef(e.c_head_ref)),
      ...enqueuerFactsStatements(db, repo, e),
      db
        .prepare(
          `SELECT ${BRANCH_RULE_COLUMNS}
             FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
        )
        .bind(repo.id),
    ]);
    if ((claim?.results?.length ?? 0) === 0) {
      await release();
      return { kind: 'lost' };
    }
    fence = { generation: claimedGen, state: 'publishing' };
    if (!written?.meta.changes) {
      // Never send without a durable intent: the entry waits for the next pass instead.
      await release();
      await back('queued');
      return { kind: 'lost' };
    }
    intent = candidate;

    const row = (change?.results as Array<ChangeRow & ReviewFactsRow> | undefined)?.[0] ?? null;
    const { workspace: headWs, pins } = headWorkspacePins(wsPins?.results as HeadWorkspacePinRow[] | undefined);
    const refused = mergeRefusal(row, 'explicit', plan.headSha) ?? workspaceAdmissionRefusal(row!, headWs);
    if (refused) {
      await release();
      return exit(refused.code ?? 'REFUSED', refused.error);
    }
    // Pins sit on workspaces, and a workspace is only ever linked to a change opened from its own ref (neither a
    // workspace's ref nor a change's head ref ever changes). No workspace at the head ref: none is or can become linked,
    // so the landing has no pins to settle. A linked change keeps every pin statement: a pin can be written until the record.
    linked = headWs !== null;
    who = enqueuerActor(repo, ref, (facts?.results as FactsRow[] | undefined)?.[0], (agentRes?.results as AgentRow[] | undefined)?.[0], e, deps.now());
    if (who.denied) {
      await release();
      return exit('AUTHORIZATION_REVOKED', who.denied);
    }
    // Rules may have been raised or added since the pass: approvals and required checks are judged by the current ones.
    const policy = effectivePolicy(((rulesRes?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow), ref);
    const review = reviewGate(parseReviewFacts(row), policy);
    if (review.block) {
      await release();
      if (review.missing.length > 0) await db.batch(review.missing.map((reason) => recordMissingEscalation(db, e.change_set_id, reason, deps.now())));
      return exit(review.block.code, review.block.error);
    }
    // Publication waits on any pin that is not satisfied, whatever its source's state.
    if (pins.some((p) => !p.satisfied_commit) || !pinsVerified(pins, plan.verifiedPins ?? new Set())) {
      // A pin turned unresolved (or was repinned) since the pass: back to waiting in place (the next pass records why).
      await release();
      await back('queued');
      return { kind: 'lost' };
    }
    const late = await checksVerdict(policy);
    if (late) {
      await release();
      return late;
    }

    const headRef = branchRef(e.c_head_ref);
    let tips: Map<string, string | null> | null = null;
    try {
      tips = await lsRefs(ctx, [ref, headRef]);
    } catch (err) {
      if (!(err instanceof RefStoreUnavailable)) throw err;
    }
    const moved = tips ? liveHeadRefusal(headRef, plan.headSha, tips.get(headRef)) : null;
    if (moved) {
      await release();
      if (row!.merge_policy !== 'auto') return exit('HEAD_MOVED', `${headRef} moved from the approved ${plan.headSha} to ${moved.headSha}; enqueue again to approve the new head`);
      // The auto change follows its new head once its push event records it (that event kicks the train).
      await back('queued');
      return { kind: 'pending' };
    }
    if (!tips) {
      status = 'unavailable';
    } else if (tips.get(ref) !== pv.targetSha) {
      status = 'stale';
    } else if (Date.now() >= acq.expiresAt - Math.min(RECONCILE_LIMITS.sendMarginMs, TRAIN_LIMITS.leaseTtlMs / 2)) {
      // Too little lease left to send: a push should not outlive the lease that fences it. Nothing was sent, and
      // the slow preparation is not the entry's failure, so it costs no attempt.
      status = 'expiring';
    } else {
      await deps.checkpoint?.('intent-recorded', e.change_number);
      sent = true;
      try {
        status = (await update.send()).status;
      } catch (err) {
        // Whatever failed, the request may have reached the store: the ref decides.
        status = 'unknown';
        console.warn(JSON.stringify({ trainSendFailed: { repo: repo.id, number: e.change_number, error: String(err).slice(0, 200) } }));
      }
      await deps.checkpoint?.('pushed', e.change_number);
      if (status !== 'ok' && status !== 'stale' && status !== 'rejected') {
        status = 'unknown';
        try {
          observed = (await lsRefs(ctx, [ref])).get(ref) ?? null;
        } catch (err) {
          if (!(err instanceof RefStoreUnavailable)) throw err;
        }
      }
    }
    deps.observe?.({ type: 'publish', number: e.change_number, status, mergeCommit: pv.mergeCommit, previous: pv.targetSha });

    if (status === 'ok' && intent) {
      const cost = costDelta(start, spanSnapshot(span));
      // The record batch and the lease release that follows it belong to the publication's work.
      const recordCost = cost ? { ...cost, d1: (cost.d1 ?? 0) + 1, do: (cost.do ?? 0) + 1 } : null;
      recorded = await recordPublication(db, e, intent, fence, { kind: 'push', cost: recordCost }, deps.now(), linked);
      if (recorded.entryWritten) {
        await deps.checkpoint?.('recorded', e.change_number);
        deps.observe?.({ type: 'publish', number: e.change_number, status: 'recorded', mergeCommit: pv.mergeCommit, previous: pv.targetSha, ...(recordCost ? { cost: recordCost } : {}) });
      }
    } else if (status === 'unknown' && intent && observed !== undefined) {
      // One D1 batch (and at most one bounded walk) under the lease; its follow-up runs after the release.
      reconciled = await reconcileIntent(env, artifactsMergeSources(ctx), e, intent, observed, deps);
    }
  } catch (err) {
    if (!(err instanceof RefStoreUnavailable)) throw err;
    // Only reads fail this way (the send's own failures are caught above): once sent, a pending intent stays for reconciliation.
    if (!sent) status = 'unavailable';
  } finally {
    await release();
  }

  if (reconciled) {
    if (reconciled.outcome === 'completed') {
      if (!reconciled.recorded.entryWritten) return { kind: 'lost' };
      await afterReconciled(env, ctx, repo, e, intent!, reconciled.recorded, deps, false, who.actor);
      return { kind: 'published', ...(observed ? { tip: observed } : {}) };
    }
    if (reconciled.exited) return { kind: 'exited', code: reconciled.exited };
    // Not applied or moved: the entry is back in the train with one more attempt (or another writer resolved it first).
    return { kind: 'retry' };
  }
  if (sent && status === 'unknown') {
    // The ref could not be read back: the entry keeps its claim with the intent pending, and a later pass reconciles it.
    return { kind: 'unresolved' };
  }
  if (recorded) {
    if (!recorded.entryWritten) {
      // The entry was reconciled by another pass while this publisher waited: its fenced record wrote nothing, so it reports nothing.
      console.warn(JSON.stringify({ trainLateResult: { repo: repo.id, number: e.change_number, mergeCommit: pv.mergeCommit, generation: claimedGen } }));
      return { kind: 'lost' };
    }
    console.log(JSON.stringify({ trainPublished: { repo: repo.id, ref, number: e.change_number, kind: pv.kind, mergeCommit: pv.mergeCommit, leaseGeneration: acq.generation, cost: costDelta(start, spanSnapshot(span)) } }));
    // After the recorded publication cost above: a settlement intent (exceptional path only) is not publication work.
    await afterPublication(env, ctx, repo, e, intent!, recorded, async () => who.actor, deps);
    return { kind: 'published' };
  }

  // Nothing sent, or a definite answer from the store that the update did not apply: the intent resolves with the entry's own write.
  const settle = !sent ? withdraw() : [intentResolveStatement(db, intent!, status === 'stale' ? 'moved' : 'not_applied', null, deps.now())];
  if (status === 'stale') {
    if (e.attempts + 1 >= TRAIN_LIMITS.maxAttempts) return exit('BASE_KEPT_MOVING', `${ref} kept moving during ${TRAIN_LIMITS.maxAttempts} publication attempts`, settle);
    await db.batch([...settle, backStatement('queued', 1)]);
    return { kind: 'retry' };
  }
  if (status === 'rejected') return exit('PUBLISH_REJECTED', 'the git store rejected the update', settle);
  await db.batch([...settle, backStatement('queued', status === 'expiring' ? 0 : 1)]);
  return { kind: 'retry' };
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
  const rejudged = new Set<string>();
  const configs: CiConfigMemo = new Map();
  let passStart: CostCounters | null = null;
  const closePass = () => {
    const cost = costDelta(passStart, meterSnapshot());
    if (cost) (result.passCosts ??= []).push(cost);
    passStart = null;
  };
  try {
    for (let pass = 0; pass < TRAIN_LIMITS.maxPasses; pass++) {
      closePass();
      passStart = meterSnapshot();
      result.passes = pass + 1;
      const [repoRes, rulesRes, windowRes, pinsRes] = await env.DB.batch(windowStatements(env.DB, repoId, ref));
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
          trainPass(
            env,
            resolveCtx({ env, repo, waitUntil: (p) => waitUntil.push(p) }, artifacts),
            repo,
            rules,
            ref,
            fairOrder(rows),
            pinsByChange(pinsRes?.results as DependencyRow[] | undefined),
            pass,
            owner,
            deps,
            rejudged,
            configs,
          ),
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
      // No progress: entries wait for checks, for candidates ahead of them or for their pins' sources. Check completion and
      // landings kick the train; a bounded backstop covers a lost kick.
      const fin = await finishRun(env.DB, repoId, ref, claim, deps.now());
      if (fin === 'again') continue;
      result.state = 'waiting';
      const head = outcome.backstop;
      if (outcome.waiting && head && head.attempts < TRAIN_LIMITS.maxAttempts) {
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
    closePass();
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
  // Fenced to the entry that still records the head this event displaced
  // (the head its own ingest observed as queued). A late redelivery whose
  // hook runs after a newer push already moved or re-approved the entry
  // must not stale the fresh approval or regress an auto entry's head.
  const active = `SELECT q.id FROM merge_queue q WHERE q.change_set_id = ?1 AND q.active = 1 AND q.state != 'publishing' AND q.head_sha = ?5`;
  let ref: string | null;
  if (e.change.policy === 'auto') {
    const row = await db
      .prepare(
        `UPDATE merge_queue SET head_sha = ?2, state = 'queued', generation = generation + 1, attempts = 0, base_sha = NULL, tree_sha = NULL,
                checks_state = NULL, updated_at = ?3
          WHERE repo_id = ?4 AND id = (${active}) RETURNING target_ref`,
      )
      .bind(e.change.id, e.headSha, now, e.repoId, queued)
      .first<{ target_ref: string }>();
    ref = row?.target_ref ?? null;
  } else {
    const row = await db
      .prepare(
        `UPDATE merge_queue SET state = 'stale', active = 0, generation = generation + 1, reason_code = 'HEAD_MOVED',
                reason = ?3, updated_at = ?2
          WHERE repo_id = ?4 AND id = (${active}) RETURNING target_ref`,
      )
      .bind(e.change.id, now, `the head moved from the approved ${queued} to ${e.headSha}; enqueue again to approve the new head`, e.repoId, queued)
      .first<{ target_ref: string }>();
    ref = row?.target_ref ?? null;
  }
  if (ref) await deps.kick(e.env, e.repoId, ref, 'head-moved');
}

HEAD_MOVED_HOOKS.push((e) => onQueuedHeadMoved(e));
