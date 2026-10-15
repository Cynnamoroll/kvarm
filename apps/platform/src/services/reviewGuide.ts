/**
 * Content-addressed review coverage, guides, acknowledgements and findings.
 */

import type { Hunk } from '@kvarm/diffcore';
import {
  carryGuide,
  fallbackGuide,
  matchReviewGlob,
  validateGuide,
  type ExportBreak,
  type CoverageMap,
  type CoverageUnit,
  type ResolvedGuide,
  type ReviewTier,
} from '@kvarm/review';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { compareKeys, readJson, writeJson } from '../cache/compare';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { sha256Hex } from '@kvarm/gitops';
import { effectivePolicy } from './branchRules';
import { branchRef, parseNumber, type ChangeContext, type ChangeRow } from './changes';
import { cachedFileDiff, treePairBody, type CompareBody } from './compare';
import type { ResolveContext } from './refs';
import { parseReviewFacts, reviewFactsColumns, reviewGate, type ReviewBlocker, type ReviewFacts, type ReviewFactsRow } from './reviewGate';
import { edgeState, sourceHeadSql, type DependencyState } from './dependencyGate';
import { headCoverage, type HeadCoverage } from './reviewCoverage';
import { remainingFor, type RemainingItem, type RemainingWho } from './remaining';

export const REVIEW_BUDGETS = { maxHunkFiles: 300, maxUnits: 5000, maxInlineHunkLines: 4000 } as const;
const MAX_HEAD_TREE_ENTRIES = 20_000;
export const FINDING_CATEGORIES = ['bug', 'risk', 'security', 'breaking', 'maintainability', 'question'] as const;
export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export const FINDING_CONFIDENCES = ['confirmed', 'investigate'] as const;
export const FINDING_STATUSES = ['open', 'resolved', 'irrelevant', 'wont-fix'] as const;

type FindingCategory = (typeof FINDING_CATEGORIES)[number];
type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];
type FindingStatus = (typeof FINDING_STATUSES)[number];

const SHA_RE = /^[0-9a-f]{40}$/;
const TREE_MODE = /^0?40000$/;
const fail = <T>(status: number, error: string, code: string): ServiceResult<T> => ({ ok: false, status, error, code });

export interface GuideChange extends Pick<ChangeRow, 'id' | 'number' | 'title' | 'base_ref' | 'head_ref' | 'head_sha' | 'base_sha' | 'state' | 'author_id' | 'agent_meta' | 'merge_policy' | 'risk_level' | 'updated_at'> {}

export interface CoverageBuild {
  change: GuideChange;
  baseTree: string;
  headTree: string;
  map: CoverageMap;
  compare?: CompareBody;
  configError?: string;
  configSha: string;
  truncated: boolean;
  pointer: ReviewMapPointer;
}

interface ReviewMapPointer {
  baseSha: string;
  headSha: string;
  baseTree: string;
  headTree: string;
  configSha: string;
  map: CoverageMap;
  truncated: boolean;
  invalidConfig?: boolean;
  configError?: string;
  tiers?: Record<string, ReviewTier>;
  changedPaths?: string[];
}

interface StackLayerRow extends GuideChange, Partial<ReviewFactsRow> {
  direction: 'parent' | 'child';
  on_workspace: string;
  revision: string;
  satisfied_commit: string | null;
  broken_code: string | null;
  broken_reason: string | null;
  s_status: string | null;
  s_head: string | null;
  rv_checks_pending: number;
  rv_checks_failing: number;
  rv_request_changes: number;
  queue_state: string | null;
}

interface StackParentUnits {
  id: string;
  number: number;
  revision: string;
  keys: string[];
}

interface StackLayer {
  number: number;
  title: string;
  state: string;
  headSha: string | null;
  revision?: string;
  edgeState: DependencyState;
  waitingOn: RemainingWho | null;
  approvals: { have: number; need: number };
}

function liveParentEdgeSql(d = 'd', s = 's', f = 'f'): string {
  return `(${d}.satisfied_commit IS NOT NULL OR (${d}.broken_code IS NULL AND ${s}.status = 'active'
    AND ${sourceHeadSql(s, f, d)} = ${d}.revision))`;
}

export function reviewParentChangeIdsSql(changeIdSql: string): string {
  return `SELECT DISTINCT source.change_set_id
    FROM workspaces dependent INDEXED BY idx_ws_change
     JOIN workspace_dependencies d INDEXED BY idx_dep_edge ON d.repo_id = dependent.repo_id AND d.workspace_id = dependent.id
    JOIN workspaces source ON source.repo_id = d.repo_id AND source.id = d.on_workspace
    LEFT JOIN repo_refs f ON f.repo_id = source.repo_id AND f.ref = source.ref
   WHERE dependent.change_set_id = ${changeIdSql} AND source.change_set_id IS NOT NULL
     AND ${liveParentEdgeSql('d', 'source', 'f')}`;
}

function actorPrincipal(actor: Actor): { id: string; userId: string; agentId: string | null; tokenId: string | null } {
  return actor.agent
    ? { id: `agent:${actor.agent.agentId}`, userId: actor.user.id, agentId: actor.agent.agentId, tokenId: actor.agent.tokenId }
    : { id: `user:${actor.user.id}`, userId: actor.user.id, agentId: null, tokenId: null };
}

function authorPrincipal(change: Pick<GuideChange, 'agent_meta' | 'author_id'>): string | null {
  if (change.agent_meta) {
    try {
      const meta = JSON.parse(change.agent_meta) as { agentId?: unknown };
      if (typeof meta.agentId === 'string') return `agent:${meta.agentId}`;
    } catch {
      // An unreadable agent marker falls back to the human author.
    }
  }
  return change.author_id ? `user:${change.author_id}` : null;
}

function resolveCtx(cx: ChangeContext, artifacts: LazyRepo): ResolveContext {
  return { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
}

async function headTreeFiles(ctx: ResolveContext, tree: string): Promise<{ files: string[]; truncated: boolean }> {
  const key = compareKeys.reviewFiles(tree);
  const cached = await readJson<{ files: string[]; truncated: boolean }>(key);
  if (cached && Array.isArray(cached.files)) return cached;
  const repo = await ctx.artifacts.get();
  const stack: Array<{ path: string; hash: string }> = [{ path: '', hash: tree }];
  const files: string[] = [];
  let entriesRead = 0;
  let truncated = false;
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await repo.readTree(current.hash);
    if (!entries) continue;
    for (const entry of entries) {
      entriesRead++;
      if (entriesRead > MAX_HEAD_TREE_ENTRIES) {
        truncated = true;
        stack.length = 0;
        break;
      }
      const path = current.path ? `${current.path}/${entry.name}` : entry.name;
      if (TREE_MODE.test(entry.mode)) stack.push({ path, hash: entry.hash });
      else files.push(path);
    }
  }
  const result = { files: files.sort(), truncated };
  ctx.waitUntil(writeJson(key, JSON.stringify(result)));
  return result;
}

