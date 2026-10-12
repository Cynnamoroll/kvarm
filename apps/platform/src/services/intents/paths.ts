/**
 * Path rules for the Nexus intent index (architecture §11.2): normalized,
 * repo-relative paths, where a trailing `/` marks a directory prefix that
 * covers every descendant. The index stores a prefix as one row, so a
 * declaration or a wide edit never materializes one row per file.
 */

export const INTENT_LIMITS = {
  /** Entries in one declaration (paths + prefixes, before subsumption). */
  declaredMax: 64,
  pathMaxBytes: 512,
  depthMax: 32,
  /** Observed index rows per workspace; wider edits collapse to directory prefixes. */
  observedMax: 300,
  ttlMinSeconds: 60,
  ttlMaxSeconds: 30 * 86_400,
  forecastPathsMax: 20,
  forecastPageDefault: 50,
  forecastPageMax: 100,
  /** Index entries read below each query prefix (a range is ordered by path, so it cannot stop at the page). */
  forecastRangeHitMax: 1_000,
  /** Evidence items returned per forecast match (the count still covers all). */
  evidenceMax: 20,
  overlapPageDefault: 50,
  overlapPageMax: 100,
  /** Shared-path groups and prefix hits read per overlap request. */
  overlapGroupMax: 500,
  overlapPrefixHitMax: 2_000,
  /** Workspaces taken per shared path (by id); pairs among the rest of a wider group are not enumerated. */
  overlapGroupMembersMax: 40,
  /** Workspace pairs visited per overlap request, across all shared paths and prefix hits. */
  overlapPairVisitMax: 4_000,
  /** Distinct pairs derived per overlap request. */
  overlapPairMax: 1_000,
  overlapPathsPerPair: 50,
  /** Workspaces with an incomplete observed index listed per forecast/overlap response. */
  incompleteListMax: 20,
} as const;

export type PathResult = { ok: true; value: string } | { ok: false; error: string };

const encoder = new TextEncoder();
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\x00-\x1f\x7f\\]/;

/** One normalized path or prefix: `./` and empty segments drop out; absolute, `..` and empty paths are refused. */
export function normalizePath(raw: unknown): PathResult {
  if (typeof raw !== 'string') return { ok: false, error: 'paths must be strings' };
  if (encoder.encode(raw).length > INTENT_LIMITS.pathMaxBytes) {
    return { ok: false, error: `path longer than ${INTENT_LIMITS.pathMaxBytes} bytes` };
  }
  if (FORBIDDEN.test(raw)) return { ok: false, error: `path has a control character or backslash: ${JSON.stringify(raw.slice(0, 80))}` };
  if (raw.startsWith('/')) return { ok: false, error: `absolute path not allowed: ${raw.slice(0, 80)}` };
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { ok: false, error: `'..' segment not allowed: ${raw.slice(0, 80)}` };
  if (segments.length === 0) return { ok: false, error: 'empty path' };
  if (segments.length > INTENT_LIMITS.depthMax) return { ok: false, error: `path deeper than ${INTENT_LIMITS.depthMax} segments` };
  return { ok: true, value: segments.join('/') + (raw.endsWith('/') ? '/' : '') };
}

export const isPrefix = (p: string) => p.endsWith('/');

/** Whether index entry `entry` covers `path` (equal, or a prefix above it). */
export function covers(entry: string, path: string): boolean {
  return entry === path || (isPrefix(entry) && path.startsWith(entry));
}

/** Two entries touch the same files when either covers the other. */
export function intersects(a: string, b: string): boolean {
  return covers(a, b) || covers(b, a);
}

/** The prefixes strictly above `path` (`a/b/c.ts` → `a/`, `a/b/`). */
export function ancestorPrefixes(path: string): string[] {
  const segments = path.split('/').filter((s) => s !== '');
  const out: string[] = [];
  for (let i = 1; i < segments.length; i++) out.push(`${segments.slice(0, i).join('/')}/`);
  return out;
}

