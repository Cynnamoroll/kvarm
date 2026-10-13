/**
 * Nexus intents, forecasts and active-workspace overlap (architecture §11.2).
 * This module owns all overlap/conflict-prediction signal (§0.1); other
 * services read it through these functions instead of computing their own.
 *
 * Two kinds of signal live in the `workspace_paths` index, one row per
 * normalized path or prefix (a trailing `/`) of an active workspace:
 *  - declared: the workspace's nonexclusive intent, replaced as a whole;
 *  - observed: the cumulative base→head changed-path set, reconciled from the
 *    push consumer, so reverted edits drop out and a late older event never
 *    rolls a newer set back.
 * Reads probe the index by path (exact keys, ancestor prefixes, prefix
 * ranges) or group it by shared path; no request compares workspaces pairwise.
 * Everything here is advice: nothing locks a path, refuses a push or changes a
 * merge decision. Abandon, merge and expiry remove a workspace's signal from
 * the active index; code, refs and the workspace row stay.
 */

import { withLazyRepo } from '../../artifacts/repo';
import type { RepoRow } from '../../db/repos';
import type { ServiceResult } from '../../repos/service';
import type { Actor } from '../authz';
import { normalizeBranch } from '../changes';
import { changedPaths } from '../compare';
import { readCommitInfo, type ResolveContext } from '../refs';
import { WORKSPACE_ID_RE, agentOwnershipDenial } from '../workspaces';
import { INTENT_LIMITS, ancestorPrefixes, collapseObserved, covers, intersects, isPrefix, normalizeDeclaration, normalizePath, prefixUpper } from './paths';
import { analyzeSemantic, forecastSemanticPlan, overlapSemanticPlan, parseSemanticFlag, semanticWriteStatements, type SemanticForecast, type SemanticOverlap } from './semantic';
import { declarationReplaceStatements, observedWriteStatements } from './store';

const ZERO_SHA = '0000000000000000000000000000000000000000';

export const ADVISORY_NOTE =
  'Advisory only: matches predict likely overlap from declared intents and observed changes. An empty or truncated result is not proof of compatibility, and nothing here locks paths, refuses pushes or changes merge decisions; mergeability and required checks decide.';

type Fail = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface IntentContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
}

// ---------------------------------------------------------------------------
// Intent view
// ---------------------------------------------------------------------------

interface IntentRow {
  id: string;
  status: string;
  ref: string | null;
  agent_id: string | null;
  base_ref: string | null;
  base_sha: string | null;
  head_sha: string | null;
  ref_sha: string | null;
  intent_paths: string | null;
  intent_updated_at: number | null;
  intent_expires_at: number | null;
  observed_paths: string | null;
  observed_base_sha: string | null;
  observed_head_sha: string | null;
  observed_at: number | null;
  observed_truncated: string | null;
  declared_rows: number;
  observed_rows: number;
}

const INTENT_SELECT = `SELECT w.id, w.status, w.ref, w.agent_id, w.base_ref, w.base_sha, w.head_sha, f.sha AS ref_sha,
       w.intent_paths, w.intent_updated_at, w.intent_expires_at,
       w.observed_paths, w.observed_base_sha, w.observed_head_sha, w.observed_at, w.observed_truncated,
       (SELECT COUNT(*) FROM workspace_paths p WHERE p.repo_id = w.repo_id AND p.workspace_id = w.id AND p.kind = 'declared') AS declared_rows,
       (SELECT COUNT(*) FROM workspace_paths p WHERE p.repo_id = w.repo_id AND p.workspace_id = w.id AND p.kind = 'observed') AS observed_rows
  FROM workspaces w
  LEFT JOIN repo_refs f ON f.repo_id = w.repo_id AND f.ref = w.ref`;

export interface IntentView {
  workspace: string;
  status: string;
  base: string | null;
  declaredPaths: string[];
  declaredAt: string | null;
  declaredExpiresAt: string | null;
  /** The declaration's ttl passed: it stays readable here but no longer matches forecasts. */
  declaredExpired: boolean;
  observedPaths: string[];
  /** The commit pair the observed set was computed from. */
  baseSha: string | null;
  headSha: string | null;
  observedAt: string | null;
  observedTruncated: boolean;
  observedTruncatedReason?: string;
  /** The workspace head as last recorded from pushes; differs from headSha while a reconciliation is pending. */
  workspaceHeadSha: string | null;
  observedCurrent: boolean;
  /** Per declared entry, the observed paths it intersects. */
  matches: Array<{ declared: string; observed: string[] }>;
  /** Observed paths no declared entry covers (advisory evidence, never a refusal). */
  outsideDeclaration: string[];
  /** Rows this workspace has in the active index (a prefix is one row). */
  index: { declared: number; observed: number };
  advisory: true;
}

function intentView(row: IntentRow, now: number): IntentView {
  const declared = parseList(row.intent_paths);
  const observed = parseList(row.observed_paths);
  const expired = row.intent_expires_at !== null && row.intent_expires_at <= now;
  const pushed = row.ref_sha && row.ref_sha !== ZERO_SHA ? row.ref_sha : null;
  const workspaceHead = row.status === 'active' ? (pushed ?? row.head_sha ?? row.base_sha) : row.head_sha;
  const view: IntentView = {
    workspace: row.id,
    status: row.status,
    base: row.base_ref,
    declaredPaths: declared,
    declaredAt: iso(row.intent_updated_at),
    declaredExpiresAt: iso(row.intent_expires_at),
    declaredExpired: expired,
    observedPaths: observed,
    baseSha: row.observed_base_sha ?? row.base_sha,
    headSha: row.observed_head_sha,
    observedAt: iso(row.observed_at),
    observedTruncated: row.observed_truncated !== null,
    workspaceHeadSha: workspaceHead,
    observedCurrent: workspaceHead !== null && workspaceHead === row.observed_head_sha,
    matches: declared.map((d) => ({ declared: d, observed: observed.filter((o) => intersects(d, o)) })),
    outsideDeclaration: observed.filter((o) => !declared.some((d) => covers(d, o))),
    index: { declared: expired ? 0 : row.declared_rows, observed: row.observed_rows },
    advisory: true,
  };
  if (row.observed_truncated !== null) view.observedTruncatedReason = row.observed_truncated;
  return view;
}

