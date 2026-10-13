/**
 * Signed inbound incident webhooks (architecture §11.9): an incident system posts a
 * CloudEvents 1.0 event whose `subject` is a bad commit, and Kvarm opens a
 * revert change set for it (services/reverts.ts), through guard, CI and the
 * queue like any change.
 *
 * The secret. HMAC verification needs the secret itself, so a hash alone
 * cannot verify, and a stored secret (plain or encrypted next to its key)
 * lets anyone who reads D1 sign deliveries. Kvarm stores neither: the secret
 * is HMAC-SHA256(INCIDENT_WEBHOOK_KEY, repo id + random nonce), derived from
 * a Worker secret and shown once at rotation. D1 keeps the nonce and a
 * SHA-256 fingerprint, which are useless without the Worker secret.
 * Rotation writes a new nonce and the previous secret stops verifying at
 * once. Without the Worker secret the feature is off: rotation answers 503
 * and every delivery 401. Changing the Worker secret invalidates every
 * repository's incident secret (the fingerprint check names that case in
 * the logs, by count only). The secret never reaches a log line.
 *
 * A delivery. `x-kvarm-timestamp` (Unix seconds) must be within
 * `INCIDENT_LIMITS.toleranceSeconds` of now, and `x-kvarm-signature` must be
 * `sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. Every
 * refusal before the signature is verified is `401` and writes nothing:
 * stale or missing headers are refused before any D1 read, and an unknown
 * repository, a repository without a webhook and a bad signature answer
 * alike, so a delivery cannot probe which private repositories exist.
 * Replays inside the window are harmless: the event `id` is the idempotency
 * key, and a second delivery of an id answers with the change the first one
 * opened (200) instead of opening another.
 */

import { ZERO_OID, encode, hex, sha256Hex, unhex } from '@kvarm/gitops';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { incidentDeliveryAllowed } from '../ratelimit';
import { repoBranchRulesSelect, ruleFromRow, type BranchRuleRow } from './branchRules';
import { MERGE_POLICIES, changeView, readChange, type ChangeContext, type ChangeView, type MergePolicy } from './changes';
import { createRevert, defaultRevertDeps, liveRef, revertBranch, type RevertCreated, type RevertDeps } from './reverts';

declare global {
  interface Env {
    /**
     * Worker secret (>= 32 characters) that incident webhook secrets are
     * derived from (services/incidents.ts). Unset: incident webhooks are off.
     */
    INCIDENT_WEBHOOK_KEY?: string;
  }
}

export const INCIDENT_LIMITS = {
  /** Accepted clock difference between the signed timestamp and now. */
  toleranceSeconds: 300,
  /** Raw body bytes read and verified at most. */
  maxBodyBytes: 64 * 1024,
  /** A pending claim older than this belongs to a delivery that died; another delivery of the id may take it over. */
  claimTakeoverMs: 120_000,
  masterKeyMinLength: 32,
};

export const SIGNATURE_HEADER = 'x-kvarm-signature';
export const TIMESTAMP_HEADER = 'x-kvarm-timestamp';
const DERIVATION_LABEL = 'kvarm-incident-webhook/v1';

type Failure = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function refuse(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Failure {
  return { ok: false, status, error, code, ...extra };
}

/** The one 401 every unverifiable delivery gets, whatever made it unverifiable. */
const UNVERIFIED = refuse(401, 'the delivery signature could not be verified', 'INVALID_SIGNATURE');

function masterKey(env: Env): string | null {
  const k = env.INCIDENT_WEBHOOK_KEY;
  return typeof k === 'string' && k.length >= INCIDENT_LIMITS.masterKeyMinLength ? k : null;
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

async function deriveSecret(master: string, repoId: string, nonce: string): Promise<string> {
  const key = await hmacKey(master, 'sign');
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(`${DERIVATION_LABEL}\0${repoId}\0${nonce}`))));
}

