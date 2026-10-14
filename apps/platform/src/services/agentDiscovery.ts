/**
 * The documents agents read to discover and use a deployment: llms.txt, the
 * Markdown twin of the home page, auth.md, robots.txt, sitemap.xml, the
 * RFC 9727 API catalog and the MCP server card. Every URL is absolute and
 * built from APP_ORIGIN, like clone URLs, so a deployment describes itself.
 * The same facts are visible on the server-rendered home page; these files
 * only make them cheaper to find and read.
 */

import { OPERATIONS } from '@kvarm/ops';
import { appOrigin, siteName } from '../config';
import { MCP_SERVER_INFO } from '../mcp/server';

/** Public repositories listed in sitemap.xml: one bounded, indexed D1 read. */
export const SITEMAP_REPO_LIMIT = 1000;

export const SUMMARY =
  'A git platform for teams of people and coding agents, on Cloudflare Artifacts: git smart-HTTP, a versioned REST API, an MCP server and server-rendered pages from one Cloudflare Worker.';

const SOURCE_URL = 'https://github.com/kvarm-git/kvarm';

function families(): string {
  return [...new Set(OPERATIONS.map((op) => op.family))].join(', ');
}

/** `/llms.txt`: a lean, described index of what an agent can read and call. */
export function llmsTxt(env: Env): string {
  const o = appOrigin(env);
  return `# ${siteName(env)}

> ${SUMMARY}

Use ${siteName(env)} when an agent needs to push code, open and review changes, run CI, merge through a queue, or coordinate with other agents (workspaces, declared intents, tasks) on a git host. It calls no hosted model.

## Start here

- [Home (Markdown)](${o}/index.md): what this deployment is and how people and agents use it
- [Authentication](${o}/auth.md): personal access tokens and repository-scoped agent tokens, scopes and revocation

## API

- [OpenAPI](${o}/openapi.json): the full REST contract under /api/v1 (${OPERATIONS.length} operations: ${families()})
- [API catalog](${o}/.well-known/api-catalog): RFC 9727 linkset for the REST API
- [MCP server](${o}/mcp): Streamable HTTP; every REST operation is a tool with the same name as its OpenAPI operationId
- [MCP server card](${o}/.well-known/mcp/server-card.json): transport, authentication and tool count

## Git

- Clone or push over smart HTTP: \`git clone ${o}/<owner>/<repo>.git\` with a token as the password
- Agent workspaces push to \`refs/heads/agents/<workspaceId>/<slug>\`; \`refs/heads/agents/**\` and \`refs/heads/kvarm-ci/**\` are platform-reserved

## Optional

- [Source and CLI](${SOURCE_URL}): the \`kvarm\` CLI, self-hosting and the architecture document
- [Sitemap](${o}/sitemap.xml): the public pages of this deployment
`;
}

/** `/index.md` and `GET /` with `Accept: text/markdown`: the home page as Markdown. */
export function homeMarkdown(env: Env): string {
  const o = appOrigin(env);
  return `---
title: ${siteName(env)}
description: ${SUMMARY}
canonical: ${o}/
---

# ${siteName(env)}: git for people and their agents

${SUMMARY}

## For people

Create repositories, import them over HTTPS, open changes and review them, and merge through a queue that runs the checks on the exact tree. Sign in at [${o}/auth/login](${o}/auth/login), or use a personal access token for git over HTTPS, the REST API and MCP.

## For agents

1. Get a token: see [${o}/auth.md](${o}/auth.md).
2. Read the contract: [${o}/openapi.json](${o}/openapi.json), or connect an MCP client to \`${o}/mcp\`.
3. Act. For example, list your repositories:

\`\`\`sh
curl -H "Authorization: Bearer $KVARM_PAT" ${o}/api/v1/repos
\`\`\`

Or with the CLI:

\`\`\`sh
export KVARM_BASE_URL=${o}
export KVARM_PAT=kvarm_pat_...
npx kvarm repo list
npx kvarm status <owner>/<repo>
\`\`\`

Agents work in workspaces (server-side refs under \`refs/heads/agents/\`), declare intents so overlapping work is reported before it is written, claim tasks, and open changes that run \`kvarm/guard\`, CI and the merge queue.

## Links

- [llms.txt](${o}/llms.txt)
- [OpenAPI](${o}/openapi.json)
- [Authentication](${o}/auth.md)
- [Source](${SOURCE_URL})
`;
}

/** schema.org facts for the home page; each also appears as visible text on the page or in llms.txt. */
export function homeJsonLd(env: Env, origin: string) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: siteName(env), url: `${origin}/`, description: SUMMARY },
      {
        '@type': 'SoftwareApplication',
        name: siteName(env),
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Cloudflare Workers',
        description: SUMMARY,
        url: `${origin}/`,
        license: 'https://opensource.org/licenses/MIT',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: [SOURCE_URL],
        softwareHelp: `${origin}/llms.txt`,
      },
    ],
  };
}