async function coverageBuild(
  cx: ChangeContext,
  change: GuideChange,
  since = false,
  suppliedCoverage?: HeadCoverage,
): Promise<ServiceResult<CoverageBuild>> {
  if (!change.head_sha || !change.base_sha) return fail(409, 'change has no base or head commit', 'NO_HEAD');
  const reusable = suppliedCoverage?.response?.head.sha === change.head_sha;
  const coverage = reusable
    ? suppliedCoverage
    : await headCoverage(cx.env, cx.repo, { id: change.id, base: change.base_sha }, change.head_sha, cx.waitUntil);
  if (coverage.error || !coverage.response || !coverage.map) {
    return fail(503, coverage.error ?? 'review coverage could not be computed', 'COVERAGE_UNAVAILABLE');
  }
  if (since && coverage.response.head.sha !== change.head_sha) return fail(404, 'since commit not found', 'SINCE_NOT_FOUND');
  const baseTree = coverage.baseTree;
  const headTree = coverage.headTree;
  if (!baseTree || !headTree) return fail(503, 'review coverage has no resolved trees', 'COVERAGE_UNAVAILABLE');
  const fileIndex = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) =>
    headTreeFiles(resolveCtx(cx, artifacts), headTree));
  const map = {
    ...coverage.map,
    headFiles: fileIndex.files,
    headFilesTruncated: fileIndex.truncated,
    truncated: coverage.map.truncated || fileIndex.truncated,
  };
  const pointer: ReviewMapPointer = {
    baseSha: change.base_sha,
    headSha: change.head_sha,
    baseTree,
    headTree,
    configSha: coverage.configSha,
    map,
    truncated: map.truncated,
    invalidConfig: coverage.invalidConfig,
    ...(coverage.configError ? { configError: coverage.configError } : {}),
    changedPaths: coverage.response.files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]),
  };
  return {
    ok: true,
    value: {
      change,
      baseTree,
      headTree,
      map,
      ...(coverage.configError ? { configError: coverage.configError } : {}),
      configSha: coverage.configSha,
      truncated: map.truncated,
      pointer,
    },
  };
}

function selectChange(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db.prepare(
    `SELECT id, number, title, base_ref, head_ref, head_sha, base_sha, state, author_id, agent_meta, merge_policy, risk_level, updated_at
       FROM change_sets WHERE repo_id = ?1 AND number = ?2`,
  ).bind(repoId, number);
}

async function findChange(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<GuideChange>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  const row = await selectChange(cx.env.DB, cx.repo.id, number).first<GuideChange>();
  return row ? { ok: true, value: row } : fail(404, 'change not found', 'CHANGE_NOT_FOUND');
}

export async function coverageFor(
  cx: ChangeContext,
  change: GuideChange,
  headSha?: string,
  suppliedCoverage?: HeadCoverage,
): Promise<ServiceResult<CoverageBuild>> {
  const selected = headSha === undefined ? change : { ...change, head_sha: headSha };
  return coverageBuild(cx, selected, headSha !== undefined, suppliedCoverage);
}

export async function coverageForNumber(cx: ChangeContext, rawNumber: string): Promise<ServiceResult<CoverageBuild>> {
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
  return coverageFor(cx, change.value);
}

export async function reviewMapAckKeys(
  changeId: string,
  baseSha: string | null,
  headSha: string | null,
): Promise<{ units: string[]; scrutinize: string[] } | null> {
  if (!baseSha || !headSha) return null;
  const pointer = await readJson<ReviewMapPointer>(compareKeys.reviewmapHead(changeId, baseSha, headSha));
  if (!pointer || pointer.baseSha !== baseSha || pointer.headSha !== headSha || !Array.isArray(pointer.map?.units)) return null;
  const units = pointer.map.units;
  return {
    units: units.map((unit) => unit.key),
    scrutinize: units.filter((unit) => (pointer.tiers?.[unit.key] ?? unit.defaultTier) === 'scrutinize').map((unit) => unit.key),
  };
}

interface GuideRow {
  id: string;
  head_sha: string;
  source: 'author' | 'reviewer';
  user_id: string | null;
  agent_id: string | null;
  token_id: string | null;
  body: string;
  gaps: number;
  undeclared: number;
  created_at: number;
}

interface FindingRow {
  id: string;
  opened_head: string;
  last_seen_head: string;
  path: string;
  side: 'head' | 'base';
  start_line: number;
  end_line: number | null;
  unit_key: string | null;
  category: FindingCategory;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  title: string;
  scenario: string | null;
  verify: string | null;
  body: string | null;
  status: FindingStatus;
  principal: string;
  created_at: number;
  updated_at: number;
}

function guideRowGuide(row: GuideRow, map: CoverageMap): ResolvedGuide | null {
  let body: unknown;
  try {
    body = JSON.parse(row.body);
  } catch {
    return null;
  }
  const validated = validateGuide(body, map);
  if (!validated.ok) return null;
  return { ...validated.guide, source: row.source };
}

function fallbackFromCoverage(map: CoverageMap): ResolvedGuide {
  return fallbackGuide(map);
}

function contractSurfaceMatches(surface: string, path: string): boolean {
  return surface === path || surface.startsWith(`${path}#`) || matchReviewGlob(surface, path);
}

function undeclaredContracts(map: CoverageMap, declarations: NonNullable<ResolvedGuide['contracts']>): string[] {
  const paths = map.contracts.filter((path) => !declarations.some((item) => contractSurfaceMatches(item.surface, path)));
  const breaks = (map.breaks ?? [])
    .filter((item) => item.change !== 'added' && !declarations.some((entry) =>
      entry.impact === 'breaking' && contractSurfaceMatches(entry.surface, item.path)))
    .map((item) => `${item.path}#${item.name}`);
  return [...new Set([...paths, ...breaks])];
}

async function resolveGuide(
  cx: ChangeContext,
  coverage: CoverageBuild,
  guideRows: GuideRow[],
): Promise<{ guide: ResolvedGuide; source: ResolvedGuide['source']; fromHead?: string; guideRow: GuideRow | null; gaps: string[]; raised: unknown[]; undeclared: string[] }> {
  const change = coverage.change;
  const rows = guideRows.filter((row) => row.head_sha === change.head_sha);
  const author = rows.find((row) => row.source === 'author');
  const reviewer = rows.find((row) => row.source === 'reviewer');
  const preferred = author ?? reviewer;
  if (preferred) {
    const guide = guideRowGuide(preferred, coverage.map);
    if (guide) {
      const valid = validateGuide(JSON.parse(preferred.body), coverage.map);
      return {
        guide,
        source: preferred.source,
        guideRow: preferred,
        gaps: valid.ok ? valid.gaps : [],
        raised: valid.ok ? valid.raised : [],
        undeclared: valid.ok ? valid.undeclared : [],
      };
    }
  }
  let prior: { row: GuideRow; guide: ResolvedGuide } | null = null;
  for (const row of guideRows.filter((item) => item.head_sha !== change.head_sha)) {
    const pointer = change.base_sha
      ? await readJson<ReviewMapPointer>(compareKeys.reviewmapHead(change.id, change.base_sha, row.head_sha))
      : null;
    const priorGuide = guideRowGuide(row, pointer?.map ?? coverage.map);
    if (priorGuide) {
      prior = { row, guide: priorGuide };
      break;
    }
  }
  if (prior?.guide) {
    const carried = carryGuide(prior.guide, coverage.map);
    const undeclared = undeclaredContracts(coverage.map, []);
    return {
      guide: carried,
      source: 'carried',
      fromHead: prior.row.head_sha,
      guideRow: prior.row,
      gaps: carried.chapters.find((chapter) => chapter.id === 'unguided')?.hunks ?? [],
      raised: [],
      undeclared,
    };
  }
  const guide = fallbackFromCoverage(coverage.map);
  return {
    guide,
    source: 'fallback',
    guideRow: null,
    gaps: [],
    raised: [],
    undeclared: undeclaredContracts(coverage.map, []),
  };
}

