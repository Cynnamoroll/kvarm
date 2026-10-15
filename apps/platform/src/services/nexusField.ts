/**
 * The signed-in dashboard's Nexus field: where agents in the viewer's
 * repositories have declared or been observed working, the intents behind
 * that work, and the overlap the Nexus index reports between active
 * workspaces (architecture §11.2). Read-only and advisory like every Nexus
 * surface; overlap itself is computed only by services/intents/forecast.ts.
 *
 * Bounded: at most `repos` repositories, each one workspace page, one
 * overlap page and one capped read of the active path index.
 */

import type { RepoRow } from '../db/repos';
import { listWorkspaces, type WorkspaceView } from './workspaces';
import { ADVISORY_NOTE, overlap, type OverlapPair } from './intents/forecast';

export const NEXUS_FIELD_LIMITS = {
  /** Repositories read, most recently pushed first. */
  repos: 6,
  /** Active workspaces read per repository. */
  workspaces: 20,
  /** Index rows (declared and observed paths) read per repository. */
  paths: 400,
  /** Overlap pairs read per repository. */
  pairs: 20,
  /** Areas drawn in the field. */
  areas: 9,
  /** Intents listed beside the field. */
  intents: 6,
} as const;

/** Leading directory segments that name an area of the codebase. */
const AREA_DEPTH = 2;

export interface NexusArea {
  repo: string;
  /** Directory prefix (trailing `/`) or a top-level file path. */
  path: string;
  declared: number;
  observed: number;
  /** Agents (or workspace creators) with paths in the area, deduplicated. */
  agents: string[];
  overlapping: boolean;
}

export interface NexusIntent {
  repo: string;
  workspace: string;
  task: string | null;
  agent: string | null;
  paths: string[];
  changeSet: number | null;
  overlapping: boolean;
  updatedAt: string;
}

export interface NexusOverlap {
  repo: string;
  workspaces: [string, string];
  agents: [string | null, string | null];
  paths: string[];
  pathCount: number;
}

export interface NexusField {
  repos: number;
  activeWorkspaces: number;
  areas: NexusArea[];
  intents: NexusIntent[];
  overlaps: NexusOverlap[];
  /** Repositories whose reads failed or were cut short; the field is partial for them. */
  partial: string[];
  advisoryNote: string;
}

interface PathRow {
  kind: 'declared' | 'observed';
  path: string;
  workspace_id: string;
}

/** `packages/zod/src/v4/x.ts` -> `packages/zod/`; a top-level file stays itself. */
export function areaOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const dirs = path.endsWith('/') ? parts : parts.slice(0, -1);
  if (dirs.length === 0) return parts[0] ?? path;
  return `${dirs.slice(0, AREA_DEPTH).join('/')}/`;
}

interface RepoRead {
  repo: string;
  workspaces: WorkspaceView[];
  paths: PathRow[];
  pairs: OverlapPair[];
  partial: boolean;
}

async function readRepo(env: Env, repo: RepoRow, origin: string): Promise<RepoRead> {
  const name = `${repo.owner_login}/${repo.name}`;
  const [page, pairs, paths] = await Promise.all([
    listWorkspaces(env, repo, origin, { status: 'active', limit: String(NEXUS_FIELD_LIMITS.workspaces) }),
    overlap({ env, repo, actor: null }, { limit: String(NEXUS_FIELD_LIMITS.pairs) }),
    env.DB.prepare('SELECT kind, path, workspace_id FROM workspace_paths WHERE repo_id = ? LIMIT ?')
      .bind(repo.id, NEXUS_FIELD_LIMITS.paths + 1)
      .all<PathRow>()
      .then((r) => r.results ?? []),
  ]);
  const workspaces = page.ok ? page.value.workspaces : [];
  return {
    repo: name,
    workspaces,
    paths: paths.slice(0, NEXUS_FIELD_LIMITS.paths),
    pairs: pairs.ok ? pairs.value.pairs : [],
    partial:
      !page.ok ||
      page.value.nextCursor !== null ||
      !pairs.ok ||
      pairs.value.truncated ||
      paths.length > NEXUS_FIELD_LIMITS.paths,
  };
}

