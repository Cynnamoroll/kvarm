/**
 * Change requests (architecture §4 services/changes.ts, §5, invariant 5).
 *
 * A change is a row in `change_sets`: a head branch proposed for a base
 * branch, numbered per repo. Creation resolves both branches fresh (one
 * ls-refs round trip) and records the head SHA; push events move the head
 * afterwards (services/events.ts folds the guarded UPDATE into its ingest
 * batch, so a late older event never rolls the head back).
 *
 * The rating is the compare rating of the base tip's tree against the head
 * tree, served from the same tree-pair cache as `compare/<base>...<head>`.
 * Mergeability and merges go through services/merge.ts and the checks-gate
 * only; the contributor's merge policy decides when a merge may happen:
 * `draft` never, `review` on an explicit merge call, `auto` as soon as the
 * change is mergeable and every required check passed (immediately while
 * the gate has no producers).
 */

import type { MergeConflict } from '@forge/gitops';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { internalKey, readCachedJson, writeCachedJson } from '../cache/internal';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { credentialMayUpdateRef, type Actor } from './authz';
import { effectivePolicy, ruleFromRow, type BranchPolicy, type BranchRule, type BranchRuleRow } from './branchRules';
import { defaultChecksGate, type ChecksGate, type RequiredChecks } from './checksGate';
import { treePairRating } from './compare';
import { artifactsPusher, type GitPusher } from './gitwrite';
import { changeSignalCleanup } from './intents/store';
import {
  artifactsMergeSources,
  computeMergeability,
  prepareMerge,
  publishMerge,
  type Mergeability,
  type MergeErrorCode,
  type MergeStatus,
  type MergeWork,
} from './merge';
import { RefStoreUnavailable, isValidRefName, lsRefs, resolveCommitish, type ResolveContext } from './refs';
import type { ChangeRating } from './risk';

export const MERGE_POLICIES = ['auto', 'draft', 'review'] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];
export type ChangeState = 'open' | 'merged' | 'conflicted' | 'closed';
const LIST_STATES = ['open', 'closed', 'merged', 'conflicted', 'all'] as const;

export const CHANGE_LIMITS = {
  titleMax: 256,
  bodyMax: 65_536,
  pageDefault: 50,
  pageMax: 100,
  /** Check runs returned with a change; the query is bounded so detail cost stays constant. */
  checksMax: 100,
  /** Conflicts listed in a mergeability view. */
  conflictsMax: 100,
};

const ZERO_SHA = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// Rows and views
// ---------------------------------------------------------------------------

export interface ChangeRow {
  id: string;
  repo_id: string;
  number: number;
  title: string;
  body: string | null;
  base_ref: string;
  head_ref: string;
  head_sha: string | null;
  base_sha: string | null;
  state: ChangeState;
  author_id: string | null;
  author_login: string | null;
  agent_meta: string | null;
  merge_commit: string | null;
  merged_at: number | null;
  created_at: number;
  updated_at: number | null;
  merge_policy: MergePolicy;
  risk_score: number | null;
  risk_level: string | null;
  risk_reasons: string | null;
  kind: string;
  source_change_id: string | null;
  queue_state: string | null;
}

const CHANGE_SELECT = `SELECT c.id, c.repo_id, c.number, c.title, c.body, c.base_ref, c.head_ref, c.head_sha, c.base_sha,
       c.state, c.author_id, u.login AS author_login, c.agent_meta, c.merge_commit, c.merged_at, c.created_at,
       c.updated_at, c.merge_policy, c.risk_score, c.risk_level, c.risk_reasons, c.kind, c.source_change_id, c.queue_state
  FROM change_sets c LEFT JOIN users u ON u.id = c.author_id`;

