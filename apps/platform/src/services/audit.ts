/**
 * The audit export (architecture §9 provenance): who (human, agent, session,
 * token prefix) changed which commit and when, one record per commit, joined
 * in D1 from the attribution evidence (services/provenance.ts), confirmed
 * pushes at the git gate and merge publications (`ref_updates`).
 *
 * A page is one indexed D1 read over `audit_commits` in insertion order, so
 * with the authority lookup a page costs two D1 round trips. Records
 * never carry a token or secret: credentials appear as their public prefix,
 * read from the credential row at write time.
 *
 * Callers authorize first through the shared authority lookup; nothing here
 * checks access.
 */

import type { RefCommand } from '@kvarm/gitops';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { evidenceFromRow } from './attribution';
import { submitterOf, type Evidence, type EvidenceLevel } from './provenance';

export const AUDIT_LIMITS = {
  pageDefault: 50,
  pageMax: 200,
  /** Ref updates (pushes and merges) listed per commit; more set `updatesTruncated`. */
  updatesPerCommit: 8,
} as const;

export interface AuditRefUpdate {
  ref: string;
  /** The ref's previous commit ('' when the queue did not record it). */
  before: string;
  /** ISO 8601 UTC */
  at: string;
  principal: string | null;
  actor: string | null;
  agent: string | null;
  tokenKind: Evidence['tokenKind'];
  tokenPrefix: string | null;
}

export interface AuditMerge extends AuditRefUpdate {
  via: 'merge' | 'queue';
  change: number | null;
}

export interface AuditRecord {
  commit: string;
  /** When Kvarm first recorded the commit (attribution or ref update); `since`/`until` filter on it. */
  firstSeenAt: string;
  agent: string | null;
  session: string | null;
  promptHash: string | null;
  model: string | null;
  actor: string | null;
  attributedAt: string | null;
  attributionSource: 'api' | 'merge' | 'task' | null;
  /** Null for a commit that has no attribution through Kvarm. */
  evidenceLevel: EvidenceLevel | null;
  evidence: Evidence | null;
  /** Prefix of the credential that wrote the attribution. */
  tokenPrefix: string | null;
  /** First confirmed push of this commit as a ref tip through the git gate. */
  pushedAt: string | null;
  pushes: AuditRefUpdate[];
  merges: AuditMerge[];
  updatesTruncated: boolean;
}

