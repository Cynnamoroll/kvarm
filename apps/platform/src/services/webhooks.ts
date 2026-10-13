/**
 * Outbound webhooks (architecture §11.5).
 *
 * Recording. Platform events are CloudEvents 1.0 envelopes in the `events`
 * ledger (type `kvarm.*`, `processed_at` NULL, `source`
 * `/repos/<owner>/<name>`). Migration 0028's triggers fan each one out into a
 * `webhook_deliveries` row per active hook of the repository subscribed to
 * the type, inside the statement that wrote the event, and emit the
 * envelopes for merges, merge-queue ejections, completed check runs and
 * opened escalations from those state transitions. Adding an event type that
 * is already written to the ledger in that shape is one entry in
 * WEBHOOK_EVENT_TYPES.
 *
 * Delivering. No request path or merge-queue step sends anything: a
 * pending delivery becomes a `kvarm.webhook.delivery` message on the
 * `kvarm-events` queue, sent by the pump (after every consumer batch and on
 * the Worker's cron trigger) or by the attempt before it, with the backoff
 * as the message delay. Each attempt claims the row under a short lease,
 * POSTs the stored envelope byte for byte with the signature headers, and
 * records the outcome. Delivery is at least once: a lost message or a crash
 * mid-attempt is picked up again by the pump, and the receiver deduplicates
 * on the event id (`x-kvarm-event-id`, the envelope's `id`). Order is not
 * guaranteed; receivers order by the envelope's `time`.
 *
 * Failure handling. A non-2xx answer, a redirect, a timeout or a network
 * error is a failed attempt, retried with exponential backoff up to
 * WEBHOOK_LIMITS.maxAttempts. A hook whose attempts fail
 * `disableAfterFailures` times in a row is disabled and a
 * `kvarm.webhook.disabled` event is recorded; an admin re-enables it.
 *
 * Cost. Every list is bounded and paginated; the delivery log keeps one row
 * per (hook, event) with at most `maxAttempts` short attempt entries and the
 * latest response excerpt, and terminal rows older than `retentionMs` are
 * pruned by the cron in bounded batches.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { CostMeter, runWithMeter } from '../cost/meter';
import {
  WEBHOOK_KEY_VERSION,
  checkWebhookUrl,
  newWebhookSecret,
  openWebhookSecret,
  sealWebhookSecret,
  signWebhook,
  webhookKeyConfigured,
} from './webhookSafety';

/** Event types a hook may subscribe to. Each is a CloudEvents `type` written to the events ledger. */
export const WEBHOOK_EVENT_TYPES = [
  'kvarm.task.created',
  'kvarm.change.merged',
  'kvarm.change.ejected',
  'kvarm.check_run.completed',
  'kvarm.escalation.opened',
  'kvarm.queue.publication_reconciled',
  'kvarm.webhook.disabled',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const WEBHOOK_PING_EVENT = 'kvarm.webhook.ping';
export const WEBHOOK_DISABLED_EVENT = 'kvarm.webhook.disabled';
export const WEBHOOK_DELIVERY_MESSAGE = 'kvarm.webhook.delivery';

export const WEBHOOK_LIMITS = {
  hooksPerRepo: 20,
  /** Attempts per delivery, the first included. */
  maxAttempts: 6,
  /** Consecutive failed attempts (across deliveries) that disable a hook. */
  disableAfterFailures: 15,
  timeoutMs: 10_000,
  /** Response bytes read before the body is cancelled. */
  responseReadBytes: 4096,
  /** Response characters kept in the delivery log. */
  responseExcerptChars: 512,
  errorChars: 200,
  deliveriesPageDefault: 20,
  deliveriesPageMax: 50,
  /** Deliveries one pump run enqueues (one sendBatch). */
  pumpBatch: 100,
  /** A due delivery whose message has not run after this long is enqueued again. */
  staleMs: 10 * 60_000,
  /** How long one attempt holds its delivery row. */
  leaseMs: 60_000,
  /** A queue message may run this early (clock skew between the producer and the consumer). */
  earlyMs: 5_000,
  retentionMs: 14 * 24 * 3600_000,
  pruneBatch: 200,
};

/** Delay before attempt `attempt + 1`: 30 s, 2 min, 8 min, 32 min, then 1 h. */
export function webhookRetryDelaySeconds(attempt: number): number {
  return Math.min(3600, 30 * 4 ** Math.max(0, attempt - 1));
}

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

const iso = (ms: number) => new Date(ms).toISOString();

function selfHost(env: Env): string | null {
  try {
    return new URL(env.APP_ORIGIN).hostname;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface WebhookView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  consecutiveFailures: number;
  disabledAt: string | null;
  disabledReason: string | null;
  lastDeliveryAt: string | null;
  lastStatus: number | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  secretRotatedAt: string | null;
}

interface WebhookRow {
  id: string;
  url: string;
  events: string;
  active: number;
  consecutive_failures: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  last_delivery_at: number | null;
  last_status: number | null;
  created_by_login: string | null;
  created_at: number;
  updated_at: number;
  secret_rotated_at: number | null;
}

const HOOK_COLUMNS = `id, url, events, active, consecutive_failures, disabled_at, disabled_reason, last_delivery_at, last_status,
  created_by_login, created_at, updated_at, secret_rotated_at`;

function hookView(r: WebhookRow): WebhookView {
  return {
    id: r.id,
    url: r.url,
    events: JSON.parse(r.events) as string[],
    active: r.active === 1,
    consecutiveFailures: r.consecutive_failures,
    disabledAt: r.disabled_at === null ? null : iso(r.disabled_at),
    disabledReason: r.disabled_reason,
    lastDeliveryAt: r.last_delivery_at === null ? null : iso(r.last_delivery_at),
    lastStatus: r.last_status,
    createdBy: r.created_by_login,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    secretRotatedAt: r.secret_rotated_at === null ? null : iso(r.secret_rotated_at),
  };
}

function checkEvents(raw: unknown): { ok: true; events: string[] } | { ok: false; error: string } {
  const allowed: readonly string[] = WEBHOOK_EVENT_TYPES;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((e) => typeof e === 'string')) {
    return { ok: false, error: `events must be a non-empty list of event types (${WEBHOOK_EVENT_TYPES.join(', ')})` };
  }
  const unknown = raw.filter((e) => !allowed.includes(e));
  if (unknown.length > 0) return { ok: false, error: `unknown event type(s): ${unknown.slice(0, 5).join(', ')}; known: ${WEBHOOK_EVENT_TYPES.join(', ')}` };
  return { ok: true, events: [...new Set(raw as string[])].sort() };
}

/** Audit row for a hook write, read from the hook row in the same batch (it never carries the URL or the secret). */
function auditStatement(db: D1Database, type: string, repo: RepoRow, actor: Actor, hookId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, ?2, json_object('repoId', ?3, 'repo', ?4, 'webhookId', ?5, 'actor', ?6), ?7, ?7
        WHERE EXISTS (SELECT 1 FROM webhooks WHERE id = ?5 AND repo_id = ?3)`,
    )
    .bind(crypto.randomUUID(), type, repo.id, `${repo.owner_login}/${repo.name}`, hookId, actor.user.login, now);
}

/**
 * Cancels the pending deliveries of a hook that is disabled or gone (one
 * index range over the hook's log). An attempt in flight keeps its lease and
 * records its own outcome.
 */
function cancelPendingStatement(db: D1Database, hookId: string, reason: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE webhook_deliveries SET state = 'cancelled', error = ?2, completed_at = ?3, updated_at = ?3
        WHERE webhook_id = ?1 AND state = 'pending' AND COALESCE(lease_until, 0) < ?3
          AND NOT EXISTS (SELECT 1 FROM webhooks h WHERE h.id = ?1 AND h.active = 1)`,
    )
    .bind(hookId, reason, now);
}

