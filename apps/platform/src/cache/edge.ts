/**
 * Edge caching for public content. Only anonymous views are cached (signed-in
 * pages differ), keyed by URL. Push-event purges land with the event consumer
 * (M4); short TTLs keep the window small in the meantime.
 */

import type { Context } from 'hono';
import { markCache } from '../cost/meter';

/** Any app whose Variables satisfy the platform convention. */
type AnyApp = { Bindings: Env; Variables: Record<string, unknown> };

export function cacheableViewer<S extends AnyApp>(c: Context<S>): boolean {
  const cookie = c.req.header('cookie');
  return !cookie || !cookie.includes('wos-session');
}

/**
 * Serve a public page from cache when possible; otherwise render and store.
 * `render` is only called on misses.
 */
export async function edgeCachedPage<S extends AnyApp>(
  c: Context<S>,
  ttlSeconds: number,
  render: () => Promise<Response>,
): Promise<Response> {
  if (!cacheableViewer(c)) return render();

  const cache = caches.default;
  const cached = await cache.match(c.req.raw);
  if (cached) {
    markCache('hit');
    const res = new Response(cached.body, cached);
    res.headers.set('x-forge-cache', 'hit');
    return res;
  }

  markCache('miss');
  const res = await render();
  if (res.status === 200) {
    const store = new Response(res.clone().body, res);
    store.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    store.headers.set('x-forge-cache', 'miss');
    c.executionCtx.waitUntil(
      cache.put(c.req.raw, store).catch(() => undefined),
    );
  }
  return res;
}
