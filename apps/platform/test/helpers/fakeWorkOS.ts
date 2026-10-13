/**
 * An in-memory stand-in for the WorkOS User Management endpoints Kvarm calls
 * (POST /user_management/authenticate). It is installed over global fetch and
 * refuses every other request to api.workos.com, so no test can reach WorkOS.
 * It enforces what the real API enforces for this flow: client credentials,
 * single-use codes bound to their PKCE challenge, and rotating refresh tokens.
 */

export interface FakeUser {
  id: string;
  email: string;
  emailVerified?: boolean;
  firstName?: string;
  lastName?: string;
}

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
}

function rand(prefix: string): string {
  return `${prefix}${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

export class FakeWorkOS {
  readonly clientId = 'client_fake';
  readonly apiKey = 'sk_fake_not_a_real_key';
  private codes = new Map<string, { user: FakeUser; challenge: string }>();
  private refresh = new Map<string, { user: FakeUser; sid: string }>();
  /** Users whose sessions WorkOS no longer refreshes. */
  readonly revokedUsers = new Set<string>();
  /** When set, refreshes answer as this user instead. */
  refreshAs: FakeUser | null = null;
  calls: Array<{ grant: string }> = [];

  /** What AuthKit does after the person signs in: a code for the challenge in the authorize URL. */
  issueCode(authorizeUrl: string, user: FakeUser): { code: string; state: string } {
    const url = new URL(authorizeUrl);
    if (url.origin !== 'https://api.workos.com' || url.pathname !== '/user_management/authorize') {
      throw new Error(`unexpected authorize URL ${url.origin}${url.pathname}`);
    }
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 expected');
    const code = rand('code_');
    this.codes.set(code, { user, challenge: url.searchParams.get('code_challenge') ?? '' });
    return { code, state: url.searchParams.get('state') ?? '' };
  }

  /** A refresh token that was valid for `user` (for crafting sessions directly). */
  refreshTokenFor(user: FakeUser): string {
    const rt = rand('rt_');
    this.refresh.set(rt, { user, sid: rand('session_') });
    return rt;
  }

  private respond(user: FakeUser, sid: string): Response {
    const rt = rand('rt_');
    this.refresh.set(rt, { user, sid });
    const payload = b64url(encoder.encode(JSON.stringify({ sid, sub: user.id })));
    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        email_verified: user.emailVerified ?? true,
        first_name: user.firstName ?? null,
        last_name: user.lastName ?? null,
        profile_picture_url: null,
      },
      access_token: `eyJhbGciOiJub25lIn0.${payload}.sig`,
      refresh_token: rt,
    });
  }

  private async authenticate(req: Request): Promise<Response> {
    const body = (await req.json()) as Record<string, string>;
    this.calls.push({ grant: body.grant_type ?? '' });
    if (body.client_id !== this.clientId || body.client_secret !== this.apiKey) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    if (body.grant_type === 'authorization_code') {
      const entry = this.codes.get(body.code ?? '');
      this.codes.delete(body.code ?? '');
      if (!entry || (await s256(body.code_verifier ?? '')) !== entry.challenge) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return this.respond(entry.user, rand('session_'));
    }
    if (body.grant_type === 'refresh_token') {
      const entry = this.refresh.get(body.refresh_token ?? '');
      this.refresh.delete(body.refresh_token ?? '');
      if (!entry || this.revokedUsers.has(entry.user.id)) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return this.respond(this.refreshAs ?? entry.user, entry.sid);
    }
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname === 'api.workos.com') {
        if (req.method === 'POST' && url.pathname === '/user_management/authenticate') return this.authenticate(req);
        throw new Error(`unexpected WorkOS call ${req.method} ${url.pathname}`);
      }
      return originalFetch(input, init);
    }) as typeof fetch;
  }

  static restore(): void {
    globalThis.fetch = originalFetch;
  }
}

/** A minimal cookie jar: Set-Cookie in, Cookie header out; Max-Age=0 deletes. */
export class CookieJar {
  private jar = new Map<string, string>();

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/;\s*Max-Age=0(;|$)/i.test(line) || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.jar.delete(name);
  }

  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function setCookieNamed(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}
