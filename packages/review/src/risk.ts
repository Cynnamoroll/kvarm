/**
 * Per-file risk classification and the change-level rating. Pure and
 * deterministic: the same inputs always produce byte-identical output,
 * independent of input order. packages/review/test/risk.test.ts pins the
 * rules, weights and thresholds; change them together.
 */

import { byteOrder, countTestCases, dependencyNames, hasGeneratedMarker, isWhitespaceOnlyChange } from './content';
import {
  isCiConfigPath,
  isCodePath,
  isGeneratedPath,
  isLockfilePath,
  isSecuritySensitivePath,
  isTestPath,
  manifestKind,
} from './paths';

export type RiskTag =
  | 'ci-config'
  | 'generated'
  | 'large'
  | 'lockfile'
  | 'mechanical'
  | 'new-dependency'
  | 'security-sensitive'
  | 'semantic'
  | 'test-deletion';

/** One changed path, as the tree diff and line counts describe it. */
export interface RiskChange {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'typechange';
  oldPath?: string;
  oldHash: string | null;
  newHash: string | null;
  oldMode: string | null;
  newMode: string | null;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  tooLarge?: boolean;
}

/**
 * Optional content. Texts are given only for files `needsContent` asked for;
 * the hints carry content facts computed elsewhere (e.g. while counting lines)
 * so the texts need not be kept.
 */
export interface RiskContent {
  oldText?: string | null;
  newText?: string | null;
  whitespaceOnly?: boolean;
  generatedMarker?: boolean;
}

export interface FileRiskResult {
  score: number;
  tags: RiskTag[];
  /** Detail for the change-level reasons; not part of the per-file API shape. */
  evidence?: { newDependencies?: string[]; testCases?: { before: number; after: number } };
}