export interface CheckRunView {
  id: string;
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface CheckRunRow {
  id: string;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
}

export interface ChangeView {
  number: number;
  title: string;
  body: string | null;
  state: ChangeState;
  mergePolicy: MergePolicy;
  kind: string;
  base: string;
  head: string;
  baseSha: string | null;
  headSha: string | null;
  author: string | null;
  agent: { id: string; name: string } | null;
  mergeCommit: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MergeabilityView {
  status: MergeStatus;
  /** Fast-forward or clean, and every required check passed. */
  mergeable: boolean;
  fastForward: boolean;
  conflicts: Array<Pick<MergeConflict, 'path' | 'kind'>>;
  conflictsTruncated?: true;
  targetSha: string;
  headSha: string;
  mergeBase: string | null;
  treeSha: string | null;
  unknownReason?: string;
  checks: RequiredChecks | null;
}

export interface ChangeDetail extends ChangeView {
  rating: ChangeRating | null;
  mergeability: MergeabilityView | null;
  checks: CheckRunView[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function parseAgent(meta: string | null): { id: string; name: string } | null {
  if (!meta) return null;
  try {
    const v = JSON.parse(meta) as { agentId?: unknown; agentName?: unknown };
    return typeof v.agentId === 'string' && typeof v.agentName === 'string' ? { id: v.agentId, name: v.agentName } : null;
  } catch {
    return null;
  }
}

export function changeView(row: ChangeRow): ChangeView {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    mergePolicy: row.merge_policy,
    kind: row.kind,
    base: row.base_ref,
    head: row.head_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    author: row.author_login,
    agent: parseAgent(row.agent_meta),
    mergeCommit: row.merge_commit,
    mergedAt: iso(row.merged_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at ?? row.created_at)!,
  };
}

function storedRating(row: ChangeRow): ChangeRating | null {
  if (row.risk_score === null || row.risk_level === null) return null;
  let reasons: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.risk_reasons ?? '[]');
    if (Array.isArray(parsed)) reasons = parsed.filter((r): r is string => typeof r === 'string');
  } catch {
    // stored reasons are informational
  }
  return { score: row.risk_score, level: row.risk_level as ChangeRating['level'], reasons };
}

function checkRunView(r: CheckRunRow): CheckRunView {
  return {
    id: r.id,
    name: r.name,
    headSha: r.head_sha,
    status: r.status,
    conclusion: r.conclusion,
    detailsUrl: r.details_url,
    startedAt: iso(r.started_at),
    finishedAt: iso(r.finished_at),
    createdAt: iso(r.created_at)!,
  };
}

function mergeabilityView(m: Mergeability): MergeabilityView {
  const conflicts = m.conflicts.slice(0, CHANGE_LIMITS.conflictsMax).map((c) => ({ path: c.path, kind: c.kind }));
  return {
    status: m.status,
    mergeable: m.mergeable,
    fastForward: m.fastForward,
    conflicts,
    ...(m.conflicts.length > conflicts.length ? { conflictsTruncated: true as const } : {}),
    targetSha: m.targetSha,
    headSha: m.headSha,
    mergeBase: m.mergeBase,
    treeSha: m.treeSha,
    ...(m.unknownReason !== undefined ? { unknownReason: m.unknownReason } : {}),
    checks: m.checks,
  };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ChangeContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  /** The repo's branch rules, when the caller read them in its authority batch. */
  branchRules?: BranchRule[];
  waitUntil(p: Promise<unknown>): void;
}

type Fail = Extract<ServiceResult<never>, { ok: false }> & {
  conflicts?: Array<Pick<MergeConflict, 'path' | 'kind'>>;
  checks?: RequiredChecks;
  ref?: string;
};

function fail(status: number, error: string, code: string, extra: Partial<Fail> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

function resolveCtx(cx: Pick<ChangeContext, 'env' | 'repo' | 'waitUntil'>, artifacts: LazyRepo): ResolveContext {
  return { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ changesRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/** A branch name as given (`main`) or as a full branch ref (`refs/heads/main`); null otherwise. */
export function normalizeBranch(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const name = raw.startsWith('refs/heads/') ? raw.slice('refs/heads/'.length) : raw;
  if (name.startsWith('refs/') || name === 'HEAD' || !isValidRefName(name)) return null;
  return name;
}

const branchRef = (name: string) => `refs/heads/${name}`;

function isPolicy(v: unknown): v is MergePolicy {
  return typeof v === 'string' && (MERGE_POLICIES as readonly string[]).includes(v);
}

function validTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 && t.length <= CHANGE_LIMITS.titleMax ? t : null;
}

function validBody(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || v.length > CHANGE_LIMITS.bodyMax) return undefined;
  return v;
}

function parseNumber(raw: string): number | null {
  return /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function changeSelect(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db.prepare(`${CHANGE_SELECT} WHERE c.repo_id = ? AND c.number = ?`).bind(repoId, number);
}

async function readChange(env: Env, repoId: string, number: number): Promise<ChangeRow | null> {
  return changeSelect(env.DB, repoId, number).first<ChangeRow>();
}

/** One batch: the change and its newest check runs (bounded), so the cost is the same for any number of runs. */
async function readChangeWithChecks(env: Env, repoId: string, number: number): Promise<{ row: ChangeRow; checks: CheckRunView[] } | null> {
  const [change, checks] = await env.DB.batch([
    changeSelect(env.DB, repoId, number),
    env.DB.prepare(
      `SELECT k.id, k.name, k.head_sha, k.status, k.conclusion, k.details_url, k.started_at, k.finished_at, k.created_at
         FROM check_runs k
        WHERE k.change_set_id = (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)
        ORDER BY k.created_at DESC, k.id DESC
        LIMIT ${CHANGE_LIMITS.checksMax}`,
    ).bind(repoId, number),
  ]);
  const row = (change?.results as ChangeRow[] | undefined)?.[0];
  if (!row) return null;
  return { row, checks: ((checks?.results as CheckRunRow[] | undefined) ?? []).map(checkRunView) };
}

export interface ChangePage {
  changes: ChangeView[];
  nextCursor: string | null;
}

/** GET changes?state=&limit=&cursor= — newest first; one bounded indexed query. */
export async function listChanges(
  env: Env,
  repo: RepoRow,
  q: { state?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<ChangePage>> {
  const state = q.state ?? 'open';
  if (!(LIST_STATES as readonly string[]).includes(state)) {
    return fail(400, `state must be one of ${LIST_STATES.join(', ')}`, 'INVALID_STATE');
  }
  let limit = CHANGE_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    if (!/^\d+$/.test(q.limit) || Number(q.limit) < 1 || Number(q.limit) > CHANGE_LIMITS.pageMax) {
      return fail(400, `limit must be an integer from 1 to ${CHANGE_LIMITS.pageMax}`, 'INVALID_LIMIT');
    }
    limit = Number(q.limit);
  }
  let before = Number.MAX_SAFE_INTEGER;
  if (q.cursor !== undefined) {
    const n = parseNumber(q.cursor);
    if (n === null) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    before = n;
  }
  const where = state === 'all' ? 'c.repo_id = ?1 AND c.number < ?2' : 'c.repo_id = ?1 AND c.state = ?3 AND c.number < ?2';
  const stmt = env.DB.prepare(`${CHANGE_SELECT} WHERE ${where} ORDER BY c.number DESC LIMIT ${limit + 1}`);
  const { results } = await (state === 'all' ? stmt.bind(repo.id, before) : stmt.bind(repo.id, before, state)).all<ChangeRow>();
  const rows = results ?? [];
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: { changes: page.map(changeView), nextCursor: rows.length > limit ? String(page[page.length - 1]!.number) : null },
  };
}

// ---------------------------------------------------------------------------
// Mergeability
// ---------------------------------------------------------------------------

type CachedPlan = Omit<Mergeability, 'checks' | 'mergeable'>;

/** Outcomes that depend only on the two commits (never transient read failures). */
function cacheablePlan(m: Mergeability): boolean {
  return m.status !== 'unknown' || m.unknownReason === 'criss-cross' || (m.unknownReason?.startsWith('max') ?? false) || m.unknownReason === 'diffBudget';
}

/**
 * Mergeability of head into the target: the merge plan for a commit pair is
 * immutable, so it is cached per repo and pair; required checks always come
 * fresh from the checks-gate.
 */
async function mergeabilityFor(ctx: ResolveContext, gate: ChecksGate, targetSha: string, headSha: string): Promise<Mergeability> {
  const key = internalKey('mergeplan/v1', ctx.repo.id, targetSha, headSha);
  const hit = await readCachedJson<CachedPlan>(key);
  if (hit) {
    const checks = hit.treeSha ? await gate.requiredChecksFor({ id: ctx.repo.id }, hit.treeSha, null) : null;
    const mergeable = (hit.status === 'fast-forward' || hit.status === 'clean') && checks?.state === 'success';
    return { ...hit, checks, mergeable };
  }
  const m = await computeMergeability(artifactsMergeSources(ctx), gate, { repo: { id: ctx.repo.id }, targetSha, headSha });
  if (cacheablePlan(m)) {
    const { checks: _checks, mergeable: _mergeable, ...plan } = m;
    ctx.waitUntil(writeCachedJson(key, plan, 31_536_000));
  }
  return m;
}

/** Live base tip and head trees, the compare rating and mergeability for an open change. */
async function liveState(
  ctx: ResolveContext,
  gate: ChecksGate,
  row: ChangeRow,
): Promise<ServiceResult<{ rating: ChangeRating | null; mergeability: MergeabilityView | null; baseSha: string | null }>> {
  if (!row.head_sha) return { ok: true, value: { rating: null, mergeability: null, baseSha: null } };
  const baseName = branchRef(row.base_ref);
  const resolved = await resolveCommitish(ctx, [baseName, row.head_sha]);
  const base = resolved.get(baseName) ?? null;
  const head = resolved.get(row.head_sha) ?? null;
  if (!base || !head) return { ok: true, value: { rating: null, mergeability: null, baseSha: base?.sha ?? null } };
  const [rating, m] = await Promise.all([treePairRating(ctx, base.tree, head.tree), mergeabilityFor(ctx, gate, base.sha, head.sha)]);
  return { ok: true, value: { rating, mergeability: mergeabilityView(m), baseSha: base.sha } };
}

function isLive(row: ChangeRow): boolean {
  return row.state === 'open' || row.state === 'conflicted';
}

/** GET changes/:number — the change, its rating and mergeability (open changes) and check runs. */
export function getChange(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<ChangeDetail>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const found = await readChangeWithChecks(cx.env, cx.repo.id, number);
    if (!found) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const { row, checks } = found;
    const view = changeView(row);
    if (!isLive(row)) return { ok: true, value: { ...view, rating: storedRating(row), mergeability: null, checks } };
    return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const live = await liveState(resolveCtx(cx, artifacts), defaultChecksGate(cx.env), row);
      if (!live.ok) return live;
      return {
        ok: true,
        value: { ...view, baseSha: live.value.baseSha ?? view.baseSha, rating: live.value.rating, mergeability: live.value.mergeability, checks },
      };
    });
  });
}

