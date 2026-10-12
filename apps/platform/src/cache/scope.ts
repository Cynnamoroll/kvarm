/**
 * Shared-cache scope of responses. Content of a private repo, and anything
 * served to a presented credential, must never be stored by a browser-shared
 * or intermediary cache: those copies would outlive a revocation or a
 * visibility flip that the authoritative D1 lookup enforces on every request.
 */

export const PRIVATE_CACHE_CONTROL = 'private, no-store';

/** Session cookie or Authorization header, accepted or not. */
export function presentsCredential(request: Request): boolean {
  if (request.headers.has('Authorization')) return true;
  return request.headers.get('cookie')?.includes('wos-session') ?? false;
}

/** The response with a private Cache-Control, rebuilt when its headers are immutable. */
export function withPrivateCacheControl(res: Response): Response {
  if (res.webSocket || res.status === 101) return res;
  try {
    res.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    return res;
  } catch {
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', PRIVATE_CACHE_CONTROL);
    return out;
  }
}
