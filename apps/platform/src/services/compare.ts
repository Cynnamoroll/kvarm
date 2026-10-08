/**
 * Compare and per-file diffs over Artifacts (architecture §4, §5, §9).
 *
 * `base...head` is a direct two-tree diff (`git diff base head`), not git's
 * merge-base syntax. Refs resolve to trees (services/refs.ts); the changed
 * file list comes from gitops `diffTrees` over one lazily opened repo handle;
 * per-file line counts are included when at most STATS_MAX_FILES changed.
 * Compare bodies are cached by tree pair and file diffs by blob pair, both
 * immutable; ref fields are rendered per request. Every caller has already
 * passed the authoritative repo lookup (authorizeRoute) before reaching here.
 */

import { diffTrees, type TreeChange, type TreeEntry, type TreeReader } from '@forge/gitops';
import { diffOps, diffToHunks, isBinaryContent, limitHunks, type Hunk } from '@forge/diffcore';
import type { RepoRow } from '../db/repos';
import { withLazyRepo, type LazyRepo } from '../artifacts/repo';
import { markCache } from '../cost/meter';
import { compareKeys, readJson, writeJson } from '../cache/compare';
import type { ServiceResult } from '../repos/service';
import { assessRisk, type ChangeRating, type FileRisk } from './risk';
import {
  EMPTY_TREE,
  RefStoreUnavailable,
  isFullSha,
  isValidRefName,
  readCommitAndParent,
  resolveCommitish,
  type ResolveContext,
} from './refs';

/**
 * Per-request work budgets. Each tree read and blob read is one Artifacts RPC,
 * so the read budgets keep a compare well inside the Workers subrequest limit.
 */
export const COMPARE_BUDGETS = {
  maxTreeReads: 2_000,
  maxChanges: 20_000,
  treeConcurrency: 16,
  statsMaxFiles: 300,
  /** Per-file size cap for line counts and file diffs (pinned 4 MB, architecture §9). */
  maxBlobBytes: 4 * 1024 * 1024,
  /** Total blob bytes read for line counts in one compare. */
  statsMaxTotalBytes: 64 * 1024 * 1024,
  blobConcurrency: 6,
  /** File-diff output bounds (the counts still cover the whole file). */
  fileMaxLines: 10_000,
  fileMaxBytes: 1_000_000,
} as const;

export type CacheOutcome = 'hit' | 'miss' | 'bypass';

export interface CompareFile {
  path: string;
  status: TreeChange['status'];
  oldPath?: string;
  oldHash: string | null;
  newHash: string | null;
  oldMode: string | null;
  newMode: string | null;
  additions?: number;
  deletions?: number;
  binary?: true;
  tooLarge?: true;
  approximate?: true;
  risk: FileRisk;
}

/** The content-addressed body stored under treediff/<baseTree>/<headTree>. */
export interface CompareBody {
  files: CompareFile[];
  totals: { files: number; additions: number | null; deletions: number | null };
  rating: ChangeRating;
  truncated: boolean;
  truncatedReason?: string;
  statsOmitted?: true;
  treeReads: number;
}

export interface RefView {
  ref: string | null;
  sha: string | null;
  tree: string;
}

export interface CompareResponse {
  base: RefView;
  head: RefView;
  files: CompareFile[];
  totals: CompareBody['totals'];
  rating: ChangeRating;
  truncated: boolean;
  truncatedReason?: string;
  statsOmitted?: true;
  treeReads: number;
  nextCursor?: string;
}

export interface FileDiffBody {
  hunks: Hunk[];
  totalAdditions?: number;
  totalDeletions?: number;
  approximate: boolean;
  binary?: true;
  tooLarge?: true;
  /** Hunks were cut at the output bounds; the totals still cover the file. */
  truncated?: true;
}

export interface FileDiffResponse extends FileDiffBody {
  path: string;
  status: TreeChange['status'];
  oldPath?: string;
}

export interface CompareRequest {
  env: Env;
  repo: RepoRow;
  bypass: boolean;
  waitUntil(p: Promise<unknown>): void;
}