/** GET changes/:number/mergeability */
export interface MergeabilityResponse {
  number: number;
  state: ChangeState;
  mergeability: MergeabilityView | null;
}

export function getMergeability(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<MergeabilityResponse>> {
  return guarded<MergeabilityResponse>(async () => {
    const number = parseNumber(rawNumber);
    const row = number === null ? null : await readChange(cx.env, cx.repo.id, number);
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (!isLive(row) || !row.head_sha) return { ok: true, value: { number: row.number, state: row.state, mergeability: null } };
    return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const baseName = branchRef(row.base_ref);
      const resolved = await resolveCommitish(ctx, [baseName]);
      const base = resolved.get(baseName);
      if (!base) return fail(409, `base branch ${row.base_ref} no longer exists`, 'BASE_NOT_FOUND');
      const m = await mergeabilityFor(ctx, defaultChecksGate(cx.env), base.sha, row.head_sha!);
      return { ok: true, value: { number: row.number, state: row.state, mergeability: mergeabilityView(m) } };
    });
  });
}

/** GET changes/:number/checks — the change's check runs, newest first (bounded). */
export async function listChangeChecks(env: Env, repo: RepoRow, rawNumber: string): Promise<ServiceResult<{ number: number; headSha: string | null; checks: CheckRunView[] }>> {
  const number = parseNumber(rawNumber);
  const found = number === null ? null : await readChangeWithChecks(env, repo.id, number);
  if (!found) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  return { ok: true, value: { number: found.row.number, headSha: found.row.head_sha, checks: found.checks } };
}