interface GuideQuery {
  since?: string;
  unacked?: string;
  include?: string;
}

export interface ReviewGuideView {
  number: number;
  headSha: string;
  baseSha: string;
  source: ResolvedGuide['source'];
  fromHead?: string;
  guide: ResolvedGuide;
  coverage: { units: number; guided: number; gaps: number; truncated: boolean };
  units: Array<{
    key: string;
    path: string;
    index: number;
    kind: CoverageUnit['kind'];
    ranges: { oldStart: number; oldEnd: number; newStart: number; newEnd: number };
    tier: ReviewTier;
    floor: ReviewTier;
    contract: boolean;
    moved?: { from: string };
    receipt?: string;
    inherited?: { change: number };
    acked: boolean;
    ackCount: number;
    hunks?: Hunk[];
  }>;
  contracts: {
    changed: string[];
    declared: Array<{ surface: string; impact: string; note?: string }>;
    undeclared: string[];
    breaks: Array<ExportBreak & { declared: boolean }>;
  };
  stack: {
    parents: StackLayer[];
    children: StackLayer[];
    inherited: number;
    truncated?: true;
  };
  impact: { cached: boolean };
  findings: { open: number; resolved: number; items: Array<Record<string, unknown>> };
  remaining: RemainingItem[];
  review: { satisfied: boolean; blockers: unknown[]; approvals: { count: number; required: number } };
  configError?: string;
  truncated: boolean;
  hunksTruncated?: boolean;
}

interface ReviewSummaryRow extends Partial<ReviewFactsRow> {
  rv_checks_pending?: number | null;
  rv_checks_failing?: number | null;
  rv_request_changes?: number | null;
  rv_blocking_policy?: string | null;
}

interface GuideSnapshot {
  change: GuideChange;
  guideRows: GuideRow[];
  ackRows: Array<{ unit_key: string; ack_count: number; mine: number }>;
  stackRows: StackLayerRow[];
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
  findings: FindingRow[];
  openFindings: number;
  reviewRow: ReviewSummaryRow | null;
}

function stackLayersStatement(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db.prepare(
    `WITH target AS (
       SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2
     ),
     current_ws AS (
       SELECT id FROM workspaces WHERE change_set_id = (SELECT id FROM target) LIMIT 1
     ),
     parent_edges AS (
       SELECT d.created_at AS edge_created_at, d.id AS edge_id, d.revision, d.satisfied_commit, d.broken_code, d.broken_reason,
              s.id AS on_workspace,
              s.status AS s_status, ${sourceHeadSql('s', 'f', 'd')} AS s_head, s.change_set_id
         FROM current_ws w
         JOIN workspace_dependencies d INDEXED BY idx_dep_edge ON d.repo_id = ?1 AND d.workspace_id = w.id
         JOIN workspaces s ON s.repo_id = d.repo_id AND s.id = d.on_workspace
         LEFT JOIN repo_refs f ON f.repo_id = s.repo_id AND f.ref = s.ref
        WHERE s.change_set_id IS NOT NULL AND ${liveParentEdgeSql()}
     ),
     child_edges AS (
       SELECT d.created_at AS edge_created_at, d.id AS edge_id, d.revision, d.satisfied_commit, d.broken_code, d.broken_reason,
              s.id AS on_workspace,
              s.status AS s_status, ${sourceHeadSql('s', 'f', 'd')} AS s_head, child.change_set_id
         FROM current_ws w
         JOIN workspaces s ON s.id = w.id
         JOIN workspace_dependencies d INDEXED BY idx_dep_source ON d.repo_id = ?1 AND d.on_workspace = s.id
         JOIN workspaces child ON child.repo_id = d.repo_id AND child.id = d.workspace_id
         LEFT JOIN repo_refs f ON f.repo_id = s.repo_id AND f.ref = s.ref
        WHERE child.change_set_id IS NOT NULL
     ),
     parent_candidates AS (
       SELECT 'parent' AS direction, * FROM parent_edges ORDER BY edge_created_at, edge_id LIMIT 8
     ),
     child_candidates AS (
       SELECT 'child' AS direction, * FROM child_edges ORDER BY edge_created_at, edge_id LIMIT 21
     ),
     candidates AS (
       SELECT * FROM parent_candidates UNION ALL SELECT * FROM child_candidates
     )
     SELECT candidates.direction, candidates.revision, candidates.satisfied_commit, candidates.broken_code, candidates.broken_reason, candidates.on_workspace,
            candidates.s_status, candidates.s_head,
            c.id, c.number, c.title, c.base_ref, c.head_ref, c.head_sha, c.base_sha, c.state, c.author_id, c.agent_meta,
            c.merge_policy, c.risk_level, c.updated_at,
            ${reviewFactsColumns('c', 'rp')},
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS rv_checks_pending,
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS rv_checks_failing,
            EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS rv_request_changes,
            (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1 LIMIT 1) AS queue_state
       FROM candidates JOIN change_sets c ON c.id = candidates.change_set_id
       LEFT JOIN review_policies rp ON rp.repo_id = c.repo_id`,
  ).bind(repoId, number);
}

