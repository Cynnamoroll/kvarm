/**
 * Content-addressed review coverage, guides, acknowledgements and findings.
 */

import type { Hunk } from '@kvarm/diffcore';
import {
  buildCoverage,
  carryGuide,
  fallbackGuide,
  parseReviewConfig,
  validateGuide,
  type CoverageFileInput,
  type CoverageMap,
  type CoverageUnit,
  type ResolvedGuide,
  type ReviewConfig,
  type ReviewTier,
} from '@kvarm/review';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { compareKeys, readJson, writeJson } from '../cache/compare';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';
import { branchRef, parseNumber, type ChangeContext, type ChangeRow } from './changes';
import { cachedFileDiff, treePairBody, type CompareBody, type CompareFile } from './compare';
import { effectivePolicy } from './branchRules';
import { readCommitInfo, type ResolveContext } from './refs';
import { attentionFor, type AttentionFacts } from './attention';
import { parseReviewFacts, reviewFactsColumns, reviewGate, type ReviewFactsRow } from './reviewGate';

export const REVIEW_BUDGETS = { maxHunkFiles: 300, maxUnits: 5000, maxInlineHunkLines: 4000 } as const;
export const REVIEW_GUIDE_PATH = '.kvarm/review.json';
export const FINDING_CATEGORIES = ['bug', 'risk', 'security', 'breaking', 'maintainability', 'question'] as const;
export const FINDING_SEVERITIES = ['high', 'medium', 'low'] as const;
export const FINDING_CONFIDENCES = ['confirmed', 'investigate'] as const;
export const FINDING_STATUSES = ['open', 'resolved', 'irrelevant', 'wont-fix'] as const;

type FindingCategory = (typeof FINDING_CATEGORIES)[number];
type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];
type FindingStatus = (typeof FINDING_STATUSES)[number];

const SHA_RE = /^[0-9a-f]{40}$/;
const fail = <T>(status: number, error: string, code: string): ServiceResult<T> => ({ ok: false, status, error, code });

export interface GuideChange extends Pick<ChangeRow, 'id' | 'number' | 'title' | 'base_ref' | 'head_ref' | 'head_sha' | 'base_sha' | 'state' | 'author_id' | 'agent_meta' | 'merge_policy' | 'risk_level' | 'updated_at'> {}