// ---------------------------------------------------------------------------
// Create and update
// ---------------------------------------------------------------------------

interface CreateInput {
  title: string;
  body: string | null;
  base: string;
  head: string;
  mergePolicy: MergePolicy;
}

function parseCreate(input: unknown): ServiceResult<CreateInput> {
  const b = (input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const title = validTitle(b.title);
  if (title === null) return fail(422, `title is required (1-${CHANGE_LIMITS.titleMax} characters)`, 'INVALID_TITLE');
  const body = b.body === undefined ? null : validBody(b.body);
  if (body === undefined) return fail(422, `body must be a string of at most ${CHANGE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
  const base = normalizeBranch(b.base);
  if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  const head = normalizeBranch(b.head);
  if (head === null) return fail(422, 'head must be a branch name', 'INVALID_REF');
  if (base === head) return fail(422, 'base and head must be different branches', 'SAME_REF');
  const mergePolicy = b.mergePolicy === undefined ? 'review' : b.mergePolicy;
  if (!isPolicy(mergePolicy)) return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
  return { ok: true, value: { title, body, base, head, mergePolicy } };
}

/**
 * POST changes. Both branches are resolved fresh before anything is written;
 * a missing branch or base == head writes nothing. Numbering and the read-back
 * are one D1 batch: the number is MAX+1 inside the INSERT, and
 * UNIQUE(repo_id, number) guards concurrent creates.
 */
export function createChange(cx: ChangeContext, input: unknown): Promise<ServiceResult<ChangeDetail>> {
  return guarded(async () => {
    const parsed = parseCreate(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const denied = agentMergeDenial(cx.actor, p.base, p.mergePolicy);
    if (denied) return denied;
    // Push events at or after this instant are newer than the head ls-refs reports.
    const observedAt = Date.now() - 1;
    const resolved = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const tips = await lsRefs(ctx, [branchRef(p.base), branchRef(p.head)]);
      const baseSha = tips.get(branchRef(p.base)) ?? null;
      const headSha = tips.get(branchRef(p.head)) ?? null;
      if (!baseSha) return fail(422, `base branch not found: ${p.base}`, 'REF_NOT_FOUND', { ref: p.base });
      if (!headSha) return fail(422, `head branch not found: ${p.head}`, 'REF_NOT_FOUND', { ref: p.head });
      const commits = await resolveCommitish(ctx, [baseSha, headSha]);
      const base = commits.get(baseSha);
      const head = commits.get(headSha);
      if (!base || !head) return fail(503, 'branch commits could not be read, retry shortly', 'STORAGE_UNAVAILABLE');
      const rating = await treePairRating(ctx, base.tree, head.tree);
      return { ok: true as const, value: { baseSha, headSha, rating } };
    });
    if (!resolved.ok) return resolved;
    const { baseSha, headSha, rating } = resolved.value;

    const now = Date.now();
    const id = crypto.randomUUID();
    const agentMeta = cx.actor?.agent ? JSON.stringify({ agentId: cx.actor.agent.agentId, agentName: cx.actor.agent.agentName }) : null;
    // The head watermark is tied to the ref position: a push ingested since the
    // observation (newer event) is adopted outright; the push that produced the
    // observed head lends its event time; otherwise the observation time, so a
    // push racing this create and delivered later is still newer.
    const newerPush = `f.repo_id = ?2 AND f.ref = ?16 AND f.event_at > ?17 AND f.sha != '${ZERO_SHA}'`;
    const [, read] = await cx.env.DB.batch([
      cx.env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, body, base_ref, head_ref, head_sha, base_sha, state, author_id,
           agent_meta, merge_policy, risk_score, risk_level, risk_reasons, kind, created_at, updated_at, head_event_at)
         SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6,
                COALESCE((SELECT f.sha FROM repo_refs f WHERE ${newerPush}), ?7),
                ?8, 'open', ?9, ?10, ?11, ?12, ?13, ?14, 'change', ?15, ?15,
                COALESCE((SELECT f.event_at FROM repo_refs f WHERE (${newerPush}) OR (f.repo_id = ?2 AND f.ref = ?16 AND f.sha = ?7)), ?17)
           FROM change_sets WHERE repo_id = ?2`,
      ).bind(
        id,
        cx.repo.id,
        p.title,
        p.body,
        p.base,
        p.head,
        headSha,
        baseSha,
        cx.actor?.user.id ?? null,
        agentMeta,
        p.mergePolicy,
        rating.score,
        rating.level,
        JSON.stringify(rating.reasons),
        now,
        branchRef(p.head),
        observedAt,
      ),
      cx.env.DB.prepare(`${CHANGE_SELECT} WHERE c.id = ?`).bind(id),
    ]);
    let row = (read?.results as ChangeRow[] | undefined)?.[0];
    if (!row) return fail(500, 'change could not be created', 'CREATE_FAILED');
    if (row.merge_policy === 'auto') row = (await autoMerge(cx, row)) ?? row;
    return { ok: true, value: { ...changeView(row), rating: isLive(row) ? rating : storedRating(row), mergeability: null, checks: [] } };
  });
}

