/**
 * Credential + repository resolution with cost-aware caching, in front of the
 * shared policy in services/authz.ts.
 *
 * Cache use is deliberately asymmetric (architecture §10, §11.1):
 *  - Public repo reads may be decided from Cache API copies of the PAT and
 *    repo row (0 D1 when warm). Public content is readable anonymously, so a
 *    stale credential there discloses nothing.
 *  - Everything else (private repos, writes, routes that need an actor) is
 *    decided on an authoritative D1 read of the PAT and repo row, issued as a
 *    single batch. A revoked or expired PAT therefore fails on the next such
 *    request in every colo, not only where its cache entry was deleted.
 *  - Uncached PAT lookups pass a per-IP preauth throttle first, and rejected
 *    hashes are cached, so unknown tokens cannot amplify into D1 reads.
 */

import {
  PAT_PATTERN,
  patFromRow,
  patHash,
  patNeedsStamp,
  patSelect,
  patStamp,
  readPatCache,
  scopesAllow,
  writePatCache,
  type PATInfo,
  type PatRow,
} from '../auth/pat';
import type { RepoRow } from '../db/repos';
import { readRepoCache, writeRepoCache } from '../cache/repos';
import { preauthAllowed } from '../ratelimit';
import {
  authorizeRepo,
  patActor,
  type Actor,
  type AuthzDenyCode,
  type RepoNeed,
  type RepoRole,
  type Transport,
} from './authz';

export type Credential =
  | { kind: 'anonymous' }
  | { kind: 'pat'; token: string }
  | { kind: 'session'; actor: Actor };

export type AccessDenyCode = AuthzDenyCode | 'RATE_LIMITED';

export interface AccessDenied {
  ok: false;
  status: 401 | 403 | 404 | 429;
  error: string;
  code: AccessDenyCode;
  /** The presented credential itself was rejected (unknown, revoked or expired). */
  badCredential?: true;
}

export type PrincipalResult = { ok: true; pat: PATInfo } | AccessDenied;

export type RepoAccess = { ok: true; repo: RepoRow; actor: Actor | null; role: RepoRole } | AccessDenied;

export interface RepoAccessRequest {
  owner: string;
  name: string;
  need: RepoNeed;
  transport: Transport;
  credential: Credential;
  clientIp: string | null;
  /** The route needs an authenticated actor even for reads (e.g. forking). */
  requireActor?: boolean;
}

const BAD_CREDENTIAL: AccessDenied = {
  ok: false,
  status: 401,
  error: 'unauthorized',
  code: 'UNAUTHENTICATED',
  badCredential: true,
};

const NO_ACTOR: AccessDenied = { ok: false, status: 401, error: 'unauthorized', code: 'UNAUTHENTICATED' };

const RATE_LIMITED: AccessDenied = { ok: false, status: 429, error: 'rate limited', code: 'RATE_LIMITED' };

/** Non-api PATs act as anonymous callers on REST and pages. */
function actorFor(transport: Transport, pat: PATInfo | null | undefined): Actor | null {
  if (!pat) return null;
  if (transport !== 'git' && !scopesAllow(pat.scopes, 'api')) return null;
  return patActor(pat);
}

async function decide(
  env: Env,
  repo: RepoRow | null,
  actor: Actor | null,
  req: RepoAccessRequest,
): Promise<RepoAccess> {
  if (req.requireActor && !actor) return NO_ACTOR;
  const d = await authorizeRepo(env, repo, actor, req.need, req.transport);
  if (!d.ok) return d;
  return { ok: true, repo: d.repo, actor, role: d.role };
}

interface Authoritative {
  pat: PATInfo | null;
  repo: RepoRow | null;
}

/**
 * One D1 round trip: optional throttled last_used_at stamp, the PAT join and
 * the repo row. Refreshes the Cache API copies with what it read.
 */