export interface PageOptions {
  order?: string;
  limit?: string;
  cursor?: string;
}

type Ctx = ResolveContext;

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

// ---------------------------------------------------------------------------
// Artifacts readers
// ---------------------------------------------------------------------------

/** diffTrees over the repo handle; the empty tree needs no read. */
class ArtifactsTreeReader implements TreeReader {
  constructor(private readonly artifacts: LazyRepo) {}

  async readTree(hash: string): Promise<TreeEntry[] | null> {
    if (hash === EMPTY_TREE) return [];
    const entries = await (await this.artifacts.get()).readTree(hash);
    return entries ? entries.map((e) => ({ mode: e.mode, name: e.name, hash: e.hash })) : null;
  }
}

type BlobRead = { bytes: Uint8Array } | { tooLarge: true } | null;

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

async function readBlobBytes(artifacts: LazyRepo, hash: string): Promise<BlobRead> {
  let blob: Blob | null;
  try {
    blob = await (await artifacts.get()).readBlob(hash);
  } catch (err) {
    if (errorCode(err) === 'MEMORY_LIMIT') return { tooLarge: true };
    throw err;
  }
  if (!blob) return null;
  if (blob.size > COMPARE_BUDGETS.maxBlobBytes) return { tooLarge: true };
  return { bytes: new Uint8Array(await blob.arrayBuffer()) };
}

const TREE_MODE = /^0?40000$/;
const GITLINK_MODE = '160000';

/** What one side of a change contributes to its line diff. */
type SideSpec = { kind: 'empty' } | { kind: 'literal'; text: string } | { kind: 'blob'; hash: string };

function sideSpec(mode: string | null, hash: string | null): SideSpec {
  if (!mode || !hash || TREE_MODE.test(mode)) return { kind: 'empty' };
  // git renders a submodule side as one "Subproject commit <sha>" line.
  if (mode === GITLINK_MODE) return { kind: 'literal', text: `Subproject commit ${hash}\n` };
  return { kind: 'blob', hash };
}

type SideContent = { text: string; bytes: number } | { binary: true } | { tooLarge: true } | { missing: true };

/** Bytes -> one char per byte, so line equality is exact for any encoding. */
function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return out;
}

const utf8 = new TextDecoder('utf-8');

function displayText(byteStr: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7f]/.test(byteStr)) return byteStr;
  const bytes = new Uint8Array(byteStr.length);
  for (let i = 0; i < byteStr.length; i++) bytes[i] = byteStr.charCodeAt(i);
  return utf8.decode(bytes);
}

async function loadSide(artifacts: LazyRepo, spec: SideSpec): Promise<SideContent> {
  if (spec.kind === 'empty') return { text: '', bytes: 0 };
  if (spec.kind === 'literal') return { text: spec.text, bytes: spec.text.length };
  const read = await readBlobBytes(artifacts, spec.hash);
  if (!read) return { missing: true };
  if ('tooLarge' in read) return { tooLarge: true };
  if (isBinaryContent(read.bytes)) return { binary: true };
  return { text: byteString(read.bytes), bytes: read.bytes.length };
}

/** Both sides of a change; a blob shared by both sides (rename, mode change) is read once. */
async function loadSides(
  artifacts: LazyRepo,
  change: Pick<TreeChange, 'oldMode' | 'newMode' | 'oldHash' | 'newHash'>,
): Promise<[SideContent, SideContent]> {
  const old = sideSpec(change.oldMode, change.oldHash);
  const neu = sideSpec(change.newMode, change.newHash);
  if (old.kind === 'blob' && neu.kind === 'blob' && old.hash === neu.hash) {
    const side = await loadSide(artifacts, old);
    return [side, side];
  }
  return Promise.all([loadSide(artifacts, old), loadSide(artifacts, neu)]);
}

async function runPool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Line counts
// ---------------------------------------------------------------------------

type FileStat =
  | { additions: number; deletions: number; approximate?: true }
  | { binary: true }
  | { tooLarge: true };

