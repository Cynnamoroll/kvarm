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

import type { ServiceResult } from '../repos/service';
import { DEPENDENCY_LIMITS, dependencyRowsStatement, dependencyView, type DependencyRow, type DependencyView } from './dependencyGate';
import { RefStoreUnavailable } from './refs';
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
}

export const defaultDependencyDeps: DependencyDeps = { kick: (env, repoId, ref, reason) => kickTrain(env, repoId, ref, reason) };

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
        LIMIT ${DEPENDENCY_LIMITS.walkMax}`,
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
        LIMIT ${DEPENDENCY_LIMITS.walkMax}`,
    )
    .bind(repoId, start);
}

/** SQL condition: no pin path of up to three hops leads from workspace ?4 back to workspace ?3 (re-checked with the write). */
const NO_PATH_BACK = `NOT EXISTS (
  SELECT 1 FROM workspace_dependencies y1
    LEFT JOIN workspace_dependencies y2 ON y2.repo_id = y1.repo_id AND y2.workspace_id = y1.on_workspace
    LEFT JOIN workspace_dependencies y3 ON y3.repo_id = y1.repo_id AND y3.workspace_id = y2.on_workspace
   WHERE y1.repo_id = ?1 AND y1.workspace_id = ?4 AND ?3 IN (y1.on_workspace, y2.on_workspace, y3.on_workspace))`;

/** The queue partition of the dependent's change while it is queued (to kick when its pins change). */
function queuedPartition(db: D1Database, repoId: string, workspaceId: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT q.target_ref FROM workspaces w JOIN merge_queue q ON q.change_set_id = w.change_set_id AND q.active = 1
        WHERE w.repo_id = ?1 AND w.id = ?2`,
    )
    .bind(repoId, workspaceId);
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

async function kickPartition(cx: WorkspaceContext, deps: DependencyDeps, rows: Array<{ target_ref: string }>): Promise<void> {
  for (const r of rows) {
    await deps.kick(cx.env, cx.repo.id, r.target_ref, 'dependency-changed').catch((err: unknown) => {
      console.warn(JSON.stringify({ trainKickFailed: String(err).slice(0, 200) }));
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
  const chain = chainRefusal(workspaceId, source, paths(source, results<PathRow>(downRes)), paths(workspaceId, results<PathRow>(upRes)));
  if ('ok' in chain) return chain;
  const stale = await revisionRefusal(cx, src!, revision);
  if (stale) return stale;

  const id = newId();
  const now = Date.now();
  let written: D1Result;
  try {
    // Re-checked atomically with the write: both workspaces still active and no path back from the source.
    written = await db
      .prepare(
        `INSERT INTO workspace_dependencies (repo_id, id, workspace_id, on_workspace, revision, created_by, created_login, agent_id, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9
          WHERE EXISTS (SELECT 1 FROM workspaces WHERE repo_id = ?1 AND id = ?3 AND status = 'active')
            AND EXISTS (SELECT 1 FROM workspaces WHERE repo_id = ?1 AND id = ?4 AND status = 'active')
            AND ${NO_PATH_BACK}
         RETURNING id`,
      )
      .bind(cx.repo.id, id, workspaceId, source, revision, cx.actor?.user.id ?? null, cx.actor?.user.login ?? null, cx.actor?.agent?.agentId ?? null, now)
      .all();
  } catch (err) {
    if (isUnique(err)) return exists(workspaceId, source);
    throw err;
  }
  if (!written.results?.length) {
    return fail(409, 'a workspace left active or the dependency graph changed meanwhile; retry', 'DEPENDENCY_CONFLICT');
  }
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
              LIMIT ${DEPENDENCY_LIMITS.walkMax}`,
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
  const down = paths(source, results<PathRow>(downRes));
  let edgeDepth = Math.max(...down.map((p) => p.length)) + 1;
  if (source !== edge.on_workspace) {
    if (workspaceId === source) return selfPin(workspaceId);
    if (dependent!.dup) return exists(workspaceId, source);
    const chain = chainRefusal(workspaceId, source, down, paths(workspaceId, results<PathRow>(upRes)));
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
         RETURNING id`,
      )
      .bind(cx.repo.id, depId, workspaceId, source, parsed.value.revision, now)
      .all();
  } catch (err) {
    if (isUnique(err)) return exists(workspaceId, source);
    throw err;
  }
  if (!written.results?.length) {
    return fail(409, 'the source left active or the dependency graph changed meanwhile; retry', 'DEPENDENCY_CONFLICT');
  }
  await kickPartition(cx, deps, results<{ target_ref: string }>(queuedRes));
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
  await kickPartition(cx, deps, results<{ target_ref: string }>(queuedRes));
  return { ok: true, value: { detached: true, dependency: dependencyView(row) } };
}