function randomHex(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------------------------------------------------------------------------
// Secret management (repo admins)
// ---------------------------------------------------------------------------

interface WebhookRow {
  key_nonce: string;
  key_hash: string;
  generation: number;
  created_at: number;
  rotated_at: number;
}

export interface IncidentWebhookView {
  configured: boolean;
  /** False when the deployment has no INCIDENT_WEBHOOK_KEY: rotation is refused and no delivery verifies. */
  available: boolean;
  generation: number | null;
  /** First 12 hex characters of SHA-256(secret), to tell secrets apart; not usable to sign. */
  fingerprint: string | null;
  createdAt: string | null;
  rotatedAt: string | null;
  signatureHeader: string;
  timestampHeader: string;
  toleranceSeconds: number;
}

export interface IncidentSecretView extends IncidentWebhookView {
  /** Shown once: Kvarm cannot show it again, only rotate it. */
  secret: string;
}

export interface IncidentAdminContext {
  env: Env;
  repo: RepoRow;
  userId: string | null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function webhookView(env: Env, row: WebhookRow | null): IncidentWebhookView {
  return {
    configured: row !== null,
    available: masterKey(env) !== null,
    generation: row?.generation ?? null,
    fingerprint: row ? row.key_hash.slice(0, 12) : null,
    createdAt: iso(row?.created_at ?? null),
    rotatedAt: iso(row?.rotated_at ?? null),
    signatureHeader: SIGNATURE_HEADER,
    timestampHeader: TIMESTAMP_HEADER,
    toleranceSeconds: INCIDENT_LIMITS.toleranceSeconds,
  };
}

const WEBHOOK_SELECT = 'SELECT key_nonce, key_hash, generation, created_at, rotated_at FROM incident_webhooks WHERE repo_id = ?';

/** GET incidents/webhook */
export async function getIncidentWebhook(cx: IncidentAdminContext): Promise<ServiceResult<IncidentWebhookView>> {
  const row = await cx.env.DB.prepare(WEBHOOK_SELECT).bind(cx.repo.id).first<WebhookRow>();
  return { ok: true, value: webhookView(cx.env, row ?? null) };
}

/** POST incidents/webhook/rotate: creates the secret, or replaces it (the old one stops verifying). */
export async function rotateIncidentSecret(cx: IncidentAdminContext): Promise<ServiceResult<IncidentSecretView>> {
  const master = masterKey(cx.env);
  if (!master) return refuse(503, 'incident webhooks are not configured on this deployment (INCIDENT_WEBHOOK_KEY)', 'INCIDENTS_UNAVAILABLE');
  const nonce = randomHex(16);
  const secret = await deriveSecret(master, cx.repo.id, nonce);
  const now = Date.now();
  const row = await cx.env.DB.prepare(
    `INSERT INTO incident_webhooks (repo_id, key_nonce, key_hash, generation, created_by, created_at, rotated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
     ON CONFLICT(repo_id) DO UPDATE SET key_nonce = ?2, key_hash = ?3, generation = generation + 1, rotated_at = ?5
     RETURNING key_nonce, key_hash, generation, created_at, rotated_at`,
  )
    .bind(cx.repo.id, nonce, await sha256Hex(secret), cx.userId, now)
    .first<WebhookRow>();
  if (!row) return refuse(500, 'the incident secret could not be stored', 'ROTATE_FAILED');
  return { ok: true, value: { ...webhookView(cx.env, row), secret } };
}

/** DELETE incidents/webhook: no delivery verifies afterwards. Recorded deliveries stay as history. */
export async function deleteIncidentWebhook(cx: IncidentAdminContext): Promise<ServiceResult<{ deleted: boolean }>> {
  const r = await cx.env.DB.prepare('DELETE FROM incident_webhooks WHERE repo_id = ?').bind(cx.repo.id).run();
  return { ok: true, value: { deleted: (r.meta.changes ?? 0) > 0 } };
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

export interface IncidentEvent {
  id: string;
  source: string;
  type: string;
  subject: string;
  reason?: string;
  base?: string;
  mergePolicy?: MergePolicy;
}

export interface IncidentDelivery {
  owner: string;
  name: string;
  headers: Headers;
  body: Uint8Array;
  clientIp: string | null;
  waitUntil(p: Promise<unknown>): void;
  /** Unix seconds (tests); default now. */
  now?: number;
}

export type IncidentOutcome =
  | ({ duplicate: false; eventId: string } & RevertCreated)
  | { duplicate: true; eventId: string; change: ChangeView | null };

const EVENT_ID_MAX = 256;

/** Checks the signed timestamp and signature header shape; no I/O, so it runs before any lookup. */
function signedParts(headers: Headers, now: number): { timestamp: string; signature: Uint8Array } | null {
  const timestamp = headers.get(TIMESTAMP_HEADER)?.trim() ?? '';
  if (!/^\d{1,12}$/.test(timestamp)) return null;
  if (Math.abs(now - Number(timestamp)) > INCIDENT_LIMITS.toleranceSeconds) return null;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(headers.get(SIGNATURE_HEADER)?.trim() ?? '');
  if (!m) return null;
  return { timestamp, signature: unhex(m[1]!.toLowerCase()) };
}

export function parseIncidentEvent(body: Uint8Array): ServiceResult<IncidentEvent> {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return refuse(400, 'the body must be a JSON CloudEvents 1.0 event', 'INVALID_EVENT');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return refuse(400, 'the body must be a JSON CloudEvents 1.0 event', 'INVALID_EVENT');
  const e = v as Record<string, unknown>;
  if (e.specversion !== '1.0') return refuse(422, 'specversion must be "1.0"', 'INVALID_EVENT');
  for (const k of ['id', 'source', 'type'] as const) {
    if (typeof e[k] !== 'string' || (e[k] as string).length === 0 || (e[k] as string).length > EVENT_ID_MAX) {
      return refuse(422, `${k} must be a non-empty string of at most ${EVENT_ID_MAX} characters`, 'INVALID_EVENT');
    }
  }
  if (typeof e.subject !== 'string' || !/^[0-9a-fA-F]{40}$/.test(e.subject)) {
    return refuse(422, 'subject must be the full 40-character id of the commit to revert', 'INVALID_EVENT');
  }
  const out: IncidentEvent = { id: e.id as string, source: e.source as string, type: e.type as string, subject: e.subject.toLowerCase() };
  if (e.data !== undefined && e.data !== null) {
    if (typeof e.data !== 'object' || Array.isArray(e.data)) return refuse(422, 'data must be an object', 'INVALID_EVENT');
    const d = e.data as Record<string, unknown>;
    if (d.reason !== undefined) {
      if (typeof d.reason !== 'string') return refuse(422, 'data.reason must be a string', 'INVALID_EVENT');
      out.reason = d.reason;
    }
    if (d.base !== undefined) {
      if (typeof d.base !== 'string') return refuse(422, 'data.base must be a branch name', 'INVALID_EVENT');
      out.base = d.base;
    }
    if (d.mergePolicy !== undefined) {
      if (typeof d.mergePolicy !== 'string' || !(MERGE_POLICIES as readonly string[]).includes(d.mergePolicy)) {
        return refuse(422, `data.mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_EVENT');
      }
      out.mergePolicy = d.mergePolicy as MergePolicy;
    }
  }
  return { ok: true, value: out };
}

interface ClaimRow {
  state: 'pending' | 'opened';
  claim: string;
  change_number: number | null;
  subject_sha: string;
}

type Found = RepoRow & { incident_key_nonce: string; incident_key_hash: string };

/** Stands in for a missing webhook so an unknown repository costs the same key work as a known one. */
const DECOY = { id: 'kvarm-incident-decoy', nonce: '0'.repeat(32) };

/** POST incidents: see the module comment. */
export async function receiveIncident(d: IncidentDelivery, env: Env, deps: RevertDeps = defaultRevertDeps): Promise<ServiceResult<IncidentOutcome>> {
  const now = d.now ?? Math.floor(Date.now() / 1000);
  if (d.body.length > INCIDENT_LIMITS.maxBodyBytes) return refuse(413, `the body exceeds ${INCIDENT_LIMITS.maxBodyBytes} bytes`, 'BODY_TOO_LARGE');
  const signed = signedParts(d.headers, now);
  if (!signed) return UNVERIFIED;
  const master = masterKey(env);
  if (!master) return UNVERIFIED;
  // Bounds the D1 lookups unverified deliveries can cause, in a bucket of its own so other unauthenticated traffic from one IP does not delay incidents.
  if (!(await incidentDeliveryAllowed(env, `${d.owner}/${d.name}`, d.clientIp))) return refuse(429, 'too many incident deliveries, retry shortly', 'RATE_LIMITED');

  const found = await env.DB.prepare(
    `SELECT r.*, w.key_nonce AS incident_key_nonce, w.key_hash AS incident_key_hash
       FROM repos r JOIN incident_webhooks w ON w.repo_id = r.id
      WHERE r.owner_login = ? AND r.name = ?`,
  )
    .bind(d.owner, d.name)
    .first<Found>();
  // Derive and verify even without a webhook, so response time does not tell which repositories have one.
  const secret = await deriveSecret(master, found?.id ?? DECOY.id, found?.incident_key_nonce ?? DECOY.nonce);
  const signedBytes = new Uint8Array(signed.timestamp.length + 1 + d.body.length);
  signedBytes.set(encode(`${signed.timestamp}.`), 0);
  signedBytes.set(d.body, signed.timestamp.length + 1);
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), signed.signature, signedBytes);
  const fingerprint = await sha256Hex(secret);
  if (!found || !valid) {
    if (found && fingerprint !== found.incident_key_hash) console.warn(JSON.stringify({ incidentKeyMismatch: 1 }));
    return UNVERIFIED;
  }
  const { incident_key_nonce: _n, incident_key_hash: _h, ...repo } = found;

  const parsed = parseIncidentEvent(d.body);
  if (!parsed.ok) return parsed;
  const ev = parsed.value;
  const key = { repoId: repo.id, source: ev.source, id: ev.id };

  // Claim the event before any ref is written, so concurrent deliveries of one event open one change.
  const claim = randomHex(8);
  const nowMs = Date.now();
  const [, read] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO incident_events (repo_id, event_source, event_id, subject_sha, state, claim, claimed_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)
       ON CONFLICT(repo_id, event_source, event_id) DO UPDATE SET claim = ?5, claimed_at = ?6
        WHERE incident_events.state = 'pending' AND incident_events.claimed_at < ?7 AND incident_events.subject_sha = ?4`,
    ).bind(repo.id, ev.source, ev.id, ev.subject, claim, nowMs, nowMs - INCIDENT_LIMITS.claimTakeoverMs),
    env.DB.prepare('SELECT state, claim, change_number, subject_sha FROM incident_events WHERE repo_id = ? AND event_source = ? AND event_id = ?').bind(
      repo.id,
      ev.source,
      ev.id,
    ),
  ]);
  const row = (read?.results as ClaimRow[] | undefined)?.[0];
  if (!row) return refuse(500, 'the event could not be recorded', 'EVENT_RECORD_FAILED');
  // An event is immutable: the same source and id naming another commit is a sender error, never another revert or someone else's change.
  if (row.subject_sha !== ev.subject) return refuse(409, 'this event source and id were already delivered with another subject', 'EVENT_ID_REUSED');
  if (row.state === 'opened') return duplicate(env, repo.id, ev.id, row.change_number);
  if (row.claim !== claim) return refuse(409, 'another delivery of this event is being processed; retry shortly', 'EVENT_IN_PROGRESS');

  const rules = ((await repoBranchRulesSelect(env.DB, repo.id).all<BranchRuleRow>()).results ?? []).map(ruleFromRow);
  const cx: ChangeContext = { env, repo, actor: null, branchRules: rules, waitUntil: d.waitUntil };
  const request = { sha: ev.subject, mergePolicy: ev.mergePolicy ?? 'draft', ...(ev.reason !== undefined ? { reason: ev.reason } : {}), ...(ev.base !== undefined ? { base: ev.base } : {}) };
  const origin = {
    note: `Opened by incident event ${JSON.stringify(ev.id)} (type ${JSON.stringify(ev.type)}, source ${JSON.stringify(ev.source)}).`,
    // Named after the event: a delivery that took over an abandoned claim meets the first one's branch instead of opening a second change.
    branchKey: (await sha256Hex(`${ev.source}\0${ev.id}`)).slice(0, 8),
  };
  const ref = `refs/heads/${revertBranch(ev.subject, origin.branchKey)}`;
  const adopt = async (): Promise<number | null> => {
    const existing = await env.DB.prepare(`SELECT number FROM change_sets WHERE repo_id = ? AND head_ref = ? AND kind = 'revert'`)
      .bind(repo.id, ref.slice('refs/heads/'.length))
      .first<{ number: number }>();
    return existing?.number ?? null;
  };

  let opened: ServiceResult<RevertCreated>;
  try {
    opened = await createRevert(cx, request, deps, origin);
    if (!opened.ok && opened.code === 'REVERT_BRANCH_EXISTS') {
      const number = await adopt();
      if (number !== null) {
        await markOpened(env, key, claim, number);
        return duplicate(env, repo.id, ev.id, number);
      }
      // The earlier delivery pushed the branch and died before its change existed. The orphan is
      // removed (compare-and-swap on the value read) and the revert is planned again on the current tip.
      const orphan = await liveRef(cx, ref);
      if (orphan) await deps.pusher(env, repo).updateRef({ ref, oldOid: orphan, newOid: ZERO_OID });
      opened = await createRevert(cx, request, deps, origin);
      if (!opened.ok && opened.code === 'REVERT_BRANCH_EXISTS') {
        const raced = await adopt();
        if (raced !== null) {
          await markOpened(env, key, claim, raced);
          return duplicate(env, repo.id, ev.id, raced);
        }
      }
    }
  } catch (err) {
    await releaseClaim(env, key, claim);
    throw err;
  }
  if (!opened.ok) {
    await releaseClaim(env, key, claim);
    return opened;
  }
  // A lost claim means another delivery took it over; one change per revert branch kept it from opening a second change.
  if (!(await markOpened(env, key, claim, opened.value.change.number))) console.warn(JSON.stringify({ incidentClaimLost: 1 }));
  return { ok: true, value: { duplicate: false, eventId: ev.id, ...opened.value } };
}

async function duplicate(env: Env, repoId: string, eventId: string, number: number | null): Promise<ServiceResult<IncidentOutcome>> {
  const change = number !== null ? await readChange(env, repoId, number) : null;
  return { ok: true, value: { duplicate: true, eventId, change: change ? changeView(change) : null } };
}

interface EventKey {
  repoId: string;
  source: string;
  id: string;
}

async function markOpened(env: Env, key: EventKey, claim: string, number: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE incident_events SET state = 'opened', change_set_id = (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?5), change_number = ?5, opened_at = ?6
      WHERE repo_id = ?1 AND event_source = ?2 AND event_id = ?3 AND claim = ?4 AND state = 'pending'`,
  )
    .bind(key.repoId, key.source, key.id, claim, number, Date.now())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

function releaseClaim(env: Env, key: EventKey, claim: string): Promise<unknown> {
  return env.DB.prepare(`DELETE FROM incident_events WHERE repo_id = ? AND event_source = ? AND event_id = ? AND claim = ? AND state = 'pending'`)
    .bind(key.repoId, key.source, key.id, claim)
    .run();
}
