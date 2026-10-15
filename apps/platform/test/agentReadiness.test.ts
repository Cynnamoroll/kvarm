/**
 * What an agent finds on a deployment (services/agentDiscovery.ts): the
 * discovery files, the Markdown twin of the home page, head metadata, Link
 * headers and readable 404s. Each file is fetchable without credentials or
 * JavaScript and names absolute URLs built from APP_ORIGIN.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@kvarm/ops';
import { newSessionPayload, sessionCookie } from '../src/auth/workos';
import { toUserRow } from '../src/db/users';
import { SITEMAP_REPO_LIMIT, sitemapSql } from '../src/services/agentDiscovery';
import { call } from './helpers/http';
import { seedRepo, seedUser } from './helpers/seed';

const env = cfEnv as unknown as Env;

const origin = env.APP_ORIGIN.replace(/\/+$/, '');

beforeAll(async () => {
  await seedRepo(env, 'shown-in-sitemap', { owner: 'discovery-owner', visibility: 'public', register: false, pushedAt: Date.UTC(2026, 9, 1) });
  await seedRepo(env, 'hidden-from-sitemap', { owner: 'discovery-owner', visibility: 'private', register: false });
  // Pushed after the public repository: an unfiltered pushed_at index would
  // walk all twelve before the one row the sitemap lists (migration 0044).
  for (let i = 0; i < 12; i++) {
    await seedRepo(env, `sitemap-private-${String(i).padStart(2, '0')}`, {
      owner: 'discovery-owner',
      visibility: 'private',
      register: false,
      pushedAt: Date.UTC(2026, 9, 2 + i),
    });
  }
});

describe('discovery files', () => {
  it('llms.txt is a described Markdown index of absolute links', async () => {
    const res = await call(env, 'GET', '/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.text.startsWith('# ')).toBe(true);
    for (const path of ['/index.md', '/auth.md', '/openapi.json', '/.well-known/api-catalog', '/mcp']) {
      expect(res.text).toContain(`(${origin}${path})`);
    }
    expect((await call(env, 'GET', '/.well-known/llms.txt')).text).toBe(res.text);
  });

  it('every link llms.txt lists resolves', async () => {
    const { text } = await call(env, 'GET', '/llms.txt');
    const links = [...text.matchAll(/\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]!).filter((u) => u.startsWith(origin));
    expect(links.length).toBeGreaterThan(4);
    for (const link of links) {
      const path = link.slice(origin.length);
      // /mcp answers POST JSON-RPC; a GET without a session is a protocol error, not a missing page.
      if (path === '/mcp') continue;
      expect((await call(env, 'GET', path)).status, path).toBe(200);
    }
  });

  it('robots.txt closes the generated views and keeps landing and discovery pages open', async () => {
    const { text } = await call(env, 'GET', '/robots.txt');
    const disallows = [...text.matchAll(/^Disallow: (\S+)$/gm)].map((m) => m[1]!);
    expect(text).toMatch(/User-agent: \*\nAllow: \//);
    for (const disallow of ['/auth/', '/settings/', '/*/*/compare', '/*/*/commits', '/*/*/commit/', '/*/*/branches', '/*/*/tree/', '/*/*/blob/', '/*/*/raw/', '/*?'])
      expect(disallows, disallow).toContain(disallow);
    expect(text).toContain(`Sitemap: ${origin}/sitemap.xml`);
    // A robots.txt pattern matches a path prefix, `*` is any sequence and `?` is a
    // literal, so `/*?` closes every query-string variant while `/auth.md` stays
    // open beside the closed `/auth/`.
    const covers = (pattern: string, path: string) =>
      new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}`).test(path);
    const repo = '/discovery-owner/shown-in-sitemap';
    for (const closed of [
      `${repo}/compare/main...feature`,
      `${repo}/commits`,
      `${repo}/commit/abc123`,
      `${repo}/branches`,
      `${repo}/tree/main`,
      `${repo}/blob/main/README.md`,
      `${repo}/raw/main/README.md`,
      `${repo}/changes?state=open`,
    ])
      expect(disallows.some((d) => covers(d, closed)), closed).toBe(true);
    for (const open of ['/', '/llms.txt', '/index.md', '/auth.md', '/openapi.json', '/sitemap.xml', '/.well-known/llms.txt', repo])
      expect(disallows.some((d) => covers(d, open)), open).toBe(false);
  });

  it('sitemap.xml lists public repositories with lastmod and never private ones', async () => {
    const res = await call(env, 'GET', '/sitemap.xml');
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.text).toContain(`<loc>${origin}/</loc>`);
    expect(res.text).toContain(`<loc>${origin}/discovery-owner/shown-in-sitemap</loc><lastmod>2026-10-01T00:00:00.000Z</lastmod>`);
    expect(res.text).not.toContain('hidden-from-sitemap');
    expect(res.cost.d1).toBe(1);
    // Migration 0044's partial index bounds the read to the public rows it
    // lists; the twelve newer private rows are never walked to find them
    // (measured rr=1 here; 14 without the index).
    expect(res.cost.rr).toBeLessThanOrEqual(2);
  });

  it('the sitemap read walks the partial public index, not every pushed repository', async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sitemapSql}`).bind(SITEMAP_REPO_LIMIT).all<{ detail: string }>();
    const detail = (plan.results ?? []).map((r) => r.detail).join('\n');
    expect(detail).toContain('idx_repos_public_pushed');
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('llms.txt quotes the operation count of the OpenAPI document it serves', async () => {
    const { text } = await call(env, 'GET', '/llms.txt');
    const doc = await call(env, 'GET', '/openapi.json');
    const operations = Object.values(doc.json.paths as Record<string, Record<string, unknown>>).reduce(
      (total, item) => total + Object.keys(item).length,
      0,
    );
    expect(text).toContain(`(${operations} operations:`);
  });

  it('openapi.json describes the REST API with the deployment as its server', async () => {
    const res = await call(env, 'GET', '/openapi.json');
    expect(res.json.openapi).toBe('3.1.0');
    expect(res.json.servers).toEqual([{ url: origin }]);
    const ids = Object.values(res.json.paths as Record<string, Record<string, { operationId: string }>>).flatMap((item) =>
      Object.values(item).map((op) => op.operationId),
    );
    expect(ids).toContain('list_repos');
    expect(ids.length).toBe(new Set(OPERATIONS.map((op) => `${op.method} ${op.path}`)).size);
    expect(res.cost.d1).toBe(0);
  });

  it('the API catalog (RFC 9727) and the MCP server card point at the same contract', async () => {
    const catalog = await call(env, 'GET', '/.well-known/api-catalog');
    expect(catalog.headers.get('content-type')).toBe('application/linkset+json; charset=utf-8');
    expect(catalog.json.linkset[0]['service-desc'][0].href).toBe(`${origin}/openapi.json`);
    const card = await call(env, 'GET', '/.well-known/mcp/server-card.json');
    expect(card.json).toMatchObject({ name: 'Kvarm', transport: { type: 'streamable-http', url: `${origin}/mcp` }, tools: { count: OPERATIONS.length } });
  });

  it('auth.md walks through discover, methods, use, errors and revocation', async () => {
    const { text } = await call(env, 'GET', '/auth.md');
    expect(text.startsWith('---\ntitle: ')).toBe(true);
    for (const heading of ['## Discover', '## Pick a method', '## Register and claim', '## Use', '## Errors', '## Revoke']) expect(text).toContain(heading);
  });
});

describe('home page for agents', () => {
  it('serves Markdown at the same URL when asked, varying on Accept', async () => {
    const md = await call(env, 'GET', '/', { headers: { accept: 'text/markdown' } });
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('vary')).toBe('Accept');
    expect(md.text).toContain('## For agents');
    expect(md.text).toContain('```sh');
    expect(md.text.match(/```/g)!.length % 2).toBe(0);
    const page = await call(env, 'GET', '/', { headers: { accept: 'text/html,*/*;q=0.8' } });
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('vary')).toBe('Accept');
    expect((await call(env, 'GET', '/index.md')).text).toBe(md.text);
  });

  it('keeps HTML for browsers and plain fetches', async () => {
    for (const accept of [undefined, '*/*', 'text/html,text/markdown;q=0.5']) {
      const res = await call(env, 'GET', '/', { headers: accept ? { accept } : {} });
      expect(res.headers.get('content-type'), accept).toBe('text/html; charset=utf-8');
    }
  });

  it('carries identity metadata, a Markdown alternate, JSON-LD and discovery links', async () => {
    const res = await call(env, 'GET', '/');
    expect(res.text).toContain('<html lang="en"');
    expect(res.text).toContain(`<link rel="canonical" href="${origin}/">`);
    expect(res.text).toContain('<link rel="alternate" type="text/markdown" href="/index.md">');
    expect(res.text).toMatch(/<meta name="description" content="[^"]+">/);
    for (const property of ['og:type', 'og:title', 'og:description', 'og:url', 'og:image']) expect(res.text).toContain(`property="${property}"`);
    const ld = /<script type="application\/ld\+json">([^<]+)<\/script>/.exec(res.text);
    expect(JSON.parse(ld![1]!)['@graph'].map((n: { '@type': string }) => n['@type'])).toEqual(['WebSite', 'SoftwareApplication']);
    expect(res.headers.get('link')).toContain('</llms.txt>; rel="describedby"');
    expect(res.headers.get('link')).toContain('</openapi.json>; rel="service-desc"');
  });

  it('renders ?mode=agent on the server so a client without JavaScript gets the agent view', async () => {
    const res = await call(env, 'GET', '/?mode=agent');
    expect(res.text).toContain('<html lang="en" class="k-app" data-mode="agent">');
    expect(res.text).toContain('href="/llms.txt"');
  });
});