interface CoverageBuild {
  change: GuideChange;
  baseTree: string;
  headTree: string;
  map: CoverageMap;
  compare: CompareBody;
  configError?: string;
  configSha: string;
  truncated: boolean;
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

async function blobShaAt(artifacts: LazyRepo, tree: string, path: string): Promise<string | null> {
  const parts = path.split('/');
  let current = tree;
  const repo = await artifacts.get();
  for (let index = 0; index < parts.length; index++) {
    const entry = (await repo.readTree(current))?.find((candidate) => candidate.name === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) return entry.hash;
    current = entry.hash;
  }
  return null;
}

async function reviewConfigAt(
  artifacts: LazyRepo,
  baseSha: string,
  baseTree: string,
): Promise<{ config: ReviewConfig; configSha: string; configError?: string }> {
  const sha = await blobShaAt(artifacts, baseTree, REVIEW_GUIDE_PATH);
  if (!sha) return { config: {}, configSha: 'none' };
  const blob = await (await artifacts.get()).readFile({ ref: baseSha, path: REVIEW_GUIDE_PATH });
  if (!blob) return { config: {}, configSha: sha, configError: `${REVIEW_GUIDE_PATH} could not be read at the base commit` };
  if (blob.size > 65_536) return { config: {}, configSha: sha, configError: `${REVIEW_GUIDE_PATH} is too large` };
  const parsed = parseReviewConfig(await blob.text());
  return parsed.ok ? { config: parsed.value, configSha: sha } : { config: {}, configSha: sha, configError: parsed.error };
}

function receiptEligible(file: CompareFile): boolean {
  return file.status === 'removed' || file.risk.tags.some((tag) => tag === 'lockfile' || tag === 'generated' || tag === 'mechanical');
}

async function computeMap(
  cx: ChangeContext,
  ctx: ResolveContext,
  change: GuideChange,
  compare: CompareBody,
  config: ReviewConfig,
): Promise<{ map: CoverageMap; truncated: boolean }> {
  const protectedTarget = effectivePolicy(cx.branchRules ?? [], branchRef(change.base_ref)).protected;
  const files: CoverageFileInput[] = [];
  let materializedFiles = 0;
  let materializedUnits = 0;
  let truncated = compare.truncated;
  for (const entry of compare.files) {
    const base: CoverageFileInput = {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      status: entry.status,
      oldHash: entry.oldHash,
      newHash: entry.newHash,
      additions: entry.additions,
      deletions: entry.deletions,
      tags: entry.risk.tags as CoverageFileInput['tags'],
      hunks: null,
      protected: protectedTarget,
    };
    if (receiptEligible(entry) || entry.binary || entry.tooLarge) {
      files.push(base);
      continue;
    }
    if (materializedFiles >= REVIEW_BUDGETS.maxHunkFiles) {
      files.push({ ...base, truncated: true });
      truncated = true;
      continue;
    }
    materializedFiles++;
    const diff = await cachedFileDiff(ctx, entry);
    if (diff.binary || diff.tooLarge || materializedUnits + diff.hunks.length > REVIEW_BUDGETS.maxUnits) {
      files.push({ ...base, truncated: materializedUnits + diff.hunks.length > REVIEW_BUDGETS.maxUnits });
      if (materializedUnits + diff.hunks.length > REVIEW_BUDGETS.maxUnits) truncated = true;
      continue;
    }
    materializedUnits += diff.hunks.length;
    files.push({ ...base, hunks: diff.hunks, ...(diff.truncated ? { truncated: true } : {}) });
    truncated ||= diff.truncated === true;
  }
  const map = await buildCoverage(files, config);
  const overUnitBudget = map.units.length > REVIEW_BUDGETS.maxUnits;
  const boundedMap = overUnitBudget ? { ...map, units: map.units.slice(0, REVIEW_BUDGETS.maxUnits) } : map;
  return {
    map: { ...boundedMap, truncated: map.truncated || truncated || overUnitBudget },
    truncated: map.truncated || truncated || overUnitBudget,
  };
}

async function coverageBuild(cx: ChangeContext, change: GuideChange): Promise<ServiceResult<CoverageBuild>> {
  if (!change.head_sha || !change.base_sha) return fail(409, 'change has no base or head commit', 'NO_HEAD');
  return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
    const ctx = resolveCtx(cx, artifacts);
    const [base, head] = await Promise.all([readCommitInfo(ctx, change.base_sha!), readCommitInfo(ctx, change.head_sha!)]);
    if (!base || !head) return fail(503, 'change commits could not be read, retry shortly', 'STORAGE_UNAVAILABLE');
    const config = await reviewConfigAt(artifacts, change.base_sha!, base.tree);
    const cacheKey = compareKeys.reviewmap(base.tree, head.tree, config.configSha);
    const cached = await readJson<{ map: CoverageMap; truncated: boolean }>(cacheKey);
    let result: { map: CoverageMap; truncated: boolean };
    let compare: CompareBody;
    if (cached) {
      result = cached;
      const pair = await treePairBody(ctx, base.tree, head.tree);
      compare = pair.body;
    } else {
      const pair = await treePairBody(ctx, base.tree, head.tree);
      compare = pair.body;
      result = await computeMap(cx, ctx, change, compare, config.config);
      cx.waitUntil(writeJson(cacheKey, JSON.stringify(result)));
    }
    return {
      ok: true,
      value: {
        change,
        baseTree: base.tree,
        headTree: head.tree,
        map: result.map,
        compare,
        ...(config.configError ? { configError: config.configError } : {}),
        configSha: config.configSha,
        truncated: result.truncated,
      },
    };
  });
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

