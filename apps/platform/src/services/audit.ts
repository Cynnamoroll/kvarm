/**
 * The audit export (architecture §9 provenance): who (human, agent, session,
 * token prefix) changed which commit and when, one record per commit, joined
 * in D1 from the attribution evidence (services/provenance.ts), confirmed
 * pushes at the git gate and merge publications (`ref_updates`).
 *
 * A page is one indexed D1 read over `audit_commits` (first-seen time, then
 * sha), so with the authority lookup a page costs two D1 round trips. Records
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
 * One `ref_updates` row per ref a gate push confirmed. The credential prefix
 * is read by id inside the statement, so no token material is handled here.
 */
export function pushAuditStatements(db: D1Database, repoId: string, actor: Actor | null, commands: readonly RefCommand[], confirmed: readonly string[], at = Date.now()): D1PreparedStatement[] {
  const ok = new Set(confirmed);
  return commands.filter((c) => ok.has(c.ref)).map((c) => refUpdateStatement(db, { repoId, ref: c.ref, oldSha: c.oldOid, newSha: c.newOid, via: 'push', change: null, actor, at }));
}

/** The `ref_updates` row of a direct merge's publication. */
export function mergeAuditStatement(
  db: D1Database,
  repoId: string,
  actor: Actor | null,
  m: { ref: string; previous: string; mergeCommit: string; change: number },
  at: number,
): D1PreparedStatement {
  return refUpdateStatement(db, { repoId, ref: m.ref, oldSha: m.previous, newSha: m.mergeCommit, via: 'merge', change: m.change, actor, at });
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

function encodeCursor(at: number, sha: string): string {
  return btoa(JSON.stringify([at, sha])).replace(/=+$/, '');
}

function decodeCursor(raw: string): { at: number; sha: string } | null {
  try {
    const v: unknown = JSON.parse(atob(raw));
    if (Array.isArray(v) && v.length === 2 && Number.isSafeInteger(v[0]) && typeof v[1] === 'string' && /^[0-9a-f]{40}$/.test(v[1])) {
      return { at: v[0] as number, sha: v[1] };
    }
  } catch {
    // not one of ours
  }
  return null;
}

interface AuditRow {
  commit_sha: string;
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

/** GET audit?since=&until=&limit=&cursor= — one record per commit, oldest first. */
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
  let after: { at: number; sha: string } | null = null;
  if (q.cursor) {
    after = decodeCursor(q.cursor);
    if (!after) return fail(400, 'INVALID_CURSOR', 'cursor is not a nextCursor from this endpoint');
  }

  // One statement: a seek on (repo_id, first_at, commit_sha) that stops after one page plus one, the
  // evidence row by primary key, and each commit's first updates + 1 by the (repo_id, new_sha, at, id) index.
  const { results } = await env.DB.prepare(
    `SELECT a.commit_sha, a.first_at,
            e.agent, e.session, e.prompt_hash, e.model, e.actor, e.at, e.source, e.level, e.reasons, e.principal,
            e.token_kind, e.token_prefix, e.run_id, e.key_id,
            (SELECT json_group_array(json_object('via', u.via, 'ref', u.ref, 'before', u.old_sha, 'change', u.change_number, 'at', u.at,
                                                 'principal', u.principal, 'actor', u.actor_login, 'agent', u.agent_name,
                                                 'tokenKind', u.token_kind, 'tokenPrefix', u.token_prefix))
               FROM (SELECT * FROM ref_updates u WHERE u.repo_id = a.repo_id AND u.new_sha = a.commit_sha
                      ORDER BY u.at, u.id LIMIT ${AUDIT_LIMITS.updatesPerCommit + 1}) u) AS updates
       FROM (SELECT repo_id, commit_sha, first_at FROM audit_commits
              WHERE repo_id = ?1 AND first_at >= ?2 AND first_at < ?3 AND (first_at, commit_sha) > (?4, ?5)
              ORDER BY first_at, commit_sha LIMIT ?6) a
       LEFT JOIN attribution_evidence e ON e.repo_id = a.repo_id AND e.commit_sha = a.commit_sha
      ORDER BY a.first_at, a.commit_sha`,
  )
    .bind(repo.id, since ?? 0, until ?? Number.MAX_SAFE_INTEGER, after?.at ?? -1, after?.sha ?? '', limit + 1)
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
      nextCursor: truncated && last ? encodeCursor(last.first_at, last.commit_sha) : null,
    },
  };
}