const NOT_FOUND = () => fail<never>(404, 'webhook not found', 'WEBHOOK_NOT_FOUND');
const NOT_CONFIGURED = () =>
  fail<never>(503, 'webhooks are not configured on this deployment (WEBHOOK_SECRET_KEY secret missing)', 'WEBHOOKS_NOT_CONFIGURED');

export async function listWebhooks(env: Env, repo: RepoRow): Promise<WebhookView[]> {
  const rows = await env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE repo_id = ? ORDER BY created_at, id LIMIT ?`)
    .bind(repo.id, WEBHOOK_LIMITS.hooksPerRepo)
    .all<WebhookRow>();
  return (rows.results ?? []).map(hookView);
}

export async function getWebhook(env: Env, repo: RepoRow, id: string): Promise<ServiceResult<WebhookView>> {
  const row = await env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id = ? AND repo_id = ?`).bind(id, repo.id).first<WebhookRow>();
  return row ? { ok: true, value: hookView(row) } : NOT_FOUND();
}

/** Creates a hook; the returned secret is never readable again. */
export async function createWebhook(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  input: { url: unknown; events: unknown },
): Promise<ServiceResult<{ webhook: WebhookView; secret: string }>> {
  if (!webhookKeyConfigured(env)) return NOT_CONFIGURED();
  const url = checkWebhookUrl(input.url, selfHost(env));
  if (!url.ok) return fail(400, url.reason, 'INVALID_URL');
  const events = checkEvents(input.events);
  if (!events.ok) return fail(400, events.error, 'INVALID_EVENTS');
  const id = crypto.randomUUID();
  const secret = newWebhookSecret();
  const sealed = await sealWebhookSecret(env, id, secret);
  const now = Date.now();
  const [insert, , read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO webhooks (id, repo_id, url, events, secret_ciphertext, secret_iv, key_version, active, consecutive_failures,
         created_by, created_by_login, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, 0, ?8, ?9, ?10, ?10
        WHERE (SELECT COUNT(*) FROM webhooks WHERE repo_id = ?2) < ?11`,
    ).bind(id, repo.id, url.url, JSON.stringify(events.events), sealed.ciphertext, sealed.iv, WEBHOOK_KEY_VERSION, actor.user.id, actor.user.login, now, WEBHOOK_LIMITS.hooksPerRepo),
    env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, 'webhook.created', json_object('repoId', ?2, 'repo', ?3, 'webhookId', ?4, 'host', ?5, 'events', json(?6), 'actor', ?7), ?8, ?8
        WHERE EXISTS (SELECT 1 FROM webhooks WHERE id = ?4)`,
    ).bind(crypto.randomUUID(), repo.id, `${repo.owner_login}/${repo.name}`, id, hostOf(url.url), JSON.stringify(events.events), actor.user.login, now),
    env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id = ?`).bind(id),
  ]);
  const row = (read?.results as WebhookRow[] | undefined)?.[0];
  if (!insert?.meta.changes || !row) {
    return fail(409, `a repository has at most ${WEBHOOK_LIMITS.hooksPerRepo} webhooks`, 'WEBHOOK_LIMIT');
  }
  return { ok: true, value: { webhook: hookView(row), secret } };
}

/** Changes the URL, the subscribed events or `active`; re-enabling clears the failure count. */
export async function updateWebhook(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  id: string,
  input: { url?: unknown; events?: unknown; active?: unknown },
): Promise<ServiceResult<WebhookView>> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.url !== undefined) {
    const url = checkWebhookUrl(input.url, selfHost(env));
    if (!url.ok) return fail(400, url.reason, 'INVALID_URL');
    binds.push(url.url);
    sets.push(`url = ?${binds.length + 3}`);
  }
  if (input.events !== undefined) {
    const events = checkEvents(input.events);
    if (!events.ok) return fail(400, events.error, 'INVALID_EVENTS');
    binds.push(JSON.stringify(events.events));
    sets.push(`events = ?${binds.length + 3}`);
  }
  if (input.active !== undefined) {
    if (typeof input.active !== 'boolean') return fail(400, 'active must be a boolean', 'INVALID_ACTIVE');
    if (input.active) sets.push('active = 1', 'consecutive_failures = 0', 'disabled_at = NULL', 'disabled_reason = NULL');
    else sets.push('active = 0', `disabled_at = COALESCE(disabled_at, ?3)`, `disabled_reason = COALESCE(disabled_reason, 'disabled by an admin')`);
  }
  if (sets.length === 0) return fail(400, 'nothing to update: give url, events or active', 'INVALID_UPDATE');
  const now = Date.now();
  const [update, , , read] = await env.DB.batch([
    env.DB.prepare(`UPDATE webhooks SET ${sets.join(', ')}, updated_at = ?3 WHERE id = ?1 AND repo_id = ?2`).bind(id, repo.id, now, ...binds),
    auditStatement(env.DB, 'webhook.updated', repo, actor, id, now),
    cancelPendingStatement(env.DB, id, 'webhook disabled by an admin', now),
    env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id = ? AND repo_id = ?`).bind(id, repo.id),
  ]);
  const row = (read?.results as WebhookRow[] | undefined)?.[0];
  if (!update?.meta.changes || !row) return NOT_FOUND();
  return { ok: true, value: hookView(row) };
}

