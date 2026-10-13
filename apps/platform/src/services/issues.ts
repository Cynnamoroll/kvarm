/**
 * Issues and their automation.
 *
 * Filing: people and agents file issues through create_issue. A report that
 * names a fingerprint lands on the open issue with that fingerprint as one
 * more occurrence instead of a duplicate, so an agent that keeps hitting the
 * same bug, or a check that keeps failing, produces one issue. Platform
 * signals (CI, flakes, quarantine, guard) use `issueSignalStatements` and
 * `resolveSignalStatement` inside their own D1 batches; a check's
 * fingerprint is `checkFingerprint(name)` from @kvarm/issues.
 *
 * Linking: a change's title, body and head branch are read for issue
 * references whenever they are written (`changeLinkStatements`). Closing
 * keywords give confirmed `closes` links; an issue number in the branch name
 * gives a proposed one that a person or agent confirms or rejects with
 * link_issue. A workspace created for an issue (create_workspace {issue})
 * links the issue to whatever change the workspace opens.
 *
 * Closing: `mergeCloseStatement` runs in the batch that records a change
 * merged (changes.ts mergedRecordStatements, both the explicit merge and the
 * train), under the same guard. Only a merge into the repository's default
 * branch closes; links to other bases stay visible but inert.
 *
 * The guard as a producer (guardScanStatements, the events.ts issue-guard
 * effect): a push that moves the default branch outside the publication
 * path gets the same kvarm/guard evaluation a change gets, over the push's
 * whole tree diff. A failing finding files one fingerprinted issue
 * (guardFingerprint) or counts one more occurrence while one is open, and
 * the push that clears one on a path it changes closes it as verified.
 *
 * Comments (createComment) are plain discussion on an issue, agent-attributed
 * like filings; they carry no links, and get_issue returns the newest ones.
 *
 * Callers authorize first through the shared authority lookup; nothing here
 * checks access.
 */

import { mergeBase, type CommitReader } from '@kvarm/gitops';
import { branchIssueNumber, checkFingerprint, guardFingerprint, issueRefsIn, normalizeFingerprint, type IssueRef } from '@kvarm/issues';
import type { GuardFinding } from '@kvarm/review';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import { evaluateGuard } from './checks';
import { changedPaths, treePairBody } from './compare';
import { lsRefs, readCommitInfo, resolveCommitish, type ResolveContext } from './refs';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { normalizePath } from './intents/paths';
import {
  issuePathsCleanupStatement,
  issuePathsInsertStatement,
  issuePathsReplaceStatements,
  issueProbe,
  touchedIssuesBinds,
  touchedIssuesSql,
} from './intents/issuePaths';

export const ISSUE_LIMITS = {
  titleMax: 256,
  bodyMax: 65_536,
  pathsMax: 100,
  pathMax: 1024,
  checkMax: 200,
  urlMax: 2000,
  pageDefault: 50,
  pageMax: 100,
  /** Links returned with one issue or one change. */
  linksMax: 50,
  /** Comments returned with one issue; the newest are kept when beyond. */
  commentsMax: 50,
} as const;

export const ISSUE_SOURCES = ['human', 'agent', 'ci', 'flake', 'guard'] as const;
export type IssueSource = (typeof ISSUE_SOURCES)[number];
export type SignalSource = Exclude<IssueSource, 'human' | 'agent'>;
const CLOSED_REASONS = ['completed', 'not_planned', 'duplicate'] as const;
type ClosedReason = (typeof CLOSED_REASONS)[number] | 'verified' | 'restored';

export interface IssueEvidence {
  sha?: string;
  check?: string;
  runId?: string;
  workspace?: string;
  url?: string;
}

export interface IssueView {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  source: IssueSource;
  author: string | null;
  agent: { id: string; name: string } | null;
  fingerprint: string | null;
  paths: string[];
  evidence: IssueEvidence | null;
  occurrences: number;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  closedReason: ClosedReason | null;
  /** The merged change (and its merge commit) or the verifying commit that closed the issue. */
  closedBy: { change: number | null; commit: string | null } | null;
}

export interface IssueLinkView {
  issue: number;
  change: number | null;
  workspace: string | null;
  kind: 'closes' | 'refs';
  source: 'text' | 'branch' | 'workspace' | 'paths' | 'manual';
  state: 'confirmed' | 'proposed' | 'rejected';
  actor: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IssueContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
}

interface IssueRow {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  source: IssueSource;
  author_login: string | null;
  agent_meta: string | null;
  fingerprint: string | null;
  paths: string | null;
  evidence: string | null;
  occurrences: number;
  created_at: number;
  updated_at: number | null;
  last_seen_at: number | null;
  closed_at: number | null;
  closed_reason: ClosedReason | null;
  closed_by_change_number: number | null;
  closed_by_commit: string | null;
}

interface LinkRow {
  issue_number: number;
  change_number: number | null;
  workspace_id: string | null;
  kind: IssueLinkView['kind'];
  source: IssueLinkView['source'];
  state: IssueLinkView['state'];
  actor: string | null;
  created_at: number;
  updated_at: number;
}

const ISSUE_SELECT = `SELECT i.id, i.number, i.title, i.body, i.state, i.source, u.login AS author_login, i.agent_meta, i.fingerprint,
       i.paths, i.evidence, i.occurrences, i.created_at, i.updated_at, i.last_seen_at, i.closed_at, i.closed_reason,
       (SELECT c.number FROM change_sets c WHERE c.id = i.closed_by_change_id) AS closed_by_change_number, i.closed_by_commit
  FROM issues i LEFT JOIN users u ON u.id = i.author_id`;

const LINK_COLUMNS = `(SELECT c.number FROM change_sets c WHERE c.id = l.change_set_id) AS change_number, l.workspace_id, l.kind, l.source, l.state, l.actor, l.created_at, l.updated_at`;

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });
const iso = (ms: number) => new Date(ms).toISOString();
const SHA_RE = /^[0-9a-f]{40}$/;
const textOf = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

/** Who a link or filing is recorded as: the agent's name for an agent token, else the login. */
export const actorName = (a: Actor | null): string | null => a?.agent?.agentName ?? a?.user.login ?? null;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function issueView(r: IssueRow): IssueView {
  const agent = parseJson<{ agentId?: string; agentName?: string } | null>(r.agent_meta, null);
  const closedBy = r.closed_by_change_number !== null || r.closed_by_commit !== null ? { change: r.closed_by_change_number, commit: r.closed_by_commit } : null;
  return {
    number: r.number,
    title: r.title,
    body: r.body,
    state: r.state,
    source: r.source,
    author: r.author_login,
    agent: agent?.agentId && agent.agentName ? { id: agent.agentId, name: agent.agentName } : null,
    fingerprint: r.fingerprint,
    paths: parseJson<string[]>(r.paths, []),
    evidence: parseJson<IssueEvidence | null>(r.evidence, null),
    occurrences: r.occurrences,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at ?? r.created_at),
    lastSeenAt: iso(r.last_seen_at ?? r.created_at),
    closedAt: r.closed_at === null ? null : iso(r.closed_at),
    closedReason: r.closed_reason,
    closedBy,
  };
}

