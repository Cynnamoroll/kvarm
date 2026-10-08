/**
 * Git smart-HTTP proxy: the fastest possible clone path on Artifacts.
 *
 * Design (see planning/PLAN.md §3.1):
 *  - Platform auth happens here (PATs or anonymous public reads); storage is
 *    Cloudflare Artifacts, reached same-network over the Worker fetch API.
 *  - The proxy streams both directions and buffers nothing, so clones and
 *    pushes add ~1-3ms and flat memory/CPU regardless of repo size.
 *  - Anonymous and authenticated reads share a per-repo read-only Artifacts
 *    token minted through the binding and cached in the TokenCache DO
 *    (platform authorization has already happened by then).
 *  - info/refs advertisements for public repos are edge-cached briefly so
 *    bursty CI clones skip the backend hop. Purged by push events (M4).
 */

import type { Context } from 'hono';
import { getRepo, type RepoRow } from '../db/repos';
import { parseBasicAuth, verifyPAT } from '../auth/pat';
import { getGitToken } from '../artifacts/tokens';
import { rateLimit } from '../ratelimit';
import { authorizeRepo, patActor, type Actor, type AuthzDenyCode } from '../services/authz';

/** /{owner}/{repo}(.git)/{git subpath} — mounted before all web routes. */
export const GIT_PATH_RE =
  /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/[^/]+\/[^/]+)$/;

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="forge", charset="UTF-8"' },
  });
}

function denied(status: 401 | 403 | 404, code: AuthzDenyCode): Response {
  if (status === 401) return unauthorized();
  if (status === 404) return new Response('repository not found\n', { status: 404 });
  return new Response(
    code === 'INSUFFICIENT_SCOPE' ? 'insufficient token scope\n' : 'permission denied\n',
    { status: 403 },
  );
}

/** Upstream headers relayed to git clients; everything else stays server-side. */
const RELAYED_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma', 'content-encoding'];

function relay(upstream: Response): Response {
  const headers = new Headers();
  for (const h of RELAYED_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

function operation(subpath: string, service: string | null): 'read' | 'write' {
  if (subpath === 'git-receive-pack') return 'write';
  if (subpath === 'info/refs' && service === 'git-receive-pack') return 'write';
  return 'read';
}

/** Rate limits per identity, per minute. Generous for CI, bounded for abuse. */
const RATE_LIMITS = { read: 600, write: 120 } as const;

export type GitAccess =
  | { ok: true; repo: RepoRow; actor: Actor | null; op: 'read' | 'write' }
  | { ok: false; response: Response };

/** Authenticates and authorizes one git request; nothing upstream is touched. */
export async function authorizeGitRequest(
  env: Env,
  request: Request,
  owner: string,
  name: string,
  subpath: string,
): Promise<GitAccess> {
  const op = operation(subpath, new URL(request.url).searchParams.get('service'));

  const basic = parseBasicAuth(request.headers.get('Authorization') ?? undefined);
  let actor: Actor | null = null;
  if (basic) {
    const pat = await verifyPAT(env, basic.password);
    if (!pat) return { ok: false, response: unauthorized() };
    actor = patActor(pat);
  }

  // Anonymous writes never need a repo lookup; challenge before touching D1.
  if (op === 'write' && !actor) return { ok: false, response: unauthorized() };

  const found = await getRepo(env.DB, owner, name);
  const decision = await authorizeRepo(env, found, actor, op, 'git');
  if (!decision.ok) return { ok: false, response: denied(decision.status, decision.code) };
  return { ok: true, repo: decision.repo, actor, op };
}

export async function handleGitRequest(
  c: Context<{ Bindings: Env }>,
  owner: string,
  name: string,
  subpath: string,
): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);
  const access = await authorizeGitRequest(env, c.req.raw, owner, name, subpath);
  if (!access.ok) return access.response;
  const { repo, actor, op } = access;
  const isPublic = repo.visibility === 'public';

  // Rate limit by PAT id (or client IP for anonymous public reads).
  const identity = actor?.patId ?? `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
  const allowed = await rateLimit(env, `git:${op}:${identity}`, RATE_LIMITS[op]);
  if (!allowed) {
    return new Response('rate limit exceeded, slow down\n', {
      status: 429,
      headers: { 'Retry-After': '60' },
    });
  }

  // Mint (or reuse) a short-lived repo-scoped Artifacts token upstream.
  let artifactsToken: string;
  try {
    artifactsToken = await getGitToken(env, repo.artifacts_name, op);
  } catch (err) {
    // Most common cause: repo is still importing/creating upstream. Upstream
    // detail stays in logs, never in the client response.
    console.warn(JSON.stringify({ gitTokenMintFailed: String(err).slice(0, 200) }));
    return new Response('repository storage is warming up, retry shortly\n', {
      status: 503,
      headers: { 'Retry-After': '5' },
    });
  }

  const upstream = new URL(`${repo.artifacts_remote}/${subpath}`);
  upstream.search = url.search;

  const headers = new Headers();
  headers.set('Authorization', `Basic ${btoa(`forge:${artifactsToken}`)}`);
  for (const h of ['content-type', 'accept', 'git-protocol', 'user-agent']) {
    const v = c.req.raw.headers.get(h);
    if (v) headers.set(h, v);
  }

  const init: RequestInit = { method: c.req.method, headers };
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    init.body = c.req.raw.body;
  }
  const upstreamRes = await fetch(upstream.toString(), init);

  // Briefly edge-cache public clone bootstrapping (purge-on-push lands in M4).
  if (op === 'read' && isPublic && subpath === 'info/refs' && c.req.method === 'GET') {
    const cache = caches.default;
    // v0 and v2 advertisements differ for the same URL; key on the protocol.
    const keyUrl = new URL(upstream);
    keyUrl.searchParams.set('forge-git-protocol', c.req.header('git-protocol') ?? '');
    const cacheKey = new Request(keyUrl.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const res = relay(upstreamRes);
    res.headers.set('Cache-Control', 'public, max-age=30');
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    } catch {
      // cache.put can race on streaming bodies; never fail a clone over it.
    }
    return res;
  }

  return relay(upstreamRes);
}
