/**
 * Candidate comparison, ranking and arenas (architecture §0.1, §4, §11.7).
 *
 * A candidate set is explicit: the caller names 1-8 workspaces (`GET
 * candidates?workspaces=`), or an arena names its 2-8 workspaces created
 * together from one brief. For each active candidate the service reports its
 * vs-base summary (the same cached tree-pair body `compare/<base>...<ref>`
 * renders), pairwise head-to-head diffs, the checks-gate state of its head
 * tree and a deterministic ranking with the factors that placed it.
 *
 * Tree diffs come from the content-addressed compare cache keyed by tree
 * pair, so a repeated request reads nothing from Artifacts. Pairwise diffs
 * are derived from the two vs-base file lists (both are relative to the same
 * base tree) and fall back to a cached head-to-head body only when a vs-base
 * list is incomplete. Overlap between candidates is read from the Nexus index
 * (services/intents/forecast.ts), never computed here.
 *
 * Nothing here selects, merges or closes anything: an arena selection is a
 * recorded choice and the winner still merges through its own change set,
 * after a human confirms the selection (a final-selection escalation,
 * services/reviewGate.ts). Ranking and composition never approve anything.
 */

import { withLazyRepo } from '../artifacts/repo';
import type { ServiceResult } from '../repos/service';
import { credentialMayUpdateRef } from './authz';
import { normalizeBranch } from './changes';
import { defaultChecksGate, type CheckState, type ChecksGate, type RequiredCheck } from './checksGate';
import { treePairBody, type CompareBody, type CompareFile } from './compare';
import { ADVISORY_NOTE, setOverlap, setOverlapStatements, type SetOverlap, type SetOverlapPair } from './intents/forecast';
import { runPool } from './pool';
import { RefStoreUnavailable, resolveCommitish, type ResolveContext } from './refs';
import { finalSelectionEscalation } from './reviewGate';
import {
  WORKSPACE_ID_RE,
  arenaWorkspacesStatement,
  defaultWorkspaceDeps,
  liveRefs,
  newId,
  workspaceInsertStatement,
  workspaceRef,
  workspaceRowsStatement,
  workspaceView,
  type WorkspaceContext,
  type WorkspaceDeps,
  type WorkspaceRow,
  type WorkspaceView,
} from './workspaces';

export const CANDIDATE_LIMITS = {
  /** Workspaces in one candidates request. */
  max: 8,
  arenaMin: 2,
  arenaMax: 8,
  briefMax: 500,
  agentMax: 100,
  /** Files listed per vs-base summary (totals still cover the whole comparison). */
  filesPerCandidate: 100,
  /** Paths listed per pairwise diff (fileCount still covers all). */
  pairFilesMax: 100,
  /** Tree-pair bodies loaded at once on a cold request. */
  bodyConcurrency: 2,
  /** An arena pair is reported as duplication from this many shared observed paths. */
  duplicationMinSharedPaths: 1,
  arenaPageDefault: 20,
  arenaPageMax: 100,
} as const;

/** Ranking keys in the order they are compared; the last one makes the order total. */
export const RANKING_FACTORS = ['checks', 'complete', 'riskScore', 'overlapSharedPaths', 'changedLines', 'changedFiles', 'workspace'] as const;
/** Arenas expect duplication, so it is reported separately and never ranks. */
export const ARENA_RANKING_FACTORS = RANKING_FACTORS.filter((f) => f !== 'overlapSharedPaths');

const ZERO_SHA = '0000000000000000000000000000000000000000';