interface Patch {
  title?: string;
  body?: string | null;
  mergePolicy?: MergePolicy;
  state?: 'open' | 'closed';
}

function parsePatch(input: unknown): ServiceResult<Patch> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const b = input as Record<string, unknown>;
  const out: Patch = {};
  if (b.title !== undefined) {
    const t = validTitle(b.title);
    if (t === null) return fail(422, `title must be 1-${CHANGE_LIMITS.titleMax} characters`, 'INVALID_TITLE');
    out.title = t;
  }
  if (b.body !== undefined) {
    const body = validBody(b.body);
    if (body === undefined) return fail(422, `body must be a string of at most ${CHANGE_LIMITS.bodyMax} characters`, 'INVALID_BODY');
    out.body = body;
  }
  if (b.mergePolicy !== undefined) {
    if (!isPolicy(b.mergePolicy)) return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
    out.mergePolicy = b.mergePolicy;
  }
  if (b.state !== undefined) {
    if (b.state !== 'open' && b.state !== 'closed') return fail(422, 'state must be "open" or "closed"', 'INVALID_STATE');
    out.state = b.state;
  }
  if (Object.keys(out).length === 0) return fail(422, 'nothing to update: pass title, body, mergePolicy or state', 'EMPTY_PATCH');
  return { ok: true, value: out };
}

/**
 * PATCH changes/:number. One batch: a guarded UPDATE that never touches a
 * merged change, then the read-back. Changing the policy to `auto` (or
 * reopening an `auto` change) merges it right away when it is mergeable;
 * an agent token must be allowed to update the base for either.
 */
export function updateChange(cx: ChangeContext, rawNumber: string, input: unknown): Promise<ServiceResult<ChangeView>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const parsed = parsePatch(input);
    if (!parsed.ok) return parsed;
    const p = parsed.value;
    const sets: string[] = [];
    const args: unknown[] = [];
    const set = (col: string, v: unknown) => {
      args.push(v);
      sets.push(`${col} = ?${args.length + 2}`);
    };
    if (p.title !== undefined) set('title', p.title);
    if (p.body !== undefined) set('body', p.body);
    if (cx.actor?.agent && (p.mergePolicy === 'auto' || p.state === 'open')) {
      // Setting auto or reopening an auto change publishes to the base: the agent's ref ceiling applies.
      const current = await readChange(cx.env, cx.repo.id, number);
      if (!current) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
      if ((p.mergePolicy ?? current.merge_policy) === 'auto' && (p.state ?? current.state) === 'open') {
        const denied = agentMergeDenial(cx.actor, current.base_ref, p.mergePolicy === 'auto' ? 'auto' : 'merge');
        if (denied) return denied;
      }
    }
    if (p.mergePolicy !== undefined) set('merge_policy', p.mergePolicy);
    if (p.state !== undefined) set('state', p.state);
    set('updated_at', Date.now());
    const [, read] = await cx.env.DB.batch([
      cx.env.DB.prepare(`UPDATE change_sets SET ${sets.join(', ')} WHERE repo_id = ?1 AND number = ?2 AND state != 'merged'`).bind(
        cx.repo.id,
        number,
        ...args,
      ),
      changeSelect(cx.env.DB, cx.repo.id, number),
    ]);
    let row = (read?.results as ChangeRow[] | undefined)?.[0];
    if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    if (row.state === 'merged') return fail(409, 'a merged change cannot be updated', 'CHANGE_MERGED');
    if (row.merge_policy === 'auto' && row.state === 'open') row = (await autoMerge(cx, row)) ?? row;
    return { ok: true, value: changeView(row) };
  });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export interface MergeOutcome {
  change: ChangeView;
  merge: { kind: 'fast-forward' | 'merge'; mergeCommit: string; treeSha: string; previous: string; work: MergeWork };
}

/** The gate's answer per tree, asked once per merge attempt. */
function memoGate(inner: ChecksGate): ChecksGate {
  const seen = new Map<string, Promise<RequiredChecks>>();
  return {
    requiredChecksFor(repo, treeSha, configId) {
      const k = `${repo.id}:${treeSha}:${configId ?? ''}`;
      let p = seen.get(k);
      if (!p) {
        p = inner.requiredChecksFor(repo, treeSha, configId);
        seen.set(k, p);
      }
      return p;
    },
  };
}

/** Branch-rule requirements on the target ref that the checks-gate answer does not satisfy. */
function branchPolicyBlock(policy: BranchPolicy, checks: RequiredChecks): Fail | null {
  if (policy.requiredApprovals > 0) {
    return fail(
      409,
      `${policy.ref} requires ${policy.requiredApprovals} approving review(s) before a merge`,
      'APPROVALS_REQUIRED',
    );
  }
  for (const name of policy.requiredChecks) {
    const found = checks.required.find((c) => c.name === name);
    if (found?.state === 'failure') {
      return fail(409, `required check ${name} failed`, 'REQUIRED_CHECKS_FAILED', { checks });
    }
    if (found?.state !== 'success') {
      return fail(409, `required check ${name} has not passed on the merge result`, 'REQUIRED_CHECKS_PENDING', { checks });
    }
  }
  return null;
}