/** Exclusive upper bound of the index range holding a prefix and its descendants (`/` + 1 is `0`). */
export function prefixUpper(prefix: string): string {
  return `${prefix.slice(0, -1)}0`;
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sorted, deduplicated, without entries a declared prefix already covers.
 * One sweep after the sort: the entries a prefix covers are exactly the
 * contiguous run that follows it in sorted order, so only the latest kept
 * prefix can cover the next entry.
 */
export function minimalCover(entries: Iterable<string>): string[] {
  const sorted = [...new Set(entries)].sort(byString);
  const out: string[] = [];
  let open: string | null = null;
  for (const p of sorted) {
    if (open !== null && p.startsWith(open)) continue;
    out.push(p);
    if (isPrefix(p)) open = p;
  }
  return out;
}

export interface Declaration {
  paths: string[];
  ttlSeconds: number | null;
}

export type DeclarationResult = { ok: true; value: Declaration } | { ok: false; error: string };

/**
 * `{paths: string[], prefixes?: string[], ttlSeconds?}`. A `paths` entry
 * ending in `/` is a prefix; every `prefixes` entry is one. The stored
 * declaration is the minimal cover of both.
 */
export function normalizeDeclaration(input: unknown): DeclarationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, error: 'intent must be an object {paths, prefixes?, ttlSeconds?}' };
  const b = input as Record<string, unknown>;
  if (!Array.isArray(b.paths)) return { ok: false, error: 'intent.paths must be an array of repo-relative paths' };
  if (b.prefixes !== undefined && !Array.isArray(b.prefixes)) return { ok: false, error: 'intent.prefixes must be an array' };
  const prefixes = (b.prefixes as unknown[] | undefined) ?? [];
  const raw = [...b.paths, ...prefixes.map((p) => (typeof p === 'string' && !p.endsWith('/') ? `${p}/` : p))];
  if (raw.length === 0) return { ok: false, error: 'intent must name at least one path or prefix' };
  if (raw.length > INTENT_LIMITS.declaredMax) return { ok: false, error: `intent may name at most ${INTENT_LIMITS.declaredMax} paths and prefixes` };
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizePath(r);
    if (!n.ok) return n;
    out.push(n.value);
  }
  let ttlSeconds: number | null = null;
  if (b.ttlSeconds !== undefined && b.ttlSeconds !== null) {
    const t = b.ttlSeconds;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < INTENT_LIMITS.ttlMinSeconds || t > INTENT_LIMITS.ttlMaxSeconds) {
      return { ok: false, error: `intent.ttlSeconds must be an integer ${INTENT_LIMITS.ttlMinSeconds}-${INTENT_LIMITS.ttlMaxSeconds}` };
    }
    ttlSeconds = t;
  }
  return { ok: true, value: { paths: minimalCover(out), ttlSeconds } };
}

export interface Collapsed {
  paths: string[];
  /** Some entries are directory prefixes standing for several changed files. */
  collapsed: boolean;
  /** Even top-level prefixes did not fit: entries beyond the cap were dropped. */
  truncated: boolean;
}

/**
 * Bounds an observed path set to `max` entries: when it is wider, files
 * collapse into their directory at the deepest level that fits, so every
 * changed file stays covered by some entry.
 */
export function collapseObserved(paths: Iterable<string>, max: number = INTENT_LIMITS.observedMax): Collapsed {
  const unique = [...new Set(paths)].sort(byString);
  if (unique.length <= max) return { paths: unique, collapsed: false, truncated: false };
  // Offsets of each path's separators, so a level is a slice instead of a split and join.
  const cuts = unique.map((p) => {
    const at: number[] = [];
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) at.push(i);
    return at;
  });
  let depth = 1;
  for (const at of cuts) depth = Math.max(depth, at.length + 1);
  const level = (d: number) => minimalCover(unique.map((p, i) => (cuts[i]!.length >= d ? p.slice(0, cuts[i]![d - 1]! + 1) : p)));
  // A shallower level never has more entries than a deeper one (each of its
  // prefixes stands for a non-empty group of the deeper level's entries), so
  // the deepest level that fits is found by binary search.
  let lo = 1;
  let hi = depth - 1;
  let fit: string[] | null = null;
  while (lo <= hi) {
    const d = (lo + hi) >> 1;
    const cover = level(d);
    if (cover.length <= max) {
      fit = cover;
      lo = d + 1;
    } else {
      hi = d - 1;
    }
  }
  if (fit !== null) return { paths: fit, collapsed: true, truncated: false };
  return { paths: level(1).slice(0, max), collapsed: true, truncated: true };
}
