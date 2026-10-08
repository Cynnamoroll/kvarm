/**
 * Snapshot metadata, demand and download (architecture §11.5).
 *
 * A snapshot is addressed by commit: `snapshot_commits` holds per-commit
 * metadata and points at an immutable per-(repo, tree) tarball in
 * `snapshot_trees`/R2, so commits with identical trees share bytes. The
 * default branch builds eagerly on push (services/events.ts); every other ref
 * builds only on an explicit demand. Reading metadata never starts a build.
 *
 * Callers authorize first (authorizeRoute); nothing here checks access.
 */

import { RefStoreUnavailable, isFullSha, isValidRefName, lsRefs, readCommitInfo, type ResolveContext } from './refs';
import { REF_TTL_SECONDS, refGeneration } from '../cache/compare';
import { internalKey, readCachedJson, writeCachedJson } from '../cache/internal';
import { snapshotInstanceId } from './events';
import { STALE_BUILD_MS, type BuildCost, type SnapshotParams } from '../workflows/snapshotBuilder';

export { RefStoreUnavailable };

export type SnapshotState = 'absent' | 'building' | 'ready' | 'failed';

/** Instance id for a demand: the eager id first, then one per retry after a failure. */
export function demandInstanceId(repoId: string, sha: string, attempt: number): string {
  const base = snapshotInstanceId(repoId, sha);
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

function snapRefKey(repoId: string, gen: string, name: string): Request {
  return internalKey('snapref/v1', repoId, gen, name);
}

/**
 * A ref name or full SHA to a commit SHA, or null for an unknown ref. Names
 * resolve through ls-refs and are kept for REF_TTL_SECONDS under the repo's
 * ref generation (replaced by every push through the git gate); `fresh`
 * skips the cached answer. A full SHA is returned as is; callers that find
 * no snapshot row for it check that the commit exists.
 */
export async function resolveSnapshotRef(
  ctx: ResolveContext,
  ref: string,
  opts: { fresh?: boolean } = {},
): Promise<string | null> {
  if (isFullSha(ref)) return ref;
  if (!isValidRefName(ref)) return null;
  const gen = await refGeneration(ctx.repo.id);
  const key = snapRefKey(ctx.repo.id, gen, ref);
  if (!opts.fresh) {
    const hit = await readCachedJson<{ sha: string }>(key);
    if (hit) return hit.sha;
  }
  const sha = (await lsRefs(ctx, [ref])).get(ref) ?? null;
  if (sha) ctx.waitUntil(writeCachedJson(key, { sha }, REF_TTL_SECONDS));
  return sha;
}

export interface SnapshotRow {
  sha: string;
  tree: string | null;
  state: 'building' | 'ready' | 'failed';
  trigger: 'push' | 'demand';
  instance_id: string;
  attempt: number;
  reused: number;
  build_cost: string | null;
  error: string | null;
  requested_at: number;
  built_at: number | null;
  size: number | null;
  files: number | null;
  r2_key: string | null;
}

const ROW_SELECT = `SELECT c.sha, c.tree, c.state, c.trigger, c.instance_id, c.attempt, c.reused, c.build_cost, c.error,
         c.requested_at, c.built_at, t.size, t.files, t.r2_key
    FROM snapshot_commits c
    LEFT JOIN snapshot_trees t ON t.repo_id = c.repo_id AND t.tree = c.tree AND t.state = 'ready'
   WHERE c.repo_id = ?1 AND c.sha = ?2`;

/** The commit's snapshot row with its tarball, in one indexed query. */
export async function readSnapshot(env: Env, repoId: string, sha: string): Promise<SnapshotRow | null> {
  return env.DB.prepare(ROW_SELECT).bind(repoId, sha).first<SnapshotRow>();
}

/** True when a commit row is ready and its tarball row is too. */
export function isReady(row: SnapshotRow | null): row is SnapshotRow & { r2_key: string; size: number } {
  return row !== null && row.state === 'ready' && row.r2_key !== null && row.size !== null;
}

/** Does a full SHA name a commit in the repo? (commit cache, else one readCommit.) */
export async function commitExists(ctx: ResolveContext, sha: string): Promise<boolean> {
  return (await readCommitInfo(ctx, sha)) !== null;
}

export interface SnapshotView {
  status: 200 | 202 | 409;
  body: Record<string, unknown>;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function parseCost(raw: string | null): BuildCost | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BuildCost;
  } catch {
    return null;
  }
}