/** GET workspaces/:id/intent: one indexed read. */
export async function getIntent(cx: IntentContext, id: string): Promise<ServiceResult<IntentView>> {
  const row = WORKSPACE_ID_RE.test(id)
    ? await cx.env.DB.prepare(`${INTENT_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(cx.repo.id, id).first<IntentRow>()
    : null;
  if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  return { ok: true, value: intentView(row, Date.now()) };
}

/**
 * POST workspaces/:id/intent {paths, prefixes?, ttlSeconds?}: replaces the
 * declaration in one guarded batch that also reads the row back; when that
 * write did not land (missing or inactive) the reason comes from the
 * read-back row. An agent's ownership and token ref ceiling are checked on
 * a row read before the write.
 */
export async function declareIntent(cx: IntentContext, id: string, input: unknown): Promise<ServiceResult<IntentView>> {
  if (!WORKSPACE_ID_RE.test(id)) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const parsed = normalizeDeclaration(input);
  if (!parsed.ok) return fail(422, parsed.error, 'INVALID_INTENT');
  const now = Date.now();
  const pathsJson = JSON.stringify(parsed.value.paths);
  const expiresAt = parsed.value.ttlSeconds ? now + parsed.value.ttlSeconds * 1000 : null;
  const write = async (agentId: string | null) => {
    const results = await cx.env.DB.batch([
      ...declarationReplaceStatements(cx.env.DB, { repoId: cx.repo.id, workspaceId: id, pathsJson, expiresAt, now, agentId }),
      cx.env.DB.prepare(`${INTENT_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(cx.repo.id, id),
    ]);
    return {
      landed: (results[0]?.meta.changes ?? 0) > 0,
      row: (results[results.length - 1]?.results as IntentRow[] | undefined)?.[0] ?? null,
    };
  };
  if (cx.actor?.agent) {
    // An agent's token ceiling decides before anything is written, its own workspaces included.
    const row = await cx.env.DB.prepare(`${INTENT_SELECT} WHERE w.repo_id = ? AND w.id = ?`).bind(cx.repo.id, id).first<IntentRow>();
    if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    if (row.status !== 'active') return fail(409, `the workspace is ${row.status}`, 'WORKSPACE_NOT_ACTIVE', { workspaceStatus: row.status });
    const denied = agentOwnershipDenial(cx.actor, row);
    if (denied) return fail(403, denied, 'WORKSPACE_NOT_OWNED');
    const r = await write(row.agent_id);
    if (!r.landed || !r.row) return fail(409, 'the workspace left active meanwhile', 'WORKSPACE_NOT_ACTIVE');
    return { ok: true, value: intentView(r.row, now) };
  }
  const r = await write(null);
  if (!r.landed || !r.row) {
    if (!r.row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    return fail(409, `the workspace is ${r.row.status}`, 'WORKSPACE_NOT_ACTIVE', { workspaceStatus: r.row.status });
  }
  return { ok: true, value: intentView(r.row, now) };
}

// ---------------------------------------------------------------------------
// Push reconciliation (push consumer `intent-index` effect)
// ---------------------------------------------------------------------------

export interface ObservedTarget {
  repoId: string;
  artifactsName: string;
  workspaceId: string;
  /** The workspace's base commit (its creation-time base head). */
  baseSha: string;
  headSha: string;
  /** The push event being reconciled; null for a seed by the service that just created the ref (see `ObservedWrite.event`). */
  event: { id: string; at: number } | null;
}

/**
 * The statements recording a workspace's cumulative base→head changed paths,
 * for the consumer's completion batch. Commits and trees come from the
 * commit cache and the cached compare body when present, else Artifacts.
 */
