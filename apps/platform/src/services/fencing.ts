/**
 * Generation/owner-fenced expiring claims (architecture §11.4, STEER v2 §0.1).
 *
 * A worker (a CI runner on a check, an agent on a task) claims a subject for
 * a bounded time under a fresh generation. Its report and its release must
 * name that generation and owner. A claim is taken over only once it expired
 * (a dead worker cannot strand the subject) or when the subject moved to a
 * new identity (for example a new head SHA); either bumps the generation, so
 * the earlier holder's late report or release is rejected and can never
 * overwrite or free its successor's claim. One D1 round trip per operation.
 */

import type { ServiceResult } from '../repos/service';
import { fail } from './result';

export interface ClaimView {
  kind: string;
  subject: string;
  generation: number;
  owner: string | null;
  identity: string | null;
  state: 'open' | 'claimed' | 'done';
  expiresAt: number | null;
  result: unknown;
}

interface ClaimRow {
  kind: string;
  subject: string;
  generation: number;
  owner: string | null;
  identity: string | null;
  state: 'open' | 'claimed' | 'done';
  expires_at: number | null;
  result: string | null;
}

export const CLAIM_LIMITS = { minTtlMs: 1, maxTtlMs: 3_600_000, maxRetryAfterMs: 60_000 };

type Fail = Extract<ServiceResult<never>, { ok: false }> & { current?: ClaimView | null; retryAfterMs?: number };


function view(r: ClaimRow | undefined | null): ClaimView | null {
  if (!r) return null;
  let result: unknown = null;
  if (r.result !== null) {
    try {
      result = JSON.parse(r.result);
    } catch {
      result = r.result;
    }
  }
  return { kind: r.kind, subject: r.subject, generation: r.generation, owner: r.owner, identity: r.identity, state: r.state, expiresAt: r.expires_at, result };
}

const SELECT = 'SELECT kind, subject, generation, owner, identity, state, expires_at, result FROM fenced_claims WHERE kind = ?1 AND subject = ?2';

export interface ClaimInput {
  kind: string;
  subject: string;
  owner: string;
  /** What the claim is for (e.g. a head SHA or tree:config identity); a different identity supersedes older claims. */
  identity: string | null;
  ttlMs: number;
  now?: number;
}

