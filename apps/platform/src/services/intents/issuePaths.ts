/**
 * The Nexus issue-path index (architecture §11.2): which files open issues
 * are about, and which of them a change touches. Overlap signal has one
 * owner (§0.1), so the issues service writes and matches issue paths only
 * through this module, with the same path rules as workspace intents: a
 * trailing `/` is a directory prefix that covers every descendant.
 *
 * Matching probes the index by key instead of comparing issues one by one:
 * each changed entry and its ancestor prefixes are exact keys (an issue on
 * `src/auth/` matches a change to `src/auth/login.ts`), and each changed
 * prefix (a wide edit collapsed to its directory) is an index range (a
 * change to `src/` matches an issue on `src/auth/login.ts`).
 */

import { ancestorPrefixes, collapseObserved, isPrefix } from './paths';

export const ISSUE_PATH_LIMITS = {
  /** Changed entries probed per change; wider edits collapse to directory prefixes first. */
  probeEntriesMax: 300,
} as const;

/** Index rows for a newly filed issue; nothing when the id was not inserted (a deduplicated report). */
export function issuePathsInsertStatement(db: D1Database, repoId: string, issueId: string, paths: readonly string[]): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO issue_paths (repo_id, path, issue_id)
       SELECT ?1, j.value, i.id FROM json_each(?3) j JOIN issues i ON i.id = ?2 AND i.repo_id = ?1`,
    )
    .bind(repoId, issueId, JSON.stringify(paths));
}

/** Replaces an issue's index rows (by number) with `paths`. */
export function issuePathsReplaceStatements(db: D1Database, repoId: string, number: number, paths: readonly string[]): D1PreparedStatement[] {
  return [
    db.prepare(`DELETE FROM issue_paths WHERE issue_id = (SELECT id FROM issues WHERE repo_id = ?1 AND number = ?2)`).bind(repoId, number),
    db
      .prepare(
        `INSERT OR IGNORE INTO issue_paths (repo_id, path, issue_id)
         SELECT ?1, j.value, i.id FROM json_each(?3) j JOIN issues i ON i.repo_id = ?1 AND i.number = ?2`,
      )
      .bind(repoId, number, JSON.stringify(paths)),
  ];
}

export interface IssueProbe {
  /** Exact index keys: every changed entry and every prefix above it. */
  keys: string[];
  /** Changed directory prefixes, matched as index ranges. */
  prefixes: string[];
}

/** The index probe for a change's changed paths, bounded by collapsing wide edits. */
export function issueProbe(changed: Iterable<string>): IssueProbe {
  const entries = collapseObserved(changed, ISSUE_PATH_LIMITS.probeEntriesMax).paths;
  const keys = new Set<string>();
  for (const e of entries) {
    keys.add(e);
    for (const a of ancestorPrefixes(e)) keys.add(a);
  }
  return { keys: [...keys], prefixes: entries.filter(isPrefix) };
}

/**
 * A subquery of the ids of issues whose indexed paths the probe touches, for
 * `issues.id IN (…)`. Its three parameters start at `?first`: the repo id,
 * the exact keys and the prefixes.
 */
export function touchedIssuesSql(first: number): string {
  const [repo, keys, prefixes] = [first, first + 1, first + 2];
  return `SELECT issue_id FROM issue_paths WHERE repo_id = ?${repo} AND path IN (SELECT value FROM json_each(?${keys}))
          UNION
          SELECT ip.issue_id FROM json_each(?${prefixes}) p
            JOIN issue_paths ip ON ip.repo_id = ?${repo} AND ip.path >= p.value AND ip.path < substr(p.value, 1, length(p.value) - 1) || '0'`;
}

/** Bind values for `touchedIssuesSql`, in order. */
export function touchedIssuesBinds(repoId: string, probe: IssueProbe): [string, string, string] {
  return [repoId, JSON.stringify(probe.keys), JSON.stringify(probe.prefixes)];
}

/** Statement that removes a repository's issue-path index, for the repo DELETE batch. */
export function issuePathsCleanupStatement(db: D1Database, repoId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM issue_paths WHERE repo_id = ?').bind(repoId);
}
