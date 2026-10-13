/**
 * The Nexus semantic dependency signal (architecture §11.2): advisory import,
 * export-surface and contract-family evidence that complements path overlap.
 *
 * Writes: push reconciliation (`reconcileObserved`) reads the workspace's
 * changed files at its head through `@kvarm/review`'s bounded analysis and
 * swaps its `workspace_semantic` rows in the same guarded batch as its
 * observed set, so the two always describe one head. Reads: forecast and
 * overlap probe those rows against query paths or other workspaces' observed
 * rows inside their existing D1 batch, so they stay `art = 0`.
 *
 * Advisory only: no push, merge, queue, check or ranking path reads these
 * rows, and an empty result is not proof of compatibility.
 */

import { analyzeDependencies, contractFamily, type DependencyAnalysis, type SemanticBlob, type SemanticTreeSource } from '@kvarm/review';
import type { LazyRepo } from '../../artifacts/repo';
import { isPrefix, prefixUpper } from './paths';

export const SEMANTIC_READ_LIMITS = {
  /** Hits read per forecast probe (query consumers, contract families, your own edges). */
  forecastHitMax: 200,
  /** Workspaces reported per semantic forecast. */
  matchMax: 100,
  /** Import rows scanned per overlap request (in key order) and pair hits kept from them. */
  overlapScanMax: 2_000,
  overlapHitMax: 500,
  /** Contract families read per overlap request. */
  overlapFamilyMax: 200,
  pairMax: 200,
  evidenceMax: 20,
  /** Names kept per stored import edge. */
  namesMax: 20,
} as const;

export type SemanticConfidence = 'semantic:export' | 'semantic:import' | 'semantic:contract';

const RANK: Record<SemanticConfidence, number> = { 'semantic:export': 0, 'semantic:import': 1, 'semantic:contract': 2 };

export const SEMANTIC_NOTE =
  'Advisory only: semantic matches come from a bounded import/export/contract-file heuristic over each workspace\'s changed files at its reconciled head (not a compiler or a model). They rank below observed path matches; an empty or truncated result is not proof of compatibility, and nothing here blocks pushes, merges, the queue or checks.';

// ---------------------------------------------------------------------------
// Writes (push reconciliation)
// ---------------------------------------------------------------------------

/** `@kvarm/review`'s tree source over the Artifacts handle; the empty tree needs no read. */
class ArtifactsSemanticSource implements SemanticTreeSource {
  constructor(private readonly artifacts: LazyRepo) {}

  async readTree(hash: string) {
    const entries = await (await this.artifacts.get()).readTree(hash);
    return entries ? entries.map((e) => ({ name: e.name, mode: e.mode, hash: e.hash })) : null;
  }

  async readBlob(hash: string, maxBytes: number): Promise<SemanticBlob> {
    let blob: Blob | null;
    try {
      blob = await (await this.artifacts.get()).readBlob(hash);
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'MEMORY_LIMIT') return { tooLarge: true };
      throw err;
    }
    if (!blob) return null;
    if (blob.size > maxBytes) return { tooLarge: true };
    return { bytes: new Uint8Array(await blob.arrayBuffer()) };
  }
}

export interface SemanticRecord {
  /** `[kind, key, detail JSON]` rows for `workspace_semantic`. */
  rows: Array<[string, string, string]>;
  truncated: string | null;
  detail: string;
}

/** Rows from an analysis; contract files group by family. */
export function semanticRows(a: DependencyAnalysis): Array<[string, string, string]> {
  const rows: Array<[string, string, string]> = [];
  for (const e of a.edges) {
    const names = e.names?.slice(0, SEMANTIC_READ_LIMITS.namesMax);
    rows.push(['import', e.target, JSON.stringify({ depth: e.depth, chain: e.chain, ...(names && names.length > 0 ? { names } : {}) })]);
  }
  for (const x of a.exportChanges) rows.push(['export', x.path, JSON.stringify({ added: x.added, removed: x.removed })]);
  const families = new Map<string, string[]>();
  for (const c of a.contracts) families.set(c.family, [...(families.get(c.family) ?? []), c.path]);
  for (const [family, paths] of families) rows.push(['contract', family, JSON.stringify({ paths })]);
  return rows;
}

