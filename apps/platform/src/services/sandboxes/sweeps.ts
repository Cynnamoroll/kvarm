import { requestEnvironmentBuild } from '../environments';
import { sandboxProvider } from './provider';

const BATCH_SIZE = 50;

export async function handleFleetScheduled(env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(runFleetSweeps(env));
}

export async function runFleetSweeps(env: Env): Promise<void> {
  const now = Date.now();
  const aged = await env.DB.prepare(
    `SELECT e.id FROM environments e JOIN environment_builds b ON b.id = e.ready_build_id
      WHERE e.archived_at IS NULL AND b.status = 'ready'
        AND b.created_at < ?1 - e.max_build_age_hours * 3600000
      ORDER BY b.created_at LIMIT ?2`,
  )
    .bind(now, BATCH_SIZE)
    .all<{ id: string }>();
  for (const row of aged.results ?? []) {
    const requested = await requestEnvironmentBuild(env, row.id, 'age');
    if (!requested.ok && requested.code !== 'BUILD_NOT_QUEUED') {
      console.warn(JSON.stringify({ fleetSweep: 'age', environmentId: row.id, error: requested.error }));
    }
  }

  const retry = await env.DB.prepare(
    `SELECT e.id, b.attempt, b.finished_at FROM environments e
      JOIN environment_builds b ON b.environment_id = e.id
      WHERE e.archived_at IS NULL AND b.status = 'failed'
        AND b.seq = (SELECT MAX(latest.seq) FROM environment_builds latest WHERE latest.environment_id = e.id)
        AND b.finished_at <= ?1 - CASE WHEN b.attempt >= 5 THEN 24 ELSE (1 << MIN(b.attempt, 4)) END * 3600000
      ORDER BY b.finished_at LIMIT ?2`,
  )
    .bind(now, BATCH_SIZE)
    .all<{ id: string; attempt: number }>();
  for (const row of retry.results ?? []) {
    const requested = await requestEnvironmentBuild(env, row.id, 'retry');
    if (!requested.ok && requested.code !== 'BUILD_NOT_QUEUED') {
      console.warn(JSON.stringify({ fleetSweep: 'retry', environmentId: row.id, error: requested.error }));
    }
  }

  const expired = await env.DB.prepare(
    `SELECT * FROM sandboxes WHERE status IN ('starting','running','sleeping') AND expires_at <= ?1
      ORDER BY expires_at LIMIT ?2`,
  )
    .bind(now, BATCH_SIZE)
    .all<{ id: string; status: string; token_id: string | null }>();
  for (const row of expired.results ?? []) {
    const discarded = await sandboxProvider('linux')?.agentSandbox(env, row.id).discard();
    if (discarded && typeof discarded === 'object' && 'ok' in discarded && discarded.ok === false) {
      const failure = discarded as { error?: string };
      console.warn(JSON.stringify({ fleetSweep: 'discard', sandboxId: row.id, error: failure.error }));
    }
  }

  const endedRuns = await env.DB.prepare(
    `SELECT id FROM sandboxes WHERE status = 'running' AND run_expires_at <= ?1
      ORDER BY run_expires_at LIMIT ?2`,
  )
    .bind(now, BATCH_SIZE)
    .all<{ id: string }>();
  for (const row of endedRuns.results ?? []) {
    const slept = await sandboxProvider('linux')?.agentSandbox(env, row.id).sleep();
    if (slept && typeof slept === 'object' && 'ok' in slept && slept.ok === false) {
      const failure = slept as { error?: string };
      console.warn(JSON.stringify({ fleetSweep: 'sleep', sandboxId: row.id, error: failure.error }));
    }
  }
}
