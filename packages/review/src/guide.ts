/**
 * Deterministic review coverage and author-supplied guide validation.
 */

import type { Hunk } from '@kvarm/diffcore';
import { byteOrder } from './content';
import { isTestPath } from './paths';
import type { RiskTag } from './risk';

export type ReviewTier = 'scrutinize' | 'read' | 'receipt';
const TIER_ORDER: Record<ReviewTier, number> = { receipt: 0, read: 1, scrutinize: 2 };

export interface CoverageFileInput {
  path: string;
  oldPath?: string;
  status: string;
  oldHash: string | null;
  newHash: string | null;
  additions?: number;
  deletions?: number;
  tags: RiskTag[];
  hunks: Hunk[] | null;
  protected?: boolean;
  /** True when hunks were omitted because a service budget was exhausted. */
  truncated?: boolean;
}

export interface CoverageUnit {
  key: string;
  path: string;
  index: number;
  kind: 'hunk' | 'file';
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  additions: number;
  deletions: number;
  floor: ReviewTier;
  defaultTier: ReviewTier;
  contract: boolean;
  receipt?: string;
}

export interface CoverageMap {
  units: CoverageUnit[];
  contracts: string[];
  truncated: boolean;
}

export interface ReviewConfig {
  contracts?: string[];
  scrutinize?: string[];
  receipts?: string[];
  postingThreshold?: 'low' | 'medium' | 'high';
}

export type ReviewConfigResult = { ok: true; value: ReviewConfig } | { ok: false; error: string };

const CONFIG_KEYS = new Set(['contracts', 'scrutinize', 'receipts', 'postingThreshold']);
const MAX_GLOBS = 100;

export function parseReviewConfig(text: string): ReviewConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: '.kvarm/review.json must be valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '.kvarm/review.json must be a JSON object' };
  }
  const object = raw as Record<string, unknown>;
  const unknown = Object.keys(object).find((key) => !CONFIG_KEYS.has(key));
  if (unknown) return { ok: false, error: `unknown review config key: ${unknown}` };
  const value: ReviewConfig = {};
  for (const key of ['contracts', 'scrutinize', 'receipts'] as const) {
    const list = object[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > MAX_GLOBS || list.some((item) => typeof item !== 'string' || item.length === 0)) {
      return { ok: false, error: `${key} must be an array of at most ${MAX_GLOBS} non-empty glob strings` };
    }
    value[key] = [...list] as string[];
  }
  if (object.postingThreshold !== undefined) {
    if (object.postingThreshold !== 'low' && object.postingThreshold !== 'medium' && object.postingThreshold !== 'high') {
      return { ok: false, error: 'postingThreshold must be low, medium or high' };
    }
    value.postingThreshold = object.postingThreshold;
  }
  return { ok: true, value };
}

function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const options = match[1]!.split(',');
  if (options.length < 2) return [pattern];
  return options.flatMap((option) => expandBraces(`${pattern.slice(0, match.index)}${option}${pattern.slice(match.index + match[0].length)}`));
}