async function authoritativeLookup(
  env: Env,
  opts: { hash: string | null; stamp: boolean; repo: { owner: string; name: string } | null; now: number },
): Promise<Authoritative> {
  const stmts: D1PreparedStatement[] = [];
  let patIndex = -1;
  let repoIndex = -1;
  if (opts.hash) {
    if (opts.stamp) stmts.push(patStamp(env.DB, opts.hash, opts.now));
    patIndex = stmts.push(patSelect(env.DB, opts.hash)) - 1;
  }
  if (opts.repo) {
    repoIndex =
      stmts.push(
        env.DB.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?').bind(opts.repo.owner, opts.repo.name),
      ) - 1;
  }
  if (stmts.length === 0) return { pat: null, repo: null };
  const results = await env.DB.batch(stmts);
  const pat = patIndex >= 0 ? patFromRow(results[patIndex]?.results?.[0] as PatRow | undefined, opts.now) : null;
  const repo = repoIndex >= 0 ? ((results[repoIndex]?.results?.[0] as RepoRow | undefined) ?? null) : null;
  await Promise.all([
    opts.hash ? writePatCache(opts.hash, pat, opts.now) : undefined,
    repo ? writeRepoCache(repo) : undefined,
  ]);
  return { pat, repo };
}

/**
 * Authoritative PAT verification for routes that act on the caller's own
 * account (user info, tokens, repo creation): always confirms against D1.
 */
export async function resolvePAT(env: Env, token: string, clientIp: string | null): Promise<PrincipalResult> {
  if (!PAT_PATTERN.test(token)) return BAD_CREDENTIAL;
  const now = Date.now();
  const hash = await patHash(token);
  const cached = await readPatCache(hash, now);
  if (cached === 'invalid') return BAD_CREDENTIAL;
  if (!cached && !(await preauthAllowed(env, clientIp))) return RATE_LIMITED;
  const { pat } = await authoritativeLookup(env, { hash, stamp: patNeedsStamp(cached, now), repo: null, now });
  return pat ? { ok: true, pat } : BAD_CREDENTIAL;
}

/** Resolves the credential and repository, then applies the shared policy. */
export async function resolveRepoAccess(env: Env, req: RepoAccessRequest): Promise<RepoAccess> {
  const now = Date.now();
  const cred = req.credential;
  if (req.requireActor && cred.kind === 'anonymous') return NO_ACTOR;
  let hash: string | null = null;
  if (cred.kind === 'pat') {
    if (!PAT_PATTERN.test(cred.token)) return BAD_CREDENTIAL;
    hash = await patHash(cred.token);
  }

  const [cachedPat, cachedRepo] = await Promise.all([
    hash ? readPatCache(hash, now) : Promise.resolve(undefined),
    readRepoCache(req.owner, req.name),
  ]);
  if (cachedPat === 'invalid') return BAD_CREDENTIAL;

  // Public metadata reads: decided entirely from warm caches.
  if (req.need === 'read' && !req.requireActor && cachedRepo?.visibility === 'public' && (!hash || cachedPat)) {
    const actor = cred.kind === 'session' ? cred.actor : actorFor(req.transport, cachedPat);
    return decide(env, cachedRepo, actor, req);
  }

  // Anonymous callers never gain access to a repo cached as private; deny
  // (fail closed) without a D1 read.
  if (cred.kind === 'anonymous' && cachedRepo?.visibility === 'private') {
    return decide(env, cachedRepo, null, req);
  }

  if (hash && !cachedPat && !(await preauthAllowed(env, req.clientIp))) return RATE_LIMITED;

  const fresh = await authoritativeLookup(env, {
    hash,
    stamp: hash !== null && patNeedsStamp(cachedPat, now),
    repo: { owner: req.owner, name: req.name },
    now,
  });
  if (hash && !fresh.pat) return BAD_CREDENTIAL;
  const actor = cred.kind === 'session' ? cred.actor : actorFor(req.transport, fresh.pat);
  return decide(env, fresh.repo, actor, req);
}