/** Takes the claim when it is open, expired or for another identity; refuses a live claim with a bounded retry hint. */
export async function claimFenced(db: D1Database, input: ClaimInput): Promise<ServiceResult<ClaimView> & { current?: ClaimView | null; retryAfterMs?: number }> {
  const now = input.now ?? Date.now();
  const ttl = Math.min(CLAIM_LIMITS.maxTtlMs, Math.max(CLAIM_LIMITS.minTtlMs, Math.floor(input.ttlMs)));
  const [, claimed, read] = await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO fenced_claims (kind, subject, generation, identity, state, updated_at) VALUES (?1, ?2, 0, ?3, 'open', ?4)`)
      .bind(input.kind, input.subject, input.identity, now),
    db
      .prepare(
        `UPDATE fenced_claims
            SET generation = generation + 1, owner = ?3, identity = ?4, state = 'claimed', expires_at = ?5 + ?6, result = NULL, updated_at = ?5
          WHERE kind = ?1 AND subject = ?2
            AND (identity IS NOT ?4 OR state = 'open' OR (state = 'claimed' AND expires_at <= ?5))
          RETURNING kind, subject, generation, owner, identity, state, expires_at, result`,
      )
      .bind(input.kind, input.subject, input.owner, input.identity, now, ttl),
    db.prepare(SELECT).bind(input.kind, input.subject),
  ]);
  const won = (claimed?.results as ClaimRow[] | undefined)?.[0];
  if (won) return { ok: true, value: view(won)! };
  const current = view((read?.results as ClaimRow[] | undefined)?.[0]);
  if (current?.state === 'done') return fail(409, `${input.kind} ${input.subject} is already completed`, 'CLAIM_DONE', { current });
  const retryAfterMs = Math.min(CLAIM_LIMITS.maxRetryAfterMs, Math.max(0, (current?.expiresAt ?? now) - now));
  return fail(409, `${input.kind} ${input.subject} is claimed by another worker`, 'CLAIMED', { current, retryAfterMs });
}

export interface FencedInput {
  kind: string;
  subject: string;
  generation: number;
  owner: string;
  now?: number;
}

function stale(input: FencedInput, current: ClaimView | null): Fail {
  return fail(
    409,
    `generation ${input.generation} of ${input.kind} ${input.subject} is no longer current (current generation ${current?.generation ?? 0})`,
    'STALE_GENERATION',
    { current },
  );
}

/** Records the claim holder's result. Rejected unless generation and owner are current and the claim is still held. */
export async function reportFenced(
  db: D1Database,
  input: FencedInput & { identity?: string | null; result: unknown },
): Promise<ServiceResult<ClaimView> & { current?: ClaimView | null }> {
  const now = input.now ?? Date.now();
  const [done, read] = await db.batch([
    db
      .prepare(
        `UPDATE fenced_claims SET state = 'done', result = ?5, updated_at = ?6
          WHERE kind = ?1 AND subject = ?2 AND generation = ?3 AND owner = ?4 AND state = 'claimed'
            AND (?7 IS NULL OR identity = ?7)
          RETURNING kind, subject, generation, owner, identity, state, expires_at, result`,
      )
      .bind(input.kind, input.subject, input.generation, input.owner, JSON.stringify(input.result ?? null), now, input.identity ?? null),
    db.prepare(SELECT).bind(input.kind, input.subject),
  ]);
  const row = (done?.results as ClaimRow[] | undefined)?.[0];
  if (row) return { ok: true, value: view(row)! };
  return stale(input, view((read?.results as ClaimRow[] | undefined)?.[0]));
}

/**
 * Extends the holder's lease to `ttlMs` from now (a heartbeat). Rejected
 * unless generation and owner are current and the claim is still held; a
 * lease that ran out but was not taken over yet may still be renewed.
 */
export async function renewFenced(db: D1Database, input: FencedInput & { ttlMs: number }): Promise<ServiceResult<ClaimView> & { current?: ClaimView | null }> {
  const now = input.now ?? Date.now();
  const ttl = Math.min(CLAIM_LIMITS.maxTtlMs, Math.max(CLAIM_LIMITS.minTtlMs, Math.floor(input.ttlMs)));
  const [renewed, read] = await db.batch([
    db
      .prepare(
        `UPDATE fenced_claims SET expires_at = ?5 + ?6, updated_at = ?5
          WHERE kind = ?1 AND subject = ?2 AND generation = ?3 AND owner = ?4 AND state = 'claimed'
          RETURNING kind, subject, generation, owner, identity, state, expires_at, result`,
      )
      .bind(input.kind, input.subject, input.generation, input.owner, now, ttl),
    db.prepare(SELECT).bind(input.kind, input.subject),
  ]);
  const row = (renewed?.results as ClaimRow[] | undefined)?.[0];
  if (row) return { ok: true, value: view(row)! };
  return stale(input, view((read?.results as ClaimRow[] | undefined)?.[0]));
}

/** Gives a held claim back (open) so another worker can take it at once. */
export async function releaseFenced(db: D1Database, input: FencedInput): Promise<ServiceResult<ClaimView> & { current?: ClaimView | null }> {
  const now = input.now ?? Date.now();
  const [released, read] = await db.batch([
    db
      .prepare(
        `UPDATE fenced_claims SET state = 'open', owner = NULL, expires_at = NULL, updated_at = ?5
          WHERE kind = ?1 AND subject = ?2 AND generation = ?3 AND owner = ?4 AND state = 'claimed'
          RETURNING kind, subject, generation, owner, identity, state, expires_at, result`,
      )
      .bind(input.kind, input.subject, input.generation, input.owner, now),
    db.prepare(SELECT).bind(input.kind, input.subject),
  ]);
  const row = (released?.results as ClaimRow[] | undefined)?.[0];
  if (row) return { ok: true, value: view(row)! };
  return stale(input, view((read?.results as ClaimRow[] | undefined)?.[0]));
}

/**
 * The subject moved to a new identity (a new head): earlier claims and
 * results no longer apply. Bumps the generation and reopens the claim.
 */
export async function advanceFenced(db: D1Database, kind: string, subject: string, identity: string, now = Date.now()): Promise<ClaimView | null> {
  const row = await db
    .prepare(
      `UPDATE fenced_claims SET generation = generation + 1, identity = ?3, state = 'open', owner = NULL, expires_at = NULL, result = NULL, updated_at = ?4
        WHERE kind = ?1 AND subject = ?2 AND identity IS NOT ?3
        RETURNING kind, subject, generation, owner, identity, state, expires_at, result`,
    )
    .bind(kind, subject, identity, now)
    .first<ClaimRow>();
  return view(row);
}

export async function readFenced(db: D1Database, kind: string, subject: string): Promise<ClaimView | null> {
  return view(await db.prepare(SELECT).bind(kind, subject).first<ClaimRow>());
}