/**
 * The metadata response: 200 ready, 202 building (or `absent`: the ref
 * exists but no build was requested), 409 failed.
 */
export function snapshotView(ref: string, sha: string, row: SnapshotRow | null, demandPath: string): SnapshotView {
  if (!row) {
    return { status: 202, body: { ref, sha, state: 'absent', demand: `POST ${demandPath}` } };
  }
  const common = {
    ref,
    sha,
    tree: row.tree,
    trigger: row.trigger,
    requestedAt: iso(row.requested_at),
  };
  if (isReady(row)) {
    return {
      status: 200,
      body: {
        ...common,
        state: 'ready',
        size: row.size,
        files: row.files,
        builtAt: iso(row.built_at),
        reused: row.reused === 1,
        buildCost: parseCost(row.build_cost),
      },
    };
  }
  if (row.state === 'failed') {
    return {
      status: 409,
      body: { ...common, state: 'failed', error: row.error ?? 'snapshot build failed', code: 'SNAPSHOT_FAILED' },
    };
  }
  return { status: 202, body: { ...common, state: 'building' } };
}

/**
 * Records an explicit demand and starts a build when none is live: a new
 * commit, a failed build, or a build stuck past STALE_BUILD_MS. A live or
 * finished build is left alone. One D1 batch; at most one Workflow create.
 */
export async function demandSnapshot(
  env: Env,
  repoId: string,
  sha: string,
): Promise<{ row: SnapshotRow; started: string | null }> {
  const now = Date.now();
  const base = snapshotInstanceId(repoId, sha);
  const db = env.DB;
  const [upsert, read] = await db.batch([
    db
      .prepare(
        `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, attempt, requested_at)
         VALUES (?1, ?2, NULL, 'building', 'demand', ?3, 0, ?4)
         ON CONFLICT (repo_id, sha) DO UPDATE SET
           state = 'building', trigger = 'demand', attempt = snapshot_commits.attempt + 1,
           instance_id = ?3 || '-r' || (snapshot_commits.attempt + 1),
           requested_at = ?4, error = NULL, built_at = NULL
         WHERE snapshot_commits.state = 'failed'
            OR (snapshot_commits.state = 'building' AND snapshot_commits.requested_at < ?5)
         RETURNING instance_id`,
      )
      .bind(repoId, sha, base, now, now - STALE_BUILD_MS),
    db.prepare(ROW_SELECT).bind(repoId, sha),
  ]);
  const row = (read?.results as SnapshotRow[] | undefined)?.[0];
  if (!row) throw new Error('snapshot demand row missing');
  const started = (upsert?.results as { instance_id: string }[] | undefined)?.[0]?.instance_id ?? null;
  if (started) {
    const params: SnapshotParams = { repoId, sha, trigger: 'demand' };
    try {
      await env.SNAPSHOT_BUILDER.create({ id: started, params });
    } catch (err) {
      // The eager push build may already own the base id; it is the same build.
      const exists = await env.SNAPSHOT_BUILDER.get(started).then(
        () => true,
        () => false,
      );
      if (!exists) throw err;
    }
  }
  return { row, started };
}

/** Removes a deleted repo's snapshot rows and tarballs (bounded: up to 10,000 objects). */
export async function deleteRepoSnapshots(env: Env, repoId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM snapshot_commits WHERE repo_id = ?').bind(repoId),
    env.DB.prepare('DELETE FROM snapshot_trees WHERE repo_id = ?').bind(repoId),
  ]);
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const list = await env.SNAPSHOTS.list({ prefix: `trees/v1/${repoId}/`, cursor, limit: 1000 });
    if (list.objects.length > 0) await env.SNAPSHOTS.delete(list.objects.map((o) => o.key));
    if (!list.truncated) return;
    cursor = list.cursor;
  }
}
