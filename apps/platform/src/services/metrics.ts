type MetricsEnv = Pick<Env, 'KVARM_METRICS'>;

export function recordMirrorCompare(
  env: MetricsEnv,
  repoId: string,
  kind: 'adv' | 'ls-refs',
  outcome: 'match' | 'mismatch' | 'error',
  reason: string,
): void {
  try {
    env.KVARM_METRICS?.writeDataPoint({
      indexes: [repoId],
      blobs: ['mirror_compare', repoId, kind, outcome, reason.slice(0, 256)],
      doubles: [1],
    });
  } catch {
    // Metrics must not affect request handling.
  }
}

export function recordReceivePack(
  env: MetricsEnv,
  repoId: string,
  outcome: 'ok' | 'busy_exhausted' | 'not_retryable' | 'error',
  retries: number,
  attempts: number,
): void {
  try {
    env.KVARM_METRICS?.writeDataPoint({
      indexes: [repoId],
      blobs: ['receive_pack', repoId, outcome],
      doubles: [retries, attempts],
    });
  } catch {
    // Metrics must not affect request handling.
  }
}
