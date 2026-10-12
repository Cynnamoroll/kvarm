/**
 * Deterministic conflict resolution (architecture §3 resolve.ts), the stage
 * between git's merge and a human or agent.
 *
 * Rules, in the order a merge meets them:
 *  - non-overlapping hunks in one file: diff3 already merges them (merge3
 *    reports `non-overlapping`);
 *  - the identical change on both sides: merged once (`identical-change`);
 *  - both sides adding the identical file: one path (`add-add-identical`);
 *  - a conflicting hunk whose two sides differ only in whitespace: the
 *    target's (ours) variant wins (`whitespace-only`). git refuses these;
 *    this is the one rule that goes beyond git.
 * Lockfiles are never resolved here, whatever the hunk: their content is
 * generated, so a conflict needs regeneration by an agent and is marked
 * `needsRegeneration`. Everything else that still conflicts is left as is.
 */

import type { HunkResolver, MergeConflict } from './merge3';

export interface ResolveOptions {
  /** Paths whose conflicts need regeneration rather than text resolution. */
  isLockfile(path: string): boolean;
}

/** A conflict left after resolution; lockfiles carry `needsRegeneration`. */
export type ClassifiedConflict = MergeConflict & { needsRegeneration?: true };

// Records are byte strings (one char per byte): only ASCII whitespace counts,
// so UTF-8 continuation bytes such as 0x85 or 0xA0 are never mistaken for it.
const WS_RUN = /[ \t\r\n\f\v]+/g;

function normalized(records: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of records) {
    const line = r.replace(WS_RUN, ' ').trim();
    if (line !== '') out.push(line);
  }
  return out;
}

/**
 * Whether two hunks say the same thing up to whitespace: runs of spaces,
 * tabs and line-end characters count as one space, leading/trailing ones
 * and blank lines do not count. Whitespace between two words still has to
 * exist on both sides (`a b` is not `ab`).
 */
export function whitespaceEquivalent(ours: readonly string[], theirs: readonly string[]): boolean {
  const a = normalized(ours);
  const b = normalized(theirs);
  if (a.length !== b.length) return false;
  return a.every((line, i) => line === b[i]);
}

/** merge3's hunk resolver for the deterministic rules: whitespace-only hunks go to ours, never in lockfiles. */
export function deterministicResolver(opts: ResolveOptions): HunkResolver {
  return (path, ours, theirs) => (!opts.isLockfile(path) && whitespaceEquivalent(ours, theirs) ? 'ours' : null);
}

/** Marks the conflicts that need regeneration (lockfiles); the order is kept. */
export function classifyConflicts(conflicts: readonly MergeConflict[], opts: ResolveOptions): ClassifiedConflict[] {
  return conflicts.map((c) => (opts.isLockfile(c.path) ? { ...c, needsRegeneration: true as const } : c));
}