export interface MergeDeps {
  pusher(env: Env, repo: RepoRow): GitPusher;
  gate(env: Env): ChecksGate;
}

export const defaultMergeDeps: MergeDeps = {
  pusher: (env, repo) => artifactsPusher(env, repo),
  gate: (env) => defaultChecksGate(env),
};

const RETRYABLE: ReadonlySet<MergeErrorCode | string> = new Set(['STALE_TARGET']);

/** `explicit`: a merge call (review or auto policy). `auto`: the auto policy acting on its own. */
type MergeMode = 'explicit' | 'auto';

/** Why the change, as it is now, may not be merged at `headSha` (null: it may). */
function mergeRefusal(row: ChangeRow | null, mode: MergeMode, headSha?: string): Fail | null {
  if (!row) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  if (row.state === 'merged') return fail(409, 'the change is already merged', 'ALREADY_MERGED');
  if (row.state === 'closed') return fail(409, 'a closed change cannot be merged; reopen it first', 'CHANGE_CLOSED');
  if (row.merge_policy === 'draft') {
    return fail(409, 'the change is a draft (mergePolicy draft) and never merges; set mergePolicy to review or auto', 'DRAFT');
  }
  if (mode === 'auto' && (row.merge_policy !== 'auto' || row.state !== 'open')) {
    return fail(409, 'the change no longer has mergePolicy auto', 'NOT_AUTO');
  }
  if (headSha !== undefined && row.head_sha !== headSha) {
    return fail(409, "the change's head moved while the merge was prepared; merge again to merge the new head", 'HEAD_MOVED');
  }
  return null;
}

/**
 * Merges an open change's recorded head into its base branch: plan against
 * the base tip read fresh, check branch rules against the checks-gate answer
 * for the exact merge tree, prepare the push (write token and pack), re-read
 * the change immediately before sending (state, policy and head must still
 * allow this merge), publish one ref with the tip as expected old value,
 * then mark the change merged only while its head is still the published
 * one and it is not a draft. A moved base re-plans once. A change edited
 * between that last read and the send is not caught here; the guarded
 * merged write then refuses to record it.
 */
async function performMerge(
  cx: ChangeContext,
  row: ChangeRow,
  author: { name: string; email: string } | undefined,
  deps: MergeDeps,
  mode: MergeMode,
): Promise<ServiceResult<MergeOutcome>> {
  if (!row.head_sha) return fail(409, 'the change has no head commit', 'NO_HEAD');
  const headSha = row.head_sha;
  const targetRef = branchRef(row.base_ref);
  const policy = effectivePolicy(cx.branchRules ?? [], targetRef);
  const gate = memoGate(deps.gate(cx.env));
  const pusher = deps.pusher(cx.env, cx.repo);

  return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
    const ctx = resolveCtx(cx, artifacts);
    const sources = artifactsMergeSources(ctx);
    let last: Fail | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const targetSha = (await lsRefs(ctx, [targetRef])).get(targetRef) ?? null;
      if (!targetSha) return fail(409, `base branch ${row.base_ref} no longer exists`, 'BASE_NOT_FOUND');
      const prepared = await prepareMerge(sources, {
        targetSha,
        headSha,
        message: `Merge change #${row.number} from ${row.head_ref}\n\n${row.title}\n`,
        ...(author ? { author } : {}),
      });
      if (!prepared.ok) {
        return fail(prepared.status, prepared.error, prepared.code, prepared.conflicts ? { conflicts: prepared.conflicts.map((c) => ({ path: c.path, kind: c.kind })) } : {});
      }
      const checks = await gate.requiredChecksFor({ id: cx.repo.id }, prepared.value.treeSha, null);
      const blocked = branchPolicyBlock(policy, checks);
      if (blocked) return blocked;
      // The last change read runs after every asynchronous preparation step (checks, write token, pack).
      const verdict: { refusal: Fail | null } = { refusal: null };
      const beforeSend = async () => {
        verdict.refusal = mergeRefusal(await readChange(cx.env, cx.repo.id, row.number), mode, headSha);
        return verdict.refusal === null;
      };
      const published = await publishMerge({ pusher, gate, beforeSend }, { repo: { id: cx.repo.id }, ref: targetRef }, prepared.value);
      if (verdict.refusal) return verdict.refusal;
      let ok = published.ok;
      if (!published.ok && published.code === 'PUBLISH_UNKNOWN') {
        // The update may have landed: the ref decides.
        const now = (await lsRefs(ctx, [targetRef]).catch(() => new Map<string, string | null>())).get(targetRef);
        ok = now === prepared.value.mergeCommit;
      }
      if (!ok && !published.ok) {
        last = fail(published.status, published.error, published.code, published.checks ? { checks: published.checks } : {});
        if (RETRYABLE.has(published.code)) continue;
        return last;
      }
      const pv = prepared.value;
      const mergedAt = Date.now();
      const [update, , , read] = await cx.env.DB.batch([
        cx.env.DB.prepare(
          `UPDATE change_sets SET state = 'merged', merge_commit = ?3, merged_at = ?4, updated_at = ?4, base_sha = ?5
            WHERE repo_id = ?1 AND number = ?2 AND state IN ('open', 'conflicted') AND head_sha = ?6 AND merge_policy != 'draft'`,
        ).bind(cx.repo.id, row.number, pv.mergeCommit, mergedAt, pv.targetSha, headSha),
        // The workspace the change was opened from (services/workspaces.ts) follows it, only when the guarded write above landed.
        cx.env.DB.prepare(
          `UPDATE workspaces SET status = 'merged', merged_at = ?3, updated_at = ?3, head_sha = ?4
            WHERE repo_id = ?1 AND change_set_id = ?2 AND status = 'active'
              AND EXISTS (SELECT 1 FROM change_sets c WHERE c.id = ?2 AND c.state = 'merged' AND c.merge_commit = ?5 AND c.merged_at = ?3)`,
        ).bind(cx.repo.id, row.id, mergedAt, headSha, pv.mergeCommit),
        changeSignalCleanup(cx.env.DB, cx.repo.id, row.id),
        changeSelect(cx.env.DB, cx.repo.id, row.number),
      ]);
      if (!update?.meta.changes) {
        console.warn(JSON.stringify({ mergeNotRecorded: { repo: cx.repo.id, number: row.number, mergeCommit: pv.mergeCommit, headSha } }));
        return fail(
          409,
          `the change was updated while it merged (head, policy or state); ${targetRef} now points at ${pv.mergeCommit}, which merged head ${headSha}, and the change was not marked merged`,
          'CHANGE_UPDATED_DURING_MERGE',
        );
      }
      const merged = (read?.results as ChangeRow[] | undefined)?.[0] ?? row;
      return {
        ok: true,
        value: {
          change: changeView(merged),
          merge: { kind: pv.kind, mergeCommit: pv.mergeCommit, treeSha: pv.treeSha, previous: pv.targetSha, work: pv.work },
        },
      };
    }
    return last ?? fail(409, 'the base branch kept moving, retry', 'STALE_TARGET');
  });
}

