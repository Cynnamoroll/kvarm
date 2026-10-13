/**
 * WorkOS AuthKit sign-in for humans (architecture §11.1).
 *
 * WorkOS authenticates the person; Kvarm keeps its own sealed session cookie
 * naming the platform user. The cookie carries no authority of its own: every
 * request re-reads the user row from D1, and repository decisions go through
 * the same authoritative lookup as personal access tokens, so a deleted user,
 * a removed grant or a visibility flip applies on the next request.
 *
 * Identity comes only from the server-to-server code exchange (authenticated
 * with the API key, PKCE-bound to the browser that started sign-in), so no
 * access-token JWT is verified or used for authorization here. The WorkOS
 * refresh token is redeemed every SESSION_REFRESH_SECONDS; a refused refresh
 * (session revoked or user removed in WorkOS) ends the Kvarm session
 * (refreshSession explains races and outages).
 *
 * Never log codes, tokens, cookies or the cookie password.
 */

import { sha256Hex } from '@kvarm/gitops';
import { getUserById, type UserRow } from '../db/users';
import { internalKey, readCachedJson, writeCachedJson } from '../cache/internal';
import { refreshProfile } from '../services/identity';
import { appOrigin } from '../config';
import { fromB64url, pkceChallenge, randomToken, safeEqual, seal, unseal } from './sealed';

/** Kept from the AuthKit default: cache scoping (cache/scope.ts) and repo pages key off it. */
export const SESSION_COOKIE = 'wos-session';
export const STATE_COOKIE = 'kvarm-auth-state';
/** Absolute session lifetime; refresh never extends it. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
/** How long a session trusts WorkOS before redeeming its refresh token again. */
export const SESSION_REFRESH_SECONDS = 10 * 60;
/** A sign-in must come back to /auth/callback within this window. */
export const STATE_MAX_AGE_SECONDS = 10 * 60;
export const MIN_COOKIE_PASSWORD_LENGTH = 32;

const WORKOS_API = 'https://api.workos.com';

export function authConfigured(env: Env): boolean {
  return Boolean(
    env.WORKOS_API_KEY &&
      env.WORKOS_CLIENT_ID &&
      env.WORKOS_COOKIE_PASSWORD &&
      env.WORKOS_COOKIE_PASSWORD.length >= MIN_COOKIE_PASSWORD_LENGTH,
  );
}

// ---------------------------------------------------------------------------
// WorkOS User Management client
// ---------------------------------------------------------------------------

export interface WorkOSIdentity {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export interface WorkOSAuthentication {
  user: WorkOSIdentity;
  refreshToken: string;
  /** WorkOS session id (`sid` of the access token), used only for the logout redirect. */
  sessionId: string | null;
}

export interface WorkOSClient {
  authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string;
  authenticateWithCode(p: { code: string; codeVerifier: string }): Promise<WorkOSAuthentication>;
  authenticateWithRefreshToken(p: { refreshToken: string }): Promise<WorkOSAuthentication>;
  logoutUrl(p: { sessionId: string; returnTo: string }): string;
}

export class WorkOSError extends Error {
  constructor(readonly status: number) {
    // The status only: WorkOS error bodies may echo the submitted code.
    super(`WorkOS authenticate failed with HTTP ${status}`);
  }
}

interface RawAuthResponse {
  user?: {
    id?: unknown;
    email?: unknown;
    email_verified?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    profile_picture_url?: unknown;
  };
  access_token?: unknown;
  refresh_token?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The `sid` claim, read without verification: the token came straight from WorkOS over TLS. */
function sessionIdOf(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null;
  const part = accessToken.split('.')[1];
  const bytes = part ? fromB64url(part) : null;
  if (!bytes) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(bytes)) as { sid?: unknown };
    return str(json.sid);
  } catch {
    return null;
  }
}

