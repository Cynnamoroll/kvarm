/**
 * Cache API entries behind compare and per-file diffs (architecture §2.3).
 *
 *  - treediff/v2/<baseTree>/<headTree>   compare body for a tree pair (immutable)
 *  - risk/v1/<baseTree>/<headTree>       per-file risk + change rating for a tree pair (immutable)
 *  - filediff/v1/<oldBlob>/<newBlob>     per-file diff body for a blob pair (immutable)
 *  - numstat/v2/<oldBlob>/<newBlob>      line counts + content hints for a blob pair (immutable)
 *  - commit/v1?repo&sha                  commit -> {tree, parents}, repo-scoped (immutable)
 *  - ref/v1?repo&gen&name                ref name -> commit, short TTL, repo-scoped
 *  - refgen/v1?repo                      ref generation, replaced after a push
 *
 * Tree and blob pairs are content-addressed: anyone who can resolve the same
 * pair in some repo already has the same content, so those entries carry no
 * repo id. Callers must authorize the request (authorizeRoute) before any
 * read here; nothing in this module checks access.
 */

const ORIGIN = 'https://forge.internal';
const IMMUTABLE_TTL_SECONDS = 31536000;
/** Ref names move; the generation bump on push and this TTL bound staleness. */
export const REF_TTL_SECONDS = 30;

/** Placeholder for the missing side of an added or removed file. */
const NONE = '-';

function key(path: string, query?: Record<string, string>): Request {
  const url = new URL(`${ORIGIN}/${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  return new Request(url.toString(), { method: 'GET' });
}

export const compareKeys = {
  // v2: bodies carry real risk and blobReads; v1 bodies held the neutral placeholder.
  treediff: (baseTree: string, headTree: string) => key(`treediff/v2/${baseTree}/${headTree}`),
  risk: (baseTree: string, headTree: string) => key(`risk/v1/${baseTree}/${headTree}`),
  filediff: (oldBlob: string | null, newBlob: string | null) =>
    key(`filediff/v1/${oldBlob ?? NONE}/${newBlob ?? NONE}`),
  // v2 adds the whitespaceOnly/generated hints risk relies on.
  numstat: (oldBlob: string | null, newBlob: string | null) =>
    key(`numstat/v2/${oldBlob ?? NONE}/${newBlob ?? NONE}`),
  commit: (repoId: string, sha: string) => key('commit/v1', { repo: repoId, sha }),
  ref: (repoId: string, gen: string, name: string) => key('ref/v1', { repo: repoId, gen, name }),
  refgen: (repoId: string) => key('refgen/v1', { repo: repoId }),
};

export async function readJson<T>(k: Request): Promise<T | undefined> {
  try {
    const hit = await caches.default.match(k);
    if (!hit) return undefined;
    return (await hit.json()) as T;
  } catch {
    return undefined;
  }
}

/** Stores serialized JSON; returns the write so callers can hand it to waitUntil. */
export function writeJson(k: Request, body: string, ttlSeconds = IMMUTABLE_TTL_SECONDS): Promise<void> {
  const response = new Response(body, {
    headers: {
      'content-type': 'application/json',
      'cache-control': ttlSeconds === IMMUTABLE_TTL_SECONDS ? `max-age=${ttlSeconds}, immutable` : `max-age=${ttlSeconds}`,
    },
  });
  return caches.default.put(k, response).catch(() => undefined);
}

/** Current ref generation for a repo ("0" until the first push bump in this colo). */
export async function refGeneration(repoId: string): Promise<string> {
  try {
    const hit = await caches.default.match(compareKeys.refgen(repoId));
    if (hit) return await hit.text();
  } catch {
    // fall through to the default generation
  }
  return '0';
}

/**
 * Invalidates this colo's cached ref resolutions for a repo after a push by
 * moving to a new generation. Other colos converge within REF_TTL_SECONDS.
 */
export async function bumpRefGeneration(repoId: string): Promise<void> {
  try {
    await caches.default.put(
      compareKeys.refgen(repoId),
      new Response(crypto.randomUUID(), { headers: { 'cache-control': `max-age=${IMMUTABLE_TTL_SECONDS}` } }),
    );
  } catch {
    // best-effort; the ref TTL still bounds staleness
  }
}