function statKey(change: TreeChange): Request | null {
  const old = sideSpec(change.oldMode, change.oldHash);
  const neu = sideSpec(change.newMode, change.newHash);
  if (old.kind === 'literal' || neu.kind === 'literal') return null;
  return compareKeys.numstat(old.kind === 'blob' ? old.hash : null, neu.kind === 'blob' ? neu.hash : null);
}

class StatsBudgetExceeded extends Error {}

async function computeStat(ctx: Ctx, change: TreeChange, budget: { bytes: number }): Promise<FileStat> {
  const key = statKey(change);
  if (key) {
    const cached = await readJson<FileStat>(key);
    if (cached) return cached;
  }
  const [a, b] = await loadSides(ctx.artifacts, change);
  let stat: FileStat;
  if ('tooLarge' in a || 'tooLarge' in b) stat = { tooLarge: true };
  else if ('binary' in a || 'binary' in b) stat = { binary: true };
  else if ('missing' in a || 'missing' in b) throw new Error('blob missing from the repository');
  else {
    budget.bytes += a === b ? a.bytes : a.bytes + b.bytes;
    if (budget.bytes > COMPARE_BUDGETS.statsMaxTotalBytes) throw new StatsBudgetExceeded();
    if (change.oldHash !== null && change.oldHash === change.newHash) {
      stat = { additions: 0, deletions: 0 };
    } else {
      const { ops, approximate } = diffOps(a.text, b.text, { eolAware: true });
      let additions = 0;
      let deletions = 0;
      for (const op of ops) {
        if (op === 'ins') additions++;
        else if (op === 'del') deletions++;
      }
      stat = approximate ? { additions, deletions, approximate: true } : { additions, deletions };
    }
  }
  if (key && !ctx.bypass) ctx.waitUntil(writeJson(key, JSON.stringify(stat)));
  return stat;
}