export interface AuditPage {
  since: string | null;
  until: string | null;
  records: AuditRecord[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface AuditQuery {
  since?: string | undefined;
  until?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, code: string, error: string): Fail => ({ ok: false, status, code, error });

const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// Ledger writes
// ---------------------------------------------------------------------------

/**
 * Records one `ref_updates` row per ref a gate push confirmed. Best effort:
 * the push already landed, and the audit ledger must never fail it. The
 * credential prefix is read by id inside the statement, so no token material
 * is handled here.
 */
export async function recordPushAudit(env: Env, repoId: string, actor: Actor | null, commands: readonly RefCommand[], confirmed: readonly string[]): Promise<void> {
  const ok = new Set(confirmed);
  const at = Date.now();
  const rows = commands
    .filter((c) => ok.has(c.ref))
    .map((c) => refUpdateStatement(env.DB, { repoId, ref: c.ref, oldSha: c.oldOid, newSha: c.newOid, via: 'push', change: null, actor, at }));
  if (rows.length === 0) return;
  await env.DB.batch(rows).catch((err: unknown) => console.warn(JSON.stringify({ pushAuditFailed: String(err).slice(0, 200), repo: repoId })));
}

/** Records a direct merge's publication; best effort, like the push record. */
export async function recordMergeAudit(
  env: Env,
  repoId: string,
  actor: Actor | null,
  m: { ref: string; previous: string; mergeCommit: string; change: number },
  at: number,
): Promise<void> {
  await refUpdateStatement(env.DB, { repoId, ref: m.ref, oldSha: m.previous, newSha: m.mergeCommit, via: 'merge', change: m.change, actor, at })
    .run()
    .catch((err: unknown) => console.warn(JSON.stringify({ mergeAuditFailed: String(err).slice(0, 200), repo: repoId, mergeCommit: m.mergeCommit })));
}

function refUpdateStatement(
  db: D1Database,
  u: { repoId: string; ref: string; oldSha: string; newSha: string; via: 'push' | 'merge'; change: number | null; actor: Actor | null; at: number },
): D1PreparedStatement {
  const s = submitterOf(u.actor);
  return db
    .prepare(
      `INSERT INTO ref_updates (id, repo_id, ref, old_sha, new_sha, via, change_number, principal, actor_login, agent_name, token_kind, token_prefix, at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
               CASE ?11 WHEN 'pat' THEN (SELECT prefix FROM pat WHERE id = ?12)
                        WHEN 'agent' THEN (SELECT prefix FROM agent_tokens WHERE id = ?12) END,
               ?13)`,
    )
    .bind(
      crypto.randomUUID(),
      u.repoId,
      u.ref,
      u.oldSha,
      u.newSha,
      u.via,
      u.change,
      s.principal,
      u.actor?.user.login ?? null,
      u.actor?.agent?.agentName ?? null,
      s.tokenKind,
      s.tokenId,
      u.at,
    );
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function parseTime(raw: string | undefined, name: string): number | null | Fail {
  if (raw === undefined || raw === '') return null;
  // ISO 8601 with an explicit zone, so a query means the same instant everywhere.
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/.test(raw)) {
    return fail(400, 'INVALID_TIME', `${name} must be an ISO 8601 date or UTC time such as 2026-01-31T12:00:00Z`);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return fail(400, 'INVALID_TIME', `${name} is not a valid time`);
  return ms;
}

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as Fail).ok === false;

function encodeCursor(seq: number): string {
  return btoa(JSON.stringify(['a', seq])).replace(/=+$/, '');
}

function decodeCursor(raw: string): number | null {
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && v.length === 2 && v[0] === 'a' && Number.isSafeInteger(v[1]) && (v[1] as number) >= 0) return v[1] as number;
  } catch {
    // not one of ours
  }
  return null;
}

interface AuditRow {
  commit_sha: string;
  seq: number;
  first_at: number;
  agent: string | null;
  session: string | null;
  prompt_hash: string | null;
  model: string | null;
  actor: string | null;
  at: number | null;
  source: AuditRecord['attributionSource'];
  level: EvidenceLevel | null;
  reasons: string | null;
  principal: string | null;
  token_kind: Evidence['tokenKind'];
  token_prefix: string | null;
  run_id: string | null;
  key_id: string | null;
  updates: string;
}

interface UpdateJson {
  via: 'push' | 'merge' | 'queue';
  ref: string;
  before: string;
  change: number | null;
  at: number;
  principal: string | null;
  actor: string | null;
  agent: string | null;
  tokenKind: Evidence['tokenKind'];
  tokenPrefix: string | null;
}

function toRecord(r: AuditRow): AuditRecord {
  let updates: UpdateJson[] = [];
  try {
    updates = JSON.parse(r.updates) as UpdateJson[];
  } catch {
    // json_group_array always yields an array
  }
  const updatesTruncated = updates.length > AUDIT_LIMITS.updatesPerCommit;
  updates = updates.slice(0, AUDIT_LIMITS.updatesPerCommit);
  const base = (u: UpdateJson): AuditRefUpdate => ({
    ref: u.ref,
    before: u.before,
    at: iso(u.at),
    principal: u.principal,
    actor: u.actor,
    agent: u.agent,
    tokenKind: u.tokenKind,
    tokenPrefix: u.tokenPrefix,
  });
  const pushes = updates.filter((u) => u.via === 'push').map(base);
  const merges = updates
    .filter((u): u is UpdateJson & { via: 'merge' | 'queue' } => u.via !== 'push')
    .map((u) => ({ via: u.via, change: u.change, ...base(u) }));
  const evidence =
    r.level === null
      ? null
      : evidenceFromRow({ level: r.level, reasons: r.reasons ?? '[]', principal: r.principal, token_kind: r.token_kind, token_prefix: r.token_prefix, run_id: r.run_id, key_id: r.key_id });
  return {
    commit: r.commit_sha,
    firstSeenAt: iso(r.first_at),
    agent: r.agent,
    session: r.session,
    promptHash: r.prompt_hash,
    model: r.model,
    actor: r.actor,
    attributedAt: r.at === null ? null : iso(r.at),
    attributionSource: r.source,
    evidenceLevel: r.level,
    evidence,
    tokenPrefix: r.token_prefix,
    pushedAt: pushes[0]?.at ?? null,
    pushes,
    merges,
    updatesTruncated,
  };
}

