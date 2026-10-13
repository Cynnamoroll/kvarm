/**
 * WorkOS AuthKit integration (all human auth; nothing self-rolled).
 *
 * Uses @workos/authkit-session — WorkOS' framework-agnostic toolkit that
 * handles the PKCE authorization flow, JWKS-verified JWTs, session sealing
 * (AES-256-CBC + HMAC via iron-webcrypto), and token refresh. We only supply
 * a Workers storage adapter that reads/writes cookies on raw Request/Response
 * objects, plus small helpers for routes.
 */

import {
  configure,
  CookieSessionStorage,
  createAuthService,
} from '@workos/authkit-session';

// ---------------------------------------------------------------------------
// Workers storage adapter
// ---------------------------------------------------------------------------

export class WorkersSessionStorage extends CookieSessionStorage<Request, Response> {
  async getCookie(request: Request, name: string): Promise<string | null> {
    const header = request.headers.get('cookie');
    if (!header) return null;
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === name) return decodeURIComponent(rest.join('='));
    }
    return null;
  }

  protected async applyHeaders(
    response: Response | undefined,
    headers: Record<string, string | string | string[]>,
  ): Promise<{ response: Response }> {
    const newResponse = new Response(response?.body, {
      status: response?.status ?? 200,
      statusText: response?.statusText,
      headers: new Headers(response?.headers),
    });
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        // Never comma-join Set-Cookie; each entry is its own header.
        for (const v of value) newResponse.headers.append(key, v);
      } else {
        newResponse.headers.append(key, value);
      }
    }
    return { response: newResponse };
  }
}

export const authService = createAuthService({
  // The factory receives the resolved config (cookie name, options, secure
  // flag) and must return the framework's storage adapter.
  // biome-ignore lint/suspicious/noExplicitAny: config type is inferred by the library
  sessionStorageFactory: (config: any) => new WorkersSessionStorage(config),
});

let configured = false;

export function authConfigured(env: Env): boolean {
  return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID && env.WORKOS_COOKIE_PASSWORD);
}

function ensureConfigured(env: Env): void {
  if (configured) return;
  configure({
    clientId: env.WORKOS_CLIENT_ID,
    apiKey: env.WORKOS_API_KEY,
    redirectUri: env.WORKOS_REDIRECT_URI,
    cookiePassword: env.WORKOS_COOKIE_PASSWORD,
    // The session cookie carries every human credential: its SameSite policy
    // is the CSRF backstop for the cookie-authenticated routes, so it is set
    // here instead of relying on the library's default. 'lax' keeps top-level
    // navigations working; cross-site POSTs (the form routes) never ride it.
    cookieSameSite: 'lax',
  });
  configured = true;
}

export function requireConfigured(env: Env): void {
  if (!authConfigured(env)) {
    throw new Error(
      'WorkOS is not configured: set WORKOS_CLIENT_ID, WORKOS_API_KEY, WORKOS_COOKIE_PASSWORD and restart.',
    );
  }
  ensureConfigured(env);
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

export interface SessionUser {
  workosUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface SessionInfo {
  user: SessionUser;
  sessionId: string;
  /** Set-Cookie values to persist when the access token was refreshed. */
  refreshCookies: string[];
}

/** Returns the signed-in WorkOS user, or null. Never throws for anon users. */
export async function getSessionInfo(request: Request, env: Env): Promise<SessionInfo | null> {
  if (!authConfigured(env)) return null;
  ensureConfigured(env);
  try {
    const { auth, refreshedSessionData } = await authService.withAuth(request);
    if (!auth.user) return null;
    const info: SessionInfo = {
      user: {
        workosUserId: auth.user.id,
        email: auth.user.email,
        name: [auth.user.firstName, auth.user.lastName].filter(Boolean).join(' ') || null,
        avatarUrl: auth.user.profilePictureUrl ?? null,
      },
      sessionId: auth.sessionId,
      refreshCookies: [],
    };
    if (refreshedSessionData) {
      const { headers } = await authService.saveSession(undefined, refreshedSessionData);
      const bag = (headers ?? {}) as Record<string, string | string[]>;
      const setCookie = bag['Set-Cookie'] ?? bag['set-cookie'];
      if (setCookie) {
        info.refreshCookies = Array.isArray(setCookie) ? setCookie : [setCookie];
      }
    }
    return info;
  } catch {
    // Invalid/expired sealed cookie, WorkOS unreachable, missing config…
    // Treat as signed out rather than failing the page.
    return null;
  }
}
