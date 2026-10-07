/**
 * Fixed-window rate limiting in a DO. Fails open if the DO is unavailable:
 * availability of git operations beats strict enforcement here, and the
 * hardware-protection goal is about bounding abuse, not hard guarantees.
 */

export async function rateLimit(
  env: Env,
  key: string,
  limit: number,
  windowMs = 60_000,
): Promise<boolean> {
  const id = env.RATE_LIMIT.idFromName(key.slice(0, 128));
  const stub = env.RATE_LIMIT.get(id);
  try {
    const res = await stub.fetch('https://rate-limit/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, limit, windowMs }),
    });
    if (!res.ok) return true;
    const body = (await res.json()) as { allowed: boolean };
    return body.allowed;
  } catch {
    return true;
  }
}
