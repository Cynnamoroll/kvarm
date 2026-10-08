/**
 * Risk hook for compare. Runs once per computed tree pair (the result is
 * stored inside the content-addressed compare body), with the changed files
 * and a bounded reader for their blob contents.
 *
 * This neutral implementation rates everything low; the review package
 * (classifyFile/rateChange) plugs in here.
 */

import type { TreeChange } from '@forge/gitops';

export interface FileRisk {
  score: number;
  tags: string[];
}

export interface ChangeRating {
  score: number;
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface RiskInput {
  changes: TreeChange[];
  /** Per-file line counts where computed (same order as `changes`). */
  stats: Array<{ additions: number; deletions: number; binary: boolean } | null>;
  /** Reads a blob's text (null when missing, binary or over the size cap). */
  readText(hash: string): Promise<string | null>;
}

export interface RiskResult {
  files: FileRisk[];
  rating: ChangeRating;
}

export async function assessRisk(input: RiskInput): Promise<RiskResult> {
  return {
    files: input.changes.map(() => ({ score: 0, tags: [] })),
    rating: { score: 0, level: 'low', reasons: [] },
  };
}