/** GET audit?since=&until=&limit=&cursor= — one record per commit, in the order Kvarm first recorded them. */
export async function readAudit(env: Env, repo: RepoRow, q: AuditQuery): Promise<ServiceResult<AuditPage>> {
  const since = parseTime(q.since, 'since');
  if (isFail(since)) return since;
  const until = parseTime(q.until, 'until');
  if (isFail(until)) return until;
  if (since !== null && until !== null && until < since) return fail(400, 'INVALID_TIME', 'until must not be before since');
  let limit: number = AUDIT_LIMITS.pageDefault;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > AUDIT_LIMITS.pageMax) return fail(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${AUDIT_LIMITS.pageMax}`);
    limit = n;
  }
  let after = 0;
  if (q.cursor) {
    const seq = decodeCursor(q.cursor);
    if (seq === null) return fail(400, 'INVALID_CURSOR', 'cursor is not a nextCursor from this endpoint');
    after = seq;
  }

  // One statement. Pages follow the insertion sequence, so a commit recorded after a page was read sorts after
  // it. The time window becomes a sequence range by one seek at each end of the (repo_id, first_at, seq) index;
  // first_at is filtered again because the database clock is only nearly monotonic. Each page row then reads
  // the commit's newest evidence row and its first updates + 1 by index.
  const { results } = await env.DB.prepare(
    `SELECT a.commit_sha, a.seq, a.first_at,
            e.agent, e.session, e.prompt_hash, e.model, e.actor, e.at, e.source, e.level, e.reasons, e.principal,
            e.token_kind, e.token_prefix, e.run_id, e.key_id,
            (SELECT json_group_array(json_object('via', u.via, 'ref', u.ref, 'before', u.old_sha, 'change', u.change_number, 'at', u.at,
                                                 'principal', u.principal, 'actor', u.actor_login, 'agent', u.agent_name,
                                                 'tokenKind', u.token_kind, 'tokenPrefix', u.token_prefix))
               FROM (SELECT * FROM ref_updates u WHERE u.repo_id = a.repo_id AND u.new_sha = a.commit_sha
                      ORDER BY u.at, u.id LIMIT ${AUDIT_LIMITS.updatesPerCommit + 1}) u) AS updates
       FROM (SELECT repo_id, commit_sha, seq, first_at FROM audit_commits
              WHERE repo_id = ?1 AND first_at >= ?2 AND first_at < ?3 AND seq > ?4
                AND seq >= COALESCE((SELECT seq FROM audit_commits WHERE repo_id = ?1 AND first_at >= ?2 ORDER BY first_at, seq LIMIT 1), 0)
                AND seq <= COALESCE((SELECT seq FROM audit_commits WHERE repo_id = ?1 AND first_at < ?3 ORDER BY first_at DESC, seq DESC LIMIT 1), 0)
              ORDER BY seq LIMIT ?5) a
       LEFT JOIN attribution_evidence e ON e.repo_id = a.repo_id AND e.commit_sha = a.commit_sha
             AND e.note_digest = (SELECT x.note_digest FROM attribution_evidence x WHERE x.repo_id = a.repo_id AND x.commit_sha = a.commit_sha
                                   ORDER BY x.recorded_at DESC, x.note_digest DESC LIMIT 1)
      ORDER BY a.seq`,
  )
    .bind(repo.id, since ?? 0, until ?? Number.MAX_SAFE_INTEGER, after, limit + 1)
    .all<AuditRow>();
  const truncated = results.length > limit;
  const kept = results.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    ok: true,
    value: {
      since: since === null ? null : iso(since),
      until: until === null ? null : iso(until),
      records: kept.map(toRecord),
      truncated,
      nextCursor: truncated && last ? encodeCursor(last.seq) : null,
    },
  };
}