function linkView(r: LinkRow): IssueLinkView {
  return {
    issue: r.issue_number,
    change: r.change_number,
    workspace: r.workspace_id,
    kind: r.kind,
    source: r.source,
    state: r.state,
    actor: r.actor,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

export interface CommentView {
  id: string;
  body: string;
  author: string | null;
  agent: { id: string; name: string } | null;
  createdAt: string;
}

interface CommentRow {
  id: string;
  body: string;
  author_login: string | null;
  agent_meta: string | null;
  created_at: number;
}

function commentView(r: CommentRow): CommentView {
  const agent = parseJson<{ agentId?: string; agentName?: string } | null>(r.agent_meta, null);
  return {
    id: r.id,
    body: r.body,
    author: r.author_login,
    agent: agent?.agentId && agent.agentName ? { id: agent.agentId, name: agent.agentName } : null,
    createdAt: iso(r.created_at),
  };
}

function parseNumber(raw: string): number | null {
  return /^[1-9][0-9]{0,8}$/.test(raw) ? Number(raw) : null;
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    const msg = String(err);
    if (msg.includes('UNIQUE constraint failed: issues.repo_id, issues.fingerprint')) {
      return fail(409, 'an open issue already has this fingerprint', 'FINGERPRINT_OPEN');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

function parsePaths(v: unknown): ServiceResult<string[] | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (!Array.isArray(v) || v.length > ISSUE_LIMITS.pathsMax) {
    return fail(422, `paths must be a list of at most ${ISSUE_LIMITS.pathsMax} repository-relative paths (a trailing / names a directory)`, 'INVALID_PATH');
  }
  const out: string[] = [];
  for (const p of v) {
    const norm = normalizePath(p);
    if (!norm.ok) return fail(422, `invalid path ${JSON.stringify(p).slice(0, 120)}: ${norm.error}`, 'INVALID_PATH');
    if (!out.includes(norm.value)) out.push(norm.value);
  }
  return { ok: true, value: out };
}

function parseEvidence(v: unknown): ServiceResult<IssueEvidence | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'object' || Array.isArray(v)) return fail(422, 'evidence must be an object {sha?, check?, runId?, workspace?, url?}', 'INVALID_EVIDENCE');
  const o = v as Record<string, unknown>;
  const out: IssueEvidence = {};
  if (o.sha !== undefined) {
    if (typeof o.sha !== 'string' || !SHA_RE.test(o.sha)) return fail(422, 'evidence.sha must be a full 40-character commit SHA', 'INVALID_EVIDENCE');
    out.sha = o.sha;
  }
  for (const key of ['check', 'runId', 'workspace'] as const) {
    if (o[key] === undefined) continue;
    if (!textOf(o[key], ISSUE_LIMITS.checkMax)) return fail(422, `evidence.${key} must be a string of 1-${ISSUE_LIMITS.checkMax} characters`, 'INVALID_EVIDENCE');
    out[key] = o[key];
  }
  if (o.url !== undefined) {
    if (!textOf(o.url, ISSUE_LIMITS.urlMax) || !/^https?:\/\//.test(o.url)) return fail(422, 'evidence.url must be an http(s) URL', 'INVALID_EVIDENCE');
    out.url = o.url;
  }
  return { ok: true, value: Object.keys(out).length > 0 ? out : null };
}

interface NewIssue {
  title: string;
  body: string | null;
  paths: string[] | null;
  fingerprint: string | null;
  evidence: IssueEvidence | null;
}

function parseCreate(input: unknown): ServiceResult<NewIssue> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail(400, 'body must be a JSON object {title, body?, paths?, fingerprint?, evidence?}', 'INVALID_BODY');
  }
  const b = input as Record<string, unknown>;
  if (!textOf(b.title, ISSUE_LIMITS.titleMax)) return fail(422, `title is required (1-${ISSUE_LIMITS.titleMax} characters)`, 'INVALID_TITLE');
  if (b.body !== undefined && b.body !== null && (typeof b.body !== 'string' || b.body.length > ISSUE_LIMITS.bodyMax)) {
    return fail(422, `body must be a string of at most ${ISSUE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
  }
  let fingerprint: string | null = null;
  if (b.fingerprint !== undefined && b.fingerprint !== null) {
    fingerprint = normalizeFingerprint(b.fingerprint);
    if (fingerprint === null) return fail(422, 'fingerprint must be a non-empty string of at most 200 characters', 'INVALID_FINGERPRINT');
  }
  const paths = parsePaths(b.paths);
  if (!paths.ok) return paths;
  const evidence = parseEvidence(b.evidence);
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    value: { title: b.title.trim(), body: (b.body as string | null | undefined) ?? null, paths: paths.value, fingerprint, evidence: evidence.value },
  };
}

// ---------------------------------------------------------------------------
// Filing
// ---------------------------------------------------------------------------

interface UpsertRow extends NewIssue {
  id: string;
  source: IssueSource;
  authorId: string | null;
  agentMeta: string | null;
}

/**
 * Files an issue, or counts one more occurrence on the open issue with the
 * same fingerprint (its title and body stay; the newest evidence wins).
 */
function upsertStatement(db: D1Database, repoId: string, r: UpsertRow, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO issues (id, repo_id, number, title, body, author_id, state, created_at, source, fingerprint, paths, agent_meta, evidence,
           occurrences, last_seen_at, updated_at)
       SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, 'open', ?6, ?7, ?8, ?9, ?10, ?11, 1, ?6, ?6 FROM issues WHERE repo_id = ?2
       ON CONFLICT (repo_id, fingerprint) WHERE state = 'open' AND fingerprint IS NOT NULL
       DO UPDATE SET occurrences = occurrences + 1, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at,
                     evidence = COALESCE(excluded.evidence, evidence)`,
    )
    .bind(
      r.id,
      repoId,
      r.title,
      r.body,
      r.authorId,
      now,
      r.source,
      r.fingerprint,
      r.paths ? JSON.stringify(r.paths) : null,
      r.agentMeta,
      r.evidence ? JSON.stringify(r.evidence) : null,
    );
}

export interface IssueSignal {
  source: SignalSource;
  /** Normalized by the caller, e.g. checkFingerprint(name). */
  fingerprint: string;
  title: string;
  body?: string | null;
  paths?: string[] | null;
  evidence?: IssueEvidence | null;
}

/**
 * The statement that files a platform signal as an issue, or counts it on
 * the open issue with its fingerprint. Meant for the signal owner's own
 * batch (a CI report, a flake registration, a quarantine), so the issue
 * moves together with the state that raised it.
 */
export function issueSignalStatements(db: D1Database, repoId: string, s: IssueSignal, now: number): D1PreparedStatement[] {
  const fingerprint = normalizeFingerprint(s.fingerprint);
  if (fingerprint === null) return [];
  const row: UpsertRow = {
    id: crypto.randomUUID(),
    title: s.title.slice(0, ISSUE_LIMITS.titleMax),
    body: s.body?.slice(0, ISSUE_LIMITS.bodyMax) ?? null,
    paths: s.paths?.slice(0, ISSUE_LIMITS.pathsMax) ?? null,
    fingerprint,
    evidence: s.evidence ?? null,
    source: s.source,
    authorId: null,
    agentMeta: null,
  };
  return [upsertStatement(db, repoId, row, now), ...(row.paths?.length ? [issuePathsInsertStatement(db, repoId, row.id, row.paths)] : [])];
}

/**
 * Closes the open issue with a fingerprint: `verified` when the signal that
 * filed it has passed again, `restored` when the signal's owner returned it
 * to normal handling (a quarantined check restored). A fingerprint with no
 * open issue changes nothing; a later recurrence files a new issue. A
 * caller that resolves many fingerprints in one batch passes `retireTasks:
 * false` and retires the fix-issue tasks itself, once.
 */
export function resolveSignalStatements(
  db: D1Database,
  repoId: string,
  fingerprint: string,
  verified: { commit?: string | null; evidence?: IssueEvidence | null; reason?: 'verified' | 'restored' },
  now: number,
  { retireTasks = true }: { retireTasks?: boolean } = {},
): D1PreparedStatement[] {
  const close = db
    .prepare(
      `UPDATE issues SET state = 'closed', closed_reason = ?6, closed_at = ?3, updated_at = ?3, closed_by_change_id = NULL,
              closed_by_commit = ?4, evidence = COALESCE(?5, evidence)
        WHERE repo_id = ?1 AND fingerprint = ?2 AND state = 'open'`,
    )
    .bind(
      repoId,
      normalizeFingerprint(fingerprint) ?? '',
      now,
      verified.commit ?? null,
      verified.evidence ? JSON.stringify(verified.evidence) : null,
      verified.reason ?? 'verified',
    );
  return retireTasks ? [close, retireIssueTasksStatement(db, repoId, now)] : [close];
}

/**
 * Files the flake that a CI report just registered (services/ci.ts
 * reportJob) as an issue, or counts it on the check's open issue. Runs in
 * the report's own batch and writes only when the flake row `flakeId` was
 * inserted by that batch, so a repeated or stale report never counts twice.
 * The fingerprint is `checkFingerprint(name)`, built in SQL.
 */
export function flakeIssueStatement(db: D1Database, repoId: string, flakeId: string, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO issues (id, repo_id, number, title, body, author_id, state, created_at, source, fingerprint, paths, agent_meta, evidence,
           occurrences, last_seen_at, updated_at)
       SELECT ?3, ?2, (SELECT COALESCE(MAX(number), 0) + 1 FROM issues WHERE repo_id = ?2),
              'Check ' || f.name || ' is flaky',
              'The check \`' || f.name || '\` failed and then passed on its automatic retry at ' || f.head_sha ||
                COALESCE(' (change #' || c.number || ')', '') || '. Every further flake of this check counts as one more occurrence here; ' ||
                'the first attempt''s output is in the flake registry (GET ci/flakes). Quarantine the check while it is fixed so it ' ||
                'neither blocks nor satisfies merges; restoring it closes this issue.',
              NULL, 'open', ?4, 'flake', 'check:' || lower(f.name), NULL, NULL,
              json_object('check', f.name, 'sha', f.head_sha), 1, ?4, ?4
         FROM ci_flakes f LEFT JOIN change_sets c ON c.id = f.change_set_id
        WHERE f.id = ?1 AND f.repo_id = ?2
       ON CONFLICT (repo_id, fingerprint) WHERE state = 'open' AND fingerprint IS NOT NULL
       DO UPDATE SET occurrences = occurrences + 1, last_seen_at = excluded.last_seen_at, updated_at = excluded.updated_at,
                     evidence = excluded.evidence`,
    )
    .bind(flakeId, repoId, crypto.randomUUID(), now);
}

/**
 * Makes sure a quarantined check has an open issue tracking it: files one
 * when the check has none (an open flake issue for it already tracks it).
 */
export function quarantineIssueStatement(db: D1Database, repoId: string, name: string, by: string | null, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO issues (id, repo_id, number, title, body, author_id, state, created_at, source, fingerprint, paths, agent_meta, evidence,
           occurrences, last_seen_at, updated_at)
       SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, NULL, 'open', ?5, 'ci', ?6, NULL, NULL, json_object('check', ?7), 1, ?5, ?5
         FROM issues WHERE repo_id = ?2
       ON CONFLICT (repo_id, fingerprint) WHERE state = 'open' AND fingerprint IS NOT NULL DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      repoId,
      `Check ${name} is quarantined`.slice(0, ISSUE_LIMITS.titleMax),
      `The check \`${name}\` was quarantined${by ? ` by ${by}` : ''}: it still runs, but its results neither block nor satisfy merges until it is restored. Restoring it closes this issue.`,
      now,
      checkFingerprint(name),
      name,
    );
}