function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      while (pattern[i + 1] === '*') i++;
      if (pattern[i + 1] === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        source += '.*';
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

export function matchReviewGlob(pattern: string, path: string): boolean {
  return expandBraces(pattern).some((expanded) => globRegex(expanded).test(path));
}

const CONTRACT_GLOBS = ['**/migrations/**', '**/*.proto', '**/openapi.{json,yaml,yml}', '**/*.graphql', '**/schema.prisma', '**/*.d.ts'];

export function isContractPath(path: string, extraGlobs: readonly string[] = []): boolean {
  if (path.endsWith('.d.ts') && isTestPath(path)) return false;
  return [...CONTRACT_GLOBS, ...extraGlobs].some((pattern) => matchReviewGlob(pattern, path));
}

function maxTier(a: ReviewTier, b: ReviewTier): ReviewTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

function digestHex(text: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then((buffer) =>
    [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}

function normalizedLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function hunkIdentity(path: string, hunk: Hunk): Promise<string> {
  const prefix = { eq: ' ', ins: '+', del: '-' } as const;
  const lines = hunk.lines.map((line) => `${prefix[line.type]}${normalizedLine(line.text)}`).join('\n');
  return digestHex(`${path}\0${lines}`).then((hash) => `h_${hash.slice(0, 24)}`);
}

function fileIdentity(file: CoverageFileInput): Promise<string> {
  return digestHex(['file', file.path, file.oldPath ?? '', file.oldHash ?? '', file.newHash ?? ''].join('\0')).then((hash) => `f_${hash.slice(0, 24)}`);
}

function isDeleted(status: string): boolean {
  return status === 'deleted' || status === 'removed';
}

function isReceiptEligible(file: CoverageFileInput, config: ReviewConfig): boolean {
  return (
    file.tags.some((tag) => tag === 'lockfile' || tag === 'generated' || tag === 'mechanical') ||
    isDeleted(file.status) ||
    (config.receipts ?? []).some((pattern) => matchReviewGlob(pattern, file.path))
  );
}

function receiptText(file: CoverageFileInput): string | undefined {
  const additions = file.additions ?? 0;
  const deletions = file.deletions ?? 0;
  if (file.tags.includes('lockfile')) return `lockfile · +${additions} −${deletions}`;
  if (file.tags.includes('generated')) return `generated · +${additions} −${deletions}`;
  if (file.tags.includes('mechanical')) return `mechanical (whitespace) · +${additions} −${deletions}`;
  if (isDeleted(file.status)) return `deleted · ${deletions} lines`;
  return undefined;
}

function fileFloor(file: CoverageFileInput, contract: boolean, config: ReviewConfig): ReviewTier {
  if (
    file.protected ||
    contract ||
    file.tags.some((tag) => tag === 'security-sensitive' || tag === 'ci-config' || tag === 'test-deletion' || tag === 'new-dependency') ||
    (config.scrutinize ?? []).some((pattern) => matchReviewGlob(pattern, file.path))
  ) {
    return 'scrutinize';
  }
  return isReceiptEligible(file, config) ? 'receipt' : 'read';
}

export async function buildCoverage(files: readonly CoverageFileInput[], config: ReviewConfig): Promise<CoverageMap> {
  const units: CoverageUnit[] = [];
  const contracts = new Set<string>();
  let truncated = false;
  for (const file of files) {
    const contract = isContractPath(file.path, config.contracts);
    if (contract) contracts.add(file.path);
    if (file.oldPath && isContractPath(file.oldPath, config.contracts)) contracts.add(file.oldPath);
    truncated ||= file.truncated === true;
    const floor = fileFloor(file, contract, config);
    const hunks = file.hunks;
    const fileUnit = isReceiptEligible(file, config) || hunks === null;
    if (fileUnit) {
      units.push({
        key: await fileIdentity(file),
        path: file.path,
        index: 0,
        kind: 'file',
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        floor,
        defaultTier: floor,
        contract,
        ...(floor === 'receipt' ? { receipt: receiptText(file) } : {}),
      });
      continue;
    }
    const seen = new Map<string, number>();
    for (const [index, hunk] of hunks.entries()) {
      const baseKey = await hunkIdentity(file.path, hunk);
      const ordinal = (seen.get(baseKey) ?? 0) + 1;
      seen.set(baseKey, ordinal);
      const additions = hunk.lines.filter((line) => line.type === 'ins').length;
      const deletions = hunk.lines.filter((line) => line.type === 'del').length;
      units.push({
        key: ordinal === 1 ? baseKey : `${baseKey}-${ordinal}`,
        path: file.path,
        index,
        kind: 'hunk',
        oldStart: hunk.oldStart,
        oldLines: hunk.oldLines,
        newStart: hunk.newStart,
        newLines: hunk.newLines,
        additions,
        deletions,
        floor,
        defaultTier: floor,
        contract,
      });
    }
  }
  return { units, contracts: [...contracts].sort(byteOrder), truncated };
}

export interface GuideNote {
  hunk: string;
  kind: 'looks-wrong-but' | 'note';
  body: string;
}

export interface GuideChapter {
  id: string;
  title: string;
  why?: string;
  tier: ReviewTier;
  dependsOn?: string[];
  hunks: string[];
  notes?: GuideNote[];
}

export interface ResolvedChapter extends GuideChapter {}

export interface ResolvedGuide {
  intent: string;
  steps?: string[];
  beforeAfter?: Array<{ lane: string; before: string; after: string }>;
  chapters: ResolvedChapter[];
  contracts?: Array<{ surface: string; impact: 'breaking' | 'additive' | 'none'; note?: string }>;
  unchanged?: string[];
  evidence?: Array<{ kind: 'test' | 'check' | 'manual'; ref: string; covers?: string[] }>;
  source: 'author' | 'reviewer' | 'carried' | 'fallback';
  tiers: Record<string, ReviewTier>;
}

export type GuideValidationResult =
  | { ok: true; guide: ResolvedGuide; gaps: string[]; raised: Array<{ key: string; from: ReviewTier; to: ReviewTier }>; undeclared: string[] }
  | { ok: false; code: 'GUIDE_TOO_LARGE' | 'INVALID_GUIDE'; error: string };

function invalid(error: string): GuideValidationResult {
  return { ok: false, code: 'INVALID_GUIDE', error };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): string | null {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  return unknown ? `${where} contains unknown key ${unknown}` : null;
}

function boundedString(value: unknown, max: number, field: string, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be a string of at most ${max} characters`);
  return value;
}

function stringList(value: unknown, maxItems: number, maxLength: number, field: string, optional = false): string[] | undefined {
  if (optional && value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${field} must be an array with at most ${maxItems} items`);
  return value.map((item, index) => {
    const result = boundedString(item, maxLength, `${field}[${index}]`);
    return result!;
  });
}

function tier(value: unknown, field: string): ReviewTier {
  if (value !== 'scrutinize' && value !== 'read' && value !== 'receipt') throw new Error(`${field} must be scrutinize, read or receipt`);
  return value;
}

function parseChapter(value: unknown, index: number): GuideChapter {
  const field = `chapters[${index}]`;
  if (!isObject(value)) throw new Error(`${field} must be an object`);
  const keyError = onlyKeys(value, ['id', 'title', 'why', 'tier', 'dependsOn', 'hunks', 'notes'], field);
  if (keyError) throw new Error(keyError);
  const id = boundedString(value.id, 32, `${field}.id`)!;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || id === 'unguided') throw new Error(`${field}.id must be a unique chapter id other than unguided`);
  const title = boundedString(value.title, 120, `${field}.title`)!;
  const why = boundedString(value.why, 1000, `${field}.why`, true);
  const chapterTier = tier(value.tier, `${field}.tier`);
  const dependsOn = stringList(value.dependsOn, 50, 32, `${field}.dependsOn`, true);
  const hunks = stringList(value.hunks, 5000, 80, `${field}.hunks`)!;
  if (hunks.length === 0) throw new Error(`${field}.hunks must contain at least one unit key`);
  let notes: GuideNote[] | undefined;
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes) || value.notes.length > 50) throw new Error(`${field}.notes must be an array with at most 50 notes`);
    notes = value.notes.map((item, noteIndex) => {
      const nf = `${field}.notes[${noteIndex}]`;
      if (!isObject(item)) throw new Error(`${nf} must be an object`);
      const noteKeyError = onlyKeys(item, ['hunk', 'kind', 'body'], nf);
      if (noteKeyError) throw new Error(noteKeyError);
      const hunkKey = boundedString(item.hunk, 80, `${nf}.hunk`)!;
      if (!hunks.includes(hunkKey)) throw new Error(`${nf}.hunk must be a key in its chapter`);
      if (item.kind !== 'looks-wrong-but' && item.kind !== 'note') throw new Error(`${nf}.kind must be looks-wrong-but or note`);
      return { hunk: hunkKey, kind: item.kind, body: boundedString(item.body, 1000, `${nf}.body`)! };
    });
  }
  return { id, title, ...(why !== undefined ? { why } : {}), tier: chapterTier, ...(dependsOn ? { dependsOn } : {}), hunks, ...(notes ? { notes } : {}) };
}

