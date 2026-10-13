import { extractReviewImports, isCodePath, isTestPath, resolveSpecifier, type ReviewImport } from '@kvarm/review';
import { withLazyRepo } from '../artifacts/repo';
import { compareKeys, readJson, writeJson } from '../cache/compare';
import type { ServiceResult } from '../repos/service';
import { coverageForNumber, type CoverageBuild } from './reviewGuide';
import type { ChangeContext } from './changes';
import { changedPaths, readBlobBytes } from './compare';
import type { ResolveContext } from './refs';

const MAX_TREE_ENTRIES = 20_000;
const MAX_CODE_FILES = 3_000;
const MAX_BLOB_READS = 400;
const MAX_BLOB_BYTES = 512 * 1024;
const TREE_MODE = /^0?40000$/;

interface Consumer {
  path: string;
  line: number;
  specifier: string;
  names?: string[];
  test: boolean;
}

interface AffectedConsumer extends Consumer {
  name: string;
}

export interface ReviewImpactFile {
  path: string;
  consumers: Consumer[];
  affected: AffectedConsumer[];
  tests: string[];
  truncated: boolean;
}

export interface ReviewImpactView {
  files: ReviewImpactFile[];
  truncated: boolean;
  truncatedReason?: string;
}

interface ImportCacheEntry {
  imports: ReviewImport[];
  manifest?: Record<string, unknown> | null;
}

interface Budget {
  blobReads: number;
  codeFiles: number;
  treeEntries: number;
  truncatedReasons: Set<string>;
  entries: Map<string, ImportCacheEntry>;
}

function decode(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  return new TextDecoder('utf-8').decode(bytes);
}

function importContext(cx: ChangeContext, artifacts: ResolveContext['artifacts']): ResolveContext {
  return { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
}

async function headFiles(
  ctx: ResolveContext,
  tree: string,
  budget: Budget,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const repo = await ctx.artifacts.get();
  const stack: Array<{ path: string; sha: string }> = [{ path: '', sha: tree }];
  while (stack.length && budget.treeEntries < MAX_TREE_ENTRIES) {
    const current = stack.pop()!;
    const entries = await repo.readTree(current.sha);
    if (!entries) continue;
    for (const entry of entries) {
      if (++budget.treeEntries > MAX_TREE_ENTRIES) {
        budget.truncatedReasons.add('tree-entry-budget');
        return result;
      }
      const path = current.path ? `${current.path}/${entry.name}` : entry.name;
      if (TREE_MODE.test(entry.mode)) stack.push({ path, sha: entry.hash });
      else result.set(path, entry.hash);
    }
  }
  if (stack.length) budget.truncatedReasons.add('tree-entry-budget');
  return result;
}

function workspacePatterns(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (value && typeof value === 'object' && Array.isArray((value as { packages?: unknown }).packages)) {
    return (value as { packages: unknown[] }).packages.filter((item): item is string => typeof item === 'string');
  }
  return [];
}

function workspaceAllowed(directory: string, patterns: string[]): boolean {
  const candidates = patterns.length ? patterns : ['packages/*'];
  const directoryParts = directory.split('/');
  return candidates.some((pattern) => {
    const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!normalized) return false;
    const patternParts = normalized.split('/');
    const recursive = patternParts.at(-1) === '**';
    if (recursive) patternParts.pop();
    if (directoryParts.length < patternParts.length) return false;
    if (!recursive && directoryParts.length !== patternParts.length) return false;
    return patternParts.every((part, index) => part === '*' || part === directoryParts[index]);
  });
}