/**
 * Deletes a hook and cancels its pending deliveries in the same batch; its
 * log ages out with the retention prune.
 */
export async function deleteWebhook(env: Env, repo: RepoRow, actor: Actor, id: string): Promise<ServiceResult<WebhookView>> {
  const [read, , del] = await env.DB.batch([
    env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id = ? AND repo_id = ?`).bind(id, repo.id),
    auditStatement(env.DB, 'webhook.deleted', repo, actor, id, Date.now()),
    env.DB.prepare('DELETE FROM webhooks WHERE id = ? AND repo_id = ?').bind(id, repo.id),
    cancelPendingStatement(env.DB, id, 'webhook deleted', Date.now()),
  ]);
  const row = (read?.results as WebhookRow[] | undefined)?.[0];
  if (!del?.meta.changes || !row) return NOT_FOUND();
  return { ok: true, value: hookView(row) };
}

/** Replaces the signing secret; the new one is returned once. Attempts sign with the secret current when they run. */
export async function rotateWebhookSecret(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  id: string,
): Promise<ServiceResult<{ webhook: WebhookView; secret: string }>> {
  if (!webhookKeyConfigured(env)) return NOT_CONFIGURED();
  const secret = newWebhookSecret();
  const sealed = await sealWebhookSecret(env, id, secret);
  const now = Date.now();
  const [update, , read] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhooks SET secret_ciphertext = ?3, secret_iv = ?4, key_version = ?5, secret_rotated_at = ?6, updated_at = ?6
        WHERE id = ?1 AND repo_id = ?2`,
    ).bind(id, repo.id, sealed.ciphertext, sealed.iv, WEBHOOK_KEY_VERSION, now),
    auditStatement(env.DB, 'webhook.secret_rotated', repo, actor, id, now),
    env.DB.prepare(`SELECT ${HOOK_COLUMNS} FROM webhooks WHERE id = ? AND repo_id = ?`).bind(id, repo.id),
  ]);
  const row = (read?.results as WebhookRow[] | undefined)?.[0];
  if (!update?.meta.changes || !row) return NOT_FOUND();
  return { ok: true, value: { webhook: hookView(row), secret } };
}