function parseBeforeAfter(value: unknown): Array<{ lane: string; before: string; after: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) throw new Error('beforeAfter must be an array with at most 12 items');
  return value.map((item, index) => {
    const field = `beforeAfter[${index}]`;
    if (!isObject(item)) throw new Error(`${field} must be an object`);
    const keyError = onlyKeys(item, ['lane', 'before', 'after'], field);
    if (keyError) throw new Error(keyError);
    return {
      lane: boundedString(item.lane, 80, `${field}.lane`)!,
      before: boundedString(item.before, 300, `${field}.before`)!,
      after: boundedString(item.after, 300, `${field}.after`)!,
    };
  });
}

function parseContracts(value: unknown): ResolvedGuide['contracts'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new Error('contracts must be an array with at most 50 items');
  return value.map((item, index) => {
    const field = `contracts[${index}]`;
    if (!isObject(item)) throw new Error(`${field} must be an object`);
    const keyError = onlyKeys(item, ['surface', 'impact', 'note'], field);
    if (keyError) throw new Error(keyError);
    const surface = boundedString(item.surface, 300, `${field}.surface`)!;
    if (item.impact !== 'breaking' && item.impact !== 'additive' && item.impact !== 'none') throw new Error(`${field}.impact must be breaking, additive or none`);
    const note = boundedString(item.note, 500, `${field}.note`, true);
    return { surface, impact: item.impact, ...(note !== undefined ? { note } : {}) };
  });
}

