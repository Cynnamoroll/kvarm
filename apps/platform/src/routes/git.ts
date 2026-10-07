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
import { parseBasicAuth, scopesAllow, verifyPAT, type PATInfo } from '../auth/pat';
import { getGitToken } from '../artifacts/tokens';
import { rateLimit } from '../ratelimit';

/** /{owner}/{repo}(.git)/{git subpath} — mounted before all web routes. */
export const GIT_PATH_RE =
  /^\/([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/[^/]+\/[^/]+)$/;

function unauthorized(): Response {
  return new Response(null, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="forge", charset="UTF-8"' },
  });
}

function forbidden(): Response {
  return new Response('insufficient token scope\n', { status: 403 });
}

function operation(subpath: string, service: string | null): 'read' | 'write' {
  if (subpath === 'git-receive-pack') return 'write';
  if (subpath === 'info/refs' && service === 'git-receive-pack') return 'write';
  return 'read';
}

/** Rate limits per identity, per minute. Generous for CI, bounded for abuse. */
const RATE_LIMITS = { read: 600, write: 120 } as const;

export async function handleGitRequest(
  c: Context<{ Bindings: Env }>,
  owner: string,
  name: string,
  subpath: string,
): Promise<Response> {
  const env = c.env;
  const url = new URL(c.req.url);

  const repo: RepoRow | null = await getRepo(env.DB, owner, name);
  if (!repo) return new Response('repository not found\n', { status: 404 });

  const op = operation(subpath, url.searchParams.get('service'));
  const isPublic = repo.visibility === 'public';

  const basic = parseBasicAuth(c.req.header('Authorization'));
  let pat: PATInfo | null = null;
  if (basic) {
    pat = await verifyPAT(env, basic.password);
    if (!pat) return unauthorized();
  }

  if (op === 'write') {
    if (!pat) return unauthorized();
    if (!scopesAllow(pat.scopes, 'write')) return forbidden();
  } else if (!isPublic) {
    if (!pat) return unauthorized();
    if (!scopesAllow(pat.scopes, 'read')) return forbidden();
  }

  // Rate limit by PAT id (or client IP for anonymous public reads).
  const identity = pat?.id ?? `ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
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
    // Most common cause: repo is still importing/creating upstream.
    return new Response(
      `repository storage is warming up, retry shortly (${String(err)})\n`,
      { status: 503, headers: { 'Retry-After': '5' } },
    );
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
    const cacheKey = new Request(upstream.toString(), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const res = new Response(upstreamRes.body, upstreamRes);
    res.headers.set('Cache-Control', 'public, max-age=30');
    try {
      c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
    } catch {
      // cache.put can race on streaming bodies; never fail a clone over it.
    }
    return res;
  }

  return new Response(upstreamRes.body, upstreamRes);
}
