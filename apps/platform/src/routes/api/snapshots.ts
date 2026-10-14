/**
 * Snapshot routes under /api/v1/repos/:owner/:repo. Thin adapters over
 * services/snapshots.ts; the shared authority lookup runs before any ref
 * resolution, cache lookup, D1 row or R2 read, so a repo that turned private
 * is concealed (404) from then on.
 *
 *   GET  snapshots/:ref            metadata: 200 ready, 202 building/absent, 409 failed, 404 unknown
 *   GET  snapshots/:ref/download   the tarball: a repo-scoped Cache API hit for the commit
 *                                  (no snapshot row, no R2), else streamed from R2 (one
 *                                  class-B read) and stored in the cache in step
 *   POST snapshots/:ref            explicit demand (checkout/CI): builds a missing snapshot
 *
 * `:ref` is a branch, tag or full commit SHA and may contain "/". A trailing
 * "/download" always selects the download; a ref whose name ends in
 * "/download" is reachable by its SHA.
 */

import { Hono, type Context } from 'hono';
import { actorJson, authorizeRoute, denyJson, type App } from '../api';
import { withLazyRepo } from '../../artifacts/repo';
import { matchSnapshot, zstdToTar } from '../../cache/snapshot';
import type { RepoRow } from '../../db/repos';
import { isFullSha, type ResolveContext } from '../../services/refs';
import {
  RefStoreUnavailable,
  commitExists,
  demandSnapshot,
  downloadSnapshot,
  readSnapshot,
  resolveSnapshotRef,
  snapshotView,
  type StoredSnapshot,
} from '../../services/snapshots';

export const snapshotsApi = new Hono<App>();

const PREFIX = /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/snapshots\/(.+)$/;
const DOWNLOAD = '/download';

function parseRef(c: Context<App>): { ref: string; download: boolean } | null {
  const m = PREFIX.exec(new URL(c.req.url).pathname);
  if (!m) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(m[3]!);
  } catch {
    return null;
  }
  if (rest.endsWith(DOWNLOAD)) return { ref: rest.slice(0, -DOWNLOAD.length), download: true };
  return { ref: rest, download: false };
}

function notFound(c: Context<App>): Response {
  return c.json({ error: 'snapshot not found', code: 'NOT_FOUND' }, 404);
}

function unavailable(c: Context<App>): Response {
  return c.json({ error: 'ref store unavailable', code: 'UPSTREAM_UNAVAILABLE' }, 503);
}

function demandPath(repo: RepoRow, ref: string): string {
  return `/api/v1/repos/${repo.owner_login}/${repo.name}/snapshots/${ref}`;
}

/** Does the request's Accept header admit the stored zstd representation (q > 0)? */
export function acceptsZstd(header: string | null | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(',')) {
    const [type, ...params] = part.split(';');
    if (type?.trim().toLowerCase() !== 'application/zstd') continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q > 0) return true;
  }
  return false;
}

function resolveContext(c: Context<App>, repo: RepoRow, artifacts: ResolveContext['artifacts']): ResolveContext {
  return { env: c.env, repo, artifacts, bypass: false, waitUntil: (p) => c.executionCtx.waitUntil(p) };
}

snapshotsApi.get('/repos/:owner/:repo/snapshots/*', async (c) => {
  const d = await authorizeRoute(c, 'read');
  if (!d.ok) return denyJson(c, d);
  const parsed = parseRef(c);
  if (!parsed || parsed.ref.length === 0) return notFound(c);
  const repo = d.repo;

  return withLazyRepo(c.env, repo.artifacts_name, async (artifacts) => {
    const ctx = resolveContext(c, repo, artifacts);
    let sha: string | null;
    try {
      sha = await resolveSnapshotRef(ctx, parsed.ref);
    } catch (err) {
      if (err instanceof RefStoreUnavailable) return unavailable(c);
      throw err;
    }
    if (!sha) return notFound(c);
    if (parsed.download) {
      const wantsZstd = acceptsZstd(c.req.header('accept'));
      const cached = await matchSnapshot(repo.id, sha);
      if (cached) return downloadResponse(c, repo, sha, cached, wantsZstd);
    }
    const row = await readSnapshot(c.env, repo.id, sha);
    if (!row && isFullSha(parsed.ref) && !(await commitExists(ctx, sha))) return notFound(c);

    if (!parsed.download) {
      const view = snapshotView(parsed.ref, sha, row, demandPath(repo, parsed.ref));
      return actorJson(c, view.body, view.status);
    }
    const dl = await downloadSnapshot(c.env, c.executionCtx, repo.id, sha, row);
    if (!dl.ok) {
      return dl.code === 'SNAPSHOT_NOT_READY'
        ? c.json({ error: dl.error, code: dl.code, state: dl.state, sha }, 409)
        : c.json({ error: dl.error, code: dl.code, sha }, 409);
    }
    return downloadResponse(c, repo, sha, dl.stored, acceptsZstd(c.req.header('accept')));
  });
});

/**
 * Serves the stored representation as-is to a zstd-capable client,
 * decompresses it for one that is not, and passes identity objects through.
 * `x-kvarm-snapshot-encoding` names the representation sent.
 */
function downloadResponse(
  c: Context<App>,
  repo: RepoRow,
  sha: string,
  stored: StoredSnapshot,
  wantsZstd: boolean,
): Response {
  const zstd = stored.encoding === 'zstd' && wantsZstd;
  const body = stored.encoding === 'zstd' && !wantsZstd ? zstdToTar(stored.body, stored.tarSize) : stored.body;
  const res = new Response(body, {
    headers: {
      'content-type': zstd ? 'application/zstd' : 'application/x-tar',
      'content-length': String(zstd ? stored.size : stored.tarSize),
      'content-disposition': `attachment; filename="${repo.name}-${sha.slice(0, 12)}.tar${zstd ? '.zst' : ''}"`,
      etag: zstd ? `"${stored.tree}.zst"` : `"${stored.tree}"`,
      vary: 'accept',
      'cache-control': 'no-store',
      'x-kvarm-snapshot-sha': sha,
      'x-kvarm-snapshot-encoding': zstd ? 'zstd' : 'identity',
    },
  });
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
}

snapshotsApi.post('/repos/:owner/:repo/snapshots/*', async (c) => {
  // Demand starts background work, so it needs an identified caller (a
  // person or an agent/CI token) with read access.
  const d = await authorizeRoute(c, 'read', { requireActor: true, allowAgent: true });
  if (!d.ok) return denyJson(c, d);
  const parsed = parseRef(c);
  if (!parsed || parsed.download || parsed.ref.length === 0) return notFound(c);
  const repo = d.repo;

  return withLazyRepo(c.env, repo.artifacts_name, async (artifacts) => {
    const ctx = resolveContext(c, repo, artifacts);
    let sha: string | null;
    try {
      sha = await resolveSnapshotRef(ctx, parsed.ref, { fresh: true });
    } catch (err) {
      if (err instanceof RefStoreUnavailable) return unavailable(c);
      throw err;
    }
    if (!sha) return notFound(c);
    if (isFullSha(parsed.ref) && !(await commitExists(ctx, sha))) return notFound(c);
    const { row, started, startError } = await demandSnapshot(c.env, repo.id, sha);
    if (startError) {
      return actorJson(c, { ref: parsed.ref, sha, error: startError, code: 'SNAPSHOT_START_FAILED', started: false }, 503);
    }
    const view = snapshotView(parsed.ref, sha, row, demandPath(repo, parsed.ref));
    return actorJson(c, { ...view.body, started: started !== null }, view.status);
  });
});