type Fail = Extract<ServiceResult<never>, { ok: false }> & Record<string, unknown>;

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}): Fail {
  return { ok: false, status, error, code, ...extra };
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export interface CandidatesContext extends WorkspaceContext {
  gate?: ChecksGate;
}

async function guarded<T>(fn: () => Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ candidatesRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CandidateFile {
  path: string;
  status: CompareFile['status'];
  oldPath?: string;
  additions?: number;
  deletions?: number;
  binary?: true;
  tooLarge?: true;
}

export interface VsBase {
  files: CandidateFile[];
  totals: CompareBody['totals'];
  totalsComplete: boolean;
  rating: CompareBody['rating'];
  truncated: boolean;
  truncatedReason?: string;
  statsOmitted?: true;
  /** More than `filesPerCandidate` files changed; `compare/<base>...<ref>` pages the rest. */
  filesTruncated?: true;
}

export interface CandidateChecks {
  /** The checks-gate state of the candidate's head tree (`success` when nothing is required). */
  state: CheckState;
  required: Array<Pick<RequiredCheck, 'name' | 'state' | 'producer'>>;
}

export interface CandidateSummary {
  workspace: string;
  task: string | null;
  agent: string | null;
  ref: string;
  branch: string;
  changeSet: number | null;
  /** The branch the workspace was created from; `baseMatches` is false when it is not the requested base. */
  workspaceBase: string | null;
  baseMatches: boolean;
  headSha: string;
  headTree: string;
  vsBase: VsBase;
  checks: CandidateChecks;
  /** From the Nexus index: the other candidates this one shares observed paths with (candidates sets only). */
  overlap?: { with: string[]; sharedPaths: number };
}

export interface PairFile {
  path: string;
  /** How the second candidate's head differs from the first's at this path. */
  status: 'added' | 'removed' | 'modified' | 'typechange' | 'renamed';
  oldPath?: string;
  /** Which candidates changed the path against the base (vs-base derivation only). */
  changedBy?: Array<'a' | 'b'>;
}

export interface PairDiff {
  /** The two candidates in request order. */
  workspaces: [string, string];
  /** `vs-base`: derived from both vs-base lists; `tree-pair`: a head-to-head tree diff. */
  source: 'vs-base' | 'tree-pair';
  files: PairFile[];
  fileCount: number;
  /** Paths both candidates changed to identical content. */
  identical: number;
  truncated: boolean;
  truncatedReason?: string;
}

export interface RankingEntry {
  rank: number;
  workspace: string;
  changeSet: number | null;
  factors: {
    checks: CheckState;
    failingChecks: string[];
    complete: boolean;
    riskScore: number;
    riskLevel: CompareBody['rating']['level'];
    overlapSharedPaths?: number;
    changedLines: number | null;
    changedFiles: number;
  };
}

export interface ExcludedCandidate {
  workspace: string;
  status: string;
  reason: string;
}

export interface CandidatesResponse {
  base: { ref: string; sha: string; tree: string };
  candidates: CandidateSummary[];
  excluded: ExcludedCandidate[];
  pairwise: PairDiff[];
  ranking: RankingEntry[];
  rankingFactors: readonly string[];
  overlap?: { source: 'nexus-index'; advisory: true; advisoryNote: string; pairs: SetOverlapPair[]; truncated: boolean; truncatedReason?: string };
  truncated: boolean;
  truncatedReason?: string;
}

// ---------------------------------------------------------------------------
// Comparison of a resolved set
// ---------------------------------------------------------------------------

interface Member {
  row: WorkspaceRow;
  ref: string;
  sha: string;
  tree: string;
}

type Mode = 'candidates' | 'arena';

function candidateFile(f: CompareFile): CandidateFile {
  const out: CandidateFile = { path: f.path, status: f.status };
  if (f.oldPath !== undefined) out.oldPath = f.oldPath;
  if (f.additions !== undefined) out.additions = f.additions;
  if (f.deletions !== undefined) out.deletions = f.deletions;
  if (f.binary) out.binary = true;
  if (f.tooLarge) out.tooLarge = true;
  return out;
}

function vsBase(body: CompareBody): VsBase {
  const v: VsBase = {
    files: body.files.slice(0, CANDIDATE_LIMITS.filesPerCandidate).map(candidateFile),
    totals: body.totals,
    totalsComplete: body.totalsComplete,
    rating: body.rating,
    truncated: body.truncated,
  };
  if (body.truncatedReason !== undefined) v.truncatedReason = body.truncatedReason;
  if (body.statsOmitted) v.statsOmitted = true;
  if (body.files.length > CANDIDATE_LIMITS.filesPerCandidate) v.filesTruncated = true;
  return v;
}

type Leaf = { mode: string; hash: string } | null;

/** Each changed leaf of a vs-base list: its base entry and its head entry (renames split into their two leaves). */
function leaves(body: CompareBody): Map<string, { base: Leaf; head: Leaf }> {
  const out = new Map<string, { base: Leaf; head: Leaf }>();
  const entry = (mode: string | null, hash: string | null): Leaf => (mode && hash ? { mode, hash } : null);
  for (const f of body.files) {
    if (f.status === 'renamed' && f.oldPath !== undefined) {
      out.set(f.oldPath, { base: entry(f.oldMode, f.oldHash), head: null });
      out.set(f.path, { base: null, head: entry(f.newMode, f.newHash) });
    } else out.set(f.path, { base: entry(f.oldMode, f.oldHash), head: entry(f.newMode, f.newHash) });
  }
  return out;
}

const fileType = (mode: string) => (mode === '120000' ? 'link' : mode === '160000' ? 'gitlink' : mode === '40000' ? 'tree' : 'file');

const isTreeMode = (mode: string | null) => mode === '40000' || mode === '040000';

/**
 * Whether a vs-base list has a directory/file replacement. Compare lists one
 * at the ancestor path only, so its descendants' head entries are not in the
 * list and cannot be derived from it.
 */
const hasStructuralChange = (body: CompareBody) => body.files.some((f) => isTreeMode(f.oldMode) || isTreeMode(f.newMode));

/** Head-to-head differences of two candidates over the same base, from their vs-base lists alone. */
function derivePair(a: CompareBody, b: CompareBody): { files: PairFile[]; identical: number } {
  const la = leaves(a);
  const lb = leaves(b);
  const files: PairFile[] = [];
  let identical = 0;
  for (const path of [...new Set([...la.keys(), ...lb.keys()])].sort()) {
    const ea = la.get(path);
    const eb = lb.get(path);
    const base = ea?.base ?? eb?.base ?? null;
    const ha = ea ? ea.head : base;
    const hb = eb ? eb.head : base;
    const changedBy: Array<'a' | 'b'> = [...(ea ? (['a'] as const) : []), ...(eb ? (['b'] as const) : [])];
    if (ha?.hash === hb?.hash && ha?.mode === hb?.mode) {
      if (changedBy.length === 2) identical++;
      continue;
    }
    const status: PairFile['status'] =
      ha === null ? 'added' : hb === null ? 'removed' : fileType(ha.mode) !== fileType(hb.mode) ? 'typechange' : 'modified';
    files.push({ path, status, changedBy });
  }
  return { files, identical };
}

function pairFromTreePair(body: CompareBody): { files: PairFile[] } {
  return {
    files: body.files.map((f) => {
      const p: PairFile = { path: f.path, status: f.status };
      if (f.oldPath !== undefined) p.oldPath = f.oldPath;
      return p;
    }),
  };
}

const CHECK_ORDER: Record<CheckState, number> = { success: 0, pending: 1, failure: 2 };

function rank(candidates: CandidateSummary[], mode: Mode): RankingEntry[] {
  const entries = candidates.map((c): RankingEntry => {
    const { additions, deletions } = c.vsBase.totals;
    const factors: RankingEntry['factors'] = {
      checks: c.checks.state,
      failingChecks: c.checks.required.filter((k) => k.state === 'failure').map((k) => k.name),
      complete: c.vsBase.totalsComplete,
      riskScore: c.vsBase.rating.score,
      riskLevel: c.vsBase.rating.level,
      changedLines: additions === null || deletions === null ? null : additions + deletions,
      changedFiles: c.vsBase.totals.files,
    };
    if (mode === 'candidates') factors.overlapSharedPaths = c.overlap?.sharedPaths ?? 0;
    return { rank: 0, workspace: c.workspace, changeSet: c.changeSet, factors };
  });
  const cmp = (x: RankingEntry, y: RankingEntry): number => {
    const a = x.factors;
    const b = y.factors;
    return (
      CHECK_ORDER[a.checks] - CHECK_ORDER[b.checks] ||
      Number(b.complete) - Number(a.complete) ||
      a.riskScore - b.riskScore ||
      (a.overlapSharedPaths ?? 0) - (b.overlapSharedPaths ?? 0) ||
      (a.changedLines ?? Number.MAX_SAFE_INTEGER) - (b.changedLines ?? Number.MAX_SAFE_INTEGER) ||
      a.changedFiles - b.changedFiles ||
      (x.workspace < y.workspace ? -1 : x.workspace > y.workspace ? 1 : 0)
    );
  };
  return entries.sort(cmp).map((e, i) => ({ ...e, rank: i + 1 }));
}

function excludedOf(row: WorkspaceRow, reason: string): ExcludedCandidate {
  return { workspace: row.id, status: row.status, reason };
}

/**
 * The comparison of `rows` (in request order) against the head of `base`.
 * Inactive workspaces and those whose ref is gone are listed in `excluded`.
 */
async function compareSet(
  cx: CandidatesContext,
  base: string,
  rows: WorkspaceRow[],
  overlap: SetOverlap,
  mode: Mode,
): Promise<ServiceResult<CandidatesResponse>> {
  const excluded: ExcludedCandidate[] = [];
  const active = rows.filter((r) => {
    if (r.status === 'active' && r.ref) return true;
    excluded.push(excludedOf(r, r.status === 'active' ? 'workspace has no ref' : `workspace is ${r.status}`));
    return false;
  });
  const gate = cx.gate ?? defaultChecksGate(cx.env);
  const baseRef = `refs/heads/${base}`;

  return withLazyRepo(cx.env, cx.repo.artifacts_name, async (artifacts) => {
    const ctx: ResolveContext = { env: cx.env, repo: cx.repo, artifacts, bypass: false, waitUntil: cx.waitUntil };
    const resolved = await resolveCommitish(ctx, [baseRef, ...active.map((r) => r.ref!)]);
    const baseCommit = resolved.get(baseRef);
    if (!baseCommit) return fail(422, `base branch not found: ${base}`, 'REF_NOT_FOUND', { ref: base });

    const members: Member[] = [];
    for (const row of active) {
      const head = resolved.get(row.ref!);
      if (!head) excluded.push(excludedOf(row, 'workspace ref not found'));
      else members.push({ row, ref: row.ref!, sha: head.sha, tree: head.tree });
    }

    const bodies = Array.from<CompareBody>({ length: members.length });
    await runPool(members, CANDIDATE_LIMITS.bodyConcurrency, async (m, i) => {
      bodies[i] = (await treePairBody(ctx, baseCommit.tree, m.tree)).body;
    });
    const checks = await Promise.all(members.map((m) => gate.requiredChecksFor({ id: cx.repo.id }, m.tree, null, { headSha: m.sha })));

    const reasons: string[] = [];
    const candidates = members.map((m, i): CandidateSummary => {
      const v = vsBase(bodies[i]!);
      if (v.truncated) reasons.push(`${m.row.id}: ${v.truncatedReason ?? 'comparison truncated'}`);
      if (v.filesTruncated) reasons.push(`${m.row.id}: more than ${CANDIDATE_LIMITS.filesPerCandidate} changed files; compare/${base}...${m.ref} lists them all`);
      const c: CandidateSummary = {
        workspace: m.row.id,
        task: m.row.task,
        agent: m.row.agent,
        ref: m.ref,
        branch: m.ref.slice('refs/heads/'.length),
        changeSet: m.row.change_number,
        workspaceBase: m.row.base_ref,
        baseMatches: m.row.base_ref === base,
        headSha: m.sha,
        headTree: m.tree,
        vsBase: v,
        checks: { state: checks[i]!.state, required: checks[i]!.required.map((k) => ({ name: k.name, state: k.state, producer: k.producer })) },
      };
      if (mode === 'candidates') c.overlap = overlap.members.get(m.row.id) ?? { with: [], sharedPaths: 0 };
      return c;
    });

    const pairwise: PairDiff[] = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        const ids: [string, string] = [members[i]!.row.id, members[j]!.row.id];
        let pair: PairDiff;
        if (!a.truncated && !b.truncated && !hasStructuralChange(a) && !hasStructuralChange(b)) {
          const d = derivePair(a, b);
          pair = { workspaces: ids, source: 'vs-base', files: d.files, fileCount: d.files.length, identical: d.identical, truncated: false };
        } else {
          const body = (await treePairBody(ctx, members[i]!.tree, members[j]!.tree)).body;
          const d = pairFromTreePair(body);
          pair = { workspaces: ids, source: 'tree-pair', files: d.files, fileCount: d.files.length, identical: 0, truncated: body.truncated };
          if (body.truncatedReason !== undefined) pair.truncatedReason = body.truncatedReason;
        }
        if (pair.files.length > CANDIDATE_LIMITS.pairFilesMax) {
          pair.files = pair.files.slice(0, CANDIDATE_LIMITS.pairFilesMax);
          pair.truncated = true;
          pair.truncatedReason = [pair.truncatedReason, `more than ${CANDIDATE_LIMITS.pairFilesMax} differing paths listed`].filter(Boolean).join('; ');
        }
        if (pair.truncated) reasons.push(`${ids[0]}/${ids[1]}: ${pair.truncatedReason ?? 'pairwise diff truncated'}`);
        pairwise.push(pair);
      }
    }
    if (overlap.truncated) reasons.push(`overlap: ${overlap.truncatedReason ?? 'truncated'}`);

    const out: CandidatesResponse = {
      base: { ref: base, sha: baseCommit.sha, tree: baseCommit.tree },
      candidates,
      excluded,
      pairwise,
      ranking: rank(candidates, mode),
      rankingFactors: mode === 'arena' ? ARENA_RANKING_FACTORS : RANKING_FACTORS,
      truncated: reasons.length > 0,
    };
    if (mode === 'candidates') {
      out.overlap = { source: 'nexus-index', advisory: true, advisoryNote: ADVISORY_NOTE, pairs: overlap.pairs, truncated: overlap.truncated };
      if (overlap.truncatedReason !== undefined) out.overlap.truncatedReason = overlap.truncatedReason;
    }
    if (reasons.length > 0) out.truncatedReason = reasons.join('; ');
    return { ok: true, value: out };
  });
}

