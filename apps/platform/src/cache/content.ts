/**
 * Immutable file bodies at a commit SHA, reused across requests for any repo
 * visibility. Keys carry the repo's internal id, never owner/name or the
 * request URL, so a renamed or deleted-and-recreated repo cannot alias
 * another repo's entry.
 *
 * Callers must have authorized the request through resolveRepoAccess first:
 * this module neither checks access nor is ever reached by a denied request,
 * so nothing is stored or served for one.
 */

import type { RepoRow } from '../db/repos';
import { readFileAt, isCommitRef } from '../artifacts/repo';
import { markCache } from '../cost/meter';

const IMMUTABLE_TTL_SECONDS = 31536000;

/** The path travels in the query so dot segments are never URL-normalized. */
export function contentCacheKey(repoId: string, sha: string, path: string): Request {
  const url = new URL('https://forge.internal/content/v1/file');
  url.searchParams.set('repo', repoId);
  url.searchParams.set('sha', sha);
  url.searchParams.set('path', path);
  return new Request(url.toString(), { method: 'GET' });
}

/**
 * File at (ref, path). Commit-SHA refs are served from and stored into the
 * repo-scoped content cache; other refs always read Artifacts.
 */
export async function readFileImmutable(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repo: RepoRow,
  ref: string,
  path: string,
): Promise<Blob | null> {
  if (!isCommitRef(ref)) return readFileAt(env, repo.artifacts_name, ref, path);
  const key = contentCacheKey(repo.id, ref, path);
  const hit = await caches.default.match(key);
  if (hit) {
    markCache('hit');
    return new Blob([await hit.arrayBuffer()], { type: hit.headers.get('content-type') ?? '' });
  }
  markCache('miss');
  const blob = await readFileAt(env, repo.artifacts_name, ref, path);
  if (blob) {
    // Stored under the internal host, which no client request can address;
    // the max-age only tells the Cache API how long to keep the entry.
    const stored = new Response(blob, {
      headers: {
        'content-type': blob.type || 'application/octet-stream',
        'cache-control': `max-age=${IMMUTABLE_TTL_SECONDS}, immutable`,
      },
    });
    ctx.waitUntil(caches.default.put(key, stored).catch(() => undefined));
  }
  return blob;
}