export async function reconcileObserved(env: Env, t: ObservedTarget): Promise<{ statements: D1PreparedStatement[]; detail: string }> {
  const pending: Promise<unknown>[] = [];
  try {
    return await withLazyRepo(env, t.artifactsName, async (artifacts) => {
      const ctx: ResolveContext = {
        env,
        repo: { id: t.repoId, artifacts_name: t.artifactsName } as RepoRow,
        artifacts,
        bypass: false,
        waitUntil: (p) => pending.push(p),
      };
      const [base, head] = await Promise.all([readCommitInfo(ctx, t.baseSha), readCommitInfo(ctx, t.headSha)]);
      if (!base || !head) throw new Error(`commit not readable: ${base ? t.headSha : t.baseSha}`);
      const diff = await changedPaths(ctx, base.tree, head.tree);
      const changed = new Set(diff.paths).size;
      const c = collapseObserved(diff.paths);
      const omitted: string[] = [];
      if (diff.truncated) omitted.push(`base→head diff incomplete: ${diff.truncatedReason ?? 'budget exhausted'}`);
      if (c.truncated) omitted.push(`more than ${INTENT_LIMITS.observedMax} top-level entries changed; the first ${INTENT_LIMITS.observedMax} are kept`);
      const reasons = [...omitted];
      if (!c.truncated && c.collapsed) reasons.push(`${changed} changed paths collapsed into directory prefixes (cap ${INTENT_LIMITS.observedMax} entries)`);
      const now = Date.now();
      const observed = observedWriteStatements(env.DB, {
        repoId: t.repoId,
        workspaceId: t.workspaceId,
        pathsJson: JSON.stringify(c.paths),
        baseSha: t.baseSha,
        headSha: t.headSha,
        event: t.event,
        now,
        truncated: reasons.length > 0 ? reasons.join('; ') : null,
        omitted: omitted.length > 0 ? omitted.join('; ') : null,
        prefixes: c.paths.filter(isPrefix).length,
      });
      // The semantic rows describe the same head and land under the same guard (architecture §11.2).
      const semantic = await analyzeSemantic(artifacts, { base: base.tree, head: head.tree }, diff.paths, diff.truncated ? (diff.truncatedReason ?? 'budget exhausted') : null);
      const statements = [
        ...observed,
        ...semanticWriteStatements(env.DB, { repoId: t.repoId, workspaceId: t.workspaceId, eventAt: t.event?.at ?? 0, headSha: t.headSha, now, record: semantic }),
      ];
      return { statements, detail: `${c.paths.length} observed entries for ${changed} changed paths (${diff.source}); semantic: ${semantic.detail}` };
    });
  } finally {
    await Promise.allSettled(pending);
  }
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

export interface ForecastQuery {
  paths?: string;
  base?: string;
  limit?: string;
  cursor?: string;
  exclude?: string;
  /** `0`/`false` leaves the semantic layer out (default: included on the first page). */
  semantic?: string;
}

export interface Evidence {
  kind: 'declared' | 'observed';
  /** The indexed entry (a trailing `/` is a prefix). */
  path: string;
  /** The query path it intersects. */
  query: string;
}

export interface ForecastMatch {
  workspace: string;
  task: string | null;
  agent: string | null;
  agentId: string | null;
  base: string | null;
  baseSha: string | null;
  /** `observed` when any actual change matched, else `declared`. */
  matchKind: 'declared' | 'observed';
  matchKinds: Array<'declared' | 'observed'>;
  evidence: Evidence[];
  evidenceCount: number;
  evidenceTruncated?: true;
  /** The workspace revision the observed signal reflects (its base head before any push). */
  revision: string | null;
  observedHeadSha: string | null;
  observedBaseSha: string | null;
  observedAt: string | null;
  observedTruncated: boolean;
  declaredAt: string | null;
  declaredExpiresAt: string | null;
}

/** An active workspace whose observed index omits some of its changed paths, so it may match without being reported. */
export interface IncompleteIndex {
  workspace: string;
  reason: string;
}

export interface ForecastResponse {
  query: { paths: string[]; base: string | null; exclude: string | null };
  advisory: true;
  advisoryNote: string;
  matches: ForecastMatch[];
  truncated: boolean;
  truncatedReason?: string;
  /** In-scope workspaces with an incomplete observed index (on every page; absent when there are none). */
  incomplete?: IncompleteIndex[];
  /** The advisory semantic dependency layer (first page only, unless `semantic=0`); its truncation is its own. */
  semantic?: SemanticForecast;
  nextCursor: string | null;
  limit: number;
}

/**
 * Whether workspace `w`'s observed index omits changed paths. A row
 * reconciled before observed_omitted existed has it NULL and its omission
 * reasons only in observed_truncated, where they come first; the only
 * non-omission reason (collapse into prefixes) starts with the changed-path
 * count, so any other non-null observed_truncated there is an omission.
 */
const INDEX_INCOMPLETE = `(w.observed_omitted IS NOT NULL OR (w.observed_truncated IS NOT NULL AND w.observed_truncated NOT GLOB '[0-9]*'))`;
const INCOMPLETE_REASON = 'COALESCE(w.observed_omitted, w.observed_truncated)';

/** Active workspaces (on `base` when given, other than `exclude`) whose observed index omitted changed paths. */
function incompleteStatement(db: D1Database, repoId: string, base: string | null, exclude: string | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT w.id AS workspace, ${INCOMPLETE_REASON} AS reason FROM workspaces w INDEXED BY idx_ws_index_incomplete
        WHERE w.repo_id = ?1 AND w.status = 'active' AND ${INDEX_INCOMPLETE}
          AND (?2 IS NULL OR w.base_ref = ?2) AND (?3 IS NULL OR w.id != ?3)
        ORDER BY w.id LIMIT ${INTENT_LIMITS.incompleteListMax + 1}`,
    )
    .bind(repoId, base, exclude);
}

/** The disclosed list and a reason for the response's truncatedReason, from `incompleteStatement`. */
function incompleteOf(result: D1Result | undefined): { list: IncompleteIndex[]; reason: string } | null {
  const rows = (result?.results as IncompleteIndex[] | undefined) ?? [];
  if (rows.length === 0) return null;
  const max = INTENT_LIMITS.incompleteListMax;
  const count = rows.length > max ? `more than ${max}` : `${rows.length}`;
  return {
    list: rows.slice(0, max).map((r) => ({ workspace: r.workspace, reason: r.reason })),
    reason: `the observed index of ${count} active workspace(s) is incomplete (changed paths were omitted), so they may overlap without being reported; see incomplete`,
  };
}

interface ForecastRow {
  id: string;
  task: string | null;
  agent: string | null;
  agent_id: string | null;
  base_ref: string | null;
  base_sha: string | null;
  observed_head_sha: string | null;
  observed_base_sha: string | null;
  observed_at: number | null;
  observed_truncated: string | null;
  intent_updated_at: number | null;
  intent_expires_at: number | null;
  ev: Array<[Evidence['kind'], string]>;
}

/** One index hit with its workspace: `[kind, path, ...ForecastRow columns in declaration order]`. */
type HitTuple = [
  Evidence['kind'],
  string,
  string,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number | null,
  string | null,
  number | null,
  number | null,
];

const HIT_JSON = `json_array(p.kind, p.path, w.id, w.task, w.agent, w.agent_id, w.base_ref, w.base_sha, w.observed_head_sha,
  w.observed_base_sha, w.observed_at, w.observed_truncated, w.intent_updated_at, w.intent_expires_at)`;

/**
 * The conditions every forecast probe applies before its LIMIT (?3 now, ?4
 * base, ?5 cursor or '', ?6 exclude). The cursor bounds the index column
 * itself so a later page starts its probe at the cursor.
 */
const HIT_FILTER = `p.workspace_id > ?5 AND w.repo_id = ?1 AND w.status = 'active'
  AND (p.kind = 'observed' OR w.intent_expires_at IS NULL OR w.intent_expires_at > ?3)
  AND (?4 IS NULL OR w.base_ref = ?4) AND (?6 IS NULL OR w.id != ?6)`;

function hitsOf(result: D1Result | undefined): HitTuple[] {
  const out: HitTuple[] = [];
  for (const r of (result?.results as Array<{ hits: string | null }> | undefined) ?? []) {
    if (r.hits) out.push(...(JSON.parse(r.hits) as HitTuple[]));
  }
  return out;
}

function parseLimit(raw: string | undefined, def: number, max: number): number | Fail {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < 1 || n > max) return fail(400, `limit must be an integer 1-${max}`, 'INVALID_LIMIT');
  return n;
}

function parseQueryPaths(raw: string | undefined): string[] | Fail {
  const parts = (raw ?? '').split(',').filter((p) => p.length > 0);
  if (parts.length === 0) return fail(422, 'paths is required: comma-separated repo-relative paths or prefixes (trailing /)', 'INVALID_PATHS');
  if (parts.length > INTENT_LIMITS.forecastPathsMax) {
    return fail(422, `at most ${INTENT_LIMITS.forecastPathsMax} paths per forecast request (got ${parts.length})`, 'TOO_MANY_PATHS', {
      limit: INTENT_LIMITS.forecastPathsMax,
    });
  }
  const out = new Set<string>();
  for (const p of parts) {
    const n = normalizePath(p);
    if (!n.ok) return fail(422, n.error, 'INVALID_PATHS');
    out.add(n.value);
  }
  return [...out].sort();
}

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/**
 * GET forecast?paths=a,b/&base=&limit=&cursor=&exclude=&semantic=: the active
 * workspaces whose declared or observed entries intersect the query paths.
 * Index probes per query path: the path itself and its ancestor prefixes
 * (a declared `src/` matches `src/a.ts`), plus the range below a query
 * prefix. One page of workspaces, ordered by id; the cursor is the last id.
 */
export async function forecast(cx: IntentContext, q: ForecastQuery): Promise<ServiceResult<ForecastResponse>> {
  const paths = parseQueryPaths(q.paths);
  if (isFail(paths)) return paths;
  let base: string | null = null;
  if (q.base !== undefined && q.base !== '') {
    base = normalizeBranch(q.base);
    if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  }
  const limit = parseLimit(q.limit, INTENT_LIMITS.forecastPageDefault, INTENT_LIMITS.forecastPageMax);
  if (isFail(limit)) return limit;
  const cursor = q.cursor ?? null;
  if (cursor !== null && !WORKSPACE_ID_RE.test(cursor)) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
  const exclude = q.exclude ?? null;
  if (exclude !== null && !WORKSPACE_ID_RE.test(exclude)) return fail(400, 'exclude must be a workspace id', 'INVALID_EXCLUDE');
  const withSemantic = parseSemanticFlag(q.semantic);
  if (withSemantic === null) return fail(400, 'semantic must be true, false, 1 or 0', 'INVALID_SEMANTIC');

  const exact = new Set<string>();
  const ranges: string[] = [];
  for (const p of paths) {
    exact.add(p);
    for (const a of ancestorPrefixes(p)) exact.add(a);
    if (isPrefix(p)) ranges.push(p);
  }
  // Each exact key is probed in workspace-id order and stops after the page:
  // the page's workspaces are the first `limit` ids of the union, and every
  // one of them is within the first `limit` ids of each probe it matches, so
  // the page and its evidence are complete while a popular path costs one
  // page of rows instead of one row per matching workspace.
  const exactSql = `SELECT (SELECT json_group_array(json(hit)) FROM (
        SELECT ${HIT_JSON} AS hit FROM workspace_paths p JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.repo_id = ?1 AND p.kind = k.kind AND p.path = k.path AND ${HIT_FILTER}
         ORDER BY p.workspace_id LIMIT ${limit + 1})) AS hits
      FROM (SELECT kinds.value AS kind, keys.value AS path FROM json_each('["declared","observed"]') kinds, json_each(?2) keys) k`;
  // Entries below a query prefix are ordered by path, not workspace, so each range reads at most a fixed number of hits and says when it stopped.
  const rangeMax = INTENT_LIMITS.forecastRangeHitMax;
  const rangeSql = `SELECT json_group_array(json(hit)) AS hits FROM (
        SELECT ${HIT_JSON} AS hit FROM workspace_paths p JOIN workspaces w ON w.id = p.workspace_id
         WHERE p.repo_id = ?1 AND p.kind IN ('declared', 'observed') AND p.path >= ?2 AND p.path < ?7 AND ${HIT_FILTER}
         LIMIT ${rangeMax + 1})`;
  const now = Date.now();
  const db = cx.env.DB;
  const semantic = withSemantic && cursor === null ? forecastSemanticPlan(db, { repoId: cx.repo.id, paths, base, exclude }) : null;
  const pathStatements = [
    db.prepare(exactSql).bind(cx.repo.id, JSON.stringify([...exact]), now, base, cursor ?? '', exclude),
    ...ranges.map((r) => db.prepare(rangeSql).bind(cx.repo.id, r, now, base, cursor ?? '', exclude, prefixUpper(r))),
    incompleteStatement(db, cx.repo.id, base, exclude),
  ];
  const all = await db.batch([...pathStatements, ...(semantic?.statements ?? [])]);
  const results = all.slice(0, pathStatements.length);
  const incompleteRes = results[results.length - 1];
  const hits = hitsOf(results[0]);
  const cutRanges: string[] = [];
  ranges.forEach((r, i) => {
    const got = hitsOf(results[1 + i]);
    if (got.length > rangeMax) cutRanges.push(r);
    hits.push(...got.slice(0, rangeMax));
  });
  const byId = new Map<string, ForecastRow>();
  const seen = new Set<string>();
  for (const [kind, path, id, ...w] of hits) {
    const key = `${id}\0${kind}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let row = byId.get(id);
    if (!row) {
      const [task, agent, agentId, baseRef, baseSha, observedHead, observedBase, observedAt, observedTruncated, intentUpdated, intentExpires] = w;
      row = {
        id,
        task,
        agent,
        agent_id: agentId,
        base_ref: baseRef,
        base_sha: baseSha,
        observed_head_sha: observedHead,
        observed_base_sha: observedBase,
        observed_at: observedAt as number | null,
        observed_truncated: observedTruncated as string | null,
        intent_updated_at: intentUpdated as number | null,
        intent_expires_at: intentExpires as number | null,
        ev: [],
      };
      byId.set(id, row);
    }
    row.ev.push([kind, path]);
  }
  const rows = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const page = rows.slice(0, limit);
  const matches = page.map((row) => forecastMatch(row, paths));
  const more = rows.length > limit;
  const incomplete = incompleteOf(incompleteRes);
  const reasons: string[] = [];
  if (more) reasons.push(`more than ${limit} matching workspaces; follow nextCursor for the rest`);
  if (cutRanges.length > 0) {
    reasons.push(
      `more than ${rangeMax} index entries match below ${cutRanges.join(', ')}; workspaces matching only beyond them are not reported, narrow the prefix`,
    );
  }
  if (incomplete) reasons.push(incomplete.reason);
  const out: ForecastResponse = {
    query: { paths, base, exclude },
    advisory: true,
    advisoryNote: ADVISORY_NOTE,
    matches,
    truncated: reasons.length > 0,
    nextCursor: more ? (page[page.length - 1]?.id ?? null) : null,
    limit,
  };
  if (reasons.length > 0) out.truncatedReason = reasons.join('; ');
  if (incomplete) out.incomplete = incomplete.list;
  if (semantic) out.semantic = semantic.read(all.slice(pathStatements.length));
  return { ok: true, value: out };
}

