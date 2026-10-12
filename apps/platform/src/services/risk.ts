/**
 * Risk for one computed tree pair: per-file classification and the
 * change-level rating from packages/review. Content is read only for the few
 * files whose tags depend on it (manifests, modified tests), only when line
 * stats were computed, and within RISK_BUDGETS; every other content fact
 * (whitespace-only, generated marker) arrives as a hint from the line-count
 * pass. The result is stored in the content-addressed compare body.
 */

import type { TreeChange } from '@kvarm/gitops';
import { classifyFile, needsContent, rateChange, type ChangeRating, type RiskChange, type RiskContent } from '@kvarm/review';
import { runPool } from './pool';

export type { ChangeRating } from '@kvarm/review';

export interface FileRisk {
  score: number;
  tags: string[];
}

/** Line-count facts for one file; null entries mean nothing is known. */
export interface RiskStat {
  additions?: number;
  deletions?: number;
  binary?: boolean;
  tooLarge?: boolean;
  whitespaceOnly?: boolean;
  generated?: boolean;
}

export interface RiskInput {
  changes: TreeChange[];
  /** Per-file stats in `changes` order, or null when stats were omitted. */
  stats: Array<RiskStat | null> | null;
  truncated: boolean;
  /** A blob's text (null when missing, binary or over RISK_BUDGETS.maxTextBytes). */
  readText(hash: string): Promise<string | null>;
}

export interface RiskResult {
  files: FileRisk[];
  rating: ChangeRating;
}

export const RISK_BUDGETS = {
  /** Files whose content is read for risk, in path order. */
  maxContentFiles: 50,
  /** Per-blob size cap for risk content. */
  maxTextBytes: 1024 * 1024,
  /** Texts kept from the line-count pass for reuse by risk. */
  maxKeptBytes: 16 * 1024 * 1024,
  concurrency: 6,
} as const;

function riskChange(c: TreeChange, s: RiskStat | null): RiskChange {
  const out: RiskChange = {
    path: c.path,
    status: c.status,
    oldHash: c.oldHash,
    newHash: c.newHash,
    oldMode: c.oldMode,
    newMode: c.newMode,
  };
  if (c.oldPath !== undefined) out.oldPath = c.oldPath;
  if (s?.additions !== undefined && s.deletions !== undefined) {
    out.additions = s.additions;
    out.deletions = s.deletions;
  }
  if (s?.binary) out.binary = true;
  if (s?.tooLarge) out.tooLarge = true;
  return out;
}

export async function assessRisk(input: RiskInput): Promise<RiskResult> {
  const changes = input.changes.map((c, i) => riskChange(c, input.stats?.[i] ?? null));
  const hints = (i: number): RiskContent => {
    const s = input.stats?.[i];
    if (!s || s.binary || s.tooLarge) return {};
    return { whitespaceOnly: s.whitespaceOnly === true, generatedMarker: s.generated === true };
  };
  const classified = changes.map((c, i) => ({ change: c, risk: classifyFile(c, hints(i)) }));

  if (input.stats) {
    const wanted = changes
      .map((c, i) => ({ i, want: needsContent(c) }))
      .filter((w) => w.want.old || w.want.new)
      .slice(0, RISK_BUDGETS.maxContentFiles);
    // Classify as each file's texts arrive so no more than `concurrency` files' texts are held.
    await runPool(wanted, RISK_BUDGETS.concurrency, async ({ i, want }) => {
      const c = changes[i]!;
      const [oldText, newText] = await Promise.all([
        want.old && c.oldHash ? input.readText(c.oldHash) : null,
        want.new && c.newHash ? input.readText(c.newHash) : null,
      ]);
      classified[i] = { change: c, risk: classifyFile(c, { ...hints(i), oldText, newText }) };
    });
  }

  return {
    files: classified.map(({ risk }) => ({ score: risk.score, tags: risk.tags })),
    rating: rateChange(classified, { truncated: input.truncated, statsOmitted: input.stats === null }),
  };
}
