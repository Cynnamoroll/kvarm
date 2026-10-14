/**
 * What an agent finds on a deployment (services/agentDiscovery.ts): the
 * discovery files, the Markdown twin of the home page, head metadata, Link
 * headers and readable 404s. Each file is fetchable without credentials or
 * JavaScript and names absolute URLs built from APP_ORIGIN.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS } from '@kvarm/ops';
import { call } from './helpers/http';
import { seedRepo } from './helpers/seed';

const env = cfEnv as unknown as Env;

const origin = env.APP_ORIGIN.replace(/\/+$/, '');

beforeAll(async () => {
  await seedRepo(env, 'shown-in-sitemap', { owner: 'discovery-owner', visibility: 'public', register: false, pushedAt: Date.UTC(2026, 9, 1) });
  await seedRepo(env, 'hidden-from-sitemap', { owner: 'discovery-owner', visibility: 'private', register: false });
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

  it('robots.txt allows crawling and names the sitemap', async () => {
    const res = await call(env, 'GET', '/robots.txt');
    expect(res.text).toMatch(/User-agent: \*\nAllow: \//);
    expect(res.text).toContain(`Sitemap: ${origin}/sitemap.xml`);
  });

  it('sitemap.xml lists public repositories with lastmod and never private ones', async () => {
    const res = await call(env, 'GET', '/sitemap.xml');
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.text).toContain(`<loc>${origin}/</loc>`);
    expect(res.text).toContain(`<loc>${origin}/discovery-owner/shown-in-sitemap</loc><lastmod>2026-10-01T00:00:00.000Z</lastmod>`);
    expect(res.text).not.toContain('hidden-from-sitemap');
    expect(res.cost.d1).toBe(1);
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
  });

  it('are a page for browsers', async () => {
    const res = await call(env, 'GET', '/no-such/page/at-all', { headers: { accept: 'text/html' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('404 · Not found');
  });

  it('are JSON under the API', async () => {
    const res = await call(env, 'GET', '/api/v1/no-such-route/x/y');
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not found', code: 'NOT_FOUND' });
  });
});
