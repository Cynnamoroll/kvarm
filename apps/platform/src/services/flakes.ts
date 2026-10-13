/**
 * Flake registry and check quarantine (issue #13): the classification side of
 * retry-then-classify flaky-check handling. The retry itself lives in
 * reportJob (services/ci.ts), which requeues exactly one automatic second
 * attempt of a failed required, non-quarantined runner check and records
 * here the checks whose second attempt passed, with the first attempt's
 * failure summary as evidence. A check that fails both attempts is never
 * registered and blocks as before.
 *
 * Quarantine is per repository and check name and only ever set by an
 * explicit repo-admin action: the check still queues and runs (queueJobs
 * marks its check runs quarantined), but quarantined runs are excluded from
 * the checks gate and the commit-status rollup, so they never satisfy or
 * block a merge, and their failures never retry. Restore clears the flag on
 * the recorded runs and returns the name to normal handling.
 *
 * Both are tracked as issues (services/issues.ts): every registered flake
 * files or counts on the check's open issue (fingerprint `check:<name>`), a
 * quarantine makes sure one is open, and a restore closes it as `restored`.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { checkFingerprint } from '@kvarm/issues';
import { CI_LIMITS } from './ciConfig';
import { quarantineIssueStatement, resolveSignalStatements } from './issues';

const FLAKE_PAGE_DEFAULT = 50;
const FLAKE_PAGE_MAX = 100;

export interface FlakeView {
  id: string;
  name: string;
  change: number | null;
  headSha: string;
  treeSha: string;
  /** The attempt that passed after the recorded failure (always 2). */
  attempt: number;
  /** The first attempt's failure summary, the evidence of the flake. */
  summary: unknown;
  seenAt: string;
}

export interface QuarantineView {
  name: string;
  quarantinedBy: string | null;
  quarantinedAt: string;
}

export interface FlakesView {
  flakes: FlakeView[];
  quarantined: QuarantineView[];
  nextCursor: string | null;
}

