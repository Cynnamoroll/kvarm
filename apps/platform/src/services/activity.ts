/**
 * The repository activity view's one read set: the active workspaces with
 * each agent principal's model family, their pinned dependencies, the Nexus
 * overlap pairs of the base in question, and the newest arenas — the
 * composition `kvarm status` performs over the API, read here directly.
 *
 * Every read is bounded and indexed (architecture §10): the workspace page,
 * the agents' model families by primary key, one shared pins read for the
 * whole page, the overlap query over the Nexus shared-path index, and one
 * arena page. No Artifacts read, no write, nothing that kicks a train.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { listWorkspaces, type WorkspaceView } from './workspaces';
import { dependencyRowsStatement, dependencyView, type DependencyRow, type DependencyView } from './dependencyGate';
import { listArenas, type ArenaSummary } from './candidates';
import { overlap, type OverlapResponse } from './intents/forecast';

export const ACTIVITY_LIMITS = {
  /** Workspaces on the activity page. */
  workspaces: 50,
  /** Arenas previewed on the activity page. */
  arenas: 5,
  /** Overlap pairs read for the page's base. */
  overlapPairs: 20,
} as const;

export interface ActivityWorkspace extends WorkspaceView {
  /** The owning agent principal's model family, when the workspace has one. */
  modelFamily: string | null;
  dependencies: DependencyView[];
}

export interface RepoActivity {
  base: string;
  /** `active` by default; the page offers `all` through the same bounded read. */
  status: string;
  workspaces: ActivityWorkspace[];
  /** Set when the newest page shown is not the last (older workspaces exist). */
  workspacesNextCursor: string | null;
  overlap: OverlapResponse;
  arenas: { arenas: ArenaSummary[]; nextCursor: string | null };
}

interface AgentFamilyRow {
  id: string;
  model_family: string | null;
}

export async function repoActivity(
  env: Env,
  repo: RepoRow,
  origin: string,
  q: { status?: string; limit?: string; cursor?: string; base?: string } = {},
): Promise<ServiceResult<RepoActivity>> {
  const status = q.status ?? 'active';
  const limit = q.limit ?? String(ACTIVITY_LIMITS.workspaces);
  const [page, arenas, pairs] = await Promise.all([
    listWorkspaces(env, repo, origin, { status, limit, cursor: q.cursor }),
    listArenas({ env, repo, actor: null, origin, waitUntil: () => undefined }, { limit: String(ACTIVITY_LIMITS.arenas) }),
    overlap({ env, repo, actor: null }, { base: q.base, limit: String(ACTIVITY_LIMITS.overlapPairs) }),
  ]);
  if (!page.ok) return page;
  if (!arenas.ok) return arenas;
  if (!pairs.ok) return pairs;

  const list = page.value.workspaces;
  // The pinned dependencies of every workspace on the page, in one shared read.
  const agentIds = [...new Set(list.map((w) => w.agentId).filter((a): a is string => a !== null))];
  const noRows = env.DB.prepare('SELECT NULL AS id, NULL AS model_family WHERE 0');
  const [familiesRes, pinsRes] = await env.DB.batch([
    agentIds.length > 0
      ? env.DB.prepare(`SELECT id, model_family FROM agents WHERE id IN (${agentIds.map(() => '?').join(', ')})`).bind(...agentIds)
      : noRows,
    list.length > 0
      ? dependencyRowsStatement(env.DB, repo.id, { where: `w.id IN (${list.map(() => '?').join(', ')})`, dependents: list.length }, ...list.map((w) => w.id))
      : noRows,
  ]);
  const families = new Map<string, string | null>(
    ((familiesRes?.results as AgentFamilyRow[] | undefined) ?? []).map((r) => [r.id, r.model_family]),
  );
  const pins = new Map<string, DependencyView[]>();
  for (const row of (pinsRes?.results as DependencyRow[] | undefined) ?? []) {
    const view = dependencyView(row);
    const edges = pins.get(view.workspaceId) ?? [];
    edges.push(view);
    pins.set(view.workspaceId, edges);
  }

  const workspaces: ActivityWorkspace[] = list.map((w) => ({
    ...w,
    modelFamily: w.agentId !== null ? (families.get(w.agentId) ?? null) : null,
    dependencies: pins.get(w.id) ?? [],
  }));
  return {
    ok: true,
    value: {
      base: pairs.value.base,
      status,
      workspaces,
      workspacesNextCursor: page.value.nextCursor,
      overlap: pairs.value,
      arenas: { arenas: arenas.value.arenas, nextCursor: arenas.value.nextCursor },
    },
  };
}