// ---------------------------------------------------------------------------
// GET candidates
// ---------------------------------------------------------------------------

function parseBase(cx: CandidatesContext, raw: unknown): string | Fail {
  if (raw === undefined || raw === null || raw === '') return cx.repo.default_branch;
  const b = normalizeBranch(raw);
  return b === null ? fail(422, 'base must be a branch name', 'INVALID_REF') : b;
}

function parseIds(raw: string | undefined): string[] | Fail {
  if (raw === undefined || raw.trim() === '') {
    return fail(400, `workspaces is required: a comma-separated list of 1-${CANDIDATE_LIMITS.max} workspace ids`, 'INVALID_WORKSPACES');
  }
  const ids = raw.split(',').map((s) => s.trim());
  if (ids.length > CANDIDATE_LIMITS.max) {
    return fail(422, `at most ${CANDIDATE_LIMITS.max} workspaces can be compared at once (got ${ids.length})`, 'TOO_MANY_CANDIDATES', {
      limit: CANDIDATE_LIMITS.max,
      requested: ids.length,
    });
  }
  const bad = ids.filter((id) => !WORKSPACE_ID_RE.test(id));
  if (bad.length > 0) return fail(400, `invalid workspace id: ${JSON.stringify(bad[0]!.slice(0, 80))}`, 'INVALID_WORKSPACES');
  if (new Set(ids).size !== ids.length) return fail(400, 'workspaces lists an id more than once', 'DUPLICATE_WORKSPACES');
  return ids;
}