export interface FiledIssue {
  issue: IssueView;
  /** False when the report was counted on an open issue with the same fingerprint. */
  created: boolean;
}

/** POST issues. One batch: the upsert and the read-back. */
export function createIssue(cx: IssueContext, input: unknown): Promise<ServiceResult<FiledIssue>> {
  return guarded(async () => {
    const parsed = parseCreate(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const agent = cx.actor?.agent;
    const row: UpsertRow = {
      ...p,
      id: crypto.randomUUID(),
      source: agent ? 'agent' : 'human',
      authorId: cx.actor?.user.id ?? null,
      agentMeta: agent ? JSON.stringify({ agentId: agent.agentId, agentName: agent.agentName }) : null,
    };
    const db = cx.env.DB;
    const results = await db.batch([
      upsertStatement(db, cx.repo.id, row, Date.now()),
      ...(p.paths?.length ? [issuePathsInsertStatement(db, cx.repo.id, row.id, p.paths)] : []),
      db.prepare(`${ISSUE_SELECT} WHERE i.id = ?1 OR (i.repo_id = ?2 AND i.fingerprint = ?3 AND i.state = 'open') LIMIT 1`).bind(row.id, cx.repo.id, p.fingerprint),
    ]);
    const read = results[results.length - 1];
    const got = (read?.results as (IssueRow & { id: string })[] | undefined)?.[0];
    if (!got) return fail(500, 'issue could not be filed', 'CREATE_FAILED');
    return { ok: true, value: { issue: issueView(got), created: got.id === row.id } };
  });
}

// ---------------------------------------------------------------------------
// Reading and updating
// ---------------------------------------------------------------------------

export interface IssueQuery {
  state?: string | undefined;
  source?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
}

export interface IssuePage {
  issues: IssueView[];
  nextCursor: string | null;
}

/** GET issues?state=&source=&limit=&cursor= — newest number first, one bounded indexed read. */
export async function listIssues(env: Env, repo: RepoRow, q: IssueQuery): Promise<ServiceResult<IssuePage>> {
  const state = q.state === undefined || q.state === '' ? 'open' : q.state;
  if (state !== 'open' && state !== 'closed' && state !== 'all') return fail(400, 'state must be open, closed or all', 'INVALID_STATE');
  const source = q.source === undefined || q.source === '' ? null : q.source;
  if (source !== null && !(ISSUE_SOURCES as readonly string[]).includes(source)) {
    return fail(400, `source must be one of ${ISSUE_SOURCES.join(', ')}`, 'INVALID_SOURCE');
  }
  let limit: number = ISSUE_LIMITS.pageDefault;
  if (q.limit !== undefined && q.limit !== '') {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 1 || n > ISSUE_LIMITS.pageMax) return fail(400, `limit must be an integer from 1 to ${ISSUE_LIMITS.pageMax}`, 'INVALID_LIMIT');
    limit = n;
  }
  let before: number | null = null;
  if (q.cursor) {
    before = parseNumber(q.cursor);
    if (before === null) return fail(400, 'cursor is not a nextCursor from this endpoint', 'INVALID_CURSOR');
  }
  const rows = (
    await env.DB.prepare(
      `${ISSUE_SELECT}
        WHERE i.repo_id = ?1 AND (?2 = 'all' OR i.state = ?2) AND (?3 IS NULL OR i.source = ?3) AND (?4 IS NULL OR i.number < ?4)
        ORDER BY i.number DESC LIMIT ?5`,
    )
      .bind(repo.id, state, source, before, limit + 1)
      .all<IssueRow>()
  ).results;
  const kept = rows.slice(0, limit);
  return { ok: true, value: { issues: kept.map(issueView), nextCursor: rows.length > limit ? String(kept[kept.length - 1]!.number) : null } };
}

export interface IssueTaskView {
  id: string;
  /** `open` also for a claim whose lease ran out. */
  status: 'open' | 'claimed' | 'completed' | 'obsolete';
  claimedBy: string | null;
  /** The workspace created for the claimant. */
  workspace: string | null;
  createdAt: string;
}

export interface IssueDetail extends IssueView {
  links: IssueLinkView[];
  /** The issue's fix-issue agent tasks, newest first. */
  tasks: IssueTaskView[];
  /** The newest comments, oldest first; `commentsTruncated` says older ones exist. */
  comments: CommentView[];
  commentsTruncated: boolean;
}

interface IssueTaskRow {
  id: string;
  status: IssueTaskView['status'];
  claimed_by: string | null;
  claim_workspace_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
}

const ISSUE_TASKS_MAX = 5;