/**
 * Sends a `kvarm.webhook.ping` to one hook through the ordinary delivery
 * path. The ping is written to the ledger already processed, so no other
 * hook receives it.
 */
export async function pingWebhook(env: Env, repo: RepoRow, actor: Actor, id: string): Promise<ServiceResult<DeliveryView>> {
  if (!webhookKeyConfigured(env)) return NOT_CONFIGURED();
  const now = Date.now();
  const eventId = `webhook-ping-${crypto.randomUUID()}`;
  const deliveryId = crypto.randomUUID().replace(/-/g, '');
  const source = `/repos/${repo.owner_login}/${repo.name}`;
  const envelope = JSON.stringify({
    specversion: '1.0',
    id: eventId,
    type: WEBHOOK_PING_EVENT,
    source,
    subject: id,
    time: iso(now),
    datacontenttype: 'application/json',
    data: { repo: `${repo.owner_login}/${repo.name}`, webhook: id, actor: actor.user.login },
  });
  const [event, , read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, '${WEBHOOK_PING_EVENT}', ?2, ?3, ?3 WHERE EXISTS (SELECT 1 FROM webhooks WHERE id = ?4 AND repo_id = ?5 AND active = 1)`,
    ).bind(eventId, envelope, now, id, repo.id),
    env.DB.prepare(
      `INSERT INTO webhook_deliveries (id, webhook_id, repo_id, event_id, event_type, state, attempts, next_attempt_at, enqueued_at, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, '${WEBHOOK_PING_EVENT}', 'pending', 0, ?5, ?5, ?5, ?5 WHERE EXISTS (SELECT 1 FROM events WHERE id = ?4)`,
    ).bind(deliveryId, id, repo.id, eventId, now),
    env.DB.prepare(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries d WHERE d.id = ?`).bind(deliveryId),
  ]);
  const row = (read?.results as DeliveryRow[] | undefined)?.[0];
  if (!event?.meta.changes || !row) {
    const hook = await getWebhook(env, repo, id);
    return hook.ok ? fail(409, 'the webhook is disabled; re-enable it first', 'WEBHOOK_DISABLED') : NOT_FOUND();
  }
  // A lost send is recovered by the pump once the delivery is stale.
  await enqueueDeliveries(env, [deliveryId]);
  return { ok: true, value: deliveryView(row) };
}

// ---------------------------------------------------------------------------
// Delivery log
// ---------------------------------------------------------------------------