const isFail = (v: unknown): v is Fail => typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;

/** GET candidates?base=&workspaces=a,b,c — one D1 batch (rows + Nexus overlap), then cached tree pairs. */
export function candidates(cx: CandidatesContext, q: { base?: string; workspaces?: string }): Promise<ServiceResult<CandidatesResponse>> {
  return guarded(async () => {
    const ids = parseIds(q.workspaces);
    if (isFail(ids)) return ids;
    const base = parseBase(cx, q.base);
    if (isFail(base)) return base;
    const db = cx.env.DB;
    const [rowsRes, ...overlapRes] = await db.batch([workspaceRowsStatement(db, cx.repo.id, ids), ...setOverlapStatements(db, cx.repo.id, ids)]);
    const found = new Map(((rowsRes?.results as WorkspaceRow[] | undefined) ?? []).map((r) => [r.id, r]));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) return fail(404, `workspace not found: ${missing.join(', ')}`, 'WORKSPACE_NOT_FOUND', { workspaces: missing });
    return compareSet(cx, base, ids.map((id) => found.get(id)!), setOverlap(ids, overlapRes), 'candidates');
  });
}

// ---------------------------------------------------------------------------
// Arenas
// ---------------------------------------------------------------------------

interface ArenaRow {
  id: string;
  brief: string;
  base_ref: string;
  base_sha: string;
  candidates: number;
  state: 'open' | 'selected';
  created_by_login: string | null;
  agent_id: string | null;
  created_at: number;
  selected_workspace: string | null;
  selected_by: string | null;
  selected_at: number | null;
}

