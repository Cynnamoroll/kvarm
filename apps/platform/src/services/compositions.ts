/**
 * Composition of candidate attempts (architecture §0.4, §11.4).
 *
 * `POST candidates/compose` folds the selected pieces of 2-8 active
 * workspaces onto the head of a base branch with gitops `composeTrees`
 * (merge3, each piece against its own merge base with the base head). A
 * clean composition becomes a composed candidate: one commit on the base
 * head, its own workspace ref (GitPusher) and a change set opened from it
 * under the requested policy, so it is reviewed and merged like any other
 * candidate. Any textual conflict, unmatched selection or budget stop
 * creates nothing.
 *
 * Required checks come from the checks-gate for the exact composed tree. A
 * clean composition whose required checks fail is a semantic conflict: it is
 * recorded and reported as `{kind: "semantic"}`, never as a textual
 * conflict, and the change's merge is refused by the same gate.
 */

import { buildCommit, composeTrees, mergeBase, type ComposePiece, type GitIdent } from '@forge/gitops';
import { withLazyRepo } from '../artifacts/repo';
import { touchRepoPushedStatement } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { credentialMayUpdateRef } from './authz';
import { CHANGE_LIMITS, MERGE_POLICIES, mergeAuthor, normalizeBranch } from './changes';
import { defaultChecksGate, type ChecksGate, type RequiredChecks } from './checksGate';
import { reconcileObserved } from './intents/forecast';
import { observedSeedFailedStatement } from './intents/store';
import { normalizePath } from './intents/paths';
import { FORGE_COMMITTER, MERGE_BUDGETS, artifactsMergeSources } from './merge';
import { RefStoreUnavailable, lsRefs, readCommitInfo, type ResolveContext } from './refs';
import {
  WORKSPACE_ID_RE,
  WORKSPACE_SELECT,
  defaultWorkspaceDeps,
  liveRefs,
  newId,
  openChangeSet,
  workspaceInsertStatement,
  workspaceRef,
  workspaceRowsStatement,
  workspaceView,
  type WorkspaceContext,
  type WorkspaceDeps,
  type WorkspaceRow,
  type WorkspaceView,
} from './workspaces';

export const COMPOSE_LIMITS = {
  minPieces: 2,
  maxPieces: 8,
  /** Selected paths per piece. */
  pathsMax: 64,
  pageDefault: 20,
  pageMax: 100,
} as const;

const ZERO_SHA = '0000000000000000000000000000000000000000';

type Fail = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
const iso = (ms: number) => new Date(ms).toISOString();

export interface ComposeContext extends WorkspaceContext {
  gate?: ChecksGate;
}

export interface ComposeDeps extends WorkspaceDeps {
  gate(env: Env): ChecksGate;
}

export const defaultComposeDeps: ComposeDeps = { ...defaultWorkspaceDeps, gate: defaultChecksGate };

export interface CompositionSource {
  workspace: string;
  headSha: string;
  mergeBase: string;
  /** Selected paths (a trailing `/` is a prefix); null: the whole workspace. */
  paths: string[] | null;
}

export interface SemanticConflict {
  kind: 'semantic';
  /** Required checks that failed on the composed tree. */
  checks: string[];
  treeSha: string;
}

export interface CompositionView {
  id: string;
  base: string;
  baseSha: string;
  treeSha: string;
  commitSha: string;
  sources: CompositionSource[];
  workspace: WorkspaceView | null;
  changeSet: number | null;
  /** The checks-gate answer for the exact composed tree when it was composed. */
  checks: RequiredChecks;
  /** null when clean; a semantic conflict when the tree merged cleanly but a required check failed. */
  conflict: SemanticConflict | null;
  createdBy: string | null;
  createdAt: string;
  /** Present when the composed workspace exists but its change set could not be opened. */
  changeSetError?: { status: number; error: string; code?: string };
}

interface CompositionRow {
  id: string;
  base_ref: string;
  base_sha: string;
  tree_sha: string;
  commit_sha: string;
  sources: string;
  workspace_id: string;
  checks: string;
  conflict_kind: string | null;
  created_by_login: string | null;
  created_at: number;
}

