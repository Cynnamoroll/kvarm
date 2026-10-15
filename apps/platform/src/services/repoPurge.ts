import { purgeGitTokens } from '../artifacts/tokens';

export interface RepoPurgeTombstone {
  repo_id: string;
  artifacts_name: string;
  snapshot_keys: string;
  created_at: number;
  attempts: number;
  next_attempt_at: number;
  done_at: number | null;
  last_error: string | null;
}

export interface RepoPurgeResult {
  ok: boolean;
  error?: string;
}

const PURGE_BATCH = 1000;
const MAX_PREFIX_PAGES = 10;
const MAX_SNAPSHOT_BATCHES = Number.POSITIVE_INFINITY;
const PREFIXES = ['replica/', 'fetch/', 'bundles/'] as const;

async function deletePrefix(env: Env, prefix: string, maxPages: number): Promise<void> {
  let cursor: string | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const page = await env.SNAPSHOTS.list({ prefix, limit: PURGE_BATCH, ...(cursor ? { cursor } : {}) });
    for (let i = 0; i < page.objects.length; i += PURGE_BATCH) {
      await env.SNAPSHOTS.delete(page.objects.slice(i, i + PURGE_BATCH).map((object) => object.key));
    }
    if (!page.truncated) return;
    if (!page.cursor) throw new Error('page limit');
    cursor = page.cursor;
  }
  throw new Error('page limit');
}

function snapshotKeys(raw: string): string[] {
  const keys: unknown = JSON.parse(raw);
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string')) throw new Error('invalid snapshot keys');
  return keys;
}

function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

export async function purgeRepo(
  env: Env,
  tombstone: RepoPurgeTombstone,
  options: { maxPrefixPages?: number; maxSnapshotBatches?: number } = {},
): Promise<RepoPurgeResult> {
  const maxPrefixPages = options.maxPrefixPages ?? MAX_PREFIX_PAGES;
  const maxSnapshotBatches = options.maxSnapshotBatches ?? MAX_SNAPSHOT_BATCHES;
  const steps: { name: string; run: () => Promise<void> }[] = [
    {
      name: 'artifacts',
      async run() {
        try {
          await env.ARTIFACTS.delete(tombstone.artifacts_name);
        } catch (error) {
          if (!/not ?found|does not exist|no such/i.test(String(error))) throw error;
        }
      },
    },
    {
      name: 'path-history',
      async run() {
        await env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(tombstone.repo_id)).destroy();
      },
    },
    { name: 'tokens', run: () => purgeGitTokens(tombstone.artifacts_name) },
    {
      name: 'snapshots',
      async run() {
        const keys = snapshotKeys(tombstone.snapshot_keys);
        let batches = 0;
        for (let i = 0; i < keys.length; i += PURGE_BATCH) {
          if (batches >= maxSnapshotBatches) throw new Error('snapshot batch limit');
          await env.SNAPSHOTS.delete(keys.slice(i, i + PURGE_BATCH));
          batches++;
        }
      },
    },
    ...PREFIXES.map((prefix) => ({
      name: prefix,
      run: () => deletePrefix(env, `${prefix}${tombstone.repo_id}/`, maxPrefixPages),
    })),
  ];
  const errors: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      errors.push(`${step.name}:${errorLabel(error)}`);
    }
  }
  const now = Date.now();
  if (errors.length === 0) {
    await env.DB.prepare('UPDATE repo_purges SET done_at = ?, last_error = NULL WHERE repo_id = ?')
      .bind(now, tombstone.repo_id)
      .run();
    return { ok: true };
  }
  const attempts = tombstone.attempts + 1;
  const backoffMs = Math.min(3_600_000, 1000 * 2 ** Math.min(attempts - 1, 12));
  const lastError = errors.join(', ').slice(0, 500);
  await env.DB.prepare(
    `UPDATE repo_purges
        SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?, done_at = NULL
      WHERE repo_id = ?`,
  )
    .bind(now + backoffMs, lastError, tombstone.repo_id)
    .run();
  return { ok: false, error: lastError };
}

export async function purgeRepoById(env: Env, repoId: string): Promise<RepoPurgeResult> {
  const tombstone = await env.DB.prepare('SELECT * FROM repo_purges WHERE repo_id = ?')
    .bind(repoId)
    .first<RepoPurgeTombstone>();
  if (!tombstone || tombstone.done_at !== null) return { ok: true };
  return purgeRepo(env, tombstone);
}

export async function sweepRepoPurges(
  env: Env,
  options: { limit?: number; now?: number } = {},
): Promise<{ count: number; failed: number; pruned: number }> {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 25;
  const due = await env.DB.prepare(
    'SELECT * FROM repo_purges WHERE done_at IS NULL AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?',
  ).bind(now, limit).all<RepoPurgeTombstone>();
  const rows = due?.results ?? [];
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await purgeRepo(env, row);
      if (!result.ok) failed++;
    } catch {
      failed++;
    }
  }
  const pruned = await env.DB.prepare(
    'DELETE FROM repo_purges WHERE done_at IS NOT NULL AND done_at <= ?',
  ).bind(now - 7 * 24 * 60 * 60 * 1000).run();
  return { count: rows.length, failed, pruned: pruned.meta.changes ?? 0 };
}

export async function runRepoPurgeCron(env: Env): Promise<void> {
  try {
    const result = await sweepRepoPurges(env);
    const line = JSON.stringify({ cron: 'repoPurges', ...result });
    if (result.failed) console.error(line);
    else console.log(line);
  } catch (error) {
    console.error(JSON.stringify({ cron: 'repoPurges', error: errorLabel(error) }));
  }
}