async function loadGuideSnapshot(cx: ChangeContext, rawNumber: string, mine: string | null): Promise<ServiceResult<GuideSnapshot>> {
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  const db = cx.env.DB;
  const results = await db.batch([
    selectChange(db, cx.repo.id, number),
    db.prepare(
      `SELECT g.id, g.head_sha, g.source, g.user_id, g.agent_id, g.token_id, g.body, g.gaps, g.undeclared, g.created_at
         FROM review_guides g JOIN change_sets c ON c.id = g.change_set_id
        WHERE c.repo_id = ?1 AND c.number = ?2
        ORDER BY (g.head_sha = c.head_sha) DESC, (g.source = 'author') DESC, g.created_at DESC LIMIT 50`,
    ).bind(cx.repo.id, number),
    db.prepare(
      `WITH target AS (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)
       SELECT a.unit_key, COUNT(DISTINCT a.principal) AS ack_count, MAX(CASE WHEN a.principal = ?3 THEN 1 ELSE 0 END) AS mine
         FROM review_acks a
        WHERE a.change_set_id = (SELECT id FROM target)
           OR a.change_set_id IN (${reviewParentChangeIdsSql('(SELECT id FROM target)')})
        GROUP BY a.unit_key`,
    ).bind(cx.repo.id, number, mine),
    db.prepare(
      `SELECT f.id, f.opened_head, f.last_seen_head, f.path, f.side, f.start_line, f.end_line, f.unit_key, f.category, f.severity,
              f.confidence, f.title, f.scenario, f.verify, f.body, f.status, f.principal, f.created_at, f.updated_at
         FROM review_findings f JOIN change_sets c ON c.id = f.change_set_id
        WHERE c.repo_id = ?1 AND c.number = ?2 AND (f.status = 'open' OR f.opened_head = c.head_sha OR f.last_seen_head = c.head_sha)
        ORDER BY f.created_at DESC LIMIT 100`,
    ).bind(cx.repo.id, number),
    db.prepare(
      `SELECT COUNT(*) AS n FROM review_findings f JOIN change_sets c ON c.id = f.change_set_id
        WHERE c.repo_id = ?1 AND c.number = ?2 AND f.status = 'open'`,
    ).bind(cx.repo.id, number),
    db.prepare(
      `SELECT ${reviewFactsColumns('c', 'rp')},
              EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS rv_checks_pending,
              EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS rv_checks_failing,
              EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS rv_request_changes,
              rp.blocking_findings AS rv_blocking_policy
         FROM change_sets c LEFT JOIN review_policies rp ON rp.repo_id = c.repo_id
        WHERE c.repo_id = ?1 AND c.number = ?2`,
    ).bind(cx.repo.id, number),
    db.prepare(
      `SELECT name, status, conclusion
         FROM check_runs
        WHERE change_set_id = (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)
          AND head_sha = (SELECT head_sha FROM change_sets WHERE repo_id = ?1 AND number = ?2)
        ORDER BY created_at DESC, id DESC LIMIT 200`,
    ).bind(cx.repo.id, number),
    stackLayersStatement(db, cx.repo.id, number),
  ]);
  const change = (results[0]?.results?.[0] as GuideChange | undefined) ?? null;
  if (!change) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  return {
    ok: true,
    value: {
      change,
      guideRows: (results[1]?.results ?? []) as GuideRow[],
      ackRows: (results[2]?.results ?? []) as Array<{ unit_key: string; ack_count: number; mine: number }>,
      stackRows: (results[7]?.results ?? []) as StackLayerRow[],
      checks: (results[6]?.results ?? []) as Array<{ name: string; status: string; conclusion: string | null }>,
      findings: (results[3]?.results ?? []) as FindingRow[],
      openFindings: Number((results[4]?.results?.[0] as { n?: number } | undefined)?.n ?? 0),
      reviewRow: (results[5]?.results?.[0] as ReviewSummaryRow | undefined) ?? null,
    },
  };
}

function reviewSummary(
  cx: ChangeContext,
  change: GuideChange,
  row: ReviewSummaryRow | null,
): { facts: ReviewFacts; satisfied: boolean; blockers: ReviewBlocker[]; approvals: { count: number; required: number } } {
  const facts = parseReviewFacts(row);
  const branchPolicy = effectivePolicy(cx.branchRules ?? [], branchRef(change.base_ref));
  const gate = reviewGate(facts, branchPolicy);
  const required = facts.required;
  const approvals = facts.approvals;
  return {
    facts,
    satisfied: gate.block === null,
    blockers: gate.blockers,
    approvals: { count: approvals, required },
  };
}

function remainingReviewItems(
  cx: ChangeContext,
  change: Pick<ChangeRow, 'state' | 'merge_policy' | 'author_id' | 'agent_meta'> & { queue_state?: string | null },
  blockers: ReviewBlocker[],
  facts: ReviewFacts,
  humansRequired: number,
  queueState: string | null = null,
): RemainingItem[] {
  return remainingFor({
    change: {
      state: change.state,
      mergePolicy: change.merge_policy,
      author: { principal: authorPrincipal(change) },
      queueState: change.queue_state ?? queueState,
      conflicts: [],
    },
    blockers,
    approvals: {
      count: facts.approvals,
      required: facts.required,
      humans: facts.humans,
      humansRequired,
      agentFamilyApprovals: facts.agentFamilyApprovals,
      lowRisk: false,
    },
    agentApprovals: 'never',
    mergeability: { status: 'known', mergeable: false, checks: { state: 'success', required: [] } },
    dependency: null,
    resolveConflictTaskOpen: false,
    viewer: {
      principal: cx.actor ? actorPrincipal(cx.actor).id : null,
      login: cx.actor?.user.login ?? null,
      kind: cx.actor ? (cx.actor.agent ? 'agent' : 'human') : null,
      writeAccess: cx.writeAccess === true,
    },
  });
}

interface ReviewStackBuild {
  parents: StackLayer[];
  children: StackLayer[];
  inheritedByKey: Map<string, number>;
  inherited: number;
  truncated: boolean;
}

async function buildReviewStack(
  cx: ChangeContext,
  change: GuideChange,
  units: CoverageUnit[],
  rows: StackLayerRow[],
): Promise<ServiceResult<ReviewStackBuild>> {
  const parentRows = rows.filter((row) => row.direction === 'parent').sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  const childRows = rows.filter((row) => row.direction === 'child').sort((a, b) => a.number - b.number || a.id.localeCompare(b.id));
  const parentPins = parentRows.map((row) => `${row.id}:${row.revision}`).sort();
  const stackKey = compareKeys.reviewStack(change.id, change.head_sha ?? '', await sha256Hex(parentPins.join('\n')));
  const cached = await readJson<{ parents: StackParentUnits[] }>(stackKey);
  let parentUnits = cached?.parents;
  if (!parentUnits || parentUnits.length !== parentRows.length ||
      parentUnits.some((parent, index) => parent.id !== parentRows[index]?.id || parent.revision !== parentRows[index]?.revision)) {
    parentUnits = [];
    for (const row of parentRows) {
      const coverage = await coverageFor(cx, row, row.revision);
      if (!coverage.ok) return coverage;
      parentUnits.push({
        id: row.id,
        number: row.number,
        revision: row.revision,
        keys: coverage.value.map.units.map((unit) => unit.key),
      });
    }
    await writeJson(stackKey, JSON.stringify({ parents: parentUnits }));
  }
  const inheritedByKey = new Map<string, number>();
  for (const parent of parentUnits) {
    for (const key of parent.keys) if (!inheritedByKey.has(key)) inheritedByKey.set(key, parent.number);
  }
  const toLayer = (row: StackLayerRow): StackLayer => {
    const facts = parseReviewFacts(row);
    const policy = effectivePolicy(cx.branchRules ?? [], branchRef(row.base_ref));
    const gate = reviewGate(facts, policy);
    const remaining = remainingReviewItems(cx, row, gate.blockers, facts, policy.requiredApprovals, row.queue_state);
    return {
      number: row.number,
      title: row.title,
      state: row.state,
      headSha: row.head_sha,
      revision: row.revision,
      edgeState: edgeState({
        revision: row.revision,
        on_workspace: row.on_workspace,
        satisfied_commit: row.satisfied_commit,
        broken_code: row.broken_code,
        broken_reason: row.broken_reason,
        s_status: row.s_status,
        s_head: row.s_head,
      }).state,
      waitingOn: remaining[0]?.who ?? null,
      approvals: { have: facts.approvals, need: facts.required },
    };
  };
  return {
    ok: true,
    value: {
      parents: parentRows.map(toLayer),
      children: childRows.slice(0, 20).map(toLayer),
      inheritedByKey,
      inherited: units.reduce((count, unit) => count + Number(inheritedByKey.has(unit.key)), 0),
      truncated: childRows.length > 20,
    },
  };
}

