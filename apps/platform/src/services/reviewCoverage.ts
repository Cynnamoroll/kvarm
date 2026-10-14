import {
  buildCoverage,
  diffExports,
  extractExportSignatures,
  fallbackGuide,
  isCodePath,
  isContractPath,
  parseReviewConfig,
  type CoverageFileInput,
  type CoverageMap,
  type ExportBreak,
  type ResolvedGuide,
  type ReviewTier,
} from '@kvarm/review';
import { detectMoves } from '@kvarm/diffcore';
import { sha256Hex } from '@kvarm/gitops';
import type { RepoRow } from '../db/repos';
import { readFileAt, withLazyRepo } from '../artifacts/repo';
import { compareKeys, readJson, writeJson } from '../cache/compare';
import { compareChange } from './changeDiff';
import * as compare from './compare';
import type { ResolveContext } from './refs';

const COVERAGE_FILES = 30;
const COVERAGE_BYTES = 512 * 1024;
const CONFIG_BYTES = 64 * 1024;
const EXPORT_FILES = 50;
const EXPORT_BYTES = 512 * 1024;

export interface CoverageChange {
  id: string;
  base: string;
}

export interface HeadCoverage {
  response: compare.CompareResponse | null;
  map: CoverageMap | null;
  guide: ResolvedGuide | null;
  configSha: string;
  baseTree: string | null;
  headTree: string | null;
  configError: string | null;
  invalidConfig: boolean;
  error: string | null;
}

export interface HeadTier {
  maxTier: ReviewTier;
  truncated: boolean;
  recorded: boolean;
}

interface CoverageCache {
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

export async function headCoverage(
  env: Env,
  repo: RepoRow,
  change: CoverageChange,
  headSha: string,
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
): Promise<HeadCoverage> {
  try {
    const diff = await compareChange(env, repo, { base: change.base }, headSha, waitUntil);
    if (!diff.ok) return {
      response: null, map: null, guide: null, configSha: 'none', baseTree: null, headTree: null,
      configError: null, invalidConfig: false, error: diff.error,
    };
    const response = diff.value.response;
    const cacheKey = compareKeys.reviewmapHead(change.id, change.base, headSha);
    const cached = await readJson<CoverageCache>(cacheKey);
    if (
      cached?.baseSha === change.base &&
      cached.headSha === headSha &&
      Array.isArray(cached.map?.units) &&
      cached.baseTree === response.base.tree &&
      cached.headTree === response.head.tree
    ) {
      return {
        response,
        map: cached.map,
        guide: fallbackGuide(cached.map),
        configSha: cached.configSha,
        baseTree: cached.baseTree,
        headTree: cached.headTree,
        configError: cached.configError ?? null,
        invalidConfig: cached.invalidConfig === true,
        error: null,
      };
    }
    const inputs: CoverageFileInput[] = [];
    let reads = 0;
    let usedBytes = 0;
    let exhausted = response.truncated || response.nextCursor !== undefined;
    for (const file of response.files) {
      let hunks: CoverageFileInput['hunks'] = null;
      let truncated = false;
      if (!file.binary && !file.tooLarge && !exhausted && reads < COVERAGE_FILES) {
        const found = await compare.fileDiff(
          { env, repo, bypass: false, waitUntil },
          change.base,
          headSha,
          file.path,
        );
        reads++;
        if (found.ok && !found.value.response.binary && !found.value.response.tooLarge) {
          const size = new TextEncoder().encode(JSON.stringify(found.value.response.hunks)).byteLength;
          if (usedBytes + size <= COVERAGE_BYTES) {
            hunks = found.value.response.hunks;
            usedBytes += size;
            truncated = found.value.response.truncated === true;
          } else {
            truncated = true;
            exhausted = true;
          }
        } else if (!found.ok) {
          truncated = true;
          exhausted = true;
        }
      } else if (file.tooLarge) {
        truncated = true;
        exhausted = true;
      } else if (!file.binary) {
        truncated = true;
        exhausted = true;
      }
      inputs.push({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        oldHash: file.oldHash,
        newHash: file.newHash,
        additions: file.additions,
        deletions: file.deletions,
        tags: file.risk.tags,
        hunks,
        ...(truncated ? { truncated: true } : {}),
      });
    }
    let config: Parameters<typeof buildCoverage>[1] = {};
    let configError: string | null = null;
    let invalidConfig = false;
    let configSha = 'none';
    try {
      const blob = await readFileAt(env, repo.artifacts_name, headSha, '.kvarm/review.json');
      if (blob) {
        if (blob.size > CONFIG_BYTES) {
          configError = '.kvarm/review.json exceeds the 64 KiB config limit; default review tiers are used.';
          invalidConfig = true;
          configSha = `oversize-${blob.size}`;
        } else {
          const text = await blob.text();
          configSha = await sha256Hex(text);
          const parsed = parseReviewConfig(text);
          if (parsed.ok) config = parsed.value;
          else {
            configError = `${parsed.error}; default review tiers are used.`;
            invalidConfig = true;
          }
        }
      }
    } catch {
      configError = 'Could not read .kvarm/review.json; default review tiers are used.';
      invalidConfig = true;
    }
    const moves = detectMoves(inputs.flatMap((file) => file.hunks ? [{ path: file.path, hunks: file.hunks }] : []));
    const filesWithMoves = inputs.map((file) => {
      const fileMoves = moves.filter((move) => move.from.path === file.path || move.to.path === file.path);
      return fileMoves.length ? { ...file, moves: fileMoves } : file;
    });
    const breaks: ExportBreak[] = [];
    let exportFiles = 0;
    let exportBytes = 0;
    let exportTruncated = false;
    await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const context: ResolveContext = { env, repo, artifacts, bypass: false, waitUntil };
      for (const file of response.files) {
        const exportSurface =
          (isCodePath(file.path) && isContractPath(file.path, config.contracts)) ||
          Boolean(file.oldPath && isCodePath(file.oldPath) && isContractPath(file.oldPath, config.contracts));
        if (!exportSurface || file.binary || file.tooLarge) continue;
        if (exportFiles >= EXPORT_FILES || exportBytes >= EXPORT_BYTES) {
          exportTruncated = true;
          continue;
        }
        exportFiles++;
        const remaining = EXPORT_BYTES - exportBytes;
        const material = await compare.cachedFileDiffWithTexts(context, file, Math.floor(remaining / 2));
        if (material.oldText === undefined || material.newText === undefined || material.body.tooLarge) {
          exportTruncated = true;
          continue;
        }
        const size = new TextEncoder().encode(material.oldText).byteLength + new TextEncoder().encode(material.newText).byteLength;
        if (size > remaining) {
          exportTruncated = true;
          continue;
        }
        exportBytes += size;
        const before = extractExportSignatures(file.oldPath ?? file.path, material.oldText);
        const after = extractExportSignatures(file.path, material.newText);
        if (before.truncated || after.truncated) exportTruncated = true;
        breaks.push(...diffExports(before, after).map((item) => ({ path: file.path, ...item })));
      }
    });
    const map = await buildCoverage(filesWithMoves, config);
    map.breaks = breaks.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    if (response.truncated || response.nextCursor !== undefined || exportTruncated) map.truncated = true;
    const cache: CoverageCache = {
      baseSha: change.base,
      headSha,
      baseTree: response.base.tree,
      headTree: response.head.tree,
      configSha,
      map,
      truncated: map.truncated,
      invalidConfig,
      ...(configError ? { configError } : {}),
      changedPaths: response.files.flatMap((file) => file.oldPath ? [file.path, file.oldPath] : [file.path]),
    };
    waitUntil(writeJson(cacheKey, JSON.stringify(cache)));
    return {
      response,
      map,
      guide: fallbackGuide(map),
      configSha,
      baseTree: response.base.tree,
      headTree: response.head.tree,
      configError,
      invalidConfig,
      error: null,
    };
  } catch (error) {
    return {
      response: null, map: null, guide: null, configSha: 'none', baseTree: null, headTree: null,
      configError: null, invalidConfig: false, error: String(error),
    };
  }
}