function parseEvidence(value: unknown): ResolvedGuide['evidence'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new Error('evidence must be an array with at most 50 items');
  return value.map((item, index) => {
    const field = `evidence[${index}]`;
    if (!isObject(item)) throw new Error(`${field} must be an object`);
    const keyError = onlyKeys(item, ['kind', 'ref', 'covers'], field);
    if (keyError) throw new Error(keyError);
    if (item.kind !== 'test' && item.kind !== 'check' && item.kind !== 'manual') throw new Error(`${field}.kind must be test, check or manual`);
    const ref = boundedString(item.ref, 300, `${field}.ref`)!;
    const covers = stringList(item.covers, 50, 32, `${field}.covers`, true);
    return { kind: item.kind, ref, ...(covers ? { covers } : {}) };
  });
}

export function validateGuide(input: unknown, map: CoverageMap): GuideValidationResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return invalid('guide must be JSON-serializable');
  }
  if (serialized.length > 65_536) return { ok: false, code: 'GUIDE_TOO_LARGE', error: 'guide JSON must be at most 65536 characters' };
  if (!isObject(input)) return invalid('guide must be a JSON object');
  const rootError = onlyKeys(input, ['intent', 'steps', 'beforeAfter', 'chapters', 'contracts', 'unchanged', 'evidence'], 'guide');
  if (rootError) return invalid(rootError);
  try {
    const intent = boundedString(input.intent, 500, 'intent')!;
    const steps = stringList(input.steps, 20, 200, 'steps', true);
    const beforeAfter = parseBeforeAfter(input.beforeAfter);
    if (!Array.isArray(input.chapters) || input.chapters.length < 1 || input.chapters.length > 50) {
      throw new Error('chapters must contain between 1 and 50 chapters');
    }
    const chapters = input.chapters.map(parseChapter);
    const ids = new Set<string>();
    for (const chapter of chapters) {
      if (ids.has(chapter.id)) throw new Error(`duplicate chapter id: ${chapter.id}`);
      ids.add(chapter.id);
    }
    for (const chapter of chapters) {
      for (const dependency of chapter.dependsOn ?? []) {
        if (dependency === chapter.id) throw new Error(`chapter ${chapter.id} cannot depend on itself`);
        if (!ids.has(dependency)) throw new Error(`chapter ${chapter.id} depends on unknown chapter ${dependency}`);
      }
    }
    const known = new Set(map.units.map((unit) => unit.key));
    const claimed = new Set<string>();
    for (const chapter of chapters) {
      for (const key of chapter.hunks) {
        if (!known.has(key)) {
          const unknown = chapter.hunks.filter((item) => !known.has(item));
          throw new Error(`unknown unit key${unknown.length === 1 ? '' : 's'}: ${[...new Set(unknown)].slice(0, 10).join(', ')}`);
        }
        if (claimed.has(key)) throw new Error(`unit key appears in more than one chapter: ${key}`);
        claimed.add(key);
      }
    }
    const contracts = parseContracts(input.contracts);
    const unchanged = stringList(input.unchanged, 20, 200, 'unchanged', true);
    const evidence = parseEvidence(input.evidence);
    const tiers: Record<string, ReviewTier> = {};
    const raised: Array<{ key: string; from: ReviewTier; to: ReviewTier }> = [];
    for (const chapter of chapters) {
      for (const key of chapter.hunks) {
        const unit = map.units.find((candidate) => candidate.key === key)!;
        const effective = maxTier(chapter.tier, unit.floor);
        tiers[key] = effective;
        if (effective !== chapter.tier) raised.push({ key, from: chapter.tier, to: effective });
      }
    }
    const gaps = map.units.filter((unit) => !claimed.has(unit.key)).map((unit) => unit.key);
    if (gaps.length) {
      chapters.push({ id: 'unguided', title: 'Not covered by the guide', tier: 'read', hunks: gaps });
      for (const key of gaps) {
        const unit = map.units.find((candidate) => candidate.key === key)!;
        const effective = maxTier('read', unit.floor);
        tiers[key] = effective;
        if (effective !== 'read') raised.push({ key, from: 'read', to: effective });
      }
    }
    const undeclared = map.contracts.filter(
      (path) => !contracts?.some((declaration) => declaration.surface === path || declaration.surface.startsWith(`${path}#`)),
    );
    const guide: ResolvedGuide = {
      intent,
      ...(steps ? { steps } : {}),
      ...(beforeAfter ? { beforeAfter } : {}),
      chapters,
      ...(contracts ? { contracts } : {}),
      ...(unchanged ? { unchanged } : {}),
      ...(evidence ? { evidence } : {}),
      source: 'author',
      tiers,
    };
    return { ok: true, guide, gaps, raised, undeclared };
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'guide is invalid');
  }
}