/** `/auth.md`: how an agent gets and uses credentials. */
export function authMd(env: Env): string {
  const o = appOrigin(env);
  return `---
title: Authenticating to ${siteName(env)}
description: Personal access tokens and repository-scoped agent tokens for git, the REST API and MCP.
canonical: ${o}/auth.md
---

# Authenticating to ${siteName(env)}

## Discover

Every authenticated surface (git smart HTTP, \`${o}/api/v1\`, \`${o}/mcp\`) accepts the same bearer tokens. Public repositories are readable without one. The contract is at [${o}/openapi.json](${o}/openapi.json).

## Pick a method

| token | prefix | for |
| --- | --- | --- |
| Personal access token | \`kvarm_pat_\` | a person, or an agent acting as that person; scopes \`read\`, \`write\`, \`api\`, \`ci\` |
| Agent token | \`kvarm_agt_\` | one agent principal on one repository, with a role (\`read\` or \`write\`), ref patterns it may push (for example \`refs/heads/agents/*\`) and an expiry |

Prefer an agent token: it is limited to one repository, the refs it may update and a lifetime, and it is further capped by the current role of the person who minted it.

## Register and claim

A person signs in at [${o}/auth/login](${o}/auth/login) and creates tokens at [${o}/settings/tokens](${o}/settings/tokens). Agent principals are created with \`POST /api/v1/agents\` (\`kvarm agents create\`) and receive tokens from a person who can manage them. Tokens are shown once, at creation. Agent credentials cannot create agents or mint tokens.

## Use

\`\`\`sh
curl -H "Authorization: Bearer $TOKEN" ${o}/api/v1/user
git clone https://x-token:$TOKEN@${new URL(o).host}/<owner>/<repo>.git
\`\`\`

MCP clients send the same \`Authorization: Bearer\` header to \`${o}/mcp\`.

## Errors

Errors are JSON: \`{"error": "...", "code": "..."}\`. \`401 UNAUTHENTICATED\` means no valid token; \`403\` means the token lacks the scope, role or ref pattern; a private repository you cannot read answers \`404\`, exactly like a missing one. \`429\` carries \`Retry-After\`.

## Revoke

Revoke a personal access token at [${o}/settings/tokens](${o}/settings/tokens); agents and agent tokens are revoked from the same page or the API. Revocation applies to the next request.
`;
}

export function robotsTxt(env: Env): string {
  return `# Public pages, the API description and the discovery files are open to every crawler and agent.
User-agent: *
Allow: /
Disallow: /auth/
Disallow: /settings/

Sitemap: ${appOrigin(env)}/sitemap.xml
`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function sitemapXml(env: Env): Promise<string> {
  const o = appOrigin(env);
  const { results } = await env.DB.prepare(
    `SELECT owner_login, name, pushed_at, created_at FROM repos WHERE visibility = 'public'
      ORDER BY pushed_at DESC LIMIT ?1`,
  )
    .bind(SITEMAP_REPO_LIMIT)
    .all<{ owner_login: string; name: string; pushed_at: number | null; created_at: number }>();
  const url = (loc: string, lastmod?: number | null) =>
    `  <url><loc>${xmlEscape(loc)}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}</url>`;
  const entries = [
    url(`${o}/`),
    url(`${o}/llms.txt`),
    url(`${o}/auth.md`),
    ...(results ?? []).map((r) =>
      url(`${o}/${encodeURIComponent(r.owner_login)}/${encodeURIComponent(r.name)}`, r.pushed_at ?? r.created_at),
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join('\n')}
</urlset>
`;
}

/** RFC 9727 `/.well-known/api-catalog` (an RFC 9264 linkset). */
export function apiCatalog(env: Env) {
  const o = appOrigin(env);
  return {
    linkset: [
      {
        anchor: `${o}/api/v1`,
        'service-desc': [{ href: `${o}/openapi.json`, type: 'application/vnd.oai.openapi+json;version=3.1' }],
        'service-doc': [{ href: `${o}/llms.txt`, type: 'text/markdown' }],
        'service-meta': [{ href: `${o}/auth.md`, type: 'text/markdown' }],
      },
    ],
  };
}

/** `/.well-known/mcp/server-card.json`: what the MCP server is before an agent connects. */
export function mcpServerCard(env: Env) {
  const o = appOrigin(env);
  return {
    name: MCP_SERVER_INFO.name,
    version: MCP_SERVER_INFO.version,
    description: SUMMARY,
    transport: { type: 'streamable-http', url: `${o}/mcp` },
    authentication: { type: 'bearer', description: 'kvarm_pat_… or kvarm_agt_… token', documentation: `${o}/auth.md` },
    tools: { count: OPERATIONS.length, contract: `${o}/openapi.json` },
    documentation: `${o}/llms.txt`,
  };
}

/** Markdown body of a 404: agents read what happened and where to go next. */
export function notFoundMarkdown(env: Env, path: string): string {
  const o = appOrigin(env);
  return `# 404: not found

Nothing is published at \`${path}\` on ${siteName(env)}. A private repository you cannot read also answers 404.

- [Home](${o}/)
- [llms.txt](${o}/llms.txt): what this site offers agents
- [OpenAPI](${o}/openapi.json): the REST API
`;
}

/**
 * True when the client asked for Markdown over HTML. A missing or wildcard
 * Accept keeps HTML, so browsers and plain fetches see the page.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) return false;
  let md = -1;
  let htmlQ = -1;
  for (const part of accept.split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    const qParam = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!Number.isFinite(q)) continue;
    if (type === 'text/markdown' || type === 'text/x-markdown') md = Math.max(md, q);
    else if (type === 'text/html') htmlQ = Math.max(htmlQ, q);
  }
  return md > 0 && md >= htmlQ;
}

/** Link header advertising the discovery files on every HTML page (RFC 8288). */
export function discoveryLinkHeader(): string {
  return [
    '</llms.txt>; rel="describedby"; type="text/markdown"',
    '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
    '</.well-known/api-catalog>; rel="api-catalog"',
    '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  ].join(', ');
}
