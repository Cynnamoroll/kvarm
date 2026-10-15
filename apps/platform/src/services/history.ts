/**
 * Path history service (architecture §11.10): validate the request, resolve
 * the cached default-branch head, and delegate indexing and reads to the
 * repository's PathHistory Durable Object.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { LazyRepo } from '../artifacts/repo';
import { resolveCtx } from './changes';
import { RefStoreUnavailable, resolveCommitish } from './refs';

export const HISTORY_LIMITS = {
  pageDefault: 30,
  pageMax: 100,
  maxPathBytes: 4096,
} as const;

export interface HistoryEntry {
  sha: string;
  status: string;
  author: { name: string; email: string };
  committedAt: string;
  summary: string;
}

export interface HistoryView {
  path: string;
  ref: string;
  headSha: string | null;
  commits: HistoryEntry[];
  nextCursor: string | null;
  index: {
    epoch: number;
    indexedHead: string | null;
    current: boolean;
    rootReached: boolean;
    gaps: number;
    complete: boolean;
    progressed: boolean;
  };
}

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });

function encodeCursor(epoch: number, seq: number): string {
  return btoa(`${epoch}:${seq}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): { epoch: number; seq: number } | null {
  try {
    const match = /^(\d{1,9}):(-?\d{1,15})$/.exec(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    return match ? { epoch: Number(match[1]), seq: Number(match[2]) } : null;
  } catch {
    return null;
  }
}

export async function pathHistory(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  repo: RepoRow,
  q: { path?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<HistoryView>> {
  const path = q.path ?? '';
  if (path.length === 0 || path.includes('\0') || new TextEncoder().encode(path).length > HISTORY_LIMITS.maxPathBytes) {
    return fail(400, `path must be a non-empty repository path of at most ${HISTORY_LIMITS.maxPathBytes} bytes`, 'INVALID_PATH');
  }
  let limit: number = HISTORY_LIMITS.pageDefault;
  if (q.limit !== undefined) {
    limit = /^\d{1,4}$/.test(q.limit) ? Number(q.limit) : 0;
    if (limit < 1 || limit > HISTORY_LIMITS.pageMax) return fail(400, `limit must be an integer from 1 to ${HISTORY_LIMITS.pageMax}`, 'INVALID_LIMIT');
  }
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && !cursor) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
  const ref = `refs/heads/${repo.default_branch}`;
  const artifacts = new LazyRepo(env, repo.artifacts_name);
  let cachedHead: string | null;
  try {
    const ctx = resolveCtx({ env, repo, waitUntil }, artifacts);
    cachedHead = (await resolveCommitish(ctx, [ref])).get(ref)?.sha ?? null;
  } catch (err) {
    if (!(err instanceof RefStoreUnavailable)) throw err;
    console.warn(JSON.stringify({ historyRefStore: err.message.slice(0, 200) }));
    return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
  } finally {
    await artifacts.dispose();
  }
  try {
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    const result = await stub.query({ repoId: repo.id, repoName: repo.artifacts_name, ref, path, limit, cursor, cachedHead });
    if (!result.ok) return fail(result.status ?? 503, result.error ?? 'repository storage is unavailable, retry shortly', result.code ?? 'STORAGE_UNAVAILABLE');
    const value = result.value!;
    return {
      ok: true,
      value: {
        path: value.path,
        ref: value.ref,
        headSha: value.headSha,
        commits: value.commits,
        nextCursor: value.nextCursor ? encodeCursor(value.nextCursor.epoch, value.nextCursor.seq) : null,
        index: value.index,
      },
    };
  } catch (err) {
    console.warn(JSON.stringify({ historyDo: String(err).slice(0, 200) }));
    return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
  }
}
