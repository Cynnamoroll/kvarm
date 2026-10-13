/**
 * Push-side fast path (architecture §11.5).
 *
 * The git gate sees a push confirmed in the receive-pack reply itself, while
 * the Artifacts push event takes seconds to reach the queue consumer. The
 * fast path starts the latency-critical head hooks — the guard verdict and
 * the CI dispatch, plus the queued entry's head move and its train kick —
 * in the push request's own background work, so an agent polling for its
 * verdict sees it in about a second instead of after the event.
 *
 * The Artifacts event stays the reliable path and the single audit record
 * (no push_events row is written here); everything the fast path does is
 * idempotent with the event's effects:
 *
 *  - the head move is a compare-and-swap from the pushed `before` position,
 *    so a newer writer is never overwritten and a change whose head sits
 *    elsewhere is left to the event path (whose ingest moves heads to the
 *    recorded ref position, whatever this did);
 *  - the hooks are exactly HEAD_MOVED_HOOKS, which are per-effect idempotent:
 *    the guard records one run per (change, head), CI queues rows keyed by
 *    (change, head, job name) with ON CONFLICT DO NOTHING, and the queued
 *    entry's head move is fenced by the entry's own generation.
 *
 * Ref creations and deletions are left to the event path: a deleted ref has
 * no position to move heads to, and a created branch cannot yet be a live
 * change's head branch. A push to a branch no live change uses costs one D1
 * batch here and dispatches nothing.
 */

import { isZeroOid, type RefCommand } from '@kvarm/gitops';
import { HEAD_MOVED_HOOKS, type ChangeOnRef } from './changes';
import { parseChanges } from './events';

const BRANCH_PREFIX = 'refs/heads/';

/** Live changes the fast path acts on per pushed branch; the rest wait for the event path. */
export const FAST_PATH_CHANGE_LIMIT = 20;

/** One confirmed branch update of a push, as the gate read it from the command list. */
export interface ConfirmedPushUpdate {
  ref: string;
  before: string;
  after: string;
}

/** The branch updates of a push the fast path can act on: confirmed, non-create, non-delete. */
export function branchPushUpdates(commands: readonly RefCommand[], confirmed: readonly string[]): ConfirmedPushUpdate[] {
  const ok = new Set(confirmed);
  const out: ConfirmedPushUpdate[] = [];
  for (const cmd of commands) {
    if (!ok.has(cmd.ref)) continue;
    if (!cmd.ref.startsWith(BRANCH_PREFIX)) continue;
    if (isZeroOid(cmd.oldOid) || isZeroOid(cmd.newOid)) continue;
    out.push({ ref: cmd.ref, before: cmd.oldOid, after: cmd.newOid });
  }
  return out;
}

/**
 * Runs the head-moved hooks for every live change now at each pushed commit.
 * One D1 batch per pushed branch moves the heads and reads the changes back;
 * the hooks then run in the event path's order (the guard first).
 */
export async function dispatchConfirmedPush(env: Env, repoId: string, updates: readonly ConfirmedPushUpdate[]): Promise<void> {
  const started = Date.now();
  for (const u of updates) {
    const branch = u.ref.slice(BRANCH_PREFIX.length);
    // Only head_sha moves: head_event_at stays with the Artifacts event times
    // that order the event path's refresh, so heads keep converging to the
    // newest ref position no matter how this write and a delivery interleave.
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE change_sets SET head_sha = ?4, updated_at = ?5
          WHERE repo_id = ?1 AND head_ref = ?2 AND state IN ('open', 'conflicted') AND head_sha = ?3`,
      ).bind(repoId, branch, u.before, u.after, Date.now()),
      env.DB.prepare(
        `SELECT json_group_array(json_object('id', c.id, 'number', c.number, 'state', c.state, 'policy', c.merge_policy,
                  'headSha', c.head_sha,
                  'queuedHead', (SELECT q.head_sha FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1)))
                  AS changes
           FROM (SELECT c.* FROM change_sets c
                  WHERE c.repo_id = ?1 AND c.head_ref = ?2 AND c.state IN ('open', 'conflicted') AND c.head_sha = ?3
                  ORDER BY c.number LIMIT ${FAST_PATH_CHANGE_LIMIT}) c`,
      ).bind(repoId, branch, u.after),
    ]);
    const json = (results[1]?.results as Array<{ changes: string | null }> | undefined)?.[0]?.changes ?? null;
    const changes: ChangeOnRef[] = parseChanges(json);
    if (changes.length === 0) continue;
    for (const change of changes) {
      for (const hook of HEAD_MOVED_HOOKS) await hook({ env, repoId, change, headSha: u.after });
    }
    console.log(
      JSON.stringify({
        pushFastPath: { repo: repoId, ref: u.ref, heads: changes.map((c) => `#${c.number}`).join(','), ms: Date.now() - started },
      }),
    );
  }
}
