/**
 * Push event dispatcher (architecture §11.5).
 *
 * Artifacts push events reach the `kvarm-events` queue through the
 * account-level event subscription. Each message is handled on its own:
 *
 *  1. One ingest D1 batch records the event (insert or ignore, delivery
 *     count), advances `repos.pushed_at` monotonically, moves the ref position
 *     only for a newer event, moves the head of open change requests on a
 *     pushed branch to that position, and reads back the repo, the current
 *     ref position, those changes and the effects already completed for this
 *     event. Events for repos the platform does not know are acked and ignored.
 *  2. Every effect still missing for the event runs independently. Completed
 *     effects are recorded in one completion batch, so a redelivery (queue
 *     at-least-once, or a retry after a failed effect) runs only what is
 *     still missing.
 *
 * Audit identity and work identity differ on purpose: every genuine push is
 * its own `push_events` row (a later A→B repeating an earlier A→B is a new
 * row), while snapshot work is keyed by the immutable commit, so a repeated
 * transition reuses the existing snapshot instead of rebuilding it.
 */

import { sha256Hex, ZERO_OID } from '@kvarm/gitops';
import { bumpRefGeneration } from '../cache/compare';
import { CostMeter, runWithMeter } from '../cost/meter';
import type { ServiceResult } from '../repos/service';
import { onBasePushed, onHeadPushed, type ChangeOnRef } from './changes';
import { reconcileObserved } from './intents/forecast';
import { runTrain, type TrainRunResult } from './queue';
import { isTrainMessage } from './trainKick';
import { isSettleMessage, type SettleContinuationResult } from './dependencyGate';
import { continueDependencySettlement } from './dependencies';
import { withLazyRepo } from '../artifacts/repo';
import { changedPaths } from './compare';
import { matchesAnyGlob } from '../containers/fleetJob';
import { readCommitInfo, type ResolveContext } from './refs';
import { requestEnvironmentBuild } from './environments';
import { commitCloseStatement, commitClosingRefs, guardScanStatements, pushedCommits, retireIssueTasksStatement } from './issues';
import { deliverWebhook, isWebhookDeliveryMessage, pumpWebhookDeliveries, type AttemptResult } from './webhooks';
import type { RepoRow } from '../db/repos';
import { publishRepoEvent } from './live';