/**
 * A merge moves the base branch, so an agent token may merge, or opt a
 * change into `auto`, only when its ref patterns allow updating that branch.
 */
function agentMergeDenial(actor: Actor | null, base: string, what: MergePolicy | 'merge'): Fail | null {
  if (!actor?.agent || (what !== 'merge' && what !== 'auto')) return null;
  if (credentialMayUpdateRef(actor, branchRef(base))) return null;
  const action = what === 'merge' ? 'merge into' : 'set mergePolicy auto on a change into';
  return fail(403, `this agent token may not ${action} ${branchRef(base)}`, 'AGENT_REF_FORBIDDEN');
}

export function mergeAuthor(actor: Actor | null): { name: string; email: string } | undefined {
  if (!actor) return undefined;
  if (actor.agent) return { name: actor.agent.agentName, email: `${actor.agent.agentId}@agents.forge.invalid` };
  return { name: actor.user.name ?? actor.user.login, email: actor.user.email };
}

/** POST changes/:number/merge — explicit merge; refused for drafts, closed and merged changes. */
export function mergeChange(cx: ChangeContext, rawNumber: string, deps: MergeDeps = defaultMergeDeps): Promise<ServiceResult<MergeOutcome>> {
  return guarded(async () => {
    const number = parseNumber(rawNumber);
    const row = number === null ? null : await readChange(cx.env, cx.repo.id, number);
    const refused = mergeRefusal(row, 'explicit');
    if (refused || !row) return refused ?? fail(404, 'change not found', 'CHANGE_NOT_FOUND');
    const denied = agentMergeDenial(cx.actor, row.base_ref, 'merge');
    if (denied) return denied;
    return performMerge(cx, row, mergeAuthor(cx.actor), deps, 'explicit');
  });
}

/**
 * Merges an open `auto` change when it is mergeable now. Returns the merged
 * row, or null when it stays open (not mergeable yet, checks pending or
 * failed, conflicts, or a caller's agent token that may not update the
 * base); a refusal is logged, never an error for the caller.
 */
export async function autoMerge(cx: ChangeContext, row: ChangeRow, deps: MergeDeps = defaultMergeDeps): Promise<ChangeRow | null> {
  if (row.merge_policy !== 'auto' || row.state !== 'open') return null;
  if (agentMergeDenial(cx.actor, row.base_ref, 'merge')) {
    console.log(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, ok: false, code: 'AGENT_REF_FORBIDDEN' } }));
    return null;
  }
  let r: ServiceResult<MergeOutcome>;
  try {
    r = await guarded(() => performMerge(cx, row, undefined, deps, 'auto'));
  } catch (err) {
    console.warn(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, error: String(err).slice(0, 200) } }));
    return null;
  }
  console.log(JSON.stringify({ autoMerge: { repo: cx.repo.id, number: row.number, ok: r.ok, ...(r.ok ? {} : { code: r.code }) } }));
  if (!r.ok) return null;
  return (await readChange(cx.env, cx.repo.id, row.number)) ?? null;
}

// ---------------------------------------------------------------------------
// Push hooks (services/events.ts)
// ---------------------------------------------------------------------------

