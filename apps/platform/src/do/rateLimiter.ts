/** Fixed-window counters, in-memory per DO instance (resets on eviction). */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/check' && request.method === 'POST') {
      const { key, limit, windowMs } = (await request.json()) as {
        key: string;
        limit: number;
        windowMs?: number;
      };
      const window = windowMs ?? 60_000;
      const now = Date.now();
      let bucket = this.buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + window };
        this.buckets.set(key, bucket);
      }
      bucket.count++;
      if (this.buckets.size > 10_000) {
        for (const [k, v] of this.buckets) {
          if (v.resetAt <= now) this.buckets.delete(k);
        }
      }
      return Response.json({
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt,
      });
    }
    return new Response('not found', { status: 404 });
  }
}