/** GET issues/:number — the issue, its links, tasks and newest comments, in one batch. */
export async function getIssue(cx: IssueContext, rawNumber: string): Promise<ServiceResult<IssueDetail>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
  const db = cx.env.DB;
  const [issue, links, tasks, comments] = await db.batch([
    db.prepare(`${ISSUE_SELECT} WHERE i.repo_id = ?1 AND i.number = ?2`).bind(cx.repo.id, number),
    db
      .prepare(
        `SELECT ?2 AS issue_number, ${LINK_COLUMNS} FROM issue_links l
          WHERE l.issue_id = (SELECT id FROM issues WHERE repo_id = ?1 AND number = ?2)
          ORDER BY l.created_at, l.id LIMIT ${ISSUE_LIMITS.linksMax}`,
      )
      .bind(cx.repo.id, number),
    db
      .prepare(
        `SELECT id, status, claimed_by, claim_workspace_id, lease_expires_at, created_at FROM agent_tasks
          WHERE repo_id = ?1 AND kind = '${FIX_ISSUE}' AND json_extract(payload, '$.issue') = ?2
          ORDER BY created_at DESC, id DESC LIMIT ${ISSUE_TASKS_MAX}`,
      )
      .bind(cx.repo.id, number),
    db
      .prepare(
        `SELECT c.id, c.body, u.login AS author_login, c.agent_meta, c.created_at
           FROM issue_comments c LEFT JOIN users u ON u.id = c.user_id
          WHERE c.issue_id = (SELECT id FROM issues WHERE repo_id = ?1 AND number = ?2)
          ORDER BY c.created_at DESC, c.rowid DESC LIMIT ${ISSUE_LIMITS.commentsMax + 1}`,
      )
      .bind(cx.repo.id, number),
  ]);
  const row = (issue?.results as IssueRow[] | undefined)?.[0];
  if (!row) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
  const now = Date.now();
  const taskViews = ((tasks?.results as IssueTaskRow[] | undefined) ?? []).map((t) => ({
    id: t.id,
    status: t.status === 'claimed' && t.lease_expires_at !== null && t.lease_expires_at <= now ? ('open' as const) : t.status,
    claimedBy: t.claimed_by,
    workspace: t.claim_workspace_id,
    createdAt: iso(t.created_at),
  }));
  const commentRows = (comments?.results as CommentRow[] | undefined) ?? [];
  return {
    ok: true,
    value: {
      ...issueView(row),
      links: ((links?.results as LinkRow[] | undefined) ?? []).map(linkView),
      tasks: taskViews,
      comments: commentRows.slice(0, ISSUE_LIMITS.commentsMax).reverse().map(commentView),
      commentsTruncated: commentRows.length > ISSUE_LIMITS.commentsMax,
    },
  };
}

/**
 * PATCH issues/:number {title?, body?, paths?, state?, closedReason?}. Closing
 * records the reason (default completed); reopening clears it. Reopening an
 * issue whose fingerprint already has another open issue is 409.
 */
export function updateIssue(cx: IssueContext, rawNumber: string, input: unknown): Promise<ServiceResult<IssueView>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
    const b = input as Record<string, unknown>;
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (sql: string, v: unknown) => {
      args.push(v);
      sets.push(sql.replace('?', `?${args.length + 2}`));
    };
    if (b.title !== undefined) {
      if (!textOf(b.title, ISSUE_LIMITS.titleMax)) return fail(422, `title must be 1-${ISSUE_LIMITS.titleMax} characters`, 'INVALID_TITLE');
      set('title = ?', b.title.trim());
    }
    if (b.body !== undefined) {
      if (b.body !== null && (typeof b.body !== 'string' || b.body.length > ISSUE_LIMITS.bodyMax)) {
        return fail(422, `body must be a string of at most ${ISSUE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
      }
      set('body = ?', b.body);
    }
    let newPaths: string[] | null = null;
    if (b.paths !== undefined) {
      const paths = parsePaths(b.paths);
      if (!paths.ok) return paths;
      newPaths = paths.value ?? [];
      set('paths = ?', newPaths.length > 0 ? JSON.stringify(newPaths) : null);
    }
    if (b.closedReason !== undefined && (b.state !== 'closed' || !(CLOSED_REASONS as readonly unknown[]).includes(b.closedReason))) {
      return fail(422, `closedReason goes with state "closed" and is one of ${CLOSED_REASONS.join(', ')}`, 'INVALID_CLOSED_REASON');
    }
    const now = Date.now();
    if (b.state === 'closed') {
      // Closing an already closed issue keeps its original close record.
      set(`closed_reason = CASE WHEN state = 'open' THEN ? ELSE closed_reason END`, b.closedReason ?? 'completed');
      set(`closed_at = CASE WHEN state = 'open' THEN ? ELSE closed_at END`, now);
      sets.push(`closed_by_change_id = CASE WHEN state = 'open' THEN NULL ELSE closed_by_change_id END`);
      sets.push(`closed_by_commit = CASE WHEN state = 'open' THEN NULL ELSE closed_by_commit END`);
      sets.push(`state = 'closed'`);
    } else if (b.state === 'open') {
      sets.push(`state = 'open'`, 'closed_reason = NULL', 'closed_at = NULL', 'closed_by_change_id = NULL', 'closed_by_commit = NULL');
    } else if (b.state !== undefined) {
      return fail(422, 'state must be "open" or "closed"', 'INVALID_STATE');
    }
    if (sets.length === 0) return fail(422, 'nothing to update: pass title, body, paths or state', 'EMPTY_PATCH');
    set('updated_at = ?', now);
    const db = cx.env.DB;
    const results = await db.batch([
      db.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE repo_id = ?1 AND number = ?2`).bind(cx.repo.id, number, ...args),
      ...(newPaths !== null ? issuePathsReplaceStatements(db, cx.repo.id, number, newPaths) : []),
      ...(b.state === 'closed' ? [retireIssueTasksStatement(db, cx.repo.id, now)] : []),
      db.prepare(`${ISSUE_SELECT} WHERE i.repo_id = ?1 AND i.number = ?2`).bind(cx.repo.id, number),
    ]);
    const read = results[results.length - 1];
    const row = (read?.results as IssueRow[] | undefined)?.[0];
    if (!row) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
    return { ok: true, value: issueView(row) };
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * POST issues/:number/comments. A comment is plain discussion: it carries no
 * links (an issue link belongs to a change or a workspace) and is allowed on
 * a closed issue. One batch: the insert and the read-back.
 */
export function createComment(cx: IssueContext, rawNumber: string, input: unknown): Promise<ServiceResult<CommentView>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object {body}', 'INVALID_BODY');
    const body = (input as Record<string, unknown>).body;
    if (!textOf(body, ISSUE_LIMITS.bodyMax)) return fail(422, `body is required (1-${ISSUE_LIMITS.bodyMax} characters)`, 'INVALID_BODY');
    const agent = cx.actor?.agent;
    const id = crypto.randomUUID();
    const db = cx.env.DB;
    const [, read] = await db.batch([
      db
        .prepare(
          `INSERT INTO issue_comments (id, issue_id, user_id, body, agent_meta, created_at)
           SELECT ?1, i.id, ?2, ?3, ?4, ?5 FROM issues i WHERE i.repo_id = ?6 AND i.number = ?7`,
        )
        .bind(id, cx.actor?.user.id ?? null, body, agent ? JSON.stringify({ agentId: agent.agentId, agentName: agent.agentName }) : null, Date.now(), cx.repo.id, number),
      db
        .prepare(
          `SELECT c.id, c.body, u.login AS author_login, c.agent_meta, c.created_at
             FROM issue_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?1`,
        )
        .bind(id),
    ]);
    const row = (read?.results as CommentRow[] | undefined)?.[0];
    if (!row) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
    return { ok: true, value: commentView(row) };
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The references of a change's text that name this repository's issues. */
export function localIssueRefs(repo: Pick<RepoRow, 'owner_login' | 'name'>, texts: readonly (string | null)[]): IssueRef[] {
  const self = `${repo.owner_login}/${repo.name}`.toLowerCase();
  const refs: IssueRef[] = [];
  for (const t of texts) {
    for (const r of issueRefsIn(t ?? '')) {
      if (r.repo !== null && r.repo.toLowerCase() !== self) continue;
      const prev = refs.find((x) => x.number === r.number);
      if (!prev) refs.push({ ...r, repo: null });
      else if (r.kind === 'closes') prev.kind = 'closes';
    }
  }
  return refs;
}