/**
 * The semantic record of one reconciliation. Never throws: a failed analysis
 * is recorded as the truncation reason with no rows, and the observed set it
 * rides with still lands.
 */
export async function analyzeSemantic(
  artifacts: LazyRepo,
  trees: { base: string; head: string },
  changed: readonly string[],
  changedIncomplete: string | null,
): Promise<SemanticRecord> {
  try {
    const a = await analyzeDependencies(new ArtifactsSemanticSource(artifacts), { headTree: trees.head, baseTree: trees.base, changed });
    const reasons = [...(changedIncomplete ? [`changed paths incomplete: ${changedIncomplete}`] : []), ...a.reasons];
    return {
      rows: semanticRows(a),
      truncated: reasons.length > 0 ? reasons.join('; ') : null,
      detail: `${a.edges.length} import edges, ${a.exportChanges.length} export changes, ${a.contracts.length} contract files (${a.reads.blobs} blob, ${a.reads.trees} tree reads)`,
    };
  } catch (err) {
    const reason = `semantic analysis failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
    return { rows: [], truncated: reason, detail: reason };
  }
}

/**
 * Swaps a workspace's semantic rows, for the batch right after
 * `observedWriteStatements`: each lands only while the workspace still holds
 * exactly that observation (event time and head), so a reconciliation that
 * lost to a newer push writes nothing here either.
 */
export function semanticWriteStatements(
  db: D1Database,
  w: { repoId: string; workspaceId: string; eventAt: number; headSha: string; now: number; record: SemanticRecord },
): D1PreparedStatement[] {
  const guard = `EXISTS (SELECT 1 FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2 AND w.status = 'active'
                   AND w.observed_event_at = ?3 AND w.observed_head_sha = ?4)`;
  return [
    db
      .prepare(`UPDATE workspaces SET semantic_head_sha = ?4, semantic_at = ?5, semantic_truncated = ?6 WHERE repo_id = ?1 AND id = ?2 AND ${guard}`)
      .bind(w.repoId, w.workspaceId, w.eventAt, w.headSha, w.now, w.record.truncated),
    db.prepare(`DELETE FROM workspace_semantic WHERE repo_id = ?1 AND workspace_id = ?2 AND ${guard}`).bind(w.repoId, w.workspaceId, w.eventAt, w.headSha),
    db
      .prepare(
        `INSERT OR IGNORE INTO workspace_semantic (repo_id, kind, key, workspace_id, detail)
         SELECT ?1, j.value ->> 0, j.value ->> 1, ?2, j.value ->> 2 FROM json_each(?5) j WHERE ${guard}`,
      )
      .bind(w.repoId, w.workspaceId, w.eventAt, w.headSha, JSON.stringify(w.record.rows)),
  ];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SemanticEvidence {
  kind: 'import' | 'contract';
  confidence: SemanticConfidence;
  /** Import: the consumer's changed file, any intermediate module, then the imported path or Go package directory. Contract: one file of each side. */
  chain: string[];
  depth?: number;
  /** Names the last hop imports, where its syntax lists them. */
  names?: string[];
  /** The path the other side changes (a query path or an observed path). */
  changed: string;
  /** Who changes `changed`: a workspace id, or `query`. */
  changedBy: string;
  /** Who imports it (import) or the other side (contract): a workspace id, or `query`. */
  consumer: string;
  /** The changed module's export surface change, when known. */
  exportChange?: { added: string[]; removed: string[] };
  family?: string;
}

export interface SemanticWorkspace {
  workspace: string;
  task: string | null;
  agent: string | null;
  agentId: string | null;
  base: string | null;
  /** The head the workspace's semantic rows were read at, and when. */
  semanticHeadSha: string | null;
  semanticAt: string | null;
  semanticTruncated: boolean;
  observedHeadSha: string | null;
}

export interface SemanticMatch extends SemanticWorkspace {
  /** The strongest class among the evidence. */
  confidence: SemanticConfidence;
  evidence: SemanticEvidence[];
  evidenceCount: number;
  evidenceTruncated?: true;
}

export interface SemanticIncomplete {
  workspace: string;
  reason: string;
}

export interface SemanticForecast {
  advisory: true;
  note: string;
  matches: SemanticMatch[];
  truncated: boolean;
  truncatedReason?: string;
  /** Active workspaces whose semantic rows are incomplete (absent when there are none). */
  incomplete?: SemanticIncomplete[];
}

export interface SemanticPair {
  /** Sorted workspace ids. */
  workspaces: [string, string];
  confidence: SemanticConfidence;
  evidence: SemanticEvidence[];
  evidenceCount: number;
  evidenceTruncated?: true;
  heads: [SemanticWorkspace, SemanticWorkspace];
}

export interface SemanticOverlap {
  advisory: true;
  note: string;
  pairs: SemanticPair[];
  truncated: boolean;
  truncatedReason?: string;
  incomplete?: SemanticIncomplete[];
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Workspace columns every read returns as `wj`: id, task, agent, agent_id, base_ref, semantic_head_sha, semantic_at, semantic_truncated, observed_head_sha. */
const WS_JSON = (w: string) =>
  `json_array(${w}.id, ${w}.task, ${w}.agent, ${w}.agent_id, ${w}.base_ref, ${w}.semantic_head_sha, ${w}.semantic_at, ${w}.semantic_truncated, ${w}.observed_head_sha)`;

type WsTuple = [string, string | null, string | null, string | null, string | null, string | null, number | null, string | null, string | null];

function wsOf(json: string): SemanticWorkspace {
  const t = JSON.parse(json) as WsTuple;
  return {
    workspace: t[0],
    task: t[1],
    agent: t[2],
    agentId: t[3],
    base: t[4],
    semanticHeadSha: t[5],
    semanticAt: iso(t[6]),
    semanticTruncated: t[7] !== null,
    observedHeadSha: t[8],
  };
}

interface ImportDetail {
  depth: number;
  chain: string[];
  names?: string[];
}

function parseDetail<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Whether import key `key` names the module `path`: equal, or `path` sits directly in Go package directory `key`. */
function keyNames(key: string, path: string): boolean {
  if (key === path) return true;
  return isPrefix(key) && path.startsWith(key) && !path.slice(key.length).includes('/');
}

function importEvidence(
  detail: ImportDetail,
  changed: string,
  changedBy: string,
  consumer: string,
  exportJson: string | null,
): SemanticEvidence {
  const exportChange = parseDetail<{ added: string[]; removed: string[] }>(exportJson);
  const ev: SemanticEvidence = {
    kind: 'import',
    confidence: exportChange ? 'semantic:export' : 'semantic:import',
    chain: detail.chain,
    depth: detail.depth,
    changed,
    changedBy,
    consumer,
  };
  if (detail.names) ev.names = detail.names;
  if (exportChange) ev.exportChange = exportChange;
  return ev;
}

const byEvidence = (a: SemanticEvidence, b: SemanticEvidence) =>
  RANK[a.confidence] - RANK[b.confidence] || (a.depth ?? 0) - (b.depth ?? 0) || cmp(a.changed, b.changed) || cmp(a.chain.join('\0'), b.chain.join('\0'));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Evidence deduplicated, ordered strongest first and capped, with the class it earns. */
function settle(all: SemanticEvidence[]): Pick<SemanticMatch, 'confidence' | 'evidence' | 'evidenceCount' | 'evidenceTruncated'> {
  const seen = new Map<string, SemanticEvidence>();
  for (const e of all) {
    const k = JSON.stringify([e.kind, e.chain, e.changed, e.changedBy, e.consumer]);
    if (!seen.has(k)) seen.set(k, e);
  }
  const list = [...seen.values()].sort(byEvidence);
  const out: Pick<SemanticMatch, 'confidence' | 'evidence' | 'evidenceCount' | 'evidenceTruncated'> = {
    confidence: list[0]!.confidence,
    evidence: list.slice(0, SEMANTIC_READ_LIMITS.evidenceMax),
    evidenceCount: list.length,
  };
  if (list.length > SEMANTIC_READ_LIMITS.evidenceMax) out.evidenceTruncated = true;
  return out;
}

function incompleteStatement(db: D1Database, repoId: string, base: string | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT w.id AS workspace, w.semantic_truncated AS reason FROM workspaces w INDEXED BY idx_ws_semantic_incomplete
        WHERE w.repo_id = ?1 AND w.status = 'active' AND w.semantic_truncated IS NOT NULL AND (?2 IS NULL OR w.base_ref = ?2)
        ORDER BY w.id LIMIT ${SEMANTIC_READ_LIMITS.matchMax + 1}`,
    )
    .bind(repoId, base);
}