export interface PushEvent {
  namespace: string;
  repoName: string;
  ref: string;
  before: string;
  after: string;
  /** Source event time in ms; orders transitions of one ref. */
  eventAt: number;
  /** A delivery identity carried by the source itself, when it has one. */
  sourceId: string | null;
  source: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const PUSH_TYPE = 'cf.artifacts.repo.pushed';
const WORKSPACE_REF_PREFIX = 'refs/heads/agents/';

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The push event in a queue message body, or null for anything else. */
export function parsePushEvent(body: unknown): PushEvent | null {
  const msg = record(body);
  if (!msg || msg.type !== PUSH_TYPE) return null;
  const source = record(msg.source);
  const payload = record(msg.payload);
  const metadata = record(msg.metadata) ?? {};
  if (!source || !payload) return null;
  const repoName = str(source.repoName);
  const namespace = str(source.namespace);
  const ref = str(payload.ref);
  const before = str(payload.before);
  const after = str(payload.after);
  if (!repoName || !namespace || !ref || !before || !after) return null;
  if (!ref.startsWith('refs/') || ref.length > 1024 || !SHA_RE.test(before) || !SHA_RE.test(after)) return null;
  const ts = str(metadata.eventTimestamp);
  const eventAt = ts ? Date.parse(ts) : NaN;
  return {
    namespace,
    repoName,
    ref,
    before,
    after,
    eventAt: Number.isFinite(eventAt) ? eventAt : NaN,
    sourceId: str(msg.id) ?? str(metadata.eventId),
    source: str(source.type) ?? 'artifacts',
  };
}

/**
 * Event identity: the source's own id when it has one, otherwise the
 * transition plus its source timestamp (identical for every redelivery of one
 * push, different for a later genuine repeat), otherwise the queue message id.
 */
export async function eventIdentity(ev: PushEvent, messageId: string): Promise<string> {
  if (ev.sourceId) return sha256Hex(`source:${ev.namespace}:${ev.sourceId}`);
  if (Number.isFinite(ev.eventAt)) {
    return sha256Hex(`push:${ev.namespace}:${ev.repoName}:${ev.ref}:${ev.before}:${ev.after}:${ev.eventAt}`);
  }
  return sha256Hex(`message:${messageId}`);
}

/** Deterministic SnapshotBuilder instance id: one build per repo commit. */
export function snapshotInstanceId(repoId: string, sha: string): string {
  return `snap-${repoId}-${sha}`;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface IngestRow {
  repo_id: string;
  default_branch: string;
  deliveries: number;
  event_at: number;
  head_event_id: string | null;
  done: string;
  changes: string | null;
  workspace: string | null;
  base_conflicted: number | null;
}

/** The workspace whose ref was pushed (workspace-namespace refs only). */
export interface PushedWorkspace {
  id: string;
  status: string;
  baseSha: string | null;
}

export interface Ingested {
  repoId: string;
  defaultBranch: string;
  deliveries: number;
  /** True when a newer event of the same ref already holds the ref position. */
  superseded: boolean;
  done: Set<string>;
  /** Live (open or conflicted) change requests whose head is the pushed branch, after the head refresh. */
  changes: ChangeOnRef[];
  /** Event time as first persisted (orders reconciliations of one ref). */
  eventAt: number;
  workspace: PushedWorkspace | null;
  /** True when a conflicted `auto` change has the pushed branch as its base. */
  baseConflicted: boolean;
}

const BRANCH_PREFIX = 'refs/heads/';

/** The ingest readback's change list (services/pushFastPath.ts reads the same shape). */
export function parseChanges(json: string | null): ChangeOnRef[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as ChangeOnRef[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One D1 batch; null when the repo is unknown to the platform.
 *
 * Ref position and pushed_at use the event_at persisted by the event's first
 * delivery, not this delivery's: an event without a source timestamp falls
 * back to its first receive time, and a later redelivery must keep that
 * position or it would outrank, and roll back, newer events.
 */
async function ingest(db: D1Database, ev: PushEvent, id: string, deliveryId: string, now: number): Promise<Ingested | null> {
  const eventAt = Number.isFinite(ev.eventAt) ? ev.eventAt : now;
  const persistedAt = 'SELECT p.event_at FROM push_events p WHERE p.id = ?2 AND p.repo_id = r.id';
  // Change requests name their head by branch; other refs match no change.
  const branch = ev.ref.startsWith(BRANCH_PREFIX) ? ev.ref.slice(BRANCH_PREFIX.length) : null;
  const currentRef = 'FROM repo_refs f WHERE f.repo_id = change_sets.repo_id AND f.ref = ?2';
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO push_events (id, repo_id, ref, before_sha, after_sha, transition_key, source,
           first_delivery_id, last_delivery_id, deliveries, event_at, received_at)
         SELECT ?1, r.id, ?3, ?4, ?5, r.id || ':' || ?3 || ':' || ?4 || ':' || ?5, ?6, ?7, ?7, 0, ?8, ?9
           FROM repos r WHERE r.artifacts_name = ?2`,
      )
      .bind(id, ev.repoName, ev.ref, ev.before, ev.after, ev.source, deliveryId, eventAt, now),
    db.prepare('UPDATE push_events SET deliveries = deliveries + 1, last_delivery_id = ?2 WHERE id = ?1').bind(id, deliveryId),
    db
      .prepare(
        `UPDATE repos AS r SET pushed_at = MAX(COALESCE(r.pushed_at, 0), COALESCE((${persistedAt}), 0))
         WHERE r.artifacts_name = ?1`,
      )
      .bind(ev.repoName, id),
    // Only a newer event (event time, then id as a deterministic tiebreak)
    // moves the ref, so a late older delivery never rolls state back.
    db
      .prepare(
        `INSERT INTO repo_refs (repo_id, ref, sha, event_id, event_at, updated_at)
         SELECT r.id, ?3, ?4, ?2, (${persistedAt}), ?5 FROM repos r
          WHERE r.artifacts_name = ?1 AND EXISTS (${persistedAt})
         ON CONFLICT (repo_id, ref) DO UPDATE SET
           sha = excluded.sha, event_id = excluded.event_id, event_at = excluded.event_at, updated_at = excluded.updated_at
         WHERE excluded.event_at > repo_refs.event_at
            OR (excluded.event_at = repo_refs.event_at AND excluded.event_id > repo_refs.event_id)`,
      )
      .bind(ev.repoName, id, ev.ref, ev.after, now),
    // Head refresh: open changes on this branch follow the ref position just
    // reconciled above, and only when it is newer than the event that last
    // set their head (creation time at first), so an old delivery never
    // rolls a head back. A deleted branch leaves the head where it was.
    db
      .prepare(
        `UPDATE change_sets
            SET head_sha = (SELECT f.sha ${currentRef}),
                head_event_at = (SELECT f.event_at ${currentRef}),
                updated_at = ?4
          WHERE repo_id = (SELECT r.id FROM repos r WHERE r.artifacts_name = ?1)
            AND head_ref = ?3 AND state IN ('open', 'conflicted')
            AND EXISTS (SELECT 1 ${currentRef}
                         AND f.sha != '${ZERO_OID}' AND f.event_at > COALESCE(change_sets.head_event_at, 0)
                         AND f.sha IS NOT change_sets.head_sha)`,
      )
      .bind(ev.repoName, ev.ref, branch, now),
    db
      .prepare(
        `SELECT r.id AS repo_id, r.default_branch, p.deliveries, p.event_at, f.event_id AS head_event_id,
           (SELECT json_group_array(x.effect) FROM push_event_effects x WHERE x.event_id = ?2) AS done,
           (SELECT json_group_array(json_object('id', c.id, 'number', c.number, 'state', c.state, 'policy', c.merge_policy, 'headSha', c.head_sha,
                     'queuedHead', (SELECT q.head_sha FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1)))
              FROM change_sets c WHERE c.repo_id = r.id AND c.head_ref = ?4 AND c.state IN ('open', 'conflicted')) AS changes,
           (SELECT json_object('id', w.id, 'status', w.status, 'baseSha', w.base_sha)
              FROM workspaces w WHERE w.repo_id = r.id AND w.ref = ?5) AS workspace,
           (SELECT 1 FROM change_sets b WHERE b.repo_id = r.id AND b.state = 'conflicted' AND b.merge_policy = 'auto' AND b.base_ref = ?4 LIMIT 1) AS base_conflicted
         FROM repos r
         JOIN push_events p ON p.id = ?2 AND p.repo_id = r.id
         LEFT JOIN repo_refs f ON f.repo_id = r.id AND f.ref = ?3
         WHERE r.artifacts_name = ?1`,
      )
      .bind(ev.repoName, id, ev.ref, branch, ev.ref.startsWith(WORKSPACE_REF_PREFIX) ? ev.ref : null),
  ]);
  const row = (results[5]?.results as IngestRow[] | undefined)?.[0];
  if (!row) return null;
  return {
    repoId: row.repo_id,
    defaultBranch: row.default_branch,
    deliveries: row.deliveries,
    superseded: row.head_event_id !== id,
    done: new Set(JSON.parse(row.done || '[]') as string[]),
    changes: parseChanges(row.changes),
    eventAt: row.event_at,
    workspace: row.workspace ? (JSON.parse(row.workspace) as PushedWorkspace) : null,
    baseConflicted: row.base_conflicted === 1,
  };
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface EffectContext {
  env: Env;
  event: PushEvent;
  eventId: string;
  repoId: string;
  defaultBranch: string;
  superseded: boolean;
  /** Live (open or conflicted) change requests whose head is the pushed branch (from the ingest batch). */
  changes: ChangeOnRef[];
  eventAt: number;
  workspace: PushedWorkspace | null;
  baseConflicted: boolean;
  /** Counts SnapshotBuilder instance creations for the per-message log line. */
  counters: { wf: number };
}

export interface EffectOutcome {
  state: 'done' | 'skipped';
  detail?: string;
  /** D1 writes that land in the message's completion batch, together with the effect's completion record. */
  statements?: D1PreparedStatement[];
}

export interface PushEffect {
  name: string;
  run(ctx: EffectContext): Promise<EffectOutcome>;
}

/** Retires this colo's cached ref resolutions (the gate already did so where the push landed). */
const purgeEffect: PushEffect = {
  name: 'purge',
  async run(ctx) {
    await bumpRefGeneration(ctx.repoId);
    return { state: 'done' };
  },
};

/**
 * Eager snapshot of the default branch. Other refs, workspace refs included,
 * build lazily on explicit demand (checkout/CI), not on push.
 */
const snapshotEffect: PushEffect = {
  name: 'snapshot',
  async run(ctx) {
    const { event, env } = ctx;
    if (event.after === ZERO_OID) return { state: 'skipped', detail: 'ref deleted' };
    if (event.ref !== `refs/heads/${ctx.defaultBranch}`) return { state: 'skipped', detail: 'lazy: not the default branch' };
    if (ctx.superseded) return { state: 'skipped', detail: 'superseded' };
    const id = snapshotInstanceId(ctx.repoId, event.after);
    ctx.counters.wf++;
    try {
      await env.SNAPSHOT_BUILDER.create({ id, params: { repoId: ctx.repoId, sha: event.after } });
      return { state: 'done', detail: `created ${id}` };
    } catch (err) {
      // The id is deterministic: an existing instance is the same immutable build.
      const existing = await env.SNAPSHOT_BUILDER.get(id).then(
        () => true,
        () => false,
      );
      if (existing) return { state: 'done', detail: `reused ${id}` };
      throw err;
    }
  },
};

/**
 * Nexus observed index (services/intents/forecast.ts): reconciles the pushed
 * workspace's cumulative base→head changed paths. Its writes join the
 * completion batch, guarded so a newer push's set is never replaced.
 */
const intentIndexEffect: PushEffect = {
  name: 'intent-index',
  async run(ctx) {
    const { event, workspace } = ctx;
    if (!event.ref.startsWith(WORKSPACE_REF_PREFIX)) return { state: 'skipped', detail: 'not a workspace ref' };
    if (!workspace) return { state: 'skipped', detail: 'no workspace for this ref' };
    if (workspace.status !== 'active') return { state: 'skipped', detail: `workspace ${workspace.status}` };
    if (event.after === ZERO_OID) return { state: 'skipped', detail: 'ref deleted' };
    if (ctx.superseded) return { state: 'skipped', detail: 'superseded' };
    if (!workspace.baseSha) return { state: 'skipped', detail: 'workspace has no base commit' };
    const r = await reconcileObserved(ctx.env, {
      repoId: ctx.repoId,
      artifactsName: event.repoName,
      workspaceId: workspace.id,
      baseSha: workspace.baseSha,
      headSha: event.after,
      event: { id: ctx.eventId, at: ctx.eventAt },
    });
    return { state: 'done', detail: r.detail, statements: r.statements };
  },
};

/**
 * Change requests on the pushed branch (services/changes.ts): their head
 * already moved in the ingest batch; this runs the head-moved hooks and
 * merges ready `auto` changes; as a base, it re-evaluates the conflicted
 * `auto` changes onto it. No D1 when no live change uses the branch.
 */
const changeHooksEffect: PushEffect = {
  name: 'change-hooks',
  async run(ctx) {
    if (!ctx.event.ref.startsWith(BRANCH_PREFIX)) return { state: 'skipped', detail: 'not a branch' };
    const pending: Promise<unknown>[] = [];
    const waitUntil = (p: Promise<unknown>) => pending.push(p);
    try {
      const head = await onHeadPushed(ctx.env, ctx.repoId, ctx.changes, ctx.event.after, waitUntil);
      if (!ctx.baseConflicted || ctx.event.after === ZERO_OID) return head;
      const base = await onBasePushed(ctx.env, ctx.repoId, ctx.event.ref.slice(BRANCH_PREFIX.length), waitUntil);
      return { state: 'done', detail: head.state === 'done' ? `${head.detail}; ${base.detail}` : base.detail };
    } finally {
      await Promise.allSettled(pending);
    }
  },
};

export const environmentBuildEffect: PushEffect = {
  name: 'environment-builds',
  async run(ctx) {
    if (!ctx.event.ref.startsWith(BRANCH_PREFIX)) return { state: 'skipped', detail: 'not a branch' };
    const environments = await ctx.env.DB.prepare(
      'SELECT id, rebuild_paths FROM environments WHERE repo_id = ?1 AND base_ref = ?2 AND archived_at IS NULL LIMIT 100',
    )
      .bind(ctx.repoId, ctx.event.ref.slice(BRANCH_PREFIX.length))
      .all<{ id: string; rebuild_paths: string }>();
    const rows = environments.results ?? [];
    if (rows.length === 0) return { state: 'skipped', detail: 'no environment uses this base ref' };
    let paths: string[] = [];
    let truncated = false;
    if (ctx.event.after === ZERO_OID) {
      truncated = true;
    } else if (ctx.event.before === ctx.event.after) {
      return { state: 'skipped', detail: 'push did not change the commit' };
    } else {
      const repo = await ctx.env.DB.prepare('SELECT * FROM repos WHERE id = ?1')
        .bind(ctx.repoId)
        .first<RepoRow>();
      if (!repo) return { state: 'skipped', detail: 'repository no longer exists' };
      const diff = await withLazyRepo(ctx.env, repo.artifacts_name, async (artifacts) => {
        const context: ResolveContext = { env: ctx.env, repo, artifacts, bypass: true, waitUntil: () => undefined };
        const [before, after] = await Promise.all([
          ctx.event.before === ZERO_OID ? Promise.resolve(null) : readCommitInfo(context, ctx.event.before),
          readCommitInfo(context, ctx.event.after),
        ]);
        if (!before || !after) return { paths: [] as string[], truncated: true };
        const result = await changedPaths(context, before.tree, after.tree);
        return { paths: result.paths, truncated: result.truncated };
      });
      paths = diff.paths;
      truncated = diff.truncated;
    }
    let requested = 0;
    for (const environment of rows) {
      let patterns: string[] = [];
      try {
        const parsed: unknown = JSON.parse(environment.rebuild_paths);
        if (Array.isArray(parsed)) patterns = parsed.filter((pattern): pattern is string => typeof pattern === 'string');
      } catch {
        truncated = true;
      }
      if (!truncated && !paths.some((path) => matchesAnyGlob(path, patterns))) continue;
      const result = await requestEnvironmentBuild(ctx.env, environment.id, 'push');
      if (!result.ok) throw new Error(`environment ${environment.id} build request failed: ${result.error}`);
      requested += 1;
    }
    return { state: requested ? 'done' : 'skipped', detail: `requested ${requested} build(s)${truncated ? ' after a truncated diff' : ''}` };
  },
};

/**
 * Issues closed by commits pushed to the default branch (services/issues.ts):
 * the bounded set of commits the push brought in (the first-parent line down
 * to the previous tip and the side branches its merges brought in, see
 * pushedCommits), read for closing keywords; the closes join the completion batch. A merged
 * change's own links are closed by its merge record, not here. Creating the
 * branch closes nothing, so an imported history never sweeps issues shut.
 */
const issueCommitsEffect: PushEffect = {
  name: 'issue-commits',
  async run(ctx) {
    const { event } = ctx;
    if (event.ref !== `refs/heads/${ctx.defaultBranch}`) return { state: 'skipped', detail: 'not the default branch' };
    if (event.after === ZERO_OID) return { state: 'skipped', detail: 'ref deleted' };
    if (event.before === ZERO_OID) return { state: 'skipped', detail: 'branch created' };
    if (ctx.superseded) return { state: 'skipped', detail: 'superseded' };
    const repo = await ctx.env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(ctx.repoId).first<RepoRow>();
    if (!repo) return { state: 'skipped', detail: 'repo gone' };
    const scan = await pushedCommits(ctx.env, repo, event.before, event.after);
    const commits = scan.commits;
    const truncated =
      (scan.mainlineTruncated ? `; scanned ${commits.length} commits, older ones not read` : '') +
      (scan.sidesSkipped > 0 ? `; ${scan.sidesSkipped} merged branch(es) not read` : '');
    const closes = commitClosingRefs(commits);
    if (closes.length === 0) return { state: 'done', detail: `no closing references in ${commits.length} commits${truncated}` };
    return {
      state: 'done',
      detail: `closes ${closes.map((c) => `${c.repo ?? ''}#${c.number}`).join(', ')}${truncated}`,
      statements: [commitCloseStatement(ctx.env.DB, ctx.repoId, closes, Date.now()), retireIssueTasksStatement(ctx.env.DB, ctx.repoId, Date.now())],
    };
  },
};

/**
 * Guard findings on the default branch (services/issues.ts): a push that
 * moved it outside the publication path — recognized by the merge commit
 * recorded on the change it already gated — is scanned with the same
 * `kvarm/guard` evaluation a change gets, over the push's whole tree diff.
 * A failing finding files a fingerprinted issue (or counts one more
 * occurrence while one is open); the push that clears one on a path it
 * changes closes it as verified. The statements join the completion batch;
 * the reads are bounded by the guard's own budgets.
 */
const issueGuardEffect: PushEffect = {
  name: 'issue-guard',
  async run(ctx) {
    const { event } = ctx;
    if (event.ref !== `refs/heads/${ctx.defaultBranch}`) return { state: 'skipped', detail: 'not the default branch' };
    if (event.after === ZERO_OID) return { state: 'skipped', detail: 'ref deleted' };
    if (event.before === ZERO_OID) return { state: 'skipped', detail: 'branch created' };
    if (ctx.superseded) return { state: 'skipped', detail: 'superseded' };
    const repo = await ctx.env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(ctx.repoId).first<RepoRow>();
    if (!repo) return { state: 'skipped', detail: 'repo gone' };
    const scan = await guardScanStatements(ctx.env, repo, event.before, event.after, Date.now());
    return { state: 'done', detail: scan.detail, statements: scan.statements };
  },
};

export const PUSH_EFFECTS: readonly PushEffect[] = [
  purgeEffect,
  snapshotEffect,
  intentIndexEffect,
  changeHooksEffect,
  issueCommitsEffect,
  issueGuardEffect,
  environmentBuildEffect,
];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** Webhook attempts one consumer invocation runs at once. */
export const WEBHOOK_ATTEMPT_LANES = 3;

export type MessageOutcome = 'processed' | 'replayed' | 'duplicate' | 'unknown-repo' | 'ignored' | 'retry' | 'train' | 'settle' | 'webhook';

/** Backoff for a failed message: 10 s, 20 s, 40 s, … capped at 5 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 10 * 2 ** Math.max(0, attempts - 1));
}

interface MessageResult {
  outcome: MessageOutcome;
  eventId?: string;
  effects?: Record<string, string>;
  error?: string;
  train?: TrainRunResult & { reason: string };
  settle?: SettleContinuationResult;
  webhook?: AttemptResult;
}

async function processMessage(env: Env, msg: Message<unknown>, counters: { wf: number }): Promise<MessageResult> {
  if (isTrainMessage(msg.body)) {
    const run = await runTrain(env, msg.body.repoId, msg.body.ref);
    await publishRepoEvent(env, msg.body.repoId, { type: 'train.updated', ref: msg.body.ref, state: run.state });
    return { outcome: 'train', train: { reason: msg.body.reason, ...run } };
  }
  if (isSettleMessage(msg.body)) {
    return { outcome: 'settle', settle: await continueDependencySettlement(env, msg.body) };
  }
  // An endpoint failure is a recorded attempt with its own delayed retry, never a queue retry.
  if (isWebhookDeliveryMessage(msg.body)) {
    return { outcome: 'webhook', webhook: await deliverWebhook(env, msg.body.deliveryId) };
  }
  const event = parsePushEvent(msg.body);
  if (!event) return { outcome: 'ignored' };
  const eventId = await eventIdentity(event, msg.id);
  // The account-level subscription delivers every namespace; repos.artifacts_name is only unique within ours.
  if (event.namespace !== env.ARTIFACTS_NAMESPACE) return { outcome: 'unknown-repo', eventId };
  const now = Date.now();
  const state = await ingest(env.DB, event, eventId, msg.id, now);
  if (!state) return { outcome: 'unknown-repo', eventId };

  const pending = PUSH_EFFECTS.filter((e) => !state.done.has(e.name));
  if (pending.length === 0) return { outcome: 'duplicate', eventId };

  const ctx: EffectContext = {
    env,
    event,
    eventId,
    repoId: state.repoId,
    defaultBranch: state.defaultBranch,
    superseded: state.superseded,
    changes: state.changes,
    eventAt: state.eventAt,
    workspace: state.workspace,
    baseConflicted: state.baseConflicted,
    counters,
  };
  const settled = await Promise.allSettled(pending.map((e) => e.run(ctx)));
  const finished: { name: string; outcome: EffectOutcome }[] = [];
  const effects: Record<string, string> = {};
  let failure: unknown = null;
  settled.forEach((s, i) => {
    const name = pending[i]!.name;
    if (s.status === 'fulfilled') {
      finished.push({ name, outcome: s.value });
      effects[name] = s.value.state;
    } else {
      failure ??= s.reason;
      effects[name] = 'failed';
    }
  });

  if (finished.length > 0) {
    const doneAt = Date.now();
    const stmts = finished.flatMap(({ outcome }) => outcome.statements ?? []);
    for (const { name, outcome } of finished) {
      stmts.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO push_event_effects (event_id, effect, state, detail, completed_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(eventId, name, outcome.state, outcome.detail ?? null, doneAt),
      );
    }
    stmts.push(
      env.DB.prepare(
        `UPDATE push_events SET completed_at = ?2
         WHERE id = ?1 AND completed_at IS NULL
           AND (SELECT COUNT(*) FROM push_event_effects WHERE event_id = ?1) >= ?3`,
      ).bind(eventId, doneAt, PUSH_EFFECTS.length),
    );
    await env.DB.batch(stmts);
  }

  if (failure !== null) return { outcome: 'retry', eventId, effects, error: String(failure).slice(0, 200) };
  return { outcome: state.deliveries > 1 ? 'replayed' : 'processed', eventId, effects };
}

/**
 * Queue consumer for `kvarm-events`. Messages are handled in order (webhook
 * attempts beside them, see below), each under its own cost meter, and each
 * logs one `{cost: …}` line. A message whose
 * effects did not all complete is retried with backoff; everything else
 * (including malformed messages and unknown repos) is acked.
 */
export async function handleEventBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  // Webhook attempts wait on outside endpoints (up to their timeout each), so
  // they run concurrently with each other and alongside the in-order work,
  // never in front of it.
  const hooks = batch.messages.filter((m) => isWebhookDeliveryMessage(m.body));
  // A Worker invocation holds at most six outbound connections, and an
  // attempt's timeout starts when it calls fetch: a few lanes keep every
  // attempt on an open connection and leave room for the in-order work.
  const lanes = Array.from({ length: Math.min(WEBHOOK_ATTEMPT_LANES, hooks.length) }, async (_, lane) => {
    for (let i = lane; i < hooks.length; i += WEBHOOK_ATTEMPT_LANES) await handleMessage(batch.queue, env, hooks[i]!);
  });
  const hookRuns = Promise.all(lanes);
  for (const msg of batch.messages) {
    if (!isWebhookDeliveryMessage(msg.body)) await handleMessage(batch.queue, env, msg);
  }
  await hookRuns;
  // Only platform work records new deliveries (an attempt's disablement
  // notice waits for the cron), so a batch of attempts does not pump again.
  if (hooks.length < batch.messages.length) await pumpWebhooks(env, batch.queue);
}

async function handleMessage(queue: string, env: Env, msg: Message<unknown>): Promise<void> {
  const meter = new CostMeter();
  const counters = { wf: 0 };
  let result: MessageResult;
  try {
    result = await runWithMeter(meter, () => processMessage(meter.wrapEnv(env), msg, counters));
  } catch (err) {
    result = { outcome: 'retry', error: String(err).slice(0, 200) };
  }
  if (result.outcome === 'retry') msg.retry({ delaySeconds: retryDelaySeconds(msg.attempts) });
  else msg.ack();
  console.log(
    JSON.stringify({
      cost: meter.snapshot(),
      queue,
      outcome: result.outcome,
      attempts: msg.attempts,
      wf: counters.wf,
      ...(result.eventId ? { eventId: result.eventId } : {}),
      ...(result.effects ? { effects: result.effects } : {}),
      ...(result.train ? { train: result.train } : {}),
      ...(result.settle ? { settle: result.settle } : {}),
      ...(result.webhook ? { webhook: result.webhook } : {}),
      ...(result.error ? { error: result.error } : {}),
    }),
  );
}

/**
 * Enqueues webhook deliveries recorded by this batch's effects (merges and
 * ejections of a train run, for example), so they do not wait for the cron.
 * One indexed read when nothing is due; a failure is logged and left to the
 * cron.
 */
async function pumpWebhooks(env: Env, queue: string): Promise<void> {
  const meter = new CostMeter();
  try {
    const r = await runWithMeter(meter, () => pumpWebhookDeliveries(meter.wrapEnv(env)));
    if (r.enqueued > 0) console.log(JSON.stringify({ cost: meter.snapshot(), queue, webhooksEnqueued: r.enqueued }));
  } catch (err) {
    console.log(JSON.stringify({ cost: meter.snapshot(), queue, webhookPumpError: String(err).slice(0, 200) }));
  }
}

// ---------------------------------------------------------------------------
// Event log (GET /api/v1/repos/:owner/:repo/events)
// ---------------------------------------------------------------------------

export const EVENTS_PAGE_DEFAULT = 50;
export const EVENTS_PAGE_MAX = 100;

export interface PushEventView {
  id: string;
  ref: string;
  before: string;
  after: string;
  source: string;
  deliveries: number;
  eventAt: string;
  receivedAt: string;
  completedAt: string | null;
  effects: { effect: string; state: string; detail: string | null; completedAt: string }[];
}

interface PushEventListRow {
  id: string;
  ref: string;
  before_sha: string;
  after_sha: string;
  source: string;
  deliveries: number;
  event_at: number;
  received_at: number;
  completed_at: number | null;
  effects: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

function encodeCursor(eventAt: number, id: string): string {
  return btoa(`${eventAt}:${id}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): { eventAt: number; id: string } | null {
  try {
    const text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const m = /^(\d{1,16}):([0-9a-f]{64})$/.exec(text);
    return m ? { eventAt: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
}

/** One bounded page of a repo's push events, newest source time first, with their effects. */
export async function listPushEvents(
  env: Env,
  repoId: string,
  page: { limit?: string; cursor?: string },
): Promise<ServiceResult<{ events: PushEventView[]; nextCursor: string | null }>> {
  let limit = EVENTS_PAGE_DEFAULT;
  if (page.limit !== undefined) {
    limit = /^\d{1,4}$/.test(page.limit) ? Number(page.limit) : 0;
    if (limit < 1 || limit > EVENTS_PAGE_MAX) {
      return { ok: false, status: 400, error: `limit must be an integer from 1 to ${EVENTS_PAGE_MAX}`, code: 'INVALID_LIMIT' };
    }
  }
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
  if (page.cursor !== undefined && !after) {
    return { ok: false, status: 400, error: 'invalid cursor', code: 'INVALID_CURSOR' };
  }
  const select = `SELECT e.id, e.ref, e.before_sha, e.after_sha, e.source, e.deliveries, e.event_at, e.received_at,
      e.completed_at,
      (SELECT json_group_array(json_object('effect', f.effect, 'state', f.state, 'detail', f.detail,
          'completedAt', f.completed_at))
         FROM push_event_effects f WHERE f.event_id = e.id) AS effects
    FROM push_events e WHERE e.repo_id = ?1`;
  const stmt = after
    ? env.DB.prepare(
        `${select} AND (e.event_at < ?2 OR (e.event_at = ?2 AND e.id < ?3))
         ORDER BY e.event_at DESC, e.id DESC LIMIT ?4`,
      ).bind(repoId, after.eventAt, after.id, limit + 1)
    : env.DB.prepare(`${select} ORDER BY e.event_at DESC, e.id DESC LIMIT ?2`).bind(repoId, limit + 1);
  const rows = (await stmt.all<PushEventListRow>()).results ?? [];
  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    ok: true,
    value: {
      events: pageRows.map((r) => ({
        id: r.id,
        ref: r.ref,
        before: r.before_sha,
        after: r.after_sha,
        source: r.source,
        deliveries: r.deliveries,
        eventAt: iso(r.event_at),
        receivedAt: iso(r.received_at),
        completedAt: r.completed_at === null ? null : iso(r.completed_at),
        effects: (JSON.parse(r.effects || '[]') as { effect: string; state: string; detail: string | null; completedAt: number }[])
          .map((f) => ({ ...f, completedAt: iso(f.completedAt) }))
          .sort((a, b) => (a.effect < b.effect ? -1 : a.effect > b.effect ? 1 : 0)),
      })),
      nextCursor: more && last ? encodeCursor(last.event_at, last.id) : null,
    },
  };
}
