import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { METERED_BINDINGS } from '../src/cost/meter';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import { call } from './helpers/http';
import { seedUser } from './helpers/seed';

describe('worker smoke', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await exports.default.fetch('https://kvarm.test/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET / serves the landing page with its stylesheet, not API JSON (signed out)', async () => {
    const res = await call(env as unknown as Env, 'GET', '/', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    // Heuristic caches must not replay the signed-out page on Back after sign-in.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.text).toContain('<body class="k-app k-landing">');
    expect(res.text).toContain('/assets/landing.css');
    expect(res.text).toContain('href="/auth/login">Sign in</a>');
  });

  it('GET / serves the signed-in home on the app shell to a session cookie', async () => {
    const authEnv = {
      ...(env as unknown as Env),
      WORKOS_CLIENT_ID: 'client_fake',
      WORKOS_API_KEY: 'sk_fake_not_a_real_key',
      WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
    } as Env;
    const id = await seedUser(authEnv, 'smoke-home');
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Parameters<typeof toUserRow>[0]>();
    const payload = newSessionPayload(toUserRow(row!), {
      user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
      refreshToken: 'rt_unused',
      sessionId: null,
    });
    const cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
    const res = await call(authEnv, 'GET', '/', { headers: { cookie, accept: 'text/html' } });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<aside class="k-rail"');
    expect(res.text).toContain('Signed in as smoke-home');
    expect(res.text).toContain('Signed in via WorkOS');
    expect(res.text).not.toContain('k-landing');
  });

  it('serves the assets both shells link', async () => {
    for (const [path, type] of [
      ['/assets/tokens.css', 'text/css'],
      ['/assets/app.css', 'text/css'],
      ['/assets/console.css', 'text/css'],
      ['/assets/landing.css', 'text/css'],
      ['/assets/mode.js', 'javascript'],
      ['/assets/live.js', 'javascript'],
      ['/assets/landing.js', 'javascript'],
      ['/assets/brand/wordmark.svg', 'image/svg+xml'],
    ] as const) {
      const res = await exports.default.fetch(`https://kvarm.test${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain(type);
    }
  });

  it('applies D1 migrations before tests run', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const tables = results.map((r) => r.name);
    for (const t of ['users', 'pat', 'repos', 'change_sets', 'check_runs', 'events']) {
      expect(tables).toContain(t);
    }
  });

  it('carries no unused RealtimeHub Durable Object class or binding', async () => {
    const worker = (await import('../src/index')) as Record<string, unknown>;
    expect(worker).not.toHaveProperty('RealtimeHub');
    expect(METERED_BINDINGS).not.toHaveProperty('REALTIME');
    expect((env as unknown as Record<string, unknown>).REALTIME).toBeUndefined();
    expect(Object.keys(METERED_BINDINGS).filter((name) => METERED_BINDINGS[name] === 'do').sort()).toEqual(
      ['AGENT_SANDBOX', 'CI_SANDBOX', 'ENV_BUILDER', 'MERGE_LOCK', 'RATE_LIMIT', 'REPO_EVENTS', 'TOKENS'],
    );
  });

  it('serves the API against real D1', async () => {
    const res = await exports.default.fetch('https://kvarm.test/api/v1/user');
    expect(res.status).toBe(401);
  });
});