/** Line counts for every change, or null when the byte budget ran out. */
async function computeStats(ctx: Ctx, changes: TreeChange[]): Promise<FileStat[] | null> {
  const out: FileStat[] = [];
  const budget = { bytes: 0 };
  try {
    await runPool(changes, COMPARE_BUDGETS.blobConcurrency, async (change, i) => {
      out[i] = await computeStat(ctx, change, budget);
    });
  } catch (err) {
    if (err instanceof StatsBudgetExceeded) return null;
    throw err;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const TRUNCATION_REASONS: Record<string, string> = {
  maxTreeReads: `tree read budget exhausted (${COMPARE_BUDGETS.maxTreeReads} reads)`,
  maxChanges: `changed file budget exhausted (${COMPARE_BUDGETS.maxChanges} files)`,
};

async function computeCompare(ctx: Ctx, baseTree: string, headTree: string): Promise<{ body: CompareBody; cacheable: boolean }> {
  const diff = await diffTrees(new ArtifactsTreeReader(ctx.artifacts), baseTree, headTree, {
    maxTreeReads: COMPARE_BUDGETS.maxTreeReads,
    maxChanges: COMPARE_BUDGETS.maxChanges,
    concurrency: COMPARE_BUDGETS.treeConcurrency,
  });
  const changes = diff.changes;
  const withStats = !diff.truncated && changes.length <= COMPARE_BUDGETS.statsMaxFiles;
  const stats = withStats ? await computeStats(ctx, changes) : null;

  const risk = await assessRisk({
    changes,
    stats: changes.map((_, i) => {
      const s = stats?.[i];
      if (!s || 'tooLarge' in s) return null;
      return 'binary' in s ? { additions: 0, deletions: 0, binary: true } : { additions: s.additions, deletions: s.deletions, binary: false };
    }),
    readText: async (hash) => {
      const side = await loadSide(ctx.artifacts, { kind: 'blob', hash });
      return 'text' in side ? displayText(side.text) : null;
    },
  });

  let additions = 0;
  let deletions = 0;
  const files = changes.map((c, i): CompareFile => {
    const f: CompareFile = {
      path: c.path,
      status: c.status,
      ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
      oldHash: c.oldHash,
      newHash: c.newHash,
      oldMode: c.oldMode,
      newMode: c.newMode,
    } as CompareFile;
    const s = stats?.[i];
    if (s) {
      if ('binary' in s) f.binary = true;
      else if ('tooLarge' in s) f.tooLarge = true;
      else {
        f.additions = s.additions;
        f.deletions = s.deletions;
        if (s.approximate) f.approximate = true;
        additions += s.additions;
        deletions += s.deletions;
      }
    }
    f.risk = risk.files[i] ?? { score: 0, tags: [] };
    return f;
  });

  const body: CompareBody = {
    files,
    totals: { files: files.length, additions: stats ? additions : null, deletions: stats ? deletions : null },
    rating: risk.rating,
    truncated: diff.truncated,
    treeReads: diff.treeReads,
  };
  if (diff.truncatedReason) {
    body.truncatedReason =
      diff.truncatedReason === 'readError'
        ? `tree read failed: ${diff.readError ?? 'unknown error'}`.slice(0, 300)
        : TRUNCATION_REASONS[diff.truncatedReason];
  }
  if (!stats) body.statsOmitted = true;
  // A failed read may be transient: serve it truthfully but never pin it.
  return { body, cacheable: diff.truncatedReason !== 'readError' };
}

/** The compare body for a tree pair: cached, or computed (and cached unless bypassed). */
async function loadCompareBody(ctx: Ctx, baseTree: string, headTree: string): Promise<{ body: CompareBody; cache: CacheOutcome }> {
  const key = compareKeys.treediff(baseTree, headTree);
  if (!ctx.bypass) {
    const hit = await readJson<CompareBody>(key);
    if (hit) return { body: hit, cache: 'hit' };
  }
  const { body, cacheable } = await computeCompare(ctx, baseTree, headTree);
  const serialized = JSON.stringify(body);
  if (!ctx.bypass && cacheable) ctx.waitUntil(writeJson(key, serialized));
  // Round-trip so a miss renders exactly what a later hit will.
  return { body: JSON.parse(serialized) as CompareBody, cache: ctx.bypass ? 'bypass' : 'miss' };
}

function encodeCursor(offset: number, baseTree: string, headTree: string): string {
  return btoa(`v1:${offset}:${baseTree.slice(0, 12)}${headTree.slice(0, 12)}`).replace(/=+$/, '');
}

function decodeCursor(cursor: string, baseTree: string, headTree: string): number | null {
  let raw: string;
  try {
    raw = atob(cursor);
  } catch {
    return null;
  }
  const m = /^v1:(\d+):([0-9a-f]{24})$/.exec(raw);
  if (!m || m[2] !== `${baseTree.slice(0, 12)}${headTree.slice(0, 12)}`) return null;
  return Number(m[1]);
}

function orderFiles(files: CompareFile[], order: 'path' | 'risk'): CompareFile[] {
  if (order === 'path') return files;
  return [...files].sort((a, b) => b.risk.score - a.risk.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const MAX_PAGE = 5_000;

function render(
  body: CompareBody,
  base: RefView,
  head: RefView,
  page: PageOptions,
): ServiceResult<CompareResponse> {
  const order = page.order ?? 'path';
  if (order !== 'path' && order !== 'risk') return fail(400, 'order must be "path" or "risk"', 'INVALID_ORDER');
  let limit: number | null = null;
  if (page.limit !== undefined) {
    if (!/^\d+$/.test(page.limit) || Number(page.limit) < 1) {
      return fail(400, 'limit must be a positive integer', 'INVALID_LIMIT');
    }
    limit = Math.min(Number(page.limit), MAX_PAGE);
  }
  let offset = 0;
  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor, base.tree, head.tree);
    if (decoded === null) return fail(400, 'cursor is invalid or belongs to another comparison', 'INVALID_CURSOR');
    offset = decoded;
  }
  const ordered = orderFiles(body.files, order);
  const end = limit === null ? ordered.length : Math.min(ordered.length, offset + limit);
  const out: CompareResponse = {
    base,
    head,
    files: ordered.slice(offset, end),
    totals: body.totals,
    rating: body.rating,
    truncated: body.truncated,
    treeReads: body.treeReads,
  };
  if (body.truncatedReason !== undefined) out.truncatedReason = body.truncatedReason;
  if (body.statsOmitted) out.statsOmitted = true;
  if (end < ordered.length) out.nextCursor = encodeCursor(end, base.tree, head.tree);
  return { ok: true, value: out };
}

function resolveContext(req: CompareRequest, artifacts: LazyRepo): Ctx {
  return { env: req.env, repo: req.repo, artifacts, bypass: req.bypass, waitUntil: req.waitUntil };
}

function markOutcome(cache: CacheOutcome): void {
  markCache(cache);
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ compareRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/** Resolves base and head (one round trip for both names) to commits and trees. */
async function resolvePair(
  ctx: Ctx,
  base: string,
  head: string,
): Promise<ServiceResult<{ base: RefView; head: RefView }>> {
  for (const r of [base, head]) {
    if (!isFullSha(r) && !isValidRefName(r)) return fail(404, `ref not found: ${r.slice(0, 100)}`, 'REF_NOT_FOUND');
  }
  const resolved = await resolveCommitish(ctx, [base, head]);
  const b = resolved.get(base);
  const h = resolved.get(head);
  if (!b) return fail(404, `ref not found: ${base}`, 'REF_NOT_FOUND');
  if (!h) return fail(404, `ref not found: ${head}`, 'REF_NOT_FOUND');
  return {
    ok: true,
    value: { base: { ref: base, sha: b.sha, tree: b.tree }, head: { ref: head, sha: h.sha, tree: h.tree } },
  };
}

export interface CompareResult {
  response: CompareResponse;
  cache: CacheOutcome;
}

/** GET compare/:base...:head */
export function compare(req: CompareRequest, base: string, head: string, page: PageOptions): Promise<ServiceResult<CompareResult>> {
  return guarded(() =>
    withLazyRepo(req.env, req.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveContext(req, artifacts);
      const pair = await resolvePair(ctx, base, head);
      if (!pair.ok) return pair;
      const { body, cache } = await loadCompareBody(ctx, pair.value.base.tree, pair.value.head.tree);
      markOutcome(cache);
      const out = render(body, pair.value.base, pair.value.head, page);
      return out.ok ? { ok: true, value: { response: out.value, cache } } : out;
    }),
  );
}

/** GET commits/:sha/diff — parent...sha, or the empty tree...sha for a root commit. */
export function commitDiff(req: CompareRequest, sha: string, page: PageOptions): Promise<ServiceResult<CompareResult>> {
  return guarded(() =>
    withLazyRepo(req.env, req.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveContext(req, artifacts);
      if (!isFullSha(sha)) return fail(404, 'commit not found (a full 40-hex sha is required)', 'COMMIT_NOT_FOUND');
      const found = await readCommitAndParent(ctx, sha);
      if (!found) return fail(404, `commit not found: ${sha}`, 'COMMIT_NOT_FOUND');
      const head: RefView = { ref: sha, sha, tree: found.commit.tree };
      const base: RefView = found.parent
        ? { ref: found.parent.sha, sha: found.parent.sha, tree: found.parent.tree }
        : { ref: null, sha: null, tree: EMPTY_TREE };
      const { body, cache } = await loadCompareBody(ctx, base.tree, head.tree);
      markOutcome(cache);
      const out = render(body, base, head, page);
      return out.ok ? { ok: true, value: { response: out.value, cache } } : out;
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-file diff
// ---------------------------------------------------------------------------

/** Walks `path` in a tree; returns the leaf entry or null. */
async function entryAt(artifacts: LazyRepo, tree: string, path: string): Promise<TreeEntry | null> {
  const reader = new ArtifactsTreeReader(artifacts);
  const parts = path.split('/');
  let current = tree;
  for (let i = 0; i < parts.length; i++) {
    const entries = await reader.readTree(current);
    const e = entries?.find((x) => x.name === parts[i]);
    if (!e) return null;
    if (i === parts.length - 1) return e;
    if (!TREE_MODE.test(e.mode)) return null;
    current = e.hash;
  }
  return null;
}

/** The change for one path, from the compare body or (when truncated) a direct walk. */
async function findChange(ctx: Ctx, body: CompareBody, baseTree: string, headTree: string, path: string): Promise<CompareFile | TreeChange | null> {
  const listed = body.files.find((f) => f.path === path);
  if (listed || !body.truncated) return listed ?? null;
  const [b, h] = await Promise.all([entryAt(ctx.artifacts, baseTree, path), entryAt(ctx.artifacts, headTree, path)]);
  if (b && TREE_MODE.test(b.mode)) return null;
  if (h && TREE_MODE.test(h.mode)) return null;
  if (!b && !h) return null;
  if (b && h && b.hash === h.hash && b.mode === h.mode) return null;
  const status: TreeChange['status'] = !b ? 'added' : !h ? 'removed' : b.hash === h.hash ? 'typechange' : 'modified';
  return { path, status, oldMode: b?.mode ?? null, newMode: h?.mode ?? null, oldHash: b?.hash ?? null, newHash: h?.hash ?? null };
}

async function computeFileDiff(ctx: Ctx, change: CompareFile | TreeChange): Promise<FileDiffBody> {
  const [a, b] = await loadSides(ctx.artifacts, change);
  if ('tooLarge' in a || 'tooLarge' in b) return { hunks: [], approximate: false, tooLarge: true };
  if ('binary' in a || 'binary' in b) return { hunks: [], approximate: false, binary: true };
  if ('missing' in a || 'missing' in b) throw new Error('blob missing from the repository');
  const diff = diffToHunks(a.text, b.text, { eolAware: true });
  const limited = limitHunks(diff.hunks, { maxLines: COMPARE_BUDGETS.fileMaxLines, maxBytes: COMPARE_BUDGETS.fileMaxBytes });
  const hunks = limited.hunks.map((h) => ({
    ...h,
    lines: h.lines.map((l) => ({ ...l, text: displayText(l.text) })),
  }));
  const out: FileDiffBody = {
    hunks,
    totalAdditions: diff.totalAdditions,
    totalDeletions: diff.totalDeletions,
    approximate: diff.approximate,
  };
  if (limited.truncated) out.truncated = true;
  return out;
}

export interface FileDiffResult {
  response: FileDiffResponse;
  cache: CacheOutcome;
}

/** GET compare/:base...:head/file?path= */
export function fileDiff(req: CompareRequest, base: string, head: string, path: string): Promise<ServiceResult<FileDiffResult>> {
  return guarded(() =>
    withLazyRepo(req.env, req.repo.artifacts_name, async (artifacts) => {
      const ctx = resolveContext(req, artifacts);
      const pair = await resolvePair(ctx, base, head);
      if (!pair.ok) return pair;
      const { base: b, head: h } = pair.value;
      const compareBody = await loadCompareBody(ctx, b.tree, h.tree);
      const change = await findChange(ctx, compareBody.body, b.tree, h.tree, path);
      if (!change) return fail(404, 'path is not changed between base and head', 'PATH_NOT_CHANGED');

      const key = compareKeys.filediff(change.oldHash, change.newHash);
      const literal = statKey(change) === null;
      let body: FileDiffBody | undefined;
      let cache: CacheOutcome = ctx.bypass ? 'bypass' : 'miss';
      if ('binary' in change && change.binary) {
        body = { hunks: [], approximate: false, binary: true };
      } else if ('tooLarge' in change && change.tooLarge) {
        body = { hunks: [], approximate: false, tooLarge: true };
      } else if (!ctx.bypass && !literal) {
        body = await readJson<FileDiffBody>(key);
        if (body) cache = 'hit';
      }
      if (!body) {
        body = await computeFileDiff(ctx, change);
        if (!ctx.bypass && !literal) ctx.waitUntil(writeJson(key, JSON.stringify(body)));
      } else if (cache !== 'hit') {
        // Flags already known from the compare body: no blob read happened.
        cache = compareBody.cache;
      }
      markOutcome(cache);
      const response: FileDiffResponse = {
        path,
        status: change.status,
        ...(change.oldPath !== undefined ? { oldPath: change.oldPath } : {}),
        ...body,
      };
      return { ok: true, value: { response, cache } };
    }),
  );
}
