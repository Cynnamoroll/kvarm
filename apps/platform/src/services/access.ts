/**
 * Credential + repository resolution with cost-aware caching, in front of the
 * shared policy in services/authz.ts.
 *
 * Cache use is deliberately asymmetric (architecture §10, §11.1):
 *  - Public repo reads may be decided from Cache API copies of the PAT and
 *    repo row (0 D1 when warm). Public content is readable anonymously, so a
 *    stale credential there discloses nothing.
 *  - Everything else (private repos, writes, routes that need an actor) is
 *    decided on an authoritative D1 read of the PAT, the repo row and the
 *    caller's org membership and repo grant, issued as a single batch.
 *    Revoked or expired PATs, removed members and revoked grants therefore
 *    fail on the next such request in every colo, not only where a cache
 *    entry was deleted. Membership and grants are never cached. A repo made
 *    private stops taking the public path once its cached row is purged
 *    (same colo, at update time) or expires (other colos, REPO_CACHE_TTL).
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
  isOrgRole,
  isRepoNeed,
  NO_FACTS,
  patActor,
  type AccessFacts,
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
  facts: AccessFacts = NO_FACTS,
): Promise<RepoAccess> {
  if (req.requireActor && !actor) return NO_ACTOR;
  const d = await authorizeRepo(env, repo, actor, req.need, req.transport, facts);
  if (!d.ok) return d;
  return { ok: true, repo: d.repo, actor, role: d.role };
}

interface Authoritative {
  pat: PATInfo | null;
  repo: RepoRow | null;
  facts: AccessFacts;
  /** The user the facts were read for; null when none were read. */
  factsUserId: string | null;
}

/** Whose membership and grant to read alongside the repo row. */
type FactsSubject = { userId: string } | { patHash: string } | null;

type RepoFactsRow = RepoRow & { facts_org_role: unknown; facts_grant: unknown; facts_user_id: string | null };

/**
 * The repo row plus the subject's org membership and explicit grant, in one
 * statement. Both subqueries are primary-key probes; personal repos have a
 * NULL `owner_org_id`, so their membership probe matches nothing.
 */
function repoFactsSelect(db: D1Database, owner: string, name: string, subject: FactsSubject): D1PreparedStatement {
  if (!subject) {
    return db.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?').bind(owner, name);
  }
  const who =
    'userId' in subject ? 'SELECT ?3 AS uid' : 'SELECT user_id AS uid FROM pat WHERE hash = ?3 LIMIT 1';
  return db
    .prepare(
      `WITH who AS (${who})
       SELECT r.*, who.uid AS facts_user_id,
              (SELECT m.role FROM org_members m
                WHERE m.org_id = r.owner_org_id AND m.user_id = who.uid) AS facts_org_role,
              (SELECT g.role FROM repo_grants g WHERE g.repo_id = r.id AND g.user_id = who.uid) AS facts_grant
         FROM repos r LEFT JOIN who
        WHERE r.owner_login = ?1 AND r.name = ?2`,
    )
    .bind(owner, name, 'userId' in subject ? subject.userId : subject.patHash);
}

function splitFacts(row: RepoFactsRow | RepoRow | undefined): {
  repo: RepoRow | null;
  facts: AccessFacts;
  userId: string | null;
} {
  if (!row) return { repo: null, facts: NO_FACTS, userId: null };
  if (!('facts_grant' in row)) return { repo: row, facts: NO_FACTS, userId: null };
  const { facts_org_role, facts_grant, facts_user_id, ...repo } = row;
  return {
    repo,
    facts: {
      ownerIsOrg: typeof repo.owner_org_id === 'string',
      orgRole: isOrgRole(facts_org_role) ? facts_org_role : null,
      grant: isRepoNeed(facts_grant) ? facts_grant : null,
    },
    userId: facts_user_id,
  };
}

/**
 * One D1 round trip: optional throttled last_used_at stamp, the PAT join and
 * the repo row with the caller's membership and grant. Refreshes the Cache
 * API copies of the PAT and repo row with what it read; membership and grants
 * are never cached.
 */
async function authoritativeLookup(
  env: Env,
  opts: {
    hash: string | null;
    stamp: boolean;
    repo: { owner: string; name: string } | null;
    subject?: FactsSubject;
    now: number;
  },
): Promise<Authoritative> {
  const stmts: D1PreparedStatement[] = [];
  let patIndex = -1;
  let repoIndex = -1;
  if (opts.hash) {
    if (opts.stamp) stmts.push(patStamp(env.DB, opts.hash, opts.now));
    patIndex = stmts.push(patSelect(env.DB, opts.hash)) - 1;
  }
  if (opts.repo) {
    repoIndex = stmts.push(repoFactsSelect(env.DB, opts.repo.owner, opts.repo.name, opts.subject ?? null)) - 1;
  }
  if (stmts.length === 0) return { pat: null, repo: null, facts: NO_FACTS, factsUserId: null };
  const results = await env.DB.batch(stmts);
  const pat = patIndex >= 0 ? patFromRow(results[patIndex]?.results?.[0] as PatRow | undefined, opts.now) : null;
  const { repo, facts, userId } =
    repoIndex >= 0 ? splitFacts(results[repoIndex]?.results?.[0] as RepoFactsRow | undefined) : splitFacts(undefined);
  await Promise.all([
    opts.hash ? writePatCache(opts.hash, pat, opts.now) : undefined,
    repo ? writeRepoCache(repo) : undefined,
  ]);
  return { pat, repo, facts, factsUserId: userId };
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

  // A PAT's owning user never changes, so a cached PAT safely names whose
  // facts to read; the PAT itself is still re-verified in the same batch.
  const subject: FactsSubject =
    cred.kind === 'session'
      ? { userId: cred.actor.user.id }
      : hash
        ? cachedPat
          ? { userId: cachedPat.userId }
          : { patHash: hash }
        : null;
  const fresh = await authoritativeLookup(env, {
    hash,
    stamp: hash !== null && patNeedsStamp(cachedPat, now),
    repo: { owner: req.owner, name: req.name },
    subject,
    now,
  });
  if (hash && !fresh.pat) return BAD_CREDENTIAL;
  const actor = cred.kind === 'session' ? cred.actor : actorFor(req.transport, fresh.pat);
  const facts = actor && fresh.factsUserId === actor.user.id ? fresh.facts : NO_FACTS;
  return decide(env, fresh.repo, actor, req, facts);
}