const ARENA_SELECT = `SELECT a.id, a.brief, a.base_ref, a.base_sha, a.candidates, a.state, u.login AS created_by_login, a.agent_id,
       a.created_at, a.selected_workspace, a.selected_by, a.selected_at
  FROM arenas a LEFT JOIN users u ON u.id = a.created_by`;

export interface ArenaSelection {
  selectedWorkspace: string;
  selectedBy: { login: string | null; agent: string | null };
  selectedAt: string;
}

export interface ArenaView {
  id: string;
  brief: string;
  base: string;
  baseSha: string;
  state: 'open' | 'selected';
  candidates: number;
  workspaces: WorkspaceView[];
  selection: ArenaSelection | null;
  createdBy: string | null;
  createdAt: string;
}

function arenaView(row: ArenaRow, workspaces: WorkspaceRow[], cx: Pick<WorkspaceContext, 'repo' | 'origin'>): ArenaView {
  let selection: ArenaSelection | null = null;
  if (row.selected_workspace && row.selected_at !== null) {
    const by = row.selected_by ? (JSON.parse(row.selected_by) as ArenaSelection['selectedBy']) : { login: null, agent: null };
    selection = { selectedWorkspace: row.selected_workspace, selectedBy: by, selectedAt: iso(row.selected_at)! };
  }
  return {
    id: row.id,
    brief: row.brief,
    base: row.base_ref,
    baseSha: row.base_sha,
    state: row.state,
    candidates: row.candidates,
    workspaces: workspaces.map((w) => workspaceView(w, cx.repo, cx.origin)),
    selection,
    createdBy: row.created_by_login,
    createdAt: iso(row.created_at)!,
  };
}

