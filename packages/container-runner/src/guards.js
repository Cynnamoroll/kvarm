// @ts-check
/**
 * Small invariants several CLI modules rely on — a wire predicate, a
 * path-traversal guard and a config check where two copies must agree.
 * One definition each, so they cannot drift.
 */

import { CliError, parseRepo } from './checkout.js';

/** Tree modes as git reports them (raw entries are never padded). @param {string|null} mode */
export const isTreeMode = (mode) => mode === '40000' || mode === '040000';

/**
 * parseRepo plus the segment guard its callers kept vendoring: a `.`/`..`
 * name passes the character check but resolves outside the repository's
 * own directory or URL prefix.
 * @param {string} repo `owner/name`
 * @returns {{ owner: string, name: string }}
 */
export function parseRepoPath(repo) {
  const { owner, name } = parseRepo(repo);
  if (name === '.' || name === '..') throw new CliError(`invalid repository "${repo}", expected <owner>/<repo>`, 2);
  return { owner, name };
}

/**
 * KVARM_BASE_URL, required by every command that talks to the platform:
 * present and an http(s) URL, else a usage error.
 * @param {NodeJS.ProcessEnv} env
 */
export function requireBaseUrl(env) {
  const baseUrl = env.KVARM_BASE_URL;
  if (!baseUrl) throw new CliError('KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)', 2);
  if (!/^https?:\/\//.test(baseUrl)) throw new CliError(`KVARM_BASE_URL must be an http(s) URL, got "${baseUrl}"`, 2);
  return baseUrl;
}