export async function getGuide(
  cx: ChangeContext,
  rawNumber: string,
  query: GuideQuery = {},
  preload?: { snapshot: GuideSnapshot; built: CoverageBuild },
  coverage?: HeadCoverage,
): Promise<ServiceResult<ReviewGuideView>> {
  if (query.since !== undefined && query.since !== 'parent' && !SHA_RE.test(query.since)) return fail(400, 'since must be a full 40-character commit SHA or "parent"', 'INVALID_SINCE');
  if (query.include !== undefined && query.include !== 'hunks') return fail(400, 'include must be "hunks"', 'INVALID_INCLUDE');
  if (query.unacked !== undefined && query.unacked !== 'true' && query.unacked !== 'false') {
    return fail(400, 'unacked must be true or false', 'INVALID_UNACKED');
  }
  const mine = cx.actor ? actorPrincipal(cx.actor).id : null;
  const snapshotResult = preload ? { ok: true as const, value: preload.snapshot } : await loadGuideSnapshot(cx, rawNumber, mine);
  if (!snapshotResult.ok) return snapshotResult;
  const snapshot = snapshotResult.value;
  const coverageResult = preload ? { ok: true as const, value: preload.built } : await coverageFor(cx, snapshot.change, undefined, coverage);
  if (!coverageResult.ok) return coverageResult;
  const built = coverageResult.value;
  if (!built.change.head_sha || !built.change.base_sha) return fail(409, 'change has no base or head commit', 'NO_HEAD');
  const stackResult = await buildReviewStack(cx, built.change, built.map.units, snapshot.stackRows);
  if (!stackResult.ok) return stackResult;
  const stack = stackResult.value;
  let compare = built.compare;
  if (query.include === 'hunks' && !compare) {
    compare = (await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) =>
      treePairBody(resolveCtx(cx, artifacts), built.baseTree, built.headTree),
    )).body;
  }
  const selected = await resolveGuide(cx, built, snapshot.guideRows);
  const activeContracts = selected.source === 'author' || selected.source === 'reviewer' ? selected.guide.contracts ?? [] : [];
  const undeclared = undeclaredContracts(built.map, activeContracts);
  const evidenceChecks = new Map<string, string>();
  for (const check of snapshot.checks) {
    if (!evidenceChecks.has(check.name)) evidenceChecks.set(check.name, check.conclusion ?? '');
  }
  const guide = selected.guide.evidence
    ? {
        ...selected.guide,
        evidence: selected.guide.evidence.map((item) => ({
          ...item,
          status: item.kind === 'manual'
            ? 'unverifiable' as const
            : item.kind === 'check'
              ? evidenceChecks.get(item.ref) === 'success'
                ? 'verified' as const
                : evidenceChecks.get(item.ref) === 'failure'
                  ? 'failed' as const
                  : 'missing' as const
              : built.map.headFiles?.includes(item.ref) ? 'verified' as const : 'missing' as const,
        })),
      }
    : selected.guide;
  const ackMap = new Map(snapshot.ackRows.map((row) => [row.unit_key, row]));
  let sinceKeys: Set<string> | null = null;
  if (query.since !== undefined && query.since !== 'parent') {
    const previous = await coverageFor(cx, built.change, query.since);
    if (!previous.ok) return previous;
    sinceKeys = new Set(previous.value.map.units.map((unit) => unit.key));
  }
  const visible = built.map.units.filter((unit) => {
    if (query.since === 'parent' && stack.inheritedByKey.has(unit.key)) return false;
    if (sinceKeys && sinceKeys.has(unit.key)) return false;
    if (query.unacked === 'true' && ackMap.get(unit.key)?.mine) return false;
    return true;
  });
  let inlineLines = 0;
  let hunksTruncated = false;
  const inlineByFile = new Map<string, Hunk[]>();
  const includedInlineKeys = new Set<string>();
  if (query.include === 'hunks') {
    await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      for (const unit of visible) {
        if (unit.kind !== 'hunk') continue;
        const file = compare?.files.find((item) => item.path === unit.path);
        if (!file) continue;
        let list = inlineByFile.get(file.path);
        if (!list) {
          list = (await cachedFileDiff(ctx, file)).hunks;
          inlineByFile.set(file.path, list);
        }
        const hunk = list[unit.index];
        if (!hunk) continue;
        const lines = hunk.lines.length;
        if (inlineLines + lines > REVIEW_BUDGETS.maxInlineHunkLines) {
          hunksTruncated = true;
          continue;
        }
        inlineLines += lines;
        includedInlineKeys.add(unit.key);
      }
    });
  }
  const units = visible.map((unit) => {
    const ack = ackMap.get(unit.key);
    const value: ReviewGuideView['units'][number] = {
      key: unit.key,
      path: unit.path,
      index: unit.index,
      kind: unit.kind,
      ranges: {
        oldStart: unit.oldStart,
        oldEnd: unit.oldStart + unit.oldLines,
        newStart: unit.newStart,
        newEnd: unit.newStart + unit.newLines,
      },
      tier: selected.guide.tiers[unit.key] ?? unit.defaultTier,
      floor: unit.floor,
      contract: unit.contract,
      ...(unit.moved ? { moved: unit.moved } : {}),
      ...(unit.receipt ? { receipt: unit.receipt } : {}),
      acked: Boolean(ack?.mine),
      ackCount: Number(ack?.ack_count ?? 0),
      ...(stack.inheritedByKey.has(unit.key) ? { inherited: { change: stack.inheritedByKey.get(unit.key)! } } : {}),
    };
    if (query.include === 'hunks' && unit.kind === 'hunk' && includedInlineKeys.has(unit.key)) {
      const hunk = inlineByFile.get(unit.path)?.[unit.index];
      if (hunk) value.hunks = [hunk];
    }
    return value;
  });
  const blockingPolicy = snapshot.reviewRow?.rv_blocking_policy ?? 'high-confirmed';
  const validKeys = JSON.stringify(built.map.units.map((unit) => unit.key));
  if (built.map.units.length && !preload) {
    await cx.env.DB.batch([cx.env.DB.prepare(
      `UPDATE review_findings SET last_seen_head = ?3
        WHERE change_set_id = ?1 AND unit_key IN (SELECT value FROM json_each(?2)) AND last_seen_head != ?3`,
    ).bind(built.change.id, validKeys, built.change.head_sha)]);
    const knownKeys = new Set(built.map.units.map((unit) => unit.key));
    for (const finding of snapshot.findings) {
      if (finding.unit_key !== null && knownKeys.has(finding.unit_key)) finding.last_seen_head = built.change.head_sha;
    }
  }
  const items = snapshot.findings.map((row) => ({
    ...findingView(row),
    outdated: row.unit_key !== null && !built.map.units.some((unit) => unit.key === row.unit_key),
    blocking: isBlocking(row, blockingPolicy),
  }));
  const review = reviewSummary(cx, built.change, snapshot.reviewRow);
  const reviewPolicy = effectivePolicy(cx.branchRules ?? [], branchRef(built.change.base_ref));
  const remaining = remainingReviewItems(cx, built.change, review.blockers, review.facts, reviewPolicy.requiredApprovals);
  const reviews = { satisfied: review.satisfied, blockers: review.blockers, approvals: review.approvals };
  built.pointer.tiers = Object.fromEntries(built.map.units.map((unit) => [unit.key, selected.guide.tiers[unit.key] ?? unit.defaultTier]));
  await writeJson(compareKeys.reviewmapHead(built.change.id, built.change.base_sha, built.change.head_sha), JSON.stringify(built.pointer));
  const out: ReviewGuideView = {
    number: built.change.number,
    headSha: built.change.head_sha,
    baseSha: built.change.base_sha,
    source: selected.source,
    ...(selected.fromHead ? { fromHead: selected.fromHead } : {}),
    guide,
    coverage: {
      units: built.map.units.length,
      guided: built.map.units.length - selected.gaps.length,
      gaps: selected.gaps.length,
      truncated: built.truncated,
    },
    units,
    stack: {
      parents: stack.parents,
      children: stack.children,
      inherited: stack.inherited,
      ...(stack.truncated ? { truncated: true } : {}),
    },
    contracts: {
      changed: built.map.contracts,
      declared: activeContracts.filter((item) => built.map.contracts.some((path) => contractSurfaceMatches(item.surface, path))),
      undeclared,
      breaks: (built.map.breaks ?? []).map((item) => ({
        ...item,
        declared: item.change === 'added' || activeContracts.some((entry) =>
          entry.impact === 'breaking' && contractSurfaceMatches(entry.surface, item.path)),
      })),
    },
    impact: {
      cached: Boolean(await readJson(compareKeys.reviewImpact(built.baseTree, built.headTree, built.configSha))),
    },
    findings: { open: snapshot.openFindings, resolved: snapshot.findings.filter((row) => row.status === 'resolved').length, items },
    remaining,
    review: reviews,
    ...(built.configError ? { configError: built.configError } : {}),
    truncated: built.truncated,
    ...(hunksTruncated ? { hunksTruncated: true } : {}),
  };
  return { ok: true, value: out };
}

