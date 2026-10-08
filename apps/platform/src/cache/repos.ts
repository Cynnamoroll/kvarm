/**
 * Cache API copy of repo rows keyed by owner/name. Only found rows are
 * cached. Repo updates and deletes purge the local entry; private and write
 * decisions re-read the row from D1 regardless (services/access.ts).
 */

import type { RepoRow } from '../db/repos';
import { deleteCached, internalKey, readCachedJson, writeCachedJson } from './internal';

export const REPO_CACHE_TTL_SECONDS = 60;

function repoCacheKey(owner: string, name: string): Request {
  return internalKey('repo', owner, name);
}

export function readRepoCache(owner: string, name: string): Promise<RepoRow | undefined> {
  return readCachedJson<RepoRow>(repoCacheKey(owner, name));
}

export function writeRepoCache(row: RepoRow): Promise<void> {
  return writeCachedJson(repoCacheKey(row.owner_login, row.name), row, REPO_CACHE_TTL_SECONDS);
}

export function purgeRepoCache(owner: string, name: string): Promise<void> {
  return deleteCached(repoCacheKey(owner, name));
}
