/**
 * Pinned draft dependencies between workspaces of one repository
 * (architecture §11.3; the gate lives in services/dependencyGate.ts).
 *
 *   POST   workspaces/:id/dependencies             {onWorkspace, revision}
 *   GET    workspaces/:id/dependencies
 *   POST   workspaces/:id/dependencies/:dep/repin  {revision, onWorkspace?}
 *   DELETE workspaces/:id/dependencies/:dep
 *
 * Edges exist only on request: nothing is inferred from pushed content,
 * overlap or forecasts. A pin names the source's current revision exactly;
 * the chain through any edge holds at most DEPENDENCY_LIMITS.maxDepth
 * workspaces and cycles are refused with their path. Repin and detach are
 * the only ways a pin changes, and neither touches the dependent's ref,
 * base or change. Validation is one batch of indexed reads (the two
 * workspace rows, the dependent's edges and the chain walks above the
 * dependent and below the source, each bounded by the depth cap),
 * independent of how many other workspaces the repository has.
 */

import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import {
  DEPENDENCY_LIMITS,
  dependencyRowsStatement,
  dependencyView,
  emptySettleResult,
  handOffSettlement,
  releaseWakeClaims,
  settleContinuation,
  settleEdgesStatement,
  wakeClaimStatements,
  wakeSetOf,
  type DependencyRow,
  type DependencyView,
  type LandedRow,
  type SettleContinuationResult,
  type SettleMessage,
} from './dependencyGate';
import { RefStoreUnavailable } from './refs';
import { resolveCtx, resumeAutoDependents } from './changes';
import { artifactsMergeSources } from './merge';
import { kickTrain } from './trainKick';
import { WORKSPACE_ID_RE, agentOwnershipDenial, liveRefs, newId, type WorkspaceContext } from './workspaces';

const SHA_RE = /^[0-9a-f]{40}$/;
const DEP_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_SHA = '0000000000000000000000000000000000000000';

type Fail = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

export interface DependencyDeps {
  kick(env: Env, repoId: string, ref: string, reason: string): Promise<void>;
  /** Rejects when a resumed change failed operationally (see resumeAutoDependents). */
  resume(env: Env, repoId: string, numbers: number[], waitUntil: (p: Promise<unknown>) => void): Promise<void>;
}

export const defaultDependencyDeps: DependencyDeps = {
  kick: (env, repoId, ref, reason) => kickTrain(env, repoId, ref, reason),
  resume: (env, repoId, numbers, waitUntil) => resumeAutoDependents(env, repoId, numbers, waitUntil),
};

// ---------------------------------------------------------------------------
// Landing settlement continuation (kvarm-events consumer)
// ---------------------------------------------------------------------------

/**
 * Runs one settlement continuation of a landing for one of its two owners:
 * a `kvarm.dependency-settle` message (`queue`) or the MergeLock alarm
 * (`alarm`), under a fresh claim token. One batch reads the repo and the
 * landing's first unsettled page and claims its wake-pending marks (all
 * empty for a replay, another landing's identity or a deleted repo: nothing
 * else happens), then `settleContinuation` settles at most
 * SETTLE_LIMITS.maxPages pages and does the wake work of the marks it won.
 * The queue owner hands what is left to both owners and throws when a wake
 * effect failed or marks it could not claim remain, so the message is
 * retried and re-derives the work from D1; the alarm owner returns
 * `remaining` (and `heldUntil`) and re-arms itself. A failure gives the
 * owner's claims back before it propagates. Background merges of resumed
 * `auto` dependents finish before returning.
 */
