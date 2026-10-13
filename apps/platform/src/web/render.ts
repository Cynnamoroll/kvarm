/**
 * Streaming-ready HTML shell. One static stylesheet (zero-runtime CSS, the
 * GitHub CSS-modules lesson applied from day one); critical CSS is inlined
 * so first paint never blocks on a round-trip. Kept intentionally small.
 */

import { escapeHtml, raw } from '@kvarm/ui';
import { siteName } from '../config';

const CRITICAL_CSS = raw(`
:root{--bg:#0d1117;--bg-raised:#161b22;--bg-inset:#010409;--border:#30363d;--fg:#e6edf3;--fg-muted:#9198a1;--accent:#3fb950;--danger:#f85149;--link:#58a6ff;--radius:6px;--mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1012px;margin:0 auto;padding:16px}
.topbar{border-bottom:1px solid var(--border);background:var(--bg-raised)}
.topbar .wrap{display:flex;align-items:center;gap:12px;padding-top:10px;padding-bottom:10px}
.brand{font-weight:700;color:var(--fg)}
.spacer{flex:1}
.card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-raised);padding:16px;margin:12px 0}
.btn{display:inline-block;background:#21262d;border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:5px 14px;font-size:14px;cursor:pointer}
.btn:hover{background:#30363d}
.btn.primary{background:var(--accent-fg,#1f6feb);border-color:#1f6feb;color:#fff}
input[type=text],input[type=url],select{width:100%;background:var(--bg-inset);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);padding:6px 10px;font-size:14px}
label{display:block;font-size:12px;color:var(--fg-muted);margin:10px 0 4px}
.muted{color:var(--fg-muted)}
pre{background:var(--bg-inset);border:1px solid var(--border);border-radius:var(--radius);padding:12px;overflow:auto}
code{font-family:var(--mono);font-size:12px}
.repo-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.repo-row:last-child{border-bottom:0}
.badge{border:1px solid var(--border);border-radius:20px;padding:0 8px;font-size:11px;color:var(--fg-muted)}
.flash{border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px;margin:12px 0}
.flash.ok{border-color:#238636;color:#3fb950}
.flash.err{border-color:var(--danger);color:var(--danger)}
`);

export interface PageOptions {
  title?: string;
  /** Signed-in login, when present. */
  userLogin?: string | null;
  /** Extra <head> content. */
  head?: string;
  /** Inline script module source (deferred). */
  script?: string;
}

function publicOrigin(env: Env): string | null {
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

export function layout(env: Env, opts: PageOptions, body: string): string {
  const name = siteName(env);
  const origin = publicOrigin(env);
  const previewImage = origin ? `${origin}/assets/brand/og.png` : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title ? `${opts.title} · ${name}` : name)}</title>
<style>${CRITICAL_CSS.value}</style>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/favicon.ico" sizes="32x32">
<link rel="icon" href="/assets/brand/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/brand/apple-touch-icon.png">
<link rel="manifest" href="/assets/brand/site.webmanifest">
<meta name="theme-color" content="#050608">
${previewImage ? `<meta property="og:image" content="${escapeHtml(previewImage)}">
` : ''}
${opts.head ?? ''}
${opts.script ? `<script type="module" defer>${opts.script}</script>` : ''}
</head>
<body>
<header class="topbar">
  <div class="wrap">
    <a class="brand" href="/">${escapeHtml(name)}</a>
    <span class="spacer"></span>
    ${
      opts.userLogin
        ? `<a href="/${escapeHtml(opts.userLogin)}">${escapeHtml(opts.userLogin)}</a>
           <a href="/settings/tokens">Tokens</a>
           <a href="/auth/sign-out">Sign out</a>`
        : '<a href="/auth/sign-in">Sign in</a>'
    }
  </div>
</header>
<main class="wrap">
${body}
</main>
</body>
</html>`;
}
