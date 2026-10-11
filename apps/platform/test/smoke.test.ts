import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { METERED_BINDINGS } from '../src/cost/meter';

describe('worker smoke', () => {
  it('GET /healthz returns 200 ok', async () => {
    const res = await exports.default.fetch('https://forge.test/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
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
      ['CI_SANDBOX', 'MERGE_LOCK', 'RATE_LIMIT', 'TOKENS'],
    );
  });

  it('serves the API against real D1', async () => {
    const res = await exports.default.fetch('https://forge.test/api/v1/user');
    expect(res.status).toBe(401);
  });
});
