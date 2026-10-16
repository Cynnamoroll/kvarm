/**
 * Per-request rate limiting on the Workers Rate Limiting bindings (per-colo
 * counters, no Durable Object round trip). Limits live in wrangler.jsonc:
 *   READ_LIMITER  600/min  git reads
 *   WRITE_LIMITER 120/min  git writes; failed-auth preauth throttling
 * Fails open when a binding is missing or errors: availability of git beats
 * strict enforcement, and the goal is bounding abuse, not exact quotas.
 */

export type RateLimitReason = 'git-read' | 'git-write' | 'preauth';

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key: key.slice(0, 256) });
    return success;
  } catch {
    return true;
  }
}

/** Git request budget per identity (PAT id, or client IP for anonymous reads). */
export async function gitRateLimit(env: Env, op: 'read' | 'write', identity: string): Promise<RateLimitReason | null> {
  const limiter = op === 'write' ? env.WRITE_LIMITER : env.READ_LIMITER;
  return (await allowed(limiter, `git:${op}:${identity}`)) ? null : op === 'read' ? 'git-read' : 'git-write';
}

/**
 * Bounds uncached PAT lookups per client IP so a stream of unknown tokens
 * cannot turn into unbounded D1 reads. Cached tokens never consume it.
 */
export async function preauthAllowed(env: Env, clientIp: string | null): Promise<RateLimitReason | null> {
  return (await allowed(env.WRITE_LIMITER, `preauth:${clientIp ?? 'unknown'}`)) ? null : 'preauth';
}

/** Incident webhook deliveries (services/incidents.ts) per repository and client IP, checked before the webhook lookup. */
export function incidentDeliveryAllowed(env: Env, repo: string, clientIp: string | null): Promise<boolean> {
  return allowed(env.WRITE_LIMITER, `incident:${repo}:${clientIp ?? 'unknown'}`);
}