function arenaStatements(db: D1Database, repoId: string, id: string): D1PreparedStatement[] {
  return [db.prepare(`${ARENA_SELECT} WHERE a.repo_id = ?1 AND a.id = ?2`).bind(repoId, id), arenaWorkspacesStatement(db, repoId, id)];
}

async function readArena(env: Env, repoId: string, id: string): Promise<{ row: ArenaRow; workspaces: WorkspaceRow[] } | null> {
  if (!WORKSPACE_ID_RE.test(id)) return null;
  const [arena, ws] = await env.DB.batch(arenaStatements(env.DB, repoId, id));
  const row = (arena?.results as ArenaRow[] | undefined)?.[0];
  if (!row) return null;
  return { row, workspaces: (ws?.results as WorkspaceRow[] | undefined) ?? [] };
}

interface ArenaInput {
  brief: string;
  base: string;
  count: number;
  agent: string;
}

function parseArena(cx: CandidatesContext, input: unknown): ArenaInput | Fail {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const b = input as Record<string, unknown>;
  const brief = typeof b.brief === 'string' ? b.brief.trim() : '';
  if (brief.length === 0 || brief.length > CANDIDATE_LIMITS.briefMax) {
    return fail(422, `brief is required (1-${CANDIDATE_LIMITS.briefMax} characters)`, 'INVALID_BRIEF');
  }
  const count = b.candidates;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < CANDIDATE_LIMITS.arenaMin || count > CANDIDATE_LIMITS.arenaMax) {
    return fail(422, `candidates must be an integer from ${CANDIDATE_LIMITS.arenaMin} to ${CANDIDATE_LIMITS.arenaMax}`, 'INVALID_CANDIDATES', {
      min: CANDIDATE_LIMITS.arenaMin,
      max: CANDIDATE_LIMITS.arenaMax,
    });
  }
  const base = parseBase(cx, b.base);
  if (isFail(base)) return base;
  let agent: string;
  if (b.agent === undefined || b.agent === null) agent = cx.actor?.agent?.agentName ?? cx.actor?.user.login ?? 'unknown';
  else if (typeof b.agent === 'string' && b.agent.trim().length > 0 && b.agent.trim().length <= CANDIDATE_LIMITS.agentMax) agent = b.agent.trim();
  else return fail(422, `agent must be a string of 1-${CANDIDATE_LIMITS.agentMax} characters`, 'INVALID_AGENT');
  return { brief, base, count, agent };
}

/**
 * POST arenas {brief, base?, candidates: 2-8, agent?}: every input check runs
 * before any write; then one workspace ref per candidate is created at the
 * base head (GitPusher), and one batch inserts the arena and its workspace
 * rows. A ref that fails leaves no rows at all; refs already created for the
 * request are deleted again (best effort; without rows they are inert).
 */