/**
 * Recomputes a change's text and branch links in the caller's batch: links
 * read from the title and body are confirmed, an issue number in the head
 * branch is proposed. Manual links (confirmations and rejections) are left
 * alone and win over both. References to issues that do not exist are
 * dropped.
 */
export function changeLinkStatements(
  db: D1Database,
  repo: Pick<RepoRow, 'id' | 'owner_login' | 'name'>,
  changeId: string,
  change: { title: string; body: string | null; head: string },
  actor: string | null,
  now: number,
  /** The change's changed paths, when known (at creation): open issues about them get proposed links. */
  changed?: readonly string[],
): D1PreparedStatement[] {
  const refs = localIssueRefs(repo, [change.title, change.body]).map((r) => ({ number: r.number, kind: r.kind }));
  const branch = branchIssueNumber(change.head);
  return [
    db.prepare(`DELETE FROM issue_links WHERE change_set_id = ?1 AND source IN ('text', 'branch')`).bind(changeId),
    ...(refs.length > 0
      ? [
          db
            .prepare(
              `INSERT INTO issue_links (id, repo_id, issue_id, change_set_id, workspace_id, kind, source, state, actor, created_at, updated_at)
               SELECT lower(hex(randomblob(16))), ?1, i.id, ?2, NULL, json_extract(j.value, '$.kind'), 'text', 'confirmed', ?3, ?4, ?4
                 FROM json_each(?5) j JOIN issues i ON i.repo_id = ?1 AND i.number = json_extract(j.value, '$.number')
                WHERE true
               ON CONFLICT (change_set_id, issue_id) WHERE change_set_id IS NOT NULL DO NOTHING`,
            )
            .bind(repo.id, changeId, actor, now, JSON.stringify(refs)),
        ]
      : []),
    ...(branch !== null
      ? [
          db
            .prepare(
              `INSERT INTO issue_links (id, repo_id, issue_id, change_set_id, workspace_id, kind, source, state, actor, created_at, updated_at)
               SELECT lower(hex(randomblob(16))), ?1, i.id, ?2, NULL, 'closes', 'branch', 'proposed', ?3, ?4, ?4
                 FROM issues i WHERE i.repo_id = ?1 AND i.number = ?5 AND i.state = 'open'
               ON CONFLICT (change_set_id, issue_id) WHERE change_set_id IS NOT NULL DO NOTHING`,
            )
            .bind(repo.id, changeId, actor, now, branch),
        ]
      : []),
    ...(changed && changed.length > 0 ? [pathLinkStatement(db, repo.id, changeId, changed, actor, now)] : []),
  ];
}

/** Proposed links per change from the issue-path index; the newest issues win. */
export const PATH_PROPOSALS_MAX = 10;

/**
 * Proposes `closes` links to the open issues whose paths the change touches
 * (Nexus issue-path index). Text, branch and manual links to the same issue
 * win; a proposal only becomes a close once someone confirms it.
 */
function pathLinkStatement(
  db: D1Database,
  repoId: string,
  changeId: string,
  changed: readonly string[],
  actor: string | null,
  now: number,
  /** Write only while the change's head is still this commit. */
  headSha?: string,
): D1PreparedStatement {
  const atHead = headSha ? 'AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?2 AND c.head_sha = ?8)' : '';
  return db
    .prepare(
      `INSERT INTO issue_links (id, repo_id, issue_id, change_set_id, workspace_id, kind, source, state, actor, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), ?1, i.id, ?2, NULL, 'closes', 'paths', 'proposed', ?3, ?4, ?4
         FROM issues i
        WHERE i.repo_id = ?1 AND i.state = 'open' AND i.id IN (${touchedIssuesSql(5)}) ${atHead}
        ORDER BY i.number DESC LIMIT ${PATH_PROPOSALS_MAX}
       ON CONFLICT (change_set_id, issue_id) WHERE change_set_id IS NOT NULL DO NOTHING`,
    )
    .bind(repoId, changeId, actor, now, ...touchedIssuesBinds(repoId, issueProbe(changed)), ...(headSha ? [headSha] : []));
}

/**
 * Recomputes a change's path proposals after its head moved (a head-moved
 * hook in services/changes.ts): the still-unanswered `paths` proposals are
 * replaced by those of the new head's changed paths, guarded by the head.
 * Answered links (manual) and text, branch and workspace links stay. A
 * repository without indexed issue paths costs one D1 batch and no
 * Artifacts work. Proposals are advice, so a failure is logged, never
 * raised into the push effect.
 */
export async function refreshPathLinks(env: Env, repoId: string, changeId: string, headSha: string): Promise<'refreshed' | 'skipped'> {
  const db = env.DB;
  try {
    const [repoRes, changeRes, indexed] = await db.batch([
      db.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
      db.prepare('SELECT base_ref, head_sha, state FROM change_sets WHERE id = ? AND repo_id = ?').bind(changeId, repoId),
      db.prepare('SELECT 1 FROM issue_paths WHERE repo_id = ? LIMIT 1').bind(repoId),
    ]);
    const repo = (repoRes?.results as RepoRow[] | undefined)?.[0];
    const change = (changeRes?.results as Array<{ base_ref: string; head_sha: string | null; state: string }> | undefined)?.[0];
    if (!repo || !change || change.head_sha !== headSha || (change.state !== 'open' && change.state !== 'conflicted')) return 'skipped';
    if (!indexed?.results.length) return 'skipped';
    const pending: Promise<unknown>[] = [];
    try {
      const changed = await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
        const ctx: ResolveContext = { env, repo, artifacts, bypass: false, waitUntil: (p) => pending.push(p) };
        const baseRef = `refs/heads/${change.base_ref}`;
        const baseSha = (await lsRefs(ctx, [baseRef])).get(baseRef) ?? null;
        if (!baseSha) return null;
        const commits = await resolveCommitish(ctx, [baseSha, headSha]);
        const base = commits.get(baseSha);
        const head = commits.get(headSha);
        if (!base || !head) return null;
        return (await changedPaths(ctx, base.tree, head.tree)).paths;
      });
      if (changed === null) return 'skipped';
      const now = Date.now();
      await db.batch([
        db
          .prepare(
            `DELETE FROM issue_links WHERE change_set_id = ?1 AND source = 'paths' AND state = 'proposed'
               AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?1 AND c.head_sha = ?2)`,
          )
          .bind(changeId, headSha),
        ...(changed.length > 0 ? [pathLinkStatement(db, repoId, changeId, changed, 'kvarm', now, headSha)] : []),
      ]);
      return 'refreshed';
    } finally {
      await Promise.allSettled(pending);
    }
  } catch (err) {
    console.warn(JSON.stringify({ issuePathRefresh: { repo: repoId, change: changeId, error: String(err).slice(0, 200) } }));
    return 'skipped';
  }
}

/** True when the repository has an open issue with this number. */
export async function openIssueExists(env: Env, repoId: string, number: number): Promise<boolean> {
  return (await env.DB.prepare(`SELECT 1 FROM issues WHERE repo_id = ? AND number = ? AND state = 'open'`).bind(repoId, number).first()) !== null;
}