export async function submitGuide(
  cx: ChangeContext,
  rawNumber: string,
  input: unknown,
): Promise<ServiceResult<{ created: boolean; guide: ReviewGuideView }>> {
  if (!cx.actor) return fail(401, 'unauthorized', 'UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be an object {headSha, guide}', 'INVALID_BODY');
  const body = input as Record<string, unknown>;
  if (typeof body.headSha !== 'string' || !SHA_RE.test(body.headSha)) return fail(422, 'headSha must be a full 40-character commit SHA', 'INVALID_HEAD_SHA');
  const principal = actorPrincipal(cx.actor);
  const snapshotResult = await loadGuideSnapshot(cx, rawNumber, principal.id);
  if (!snapshotResult.ok) return snapshotResult;
  const snapshot = snapshotResult.value;
  const change = snapshot.change;
  if (body.headSha !== change.head_sha) return fail(409, 'the change head moved; submit a guide for the current head', 'HEAD_MOVED');
  const built = await coverageFor(cx, change);
  if (!built.ok) return built;
  const validated = validateGuide(body.guide, built.value.map);
  if (!validated.ok) return fail(422, validated.error, validated.code);
  const source = authorPrincipal(change) === principal.id ? 'author' : 'reviewer';
  const now = Date.now();
  const existing = snapshot.guideRows.find((row) => row.head_sha === body.headSha && row.source === source);
  const id = existing?.id ?? crypto.randomUUID();
  const json = JSON.stringify(body.guide);
  await cx.env.DB.batch([cx.env.DB.prepare(
    `INSERT INTO review_guides (id, change_set_id, head_sha, source, user_id, agent_id, token_id, body, gaps, undeclared, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(change_set_id, head_sha, source) DO UPDATE SET user_id = excluded.user_id, agent_id = excluded.agent_id,
       token_id = excluded.token_id, body = excluded.body, gaps = excluded.gaps, undeclared = excluded.undeclared, created_at = excluded.created_at`,
  ).bind(id, change.id, body.headSha, source, principal.userId, principal.agentId, principal.tokenId, json, validated.gaps.length, validated.undeclared.length, now)]);
  const guideRow: GuideRow = {
    id,
    head_sha: body.headSha,
    source,
    user_id: principal.userId,
    agent_id: principal.agentId,
    token_id: principal.tokenId,
    body: json,
    gaps: validated.gaps.length,
    undeclared: validated.undeclared.length,
    created_at: now,
  };
  snapshot.guideRows = [guideRow, ...snapshot.guideRows.filter((row) => !(row.head_sha === body.headSha && row.source === source))];
  snapshot.reviewRow = { ...snapshot.reviewRow, rv_guide_present: 1, rv_undeclared: validated.undeclared.length };
  const result = await getGuide(cx, rawNumber, {}, { snapshot, built: built.value });
  return result.ok ? { ok: true, value: { created: !existing, guide: result.value } } : result;
}

