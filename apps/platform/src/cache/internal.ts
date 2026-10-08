/**
 * Small JSON entries in the Cache API under synthetic `https://forge.internal`
 * keys: PAT metadata, repo rows and upstream Artifacts tokens. The Cache API
 * is per colo, so deletes are local; callers that need authoritative answers
 * (revocation, private access) must still check D1.
 */

const ORIGIN = 'https://forge.internal';

export function internalKey(kind: string, ...parts: string[]): Request {
  const path = [kind, ...parts].map((p) => encodeURIComponent(p)).join('/');
  return new Request(`${ORIGIN}/${path}`, { method: 'GET' });
}

export async function readCachedJson<T>(key: Request): Promise<T | undefined> {
  try {
    const hit = await caches.default.match(key);
    if (!hit) return undefined;
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}

export async function writeCachedJson(key: Request, value: unknown, ttlSeconds: number): Promise<void> {
  const ttl = Math.floor(ttlSeconds);
  if (ttl <= 0) return;
  try {
    await caches.default.put(
      key,
      new Response(JSON.stringify(value), {
        headers: { 'content-type': 'application/json', 'cache-control': `max-age=${ttl}` },
      }),
    );
  } catch {
    // A failed cache write only costs a later D1 read.
  }
}

export async function deleteCached(key: Request): Promise<void> {
  try {
    await caches.default.delete(key);
  } catch {
    // best-effort
  }
}