function packageEntry(directory: string, manifest: Record<string, unknown>): string {
  const exports = manifest.exports;
  const rootExport = exports && typeof exports === 'object' && !Array.isArray(exports)
    ? (exports as Record<string, unknown>)['.']
    : undefined;
  const target = typeof rootExport === 'string'
    ? rootExport
    : rootExport && typeof rootExport === 'object'
      ? ['types', 'import', 'default', 'require'].map((key) => (rootExport as Record<string, unknown>)[key]).find((value) => typeof value === 'string')
      : manifest.main;
  const relative = typeof target === 'string' ? target : 'src/index.ts';
  const parts = relative.replace(/^\.\//, '').split('/');
  if (relative.startsWith('/') || parts.includes('..')) return `${directory}/src/index.ts`;
  return `${directory}/${parts.join('/')}`;
}

async function loadBlobEntry(
  ctx: ResolveContext,
  path: string,
  sha: string,
  budget: Budget,
): Promise<ImportCacheEntry | null> {
  const local = budget.entries.get(sha);
  if (local) return local;
  const key = compareKeys.imports(sha);
  const cached = await readJson<ImportCacheEntry>(key);
  if (cached && Array.isArray(cached.imports)) {
    budget.entries.set(sha, cached);
    return cached;
  }
  if (budget.blobReads >= MAX_BLOB_READS) {
    budget.truncatedReasons.add('blob-read-budget');
    return null;
  }
  const bytes = await readBlobBytes(ctx.artifacts, sha, budget, MAX_BLOB_BYTES);
  if (!bytes || 'tooLarge' in bytes) {
    budget.truncatedReasons.add('blob-size-budget');
    return null;
  }
  const text = decode(bytes.bytes);
  if (text === null) {
    const value = { imports: [] };
    budget.entries.set(sha, value);
    return value;
  }
  let manifest: Record<string, unknown> | null | undefined;
  if (/(^|\/)package\.json$/.test(path)) {
    try {
      const parsed: unknown = JSON.parse(text);
      manifest = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      manifest = null;
    }
  }
  const value: ImportCacheEntry = {
    imports: isCodePath(path) ? extractReviewImports(text) : [],
    ...(manifest !== undefined ? { manifest } : {}),
  };
  budget.entries.set(sha, value);
  ctx.waitUntil(writeJson(key, JSON.stringify(value)));
  return value;
}

async function computeImpact(cx: ChangeContext, built: CoverageBuild): Promise<ReviewImpactView> {
  const budget: Budget = { blobReads: 0, codeFiles: 0, treeEntries: 0, truncatedReasons: new Set(), entries: new Map() };
  const importEntries = new Map<string, ReviewImport[]>();
  const workspaces = new Map<string, string>();
  let output: ReviewImpactView | undefined;
  await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
    const ctx = importContext(cx, artifacts);
    let changed: string[];
    if (built.compare) {
      changed = [...new Set(built.compare.files.flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path])))];
      if (built.compare.truncated) budget.truncatedReasons.add('compare-budget');
    } else if (built.pointer.changedPaths) {
      changed = [...new Set(built.pointer.changedPaths)];
    } else {
      const diff = await changedPaths(ctx, built.baseTree, built.headTree);
      changed = [...new Set(diff.paths)];
      if (diff.truncated) budget.truncatedReasons.add('compare-budget');
    }
    const files = await headFiles(ctx, built.headTree, budget);
    const fileSet = new Set(files.keys());
    for (const path of changed) fileSet.add(path);
    const rootSha = files.get('package.json');
    const rootManifest = rootSha ? await loadBlobEntry(ctx, 'package.json', rootSha, budget) : null;
    const declaredPatterns = workspacePatterns(rootManifest?.manifest?.workspaces);
    const patterns = declaredPatterns.length ? declaredPatterns : ['packages/*'];
    for (const [path, sha] of files) {
      const entry = { path, sha };
      if (path.endsWith('/package.json')) {
        const directory = path.slice(0, -'/package.json'.length);
        if (workspaceAllowed(directory, patterns)) {
          const loaded = await loadBlobEntry(ctx, path, sha, budget);
          const manifest = loaded?.manifest;
          const packageName = manifest?.name;
          if (manifest && typeof packageName === 'string') workspaces.set(packageName, packageEntry(directory, manifest));
        }
      }
      if (!isCodePath(entry.path)) continue;
      if (budget.codeFiles >= MAX_CODE_FILES) {
        budget.truncatedReasons.add('code-file-budget');
        continue;
      }
      budget.codeFiles++;
      const loaded = await loadBlobEntry(ctx, entry.path, entry.sha, budget);
      if (!loaded) continue;
      importEntries.set(entry.path, loaded.imports);
    }
    const changedSet = new Set(changed);
    const consumerMap = new Map<string, Consumer[]>();
    const consumerOverflow = new Set<string>();
    for (const [source, imports] of importEntries) {
      for (const item of imports) {
        const target = resolveSpecifier(source, item.specifier, fileSet, workspaces);
        if (!target || !changedSet.has(target)) continue;
        let consumers = consumerMap.get(target);
        if (!consumers) {
          consumers = [];
          consumerMap.set(target, consumers);
        }
        if (consumers.length >= 50) {
          consumerOverflow.add(target);
          budget.truncatedReasons.add('consumer-budget');
          continue;
        }
        consumers.push({
          path: source,
          line: item.line,
          specifier: item.specifier,
          ...(item.names ? { names: item.names } : {}),
          test: isTestPath(source),
        });
      }
    }
    const breakNames = new Map<string, string[]>();
    for (const item of built.map.breaks ?? []) {
      if (item.change === 'added') continue;
      const names = breakNames.get(item.path) ?? [];
      names.push(item.name);
      breakNames.set(item.path, names);
    }
    const results: ReviewImpactFile[] = [];
    for (const path of changed) {
      const allConsumers = consumerMap.get(path) ?? [];
      const consumers = allConsumers;
      const breaks = breakNames.get(path) ?? [];
      const affected: AffectedConsumer[] = [];
      for (const consumer of allConsumers) {
        const names = consumer.names;
        for (const name of breaks) {
          if (!names || names.includes('*') || names.includes(name)) affected.push({ ...consumer, name });
        }
      }
      const affectedTruncated = affected.length > 50;
      const tests = [...new Set(consumers.filter((consumer) => consumer.test).map((consumer) => consumer.path))].sort();
      const fileTruncated = consumerOverflow.has(path) || affectedTruncated;
      if (affectedTruncated) budget.truncatedReasons.add('consumer-budget');
      results.push({
        path,
        consumers,
        affected: affected.slice(0, 50),
        tests,
        truncated: fileTruncated,
      });
    }
    const result: ReviewImpactView = {
      files: results,
      truncated: budget.truncatedReasons.size > 0,
      ...(budget.truncatedReasons.size ? { truncatedReason: [...budget.truncatedReasons].join(',') } : {}),
    };
    const key = compareKeys.reviewImpact(built.baseTree, built.headTree, built.configSha);
    ctx.waitUntil(writeJson(key, JSON.stringify(result)));
    output = result;
  });
  return output ?? { files: [], truncated: true, truncatedReason: 'unavailable' };
}

export async function getReviewImpact(
  cx: ChangeContext,
  rawNumber: string,
): Promise<ServiceResult<ReviewImpactView>> {
  const built = await coverageForNumber(cx, rawNumber);
  if (!built.ok) return built;
  const key = compareKeys.reviewImpact(built.value.baseTree, built.value.headTree, built.value.configSha);
  const cached = await readJson<ReviewImpactView>(key);
  if (cached) return { ok: true, value: cached };
  return { ok: true, value: await computeImpact(cx, built.value) };
}
