/** Review heuristics (risk classification, guard rules, flake detection). */

export * from './risk';
export { countTestCases, dependencyNames, hasGeneratedMarker, isWhitespaceOnlyChange, GENERATED_MARKER_WINDOW } from './content';
export {
  isCiConfigPath,
  isCodePath,
  isGeneratedPath,
  isLockfilePath,
  isSecuritySensitivePath,
  isTestPath,
  manifestKind,
} from './paths';

/** Normalizes a raw risk score to an integer in [0, 100]; non-finite input scores 0. */
export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, Math.round(score)));
}