const COMPOSITION_SELECT = `SELECT k.id, k.base_ref, k.base_sha, k.tree_sha, k.commit_sha, k.sources, k.workspace_id, k.checks, k.conflict_kind,
       u.login AS created_by_login, k.created_at
  FROM compositions k LEFT JOIN users u ON u.id = k.created_by`;

function semanticConflict(checks: RequiredChecks): SemanticConflict | null {
  if (checks.state !== 'failure') return null;
  return { kind: 'semantic', checks: checks.required.filter((c) => c.state === 'failure').map((c) => c.name), treeSha: checks.treeSha };
}

function compositionView(row: CompositionRow, ws: WorkspaceRow | null, cx: Pick<WorkspaceContext, 'repo' | 'origin'>): CompositionView {
  const checks = JSON.parse(row.checks) as RequiredChecks;
  return {
    id: row.id,
    base: row.base_ref,
    baseSha: row.base_sha,
    treeSha: row.tree_sha,
    commitSha: row.commit_sha,
    sources: JSON.parse(row.sources) as CompositionSource[],
    workspace: ws ? workspaceView(ws, cx.repo, cx.origin) : null,
    changeSet: ws?.change_number ?? null,
    checks,
    conflict: row.conflict_kind === 'semantic' ? semanticConflict(checks) : null,
    createdBy: row.created_by_login,
    createdAt: iso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

interface Piece {
  workspace: string;
  paths: string[] | null;
}

interface ComposeInput {
  base: string;
  pieces: Piece[];
  title: string | null;
  mergePolicy: string;
  agent: string;
}

function parsePaths(workspace: string, raw: unknown): string[] | Fail {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > COMPOSE_LIMITS.pathsMax) {
    return fail(422, `paths for ${workspace} must be a list of 1-${COMPOSE_LIMITS.pathsMax} paths`, 'INVALID_PATHS', { workspace });
  }
  const out = new Set<string>();
  for (const p of raw) {
    const n = normalizePath(p);
    if (!n.ok) return fail(422, `paths for ${workspace}: ${n.error}`, 'INVALID_PATHS', { workspace });
    out.add(n.value);
  }
  return [...out].sort();
}

function parseCompose(cx: ComposeContext, input: unknown): ComposeInput | Fail {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const b = input as Record<string, unknown>;
  const list = b.workspaces;
  if (!Array.isArray(list) || list.length < COMPOSE_LIMITS.minPieces || list.length > COMPOSE_LIMITS.maxPieces) {
    return fail(422, `workspaces must list ${COMPOSE_LIMITS.minPieces}-${COMPOSE_LIMITS.maxPieces} workspaces`, 'INVALID_COMPOSITION', {
      min: COMPOSE_LIMITS.minPieces,
      max: COMPOSE_LIMITS.maxPieces,
    });
  }
  const pathMap = b.paths;
  if (pathMap !== undefined && (typeof pathMap !== 'object' || pathMap === null || Array.isArray(pathMap))) {
    return fail(422, 'paths must be an object mapping workspace ids to path lists', 'INVALID_PATHS');
  }
  const pieces: Piece[] = [];
  for (const item of list) {
    const obj = typeof item === 'object' && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : null;
    const id = typeof item === 'string' ? item : obj?.workspace;
    if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id)) {
      return fail(422, 'each workspaces entry must be a workspace id or {workspace, paths?}', 'INVALID_COMPOSITION');
    }
    const rawPaths = obj?.paths ?? (pathMap as Record<string, unknown> | undefined)?.[id];
    let paths: string[] | null = null;
    if (rawPaths !== undefined && rawPaths !== null) {
      const parsed = parsePaths(id, rawPaths);
      if (isFail(parsed)) return parsed;
      paths = parsed;
    }
    pieces.push({ workspace: id, paths });
  }
  if (new Set(pieces.map((p) => p.workspace)).size !== pieces.length) {
    return fail(422, 'workspaces lists a workspace more than once', 'INVALID_COMPOSITION');
  }
  for (const id of Object.keys((pathMap as Record<string, unknown> | undefined) ?? {})) {
    if (!pieces.some((p) => p.workspace === id)) return fail(422, `paths names ${id.slice(0, 80)}, which is not in workspaces`, 'INVALID_PATHS');
  }
  const base = b.base === undefined || b.base === null ? cx.repo.default_branch : normalizeBranch(b.base);
  if (base === null) return fail(422, 'base must be a branch name', 'INVALID_REF');
  let title: string | null = null;
  if (b.title !== undefined && b.title !== null) {
    if (typeof b.title !== 'string' || b.title.trim().length === 0 || b.title.trim().length > CHANGE_LIMITS.titleMax) {
      return fail(422, `title must be 1-${CHANGE_LIMITS.titleMax} characters`, 'INVALID_TITLE');
    }
    title = b.title.trim();
  }
  const mergePolicy = b.mergePolicy ?? 'review';
  if (typeof mergePolicy !== 'string' || !(MERGE_POLICIES as readonly string[]).includes(mergePolicy)) {
    return fail(422, `mergePolicy must be one of ${MERGE_POLICIES.join(', ')}`, 'INVALID_MERGE_POLICY');
  }
  const agent = typeof b.agent === 'string' && b.agent.trim().length > 0 ? b.agent.trim().slice(0, 100) : (cx.actor?.agent?.agentName ?? cx.actor?.user.login ?? 'unknown');
  return { base, pieces, title, mergePolicy, agent };
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export interface ComposeConflictView {
  /** The workspace whose piece could not be folded onto the composition so far. */
  workspace: string;
  /** Workspaces already folded in when it conflicted (in fold order). */
  with: string[];
  path: string;
  kind: string;
  paths: string[];
  hunks?: number;
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ composeRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/**
 * POST candidates/compose {base?, workspaces: [id | {workspace, paths?}], paths?: {id: [...]}, title?, mergePolicy?}
 * → 201 composition. Refusals create no ref, row or change:
 * 409 COMPOSITION_CONFLICT (textual), 422 SELECTION_UNMATCHED, 422 COMPOSITION_TOO_LARGE, 422 EMPTY_COMPOSITION.
 */
export function compose(cx: ComposeContext, input: unknown, deps: ComposeDeps = defaultComposeDeps): Promise<ServiceResult<CompositionView>> {
  return guarded(async () => {
    const p = parseCompose(cx, input);
    if (isFail(p)) return p;
    const ids = p.pieces.map((x) => x.workspace);
    const db = cx.env.DB;
    const found = new Map(((await workspaceRowsStatement(db, cx.repo.id, ids).all<WorkspaceRow>()).results ?? []).map((r) => [r.id, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) return fail(404, `workspace not found: ${missing.join(', ')}`, 'WORKSPACE_NOT_FOUND', { workspaces: missing });
    for (const id of ids) {
      const row = found.get(id)!;
      if (row.status !== 'active' || !row.ref) {
        return fail(409, `workspace ${id} is ${row.status}`, 'WORKSPACE_NOT_ACTIVE', { workspace: id, workspaceStatus: row.status });
      }
    }
    const id = newId();
    const task = p.title ?? `Composition of ${ids.join(', ')}`;
    const ref = workspaceRef(id, 'composition');
    if (cx.actor?.agent && !credentialMayUpdateRef(cx.actor, ref)) {
      return fail(403, 'this agent token may not create refs/heads/agents/<id>/ refs', 'AGENT_REF_FORBIDDEN');
    }

    const composed = await withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
      const ctx: ResolveContext = { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
      const baseRef = `refs/heads/${p.base}`;
      const refs = ids.map((w) => found.get(w)!.ref!);
      const heads = await lsRefs(ctx, [baseRef, ...refs]);
      const baseSha = heads.get(baseRef) ?? null;
      if (!baseSha) return fail(422, `base branch not found: ${p.base}`, 'REF_NOT_FOUND', { ref: p.base });
      const sources = artifactsMergeSources(ctx);
      const baseCommit = await readCommitInfo(ctx, baseSha);
      if (!baseCommit) return fail(503, 'could not read the base commit', 'COMPOSE_READ_FAILED');

      const pieces: ComposePiece[] = [];
      const recorded: CompositionSource[] = [];
      for (const piece of p.pieces) {
        const headSha = heads.get(found.get(piece.workspace)!.ref!) ?? null;
        if (!headSha) return fail(409, `the ref of workspace ${piece.workspace} is gone`, 'WORKSPACE_REF_MISSING', { workspace: piece.workspace });
        const mb = await mergeBase(sources, baseSha, headSha, { maxCommitReads: MERGE_BUDGETS.maxCommitReads, concurrency: MERGE_BUDGETS.concurrency });
        if (mb.truncated) {
          return mb.truncatedReason === 'maxCommitReads'
            ? fail(422, `history of ${piece.workspace} exceeds the merge-base budget`, 'COMPOSITION_TOO_LARGE', { workspace: piece.workspace })
            : fail(503, `could not read the history of ${piece.workspace}`, 'COMPOSE_READ_FAILED', { workspace: piece.workspace });
        }
        if (mb.bases.length === 0) return fail(409, `workspace ${piece.workspace} shares no history with ${p.base}`, 'UNRELATED_HISTORIES', { workspace: piece.workspace });
        if (mb.bases.length > 1) return fail(422, `workspace ${piece.workspace} has several merge bases with ${p.base}`, 'MULTIPLE_MERGE_BASES', { workspace: piece.workspace });
        const [mbCommit, headCommit] = await Promise.all([readCommitInfo(ctx, mb.bases[0]!), readCommitInfo(ctx, headSha)]);
        if (!mbCommit || !headCommit) return fail(503, `could not read the commits of ${piece.workspace}`, 'COMPOSE_READ_FAILED', { workspace: piece.workspace });
        pieces.push({ name: piece.workspace, baseTree: mbCommit.tree, headTree: headCommit.tree, ...(piece.paths ? { paths: piece.paths } : {}) });
        recorded.push({ workspace: piece.workspace, headSha, mergeBase: mb.bases[0]!, paths: piece.paths });
      }

      const n = pieces.length;
      const result = await composeTrees(sources, baseCommit.tree, pieces, {
        maxTreeReads: MERGE_BUDGETS.maxTreeReads,
        maxChanges: MERGE_BUDGETS.maxChanges,
        maxBlobReads: Math.max(1, Math.floor(MERGE_BUDGETS.maxBlobReads / n)),
        maxBlobBytes: MERGE_BUDGETS.maxBlobBytes,
        nodeBudget: MERGE_BUDGETS.nodeBudget,
        concurrency: MERGE_BUDGETS.concurrency,
        maxMergedBytes: Math.floor(MERGE_BUDGETS.maxMergedBytes / n),
        contentConcurrency: MERGE_BUDGETS.contentConcurrency,
      });
      if (result.unmatched.length > 0) {
        return fail(422, 'some selected paths match no change of their workspace', 'SELECTION_UNMATCHED', {
          unmatched: result.unmatched.map((u) => ({ workspace: u.piece, path: u.path })),
        });
      }
      if (result.truncated) {
        const read = result.truncatedReason === 'readError' || result.truncatedReason === 'missingObject';
        return read
          ? fail(503, `could not read the composition inputs (${result.truncatedReason})`, 'COMPOSE_READ_FAILED', { workspace: result.truncatedPiece })
          : fail(422, `composition exceeds the ${result.truncatedReason} budget`, 'COMPOSITION_TOO_LARGE', { workspace: result.truncatedPiece });
      }
      if (!result.clean || result.treeHash === null) {
        const folded: string[] = [];
        const conflicted = new Set(result.conflicts.map((c) => c.piece));
        const before = new Map<string, string[]>();
        for (const piece of pieces) {
          before.set(piece.name, [...folded]);
          if (!conflicted.has(piece.name)) folded.push(piece.name);
        }
        const conflicts: ComposeConflictView[] = result.conflicts.map((c) => ({
          workspace: c.piece,
          with: before.get(c.piece) ?? [],
          path: c.path,
          kind: c.kind,
          paths: c.paths,
          ...(c.hunks !== undefined ? { hunks: c.hunks } : {}),
        }));
        const incompatible = [...new Set(result.conflicts.flatMap((c) => c.paths))].sort();
        return fail(409, `the selection is incompatible: ${incompatible.length} path(s) conflict`, 'COMPOSITION_CONFLICT', {
          conflictKind: 'textual',
          incompatible,
          conflicts,
        });
      }
      if (result.treeHash === baseCommit.tree) return fail(422, `the selection changes nothing on ${p.base}`, 'EMPTY_COMPOSITION');
      return { ok: true as const, value: { baseSha, baseTree: baseCommit.tree, treeSha: result.treeHash, objects: result.objects, recorded } };
    });
    if (!composed.ok) return composed;
    const { baseSha, baseTree, treeSha, objects, recorded } = composed.value;

    const time = Math.floor(Date.now() / 1000);
    const committer: GitIdent = { ...FORGE_COMMITTER, time };
    const who = mergeAuthor(cx.actor);
    const author: GitIdent = who ? { ...who, time } : committer;
    const lines = recorded.map((s) => `Forge-Composed-From: ${s.workspace} ${s.headSha}${s.paths ? ` ${s.paths.join(' ')}` : ''}`);
    const commit = await buildCommit({ tree: treeSha, parents: [baseSha], author, committer, message: `${task}\n\n${lines.join('\n')}\n` });

    const gate = cx.gate ?? deps.gate(cx.env);

    // pushed_at rides the workspace insert batch below.
    const pushed = await deps
      .pusher(cx.env, cx.repo)
      .updateRef({ ref, oldOid: ZERO_SHA, newOid: commit.hash }, [commit, ...objects], { deferPushedAt: true });
    let created = pushed.status === 'ok';
    if (pushed.status === 'unknown') created = (await liveRefs(cx, [ref])).get(ref) === commit.hash;
    if (!created) {
      return fail(502, `the composed workspace ref could not be created (${pushed.status}${pushed.reason ? `: ${pushed.reason}` : ''})`, 'REF_CREATE_FAILED');
    }

    // The ref's push event may be consumed before the row below exists and is then skipped by the
    // intent index, so the registration seeds the observed set itself (guarded against newer pushes).
    // A failed seed is recorded as an omission so forecasts disclose it until a push reconciles the set.
    let observed: D1PreparedStatement[];
    try {
      observed = (
        await reconcileObserved(cx.env, {
          repoId: cx.repo.id,
          artifactsName: cx.repo.artifacts_name,
          workspaceId: id,
          baseSha,
          headSha: commit.hash,
          event: null,
        })
      ).statements;
    } catch (err) {
      console.warn(JSON.stringify({ composeObservedSeed: String(err).slice(0, 200) }));
      observed = [
        observedSeedFailedStatement(
          db,
          cx.repo.id,
          id,
          'observed set not computed: the composed workspace seed read failed; the next push to the workspace reconciles it',
        ),
      ];
    }

    const now = Date.now();
    const compositionId = newId();
    await db.batch([
      workspaceInsertStatement(cx, { id, ref, task, agent: p.agent, base: p.base, baseSha, headSha: commit.hash }, now),
      ...observed,
      touchRepoPushedStatement(db, cx.repo.id),
    ]);

    const linked: { id?: string } = {};
    const change = await openChangeSet(cx, id, { title: task, base: p.base, mergePolicy: p.mergePolicy }, (opened) => {
      linked.id = opened.id;
    });
    const changeId = change.ok ? (linked.id ?? null) : null;
    // The gate is asked once, after opening the change: that may register CI
    // jobs for this exact tree, and the change is the guard subject (before it
    // exists there is none, and the answer would only be a provisional pending).
    const checks = await gate.requiredChecksFor(
      { id: cx.repo.id },
      treeSha,
      null,
      changeId ? { changeId, headSha: commit.hash, guardBaseTree: baseTree } : undefined,
    );
    const read = await readComposition(
      cx,
      compositionId,
      db
        .prepare(
          `INSERT INTO compositions (id, repo_id, base_ref, base_sha, tree_sha, commit_sha, sources, workspace_id, checks, conflict_kind, created_by, agent_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
        )
        .bind(
          compositionId,
          cx.repo.id,
          p.base,
          baseSha,
          treeSha,
          commit.hash,
          JSON.stringify(recorded),
          id,
          JSON.stringify(checks),
          semanticConflict(checks) ? 'semantic' : null,
          cx.actor?.user.id ?? null,
          cx.actor?.agent?.agentId ?? null,
          now,
        ),
    );
    if (!read) return fail(500, 'composition could not be read back', 'CREATE_FAILED');
    if (!change.ok) {
      return { ok: true, value: { ...read, changeSetError: { status: change.status, error: change.error, ...(change.code ? { code: change.code } : {}) } } };
    }
    return { ok: true, value: read };
  });
}

/** Reads one composition with its workspace; `write` runs first in the same batch. */
async function readComposition(cx: ComposeContext, id: string, write?: D1PreparedStatement): Promise<CompositionView | null> {
  if (!WORKSPACE_ID_RE.test(id)) return null;
  const db = cx.env.DB;
  const results = await db.batch([
    ...(write ? [write] : []),
    db.prepare(`${COMPOSITION_SELECT} WHERE k.repo_id = ?1 AND k.id = ?2`).bind(cx.repo.id, id),
    db
      .prepare(`${WORKSPACE_SELECT} WHERE w.repo_id = ?1 AND w.id = (SELECT workspace_id FROM compositions WHERE repo_id = ?1 AND id = ?2)`)
      .bind(cx.repo.id, id),
  ]);
  const [k, w] = results.slice(write ? 1 : 0);
  const row = (k?.results as CompositionRow[] | undefined)?.[0];
  if (!row) return null;
  return compositionView(row, (w?.results as WorkspaceRow[] | undefined)?.[0] ?? null, cx);
}

/** GET compositions/:id */
export async function getComposition(cx: ComposeContext, id: string): Promise<ServiceResult<CompositionView>> {
  const v = await readComposition(cx, id);
  return v ? { ok: true, value: v } : fail(404, 'composition not found', 'COMPOSITION_NOT_FOUND');
}

export function compositionCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [db.prepare('DELETE FROM compositions WHERE repo_id = ?').bind(repoId)];
}

export interface CompositionSummary extends Omit<CompositionView, 'workspace' | 'changeSet'> {
  workspace: string;
}

/** GET compositions?limit=&cursor= — newest first, one indexed query. */
export async function listCompositions(
  cx: ComposeContext,
  q: { limit?: string; cursor?: string },
): Promise<ServiceResult<{ compositions: CompositionSummary[]; nextCursor: string | null }>> {
  const limit = q.limit === undefined ? COMPOSE_LIMITS.pageDefault : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > COMPOSE_LIMITS.pageMax) {
    return fail(400, `limit must be an integer 1-${COMPOSE_LIMITS.pageMax}`, 'INVALID_LIMIT');
  }
  let cursor: { at: number; seq: number } | null = null;
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(q.cursor);
    if (!m) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    cursor = { at: Number(m[1]), seq: Number(m[2]) };
  }
  const where = cursor ? 'AND (k.created_at < ?2 OR (k.created_at = ?2 AND k.rowid < ?3))' : '';
  const stmt = cx.env.DB.prepare(
    `SELECT k.id, k.base_ref, k.base_sha, k.tree_sha, k.commit_sha, k.sources, k.workspace_id, k.checks, k.conflict_kind,
            u.login AS created_by_login, k.created_at, k.rowid AS seq
       FROM compositions k LEFT JOIN users u ON u.id = k.created_by
      WHERE k.repo_id = ?1 ${where}
      ORDER BY k.created_at DESC, k.rowid DESC LIMIT ${limit + 1}`,
  );
  const rows = (await (cursor ? stmt.bind(cx.repo.id, cursor.at, cursor.seq) : stmt.bind(cx.repo.id)).all<CompositionRow & { seq: number }>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: {
      compositions: page.map((r) => {
        const { workspace: _w, changeSet: _c, ...rest } = compositionView(r, null, cx);
        return { ...rest, workspace: r.workspace_id };
      }),
      nextCursor: rows.length > limit && last ? `${last.created_at}.${last.seq}` : null,
    },
  };
}