export async function ackUnits(
  cx: ChangeContext,
  rawNumber: string,
  input: unknown,
): Promise<ServiceResult<{ acknowledged: string[]; unacknowledged: string[] }>> {
  if (!cx.actor) return fail(401, 'unauthorized', 'UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be an object', 'INVALID_BODY');
  const body = input as Record<string, unknown>;
  if (typeof body.headSha !== 'string' || !SHA_RE.test(body.headSha)) return fail(422, 'headSha must be a full 40-character commit SHA', 'INVALID_HEAD_SHA');
  if (body.unack !== undefined && typeof body.unack !== 'boolean') return fail(422, 'unack must be a boolean', 'INVALID_UNACK');
  const keys = body.keys;
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > 500 || keys.some((key) => typeof key !== 'string'))) {
    return fail(422, 'keys must be an array of at most 500 unit keys', 'INVALID_KEYS');
  }
  if (keys !== undefined && body.chapter !== undefined) return fail(422, 'provide explicit keys or a chapter, not both', 'INVALID_KEYS');
  const principal = actorPrincipal(cx.actor);
  const snapshotResult = await loadGuideSnapshot(cx, rawNumber, principal.id);
  if (!snapshotResult.ok) return snapshotResult;
  const snapshot = snapshotResult.value;
  const built = await coverageFor(cx, snapshot.change);
  if (!built.ok) return built;
  const current = await getGuide(cx, rawNumber, {}, { snapshot, built: built.value });
  if (!current.ok) return current;
  if (body.headSha !== current.value.headSha) return fail(409, 'the change head moved; acknowledge the current head', 'HEAD_MOVED');
  const requested = new Set(keys as string[] | undefined);
  if (typeof body.chapter === 'string') {
    const chapter = current.value.guide.chapters.find((item) => item.id === body.chapter);
    if (!chapter) return fail(422, 'chapter does not exist in the current guide', 'UNKNOWN_CHAPTER');
    for (const key of chapter.hunks) requested.add(key);
  } else if (body.chapter !== undefined) {
    return fail(422, 'chapter must be a string', 'INVALID_CHAPTER');
  }
  if (requested.size === 0) return fail(422, 'provide keys or a chapter', 'INVALID_KEYS');
  const known = new Set(current.value.units.map((unit) => unit.key));
  const unknown = [...requested].filter((key) => !known.has(key));
  if (unknown.length) return fail(422, `unknown unit key${unknown.length === 1 ? '' : 's'}: ${unknown.slice(0, 10).join(', ')}`, 'UNKNOWN_UNIT');
  const unack = body.unack === true;
  const now = Date.now();
  const stmts = [...requested].map((key) => unack
    ? cx.env.DB.prepare('DELETE FROM review_acks WHERE change_set_id = ?1 AND principal = ?2 AND unit_key = ?3').bind(snapshot.change.id, principal.id, key)
    : cx.env.DB.prepare(
      `INSERT INTO review_acks (change_set_id, unit_key, principal, user_id, agent_id, head_sha, created_at)
       SELECT c.id, ?3, ?4, ?5, ?6, ?7, ?8 FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2
       ON CONFLICT(change_set_id, principal, unit_key) DO UPDATE SET head_sha = excluded.head_sha, created_at = excluded.created_at`,
    ).bind(cx.repo.id, current.value.number, key, principal.id, principal.userId, principal.agentId, body.headSha, now));
  for (let start = 0; start < stmts.length; start += 100) await cx.env.DB.batch(stmts.slice(start, start + 100));
  return { ok: true, value: unack ? { acknowledged: [], unacknowledged: [...requested] } : { acknowledged: [...requested], unacknowledged: [] } };
}

function normalizedTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function findingFingerprint(category: string, path: string, title: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${category}\0${path}\0${normalizedTitle(title)}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function findingView(row: FindingRow): Record<string, unknown> {
  return {
    id: row.id,
    openedHead: row.opened_head,
    lastSeenHead: row.last_seen_head,
    path: row.path,
    side: row.side,
    startLine: row.start_line,
    endLine: row.end_line,
    unitKey: row.unit_key,
    category: row.category,
    severity: row.severity,
    confidence: row.confidence,
    title: row.title,
    scenario: row.scenario,
    verify: row.verify,
    body: row.body,
    status: row.status,
    principal: row.principal,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function isBlocking(finding: Pick<FindingRow, 'status' | 'severity' | 'confidence' | 'category'>, policy: string): boolean {
  return finding.status === 'open' && policy === 'high-confirmed' && ((finding.severity === 'high' && finding.confidence === 'confirmed') || finding.category === 'security');
}

function validEnum(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && values.includes(value);
}

export async function submitFindings(
  cx: ChangeContext,
  rawNumber: string,
  input: unknown,
): Promise<ServiceResult<{ created: Array<Record<string, unknown>>; duplicates: string[]; suppressed: string[] }>> {
  if (!cx.actor) return fail(401, 'unauthorized', 'UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be an object', 'INVALID_BODY');
  const body = input as Record<string, unknown>;
  if (typeof body.headSha !== 'string' || !SHA_RE.test(body.headSha)) return fail(422, 'headSha must be a full 40-character commit SHA', 'INVALID_HEAD_SHA');
  if (!Array.isArray(body.findings) || body.findings.length > 50) return fail(422, 'findings must be an array of at most 50 items', 'INVALID_FINDINGS');
  const parsed: Array<{
    value: Record<string, unknown>;
    side: 'head' | 'base';
    lineNumber: number;
    fingerprint: string;
  }> = [];
  for (const [index, item] of body.findings.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(422, `findings[${index}] must be an object`, 'INVALID_FINDING');
    const value = item as Record<string, unknown>;
    if (typeof value.path !== 'string' || value.path.length > 500) return fail(422, `findings[${index}].path is invalid`, 'INVALID_FINDING');
    const side = value.side ?? 'head';
    if (side !== 'head' && side !== 'base') return fail(422, `findings[${index}].side must be head or base`, 'INVALID_FINDING');
    if (!Number.isInteger(value.startLine) || Number(value.startLine) < 1) return fail(422, `findings[${index}].startLine must be positive`, 'INVALID_FINDING');
    if (value.endLine !== undefined && (!Number.isInteger(value.endLine) || Number(value.endLine) < Number(value.startLine))) return fail(422, `findings[${index}].endLine is invalid`, 'INVALID_FINDING');
    if (!validEnum(value.category, FINDING_CATEGORIES) || !validEnum(value.severity, FINDING_SEVERITIES) || !validEnum(value.confidence, FINDING_CONFIDENCES)) {
      return fail(422, `findings[${index}] has an invalid category, severity or confidence`, 'INVALID_FINDING');
    }
    if (typeof value.title !== 'string' || value.title.length > 200 || !value.title.trim()) return fail(422, `findings[${index}].title must be 1-200 characters`, 'INVALID_FINDING');
    for (const [field, max] of [['scenario', 2000], ['verify', 1000], ['body', 4000]] as const) {
      if (value[field] !== undefined && (typeof value[field] !== 'string' || value[field].length > max)) return fail(422, `findings[${index}].${field} must be at most ${max} characters`, 'INVALID_FINDING');
    }
    parsed.push({
      value,
      side,
      lineNumber: Number(value.startLine),
      fingerprint: await findingFingerprint(value.category, value.path, value.title),
    });
  }
  const number = parseNumber(rawNumber);
  if (number === null) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  const db = cx.env.DB;
  const results = await db.batch([
    selectChange(db, cx.repo.id, number),
    ...parsed.map(({ fingerprint }) => db.prepare(
      `SELECT id, status FROM review_findings WHERE change_set_id = (SELECT id FROM change_sets WHERE repo_id = ?1 AND number = ?2)
         AND fingerprint = ?3 AND status IN ('open', 'irrelevant')
        ORDER BY (status = 'open') DESC, created_at DESC LIMIT 1`,
    ).bind(cx.repo.id, number, fingerprint)),
  ]);
  const change = (results[0]?.results?.[0] as GuideChange | undefined) ?? null;
  if (!change) return fail(404, 'change not found', 'CHANGE_NOT_FOUND');
  if (body.headSha !== change.head_sha) return fail(409, 'the change head moved; submit findings for the current head', 'HEAD_MOVED');
  const built = await coverageFor(cx, change);
  if (!built.ok) return built;
  const principal = actorPrincipal(cx.actor);
  const created: Array<Record<string, unknown>> = [];
  const duplicates: string[] = [];
  const suppressed: string[] = [];
  const writes: D1PreparedStatement[] = [];
  const now = Date.now();
  for (const [index, item] of parsed.entries()) {
    const { value, side, lineNumber, fingerprint } = item;
    const prior = (results[index + 1]?.results?.[0] as { id: string; status: FindingStatus } | undefined) ?? null;
    if (prior?.status === 'open') {
      writes.push(db.prepare('UPDATE review_findings SET last_seen_head = ?2 WHERE id = ?1').bind(prior.id, body.headSha));
      duplicates.push(prior.id);
      continue;
    }
    if (prior?.status === 'irrelevant') {
      suppressed.push(prior.id);
      continue;
    }
    const unit = built.value.map.units.find((candidate) => candidate.path === value.path && (candidate.kind === 'file' ||
      (side === 'head' ? lineNumber >= candidate.newStart && lineNumber <= candidate.newStart + candidate.newLines : lineNumber >= candidate.oldStart && lineNumber <= candidate.oldStart + candidate.oldLines)));
    if (!unit) return fail(422, `findings[${index}] does not match a current coverage unit`, 'UNKNOWN_UNIT');
    const id = crypto.randomUUID();
    writes.push(db.prepare(
      `INSERT INTO review_findings (id, change_set_id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, fingerprint, status, principal, user_id, agent_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'open', ?17, ?18, ?19, ?20, ?20)`,
    ).bind(id, change.id, body.headSha, value.path, side, lineNumber, value.endLine ?? null, unit.key, value.category, value.severity,
      value.confidence, value.title, value.scenario ?? null, value.verify ?? null, value.body ?? null, fingerprint, principal.id, principal.userId, principal.agentId, now));
    created.push({ id, path: value.path, unitKey: unit.key, category: value.category, severity: value.severity, confidence: value.confidence, title: value.title });
  }
  if (writes.length) await db.batch(writes);
  return { ok: true, value: { created, duplicates, suppressed } };
}

export async function listFindings(
  cx: ChangeContext,
  rawNumber: string,
  query: { status?: string; limit?: string; cursor?: string } = {},
): Promise<ServiceResult<{ findings: Array<Record<string, unknown>>; nextCursor: string | null }>> {
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'limit must be an integer from 1 to 100', 'INVALID_LIMIT');
  if (query.status !== undefined && query.status !== 'all' && !validEnum(query.status, FINDING_STATUSES)) return fail(400, 'status is invalid', 'INVALID_STATUS');
  const cursor = query.cursor ?? '';
  const rows = await cx.env.DB.prepare(
    `SELECT id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, status, principal, created_at, updated_at
       FROM review_findings WHERE change_set_id = ?1 AND (?2 = '' OR status = ?2 OR ?2 = 'all') AND (?3 = '' OR id < ?3)
       ORDER BY created_at DESC, id DESC LIMIT ?4`,
  ).bind(change.value.id, query.status ?? 'all', cursor, limit + 1).all<FindingRow>();
  const page = (rows.results ?? []).slice(0, limit);
  const map = await coverageFor(cx, change.value);
  if (!map.ok) return map;
  const policy = await cx.env.DB.prepare('SELECT blocking_findings FROM review_policies WHERE repo_id = ?1').bind(cx.repo.id).first<{ blocking_findings: string }>();
  const known = new Set(map.value.map.units.map((unit) => unit.key));
  const findings = page.map((row) => ({
    ...findingView(row),
    outdated: row.unit_key !== null && !known.has(row.unit_key),
    blocking: isBlocking(row, policy?.blocking_findings ?? 'high-confirmed'),
  }));
  return { ok: true, value: { findings, nextCursor: (rows.results?.length ?? 0) > limit ? page.at(-1)!.id : null } };
}

export async function updateFinding(
  cx: ChangeContext,
  rawNumber: string,
  findingId: string,
  input: unknown,
): Promise<ServiceResult<Record<string, unknown>>> {
  if (!cx.actor) return fail(401, 'unauthorized', 'UNAUTHORIZED');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, 'body must be an object {status, note?}', 'INVALID_BODY');
  const body = input as Record<string, unknown>;
  if (!validEnum(body.status, FINDING_STATUSES)) return fail(422, 'status is invalid', 'INVALID_STATUS');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 4000)) return fail(422, 'note must be at most 4000 characters', 'INVALID_NOTE');
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
  const row = await cx.env.DB.prepare(
    `SELECT id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, status, principal, created_at, updated_at
       FROM review_findings WHERE id = ?1 AND change_set_id = ?2`,
  ).bind(findingId, change.value.id).first<FindingRow>();
  if (!row) return fail(404, 'finding not found', 'FINDING_NOT_FOUND');
  const policy = await cx.env.DB.prepare('SELECT blocking_findings FROM review_policies WHERE repo_id = ?1').bind(cx.repo.id).first<{ blocking_findings: string }>();
  const blocking = isBlocking(row, policy?.blocking_findings ?? 'high-confirmed');
  const mine = actorPrincipal(cx.actor).id;
  const human = !cx.actor.agent;
  const author = authorPrincipal(change.value) === mine;
  const next = body.status as FindingStatus;
  if (next === 'open') {
    if (row.status !== 'open' && row.principal !== mine && !human) return fail(403, 'only the filer or a human may reopen a finding', 'FINDING_REOPEN_FORBIDDEN');
  } else if (blocking && author && !human) {
    return fail(403, 'a blocking finding needs a non-author reviewer or human to resolve', 'FINDING_NEEDS_REVIEWER');
  } else if (blocking && author) {
    return fail(403, 'the author cannot dismiss a blocking finding', 'FINDING_NEEDS_REVIEWER');
  }
  const now = Date.now();
  await cx.env.DB.prepare(
    `UPDATE review_findings SET status = ?3, resolved_principal = ?4, resolved_note = ?5, resolved_at = ?6, updated_at = ?6
       WHERE id = ?1 AND change_set_id = ?2`,
  ).bind(findingId, change.value.id, next, next === 'open' ? null : mine, next === 'open' ? null : body.note ?? null, next === 'open' ? null : now).run();
  const updated = await cx.env.DB.prepare(
    `SELECT id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, status, principal, created_at, updated_at
       FROM review_findings WHERE id = ?1`,
  ).bind(findingId).first<FindingRow>();
  return { ok: true, value: findingView(updated!) };
}
