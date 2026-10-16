import { purgeGitTokens } from '../artifacts/tokens';

export interface RepoPurgeTombstone {
  repo_id: string;
  artifacts_name: string;
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
const KEY_DELETE_BATCH = 100;
const MAX_PREFIX_PAGES = 10;
const MAX_SNAPSHOT_BATCHES = 10;
const PREFIXES = ['trees/v1/', 'trees/v2/', 'trees/v3/', 'replica/', 'fetch/', 'bundles/'] as const;

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

async function deleteSnapshotKeys(env: Env, repoId: string, maxBatches: number): Promise<void> {
  let batches = 0;
  while (batches < maxBatches) {
    const rows = await env.DB.prepare(
      'SELECT "key" FROM repo_purge_keys WHERE repo_id = ? ORDER BY "key" LIMIT ?',
    ).bind(repoId, PURGE_BATCH).all<{ key: string }>();
    const keys = rows.results?.map((row) => row.key) ?? [];
    if (keys.length === 0) return;
    await env.SNAPSHOTS.delete(keys);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < keys.length; i += KEY_DELETE_BATCH) {
      const batch = keys.slice(i, i + KEY_DELETE_BATCH);
      statements.push(
        env.DB.prepare(
          `DELETE FROM repo_purge_keys WHERE repo_id = ? AND "key" IN (${batch.map(() => '?').join(', ')})`,
        ).bind(repoId, ...batch),
      );
    }
    await env.DB.batch(statements);
    batches++;
  }
  const remaining = await env.DB.prepare('SELECT 1 AS pending FROM repo_purge_keys WHERE repo_id = ? LIMIT 1')
    .bind(repoId).first();
  if (remaining) throw new Error('snapshot batch limit');
}

function errorLabel(error: unknown): string {
  const name = error instanceof Error && error.name ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.slice(0, 120).replace(/[A-Za-z0-9_-]{24,}/g, '…');
  return `${name}:${message}`;
}

async function artifactsNameIsCurrent(env: Env, tombstone: RepoPurgeTombstone, step: string): Promise<boolean> {
  const current = await env.DB.prepare('SELECT 1 AS active FROM repos WHERE artifacts_name = ? LIMIT 1')
    .bind(tombstone.artifacts_name)
    .first();
  if (!current) return false;
  console.log(JSON.stringify({ step, repoId: tombstone.repo_id, status: 'superseded' }));
  return true;
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
        if (await artifactsNameIsCurrent(env, tombstone, 'artifacts')) return;
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
    {
      name: 'mirror',
      async run() {
        await env.REPO_MIRROR.get(env.REPO_MIRROR.idFromName(tombstone.repo_id)).destroy(tombstone.repo_id);
      },
    },
    {
      name: 'tokens',
      async run() {
        if (await artifactsNameIsCurrent(env, tombstone, 'tokens')) return;
        await purgeGitTokens(tombstone.artifacts_name);
      },
    },
    {
      name: 'snapshots',
      run: () => deleteSnapshotKeys(env, tombstone.repo_id, maxSnapshotBatches),
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
    await env.DB.prepare(
      'UPDATE repo_purges SET done_at = ?, last_error = NULL WHERE repo_id = ? AND done_at IS NULL',
    )
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
      WHERE repo_id = ? AND done_at IS NULL`,
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
      const result = await purgeRepo(env, row, { maxPrefixPages: 1 });
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