function parseAuthentication(body: RawAuthResponse): WorkOSAuthentication {
  const u = body.user ?? {};
  const id = str(u.id);
  const email = str(u.email);
  const refreshToken = str(body.refresh_token);
  if (!id || !email || !refreshToken) throw new WorkOSError(502);
  const name = [str(u.first_name), str(u.last_name)].filter(Boolean).join(' ');
  return {
    user: { id, email, emailVerified: u.email_verified === true, name: name || null, avatarUrl: str(u.profile_picture_url) },
    refreshToken,
    sessionId: sessionIdOf(body.access_token),
  };
}

/** The production client: WorkOS User Management over `fetch` (resolved per call, so tests can stub it). */
export function httpWorkOSClient(env: Env): WorkOSClient {
  const authenticate = async (grant: Record<string, string>): Promise<WorkOSAuthentication> => {
    const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: env.WORKOS_CLIENT_ID, client_secret: env.WORKOS_API_KEY, ...grant }),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new WorkOSError(res.status);
    }
    return parseAuthentication((await res.json()) as RawAuthResponse);
  };
  return {
    authorizationUrl({ redirectUri, state, codeChallenge }) {
      const url = new URL(`${WORKOS_API}/user_management/authorize`);
      url.searchParams.set('client_id', env.WORKOS_CLIENT_ID);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('provider', 'authkit');
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.toString();
    },
    authenticateWithCode: ({ code, codeVerifier }) =>
      authenticate({ grant_type: 'authorization_code', code, code_verifier: codeVerifier }),
    authenticateWithRefreshToken: ({ refreshToken }) =>
      authenticate({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    logoutUrl({ sessionId, returnTo }) {
      const url = new URL(`${WORKOS_API}/user_management/sessions/logout`);
      url.searchParams.set('session_id', sessionId);
      url.searchParams.set('return_to', returnTo);
      return url.toString();
    },
  };
}

/**
 * The configured callback, else this request's own origin: the state cookie
 * is host-only, so the callback must land on the host that started sign-in.
 */
export function redirectUri(env: Env, requestOrigin: string): string {
  return env.WORKOS_REDIRECT_URI || `${requestOrigin}/auth/callback`;
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function cookie(name: string, value: string, path: string, maxAge: number): string {
  return `${name}=${value}; Path=${path}; Max-Age=${Math.max(0, Math.floor(maxAge))}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return cookie(SESSION_COOKIE, '', '/', 0);
}

/**
 * One state cookie per pending sign-in, named by a prefix of its state, so
 * sign-ins started in two tabs do not overwrite each other.
 */
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

function stateCookieName(state: string): string {
  return `${STATE_COOKIE}-${state.slice(0, 12)}`;
}

/** The Set-Cookie clearing the pending sign-in for `state`; none for a malformed state. */
export function clearStateCookies(state: string | undefined): string[] {
  return state && STATE_RE.test(state) ? [cookie(stateCookieName(state), '', '/auth', 0)] : [];
}

/** Only same-site absolute paths; anything else (`//host`, `/\host`, URLs) returns home. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 0x20) return '/';
  return value.slice(0, 1024);
}

// ---------------------------------------------------------------------------
// Sign-in state (PKCE verifier + state, bound to this browser)
// ---------------------------------------------------------------------------

interface StatePayload {
  state: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export async function beginSignIn(
  env: Env,
  client: WorkOSClient,
  returnTo: string,
  requestOrigin: string,
  now = Date.now(),
): Promise<{ location: string; setCookie: string }> {
  const state = randomToken(32);
  const verifier = randomToken(48);
  const payload: StatePayload = { state, verifier, returnTo: safeReturnTo(returnTo), exp: now + STATE_MAX_AGE_SECONDS * 1000 };
  const sealed = await seal(env.WORKOS_COOKIE_PASSWORD, 'auth-state', payload);
  return {
    location: client.authorizationUrl({ redirectUri: redirectUri(env, requestOrigin), state, codeChallenge: await pkceChallenge(verifier) }),
    setCookie: cookie(stateCookieName(state), sealed, '/auth', STATE_MAX_AGE_SECONDS),
  };
}

/** The pending sign-in for this browser when `state` matches it and it has not expired. */
export async function pendingSignIn(
  request: Request,
  env: Env,
  state: string,
  now = Date.now(),
): Promise<{ verifier: string; returnTo: string } | null> {
  if (!STATE_RE.test(state)) return null;
  const raw = readCookie(request, stateCookieName(state));
  if (!raw) return null;
  const p = await unseal<StatePayload>(env.WORKOS_COOKIE_PASSWORD, 'auth-state', raw);
  if (!p || typeof p.state !== 'string' || typeof p.verifier !== 'string' || typeof p.exp !== 'number') return null;
  if (p.exp <= now || !safeEqual(p.state, state)) return null;
  return { verifier: p.verifier, returnTo: safeReturnTo(p.returnTo) };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionPayload {
  /** users.id */
  uid: string;
  /** users.workos_user_id at sign-in; a relinked row no longer matches. */
  wid: string;
  sid: string | null;
  rt: string;
  /** Absolute expiry (ms). */
  exp: number;
  /** Next WorkOS refresh due (ms). */
  rat: number;
  /** Synchronizer CSRF token for this session. */
  csrf: string;
}

export interface SessionInfo {
  user: UserRow;
  sessionId: string | null;
  csrfToken: string;
  expiresAt: number;
}

export interface SessionLookup {
  session: SessionInfo | null;
  /** Set-Cookie values the response must carry (a refreshed or cleared session). */
  setCookies: string[];
}

export async function sessionCookie(env: Env, payload: SessionPayload, now = Date.now()): Promise<string> {
  const sealed = await seal(env.WORKOS_COOKIE_PASSWORD, 'session', payload);
  return cookie(SESSION_COOKIE, sealed, '/', (payload.exp - now) / 1000);
}

export function newSessionPayload(user: UserRow, auth: WorkOSAuthentication, now = Date.now()): SessionPayload {
  return {
    uid: user.id,
    wid: user.workos_user_id,
    sid: auth.sessionId,
    rt: auth.refreshToken,
    exp: now + SESSION_MAX_AGE_SECONDS * 1000,
    rat: now + SESSION_REFRESH_SECONDS * 1000,
    csrf: randomToken(32),
  };
}

function validPayload(p: SessionPayload | null): p is SessionPayload {
  return (
    p !== null &&
    typeof p.uid === 'string' &&
    typeof p.wid === 'string' &&
    typeof p.rt === 'string' &&
    typeof p.exp === 'number' &&
    typeof p.rat === 'number' &&
    typeof p.csrf === 'string' &&
    p.csrf.length >= 32
  );
}

const NO_SESSION: SessionLookup = { session: null, setCookies: [] };

/**
 * The signed-in user for this request, read fresh from D1. Never throws: a
 * missing, tampered, expired or revoked session is simply signed out, and the
 * cookie is cleared when it can never become valid again.
 */
export async function getSessionInfo(
  request: Request,
  env: Env,
  opts: { client?: WorkOSClient; now?: number } = {},
): Promise<SessionLookup> {
  if (!authConfigured(env)) return NO_SESSION;
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return NO_SESSION;
  const now = opts.now ?? Date.now();
  const cleared: SessionLookup = { session: null, setCookies: [clearSessionCookie()] };
  let p = await unseal<SessionPayload>(env.WORKOS_COOKIE_PASSWORD, 'session', raw);
  if (!validPayload(p) || p.exp <= now) return cleared;
  let user = await getUserById(env.DB, p.uid);
  if (!user || user.workos_user_id !== p.wid) return cleared;
  const setCookies: string[] = [];
  if (p.rat <= now) {
    const refreshed = await refreshSession(env, opts.client ?? httpWorkOSClient(env), p, now);
    if (refreshed === 'rejected') return cleared;
    p = refreshed.payload;
    setCookies.push(await sessionCookie(env, p, now));
    if (refreshed.identity) user = await refreshProfile(env.DB, user, refreshed.identity);
  }
  return { session: { user, sessionId: p.sid, csrfToken: p.csrf, expiresAt: p.exp }, setCookies };
}

/** How long a rotated refresh token's successor stays findable for a concurrent request. */
export const ROTATION_GRACE_SECONDS = 60;
/** Retry delay after WorkOS could not be reached. */
export const REFRESH_RETRY_SECONDS = 60;
const ROTATION_POLLS = 4;
const ROTATION_POLL_MS = 150;

function rotationKey(refreshToken: string): Promise<Request> {
  return sha256Hex(refreshToken).then((h) => internalKey('session-rotation', h));
}

/**
 * Redeems the session's refresh token. WorkOS refresh tokens are single-use,
 * so a page and its parallel requests may race: the winner records the sealed
 * successor (colo-local Cache API, keyed by a hash of the spent token) and a
 * request that then sees its token refused adopts that successor instead of
 * signing the browser out. Only a definite refusal with no successor ends the
 * session. When WorkOS is unreachable the session continues on its current
 * D1-checked authority and retries after REFRESH_RETRY_SECONDS.
 */
async function refreshSession(
  env: Env,
  client: WorkOSClient,
  p: SessionPayload,
  now: number,
): Promise<{ payload: SessionPayload; identity: WorkOSIdentity | null } | 'rejected'> {
  const key = await rotationKey(p.rt);
  let auth: WorkOSAuthentication;
  try {
    auth = await client.authenticateWithRefreshToken({ refreshToken: p.rt });
  } catch (err) {
    if (!(err instanceof WorkOSError) || err.status >= 500) {
      return { payload: { ...p, rat: now + REFRESH_RETRY_SECONDS * 1000 }, identity: null };
    }
    for (let i = 0; i < ROTATION_POLLS; i++) {
      const sealed = await readCachedJson<string>(key);
      const next = typeof sealed === 'string' ? await unseal<SessionPayload>(env.WORKOS_COOKIE_PASSWORD, 'session', sealed) : null;
      if (validPayload(next) && next.uid === p.uid && next.wid === p.wid && next.exp === p.exp) {
        return { payload: next, identity: null };
      }
      await new Promise((resolve) => setTimeout(resolve, ROTATION_POLL_MS));
    }
    return 'rejected';
  }
  if (auth.user.id !== p.wid) return 'rejected';
  const next: SessionPayload = { ...p, rt: auth.refreshToken, sid: auth.sessionId ?? p.sid, rat: now + SESSION_REFRESH_SECONDS * 1000 };
  await writeCachedJson(key, await seal(env.WORKOS_COOKIE_PASSWORD, 'session', next), ROTATION_GRACE_SECONDS);
  return { payload: next, identity: auth.user };
}

// ---------------------------------------------------------------------------
// Cross-site request defenses
// ---------------------------------------------------------------------------

export function isUnsafeMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

/**
 * Whether a browser request was issued by a page of this origin. A present
 * Origin must match; without one, Fetch Metadata (when sent) must not say
 * cross-site. Non-browser clients send neither and carry no ambient cookie.
 */
export function isSameOriginRequest(request: Request, env: Env): boolean {
  const own = new URL(request.url).origin;
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === own || origin === appOrigin(env);
  const site = request.headers.get('sec-fetch-site');
  return site === null || site === 'same-origin' || site === 'none';
}

/** Synchronizer-token check for a session's state-changing form post. */
export function csrfTokenValid(session: SessionInfo, submitted: unknown): boolean {
  return typeof submitted === 'string' && submitted.length > 0 && safeEqual(submitted, session.csrfToken);
}
