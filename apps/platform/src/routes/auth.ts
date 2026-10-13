/** WorkOS AuthKit routes: /auth/sign-in, /auth/callback, /auth/sign-out. */

import { Hono, type Context } from 'hono';
import { authService, authConfigured, getSessionInfo, requireConfigured } from '../auth/workos';

export const authRoutes = new Hono<{ Bindings: Env }>();

function applyHeaderBag(res: Response, headers: Record<string, string | string[]> | undefined): void {
  const bag = (headers ?? {}) as Record<string, string | string[]>;
  for (const [key, value] of Object.entries(bag)) {
    if (Array.isArray(value)) {
      for (const v of value) res.headers.append(key, v);
    } else {
      res.headers.append(key, value);
    }
  }
}

/** 503 with setup guidance when WorkOS secrets are absent. */
function unconfigured(c: Context<{ Bindings: Env }>): Response | null {
  if (!authConfigured(c.env)) {
    return c.text(
      'auth is not configured: set WORKOS_CLIENT_ID, WORKOS_API_KEY and WORKOS_COOKIE_PASSWORD ' +
        '(see apps/platform/.dev.vars.example)',
      503,
    );
  }
  return null;
}

authRoutes.get('/sign-in', async (c) => {
  const bail = unconfigured(c);
  if (bail) return bail;
  const { url, headers } = await authService.createSignIn(new Response(), {
    returnPathname: c.req.query('returnTo') ?? '/',
  });
  const res = new Response(null, { status: 302 });
  applyHeaderBag(res, headers);
  res.headers.set('Location', url);
  return res;
});

authRoutes.get('/callback', async (c) => {
  const bail = unconfigured(c);
  if (bail) return bail;
  requireConfigured(c.env);
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.text('bad callback request', 400);
  try {
    const result = await authService.handleCallback(c.req.raw, new Response(), { code, state });
    const res = result.response instanceof Response ? result.response : new Response(null, { status: 302 });
    applyHeaderBag(res, (result as { headers?: Record<string, string | string[]> }).headers);
    // The library carries the sign-in's sanitized returnTo through the flow
    // and sets it here, so a session-gated page (requireSessionPage builds
    // ?returnTo= links) lands where the visitor started. Only a same-origin
    // path is accepted; anything else is the root.
    const target = res.headers.get('Location');
    res.headers.set('Location', target !== null && target.startsWith('/') && !target.startsWith('//') ? target : '/');
    return res;
  } catch (err) {
    // Clear the PKCE verifier cookie so the next sign-in starts clean.
    await authService
      .clearPendingVerifier(new Response(), { state })
      .catch(() => undefined);
    return c.text(`sign-in failed: ${String(err)}`, 400);
  }
});

// POST-only: sign-out is a state change, and a GET link could be triggered by
// any third-party page (the Lax cookie rides top-level navigations).
authRoutes.post('/sign-out', async (c) => {
  const bail = unconfigured(c);
  if (bail) return bail;
  requireConfigured(c.env);
  const info = await getSessionInfo(c.req.raw, c.env);
  if (!info) return c.redirect('/');
  try {
    const { logoutUrl, headers } = await authService.signOut(info.sessionId, {
      returnTo: new URL(c.req.url).origin,
    });
    const res = new Response(null, { status: 302 });
    applyHeaderBag(res, headers);
    res.headers.set('Location', logoutUrl);
    return res;
  } catch {
    return c.redirect('/');
  }
});