export interface ChangeRating {
  score: number;
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

/** Changed lines (additions + deletions) at which a file is tagged `large`. */
export const LARGE_CHANGE_LINES = 1000;
/** Score ceiling for a mechanical change (rename, mode-only, whitespace-only). */
export const MECHANICAL_MAX_SCORE = 10;
/** Change-level score boundaries: low < MEDIUM_AT <= medium < HIGH_AT <= high. */
export const MEDIUM_AT = 30;
export const HIGH_AT = 60;
/** Change-level floor when CI configuration and test deletions land together. */
export const CI_GAMING_FLOOR = 75;
/** Points per extra high-signal tag beyond the first present on a change. */
export const HIGH_SIGNAL_BONUS = 5;
/** Bonus when total churn across the change reaches LARGE_CHANGE_LINES. */
export const LARGE_TOTAL_CHURN_BONUS = 5;

export const TAG_WEIGHTS: Record<RiskTag, number> = {
  'test-deletion': 40,
  'ci-config': 35,
  'security-sensitive': 30,
  'new-dependency': 25,
  semantic: 15,
  large: 15,
  lockfile: 10,
  generated: 0,
  mechanical: 0,
};

const HIGH_SIGNAL: RiskTag[] = ['test-deletion', 'ci-config', 'security-sensitive', 'new-dependency'];

function clamp(score: number): number {
  return Math.min(100, Math.max(0, Math.round(score)));
}

function churnOf(c: RiskChange): number | null {
  if (c.additions === undefined || c.deletions === undefined) return null;
  return c.additions + c.deletions;
}

function churnPoints(churn: number | null): number {
  if (!churn) return 0;
  if (churn < 10) return 2;
  if (churn < 100) return 5;
  if (churn < LARGE_CHANGE_LINES) return 10;
  return 15;
}

/** Content changed (not an exact rename or a mode-only change). */
function contentChanged(c: RiskChange): boolean {
  if (c.status === 'renamed' || c.status === 'typechange') return c.oldHash !== c.newHash;
  return true;
}

/** Which sides' texts `classifyFile` can use for `change` (manifests and modified tests). */
export function needsContent(c: RiskChange): { old: boolean; new: boolean } {
  const none = { old: false, new: false };
  if (c.binary || c.tooLarge || !contentChanged(c)) return none;
  const hasOld = c.oldHash !== null && c.status !== 'added';
  const hasNew = c.newHash !== null && c.status !== 'removed';
  if (manifestKind(c.path)) return { old: hasOld, new: hasNew };
  if (isTestPath(c.path) && hasOld && hasNew) return { old: true, new: true };
  return none;
}

function testDeletion(c: RiskChange, content: RiskContent): { before: number; after: number } | boolean {
  // A test file moved to a non-test path is a deletion of the test, whatever
  // edits the move carries: kvarm/guard judges the same change a failure
  // (ci-gaming/test-deleted), and the rating must not understate it.
  if (c.oldPath !== undefined && isTestPath(c.oldPath) && !isTestPath(c.path)) return true;
  if (!isTestPath(c.path)) return false;
  if (c.status === 'removed') return true;
  if (!contentChanged(c) || typeof content.oldText !== 'string' || typeof content.newText !== 'string') return false;
  const before = countTestCases(content.oldText);
  const after = countTestCases(content.newText);
  if (content.oldText.trim() !== '' && content.newText.trim() === '') return { before: before.cases, after: 0 };
  if (after.cases < before.cases || after.skipped > before.skipped) return { before: before.cases, after: after.cases - after.skipped };
  return false;
}

function newDependencies(c: RiskChange, content: RiskContent): string[] {
  if (!manifestKind(c.path) || !contentChanged(c) || c.status === 'removed') return [];
  if (typeof content.newText !== 'string') return [];
  const after = dependencyNames(c.path, content.newText) ?? [];
  let before: string[] = [];
  if (c.status !== 'added') {
    if (typeof content.oldText !== 'string') return [];
    before = dependencyNames(c.path, content.oldText) ?? [];
  }
  const had = new Set(before);
  return after.filter((d) => !had.has(d));
}

function generated(c: RiskChange, content: RiskContent): boolean {
  if (isGeneratedPath(c.path)) return true;
  if (content.generatedMarker !== undefined) return content.generatedMarker;
  const text = c.status === 'removed' ? content.oldText : content.newText;
  return typeof text === 'string' && hasGeneratedMarker(text);
}

function whitespaceOnly(c: RiskChange, content: RiskContent): boolean {
  if (c.status !== 'modified' && c.status !== 'typechange') return false;
  if (content.whitespaceOnly !== undefined) return content.whitespaceOnly;
  return typeof content.oldText === 'string' && typeof content.newText === 'string' && isWhitespaceOnlyChange(content.oldText, content.newText);
}

/** Risk score (integer 0..100) and tags for one changed file. */
export function classifyFile(c: RiskChange, content: RiskContent = {}): FileRiskResult {
  const tags = new Set<RiskTag>();
  const evidence: NonNullable<FileRiskResult['evidence']> = {};

  if (isCiConfigPath(c.path)) tags.add('ci-config');
  if (isSecuritySensitivePath(c.path)) tags.add('security-sensitive');
  const lockfile = isLockfilePath(c.path);
  if (lockfile) tags.add('lockfile');
  const gen = generated(c, content);
  if (gen) tags.add('generated');

  const mechanical = !contentChanged(c) || whitespaceOnly(c, content);
  if (mechanical) tags.add('mechanical');

  const deletion = testDeletion(c, content);
  if (deletion) {
    tags.add('test-deletion');
    if (typeof deletion === 'object') evidence.testCases = deletion;
  }
  const deps = newDependencies(c, content);
  if (deps.length > 0) {
    tags.add('new-dependency');
    evidence.newDependencies = deps;
  }

  const churn = churnOf(c);
  if (!lockfile && !gen && (c.tooLarge || (churn !== null && churn >= LARGE_CHANGE_LINES))) tags.add('large');
  if (!mechanical && !lockfile && !gen && !c.binary && isCodePath(c.path)) tags.add('semantic');

  let score = churnPoints(churn);
  for (const t of tags) score += TAG_WEIGHTS[t];
  if (mechanical) score = Math.min(score, MECHANICAL_MAX_SCORE);

  const out: FileRiskResult = { score: clamp(score), tags: [...tags].sort(byteOrder) };
  if (evidence.newDependencies || evidence.testCases) out.evidence = evidence;
  return out;
}

// ---------------------------------------------------------------------------
// Change-level rating
// ---------------------------------------------------------------------------

export interface RatedFile {
  change: RiskChange;
  risk: FileRiskResult;
}

export interface RateOptions {
  /** The file list stopped at a budget: the rating covers only listed files. */
  truncated?: boolean;
  /** Line counts were not computed: `large` and content signals are unavailable. */
  statsOmitted?: boolean;
}

const MAX_PATHS_PER_REASON = 3;
/** Dependency names shown per file in the new-dependency reason. */
const MAX_DEPS_PER_REASON = 5;

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, MAX_PATHS_PER_REASON).join(', ');
  return paths.length > MAX_PATHS_PER_REASON ? `${shown} and ${paths.length - MAX_PATHS_PER_REASON} more` : shown;
}

