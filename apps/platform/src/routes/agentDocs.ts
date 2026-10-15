/**
 * Agent discovery files (services/agentDiscovery.ts): thin adapters that set
 * the content type. None reads repository content; only sitemap.xml touches
 * D1 (one bounded read of public repositories).
 */

import { Hono } from 'hono';
import { openApiDocument } from '@kvarm/ops/openapi';
import { appOrigin, siteName } from '../config';
import * as discovery from '../services/agentDiscovery';
import type { App } from './api';

export const agentDocs = new Hono<App>();

const MARKDOWN = 'text/markdown; charset=utf-8';
// Short shared caching: these change only with a deploy or a new public repository.
const CACHE = 'public, max-age=300';

function text(body: string, type: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { headers: { 'content-type': type, 'cache-control': CACHE, ...extra } });
}

agentDocs.get('/llms.txt', (c) => text(discovery.llmsTxt(c.env), MARKDOWN));
agentDocs.get('/.well-known/llms.txt', (c) => text(discovery.llmsTxt(c.env), MARKDOWN));
agentDocs.get('/index.md', (c) => text(discovery.homeMarkdown(c.env), MARKDOWN));
agentDocs.get('/auth.md', (c) => text(discovery.authMd(c.env), MARKDOWN));
agentDocs.get('/robots.txt', (c) => text(discovery.robotsTxt(c.env), 'text/plain; charset=utf-8'));
agentDocs.get('/sitemap.xml', async (c) => text(await discovery.sitemapXml(c.env), 'application/xml; charset=utf-8'));
agentDocs.get('/openapi.json', (c) =>
  text(JSON.stringify(openApiDocument({ origin: appOrigin(c.env), title: `${siteName(c.env)} REST API` })), 'application/json; charset=utf-8'),
);
agentDocs.get('/.well-known/api-catalog', (c) =>
  text(JSON.stringify(discovery.apiCatalog(c.env)), 'application/linkset+json; charset=utf-8'),
);
agentDocs.get('/.well-known/mcp/server-card.json', (c) =>
  text(JSON.stringify(discovery.mcpServerCard(c.env)), 'application/json; charset=utf-8'),
);