function forecastMatch(row: ForecastRow, queries: string[]): ForecastMatch {
  const hits = row.ev.map(([kind, path]): Evidence => ({
    kind,
    path,
    query: queries.find((q) => intersects(path, q)) ?? path,
  }));
  hits.sort((a, b) => (a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kinds = [...new Set(hits.map((h) => h.kind))].sort();
  const m: ForecastMatch = {
    workspace: row.id,
    task: row.task,
    agent: row.agent,
    agentId: row.agent_id,
    base: row.base_ref,
    baseSha: row.base_sha,
    matchKind: kinds.includes('observed') ? 'observed' : 'declared',
    matchKinds: kinds,
    evidence: hits.slice(0, INTENT_LIMITS.evidenceMax),
    evidenceCount: hits.length,
    revision: row.observed_head_sha ?? row.base_sha,
    observedHeadSha: row.observed_head_sha,
    observedBaseSha: row.observed_base_sha,
    observedAt: iso(row.observed_at),
    observedTruncated: row.observed_truncated !== null,
    declaredAt: iso(row.intent_updated_at),
    declaredExpiresAt: iso(row.intent_expires_at),
  };
  if (hits.length > INTENT_LIMITS.evidenceMax) m.evidenceTruncated = true;
  return m;
}

// ---------------------------------------------------------------------------
// Active-workspace overlap
// ---------------------------------------------------------------------------

export interface OverlapQuery {
  base?: string;
  limit?: string;
  cursor?: string;
  /** `0`/`false` leaves the semantic layer out (default: included on the first page). */
  semantic?: string;
}

export interface OverlapHead {
  workspace: string;
  task: string | null;
  agent: string | null;
  observedHeadSha: string | null;
  observedAt: string | null;
}

export interface OverlapPair {
  /** Sorted workspace ids. */
  workspaces: [string, string];
  matchKind: 'observed';
  /** Shared changed paths (for a collapsed prefix, the other side's paths below it). */
  paths: string[];
  pathCount: number;
  pathsTruncated?: true;
  heads: [OverlapHead, OverlapHead];
}

export interface OverlapResponse {
  base: string;
  advisory: true;
  advisoryNote: string;
  pairs: OverlapPair[];
  truncated: boolean;
  truncatedReason?: string;
  /** Workspaces on `base` with an incomplete observed index (on every page; absent when there are none). */
  incomplete?: IncompleteIndex[];
  /** Advisory semantic pairs (first page only, unless `semantic=0`); its truncation is its own. */
  semantic?: SemanticOverlap;
  nextCursor: string | null;
  limit: number;
}

export interface PairWork<H> {
  /** `a:b` (sorted ids) → both sides and the shared paths. */
  pairs: Map<string, { heads: Map<string, H>; paths: Set<string> }>;
  /** Candidate pairs examined (the enumeration work done). */
  visits: number;
  reasons: string[];
}

/**
 * Pairs from shared-path groups and collapsed-prefix hits, under a work
 * budget: a group contributes pairs among its first
 * `overlapGroupMembersMax` members by id, enumeration stops after
 * `overlapPairVisitMax` candidate pairs, and at most `overlapPairMax`
 * distinct pairs are kept. Every bound that cut work is named in `reasons`.
 */
export function collectPairs<H>(
  groups: ReadonlyArray<{ path: string; members: readonly H[] }>,
  hits: ReadonlyArray<{ path: string; a: H; b: H }>,
  idOf: (h: H) => string,
): PairWork<H> {
  const L = INTENT_LIMITS;
  const pairs: PairWork<H>['pairs'] = new Map();
  let visits = 0;
  let pairCapped = false;
  let budgetSpent = false;
  const wide: string[] = [];
  const visit = (x: H, y: H, path: string): boolean => {
    if (visits >= L.overlapPairVisitMax) {
      budgetSpent = true;
      return false;
    }
    visits++;
    const [xi, yi] = [idOf(x), idOf(y)];
    if (xi === yi) return true;
    const [a, b, ai, bi] = xi < yi ? [x, y, xi, yi] : [y, x, yi, xi];
    const key = `${ai}:${bi}`;
    let p = pairs.get(key);
    if (!p) {
      if (pairs.size >= L.overlapPairMax) {
        pairCapped = true;
        return true;
      }
      p = { heads: new Map([[ai, a], [bi, b]]), paths: new Set() };
      pairs.set(key, p);
    }
    p.paths.add(path);
    return true;
  };

  run: {
    for (const g of groups) {
      const byId = new Map<string, H>();
      for (const h of g.members) byId.set(idOf(h), h);
      const members = [...byId.keys()].sort().map((id) => byId.get(id)!);
      if (members.length > L.overlapGroupMembersMax) wide.push(g.path);
      const kept = members.slice(0, L.overlapGroupMembersMax);
      for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) if (!visit(kept[i]!, kept[j]!, g.path)) break run;
    }
    for (const h of hits) if (!visit(h.a, h.b, h.path)) break run;
  }

  const reasons: string[] = [];
  if (wide.length > 0) {
    reasons.push(
      `more than ${L.overlapGroupMembersMax} workspaces share ${wide.length} path(s) (first: ${wide[0]}); only pairs among the first ${L.overlapGroupMembersMax} of each, by id, are reported`,
    );
  }
  if (budgetSpent) reasons.push(`the pair-visit budget of ${L.overlapPairVisitMax} was spent; pairs beyond it are not reported`);
  if (pairCapped) reasons.push(`more than ${L.overlapPairMax} overlapping pairs; the rest are not reported`);
  return { pairs, visits, reasons };
}

type HeadTuple = [string, string | null, number | null, string | null, string | null];

const headOf = (t: HeadTuple): OverlapHead => ({ workspace: t[0], task: t[3], agent: t[4], observedHeadSha: t[1], observedAt: iso(t[2]) });

const HEAD_JSON = (w: string) => `json_array(${w}.id, ${w}.observed_head_sha, ${w}.observed_at, ${w}.task, ${w}.agent)`;

/**
 * GET workspaces/overlap?base=&limit=&cursor=: pairs of active workspaces on
 * `base` (default: the repo's default branch) whose observed base→head
 * changes share paths. Workspaces with no change against their base have no
 * observed rows and so never pair. One batch: shared-path groups straight
 * from the index, plus the descendants of collapsed prefixes (only
 * workspaces with prefixes start that probe). Pairs are derived from groups,
 * capped, sorted, and paged by the `a:b` cursor.
 */
export async function overlap(cx: IntentContext, q: OverlapQuery): Promise<ServiceResult<OverlapResponse>> {
  const base = q.base === undefined || q.base === '' ? cx.repo.default_branch : normalizeBranch(q.base);
  if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  const limit = parseLimit(q.limit, INTENT_LIMITS.overlapPageDefault, INTENT_LIMITS.overlapPageMax);
  if (isFail(limit)) return limit;
  const cursor = q.cursor ?? null;
  if (cursor !== null) {
    const [a, b, extra] = cursor.split(':');
    if (extra !== undefined || !a || !b || !WORKSPACE_ID_RE.test(a) || !WORKSPACE_ID_RE.test(b)) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
  }
  const withSemantic = parseSemanticFlag(q.semantic);
  if (withSemantic === null) return fail(400, 'semantic must be true, false, 1 or 0', 'INVALID_SEMANTIC');
  const semantic = withSemantic && cursor === null ? overlapSemanticPlan(cx.env.DB, cx.repo.id, base) : null;

  const db = cx.env.DB;
  // Shared paths come from the per-(repo, base, path) share counts, so only
  // paths at least two workspaces touch are read; each group reads its
  // members in id order and aggregates at most one beyond the per-group cap,
  // so collectPairs can tell it was cut.
  const [groups, prefixHits, incompleteRes, ...semanticRes] = await db.batch([
    db
      .prepare(
        `SELECT s.path, (SELECT json_group_array(json(head)) FROM (
             SELECT ${HEAD_JSON('w')} AS head FROM workspace_paths p JOIN workspaces w ON w.id = p.workspace_id
              WHERE p.repo_id = ?1 AND p.kind = 'observed' AND p.path = s.path AND w.repo_id = ?1 AND w.status = 'active' AND w.base_ref = ?2
              ORDER BY p.workspace_id LIMIT ${INTENT_LIMITS.overlapGroupMembersMax + 1})) AS ws
           FROM workspace_path_shares s INDEXED BY idx_wps_shared
          WHERE s.repo_id = ?1 AND s.base_ref = ?2 AND s.members > 1
          ORDER BY s.path LIMIT ${INTENT_LIMITS.overlapGroupMax + 1}`,
      )
      .bind(cx.repo.id, base),
    db
      .prepare(
        `SELECT b.path AS path, ${HEAD_JSON('wa')} AS wa, ${HEAD_JSON('wb')} AS wb
           FROM workspaces wa INDEXED BY idx_ws_observed_prefixes
           CROSS JOIN workspace_paths a ON a.repo_id = wa.repo_id AND a.workspace_id = wa.id AND a.kind = 'observed' AND substr(a.path, -1) = '/'
           CROSS JOIN workspace_paths b ON b.repo_id = wa.repo_id AND b.kind = 'observed'
                AND b.path > a.path AND b.path < substr(a.path, 1, length(a.path) - 1) || '0' AND b.workspace_id != wa.id
           CROSS JOIN workspaces wb ON wb.id = b.workspace_id AND wb.repo_id = wa.repo_id AND wb.status = 'active' AND wb.base_ref = ?2
          WHERE wa.repo_id = ?1 AND wa.status = 'active' AND wa.base_ref = ?2 AND wa.observed_prefixes > 0
          ORDER BY b.path, wa.id, wb.id LIMIT ${INTENT_LIMITS.overlapPrefixHitMax + 1}`,
      )
      .bind(cx.repo.id, base),
    incompleteStatement(db, cx.repo.id, base, null),
    ...(semantic?.statements ?? []),
  ]);

  const reasons: string[] = [];
  // A count can include rows of a workspace that just left active in the same transaction as its cleanup; such a path is not shared.
  const groupRows = ((groups?.results as Array<{ path: string; ws: string | null }> | undefined) ?? [])
    .map((g) => ({ path: g.path, members: g.ws ? (JSON.parse(g.ws) as HeadTuple[]) : [] }))
    .filter((g) => g.members.length > 1);
  if (groupRows.length > INTENT_LIMITS.overlapGroupMax) {
    reasons.push(`more than ${INTENT_LIMITS.overlapGroupMax} shared paths; pairs beyond them are not reported`);
  }
  const prefixRows = (prefixHits?.results as Array<{ path: string; wa: string; wb: string }> | undefined) ?? [];
  if (prefixRows.length > INTENT_LIMITS.overlapPrefixHitMax) {
    reasons.push(`more than ${INTENT_LIMITS.overlapPrefixHitMax} paths below collapsed prefixes; pairs beyond them are not reported`);
  }
  const work = collectPairs(
    groupRows.slice(0, INTENT_LIMITS.overlapGroupMax).map((g) => ({ path: g.path, members: g.members.map(headOf) })),
    prefixRows.slice(0, INTENT_LIMITS.overlapPrefixHitMax).map((h) => ({
      path: h.path,
      a: headOf(JSON.parse(h.wa) as HeadTuple),
      b: headOf(JSON.parse(h.wb) as HeadTuple),
    })),
    (h) => h.workspace,
  );
  const pairs = work.pairs;
  reasons.push(...work.reasons);
  const incomplete = incompleteOf(incompleteRes);
  if (incomplete) reasons.push(incomplete.reason);

  const sorted = [...pairs.keys()].sort();
  const start = cursor === null ? 0 : sorted.findIndex((k) => k > cursor);
  const from = start < 0 ? sorted.length : start;
  const keys = sorted.slice(from, from + limit);
  const more = from + limit < sorted.length;
  if (more) reasons.unshift(`more than ${limit} pairs; follow nextCursor for the rest`);

  const out: OverlapResponse = {
    base,
    advisory: true,
    advisoryNote: ADVISORY_NOTE,
    pairs: keys.map((key) => {
      const p = pairs.get(key)!;
      const [a, b] = key.split(':') as [string, string];
      const all = [...p.paths].sort();
      const pair: OverlapPair = {
        workspaces: [a, b],
        matchKind: 'observed',
        paths: all.slice(0, INTENT_LIMITS.overlapPathsPerPair),
        pathCount: all.length,
        heads: [p.heads.get(a)!, p.heads.get(b)!],
      };
      if (all.length > INTENT_LIMITS.overlapPathsPerPair) pair.pathsTruncated = true;
      return pair;
    }),
    truncated: reasons.length > 0,
    nextCursor: more ? (keys[keys.length - 1] ?? null) : null,
    limit,
  };
  if (reasons.length > 0) out.truncatedReason = reasons.join('; ');
  if (incomplete) out.incomplete = incomplete.list;
  if (semantic) out.semantic = semantic.read(semanticRes);
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Overlap within an explicit workspace set (candidates and arenas)
// ---------------------------------------------------------------------------

export interface SetOverlapPair {
  /** Sorted workspace ids. */
  workspaces: [string, string];
  /** Shared observed paths (for a collapsed prefix, the other side's paths below it). */
  paths: string[];
  pathCount: number;
  pathsTruncated?: true;
}

export interface SetOverlap {
  /** Pairs of the set's active workspaces whose observed changes share paths, sorted. */
  pairs: SetOverlapPair[];
  /** Per member: the other members it overlaps and how many distinct paths it shares with them. */
  members: Map<string, { with: string[]; sharedPaths: number }>;
  truncated: boolean;
  truncatedReason?: string;
}

/**
 * The statements `setOverlap` reads, for the caller's batch: shared-path
 * groups and collapsed-prefix hits restricted to the given workspaces. Each
 * probes the per-workspace index, so rows read follow the members' own
 * index rows, never the repo's other workspaces.
 */
export function setOverlapStatements(db: D1Database, repoId: string, ids: readonly string[]): D1PreparedStatement[] {
  const members = JSON.stringify([...ids]);
  return [
    db
      .prepare(
        `SELECT p.path, json_group_array(p.workspace_id) AS ws
           FROM workspace_paths p
          WHERE p.repo_id = ?1 AND p.workspace_id IN (SELECT value FROM json_each(?2)) AND p.kind = 'observed'
          GROUP BY p.path HAVING COUNT(*) > 1 ORDER BY p.path LIMIT ${INTENT_LIMITS.overlapGroupMax + 1}`,
      )
      .bind(repoId, members),
    db
      .prepare(
        `SELECT b.path AS path, a.workspace_id AS a, b.workspace_id AS b
           FROM workspace_paths a
           JOIN workspace_paths b ON b.repo_id = a.repo_id AND b.workspace_id IN (SELECT value FROM json_each(?2)) AND b.kind = 'observed'
                AND b.workspace_id != a.workspace_id
                AND b.path > a.path AND b.path < substr(a.path, 1, length(a.path) - 1) || '0'
          WHERE a.repo_id = ?1 AND a.workspace_id IN (SELECT value FROM json_each(?2)) AND a.kind = 'observed' AND substr(a.path, -1) = '/'
          ORDER BY b.path, a.workspace_id, b.workspace_id LIMIT ${INTENT_LIMITS.overlapPrefixHitMax + 1}`,
      )
      .bind(repoId, members),
    db
      .prepare(
        `SELECT w.id AS workspace, ${INCOMPLETE_REASON} AS reason FROM workspaces w
          WHERE w.repo_id = ?1 AND w.id IN (SELECT value FROM json_each(?2)) AND w.status = 'active' AND ${INDEX_INCOMPLETE}
          ORDER BY w.id`,
      )
      .bind(repoId, members),
  ];
}

/** Pairs and per-member counts from the results of `setOverlapStatements`, in order. */
export function setOverlap(ids: readonly string[], results: readonly (D1Result | undefined)[]): SetOverlap {
  const reasons: string[] = [];
  const groups = (results[0]?.results as Array<{ path: string; ws: string }> | undefined) ?? [];
  if (groups.length > INTENT_LIMITS.overlapGroupMax) reasons.push(`more than ${INTENT_LIMITS.overlapGroupMax} shared paths; paths beyond them are not counted`);
  const hits = (results[1]?.results as Array<{ path: string; a: string; b: string }> | undefined) ?? [];
  if (hits.length > INTENT_LIMITS.overlapPrefixHitMax) {
    reasons.push(`more than ${INTENT_LIMITS.overlapPrefixHitMax} paths below collapsed prefixes; paths beyond them are not counted`);
  }
  const work = collectPairs(
    groups.slice(0, INTENT_LIMITS.overlapGroupMax).map((g) => ({ path: g.path, members: JSON.parse(g.ws) as string[] })),
    hits.slice(0, INTENT_LIMITS.overlapPrefixHitMax),
    (id) => id,
  );
  reasons.push(...work.reasons);
  const incomplete = ((results[2]?.results as IncompleteIndex[] | undefined) ?? []).map((r) => r.workspace);
  if (incomplete.length > 0) {
    reasons.push(`the observed index of ${incomplete.join(', ')} is incomplete (changed paths were omitted), so overlap with them may be under-reported`);
  }

  const shared = new Map<string, { with: Set<string>; paths: Set<string> }>(ids.map((id) => [id, { with: new Set(), paths: new Set() }]));
  const out: SetOverlapPair[] = [...work.pairs.keys()].sort().map((key) => {
    const [a, b] = key.split(':') as [string, string];
    const all = [...work.pairs.get(key)!.paths].sort();
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const m = shared.get(me);
      if (!m) continue;
      m.with.add(other);
      for (const p of all) m.paths.add(p);
    }
    const pair: SetOverlapPair = { workspaces: [a, b], paths: all.slice(0, INTENT_LIMITS.overlapPathsPerPair), pathCount: all.length };
    if (all.length > INTENT_LIMITS.overlapPathsPerPair) pair.pathsTruncated = true;
    return pair;
  });
  const members = new Map([...shared].map(([id, m]) => [id, { with: [...m.with].sort(), sharedPaths: m.paths.size }]));
  const result: SetOverlap = { pairs: out, members, truncated: reasons.length > 0 };
  if (reasons.length > 0) result.truncatedReason = reasons.join('; ');
  return result;
}