function withTag(files: RatedFile[], tag: RiskTag): RatedFile[] {
  return files.filter((f) => f.risk.tags.includes(tag));
}

function levelOf(score: number): ChangeRating['level'] {
  return score >= HIGH_AT ? 'high' : score >= MEDIUM_AT ? 'medium' : 'low';
}

/** Aggregate score, level and human-readable reasons for a whole change. */
export function rateChange(input: RatedFile[], opts: RateOptions = {}): ChangeRating {
  const files = [...input].sort((a, b) => byteOrder(a.change.path, b.change.path));
  const notes: string[] = [];
  if (opts.truncated) notes.push('comparison truncated: the rating covers only the listed files');
  if (opts.statsOmitted) notes.push('line stats omitted: large-change and content signals were not evaluated');
  if (files.length === 0) return { score: 0, level: 'low', reasons: notes.length ? notes : ['no files changed'] };

  const max = Math.max(...files.map((f) => f.risk.score));
  const present = HIGH_SIGNAL.filter((t) => files.some((f) => f.risk.tags.includes(t)));
  const totalChurn = files.reduce((s, f) => s + (churnOf(f.change) ?? 0), 0);
  let score = max + HIGH_SIGNAL_BONUS * Math.max(0, present.length - 1) + (totalChurn >= LARGE_CHANGE_LINES ? LARGE_TOTAL_CHURN_BONUS : 0);
  const ciGaming = present.includes('ci-config') && present.includes('test-deletion');
  if (ciGaming) score = Math.max(score, CI_GAMING_FLOOR);
  score = clamp(score);

  const reasons: string[] = [];
  const paths = (tag: RiskTag) => withTag(files, tag).map((f) => f.change.path);
  if (ciGaming) reasons.push('CI configuration changed alongside test deletions (possible CI gaming)');
  if (paths('test-deletion').length) reasons.push(`Tests deleted or disabled: ${listPaths(paths('test-deletion'))}`);
  if (paths('ci-config').length) reasons.push(`CI configuration changed: ${listPaths(paths('ci-config'))}`);
  if (paths('security-sensitive').length) reasons.push(`Security-sensitive paths changed: ${listPaths(paths('security-sensitive'))}`);
  const deps = withTag(files, 'new-dependency');
  if (deps.length) {
    const parts = deps.map((f) => {
      const names = f.risk.evidence?.newDependencies ?? [];
      const shown =
        names.slice(0, MAX_DEPS_PER_REASON).join(', ') +
        (names.length > MAX_DEPS_PER_REASON ? ` and ${names.length - MAX_DEPS_PER_REASON} more` : '');
      return `${f.change.path} (${shown})`;
    });
    reasons.push(`New dependencies added: ${listPaths(parts)}`);
  }
  if (paths('large').length) reasons.push(`Large file changes (>= ${LARGE_CHANGE_LINES} lines or over the size cap): ${listPaths(paths('large'))}`);
  if (totalChurn >= LARGE_CHANGE_LINES) reasons.push(`Large overall change: ${totalChurn} lines across ${files.length} files`);
  if (paths('semantic').length) reasons.push(`Code logic changed in ${paths('semantic').length} file(s): ${listPaths(paths('semantic'))}`);
  if (paths('lockfile').length) reasons.push(`Lockfiles changed: ${listPaths(paths('lockfile'))}`);
  if (paths('generated').length) reasons.push(`Generated files changed: ${listPaths(paths('generated'))}`);
  if (paths('mechanical').length) reasons.push(`Mechanical changes (rename, mode or whitespace only): ${listPaths(paths('mechanical'))}`);
  if (reasons.length === 0) reasons.push(`no risk signals in ${files.length} changed file(s)`);
  reasons.push(...notes);

  return { score, level: levelOf(score), reasons };
}