function pathGroup(path: string): string {
  return path.split('/').slice(0, 2).join('/');
}

function chapterTier(units: readonly CoverageUnit[]): ReviewTier {
  return units.reduce<ReviewTier>((tier, unit) => maxTier(tier, unit.defaultTier), 'receipt');
}

function chapterId(path: string, used: Set<string>): string {
  let base = path.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'files';
  if (base === 'unguided') base = 'files';
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    const tail = `-${suffix++}`;
    id = `${base.slice(0, 32 - tail.length)}${tail}`;
  }
  used.add(id);
  return id;
}

export function fallbackGuide(map: CoverageMap): ResolvedGuide {
  const used = new Set<string>();
  const tiers: Record<string, ReviewTier> = {};
  const receiptUnits = map.units.filter((unit) => unit.defaultTier === 'receipt');
  const testUnits = map.units.filter((unit) => unit.defaultTier !== 'receipt' && isTestPath(unit.path));
  const regular = map.units.filter((unit) => unit.defaultTier !== 'receipt' && !isTestPath(unit.path));
  const groups = new Map<string, CoverageUnit[]>();
  for (const unit of regular) {
    const key = pathGroup(unit.path);
    const list = groups.get(key) ?? [];
    list.push(unit);
    groups.set(key, list);
  }
  const orderedGroups = [...groups].sort(([pathA, a], [pathB, b]) => {
    const tierDiff = TIER_ORDER[chapterTier(b)] - TIER_ORDER[chapterTier(a)];
    if (tierDiff) return tierDiff;
    const aContract = a.some((unit) => unit.contract);
    const bContract = b.some((unit) => unit.contract);
    if (aContract !== bContract) return aContract ? -1 : 1;
    return byteOrder(pathA, pathB);
  });
  const chapters: ResolvedChapter[] = orderedGroups.map(([path, units]) => {
    const value = chapterTier(units);
    for (const unit of units) tiers[unit.key] = unit.defaultTier;
    return { id: chapterId(path, used), title: path, tier: value, hunks: units.map((unit) => unit.key) };
  });
  if (testUnits.length) {
    for (const unit of testUnits) tiers[unit.key] = unit.defaultTier;
    chapters.push({ id: 'tests', title: 'Tests', tier: chapterTier(testUnits), hunks: testUnits.map((unit) => unit.key) });
    used.add('tests');
  }
  if (receiptUnits.length) {
    for (const unit of receiptUnits) tiers[unit.key] = unit.defaultTier;
    chapters.push({ id: 'receipts', title: 'Receipts', tier: 'receipt', hunks: receiptUnits.map((unit) => unit.key) });
  }
  return { intent: '', chapters, source: 'fallback', tiers };
}

export function carryGuide(previous: ResolvedGuide, map: CoverageMap): ResolvedGuide {
  const known = new Set(map.units.map((unit) => unit.key));
  const tiers: Record<string, ReviewTier> = {};
  const chapters: ResolvedChapter[] = [];
  const retained = new Set<string>();
  for (const chapter of previous.chapters) {
    const hunks = chapter.hunks.filter((key) => known.has(key));
    if (hunks.length === 0) continue;
    for (const key of hunks) {
      const unit = map.units.find((candidate) => candidate.key === key)!;
      tiers[key] = maxTier(previous.tiers[key] ?? chapter.tier, unit.floor);
      retained.add(key);
    }
    chapters.push({ ...chapter, hunks });
  }
  const added = map.units.filter((unit) => !retained.has(unit.key));
  if (added.length) {
    const existing = chapters.find((chapter) => chapter.id === 'unguided');
    for (const unit of added) {
      tiers[unit.key] = maxTier('read', unit.floor);
      retained.add(unit.key);
    }
    if (existing) {
      existing.hunks.push(...added.map((unit) => unit.key));
    } else {
      chapters.push({ id: 'unguided', title: 'Not covered by the guide', tier: 'read', hunks: added.map((unit) => unit.key) });
    }
  }
  return {
    ...previous,
    chapters,
    source: 'carried',
    tiers,
  };
}