export async function nexusField(env: Env, repos: RepoRow[], origin: string): Promise<NexusField> {
  const chosen = [...repos]
    .sort((a, b) => (b.pushed_at ?? 0) - (a.pushed_at ?? 0))
    .slice(0, NEXUS_FIELD_LIMITS.repos);
  const reads = await Promise.all(
    chosen.map((repo) =>
      readRepo(env, repo, origin).catch(
        (): RepoRead => ({ repo: `${repo.owner_login}/${repo.name}`, workspaces: [], paths: [], pairs: [], partial: true }),
      ),
    ),
  );

  const areas = new Map<string, NexusArea & { ws: Set<string> }>();
  const intents: NexusIntent[] = [];
  const overlaps: NexusOverlap[] = [];
  let activeWorkspaces = 0;

  for (const r of reads) {
    const byId = new Map(r.workspaces.map((w) => [w.id, w]));
    activeWorkspaces += r.workspaces.length;
    const overlapped = new Set<string>();
    const overlappedPaths = new Set<string>();
    for (const p of r.pairs) {
      overlapped.add(p.workspaces[0]);
      overlapped.add(p.workspaces[1]);
      for (const path of p.paths) overlappedPaths.add(areaOf(path));
      overlaps.push({
        repo: r.repo,
        workspaces: p.workspaces,
        agents: [p.heads[0].agent, p.heads[1].agent],
        paths: p.paths,
        pathCount: p.pathCount,
      });
    }
    for (const row of r.paths) {
      const area = areaOf(row.path);
      const key = `${r.repo}\n${area}`;
      const entry = areas.get(key) ?? { repo: r.repo, path: area, declared: 0, observed: 0, agents: [], overlapping: false, ws: new Set<string>() };
      if (row.kind === 'declared') entry.declared++;
      else entry.observed++;
      entry.ws.add(row.workspace_id);
      const w = byId.get(row.workspace_id);
      const who = w?.agent ?? w?.createdBy ?? null;
      if (who && !entry.agents.includes(who)) entry.agents.push(who);
      if (overlappedPaths.has(area)) entry.overlapping = true;
      areas.set(key, entry);
    }
    for (const w of r.workspaces) {
      if (!w.task && w.declaredPaths.length === 0) continue;
      intents.push({
        repo: r.repo,
        workspace: w.id,
        task: w.task,
        agent: w.agent ?? w.createdBy,
        paths: w.declaredPaths,
        changeSet: w.changeSet,
        overlapping: overlapped.has(w.id),
        updatedAt: w.updatedAt,
      });
    }
  }

  const rankedAreas = [...areas.values()]
    .sort(
      (a, b) =>
        Number(b.overlapping) - Number(a.overlapping) ||
        b.ws.size - a.ws.size ||
        b.declared + b.observed - (a.declared + a.observed) ||
        (a.path < b.path ? -1 : 1),
    )
    .slice(0, NEXUS_FIELD_LIMITS.areas)
    // Agent names come out in workspace_paths scan order, which the query
    // planner does not guarantee; a stable display sorts them.
    .map(({ ws: _ws, ...area }) => ({ ...area, agents: [...area.agents].sort() }));
  intents.sort(
    (a, b) =>
      Number(b.overlapping) - Number(a.overlapping) ||
      (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.workspace < b.workspace ? -1 : 1),
  );

  return {
    repos: chosen.length,
    activeWorkspaces,
    areas: rankedAreas,
    intents: intents.slice(0, NEXUS_FIELD_LIMITS.intents),
    overlaps,
    partial: reads.filter((r) => r.partial).map((r) => r.repo),
    advisoryNote: ADVISORY_NOTE,
  };
}