function incompleteOf(result: D1Result | undefined, reasons: string[]): SemanticIncomplete[] | null {
  const rows = (result?.results as SemanticIncomplete[] | undefined) ?? [];
  if (rows.length === 0) return null;
  const max = SEMANTIC_READ_LIMITS.matchMax;
  reasons.push(
    `the semantic rows of ${rows.length > max ? `more than ${max}` : rows.length} active workspace(s) are incomplete (a budget was spent or the analysis failed), so dependencies may be missing; see semantic.incomplete`,
  );
  return rows.slice(0, max).map((r) => ({ workspace: r.workspace, reason: r.reason }));
}

/** Rows of another workspace's observed entries that an import key of `m` names (exact, Go package, or a collapsed prefix above it). */
const OBSERVED_FOR_KEY = (m: string) => `
  SELECT ${m}.key AS key, ${m}.detail AS detail, ${m}.workspace_id AS consumer, p.path AS path, p.workspace_id AS changer
    FROM M ${m} CROSS JOIN workspace_paths p ON p.repo_id = ?1 AND p.kind = 'observed' AND p.path = ${m}.key AND p.workspace_id != ${m}.workspace_id
  UNION ALL
  SELECT ${m}.key, ${m}.detail, ${m}.workspace_id, p.path, p.workspace_id
    FROM M ${m} CROSS JOIN workspace_paths p ON p.repo_id = ?1 AND p.kind = 'observed' AND p.workspace_id != ${m}.workspace_id
         AND p.path > ${m}.key AND p.path < substr(${m}.key, 1, length(${m}.key) - 1) || '0'
   WHERE substr(${m}.key, -1) = '/'
  UNION ALL
  SELECT a.key, a.detail, a.workspace_id, p.path, p.workspace_id
    FROM A a CROSS JOIN workspace_paths p ON p.repo_id = ?1 AND p.kind = 'observed' AND p.path = a.pre AND p.workspace_id != a.workspace_id
   WHERE a.pre != '' AND a.pre != a.key`;

