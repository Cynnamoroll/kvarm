import { parseJson } from './result';

/**
 * The platform-reserved agent workspace namespace (`refs/heads/agents/<id>/<slug>`).
 * Leaf constant: services/workspaces.ts is reachable from changes.ts, so
 * modules that would form a cycle take the prefix from here instead.
 */
export const WORKSPACE_REF_PREFIX = 'refs/heads/agents/';

/** The change_sets.agent_meta JSON reading shared by the change/CI/review views. */
export function agentMetaOf(meta: string | null): { id: string; name: string } | null {
  if (!meta) return null;
  const v = parseJson(meta, null as { agentId?: unknown; agentName?: unknown } | null);
  return v !== null && typeof v.agentId === 'string' && typeof v.agentName === 'string' ? { id: v.agentId, name: v.agentName } : null;
}