export async function continueDependencySettlement(
  env: Env,
  msg: SettleMessage,
  deps: DependencyDeps = defaultDependencyDeps,
  owner: 'queue' | 'alarm' = 'queue',
): Promise<SettleContinuationResult> {
  const token = `${owner}:${crypto.randomUUID()}`;
  const [repoRead, pageRead, claimRead, restRead] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(msg.repoId),
    settleEdgesStatement(env.DB, msg),
    ...wakeClaimStatements(env.DB, msg, token, Date.now()),
  ]);
  const repo = (repoRead?.results as RepoRow[] | undefined)?.[0];
  if (!repo) return emptySettleResult();
  const first = { edges: (pageRead?.results as LandedRow[] | undefined) ?? [], wake: wakeSetOf(claimRead, restRead) };
  const pending: Promise<unknown>[] = [];
  const waitUntil = (p: Promise<unknown>) => void pending.push(p);
  let result: SettleContinuationResult;
  try {
    result = await withLazyRepo(env, repo.artifacts_name, (artifacts) =>
      settleContinuation(env.DB, artifactsMergeSources(resolveCtx({ env, repo, waitUntil }, artifacts)), msg, first, token, {
        kick: (ref, reason) => deps.kick(env, repo.id, ref, reason),
        resume: (numbers) => deps.resume(env, repo.id, numbers, waitUntil),
        ...(owner === 'queue' ? { continueLater: (next: SettleMessage) => handOffSettlement(env, next) } : {}),
      }),
    );
  } catch (err) {
    await releaseWakeClaims(env.DB, msg, token);
    throw err;
  } finally {
    await Promise.allSettled(pending);
  }
  if (owner === 'queue' && result.failed) {
    throw new Error(`dependency wake effects of ${msg.mergeCommit} failed after settlement (kicked ${result.kicked}, resumed ${result.resumed}); retrying`);
  }
  if (owner === 'queue' && result.held > 0 && !result.continued) {
    throw new Error(`${result.held} wake marks of ${msg.mergeCommit} are held by another owner until ${result.heldUntil}; retrying`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The dependent: just what the ownership and liveness checks need, with its direct pins counted. */
interface DependentRow {
  id: string;
  status: string;
  agent_id: string | null;
  ref: string | null;
  direct: number;
  /** The id of its existing pin on the named source, if any. */
  dup: string | null;
}

/** The source: its liveness and recorded head. */
interface SourceRow {
  id: string;
  status: string;
  ref: string | null;
  head_sha: string | null;
  base_sha: string | null;
  ref_sha: string | null;
}

/** One path of a chain walk: the next three workspaces (null past the end). */
interface PathRow {
  a1: string;
  a2: string | null;
  a3: string | null;
}

function dependentRow(db: D1Database, repoId: string, id: string, source: string | null): D1PreparedStatement {
  return db
    .prepare(
      `SELECT w.id, w.status, w.agent_id, w.ref,
              (SELECT COUNT(*) FROM workspace_dependencies d WHERE d.repo_id = ?1 AND d.workspace_id = ?2) AS direct,
              (SELECT d.id FROM workspace_dependencies d WHERE d.repo_id = ?1 AND d.workspace_id = ?2 AND d.on_workspace = ?3) AS dup
         FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2`,
    )
    .bind(repoId, id, source);
}

function sourceRow(db: D1Database, repoId: string, idSql: string, ...params: unknown[]): D1PreparedStatement {
  return db
    .prepare(
      `SELECT s.id, s.status, s.ref, s.head_sha, s.base_sha, f.sha AS ref_sha
         FROM workspaces s LEFT JOIN repo_refs f ON f.repo_id = s.repo_id AND f.ref = s.ref
        WHERE s.repo_id = ?1 AND s.id = ${idSql}`,
    )
    .bind(repoId, ...params);
}

/**
 * The chains below a source: every path of up to three pins from it (the
 * cap allows no longer chain), over the covering edge index.
 */
function downWalk(db: D1Database, repoId: string, start: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT y1.on_workspace AS a1, y2.on_workspace AS a2, y3.on_workspace AS a3
         FROM workspace_dependencies y1
         LEFT JOIN workspace_dependencies y2 ON y2.repo_id = y1.repo_id AND y2.workspace_id = y1.on_workspace
         LEFT JOIN workspace_dependencies y3 ON y3.repo_id = y1.repo_id AND y3.workspace_id = y2.on_workspace
        WHERE y1.repo_id = ?1 AND y1.workspace_id = ?2
        LIMIT ${DEPENDENCY_LIMITS.walkMax + 1}`,
    )
    .bind(repoId, start);
}

/** The chains above a dependent: every path of up to three pins leading to it (covering source index). */
function upWalk(db: D1Database, repoId: string, start: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT y1.workspace_id AS a1, y2.workspace_id AS a2, y3.workspace_id AS a3
         FROM workspace_dependencies y1
         LEFT JOIN workspace_dependencies y2 ON y2.repo_id = y1.repo_id AND y2.on_workspace = y1.workspace_id
         LEFT JOIN workspace_dependencies y3 ON y3.repo_id = y1.repo_id AND y3.on_workspace = y2.workspace_id
        WHERE y1.repo_id = ?1 AND y1.on_workspace = ?2
        LIMIT ${DEPENDENCY_LIMITS.walkMax + 1}`,
    )
    .bind(repoId, start);
}

/** SQL condition: no pin path of up to three hops leads from workspace ?4 back to workspace ?3 (re-checked with the write). */
const NO_PATH_BACK = `NOT EXISTS (
  SELECT 1 FROM workspace_dependencies y1
    LEFT JOIN workspace_dependencies y2 ON y2.repo_id = y1.repo_id AND y2.workspace_id = y1.on_workspace
    LEFT JOIN workspace_dependencies y3 ON y3.repo_id = y1.repo_id AND y3.workspace_id = y2.on_workspace
   WHERE y1.repo_id = ?1 AND y1.workspace_id = ?4 AND ?3 IN (y1.on_workspace, y2.on_workspace, y3.on_workspace))`;

// The hop conditions use CROSS JOIN because SQLite then keeps the written
// join order, starting from the bound workspace instead of scanning the repo's edges.

/** SQL condition: a chain of `hops` pins leads up to workspace `ws` (its dependents' dependents...). */
function upHops(hops: number, ws: string): string {
  const joins = Array.from({ length: hops - 1 }, (_, i) => `CROSS JOIN workspace_dependencies u${i + 2} ON u${i + 2}.repo_id = u${i + 1}.repo_id AND u${i + 2}.on_workspace = u${i + 1}.workspace_id`);
  return `EXISTS (SELECT 1 FROM workspace_dependencies u1 ${joins.join(' ')} WHERE u1.repo_id = ?1 AND u1.on_workspace = ${ws})`;
}

/** SQL condition: a chain of `hops` pins leads down from workspace `ws` (its sources' sources...). */
function downHops(hops: number, ws: string): string {
  const joins = Array.from({ length: hops - 1 }, (_, i) => `CROSS JOIN workspace_dependencies v${i + 2} ON v${i + 2}.repo_id = v${i + 1}.repo_id AND v${i + 2}.workspace_id = v${i + 1}.on_workspace`);
  return `EXISTS (SELECT 1 FROM workspace_dependencies v1 ${joins.join(' ')} WHERE v1.repo_id = ?1 AND v1.workspace_id = ${ws})`;
}

/**
 * SQL condition, checked atomically with the write of an edge dependent ?3
 * → source ?4: the chain through the edge stays within maxDepth workspaces
 * (hops above the dependent plus hops below the source at most maxDepth - 2).
 * Graphs written by concurrent requests are judged as they are at the write.
 */
const WITHIN_DEPTH = (() => {
  const room = DEPENDENCY_LIMITS.maxDepth - 2;
  const terms: string[] = [];
  for (let up = 0; up <= room + 1; up++) {
    const down = room + 1 - up;
    const parts = [...(up > 0 ? [upHops(up, '?3')] : []), ...(down > 0 ? [downHops(down, '?4')] : [])];
    terms.push(`(${parts.join(' AND ')})`);
  }
  return `NOT (${terms.join(' OR ')})`;
})();

/** SQL condition: dependent ?3 has fewer than maxDirect pins (for a new edge, at the write). */
const WITHIN_DIRECT = `(SELECT COUNT(*) FROM workspace_dependencies x WHERE x.repo_id = ?1 AND x.workspace_id = ?3) < ${DEPENDENCY_LIMITS.maxDirect}`;

/**
 * What to wake when the dependent's pins change: the queue partition of its
 * change while it is queued, or the change's number while it is an open
 * `auto` change outside the queue.
 */
function queuedPartition(db: D1Database, repoId: string, workspaceId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT q.target_ref, NULL AS number FROM workspaces w JOIN merge_queue q ON q.change_set_id = w.change_set_id AND q.active = 1
        WHERE w.repo_id = ?1 AND w.id = ?2
       UNION ALL
       SELECT NULL AS target_ref, c.number FROM workspaces w JOIN change_sets c ON c.id = w.change_set_id
        WHERE w.repo_id = ?1 AND w.id = ?2 AND c.state = 'open' AND c.merge_policy = 'auto'
          AND NOT EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1)`,
    )
    .bind(repoId, workspaceId);
}

interface WakeRow {
  target_ref: string | null;
  number: number | null;
}

function ownEdges(db: D1Database, repoId: string, workspaceId: string): D1PreparedStatement {
  return dependencyRowsStatement(db, repoId, { where: 'w.id = ?2' }, workspaceId);
}

function sourceHead(row: SourceRow): string | null {
  if (row.status !== 'active') return row.head_sha;
  const pushed = row.ref_sha && row.ref_sha !== ZERO_SHA ? row.ref_sha : null;
  return pushed ?? row.head_sha ?? row.base_sha;
}

const results = <T>(r: D1Result | undefined): T[] => (r?.results as T[] | undefined) ?? [];

/**
 * A walk that returned more paths than its budget is incomplete: the depth
 * and cycle checks would judge a prefix of the graph, so the pin is refused
 * (the write guard would refuse an actually too deep edge anyway, but only
 * with a generic conflict).
 */
function walkOverflow(rows: PathRow[], around: string, dependent: string, source: string): Fail | null {
  if (rows.length <= DEPENDENCY_LIMITS.walkMax) return null;
  return fail(
    422,
    `the dependency chains around workspace ${around} have more than ${DEPENDENCY_LIMITS.walkMax} paths, too many to validate the edge ${dependent} -> ${source}; detach dependencies of the workspaces around ${around}, or pin another source`,
    'DEPENDENCY_GRAPH_TOO_WIDE',
    { walkMax: DEPENDENCY_LIMITS.walkMax, workspaceId: around, edge: { workspaceId: dependent, onWorkspace: source } },
  );
}

const graphChanged = (what: string) =>
  fail(
    409,
    `${what}, or the dependency graph changed meanwhile so that the edge would exceed the depth or direct-dependency limits or close a cycle; retry to see the exact reason`,
    'DEPENDENCY_CONFLICT',
  );

/** Walk rows as workspace paths starting at `start`; a lone `[start]` when it has no pins. */
function paths(start: string, rows: PathRow[]): string[][] {
  if (rows.length === 0) return [[start]];
  return rows.map((r) => [start, r.a1, ...(r.a2 ? [r.a2] : []), ...(r.a3 ? [r.a3] : [])]);
}

// ---------------------------------------------------------------------------
// Validation shared by create and repin
// ---------------------------------------------------------------------------

interface Input {
  onWorkspace: string | null;
  revision: string;
}

function parseInput(body: unknown, sourceRequired: boolean): ServiceResult<Input> {
  const shape = sourceRequired ? '{onWorkspace, revision}' : '{revision, onWorkspace?}';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail(400, `body must be a JSON object ${shape}`, 'INVALID_BODY');
  const b = body as Record<string, unknown>;
  let onWorkspace: string | null = null;
  if (b.onWorkspace !== undefined && b.onWorkspace !== null) {
    if (typeof b.onWorkspace !== 'string' || !WORKSPACE_ID_RE.test(b.onWorkspace)) return fail(422, 'onWorkspace must be a workspace id', 'INVALID_WORKSPACE');
    onWorkspace = b.onWorkspace;
  } else if (sourceRequired) {
    return fail(422, 'onWorkspace is required: the id of the workspace this one builds on, in the same repository', 'INVALID_WORKSPACE');
  }
  if (typeof b.revision !== 'string' || !SHA_RE.test(b.revision)) {
    return fail(422, "revision is required: the source workspace's current head as a full 40-character commit SHA", 'INVALID_REVISION');
  }
  return { ok: true, value: { onWorkspace, revision: b.revision } };
}

interface Checked {
  /** Workspaces in the longest chain from the dependent down through the new edge. */
  edgeDepth: number;
}

function selfPin(id: string): Fail {
  return fail(422, `a workspace cannot depend on itself: ${id} -> ${id}`, 'DEPENDENCY_CYCLE', { path: [id, id] });
}

/**
 * Cycle and depth checks for a pin dependent → source: `down` are the
 * paths from the source, `up` the paths from the dependent upward.
 */
function chainRefusal(dependent: string, source: string, down: string[][], up: string[][]): Fail | Checked {
  if (dependent === source) return selfPin(dependent);
  const back = down
    .map((p) => p.indexOf(dependent))
    .map((i, n) => (i > 0 ? down[n]!.slice(0, i + 1) : null))
    .filter((p): p is string[] => p !== null)
    .sort((a, b) => a.length - b.length)[0];
  if (back) {
    const path = [dependent, ...back];
    return fail(422, `this dependency would create a cycle: ${path.join(' -> ')}; detach an edge of the cycle first`, 'DEPENDENCY_CYCLE', { path });
  }
  const longest = (ps: string[][]) => ps.reduce((a, b) => (b.length > a.length ? b : a));
  const below = longest(down);
  const above = longest(up);
  const depth = below.length + above.length;
  if (depth > DEPENDENCY_LIMITS.maxDepth) {
    const path = [...[...above].reverse(), ...below];
    return fail(
      422,
      `dependency chains are limited to ${DEPENDENCY_LIMITS.maxDepth} workspaces; the edge ${dependent} -> ${source} would make the chain ${path.join(' -> ')} ${depth} long; detach an edge of the chain or pin a shallower source`,
      'DEPENDENCY_DEPTH_EXCEEDED',
      { maxDepth: DEPENDENCY_LIMITS.maxDepth, depth, edge: { workspaceId: dependent, onWorkspace: source }, path },
    );
  }
  return { edgeDepth: below.length + 1 };
}

/**
 * The revision must be the source's current head, read live: the recorded
 * position may trail a push either way, and the pin's own time later stands
 * in for its position until a newer push event arrives (see sourceHeadSql).
 * The recorded position is the fallback only when the ref store is down.
 */
async function revisionRefusal(cx: WorkspaceContext, source: SourceRow, revision: string): Promise<Fail | null> {
  let current: string | null;
  try {
    current = source.ref ? ((await liveRefs(cx, [source.ref])).get(source.ref) ?? null) : null;
  } catch (err) {
    if (!(err instanceof RefStoreUnavailable)) throw err;
    current = sourceHead(source);
  }
  if (current === revision) return null;
  return fail(
    422,
    `${revision} is not the current revision of workspace ${source.id}${current ? `; its current revision is ${current}` : ''}: pin the exact head you build on`,
    'REVISION_NOT_CURRENT',
    { currentRevision: current },
  );
}

function sourceRefusal(id: string, source: SourceRow | undefined): Fail | null {
  if (!source) {
    return fail(404, `no workspace ${id} in this repository: a dependency must name a workspace in the same repository`, 'SOURCE_NOT_FOUND');
  }
  if (source.status !== 'active') {
    return fail(409, `workspace ${id} is ${source.status}; pin a live workspace`, 'SOURCE_NOT_ACTIVE', { sourceStatus: source.status });
  }
  return null;
}

function dependentRefusal(cx: WorkspaceContext, row: DependentRow | undefined, write: 'pin' | 'detach'): Fail | null {
  if (!row) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const denied = agentOwnershipDenial(cx.actor, row);
  if (denied) return fail(403, denied, 'WORKSPACE_NOT_OWNED');
  if (write === 'pin' && row.status !== 'active') return fail(409, `the workspace is ${row.status}`, 'WORKSPACE_NOT_ACTIVE', { workspaceStatus: row.status });
  return null;
}

function isUnique(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(err));
}

async function kickPartition(cx: WorkspaceContext, deps: DependencyDeps, rows: WakeRow[]): Promise<void> {
  for (const r of rows) {
    if (r.target_ref) {
      await deps.kick(cx.env, cx.repo.id, r.target_ref, 'dependency-changed').catch((err: unknown) => {
        console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
      });
    }
  }
  const autos = rows.filter((r) => r.number !== null).map((r) => r.number!);
  if (autos.length > 0) {
    await deps.resume(cx.env, cx.repo.id, autos, (p) => cx.waitUntil(p)).catch((err: unknown) => {
      console.warn(JSON.stringify({ dependencyResumeFailed: String(err).slice(0, 200) }));
    });
  }
}

const exists = (dependent: string, source: string) =>
  fail(409, `workspace ${dependent} already depends on workspace ${source}; repin that edge instead`, 'DEPENDENCY_EXISTS');

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function newEdgeView(
  e: { id: string; workspaceId: string; onWorkspace: string; revision: string; depth: number; createdBy: string | null; createdAt: number; updatedAt: number; repinnedAt: number | null },
): DependencyView {
  return dependencyView({
    id: e.id,
    workspace_id: e.workspaceId,
    on_workspace: e.onWorkspace,
    revision: e.revision,
    created_login: e.createdBy,
    agent_id: null,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    repinned_at: e.repinnedAt,
    satisfied_commit: null,
    satisfied_at: null,
    broken_code: null,
    broken_reason: null,
    ws_change_set_id: null,
    s_status: 'active',
    s_head: e.revision,
    depth: e.depth,
  });
}

/**
 * POST workspaces/:id/dependencies {onWorkspace, revision} → 201 the edge.
 * One batch of validation reads (dependent, source, the chains below the
 * source and above the dependent), then one guarded insert.
 */
export async function createDependency(cx: WorkspaceContext, workspaceId: string, body: unknown): Promise<ServiceResult<DependencyView>> {
  const parsed = parseInput(body, true);
  if (!parsed.ok) return parsed;
  const { revision } = parsed.value;
  const source = parsed.value.onWorkspace!;
  if (!WORKSPACE_ID_RE.test(workspaceId)) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const db = cx.env.DB;
  const [depRes, srcRes, downRes, upRes] = await db.batch([
    dependentRow(db, cx.repo.id, workspaceId, source),
    sourceRow(db, cx.repo.id, '?2', source),
    downWalk(db, cx.repo.id, source),
    upWalk(db, cx.repo.id, workspaceId),
  ]);
  const dependent = results<DependentRow>(depRes)[0];
  const refused = dependentRefusal(cx, dependent, 'pin');
  if (refused) return refused;
  if (workspaceId === source) return selfPin(workspaceId);
  const src = results<SourceRow>(srcRes)[0];
  const bad = sourceRefusal(source, src);
  if (bad) return bad;
  if (dependent!.dup) return exists(workspaceId, source);
  if (dependent!.direct >= DEPENDENCY_LIMITS.maxDirect) {
    return fail(422, `a workspace may pin at most ${DEPENDENCY_LIMITS.maxDirect} direct dependencies; detach one first`, 'DEPENDENCY_LIMIT', {
      maxDirect: DEPENDENCY_LIMITS.maxDirect,
    });
  }
  const downRows = results<PathRow>(downRes);
  const upRows = results<PathRow>(upRes);
  const wide = walkOverflow(downRows, source, workspaceId, source) ?? walkOverflow(upRows, workspaceId, workspaceId, source);
  if (wide) return wide;
  const chain = chainRefusal(workspaceId, source, paths(source, downRows), paths(workspaceId, upRows));
  if ('ok' in chain) return chain;
  const stale = await revisionRefusal(cx, src!, revision);
  if (stale) return stale;

  const id = newId();
  const now = Date.now();
  let written: D1Result;
  try {
    // Re-checked atomically with the write: both workspaces still active, no path back from the source, and the depth and direct limits.
    written = await db
      .prepare(
        `INSERT INTO workspace_dependencies (repo_id, id, workspace_id, on_workspace, revision, created_by, created_login, agent_id, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
          WHERE EXISTS (SELECT 1 FROM workspaces WHERE repo_id = ?1 AND id = ?3 AND status = 'active')
            AND EXISTS (SELECT 1 FROM workspaces WHERE repo_id = ?1 AND id = ?4 AND status = 'active')
            AND ${WITHIN_DIRECT}
            AND ${NO_PATH_BACK}
            AND ${WITHIN_DEPTH}
         RETURNING id`,
      )
      .bind(cx.repo.id, id, workspaceId, source, revision, cx.actor?.user.id ?? null, cx.actor?.user.login ?? null, cx.actor?.agent?.agentId ?? null, now)
      .all();
  } catch (err) {
    if (isUnique(err)) return exists(workspaceId, source);
    throw err;
  }
  if (!written.results?.length) return graphChanged('a workspace left active');
  return {
    ok: true,
    value: newEdgeView({
      id,
      workspaceId,
      onWorkspace: source,
      revision,
      depth: chain.edgeDepth,
      createdBy: cx.actor?.user.login ?? null,
      createdAt: now,
      updatedAt: now,
      repinnedAt: null,
    }),
  };
}

/** GET workspaces/:id/dependencies → {dependencies}. One batch of two indexed reads. */
export async function listDependencies(env: Env, repoId: string, workspaceId: string): Promise<ServiceResult<{ dependencies: DependencyView[] }>> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const db = env.DB;
  const [ws, edges] = await db.batch([
    db.prepare('SELECT id FROM workspaces WHERE repo_id = ?1 AND id = ?2').bind(repoId, workspaceId),
    ownEdges(db, repoId, workspaceId),
  ]);
  if (!ws?.results?.length) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  return { ok: true, value: { dependencies: results<DependencyRow>(edges).map(dependencyView) } };
}

/** What a repin replaced, so callers can report the transition. */
export interface RepinView extends DependencyView {
  previous: { onWorkspace: string; revision: string; state: DependencyView['state']; reason: DependencyView['reason'] };
}

/**
 * POST workspaces/:id/dependencies/:dep/repin {revision, onWorkspace?}: the
 * explicit recovery of a stale or broken pin, to the current revision of
 * the same or another live source in this repository. A refused repin
 * leaves the previous pin in force.
 */
export async function repinDependency(
  cx: WorkspaceContext,
  workspaceId: string,
  depId: string,
  body: unknown,
  deps: DependencyDeps = defaultDependencyDeps,
): Promise<ServiceResult<RepinView>> {
  const parsed = parseInput(body, false);
  if (!parsed.ok) return parsed;
  if (!WORKSPACE_ID_RE.test(workspaceId)) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const notFound = () => fail(404, `workspace ${workspaceId} has no dependency ${depId}`, 'DEPENDENCY_NOT_FOUND');
  if (!DEP_ID_RE.test(depId)) return notFound();
  const db = cx.env.DB;
  const named = parsed.value.onWorkspace;
  const edgeSource = `(SELECT on_workspace FROM workspace_dependencies WHERE repo_id = ?1 AND id = ?3)`;
  // The source is the edge's own unless the body names another; one batch either way.
  const [depRes, edgeRes, srcRes, downRes, upRes, queuedRes] = await db.batch([
    dependentRow(db, cx.repo.id, workspaceId, named),
    dependencyRowsStatement(db, cx.repo.id, { where: 'w.id = ?2 AND d.id = ?3' }, workspaceId, depId),
    sourceRow(db, cx.repo.id, `COALESCE(?2, ${edgeSource})`, named, depId),
    named
      ? downWalk(db, cx.repo.id, named)
      : db
          .prepare(
            `SELECT y1.on_workspace AS a1, y2.on_workspace AS a2, NULL AS a3
               FROM workspace_dependencies y1
               LEFT JOIN workspace_dependencies y2 ON y2.repo_id = y1.repo_id AND y2.workspace_id = y1.on_workspace
              WHERE y1.repo_id = ?1 AND y1.workspace_id = ${edgeSource.replace('?3', '?2')}
              LIMIT ${DEPENDENCY_LIMITS.walkMax + 1}`,
          )
          .bind(cx.repo.id, depId),
    named ? upWalk(db, cx.repo.id, workspaceId) : db.prepare('SELECT NULL AS a1 WHERE 0'),
    queuedPartition(db, cx.repo.id, workspaceId),
  ]);
  const dependent = results<DependentRow>(depRes)[0];
  const refused = dependentRefusal(cx, dependent, 'pin');
  if (refused) return refused;
  const edge = results<DependencyRow>(edgeRes)[0];
  if (!edge) return notFound();
  const before = dependencyView(edge);
  const source = named ?? edge.on_workspace;
  const src = results<SourceRow>(srcRes)[0];
  const bad = sourceRefusal(source, src);
  if (bad) return bad;
  const downRows = results<PathRow>(downRes);
  const tooWide = walkOverflow(downRows, source, workspaceId, source);
  if (tooWide) return tooWide;
  const down = paths(source, downRows);
  let edgeDepth = Math.max(...down.map((p) => p.length)) + 1;
  if (source !== edge.on_workspace) {
    if (workspaceId === source) return selfPin(workspaceId);
    if (dependent!.dup) return exists(workspaceId, source);
    const upRows = results<PathRow>(upRes);
    const wide = walkOverflow(upRows, workspaceId, workspaceId, source);
    if (wide) return wide;
    const chain = chainRefusal(workspaceId, source, down, paths(workspaceId, upRows));
    if ('ok' in chain) return chain;
    edgeDepth = chain.edgeDepth;
  }
  const stale = await revisionRefusal(cx, src!, parsed.value.revision);
  if (stale) return stale;

  const now = Date.now();
  let written: D1Result;
  try {
    written = await db
      .prepare(
        `UPDATE workspace_dependencies
            SET on_workspace = ?4, revision = ?5, satisfied_commit = NULL, satisfied_at = NULL, broken_code = NULL, broken_reason = NULL,
                repinned_at = ?6, updated_at = ?6
          WHERE repo_id = ?1 AND id = ?2 AND workspace_id = ?3
            AND EXISTS (SELECT 1 FROM workspaces WHERE repo_id = ?1 AND id = ?4 AND status = 'active')
            AND ${NO_PATH_BACK}
            AND ${WITHIN_DEPTH}
         RETURNING id`,
      )
      .bind(cx.repo.id, depId, workspaceId, source, parsed.value.revision, now)
      .all();
  } catch (err) {
    if (isUnique(err)) return exists(workspaceId, source);
    throw err;
  }
  if (!written.results?.length) return graphChanged('the source left active');
  await kickPartition(cx, deps, results<WakeRow>(queuedRes));
  return {
    ok: true,
    value: {
      ...newEdgeView({
        id: depId,
        workspaceId,
        onWorkspace: source,
        revision: parsed.value.revision,
        depth: Math.min(edgeDepth, DEPENDENCY_LIMITS.maxDepth),
        createdBy: edge.created_login,
        createdAt: edge.created_at,
        updatedAt: now,
        repinnedAt: now,
      }),
      previous: { onWorkspace: before.onWorkspace, revision: before.revision, state: before.state, reason: before.reason },
    },
  };
}

/** DELETE workspaces/:id/dependencies/:dep → {detached: true, dependency}. The dependent's ref, base and change are untouched. */
export async function detachDependency(
  cx: WorkspaceContext,
  workspaceId: string,
  depId: string,
  deps: DependencyDeps = defaultDependencyDeps,
): Promise<ServiceResult<{ detached: true; dependency: DependencyView }>> {
  if (!WORKSPACE_ID_RE.test(workspaceId)) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
  const notFound = () => fail(404, `workspace ${workspaceId} has no dependency ${depId}`, 'DEPENDENCY_NOT_FOUND');
  if (!DEP_ID_RE.test(depId)) return notFound();
  const db = cx.env.DB;
  const [depRes, edgesRes, queuedRes] = await db.batch([
    dependentRow(db, cx.repo.id, workspaceId, null),
    dependencyRowsStatement(db, cx.repo.id, { where: 'w.id = ?2 AND d.id = ?3' }, workspaceId, depId),
    queuedPartition(db, cx.repo.id, workspaceId),
  ]);
  const refused = dependentRefusal(cx, results<DependentRow>(depRes)[0], 'detach');
  if (refused) return refused;
  const row = results<DependencyRow>(edgesRes)[0];
  if (!row) return notFound();
  const removed = await db
    .prepare('DELETE FROM workspace_dependencies WHERE repo_id = ?1 AND id = ?2 AND workspace_id = ?3 RETURNING id')
    .bind(cx.repo.id, depId, workspaceId)
    .all();
  if (!removed.results?.length) return notFound();
  await kickPartition(cx, deps, results<WakeRow>(queuedRes));
  return { ok: true, value: { detached: true, dependency: dependencyView(row) } };
}
