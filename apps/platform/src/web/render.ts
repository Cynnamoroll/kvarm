/** Shared server-rendered shell for signed-in and signed-out pages. */

import { escapeHtml, html, raw } from '@kvarm/ui';
import { siteName } from '../config';

const CRITICAL_CSS = raw(`
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--void,#050608);color:var(--bone,#e8e9e8);font-family:var(--f-sans,'Archivo',system-ui,sans-serif)}
`);

export interface PageOptions {
  title?: string;
  /** Signed-in login, when present. */
  userLogin?: string | null;
  /** Extra <head> content. */
  head?: string;
  /** Inline script module source (deferred). */
  script?: string;
  scriptUrl?: string;
  stylesheets?: string[];
  bodyClass?: string;
  landing?: boolean;
  active?: 'home' | 'fleet' | 'tokens';
  needsYouCount?: number;
  runningCount?: number;
  repos?: Array<{ ownerLogin: string; name: string }>;
}

export function publicOrigin(env: Env): string | null {
  const configured = env.APP_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Hidden CSRF field for a session's state-changing forms; empty without a session. */
export function csrfInput(token: string | null | undefined): string {
  return token ? `<input type="hidden" name="_csrf" value="${escapeHtml(token)}" />` : '';
}

export function layout(env: Env, opts: PageOptions, body: string): string {
  return renderShell(env, opts, body);
}

export interface AppLayoutOptions extends PageOptions {
  userId?: string | null;
}

export async function appLayout(env: Env, opts: AppLayoutOptions, body: string): Promise<string> {
  let needsYouCount = opts.needsYouCount;
  let runningCount = opts.runningCount;
  if (opts.userId && (opts.needsYouCount === undefined || opts.runningCount === undefined)) {
    const counts = await env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM sandboxes
         WHERE owner_user_id = ? AND status IN ('running', 'starting')) AS running,
        (SELECT COUNT(*) FROM sandbox_approvals a
         JOIN sandboxes s ON s.id = a.sandbox_id
         WHERE s.owner_user_id = ? AND a.status = 'pending' AND a.expires_at > ?) AS approvals`,
    )
      .bind(opts.userId, opts.userId, Date.now())
      .first<{ running: number; approvals: number }>();
    if (opts.runningCount === undefined) runningCount = Number(counts?.running ?? 0);
    if (opts.needsYouCount === undefined) needsYouCount = Number(counts?.approvals ?? 0);
  }
  return renderShell(env, { ...opts, needsYouCount, runningCount }, body);
}

function renderShell(env: Env, opts: PageOptions, body: string): string {
  const name = siteName(env);
  const login = opts.userLogin?.trim() ?? '';
  const signedIn = login.length > 0;
  const initial = login.slice(0, 1).toUpperCase() || '?';
  const origin = publicOrigin(env);
  const previewImage = origin ? `${origin}/assets/brand/og.png` : null;
  const repoLinks = (opts.repos ?? [])
    .map(
      (repo) =>
        html`<a href="${raw(`/${encodeURIComponent(repo.ownerLogin)}/${encodeURIComponent(repo.name)}`)}"><span class="k-mono">${repo.ownerLogin}/${repo.name}</span></a>`,
    )
    .join('');
  const active = (page: PageOptions['active']) => (opts.active === page ? 'aria-current="page"' : '');
  const needsYou = opts.needsYouCount === undefined ? '' : html`<b>${opts.needsYouCount}</b>`;
  const running = opts.runningCount === undefined ? '' : html`<span class="n">${opts.runningCount}</span>`;
  const landingNav = opts.landing
    ? html`<nav class="k-landing-nav" aria-label="On this page">
        <a href="#how">How it works</a><a href="#product">Product</a><a href="#agents">Agents</a>
      </nav>`
    : '';
  const mode = opts.landing
    ? html`<div class="mode" role="group" aria-label="Show this page for">
        <button type="button" data-mode-set="human" aria-pressed="true"><svg aria-hidden="true"><use href="#g-node"/></svg>Human</button>
        <button type="button" data-mode-set="agent" aria-pressed="false"><svg aria-hidden="true"><use href="#g-x"/></svg>Agent</button>
      </div>`
    : '';
  const headStyles = (opts.stylesheets ?? [])
    .map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`)
    .join('\n');
  const customScripts = [
    opts.scriptUrl ? `<script src="${escapeHtml(opts.scriptUrl)}" type="module"></script>` : '',
    opts.script ? `<script type="module" defer>${opts.script}</script>` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const header = signedIn
    ? html`<header class="k-top">
        <a class="brand" href="/" aria-label="${name} home"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><img class="wordmark-sm" src="/assets/brand/wordmark.svg" alt="" /></a>
        <div class="k-mid"><div class="k-ws"><i>${initial}</i><span>${login}</span></div></div>
        <div class="k-right">
          <a class="k-needs" href="/fleet#approvals"><span>Needs you</span>${raw(needsYou)}</a>
          <div class="mode" role="group" aria-label="Show this app for">
            <button type="button" data-mode-set="human" aria-pressed="true"><svg aria-hidden="true"><use href="#g-node"/></svg>Human</button>
            <button type="button" data-mode-set="agent" aria-pressed="false"><svg aria-hidden="true"><use href="#g-x"/></svg>Agent</button>
          </div>
          <a class="k-me" href="/auth/logout" aria-label="Sign out">${initial}</a>
        </div>
      </header>`
    : html`<header class="k-top k-top-slim">
        <a class="brand" href="/" aria-label="${name} home"><svg class="mark" aria-hidden="true"><use href="#mark"/></svg><img class="wordmark-sm" src="/assets/brand/wordmark.svg" alt="" /></a>
        ${raw(landingNav)}<div class="k-right">${raw(mode)}<a class="btn btn-primary k-signin" href="/auth/login">Sign in</a></div>
      </header>`;
  const content = signedIn
    ? html`<div class="k-shell">
        <aside class="k-rail" aria-label="App">
          <nav>
            <a href="/" ${raw(active('home'))}><svg aria-hidden="true"><use href="#g-reticle"/></svg>Home</a>
            <a href="/fleet" ${raw(active('fleet'))}><svg aria-hidden="true"><use href="#g-node"/></svg>Fleet${raw(running)}</a>
            <a href="/settings/tokens" ${raw(active('tokens'))}><svg aria-hidden="true"><use href="#g-x"/></svg>Tokens &amp; agents</a>
          </nav>
          ${repoLinks ? raw(html`<div class="k-repos"><h4 class="hud">Repos</h4>${raw(repoLinks)}</div>`) : ''}
          <div class="k-foot"><p class="hud">Signed in via WorkOS</p></div>
        </aside>
        <main class="k-main" id="main">${raw(body)}</main>
      </div>`
    : html`<main class="k-main" id="main">${raw(body)}</main>`;
  const bodyClass = ['k-app', opts.bodyClass].filter(Boolean).join(' ');

  return html`<!DOCTYPE html>
<html lang="en" class="k-app">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title ? `${opts.title} · ${name}` : name}</title>
<script>{const q=new URLSearchParams(location.search).get("mode");let m=q;try{m=m||localStorage.getItem("kvarm-mode")}catch{}document.documentElement.dataset.mode=m==="agent"?"agent":"human"}</script>
<style>${raw(CRITICAL_CSS.value)}</style>
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/app.css">
<link rel="stylesheet" href="/assets/console.css">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/site.webmanifest">
<meta name="theme-color" content="#050608">
${previewImage ? html`<meta property="og:image" content="${previewImage}">` : ''}
${raw(headStyles)}
${raw(opts.head ?? '')}
<script src="/assets/mode.js" type="module"></script>
${raw(customScripts)}
</head>
<body class="${bodyClass}">
<svg class="k-sprites" aria-hidden="true" width="0" height="0">
  <symbol id="mark" viewBox="0 0 48 48"><path fill="currentColor" d="M5 4h9v40H5zM28 18.5 42.5 4H48v5.5L33.5 24 48 38.5V44h-5.5L28 29.5 33.5 24z"/><path d="M23 17.5 29.5 24 23 30.5 16.5 24z" style="fill:var(--node,var(--signal))"/></symbol>
  <symbol id="g-node" viewBox="0 0 5 5"><path fill="currentColor" d="M1 0h3v1H1zM0 1h1v3H0zM4 1h1v3H4zM1 4h3v1H1zM2 2h1v1H2z"/></symbol>
  <symbol id="g-x" viewBox="0 0 5 5"><path fill="currentColor" d="M0 0h1v1H0zM4 0h1v1H4zM1 1h1v1H1zM3 1h1v1H3zM2 2h1v1H2zM1 3h1v1H1zM3 3h1v1H3zM0 4h1v1H0zM4 4h1v1H4z"/></symbol>
  <symbol id="g-reticle" viewBox="0 0 24 24"><g fill="none" stroke="currentColor"><circle cx="12" cy="12" r="10.5"/><path d="M12 0v4M12 20v4M0 12h4M20 12h4M12 10v4M10 12h4"/></g></symbol>
</svg>
<p class="sr" id="mode-status" role="status" aria-live="polite"></p>
${raw(header)}
${raw(content)}
</body>
</html>`;
}