/** Links a new workspace (inserted earlier in the same batch) to the open issue it was created for (a confirmed `closes` link). */
export function workspaceIssueStatement(db: D1Database, repoId: string, workspaceId: string, issue: number, actor: string | null, now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO issue_links (id, repo_id, issue_id, change_set_id, workspace_id, kind, source, state, actor, created_at, updated_at)
       SELECT lower(hex(randomblob(16))), ?1, i.id, NULL, ?2, 'closes', 'workspace', 'confirmed', ?3, ?4, ?4
         FROM issues i WHERE i.repo_id = ?1 AND i.number = ?5 AND i.state = 'open'
          AND EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ?2 AND w.repo_id = ?1)
       ON CONFLICT (workspace_id, issue_id) WHERE workspace_id IS NOT NULL DO NOTHING`,
    )
    .bind(repoId, workspaceId, actor, now, issue);
}

/**
 * The merge-record statement that closes the issues a change resolves: its
 * confirmed `closes` links and those of the workspace it was opened from.
 * It writes only once the change is recorded merged at this exact
 * publication and only when the change's base is the default branch.
 */
export function mergeCloseStatement(db: D1Database, repoId: string, changeId: string, mergeCommit: string, mergedAt: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE issues SET state = 'closed', closed_reason = 'completed', closed_at = ?3, updated_at = ?3, closed_by_change_id = ?2, closed_by_commit = ?4
        WHERE repo_id = ?1 AND state = 'open'
          AND id IN (SELECT l.issue_id FROM issue_links l
                      WHERE l.repo_id = ?1 AND l.kind = 'closes' AND l.state = 'confirmed'
                        AND (l.change_set_id = ?2 OR l.workspace_id IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.change_set_id = ?2)))
          AND EXISTS (SELECT 1 FROM change_sets c JOIN repos r ON r.id = c.repo_id
                       WHERE c.id = ?2 AND c.state = 'merged' AND c.merge_commit = ?4 AND c.merged_at = ?3 AND c.base_ref = r.default_branch)`,
    )
    .bind(repoId, changeId, mergedAt, mergeCommit);
}

export interface ChangeIssueView extends IssueLinkView {
  title: string;
  issueState: 'open' | 'closed';
  /** The issue closes when this change merges as it stands. */
  willClose: boolean;
}

interface ChangeIssueRow extends LinkRow {
  title: string;
  issue_state: 'open' | 'closed';
  base_is_default: number;
}

const CHANGE_LINKS_SQL = `SELECT i.number AS issue_number, i.title, i.state AS issue_state, ${LINK_COLUMNS},
       c.base_ref = r.default_branch AS base_is_default
  FROM change_sets c JOIN repos r ON r.id = c.repo_id
  JOIN issue_links l ON l.change_set_id = c.id
                     OR l.workspace_id IN (SELECT w.id FROM workspaces w WHERE w.repo_id = c.repo_id AND w.change_set_id = c.id)
  JOIN issues i ON i.id = l.issue_id
 WHERE c.repo_id = ?1 AND c.number = ?2
 ORDER BY i.number LIMIT ${ISSUE_LIMITS.linksMax}`;

function changeIssueView(r: ChangeIssueRow, changeNumber: number): ChangeIssueView {
  const willClose = r.kind === 'closes' && r.state === 'confirmed' && r.issue_state === 'open' && r.base_is_default === 1;
  return { ...linkView({ ...r, change_number: r.change_number ?? changeNumber }), title: r.title, issueState: r.issue_state, willClose };
}

export interface ChangeIssues {
  change: number;
  issues: ChangeIssueView[];
}

/** GET changes/:number/issues — every issue linked to the change or its workspace, with whether it will close. */
export async function listChangeIssues(cx: IssueContext, rawNumber: string): Promise<ServiceResult<ChangeIssues>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  const db = cx.env.DB;
  const [change, links] = await db.batch([
    db.prepare('SELECT 1 FROM change_sets WHERE repo_id = ?1 AND number = ?2').bind(cx.repo.id, number),
    db.prepare(CHANGE_LINKS_SQL).bind(cx.repo.id, number),
  ]);
  if (!change?.results.length) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  return { ok: true, value: { change: number, issues: ((links?.results as ChangeIssueRow[] | undefined) ?? []).map((r) => changeIssueView(r, number)) } };
}

/**
 * POST changes/:number/issues {issue, kind?, state?} — confirm (default) or
 * reject a link by hand. A manual link replaces whatever the text or branch
 * suggested for that issue and is never recomputed away.
 */
export async function linkIssue(cx: IssueContext, rawNumber: string, input: unknown): Promise<ServiceResult<ChangeIssues>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object {issue, kind?, state?}', 'INVALID_BODY');
  const b = input as Record<string, unknown>;
  if (typeof b.issue !== 'number' || !Number.isInteger(b.issue) || b.issue < 1) return fail(422, 'issue must be an issue number', 'INVALID_ISSUE');
  const kind = b.kind ?? 'closes';
  if (kind !== 'closes' && kind !== 'refs') return fail(422, 'kind must be "closes" or "refs"', 'INVALID_KIND');
  const state = b.state ?? 'confirmed';
  if (state !== 'confirmed' && state !== 'rejected') return fail(422, 'state must be "confirmed" or "rejected"', 'INVALID_LINK_STATE');
  const db = cx.env.DB;
  const now = Date.now();
  const [found, , links] = await db.batch([
    db
      .prepare(
        `SELECT (SELECT state FROM change_sets WHERE repo_id = ?1 AND number = ?2) AS change_state,
                (SELECT 1 FROM issues WHERE repo_id = ?1 AND number = ?3) AS issue_exists`,
      )
      .bind(cx.repo.id, number, b.issue),
    db
      .prepare(
        `INSERT INTO issue_links (id, repo_id, issue_id, change_set_id, workspace_id, kind, source, state, actor, created_at, updated_at)
         SELECT lower(hex(randomblob(16))), ?1, i.id, c.id, NULL, ?4, 'manual', ?5, ?6, ?7, ?7
           FROM change_sets c JOIN issues i ON i.repo_id = c.repo_id AND i.number = ?3
          WHERE c.repo_id = ?1 AND c.number = ?2 AND c.state != 'merged'
         ON CONFLICT (change_set_id, issue_id) WHERE change_set_id IS NOT NULL
         DO UPDATE SET kind = excluded.kind, source = 'manual', state = excluded.state, actor = excluded.actor, updated_at = excluded.updated_at`,
      )
      .bind(cx.repo.id, number, b.issue, kind, state, actorName(cx.actor), now),
    db.prepare(CHANGE_LINKS_SQL).bind(cx.repo.id, number),
  ]);
  const f = (found?.results as Array<{ change_state: string | null; issue_exists: number | null }> | undefined)?.[0];
  if (!f?.change_state) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  if (f.change_state === 'merged') return fail(409, 'a merged change cannot be linked to issues', 'CHANGE_MERGED');
  if (!f.issue_exists) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
  return { ok: true, value: { change: number, issues: ((links?.results as ChangeIssueRow[] | undefined) ?? []).map((r) => changeIssueView(r, number)) } };
}

/** Bounds of reading one default-branch push for closing references. */
export const COMMIT_SCAN = {
  /** Commits read in total, merged side branches included. */
  commitsMax: 100,
  /** First-parent commits read from the new tip toward the previous one. */
  mainlineMax: 50,
  /** Artifacts log calls (the main line plus one per merged side branch). */
  logCallsMax: 10,
  /** Commit reads of one merge-base search. */
  mergeBaseReadsMax: 500,
} as const;

export interface PushedCommits {
  /** Newest first along each chain: the main line, then each merged side branch. */
  commits: { sha: string; message: string }[];
  /** The main line did not reach the previous tip within its bound. */
  mainlineTruncated: boolean;
  /** Merged side branches that were not read (bounds, criss-cross merges or an unreached merge base). */
  sidesSkipped: number;
}