/**
 * The ancestor prefixes of every key in M (`a/b/c.ts` → `a/`, `a/b/`), so a
 * collapsed observed prefix above a key is found by exact index probes that
 * read nothing when no workspace holds one.
 */
const ANCESTORS = `A(key, detail, workspace_id, rest, pre) AS (
    SELECT key, detail, workspace_id, key, '' FROM M
    UNION ALL
    SELECT key, detail, workspace_id, substr(rest, instr(rest, '/') + 1), pre || substr(rest, 1, instr(rest, '/')) FROM A WHERE instr(rest, '/') > 0
  )`;

export interface SemanticForecastPlan {
  statements: D1PreparedStatement[];
  read(results: readonly (D1Result | undefined)[]): SemanticForecast;
}

/**
 * The statements for a forecast's semantic layer (for the caller's batch)
 * and the reader of their results. Three probes:
 *  - consumers of the query: active workspaces whose changed files import a
 *    query path (directly or through one module), or a Go package directory
 *    holding it, or anything below a query prefix;
 *  - contract families: workspaces changing contract files of a family a
 *    query path belongs to;
 *  - with `exclude` (your own workspace): workspaces whose observed changes
 *    your changed files import, and whose contract families you share.
 */
export function forecastSemanticPlan(
  db: D1Database,
  q: { repoId: string; paths: string[]; base: string | null; exclude: string | null },
): SemanticForecastPlan {
  const L = SEMANTIC_READ_LIMITS;
  const keys = new Set<string>();
  const ranges: string[] = [];
  const families = new Map<string, string[]>();
  for (const p of q.paths) {
    keys.add(p);
    if (isPrefix(p)) ranges.push(p);
    else {
      // A Go import names the package directory holding the file; no other language stores a directory key.
      if (p.endsWith('.go') && p.includes('/')) keys.add(p.slice(0, p.lastIndexOf('/') + 1));
      const f = contractFamily(p);
      if (f) families.set(f, [...(families.get(f) ?? []), p]);
    }
  }
  const filter = `w.repo_id = ?1 AND w.status = 'active' AND (?3 IS NULL OR w.base_ref = ?3) AND (?4 IS NULL OR w.id != ?4)`;
  // Named slots, so probes with nothing to look up are left out of the batch.
  type Slot = 'consumers' | 'range' | 'families' | 'ownImports' | 'ownContracts' | 'ownExports' | 'incomplete';
  const slots: Array<{ slot: Slot; what: string; stmt: D1PreparedStatement }> = [];
  slots.push({
    slot: 'consumers',
    what: 'the query paths',
    stmt: db
      .prepare(
        `SELECT s.key, s.detail, ${WS_JSON('w')} AS wj FROM workspace_semantic s CROSS JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.repo_id = ?1 AND s.kind = 'import' AND s.key IN (SELECT value FROM json_each(?2)) AND ${filter}
          ORDER BY s.key, s.workspace_id LIMIT ${L.forecastHitMax + 1}`,
      )
      .bind(q.repoId, JSON.stringify([...keys]), q.base, q.exclude),
  });
  for (const r of ranges) {
    slots.push({
      slot: 'range',
      what: `below ${r}`,
      stmt: db
        .prepare(
          `SELECT s.key, s.detail, ${WS_JSON('w')} AS wj FROM workspace_semantic s CROSS JOIN workspaces w ON w.id = s.workspace_id
            WHERE s.repo_id = ?1 AND s.kind = 'import' AND s.key >= ?2 AND s.key < ?5 AND ${filter}
            ORDER BY s.key, s.workspace_id LIMIT ${L.forecastHitMax + 1}`,
        )
        .bind(q.repoId, r, q.base, q.exclude, prefixUpper(r)),
    });
  }
  if (families.size > 0) {
    slots.push({
      slot: 'families',
      what: 'the query contract families',
      stmt: db
        .prepare(
          `SELECT s.key, s.detail, ${WS_JSON('w')} AS wj FROM workspace_semantic s CROSS JOIN workspaces w ON w.id = s.workspace_id
            WHERE s.repo_id = ?1 AND s.kind = 'contract' AND s.key IN (SELECT value FROM json_each(?2)) AND ${filter}
            ORDER BY s.key, s.workspace_id LIMIT ${L.forecastHitMax + 1}`,
        )
        .bind(q.repoId, JSON.stringify([...families.keys()]), q.base, q.exclude),
    });
  }
  const own = q.exclude;
  if (own !== null) {
    slots.push(
      {
        // Your import edges against the others' observed rows, with the export change of the module they changed.
        slot: 'ownImports',
        what: "your workspace's import edges",
        stmt: db
          .prepare(
            `WITH M AS (SELECT key, detail, workspace_id FROM workspace_semantic WHERE repo_id = ?1 AND workspace_id = ?4 AND kind = 'import'),
                  ${ANCESTORS},
                  H AS (${OBSERVED_FOR_KEY('m')})
             SELECT h.key, h.detail, h.path, e.detail AS export, ${WS_JSON('w')} AS wj
               FROM H h CROSS JOIN workspaces w ON w.id = h.changer
               LEFT JOIN workspace_semantic e ON e.repo_id = ?1 AND e.kind = 'export' AND e.key = h.path AND e.workspace_id = h.changer
              WHERE ${filter}
              ORDER BY w.id, h.key, h.path LIMIT ${L.forecastHitMax + 1}`,
          )
          .bind(q.repoId, null, q.base, own),
      },
      {
        slot: 'ownContracts',
        what: "your workspace's contract families",
        stmt: db
          .prepare(
            `SELECT m.key, m.detail AS mine, o.detail, ${WS_JSON('w')} AS wj
               FROM workspace_semantic m
               CROSS JOIN workspace_semantic o ON o.repo_id = m.repo_id AND o.kind = 'contract' AND o.key = m.key AND o.workspace_id != m.workspace_id
               CROSS JOIN workspaces w ON w.id = o.workspace_id
              WHERE m.repo_id = ?1 AND m.workspace_id = ?4 AND m.kind = 'contract' AND ${filter}
              ORDER BY m.key, w.id LIMIT ${L.forecastHitMax + 1}`,
          )
          .bind(q.repoId, null, q.base, own),
      },
      {
        // Export changes of your own modules, so the consumers of a query path you changed rank as semantic:export.
        slot: 'ownExports',
        what: "your workspace's export changes",
        stmt: db
          .prepare(`SELECT key, detail FROM workspace_semantic WHERE repo_id = ?1 AND workspace_id = ?2 AND kind = 'export' LIMIT ${L.forecastHitMax + 1}`)
          .bind(q.repoId, own),
      },
    );
  }
  slots.push({ slot: 'incomplete', what: 'incomplete workspaces', stmt: incompleteStatement(db, q.repoId, q.base) });

  return {
    statements: slots.map((x) => x.stmt),
    read(results) {
      const reasons: string[] = [];
      const ws = new Map<string, { w: SemanticWorkspace; ev: SemanticEvidence[] }>();
      const add = (wj: string, ev: SemanticEvidence) => {
        const w = wsOf(wj);
        let m = ws.get(w.workspace);
        if (!m) {
          m = { w, ev: [] };
          ws.set(w.workspace, m);
        }
        m.ev.push(ev);
      };
      const rowsOf = <T>(slot: Slot): T[] => {
        const out: T[] = [];
        slots.forEach((x, i) => {
          if (x.slot !== slot) return;
          const rows = (results[i]?.results as T[] | undefined) ?? [];
          if (rows.length > L.forecastHitMax) reasons.push(`more than ${L.forecastHitMax} semantic hits for ${x.what}; the rest are not reported, narrow the query`);
          out.push(...rows.slice(0, L.forecastHitMax));
        });
        return out;
      };
      type ImportRow = { key: string; detail: string; wj: string };
      const mineExports = new Map(rowsOf<{ key: string; detail: string }>('ownExports').map((r) => [r.key, r.detail]));
      for (const row of [...rowsOf<ImportRow>('consumers'), ...rowsOf<ImportRow>('range')]) {
        const detail = parseDetail<ImportDetail>(row.detail);
        if (!detail) continue;
        const consumer = wsOf(row.wj).workspace;
        for (const p of q.paths) {
          const hit = isPrefix(p) ? row.key.startsWith(p) : keyNames(row.key, p);
          if (!hit) continue;
          const changed = isPrefix(p) ? row.key : p;
          add(row.wj, importEvidence(detail, changed, 'query', consumer, mineExports.get(changed) ?? null));
        }
      }
      for (const row of rowsOf<ImportRow>('families')) {
        const theirs = parseDetail<{ paths: string[] }>(row.detail)?.paths ?? [];
        for (const qp of families.get(row.key) ?? []) {
          add(row.wj, {
            kind: 'contract',
            confidence: 'semantic:contract',
            chain: [qp, theirs[0] ?? row.key],
            changed: qp,
            changedBy: 'query',
            consumer: wsOf(row.wj).workspace,
            family: row.key,
          });
        }
      }
      if (own !== null) {
        for (const row of rowsOf<{ key: string; detail: string; path: string; export: string | null; wj: string }>('ownImports')) {
          const detail = parseDetail<ImportDetail>(row.detail);
          if (!detail) continue;
          // A Go package directory names only the files directly in it.
          if (isPrefix(row.key) && !isPrefix(row.path) && !keyNames(row.key, row.path)) continue;
          add(row.wj, importEvidence(detail, row.path, wsOf(row.wj).workspace, own, row.export));
        }
        for (const row of rowsOf<{ key: string; mine: string; detail: string; wj: string }>('ownContracts')) {
          const mine = parseDetail<{ paths: string[] }>(row.mine)?.paths ?? [];
          const theirs = parseDetail<{ paths: string[] }>(row.detail)?.paths ?? [];
          add(row.wj, {
            kind: 'contract',
            confidence: 'semantic:contract',
            chain: [mine[0] ?? row.key, theirs[0] ?? row.key],
            changed: theirs[0] ?? row.key,
            changedBy: wsOf(row.wj).workspace,
            consumer: own,
            family: row.key,
          });
        }
      }
      const incomplete = incompleteOf(results[slots.length - 1], reasons);
      const all = [...ws.values()].sort((a, b) => cmp(a.w.workspace, b.w.workspace));
      if (all.length > L.matchMax) reasons.push(`more than ${L.matchMax} semantically related workspaces; the first ${L.matchMax} by id are reported`);
      const out: SemanticForecast = {
        advisory: true,
        note: SEMANTIC_NOTE,
        matches: all.slice(0, L.matchMax).map((m) => ({ ...m.w, ...settle(m.ev) })),
        truncated: reasons.length > 0,
      };
      if (reasons.length > 0) out.truncatedReason = reasons.join('; ');
      if (incomplete) out.incomplete = incomplete;
      return out;
    },
  };
}