export interface AttemptView {
  attempt: number;
  at: string;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

export interface DeliveryView {
  id: string;
  eventId: string;
  eventType: string;
  state: 'pending' | 'delivered' | 'failed' | 'cancelled';
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  latencyMs: number | null;
  error: string | null;
  responseExcerpt: string | null;
  attemptLog: AttemptView[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface DeliveryRow {
  id: string;
  event_id: string;
  event_type: string;
  state: DeliveryView['state'];
  attempts: number;
  next_attempt_at: number;
  response_status: number | null;
  latency_ms: number | null;
  error: string | null;
  response_excerpt: string | null;
  attempt_log: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

const DELIVERY_COLUMNS = `d.id, d.event_id, d.event_type, d.state, d.attempts, d.next_attempt_at, d.response_status, d.latency_ms, d.error,
  d.response_excerpt, d.attempt_log, d.created_at, d.updated_at, d.completed_at`;

function deliveryView(r: DeliveryRow): DeliveryView {
  return {
    id: r.id,
    eventId: r.event_id,
    eventType: r.event_type,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.state === 'pending' ? iso(r.next_attempt_at) : null,
    responseStatus: r.response_status,
    latencyMs: r.latency_ms,
    error: r.error,
    responseExcerpt: r.response_excerpt,
    attemptLog: JSON.parse(r.attempt_log || '[]') as AttemptView[],
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    completedAt: r.completed_at === null ? null : iso(r.completed_at),
  };
}

function encodeCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const m = /^(\d{1,16}):([0-9a-f]{32})$/.exec(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    return m ? { createdAt: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
}

const DELIVERY_STATES = ['pending', 'delivered', 'failed', 'cancelled'] as const;

/** One bounded page of a hook's deliveries, newest first. One D1 batch. */
export async function listDeliveries(
  env: Env,
  repo: RepoRow,
  id: string,
  page: { limit?: string; cursor?: string; state?: string },
): Promise<ServiceResult<{ deliveries: DeliveryView[]; nextCursor: string | null }>> {
  let limit = WEBHOOK_LIMITS.deliveriesPageDefault;
  if (page.limit !== undefined) {
    limit = /^\d{1,4}$/.test(page.limit) ? Number(page.limit) : 0;
    if (limit < 1 || limit > WEBHOOK_LIMITS.deliveriesPageMax) {
      return fail(400, `limit must be an integer from 1 to ${WEBHOOK_LIMITS.deliveriesPageMax}`, 'INVALID_LIMIT');
    }
  }
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
  if (page.cursor !== undefined && !after) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
  if (page.state !== undefined && !(DELIVERY_STATES as readonly string[]).includes(page.state)) {
    return fail(400, `state must be one of ${DELIVERY_STATES.join(', ')}`, 'INVALID_STATE');
  }
  const conds = ['d.webhook_id = ?1'];
  const binds: unknown[] = [id, limit + 1];
  if (after) {
    binds.push(after.createdAt, after.id);
    conds.push(`(d.created_at < ?${binds.length - 1} OR (d.created_at = ?${binds.length - 1} AND d.id < ?${binds.length}))`);
  }
  if (page.state !== undefined) {
    binds.push(page.state);
    conds.push(`d.state = ?${binds.length}`);
  }
  const [hook, list] = await env.DB.batch([
    env.DB.prepare('SELECT 1 AS found FROM webhooks WHERE id = ? AND repo_id = ?').bind(id, repo.id),
    env.DB.prepare(
      `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries d WHERE ${conds.join(' AND ')}
        ORDER BY d.created_at DESC, d.id DESC LIMIT ?2`,
    ).bind(...binds),
  ]);
  if (!(hook?.results ?? []).length) return NOT_FOUND();
  const rows = (list?.results as DeliveryRow[] | undefined) ?? [];
  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    ok: true,
    value: { deliveries: pageRows.map(deliveryView), nextCursor: more && last ? encodeCursor(last.created_at, last.id) : null },
  };
}

// ---------------------------------------------------------------------------
// Queue: messages, pump, attempts
// ---------------------------------------------------------------------------

export interface WebhookDeliveryMessage {
  type: typeof WEBHOOK_DELIVERY_MESSAGE;
  deliveryId: string;
}

export function isWebhookDeliveryMessage(body: unknown): body is WebhookDeliveryMessage {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return b.type === WEBHOOK_DELIVERY_MESSAGE && typeof b.deliveryId === 'string' && /^[0-9a-f]{32}$/.test(b.deliveryId);
}

async function enqueueDeliveries(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    await env.EVENTS.sendBatch(ids.map((deliveryId) => ({ body: { type: WEBHOOK_DELIVERY_MESSAGE, deliveryId } satisfies WebhookDeliveryMessage })));
  } catch (err) {
    console.warn(JSON.stringify({ webhookEnqueueFailed: ids.length, error: String(err).slice(0, 200) }));
  }
}

/**
 * Enqueues due deliveries that have no live message: new ones (never
 * enqueued) and ones whose message is overdue by `staleMs` (lost send, or an
 * attempt that died holding its lease). One indexed read, plus one write and
 * one sendBatch when something is due. Rows are marked before the send, so a
 * failed send is retried by a later pump once stale; a duplicate message is
 * absorbed by the claim.
 */
export async function pumpWebhookDeliveries(env: Env, now = Date.now()): Promise<{ enqueued: number }> {
  // Overdue by staleMs and last sent more than staleMs ago: a message that
  // is merely late in a backlog is not sent again on every pump.
  const due = `state = 'pending' AND next_attempt_at <= ?1 AND COALESCE(lease_until, 0) < ?1
    AND (enqueued_at IS NULL OR (next_attempt_at < ?1 - ?2 AND enqueued_at < ?1 - ?2))`;
  // A read first: the common case (nothing due) writes nothing.
  const found = await env.DB.prepare(`SELECT id FROM webhook_deliveries WHERE ${due} ORDER BY next_attempt_at LIMIT ?3`)
    .bind(now, WEBHOOK_LIMITS.staleMs, WEBHOOK_LIMITS.pumpBatch)
    .all<{ id: string }>();
  const candidates = (found.results ?? []).map((r) => r.id);
  if (candidates.length === 0) return { enqueued: 0 };
  // Re-checked in the write so two concurrent pumps do not both send a row.
  const rows = await env.DB.prepare(
    `UPDATE webhook_deliveries SET enqueued_at = ?1
      WHERE id IN (SELECT value FROM json_each(?3)) AND ${due}
      RETURNING id`,
  )
    .bind(now, WEBHOOK_LIMITS.staleMs, JSON.stringify(candidates))
    .all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  await enqueueDeliveries(env, ids);
  return { enqueued: ids.length };
}

/** Deletes up to `pruneBatch` terminal deliveries older than the retention window. */
export async function pruneWebhookDeliveries(env: Env, now = Date.now()): Promise<{ pruned: number }> {
  const r = await env.DB.prepare(
    `DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries
       WHERE state != 'pending' AND created_at < ?1 ORDER BY created_at LIMIT ?2)`,
  )
    .bind(now - WEBHOOK_LIMITS.retentionMs, WEBHOOK_LIMITS.pruneBatch)
    .run();
  return { pruned: r.meta.changes ?? 0 };
}

/** The Worker's cron trigger: enqueue what is due, prune old log rows, log the work counters. */
export async function runWebhookCron(env: Env): Promise<void> {
  const meter = new CostMeter();
  try {
    const result = await runWithMeter(meter, async () => {
      const e = meter.wrapEnv(env);
      return { ...(await pumpWebhookDeliveries(e)), ...(await pruneWebhookDeliveries(e)) };
    });
    console.log(JSON.stringify({ cost: meter.snapshot(), cron: 'webhooks', ...result }));
  } catch (err) {
    console.log(JSON.stringify({ cost: meter.snapshot(), cron: 'webhooks', error: String(err).slice(0, 200) }));
  }
}

export interface DeliveryDeps {
  fetch: typeof fetch;
  now: () => number;
}

export const defaultDeliveryDeps: DeliveryDeps = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export interface AttemptResult {
  outcome: 'delivered' | 'retry' | 'failed' | 'cancelled' | 'skipped';
  attempt?: number;
  status?: number | null;
  detail?: string;
}

interface ClaimRow {
  id: string;
  webhook_id: string;
  repo_id: string;
  event_id: string;
  event_type: string;
  attempts: number;
  lease_until: number | null;
  url: string | null;
  active: number | null;
  secret_ciphertext: string | null;
  secret_iv: string | null;
  key_version: number | null;
  consecutive_failures: number | null;
  payload: string | null;
}

async function readBounded(res: Response): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (size < WEBHOOK_LIMITS.responseReadBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    if (size >= WEBHOOK_LIMITS.responseReadBytes) truncated = true;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const all = new Uint8Array(Math.min(size, WEBHOOK_LIMITS.responseReadBytes));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  const text = new TextDecoder().decode(all);
  if (text.length > WEBHOOK_LIMITS.responseExcerptChars) return { text: text.slice(0, WEBHOOK_LIMITS.responseExcerptChars), truncated: true };
  return { text, truncated };
}

/** Final state for a delivery that will not be attempted (hook gone or disabled, event missing). */
async function settleWithoutAttempt(env: Env, id: string, lease: number, state: 'cancelled' | 'failed', reason: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET state = ?3, error = ?4, lease_until = NULL, completed_at = ?5, updated_at = ?5
      WHERE id = ?1 AND lease_until = ?2`,
  )
    .bind(id, lease, state, reason, now)
    .run();
}

/**
 * One delivery attempt (the `kvarm.webhook.delivery` queue message). Claims
 * the row (one D1 batch), POSTs the envelope, records the outcome (one D1
 * batch) and sends the next attempt's delayed message when one is due.
 * Never throws for an endpoint failure: those are recorded attempts.
 */
export async function deliverWebhook(env: Env, deliveryId: string, deps: DeliveryDeps = defaultDeliveryDeps): Promise<AttemptResult> {
  const now = deps.now();
  const lease = now + WEBHOOK_LIMITS.leaseMs;
  const [claim, read] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE webhook_deliveries SET attempts = attempts + 1, lease_until = ?2, updated_at = ?3
        WHERE id = ?1 AND state = 'pending' AND next_attempt_at <= ?3 + ?4 AND COALESCE(lease_until, 0) < ?3`,
    ).bind(deliveryId, lease, now, WEBHOOK_LIMITS.earlyMs),
    env.DB.prepare(
      `SELECT d.id, d.webhook_id, d.repo_id, d.event_id, d.event_type, d.attempts, d.lease_until,
              h.url, h.active, h.secret_ciphertext, h.secret_iv, h.key_version, h.consecutive_failures, e.payload
         FROM webhook_deliveries d
         LEFT JOIN webhooks h ON h.id = d.webhook_id
         LEFT JOIN events e ON e.id = d.event_id
        WHERE d.id = ?1`,
    ).bind(deliveryId),
  ]);
  const row = (read?.results as ClaimRow[] | undefined)?.[0];
  if (!claim?.meta.changes || !row || row.lease_until !== lease) return { outcome: 'skipped', detail: row ? 'not due or already handled' : 'unknown delivery' };