/**
 * The commits a default-branch push brought in, bounded. The main line is
 * the first-parent chain from `after` down to `before`. Each merge commit
 * on it (and on every side branch read) also brought in its other parents'
 * commits that were not yet on its first parent: the first-parent chain
 * from that parent down to the merge base of the two. A side chain counts
 * only when the walk reaches that merge base, so commits that were already
 * on the branch are never read again (a deliberately reopened issue stays
 * open); criss-cross merges, bounds and unreached bases skip the side.
 */
export async function pushedCommits(env: Env, repo: RepoRow, before: string, after: string): Promise<PushedCommits> {
  const pending: Promise<unknown>[] = [];
  try {
    return await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const ctx: ResolveContext = { env, repo, artifacts, bypass: false, waitUntil: (p) => pending.push(p) };
      const reader: CommitReader = {
        async readCommit(sha) {
          const c = await readCommitInfo(ctx, sha);
          return c ? { treeHash: c.tree, parents: c.parents } : null;
        },
      };
      const seen = new Set<string>();
      const out: PushedCommits = { commits: [], mainlineTruncated: false, sidesSkipped: 0 };
      let logs = 0;
      type Entry = { hash: string; message: string; parents: string[] };
      const chain = async (tip: string, stop: ReadonlySet<string>, limit: number): Promise<{ commits: Entry[]; reached: boolean } | null> => {
        if (logs >= COMMIT_SCAN.logCallsMax) return null;
        logs++;
        const log = await (await artifacts.get()).log({ ref: tip, limit: limit + 1 });
        const commits: Entry[] = [];
        for (const c of log) {
          if (stop.has(c.hash)) return { commits, reached: true };
          // Trust the chain only while each entry is the previous one's first parent.
          if (commits.length === 0 ? c.hash !== tip : commits[commits.length - 1]!.parents[0] !== c.hash) break;
          if (commits.length >= limit) break;
          commits.push({ hash: c.hash, message: c.message, parents: c.parents });
        }
        return { commits, reached: false };
      };
      const take = (commits: Entry[]) => {
        for (const c of commits) {
          if (seen.has(c.hash)) continue;
          seen.add(c.hash);
          out.commits.push({ sha: c.hash, message: c.message });
        }
      };
      const main = await chain(after, new Set([before]), COMMIT_SCAN.mainlineMax);
      if (!main) return out;
      out.mainlineTruncated = !main.reached;
      take(main.commits);
      const merges = main.commits.filter((c) => c.parents.length > 1);
      for (let i = 0; i < merges.length; i++) {
        const m = merges[i]!;
        for (const side of m.parents.slice(1)) {
          const room = COMMIT_SCAN.commitsMax - out.commits.length;
          if (room <= 0 || seen.has(side)) {
            if (room <= 0) out.sidesSkipped++;
            continue;
          }
          const base = await mergeBase(reader, m.parents[0]!, side, { maxCommitReads: COMMIT_SCAN.mergeBaseReadsMax, concurrency: 4 });
          if (base.truncated || base.bases.length !== 1) {
            out.sidesSkipped++;
            continue;
          }
          const walked = await chain(side, new Set(base.bases), room);
          if (!walked || !walked.reached) {
            out.sidesSkipped++;
            continue;
          }
          take(walked.commits);
          merges.push(...walked.commits.filter((c) => c.parents.length > 1));
        }
      }
      return out;
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

export interface CommitClose {
  number: number;
  /** Lower-case `owner/name` when the reference was qualified. */
  repo: string | null;
  sha: string;
}

/**
 * The issues that commit messages close (`fixes #12` in a commit pushed to
 * the default branch), each attributed to the oldest commit that closes it.
 * Commits are given newest first, as the log returns them.
 */
export function commitClosingRefs(commits: readonly { sha: string; message: string }[]): CommitClose[] {
  const out = new Map<string, CommitClose>();
  for (let i = commits.length - 1; i >= 0; i--) {
    const c = commits[i]!;
    for (const r of issueRefsIn(c.message)) {
      if (r.kind !== 'closes') continue;
      const repo = r.repo?.toLowerCase() ?? null;
      const key = `${repo ?? ''}#${r.number}`;
      if (!out.has(key)) out.set(key, { number: r.number, repo, sha: c.sha });
    }
  }
  return [...out.values()];
}

/**
 * Closes the open issues that pushed commits close. A qualified reference
 * counts only when it names this repository.
 */
export function commitCloseStatement(db: D1Database, repoId: string, closes: readonly CommitClose[], now: number): D1PreparedStatement {
  const closer = `(SELECT json_extract(j.value, '$.sha') FROM json_each(?2) j, repos r
      WHERE r.id = issues.repo_id AND json_extract(j.value, '$.number') = issues.number
        AND (json_extract(j.value, '$.repo') IS NULL OR json_extract(j.value, '$.repo') = lower(r.owner_login || '/' || r.name))
      LIMIT 1)`;
  return db
    .prepare(
      `UPDATE issues SET state = 'closed', closed_reason = 'completed', closed_at = ?3, updated_at = ?3, closed_by_change_id = NULL,
              closed_by_commit = ${closer}
        WHERE repo_id = ?1 AND state = 'open' AND ${closer} IS NOT NULL`,
    )
    .bind(repoId, JSON.stringify(closes), now);
}

// ---------------------------------------------------------------------------
// The guard as an issue producer
// ---------------------------------------------------------------------------

/** Bounds of the default-branch guard scan (guardScanStatements). */
export const GUARD_SCAN = {
  /** Failing findings filed per push; further ones only widen the detail. */
  findingsMax: 10,
  /** Open guard issues read for verified-closing, newest first. */
  openMax: 100,
} as const;

export interface GuardScanResult {
  statements: D1PreparedStatement[];
  /** One line for the effect's completion record. */
  detail: string;
}

/**
 * The `kvarm/guard` evaluation of one push to the default branch, as issue
 * statements for the push effect's completion batch (services/events.ts).
 * The publication path is recognized by the merge commit recorded on the
 * change it already gated and skipped; what is left is a push that bypassed
 * every gate, so its whole tree diff gets the scan a change gets. Each
 * failing finding files one fingerprinted issue (guardFingerprint), or
 * counts one more occurrence while one is open; a later push that changes
 * that path without triggering the rule again closes the issue as
 * verified, attributed to the new tip — and only from a complete scan, so
 * a path the budgets stopped the guard from reading can never read as
 * fixed. Neutral findings never failed a gate and open no issues.
 */
export async function guardScanStatements(env: Env, repo: RepoRow, before: string, after: string, now: number): Promise<GuardScanResult> {
  const db = env.DB;
  if (await db.prepare(`SELECT 1 FROM change_sets WHERE repo_id = ?1 AND state = 'merged' AND merge_commit = ?2 LIMIT 1`).bind(repo.id, after).first()) {
    return { statements: [], detail: 'published change; kvarm/guard already gated it' };
  }
  const pending: Promise<unknown>[] = [];
  try {
    return await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const ctx: ResolveContext = { env, repo, artifacts, bypass: false, waitUntil: (p) => pending.push(p) };
      const [base, head] = await Promise.all([readCommitInfo(ctx, before), readCommitInfo(ctx, after)]);
      if (!base || !head) return { statements: [], detail: 'the previous or the new tip could not be read' };
      if (base.tree === head.tree) return { statements: [], detail: 'no tree change' };
      const { body } = await treePairBody(ctx, base.tree, head.tree);
      if (body.files.length === 0) return { statements: [], detail: 'no changed files' };
      const summary = await evaluateGuard(ctx, base.tree, head.tree, body);
      const filed = new Map<string, GuardFinding>();
      for (const f of summary.findings) {
        if (f.severity === 'failure') filed.set(guardFingerprint(f.rule, f.path), f);
      }
      const open = (
        await db
          .prepare(`SELECT number, fingerprint, paths FROM issues WHERE repo_id = ?1 AND source = 'guard' AND state = 'open' ORDER BY number DESC LIMIT ?2`)
          .bind(repo.id, GUARD_SCAN.openMax)
          .all<{ number: number; fingerprint: string; paths: string | null }>()
      ).results;
      const changed = new Set(body.files.map((f) => f.path.toLowerCase()));
      const cleared = summary.complete
        ? open
            .filter((o) => !filed.has(o.fingerprint) && parseJson<string[]>(o.paths, []).some((p) => changed.has(p.toLowerCase())))
            .map((o) => o.fingerprint)
        : [];
      const statements: D1PreparedStatement[] = [];
      const filedList = [...filed.entries()].slice(0, GUARD_SCAN.findingsMax);
      for (const [fingerprint, f] of filedList) {
        statements.push(
          ...issueSignalStatements(db, repo.id, {
            source: 'guard',
            fingerprint,
            title: `${f.rule} in ${f.path}`,
            body: `${f.message}${f.line !== undefined ? ` (line ${f.line})` : ''}.\n\nFiled automatically by the kvarm/guard scan of the push \`${after.slice(0, 10)}\` to the default branch. A push that changes \`${f.path}\` without triggering this rule again closes this issue as verified; one that triggers it again counts one more occurrence here.`,
            paths: [f.path],
            evidence: { sha: after },
          }, now),
        );
      }
      for (const fingerprint of cleared) {
        statements.push(...resolveSignalStatements(db, repo.id, fingerprint, { commit: after, evidence: { sha: after }, reason: 'verified' }, now, { retireTasks: false }));
      }
      if (statements.length > 0) statements.push(retireIssueTasksStatement(db, repo.id, now));
      const held = filed.size - filedList.length;
      const openFingerprints = new Set(open.map((o) => o.fingerprint));
      const fresh = filedList.filter(([fingerprint]) => !openFingerprints.has(fingerprint)).length;
      const counted = filedList.length - fresh;
      const detail =
        filedList.length === 0 && cleared.length === 0
          ? `no failing guard findings in ${body.files.length} changed file(s)`
          : `filed ${fresh}, counted ${counted}, verified-closed ${cleared.length}${held > 0 ? `, ${held} beyond the cap` : ''}`;
      return { statements, detail: detail + (summary.complete ? '' : '; scan incomplete, no issues verified-closed') };
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

// ---------------------------------------------------------------------------
// fix-issue agent tasks
// ---------------------------------------------------------------------------

/** Agent task kind that asks an agent to fix an issue (services/tasks.ts claims and completes it). */
export const FIX_ISSUE = 'fix-issue';

const TASK_CREATED_EVENT = 'kvarm.task.created';

/**
 * Ends the live fix-issue tasks of issues that are closed now: `completed`
 * when the claimant's workspace merged (its change closed the issue),
 * `obsolete` otherwise. Runs in every batch that closes issues.
 */
export function retireIssueTasksStatement(db: D1Database, repoId: string, now: number): D1PreparedStatement {
  const merged = `claim_workspace_id IN (SELECT w.id FROM workspaces w WHERE w.repo_id = ?1 AND w.status = 'merged')`;
  return db
    .prepare(
      `UPDATE agent_tasks
          SET status = CASE WHEN ${merged} THEN 'completed' ELSE 'obsolete' END,
              completed_at = CASE WHEN ${merged} THEN ?2 ELSE completed_at END,
              completed_by = CASE WHEN ${merged} THEN claimed_by ELSE completed_by END,
              lease_expires_at = NULL, updated_at = ?2
        WHERE repo_id = ?1 AND kind = '${FIX_ISSUE}' AND status IN ('open', 'claimed')
          AND EXISTS (SELECT 1 FROM issues i WHERE i.repo_id = ?1 AND i.number = json_extract(agent_tasks.payload, '$.issue') AND i.state = 'closed')`,
    )
    .bind(repoId, now);
}

/**
 * POST issues/:number/dispatch: one live fix-issue task per open issue. The
 * task and its `kvarm.task.created` event are written together, only when
 * the issue is open and has no live task; otherwise the live task is
 * returned as it is.
 */
export async function dispatchIssue(cx: IssueContext, rawNumber: string): Promise<ServiceResult<{ task: string; created: boolean }>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
  const db = cx.env.DB;
  const taskId = crypto.randomUUID();
  const now = Date.now();
  const noLiveTask = `NOT EXISTS (SELECT 1 FROM agent_tasks t WHERE t.repo_id = ?2 AND t.kind = '${FIX_ISSUE}' AND t.status IN ('open', 'claimed')
                       AND json_extract(t.payload, '$.issue') = ?3)`;
  const [, , issue, live] = await db.batch([
    db
      .prepare(
        `INSERT INTO events (id, type, payload, processed_at, created_at)
         SELECT ?4, '${TASK_CREATED_EVENT}',
                json_object('specversion', '1.0', 'id', ?4, 'type', '${TASK_CREATED_EVENT}',
                            'source', '/repos/' || r.owner_login || '/' || r.name, 'subject', ?1, 'time', ?6,
                            'datacontenttype', 'application/json',
                            'data', json_object('task', ?1, 'kind', '${FIX_ISSUE}', 'repo', r.owner_login || '/' || r.name,
                                                'issue', i.number, 'title', i.title, 'paths', json(COALESCE(i.paths, '[]')))),
                NULL, ?5
           FROM issues i JOIN repos r ON r.id = i.repo_id
          WHERE i.repo_id = ?2 AND i.number = ?3 AND i.state = 'open' AND ${noLiveTask}`,
      )
      .bind(taskId, cx.repo.id, number, crypto.randomUUID(), now, new Date(now).toISOString()),
    db
      .prepare(
        `INSERT INTO agent_tasks (id, repo_id, kind, change_set_id, workspace_id, status, generation, head_sha, base_sha, payload, created_at, updated_at)
         SELECT ?1, i.repo_id, '${FIX_ISSUE}', NULL, NULL, 'open', 0, NULL, NULL, json_object('issue', i.number, 'title', i.title), ?4, ?4
           FROM issues i WHERE i.repo_id = ?2 AND i.number = ?3 AND i.state = 'open' AND ${noLiveTask}`,
      )
      .bind(taskId, cx.repo.id, number, now),
    db.prepare('SELECT state FROM issues WHERE repo_id = ?1 AND number = ?2').bind(cx.repo.id, number),
    db
      .prepare(
        `SELECT id FROM agent_tasks WHERE repo_id = ?1 AND kind = '${FIX_ISSUE}' AND status IN ('open', 'claimed')
           AND json_extract(payload, '$.issue') = ?2 ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(cx.repo.id, number),
  ]);
  const state = (issue?.results as Array<{ state: string }> | undefined)?.[0]?.state;
  if (!state) return fail(404, 'issue not found', 'ISSUE_NOT_FOUND');
  if (state !== 'open') return fail(409, 'a closed issue cannot be dispatched; reopen it first', 'ISSUE_CLOSED');
  const id = (live?.results as Array<{ id: string }> | undefined)?.[0]?.id;
  if (!id) return fail(500, 'the task could not be created', 'CREATE_FAILED');
  return { ok: true, value: { task: id, created: id === taskId } };
}

/** Statements that remove a repo's issues and their links and comments, for the repo DELETE batch (before the repo row). */
export function issueCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM issue_links WHERE repo_id = ?').bind(repoId),
    issuePathsCleanupStatement(db, repoId),
    db.prepare('DELETE FROM issue_comments WHERE issue_id IN (SELECT id FROM issues WHERE repo_id = ?)').bind(repoId),
    db.prepare('DELETE FROM issues WHERE repo_id = ?').bind(repoId),
  ];
}