describe('404s', () => {
  it('are Markdown for agents, with links onward', async () => {
    const res = await call(env, 'GET', '/no-such/page/at-all');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.text).toContain('# 404');
    expect(res.text).toContain(`${origin}/llms.txt`);
    expect(res.cost.d1).toBe(0);
  });

  it('are a page for browsers', async () => {
    const res = await call(env, 'GET', '/no-such/page/at-all', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('404 · Not found');
    // No session cookie: the page renders without reading the session.
    expect(res.cost.d1).toBe(0);
  });

  it('the browser 404 reads the session only when a cookie is presented', async () => {
    const authEnv = {
      ...(env as unknown as Env),
      WORKOS_CLIENT_ID: 'client_fake',
      WORKOS_API_KEY: 'sk_fake_not_a_real_key',
      WORKOS_COOKIE_PASSWORD: 'test-cookie-password-0123456789abcdef',
    } as Env;
    const id = await seedUser(authEnv, 'notfound-session');
    const row = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Parameters<typeof toUserRow>[0]>();
    const payload = newSessionPayload(toUserRow(row!), {
      user: { id: row!.workos_user_id, email: row!.email, emailVerified: true, name: null, avatarUrl: null },
      refreshToken: 'rt_unused',
      sessionId: null,
    });
    const cookie = (await sessionCookie(authEnv, payload)).split(';')[0]!;
    const res = await call(authEnv, 'GET', '/no-such/page/at-all', { headers: { cookie, accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.text).toContain('404 · Not found');
    // One session read: the user plus the revocation check (d1=1;rr=1).
    expect(res.cost.d1).toBe(1);
  });

  it('are JSON under the API', async () => {
    const res = await call(env, 'GET', '/api/v1/no-such-route/x/y');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not found', code: 'NOT_FOUND' });
    expect(res.cost.d1).toBe(0);
  });
});