export function createArena(cx: CandidatesContext, input: unknown, deps: WorkspaceDeps = defaultWorkspaceDeps): Promise<ServiceResult<ArenaView>> {
  return guarded(async () => {
    const p = parseArena(cx, input);
    if (isFail(p)) return p;
    const specs = Array.from({ length: p.count }, () => {
      const id = newId();
      return { id, ref: workspaceRef(id, p.brief) };
    });
    if (cx.actor?.agent && specs.some((s) => !credentialMayUpdateRef(cx.actor!, s.ref))) {
      return fail(403, 'this agent token may not create refs/heads/agents/<id>/ refs', 'AGENT_REF_FORBIDDEN');
    }
    const baseRef = `refs/heads/${p.base}`;
    const baseSha = (await liveRefs(cx, [baseRef])).get(baseRef) ?? null;
    if (!baseSha) return fail(422, `base branch not found: ${p.base}`, 'REF_NOT_FOUND', { ref: p.base });

    const pusher = deps.pusher(cx.env, cx.repo);
    const created: string[] = [];
    let failure: string | null = null;
    for (const s of specs) {
      const r = await pusher.updateRef({ ref: s.ref, oldOid: ZERO_SHA, newOid: baseSha });
      let ok = r.status === 'ok';
      if (r.status === 'unknown') ok = (await liveRefs(cx, [s.ref])).get(s.ref) === baseSha;
      if (!ok) {
        failure = `${r.status}${r.reason ? `: ${r.reason}` : ''}`;
        break;
      }
      created.push(s.ref);
    }
    if (failure !== null) {
      for (const ref of created) await pusher.updateRef({ ref, oldOid: baseSha, newOid: ZERO_SHA }).catch(() => undefined);
      return fail(502, `a candidate workspace ref could not be created (${failure})`, 'REF_CREATE_FAILED');
    }

    const now = Date.now();
    const arenaId = newId();
    const db = cx.env.DB;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO arenas (id, repo_id, brief, base_ref, base_sha, candidates, state, created_by, agent_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7, ?8, ?9)`,
        )
        .bind(arenaId, cx.repo.id, p.brief, p.base, baseSha, p.count, cx.actor?.user.id ?? null, cx.actor?.agent?.agentId ?? null, now),
      ...specs.map((s) =>
        workspaceInsertStatement(cx, { id: s.id, ref: s.ref, task: p.brief, agent: p.agent, base: p.base, baseSha, arenaId }, now),
      ),
      ...arenaStatements(db, cx.repo.id, arenaId),
    ]);
    const arena = (results[results.length - 2]?.results as ArenaRow[] | undefined)?.[0];
    const ws = (results[results.length - 1]?.results as WorkspaceRow[] | undefined) ?? [];
    if (!arena) return fail(500, 'arena could not be created', 'CREATE_FAILED');
    return { ok: true, value: arenaView(arena, ws, cx) };
  });
}

/** GET arenas/:id — one batch: the arena and its workspaces. */
export async function getArena(cx: CandidatesContext, id: string): Promise<ServiceResult<ArenaView>> {
  const a = await readArena(cx.env, cx.repo.id, id);
  if (!a) return fail(404, 'arena not found', 'ARENA_NOT_FOUND');
  return { ok: true, value: arenaView(a.row, a.workspaces, cx) };
}

export interface ArenaSummary extends Omit<ArenaView, 'workspaces'> {
  workspaces: string[];
}

/** GET arenas?limit=&cursor= — newest first, one indexed query. */
export async function listArenas(cx: CandidatesContext, q: { limit?: string; cursor?: string }): Promise<ServiceResult<{ arenas: ArenaSummary[]; nextCursor: string | null }>> {
  const limit = q.limit === undefined ? CANDIDATE_LIMITS.arenaPageDefault : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > CANDIDATE_LIMITS.arenaPageMax) {
    return fail(400, `limit must be an integer 1-${CANDIDATE_LIMITS.arenaPageMax}`, 'INVALID_LIMIT');
  }
  let cursor: { at: number; seq: number } | null = null;
  if (q.cursor !== undefined) {
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(q.cursor);
    if (!m) return fail(400, 'cursor is invalid', 'INVALID_CURSOR');
    cursor = { at: Number(m[1]), seq: Number(m[2]) };
  }
  const where = cursor ? 'AND (a.created_at < ?2 OR (a.created_at = ?2 AND a.rowid < ?3))' : '';
  const stmt = cx.env.DB.prepare(
    `SELECT a.id, a.brief, a.base_ref, a.base_sha, a.candidates, a.state, u.login AS created_by_login, a.agent_id,
            a.created_at, a.selected_workspace, a.selected_by, a.selected_at, a.rowid AS seq,
            (SELECT json_group_array(w.id) FROM (SELECT id FROM workspaces WHERE repo_id = a.repo_id AND arena_id = a.id ORDER BY created_at, rowid) w) AS ws
       FROM arenas a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.repo_id = ?1 ${where}
      ORDER BY a.created_at DESC, a.rowid DESC LIMIT ${limit + 1}`,
  );
  const rows =
    (await (cursor ? stmt.bind(cx.repo.id, cursor.at, cursor.seq) : stmt.bind(cx.repo.id)).all<ArenaRow & { seq: number; ws: string }>()).results ?? [];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    ok: true,
    value: {
      arenas: page.map((r) => {
        const { workspaces: _w, ...rest } = arenaView(r, [], cx);
        return { ...rest, workspaces: JSON.parse(r.ws) as string[] };
      }),
      nextCursor: rows.length > limit && last ? `${last.created_at}.${last.seq}` : null,
    },
  };
}

/**
 * POST arenas/:id/select {workspace}: records the caller's choice of winner.
 * It merges, closes and abandons nothing; the winner merges through its own
 * change set under the normal policy once a human closes the final-selection
 * escalation it opens there, and the other candidates stay open until
 * someone abandons them.
 */
export async function selectArena(cx: CandidatesContext, id: string, input: unknown): Promise<ServiceResult<ArenaView>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(400, 'body must be a JSON object', 'INVALID_BODY');
  const ws = (input as Record<string, unknown>).workspace;
  if (typeof ws !== 'string' || !WORKSPACE_ID_RE.test(ws)) return fail(422, 'workspace must be a workspace id', 'INVALID_WORKSPACE');
  const a = await readArena(cx.env, cx.repo.id, id);
  if (!a) return fail(404, 'arena not found', 'ARENA_NOT_FOUND');
  const member = a.workspaces.find((w) => w.id === ws);
  if (!member) return fail(422, `workspace ${ws} is not a candidate of this arena`, 'NOT_ARENA_CANDIDATE', { workspace: ws });
  if (member.status === 'abandoned') {
    return fail(409, `workspace ${ws} is abandoned`, 'WORKSPACE_NOT_ACTIVE', { workspace: ws, workspaceStatus: member.status });
  }
  const by = JSON.stringify({ login: cx.actor?.user.login ?? null, agent: cx.actor?.agent?.agentName ?? null });
  const db = cx.env.DB;
  const now = Date.now();
  const [, , arena, rows] = await db.batch([
    db
      .prepare(`UPDATE arenas SET state = 'selected', selected_workspace = ?3, selected_by = ?4, selected_at = ?5 WHERE repo_id = ?1 AND id = ?2`)
      .bind(cx.repo.id, a.row.id, ws, by, now),
    // A final selection is confirmed by a human before the winner's change set publishes.
    finalSelectionEscalation(db, cx.repo.id, ws, now),
    ...arenaStatements(db, cx.repo.id, a.row.id),
  ]);
  const row = (arena?.results as ArenaRow[] | undefined)?.[0] ?? a.row;
  return { ok: true, value: arenaView(row, (rows?.results as WorkspaceRow[] | undefined) ?? a.workspaces, cx) };
}

export interface ArenaCandidatesResponse extends CandidatesResponse {
  arena: string;
  /**
   * Candidate pairs whose observed changes share at least
   * `minSharedPaths` paths (Nexus index). Arenas expect duplication, so it is
   * reported here and never ranks.
   */
  duplication: {
    source: 'nexus-index';
    advisory: true;
    minSharedPaths: number;
    pairs: SetOverlapPair[];
    truncated: boolean;
    truncatedReason?: string;
  };
}

/** GET arenas/:id/candidates — the arena's candidate set compared and ranked at its base. */
export function arenaCandidates(cx: CandidatesContext, id: string): Promise<ServiceResult<ArenaCandidatesResponse>> {
  return guarded(async () => {
    const a = await readArena(cx.env, cx.repo.id, id);
    if (!a) return fail(404, 'arena not found', 'ARENA_NOT_FOUND');
    const ids = a.workspaces.map((w) => w.id);
    const overlapRes = await cx.env.DB.batch(setOverlapStatements(cx.env.DB, cx.repo.id, ids));
    const overlap = setOverlap(ids, overlapRes);
    const set = await compareSet(cx, a.row.base_ref, a.workspaces, overlap, 'arena');
    if (!set.ok) return set;
    const duplication: ArenaCandidatesResponse['duplication'] = {
      source: 'nexus-index',
      advisory: true,
      minSharedPaths: CANDIDATE_LIMITS.duplicationMinSharedPaths,
      pairs: overlap.pairs.filter((p) => p.pathCount >= CANDIDATE_LIMITS.duplicationMinSharedPaths),
      truncated: overlap.truncated,
    };
    if (overlap.truncatedReason !== undefined) duplication.truncatedReason = overlap.truncatedReason;
    return { ok: true, value: { arena: a.row.id, ...set.value, duplication } };
  });
}

export function arenaCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [db.prepare('DELETE FROM arenas WHERE repo_id = ?').bind(repoId)];
}

