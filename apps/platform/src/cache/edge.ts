/**
 * Edge caching for public content. Only anonymous views are cached (signed-in
 * pages differ), keyed by URL plus, for mutable refs, the repo view
 * generation that a confirmed push moves (services/pushFreshness.ts).
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
 * Cache key for a page. `generation` is null for views pinned to a commit
 * SHA, which never change.
 */
export function pageCacheKey(request: Request, generation: string | null): Request {
  if (generation === null) return request;
  const url = new URL(request.url);
  url.searchParams.set('kvarm-gen', generation);
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * Serve a public page from cache when possible; otherwise render and store.
 * `render` is only called on misses.
 */
export async function edgeCachedPage<S extends AnyApp>(
  c: Context<S>,
  ttlSeconds: number,
  generation: string | null,
  render: () => Promise<Response>,
): Promise<Response> {
  if (!cacheableViewer(c)) return render();

  const cache = caches.default;
  const key = pageCacheKey(c.req.raw, generation);
  const cached = await cache.match(key);
  if (cached) {
    markCache('hit');
    const res = new Response(cached.body, cached);
    res.headers.set('x-kvarm-cache', 'hit');
    return res;
  }

  markCache('miss');
  const res = await render();
  if (res.status === 200) {
    const store = new Response(res.clone().body, res);
    store.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    store.headers.set('x-kvarm-cache', 'miss');
    c.executionCtx.waitUntil(
      cache.put(key, store).catch(() => undefined),
    );
  }
  return res;
}
