import type { RepoRow } from '../db/repos';
import { compare, type CompareResult, type CompareRequest } from './compare';
import type { ServiceResult } from '../repos/service';

export interface ChangeDiffTarget {
  base: string;
}

export function compareChange(
  env: Env,
  repo: RepoRow,
  change: ChangeDiffTarget,
  headSha: string,
  waitUntil: (promise: Promise<unknown>) => void = () => undefined,
): Promise<ServiceResult<CompareResult>> {
  const request: CompareRequest = { env, repo, bypass: false, waitUntil };
  return compare(request, change.base, headSha, { order: 'path', limit: '100' });
}