interface FlakeRow {
  id: string;
  name: string;
  change_number: number | null;
  head_sha: string;
  tree_sha: string;
  attempt: number;
  summary: string | null;
  seen_at: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

function parseSummary(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * A quarantinable check name: runner-check names only. Platform check names
 * (`kvarm/…`, for example the guard) carry verdicts no repository action
 * should be able to wave away, so they are refused.
 */
function checkNameOf(input: unknown): ServiceResult<string> {
  const name = typeof input === 'string' ? input.trim() : '';
  if (name.length === 0 || name.length > CI_LIMITS.name || name.toLowerCase().startsWith('kvarm/')) {
    return { ok: false, status: 422, error: `check name must be 1-${CI_LIMITS.name} characters and may not start with kvarm/`, code: 'INVALID_CHECK_NAME' };
  }
  return { ok: true, value: name };
}

/** The repository's quarantined check names, for queueJobs to mark new runs. */
export async function quarantinedNames(db: D1Database, repoId: string): Promise<Set<string>> {
  const rows = await db.prepare('SELECT name FROM ci_quarantine WHERE repo_id = ? ORDER BY name LIMIT ?').bind(repoId, FLAKE_PAGE_MAX).all<{ name: string }>();
  return new Set((rows.results ?? []).map((r) => r.name));
}

function encodeCursor(seenAt: number, id: string): string {
  return btoa(`${seenAt}:${id}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): { seenAt: number; id: string } | null {
  try {
    const text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const m = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(text);
    return m ? { seenAt: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
}

/** The flake registry (newest first) and the currently quarantined names. */
export async function listFlakes(env: Env, repo: RepoRow, page: { limit?: string; cursor?: string }): Promise<ServiceResult<FlakesView>> {
  let limit = FLAKE_PAGE_DEFAULT;
  if (page.limit !== undefined) {
    limit = /^\d{1,4}$/.test(page.limit) ? Number(page.limit) : 0;
    if (limit < 1 || limit > FLAKE_PAGE_MAX) {
      return { ok: false, status: 400, error: `limit must be an integer from 1 to ${FLAKE_PAGE_MAX}`, code: 'INVALID_LIMIT' };
    }
  }
  const after = page.cursor === undefined ? null : decodeCursor(page.cursor);
  if (page.cursor !== undefined && !after) {
    return { ok: false, status: 400, error: 'invalid cursor', code: 'INVALID_CURSOR' };
  }
  const base = `SELECT f.id, f.name, c.number AS change_number, f.head_sha, f.tree_sha, f.attempt, f.summary, f.seen_at
    FROM ci_flakes f LEFT JOIN change_sets c ON c.id = f.change_set_id WHERE f.repo_id = ?1`;
  const stmt = after
    ? env.DB.prepare(`${base} AND (f.seen_at < ?2 OR (f.seen_at = ?2 AND f.id < ?3)) ORDER BY f.seen_at DESC, f.id DESC LIMIT ?4`).bind(repo.id, after.seenAt, after.id, limit + 1)
    : env.DB.prepare(`${base} ORDER BY f.seen_at DESC, f.id DESC LIMIT ?2`).bind(repo.id, limit + 1);
  const [flakes, quarantined] = await Promise.all([
    stmt.all<FlakeRow>(),
    env.DB.prepare(
      `SELECT q.name, u.login AS quarantined_by, q.quarantined_at
         FROM ci_quarantine q LEFT JOIN users u ON u.id = q.quarantined_by
        WHERE q.repo_id = ?1 ORDER BY q.name LIMIT ?2`,
    )
      .bind(repo.id, FLAKE_PAGE_MAX)
      .all<{ name: string; quarantined_by: string | null; quarantined_at: number }>(),
  ]);
  const rows = flakes.results ?? [];
  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    ok: true,
    value: {
      flakes: pageRows.map((r) => ({
        id: r.id,
        name: r.name,
        change: r.change_number ?? null,
        headSha: r.head_sha,
        treeSha: r.tree_sha,
        attempt: r.attempt,
        summary: parseSummary(r.summary),
        seenAt: iso(r.seen_at),
      })),
      quarantined: ((quarantined.results ?? []).map((r) => ({
        name: r.name,
        quarantinedBy: r.quarantined_by,
        quarantinedAt: iso(r.quarantined_at),
      }))),
      nextCursor: more && last ? encodeCursor(last.seen_at, last.id) : null,
    },
  };
}

export interface QuarantineAction {
  name: string;
  quarantined: boolean;
  quarantinedAt: string | null;
  /** Existing check runs the action flipped. */
  checkRuns: number;
}

/**
 * Quarantines a check name: records the action and flips the repository's
 * existing runs of that name, so an in-flight or historical verdict stops
 * counting immediately. Jobs of the name keep queueing and running.
 */
export async function quarantineCheck(
  env: Env,
  repo: RepoRow,
  actorId: string | null,
  input: unknown,
  actorLogin: string | null = null,
): Promise<ServiceResult<QuarantineAction>> {
  const name = checkNameOf(input);
  if (!name.ok) return name;
  const now = Date.now();
  const flipped = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO ci_quarantine (repo_id, name, quarantined_by, quarantined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo_id, name) DO UPDATE SET quarantined_by = excluded.quarantined_by, quarantined_at = excluded.quarantined_at`,
    ).bind(repo.id, name.value, actorId, now),
    env.DB.prepare('UPDATE check_runs SET quarantined = 1 WHERE repo_id = ? AND name = ? AND quarantined = 0').bind(repo.id, name.value),
    // A quarantined check is tracked by an open issue until it is restored (services/issues.ts).
    quarantineIssueStatement(env.DB, repo.id, name.value, actorLogin, now),
  ]);
  return {
    ok: true,
    value: { name: name.value, quarantined: true, quarantinedAt: iso(now), checkRuns: flipped[1]?.meta?.changes ?? 0 },
  };
}

/** Restores a quarantined name to normal handling; a name that is not quarantined is an explicit 404. */
export async function restoreCheck(env: Env, repo: RepoRow, input: unknown): Promise<ServiceResult<QuarantineAction>> {
  const name = checkNameOf(input);
  if (!name.ok) return name;
  const removed = await env.DB.prepare('DELETE FROM ci_quarantine WHERE repo_id = ? AND name = ? RETURNING name').bind(repo.id, name.value).first<{ name: string }>();
  if (!removed) {
    return { ok: false, status: 404, error: `check ${name.value} is not quarantined`, code: 'NOT_QUARANTINED' };
  }
  const [restored] = await env.DB.batch([
    env.DB.prepare('UPDATE check_runs SET quarantined = 0 WHERE repo_id = ? AND name = ? AND quarantined = 1').bind(repo.id, name.value),
    // Restoring the check closes the issue that tracked it; a later flake files a new one.
    ...resolveSignalStatements(env.DB, repo.id, checkFingerprint(name.value), { evidence: { check: name.value }, reason: 'restored' }, Date.now()),
  ]);
  return { ok: true, value: { name: name.value, quarantined: false, quarantinedAt: null, checkRuns: restored?.meta?.changes ?? 0 } };
}