export async function coverageFor(cx: ChangeContext, change: GuideChange): Promise<ServiceResult<CoverageBuild>> {
  return coverageBuild(cx, change);
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

async function resolveGuide(
  cx: ChangeContext,
  coverage: CoverageBuild,
): Promise<{ guide: ResolvedGuide; source: ResolvedGuide['source']; fromHead?: string; guideRow: GuideRow | null; gaps: string[]; raised: unknown[]; undeclared: string[] }> {
  const db = cx.env.DB;
  const change = coverage.change;
  const current = await db.prepare(
    `SELECT id, head_sha, source, user_id, agent_id, token_id, body, gaps, undeclared, created_at
       FROM review_guides WHERE change_set_id = ?1 AND head_sha = ?2 ORDER BY source`,
  ).bind(change.id, change.head_sha).all<GuideRow>();
  const rows = current.results ?? [];
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
  const older = await db.prepare(
    `SELECT id, head_sha, source, user_id, agent_id, token_id, body, gaps, undeclared, created_at
       FROM review_guides WHERE change_set_id = ?1 AND head_sha != ?2
       ORDER BY (source = 'author') DESC, created_at DESC LIMIT 50`,
  ).bind(change.id, change.head_sha).all<GuideRow>();
  const prior = (older.results ?? [])
    .map((row) => ({ row, guide: guideRowGuide(row, coverage.map) }))
    .find((value) => value.guide !== null);
  if (prior?.guide) {
    const carried = carryGuide(prior.guide, coverage.map);
    const declared = carried.contracts ?? [];
    const undeclared = coverage.map.contracts.filter((path) => !declared.some((item) => item.surface === path || item.surface.startsWith(`${path}#`)));
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
    undeclared: coverage.map.contracts,
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
    receipt?: string;
    acked: boolean;
    ackCount: number;
    hunks?: Hunk[];
  }>;
  contracts: { changed: string[]; declared: Array<{ surface: string; impact: string; note?: string }>; undeclared: string[] };
  findings: { open: number; resolved: number; items: Array<Record<string, unknown>> };
  attention: ReturnType<typeof attentionFor>;
  review: { satisfied: boolean; blockers: unknown[]; approvals: { count: number; required: number } };
  configError?: string;
  truncated: boolean;
  hunksTruncated?: boolean;
}

function declaredContracts(guide: ResolvedGuide, paths: string[]): string[] {
  return paths.filter((path) => (guide.contracts ?? []).some((item) => item.surface === path || item.surface.startsWith(`${path}#`)));
}

function currentAttentionFacts(change: GuideChange, blocking: number, guideRequired: boolean, guidePresent: boolean, undeclared: number): AttentionFacts {
  return {
    state: change.state,
    escalations: [],
    checksPending: false,
    checksFailing: false,
    blockingFindings: blocking,
    requestChanges: false,
    guideRequired,
    guidePresent,
    undeclared,
    approvals: 0,
    required: 0,
    humans: 0,
    humansRequired: 0,
    mergePolicy: change.merge_policy,
  };
}

export async function getGuide(
  cx: ChangeContext,
  rawNumber: string,
  query: GuideQuery = {},
): Promise<ServiceResult<ReviewGuideView>> {
  if (query.since !== undefined && !SHA_RE.test(query.since)) return fail(400, 'since must be a full 40-character commit SHA', 'INVALID_SINCE');
  if (query.include !== undefined && query.include !== 'hunks') return fail(400, 'include must be "hunks"', 'INVALID_INCLUDE');
  if (query.unacked !== undefined && query.unacked !== 'true' && query.unacked !== 'false') {
    return fail(400, 'unacked must be true or false', 'INVALID_UNACKED');
  }
  const changeResult = await findChange(cx, rawNumber);
  if (!changeResult.ok) return changeResult;
  const coverage = await coverageFor(cx, changeResult.value);
  if (!coverage.ok) return coverage;
  const built = coverage.value;
  if (!built.change.head_sha || !built.change.base_sha) return fail(409, 'change has no base or head commit', 'NO_HEAD');
  const selected = await resolveGuide(cx, built);
  const mine = cx.actor ? actorPrincipal(cx.actor).id : null;
  const ackRows = await cx.env.DB.prepare(
    `SELECT unit_key, COUNT(*) AS ack_count, MAX(CASE WHEN principal = ?2 THEN 1 ELSE 0 END) AS mine
       FROM review_acks WHERE change_set_id = ?1 GROUP BY unit_key`,
  ).bind(built.change.id, mine).all<{ unit_key: string; ack_count: number; mine: number }>();
  const ackMap = new Map((ackRows.results ?? []).map((row) => [row.unit_key, row]));
  let sinceKeys: Set<string> | null = null;
  if (query.since !== undefined) {
    const previous = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx(cx, artifacts);
      const [priorCommit, baseCommit] = await Promise.all([
        readCommitInfo(ctx, query.since!),
        readCommitInfo(ctx, built.change.base_sha!),
      ]);
      if (!priorCommit) return { error: 'SINCE_NOT_FOUND' as const };
      if (!baseCommit) return { error: 'STORAGE_UNAVAILABLE' as const };
      const earlier = (await treePairBody(ctx, baseCommit.tree, priorCommit.tree)).body;
      const config = await reviewConfigAt(artifacts, built.change.base_sha!, baseCommit.tree);
      const previousFiles: CoverageFileInput[] = [];
      let hunkFiles = 0;
      for (const file of earlier.files) {
        const input: CoverageFileInput = {
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
          oldHash: file.oldHash,
          newHash: file.newHash,
          additions: file.additions,
          deletions: file.deletions,
          tags: file.risk.tags as CoverageFileInput['tags'],
          hunks: null,
        };
        if (receiptEligible(file) || file.binary || file.tooLarge || hunkFiles >= REVIEW_BUDGETS.maxHunkFiles) {
          previousFiles.push(input);
          continue;
        }
        hunkFiles++;
        const diff = await cachedFileDiff(ctx, file);
        previousFiles.push({ ...input, hunks: diff.hunks, ...(diff.truncated ? { truncated: true } : {}) });
      }
      return { map: await buildCoverage(previousFiles, config.config) };
    });
    if ('error' in previous) return previous.error === 'SINCE_NOT_FOUND'
      ? fail(404, 'since commit not found', 'SINCE_NOT_FOUND')
      : fail(503, 'base commit could not be read', 'STORAGE_UNAVAILABLE');
    sinceKeys = new Set(previous.map.units.map((unit) => unit.key));
  }
  const visible = built.map.units.filter((unit) => {
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
        const file = built.compare.files.find((item) => item.path === unit.path);
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
      ...(unit.receipt ? { receipt: unit.receipt } : {}),
      acked: Boolean(ack?.mine),
      ackCount: Number(ack?.ack_count ?? 0),
    };
    if (query.include === 'hunks' && unit.kind === 'hunk' && includedInlineKeys.has(unit.key)) {
      const hunk = inlineByFile.get(unit.path)?.[unit.index];
      if (hunk) value.hunks = [hunk];
    }
    return value;
  });
  const declared = selected.guide.contracts ?? [];
  const undeclared = built.map.contracts.filter((path) => !declared.some((item) => item.surface === path || item.surface.startsWith(`${path}#`)));
  const policy = await cx.env.DB.prepare('SELECT guide_required, blocking_findings FROM review_policies WHERE repo_id = ?1').bind(cx.repo.id)
    .first<{ guide_required: number; blocking_findings: string }>();
  const validKeys = JSON.stringify(built.map.units.map((unit) => unit.key));
  if (built.map.units.length) {
    await cx.env.DB.prepare(
      `UPDATE review_findings SET last_seen_head = ?3
        WHERE change_set_id = ?1 AND unit_key IN (SELECT value FROM json_each(?2)) AND last_seen_head != ?3`,
    ).bind(built.change.id, validKeys, built.change.head_sha).run();
  }
  const findings = await cx.env.DB.prepare(
    `SELECT id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, status, principal, created_at, updated_at
       FROM review_findings WHERE change_set_id = ?1 AND (status = 'open' OR opened_head = ?2 OR last_seen_head = ?2)
       ORDER BY created_at DESC LIMIT 100`,
  ).bind(built.change.id, built.change.head_sha).all<FindingRow>();
  const items = (findings.results ?? []).map((row) => ({
    ...findingView(row),
    outdated: row.unit_key !== null && !built.map.units.some((unit) => unit.key === row.unit_key),
    blocking: isBlocking(row, policy?.blocking_findings ?? 'high-confirmed'),
  }));
  const blockingCount = await cx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM review_findings WHERE change_set_id = ?1 AND status = 'open'
       AND (?2 = 'high-confirmed' AND ((severity = 'high' AND confidence = 'confirmed') OR category = 'security'))`,
  ).bind(built.change.id, policy?.blocking_findings ?? 'high-confirmed').first<{ n: number }>();
  const blocking = Number(blockingCount?.n ?? 0);
  const openCount = await cx.env.DB.prepare(`SELECT COUNT(*) AS n FROM review_findings WHERE change_set_id = ?1 AND status = 'open'`)
    .bind(built.change.id).first<{ n: number }>();
  const guideRequired = Boolean(policy?.guide_required);
  const review = await readReviewSummary(cx, built.change);
  const attention = attentionFor({
    ...currentAttentionFacts(built.change, blocking, guideRequired, selected.guideRow?.head_sha === built.change.head_sha, undeclared.length),
    ...review.facts,
  });
  const reviews = { satisfied: review.satisfied, blockers: review.blockers, approvals: review.approvals };
  const out: ReviewGuideView = {
    number: built.change.number,
    headSha: built.change.head_sha,
    baseSha: built.change.base_sha,
    source: selected.source,
    ...(selected.fromHead ? { fromHead: selected.fromHead } : {}),
    guide: selected.guide,
    coverage: {
      units: built.map.units.length,
      guided: built.map.units.length - selected.gaps.length,
      gaps: selected.gaps.length,
      truncated: built.truncated,
    },
    units,
    contracts: { changed: built.map.contracts, declared: declaredContracts(selected.guide, built.map.contracts).map((path) => declared.find((item) => item.surface === path)!), undeclared },
    findings: { open: Number(openCount?.n ?? 0), resolved: (findings.results ?? []).filter((row) => row.status === 'resolved').length, items },
    attention,
    review: reviews,
    ...(built.configError ? { configError: built.configError } : {}),
    truncated: built.truncated,
    ...(hunksTruncated ? { hunksTruncated: true } : {}),
  };
  return { ok: true, value: out };
}

async function readReviewSummary(cx: ChangeContext, change: GuideChange): Promise<{ facts: Partial<AttentionFacts>; satisfied: boolean; blockers: unknown[]; approvals: { count: number; required: number } }> {
  const row = await cx.env.DB.prepare(
    `SELECT ${reviewFactsColumns('c')},
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS rv_checks_pending,
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS rv_checks_failing,
            EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS rv_request_changes
       FROM change_sets c WHERE c.id = ?1`,
  ).bind(change.id).first<ReviewFactsRow & { rv_checks_pending: number; rv_checks_failing: number; rv_request_changes: number }>();
  const facts = parseReviewFacts(row);
  const branchPolicy = effectivePolicy(cx.branchRules ?? [], branchRef(change.base_ref));
  const gate = reviewGate(facts, branchPolicy);
  const required = facts.required;
  const approvals = facts.approvals;
  return {
    facts: {
      escalations: facts.open,
      checksPending: Boolean(row?.rv_checks_pending),
      checksFailing: Boolean(row?.rv_checks_failing),
      requestChanges: Boolean(row?.rv_request_changes),
      blockingFindings: facts.blockingFindings,
      guideRequired: facts.guideRequired,
      guidePresent: facts.guidePresent,
      undeclared: facts.undeclared,
      approvals,
      required,
      humans: facts.humans,
      humansRequired: branchPolicy.requiredApprovals,
      mergePolicy: change.merge_policy,
    },
    satisfied: gate.block === null,
    blockers: gate.blockers,
    approvals: { count: approvals, required },
  };
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
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
  if (body.headSha !== change.value.head_sha) return fail(409, 'the change head moved; submit a guide for the current head', 'HEAD_MOVED');
  const built = await coverageFor(cx, change.value);
  if (!built.ok) return built;
  const validated = validateGuide(body.guide, built.value.map);
  if (!validated.ok) return fail(422, validated.error, validated.code);
  const source = authorPrincipal(change.value) === actorPrincipal(cx.actor).id ? 'author' : 'reviewer';
  const principal = actorPrincipal(cx.actor);
  const now = Date.now();
  const existing = await cx.env.DB.prepare('SELECT id FROM review_guides WHERE change_set_id = ?1 AND head_sha = ?2 AND source = ?3')
    .bind(change.value.id, body.headSha, source).first<{ id: string }>();
  const id = existing?.id ?? crypto.randomUUID();
  const json = JSON.stringify(body.guide);
  await cx.env.DB.prepare(
    `INSERT INTO review_guides (id, change_set_id, head_sha, source, user_id, agent_id, token_id, body, gaps, undeclared, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
     ON CONFLICT(change_set_id, head_sha, source) DO UPDATE SET user_id = excluded.user_id, agent_id = excluded.agent_id,
       token_id = excluded.token_id, body = excluded.body, gaps = excluded.gaps, undeclared = excluded.undeclared, created_at = excluded.created_at`,
  ).bind(id, change.value.id, body.headSha, source, principal.userId, principal.agentId, principal.tokenId, json, validated.gaps.length, validated.undeclared.length, now).run();
  const result = await getGuide(cx, rawNumber);
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
  const current = await getGuide(cx, rawNumber);
  if (!current.ok) return current;
  if (body.headSha !== current.value.headSha) return fail(409, 'the change head moved; acknowledge the current head', 'HEAD_MOVED');
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
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
  const principal = actorPrincipal(cx.actor);
  const unack = body.unack === true;
  const now = Date.now();
  const stmts = [...requested].map((key) => unack
    ? cx.env.DB.prepare('DELETE FROM review_acks WHERE change_set_id = ?1 AND principal = ?2 AND unit_key = ?3').bind(change.value.id, principal.id, key)
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
  const change = await findChange(cx, rawNumber);
  if (!change.ok) return change;
  if (body.headSha !== change.value.head_sha) return fail(409, 'the change head moved; submit findings for the current head', 'HEAD_MOVED');
  const built = await coverageFor(cx, change.value);
  if (!built.ok) return built;
  const principal = actorPrincipal(cx.actor);
  const created: Array<Record<string, unknown>> = [];
  const duplicates: string[] = [];
  const suppressed: string[] = [];
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
    const lineNumber = Number(value.startLine);
    const unit = built.value.map.units.find((candidate) => candidate.path === value.path && (candidate.kind === 'file' ||
      (side === 'head' ? lineNumber >= candidate.newStart && lineNumber <= candidate.newStart + candidate.newLines : lineNumber >= candidate.oldStart && lineNumber <= candidate.oldStart + candidate.oldLines)));
    const fingerprint = await findingFingerprint(value.category, value.path, value.title);
    const prior = await cx.env.DB.prepare(`SELECT id, status FROM review_findings WHERE change_set_id = ?1 AND fingerprint = ?2 AND status IN ('open', 'irrelevant')
      ORDER BY (status = 'open') DESC, created_at DESC LIMIT 1`)
      .bind(change.value.id, fingerprint).first<{ id: string; status: FindingStatus }>();
    if (prior?.status === 'open') {
      await cx.env.DB.prepare('UPDATE review_findings SET last_seen_head = ?2 WHERE id = ?1').bind(prior.id, body.headSha).run();
      duplicates.push(prior.id);
      continue;
    }
    if (prior?.status === 'irrelevant') {
      suppressed.push(prior.id);
      continue;
    }
    if (!unit) return fail(422, `findings[${index}] does not match a current coverage unit`, 'UNKNOWN_UNIT');
    const id = crypto.randomUUID();
    const now = Date.now();
    await cx.env.DB.prepare(
      `INSERT INTO review_findings (id, change_set_id, opened_head, last_seen_head, path, side, start_line, end_line, unit_key, category, severity, confidence, title, scenario, verify, body, fingerprint, status, principal, user_id, agent_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 'open', ?17, ?18, ?19, ?20, ?20)`,
    ).bind(id, change.value.id, body.headSha, value.path, side, lineNumber, value.endLine ?? null, unit.key, value.category, value.severity,
      value.confidence, value.title, value.scenario ?? null, value.verify ?? null, value.body ?? null, fingerprint, principal.id, principal.userId, principal.agentId, now).run();
    created.push({ id, path: value.path, unitKey: unit.key, category: value.category, severity: value.severity, confidence: value.confidence, title: value.title });
  }
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

interface AttentionRow extends ReviewFactsRow {
  id: string;
  number: number;
  title: string;
  state: string;
  base_ref: string;
  head_sha: string | null;
  author_id: string | null;
  agent_meta: string | null;
  merge_policy: string;
  risk_score: number | null;
  risk_level: string | null;
  created_at: number;
  updated_at: number | null;
  queue_state: string | null;
  rv_checks_pending: number;
  rv_checks_failing: number;
  rv_request_changes: number;
  rv_actor_reviewed: number;
}

export async function listAttention(
  cx: ChangeContext,
  query: { limit?: string; cursor?: string; mine?: string } = {},
): Promise<ServiceResult<{ changes: Array<Record<string, unknown>>; nextCursor: string | null; truncated: boolean }>> {
  const limit = query.limit === undefined ? 50 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail(400, 'limit must be an integer from 1 to 100', 'INVALID_LIMIT');
  if (query.mine !== undefined && query.mine !== 'true' && query.mine !== 'false') return fail(400, 'mine must be true or false', 'INVALID_MINE');
  let offset = 0;
  if (query.cursor !== undefined) {
    let decoded: string;
    try {
      decoded = atob(query.cursor);
    } catch {
      return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    }
    const match = /^v1:(\d+)$/.exec(decoded);
    if (!match) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    offset = Number(match[1]);
  }
  const f = reviewFactsColumns('c');
  const principal = cx.actor ? actorPrincipal(cx.actor).id : '';
  const rows = await cx.env.DB.prepare(
    `SELECT c.id, c.number, c.title, c.state, c.base_ref, c.head_sha, c.author_id, c.agent_meta, c.merge_policy, c.risk_score, c.risk_level,
            c.created_at, c.updated_at,
            (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1 LIMIT 1) AS queue_state,
            ${f},
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS rv_checks_pending,
            EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS rv_checks_failing,
            EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS rv_request_changes
            , EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.principal = ?2) AS rv_actor_reviewed
       FROM change_sets c WHERE c.repo_id = ?1 AND c.state IN ('open', 'conflicted')
       ORDER BY COALESCE(c.updated_at, c.created_at) ASC, c.number ASC LIMIT 501`,
  ).bind(cx.repo.id, principal).all<AttentionRow>();
  const all = rows.results ?? [];
  const bounded = all.slice(0, 500);
  const actor = cx.actor ? actorPrincipal(cx.actor).id : null;
  const changes = bounded.map((row) => {
    const review = parseReviewFacts(row);
    const branch = effectivePolicy(cx.branchRules ?? [], branchRef(row.base_ref));
    const facts: AttentionFacts = {
      state: row.state,
      escalations: review.open,
      checksPending: Boolean(row.rv_checks_pending),
      checksFailing: Boolean(row.rv_checks_failing),
      blockingFindings: review.blockingFindings ?? 0,
      requestChanges: Boolean(row.rv_request_changes),
      guideRequired: Boolean(review.guideRequired),
      guidePresent: Boolean(review.guidePresent),
      undeclared: review.undeclared ?? 0,
      approvals: review.approvals,
      required: review.required,
      humans: review.humans,
      humansRequired: branch.requiredApprovals,
      mergePolicy: row.merge_policy,
      queueState: row.queue_state,
    };
    const attention = attentionFor(facts);
    const isAuthor = authorPrincipal(row) === actor;
    const writable = cx.role === 'write' || cx.role === 'admin';
    const yourTurn =
      (attention.waitingOn === 'author' && isAuthor) ||
      (attention.waitingOn === 'human' && writable && cx.actor !== null && !cx.actor.agent) ||
      (attention.waitingOn === 'reviewers' && writable && actor !== null && !isAuthor && !row.rv_actor_reviewed);
    return {
      number: row.number,
      title: row.title,
      state: row.state,
      headSha: row.head_sha,
      attention,
      yourTurn,
      risk: { score: row.risk_score, level: row.risk_level },
      updatedAt: new Date(row.updated_at ?? row.created_at).toISOString(),
      review: { approvals: { count: review.approvals, required: review.required, humans: review.humans, humansRequired: branch.requiredApprovals } },
    };
  });
  changes.sort((a, b) => Number(b.yourTurn) - Number(a.yourTurn) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.number - b.number);
  const visible = query.mine === 'true' ? changes.filter((change) => change.yourTurn) : changes;
  const page = visible.slice(offset, offset + limit);
  const hasMore = visible.length > offset + limit;
  return {
    ok: true,
    value: {
      changes: page,
      nextCursor: hasMore ? btoa(`v1:${offset + limit}`).replace(/=+$/, '') : null,
      truncated: all.length > bounded.length,
    },
  };
}