  if (row.url === null || row.secret_ciphertext === null || row.secret_iv === null) {
    await settleWithoutAttempt(env, deliveryId, lease, 'cancelled', 'webhook deleted', now);
    return { outcome: 'cancelled', detail: 'webhook deleted' };
  }
  if (row.active !== 1) {
    await settleWithoutAttempt(env, deliveryId, lease, 'cancelled', 'webhook disabled', now);
    return { outcome: 'cancelled', detail: 'webhook disabled' };
  }
  if (row.payload === null) {
    await settleWithoutAttempt(env, deliveryId, lease, 'failed', 'event no longer recorded', now);
    return { outcome: 'failed', detail: 'event missing' };
  }

  const attempt = row.attempts;
  let status: number | null = null;
  let error: string | null = null;
  let excerpt: string | null = null;
  let permanent = false;
  // A failure on the platform's side (the signing key) is not the endpoint's: it never counts toward disabling the hook.
  let platformFault = false;
  const started = Date.now();
  const target = checkWebhookUrl(row.url, selfHost(env));
  if (!target.ok) {
    // The policy tightened after the hook was created: never send, never retry.
    error = `url refused: ${target.reason}`;
    permanent = true;
  } else {
    let secret: string | null = null;
    try {
      secret = await openWebhookSecret(env, row.webhook_id, { ciphertext: row.secret_ciphertext, iv: row.secret_iv, keyVersion: row.key_version ?? 1 });
    } catch {
      error = 'signing secret unavailable (WEBHOOK_SECRET_KEY missing or changed); nothing was sent';
      platformFault = true;
    }
    if (secret !== null) {
      const timestamp = Math.floor(now / 1000);
      const body = row.payload;
      try {
        const res = await deps.fetch(target.url, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(WEBHOOK_LIMITS.timeoutMs),
          headers: {
            'content-type': 'application/cloudevents+json; charset=utf-8',
            'user-agent': 'Kvarm-Webhooks/1',
            'x-kvarm-event': row.event_type,
            'x-kvarm-event-id': row.event_id,
            'idempotency-key': row.event_id,
            'x-kvarm-delivery': deliveryId,
            'x-kvarm-attempt': String(attempt),
            'x-kvarm-timestamp': String(timestamp),
            'x-kvarm-signature': await signWebhook(secret, timestamp, body),
          },
          body,
        });
        status = res.status;
        const read = await readBounded(res);
        excerpt = read.text.length > 0 ? `${read.text}${read.truncated ? '…' : ''}` : null;
        if (status >= 300 && status < 400) error = 'redirect not followed';
        else if (status < 200 || status >= 300) error = `HTTP ${status}`;
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        error = name === 'TimeoutError' || name === 'AbortError' ? `timeout after ${WEBHOOK_LIMITS.timeoutMs} ms` : `network error: ${String(err)}`;
      }
    }
  }
  const latency = Date.now() - started;
  const done = deps.now();
  error = error === null ? null : error.slice(0, WEBHOOK_LIMITS.errorChars);
  const entry = JSON.stringify({ attempt, at: iso(now), status, latencyMs: latency, error } satisfies AttemptView);
  const record = (state: string, nextAt: number) =>
    env.DB.prepare(
      `UPDATE webhook_deliveries
          SET state = ?3, response_status = ?4, latency_ms = ?5, error = ?6, response_excerpt = ?7,
              attempt_log = json_insert(attempt_log, '$[#]', json(?8)), lease_until = NULL, updated_at = ?9,
              next_attempt_at = ?10, enqueued_at = CASE WHEN ?3 = 'pending' THEN ?9 ELSE enqueued_at END,
              completed_at = CASE WHEN ?3 = 'pending' THEN NULL ELSE ?9 END
        WHERE id = ?1 AND lease_until = ?2`,
    ).bind(deliveryId, lease, state, status, latency, error, excerpt, entry, done, nextAt);

  // Hook counters move only for the attempt whose outcome was recorded: one
  // that outlived its lease (another copy took over) changes nothing.
  const recorded = `EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.id = ?4 AND d.attempts = ?5 AND d.updated_at = ?2 AND d.lease_until IS NULL)`;
  if (error === null) {
    await env.DB.batch([
      record('delivered', now),
      env.DB.prepare(`UPDATE webhooks SET consecutive_failures = 0, last_delivery_at = ?2, last_status = ?3 WHERE id = ?1 AND ${recorded}`).bind(
        row.webhook_id,
        done,
        status,
        deliveryId,
        attempt,
      ),
    ]);
    return { outcome: 'delivered', attempt, status };
  }

  const final = permanent || attempt >= WEBHOOK_LIMITS.maxAttempts;
  const delay = webhookRetryDelaySeconds(attempt);
  const disabledId = `webhook-disabled-${row.webhook_id}-${done}`;
  const results = await env.DB.batch([
    record(final ? 'failed' : 'pending', final ? now : done + delay * 1000),
    env.DB.prepare(
      `UPDATE webhooks SET consecutive_failures = consecutive_failures + ?6, last_delivery_at = ?2, last_status = ?3 WHERE id = ?1 AND ${recorded}`,
    ).bind(row.webhook_id, done, status, deliveryId, attempt, platformFault ? 0 : 1),
    env.DB.prepare(
      `UPDATE webhooks SET active = 0, disabled_at = ?2, disabled_reason = 'consecutive delivery failures', updated_at = ?2
        WHERE id = ?1 AND active = 1 AND consecutive_failures >= ?3`,
    ).bind(row.webhook_id, done, WEBHOOK_LIMITS.disableAfterFailures),
    // Recorded like any platform event, so other hooks of the repository can subscribe to it.
    env.DB.prepare(
      `INSERT OR IGNORE INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, '${WEBHOOK_DISABLED_EVENT}',
              json_object('specversion', '1.0', 'id', ?1, 'type', '${WEBHOOK_DISABLED_EVENT}',
                          'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', h.id, 'time', ?4,
                          'datacontenttype', 'application/json',
                          'data', json_object('repo', r.owner_login || '/' || r.name, 'webhook', h.id, 'host', ?5,
                                              'consecutiveFailures', h.consecutive_failures, 'lastStatus', h.last_status, 'lastError', ?6)),
              NULL, ?3
         FROM webhooks h JOIN repos r ON r.id = h.repo_id
        WHERE h.id = ?2 AND h.active = 0 AND h.disabled_at = ?3 AND h.disabled_reason = 'consecutive delivery failures'`,
    ).bind(disabledId, row.webhook_id, done, iso(done), hostOf(row.url), error),
    cancelPendingStatement(env.DB, row.webhook_id, 'webhook disabled after repeated failures', done),
  ]);
  const disabled = (results[2]?.meta.changes ?? 0) > 0;
  if (!results[0]?.meta.changes) return { outcome: 'skipped', attempt, status, detail: 'lease lost; the other attempt records the outcome' };
  if (final || disabled) return { outcome: 'failed', attempt, status, detail: disabled ? 'webhook disabled' : error };
  try {
    await env.EVENTS.send({ type: WEBHOOK_DELIVERY_MESSAGE, deliveryId } satisfies WebhookDeliveryMessage, { delaySeconds: delay });
  } catch (err) {
    // The row is pending with a due time; the pump re-enqueues it once stale.
    console.warn(JSON.stringify({ webhookRetryEnqueueFailed: deliveryId, error: String(err).slice(0, 200) }));
  }
  return { outcome: 'retry', attempt, status, detail: error };
}