function maxTier(coverage: HeadCoverage): { maxTier: ReviewTier; truncated: boolean } {
  const truncated = coverage.map?.truncated === true;
  if (!coverage.map || !coverage.guide || coverage.invalidConfig || truncated) return { maxTier: 'scrutinize', truncated };
  const order: Record<ReviewTier, number> = { receipt: 0, read: 1, scrutinize: 2 };
  const tier = Object.values(coverage.guide.tiers).reduce<ReviewTier>(
    (highest, current) => order[current] > order[highest] ? current : highest,
    'receipt',
  );
  return { maxTier: tier, truncated };
}

export async function recordHeadTier(
  env: Env,
  repo: RepoRow,
  change: CoverageChange,
  headSha: string,
  coverage?: HeadCoverage,
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
): Promise<HeadTier> {
  try {
    const existing = await env.DB.prepare(
      'SELECT max_tier, truncated FROM change_head_tiers WHERE change_set_id = ? AND head_sha = ?',
    ).bind(change.id, headSha).first<{ max_tier: ReviewTier; truncated: number }>();
    if (existing) return { maxTier: existing.max_tier, truncated: existing.truncated === 1, recorded: true };
    const resolved = coverage ?? await headCoverage(env, repo, change, headSha, waitUntil);
    const tier = maxTier(resolved);
    await env.DB.prepare(
      `INSERT INTO change_head_tiers (change_set_id, head_sha, max_tier, truncated, computed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (change_set_id, head_sha) DO NOTHING`,
    ).bind(change.id, headSha, tier.maxTier, tier.truncated ? 1 : 0, Date.now()).run();
    return { ...tier, recorded: true };
  } catch {
    return { maxTier: 'scrutinize', truncated: coverage?.map?.truncated === true, recorded: false };
  }
}
