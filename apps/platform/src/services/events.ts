/**
 * Push event dispatcher (architecture §11.5).
 *
 * Artifacts push events reach the `forge-events` queue through the
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

import { sha256Hex, ZERO_OID } from '@forge/gitops';
import { bumpRefGeneration } from '../cache/compare';
import { CostMeter, runWithMeter } from '../cost/meter';
import type { ServiceResult } from '../repos/service';
import { onHeadPushed, type ChangeOnRef } from './changes';
import { reconcileObserved } from './intents/forecast';

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
  /** Open change requests whose head is the pushed branch, after the head refresh. */
  changes: ChangeOnRef[];
  /** Event time as first persisted (orders reconciliations of one ref). */
  eventAt: number;
  workspace: PushedWorkspace | null;
}

const BRANCH_PREFIX = 'refs/heads/';

function parseChanges(json: string | null): ChangeOnRef[] {
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
           (SELECT json_group_array(json_object('id', c.id, 'number', c.number, 'policy', c.merge_policy, 'headSha', c.head_sha))
              FROM change_sets c WHERE c.repo_id = r.id AND c.head_ref = ?4 AND c.state = 'open') AS changes,
           (SELECT json_object('id', w.id, 'status', w.status, 'baseSha', w.base_sha)
              FROM workspaces w WHERE w.repo_id = r.id AND w.ref = ?5) AS workspace
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
  /** Open change requests whose head is the pushed branch (from the ingest batch). */
  changes: ChangeOnRef[];
  eventAt: number;
  workspace: PushedWorkspace | null;
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
      eventAt: ctx.eventAt,
    });
    return { state: 'done', detail: r.detail, statements: r.statements };
  },
};

/**
 * Change requests on the pushed branch (services/changes.ts): their head
 * already moved in the ingest batch; this runs the head-moved hooks and
 * merges ready `auto` changes. No D1 when no open change uses the branch.
 */
const changeHooksEffect: PushEffect = {
  name: 'change-hooks',
  async run(ctx) {
    if (!ctx.event.ref.startsWith(BRANCH_PREFIX)) return { state: 'skipped', detail: 'not a branch' };
    const pending: Promise<unknown>[] = [];
    try {
      return await onHeadPushed(ctx.env, ctx.repoId, ctx.changes, ctx.event.after, (p) => pending.push(p));
    } finally {
      await Promise.allSettled(pending);
    }
  },
};

export const PUSH_EFFECTS: readonly PushEffect[] = [purgeEffect, snapshotEffect, intentIndexEffect, changeHooksEffect];

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export type MessageOutcome = 'processed' | 'replayed' | 'duplicate' | 'unknown-repo' | 'ignored' | 'retry';

/** Backoff for a failed message: 10 s, 20 s, 40 s, … capped at 5 minutes. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(300, 10 * 2 ** Math.max(0, attempts - 1));
}

interface MessageResult {
  outcome: MessageOutcome;
  eventId?: string;
  effects?: Record<string, string>;
  error?: string;
}

async function processMessage(env: Env, msg: Message<unknown>, counters: { wf: number }): Promise<MessageResult> {
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
 * Queue consumer for `forge-events`. Messages are handled in order, each under
 * its own cost meter, and each logs one `{cost: …}` line. A message whose
 * effects did not all complete is retried with backoff; everything else
 * (including malformed messages and unknown repos) is acked.
 */
export async function handleEventBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const msg of batch.messages) {
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
        queue: batch.queue,
        outcome: result.outcome,
        attempts: msg.attempts,
        wf: counters.wf,
        ...(result.eventId ? { eventId: result.eventId } : {}),
        ...(result.effects ? { effects: result.effects } : {}),
        ...(result.error ? { error: result.error } : {}),
      }),
    );
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