/** An open change whose head branch an event touched, as read back by the ingest batch. */
export interface ChangeOnRef {
  id: string;
  number: number;
  policy: MergePolicy;
  headSha: string | null;
}

export interface HeadMoved {
  env: Env;
  repoId: string;
  change: ChangeOnRef;
  headSha: string;
}

/**
 * Runs for every open change whose head moved to a pushed commit. Review
 * approvals and check producers register here to stale approvals and start
 * checks for the new head identity; none are registered yet.
 */
export type HeadMovedHook = (e: HeadMoved) => Promise<void>;
export const HEAD_MOVED_HOOKS: HeadMovedHook[] = [];

async function repoWithRules(env: Env, repoId: string): Promise<{ repo: RepoRow; rules: BranchRule[] } | null> {
  const [repo, rules] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repoId),
    env.DB.prepare(
      `SELECT b.id, b.pattern, b.required_checks, b.required_approvals, b.created_at, b.updated_at
         FROM branch_rules b WHERE b.repo_id = ? LIMIT 50`,
    ).bind(repoId),
  ]);
  const row = (repo?.results as RepoRow[] | undefined)?.[0];
  if (!row) return null;
  return { repo: row, rules: ((rules?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow) };
}

/** Open `auto` changes attempted per mergeReadyAutoChanges call. */
export const AUTO_MERGE_PAGE = 20;

export interface AutoMergePass {
  merged: number[];
  /** Pass as `after` to continue with the changes numbered above it; null when none remain. */
  next: number | null;
}

/**
 * Attempts the merge of the open `auto` changes in the repo, or only the
 * given numbers, in number order and at most AUTO_MERGE_PAGE per call. The
 * checks-gate producers call this when a check run completes; push
 * processing calls it when an `auto` change's head moves.
 */
export async function mergeReadyAutoChanges(
  env: Env,
  repoId: string,
  numbers: number[] | null,
  waitUntil: (p: Promise<unknown>) => void,
  opts: { after?: number; deps?: MergeDeps } = {},
): Promise<AutoMergePass> {
  const ctxRows = await repoWithRules(env, repoId);
  if (!ctxRows) return { merged: [], next: null };
  const after = opts.after ?? 0;
  const where = `c.repo_id = ?1 AND c.state = 'open' AND c.merge_policy = 'auto' AND c.number > ?2`;
  const page = `ORDER BY c.number LIMIT ${AUTO_MERGE_PAGE}`;
  const stmt = numbers
    ? env.DB.prepare(`${CHANGE_SELECT} WHERE ${where} AND c.number IN (SELECT value FROM json_each(?3)) ${page}`).bind(repoId, after, JSON.stringify(numbers))
    : env.DB.prepare(`${CHANGE_SELECT} WHERE ${where} ${page}`).bind(repoId, after);
  const rows = (await stmt.all<ChangeRow>()).results ?? [];
  const merged: number[] = [];
  const cx: ChangeContext = { env, repo: ctxRows.repo, actor: null, branchRules: ctxRows.rules, waitUntil };
  for (const row of rows) {
    const done = await autoMerge(cx, row, opts.deps);
    if (done?.state === 'merged') merged.push(row.number);
  }
  return { merged, next: rows.length === AUTO_MERGE_PAGE ? rows[rows.length - 1]!.number : null };
}

/**
 * Push-event effect body for a branch push: runs the head-moved hooks for
 * open changes now at `after`, then merges the `auto` ones that are ready.
 * Costs no D1 when no open change uses the branch as its head.
 */
export async function onHeadPushed(
  env: Env,
  repoId: string,
  changes: ChangeOnRef[],
  after: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ state: 'done' | 'skipped'; detail: string }> {
  if (after === ZERO_SHA) return { state: 'skipped', detail: 'ref deleted' };
  const moved = changes.filter((c) => c.headSha === after);
  if (moved.length === 0) return { state: 'skipped', detail: changes.length === 0 ? 'no open changes' : 'heads not at this push' };
  for (const change of moved) {
    for (const hook of HEAD_MOVED_HOOKS) await hook({ env, repoId, change, headSha: after });
  }
  const auto = moved.filter((c) => c.policy === 'auto').map((c) => c.number);
  const merged: number[] = [];
  // The moved changes are a finite set from the ingest batch; each pass is one bounded page of them.
  for (let after: number | null = 0; auto.length > 0 && after !== null; ) {
    const pass: AutoMergePass = await mergeReadyAutoChanges(env, repoId, auto, waitUntil, { after });
    merged.push(...pass.merged);
    after = pass.next;
  }
  const parts = [`heads ${moved.map((c) => `#${c.number}`).join(',')}`];
  if (auto.length > 0) parts.push(`auto-merged ${merged.length ? merged.map((n) => `#${n}`).join(',') : 'none'}`);
  return { state: 'done', detail: parts.join('; ') };
}

/** Statements that remove a repo's changes and their dependents, for the repo DELETE batch (before the repo row). */
export function changeCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM comments WHERE change_set_id IN (SELECT id FROM change_sets WHERE repo_id = ?)').bind(repoId),
    db.prepare('DELETE FROM check_runs WHERE repo_id = ?').bind(repoId),
    db.prepare('UPDATE workspaces SET change_set_id = NULL WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM change_sets WHERE repo_id = ?').bind(repoId),
  ];
}