export interface SemanticOverlapPlan {
  statements: D1PreparedStatement[];
  read(results: readonly (D1Result | undefined)[]): SemanticOverlap;
}

/**
 * Semantic pairs among active workspaces on `base`: one workspace's changed
 * files import (within the depth limit) a path another changed, or both
 * change contract files of one family. Import rows are scanned in key order
 * up to `overlapScanMax` across the repository, so a repository with more
 * reports `truncated` rather than reading every row.
 */
export function overlapSemanticPlan(db: D1Database, repoId: string, base: string): SemanticOverlapPlan {
  const L = SEMANTIC_READ_LIMITS;
  const statements = [
    db
      .prepare(
        `WITH M AS (SELECT key, detail, workspace_id FROM workspace_semantic WHERE repo_id = ?1 AND kind = 'import' ORDER BY key, workspace_id LIMIT ${L.overlapScanMax}),
              ${ANCESTORS},
              H AS (${OBSERVED_FOR_KEY('m')})
         SELECT h.key, h.detail, h.path, e.detail AS export, ${WS_JSON('wc')} AS consumer, ${WS_JSON('wx')} AS changer
           FROM H h
           CROSS JOIN workspaces wc ON wc.id = h.consumer AND wc.repo_id = ?1 AND wc.status = 'active' AND wc.base_ref = ?2
           CROSS JOIN workspaces wx ON wx.id = h.changer AND wx.repo_id = ?1 AND wx.status = 'active' AND wx.base_ref = ?2
           LEFT JOIN workspace_semantic e ON e.repo_id = ?1 AND e.kind = 'export' AND e.key = h.path AND e.workspace_id = h.changer
          ORDER BY h.key, wc.id, wx.id, h.path LIMIT ${L.overlapHitMax + 1}`,
      )
      .bind(repoId, base),
    db
      .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM workspace_semantic WHERE repo_id = ?1 AND kind = 'import' LIMIT ${L.overlapScanMax + 1})`)
      .bind(repoId),
    db
      .prepare(
        `SELECT s.key, json_group_array(json_array(s.detail, json(${WS_JSON('w')}))) AS members
           FROM workspace_semantic s CROSS JOIN workspaces w ON w.id = s.workspace_id AND w.repo_id = ?1 AND w.status = 'active' AND w.base_ref = ?2
          WHERE s.repo_id = ?1 AND s.kind = 'contract'
          GROUP BY s.key HAVING COUNT(*) > 1 ORDER BY s.key LIMIT ${L.overlapFamilyMax + 1}`,
      )
      .bind(repoId, base),
    incompleteStatement(db, repoId, base),
  ];
  return {
    statements,
    read(results) {
      const reasons: string[] = [];
      const pairs = new Map<string, { heads: Map<string, SemanticWorkspace>; ev: SemanticEvidence[] }>();
      const add = (x: SemanticWorkspace, y: SemanticWorkspace, ev: SemanticEvidence) => {
        if (x.workspace === y.workspace) return;
        const [a, b] = x.workspace < y.workspace ? [x, y] : [y, x];
        const key = `${a.workspace}:${b.workspace}`;
        let p = pairs.get(key);
        if (!p) {
          p = { heads: new Map([[a.workspace, a], [b.workspace, b]]), ev: [] };
          pairs.set(key, p);
        }
        p.ev.push(ev);
      };
      const hits = (results[0]?.results as Array<{ key: string; detail: string; path: string; export: string | null; consumer: string; changer: string }> | undefined) ?? [];
      if (hits.length > L.overlapHitMax) reasons.push(`more than ${L.overlapHitMax} semantic import hits; pairs beyond them are not reported`);
      const scanned = (results[1]?.results as Array<{ n: number }> | undefined)?.[0]?.n ?? 0;
      if (scanned > L.overlapScanMax) reasons.push(`more than ${L.overlapScanMax} import edges in the repository; edges beyond the first ${L.overlapScanMax} by path are not compared`);
      for (const h of hits.slice(0, L.overlapHitMax)) {
        const detail = parseDetail<ImportDetail>(h.detail);
        if (!detail) continue;
        if (isPrefix(h.key) && !isPrefix(h.path) && !keyNames(h.key, h.path)) continue;
        const consumer = wsOf(h.consumer);
        const changer = wsOf(h.changer);
        add(consumer, changer, importEvidence(detail, h.path, changer.workspace, consumer.workspace, h.export));
      }
      const fams = (results[2]?.results as Array<{ key: string; members: string }> | undefined) ?? [];
      if (fams.length > L.overlapFamilyMax) reasons.push(`more than ${L.overlapFamilyMax} shared contract families; the rest are not reported`);
      for (const f of fams.slice(0, L.overlapFamilyMax)) {
        const members = (JSON.parse(f.members) as Array<[string, WsTuple]>).map(([d, t]) => ({
          paths: parseDetail<{ paths: string[] }>(d)?.paths ?? [],
          w: wsOf(JSON.stringify(t)),
        }));
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const [x, y] = [members[i]!, members[j]!];
            add(x.w, y.w, {
              kind: 'contract',
              confidence: 'semantic:contract',
              chain: [x.paths[0] ?? f.key, y.paths[0] ?? f.key],
              changed: y.paths[0] ?? f.key,
              changedBy: y.w.workspace,
              consumer: x.w.workspace,
              family: f.key,
            });
          }
        }
      }
      const incomplete = incompleteOf(results[3], reasons);
      const keys = [...pairs.keys()].sort();
      if (keys.length > L.pairMax) reasons.push(`more than ${L.pairMax} semantic pairs; the first ${L.pairMax} by id are reported`);
      const out: SemanticOverlap = {
        advisory: true,
        note: SEMANTIC_NOTE,
        pairs: keys.slice(0, L.pairMax).map((key) => {
          const p = pairs.get(key)!;
          const [a, b] = key.split(':') as [string, string];
          return { workspaces: [a, b], ...settle(p.ev), heads: [p.heads.get(a)!, p.heads.get(b)!] };
        }),
        truncated: reasons.length > 0,
      };
      if (reasons.length > 0) out.truncatedReason = reasons.join('; ');
      if (incomplete) out.incomplete = incomplete;
      return out;
    },
  };
}

/** `semantic` query flag: absent includes the layer; `0`/`false` leaves it out. */
export function parseSemanticFlag(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === '' || raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}
