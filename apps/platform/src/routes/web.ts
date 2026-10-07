/**
 * M1 web surface: just enough to sign in, create/import a repo, mint a PAT,
 * and see the clone URL. M2 replaces the repo page with the real SSR tree
 * browser; these pages are intentionally plain (the CSS system lands with it).
 */

import { Hono, type Context } from 'hono';
import { escapeHtml, html, timeAgo } from '@forge/ui';
import { getRepo, listReposForOwner } from '../db/repos';
import { findOrCreateUser, type UserRow } from '../db/users';
import { getSessionInfo, type SessionInfo } from '../auth/workos';
import { layout } from '../web/render';
import { apiActor } from './api';
import * as svc from '../repos/service';

type App = { Bindings: Env; Variables: { refreshCookies: string[] } };
export const web = new Hono<App>();

interface PageCtx {
  session: SessionInfo | null;
  user: UserRow | null;
}

/** Narrowed context for routes that require a signed-in session. */
interface AuthedPageCtx {
  session: SessionInfo;
  user: UserRow;
}

/** Session + lazily-provisioned platform user for a request. */
async function pageCtx(c: Context<App>): Promise<PageCtx> {
  const session = await getSessionInfo(c.req.raw, c.env);
  if (!session) return { session: null, user: null };
  const user = await findOrCreateUser(c.env, session.user);
  return { session, user };
}

/** Attach refreshed session cookies (if any) to a page response. */
function withCookies(res: Response, ctx: PageCtx): Response {
  for (const cookie of ctx.session?.refreshCookies ?? []) {
    res.headers.append('Set-Cookie', cookie);
  }
  return res;
}

function page(c: Context<App>, ctx: PageCtx, title: string, body: string, status = 200): Response {
  return withCookies(
    new Response(layout(c.env, { title, userLogin: ctx.user?.login ?? null }, body), {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    ctx,
  );
}

function requireSessionPage(c: Context<App>): Promise<AuthedPageCtx | Response> | never;
async function requireSessionPage(c: Context<App>): Promise<AuthedPageCtx | Response> {
  const ctx = await pageCtx(c);
  if (!ctx.session || !ctx.user) {
    return c.redirect(`/auth/sign-in?returnTo=${encodeURIComponent(new URL(c.req.url).pathname)}`);
  }
  return ctx as AuthedPageCtx;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

web.get('/', async (c) => {
  const ctx = await pageCtx(c);
  let body: string;
  if (!ctx.user) {
    body = html`
      <div class="card">
        <h1>${escapeHtml(c.env.SITE_NAME || 'Forge')}</h1>
        <p class="muted">A git platform for the agentic era, on Cloudflare Artifacts.</p>
        <p><a class="btn primary" href="/auth/sign-in">Sign in to get started</a></p>
      </div>
    `;
  } else {
    const repos = await listReposForOwner(c.env.DB, ctx.user.login);
    const rows = repos
      .map(
        (r) => html`
          <div class="repo-row">
            <div>
              <a href="/${r.owner_login}/${r.name}"><strong>${r.owner_login}/${r.name}</strong></a>
              <span class="badge">${r.visibility}</span>
              <div class="muted">${r.description ?? ''}</div>
            </div>
            <div class="muted">${r.pushed_at ? timeAgo(r.pushed_at) : 'never pushed'}</div>
          </div>
        `,
      )
      .join('');
    body = html`
      <div class="card">
        <h2>New repository</h2>
        <form method="post" action="/new-repo">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" required placeholder="my-project" />
          <label for="description">Description</label>
          <input id="description" name="description" type="text" placeholder="optional" />
          <label for="visibility">Visibility</label>
          <select id="visibility" name="visibility">
            <option value="private">private</option>
            <option value="public">public</option>
          </select>
          <p><button class="btn primary" type="submit">Create</button></p>
        </form>
      </div>
      <div class="card">
        <h2>Import from HTTPS</h2>
        <form method="post" action="/import-repo">
          <label for="url">Remote URL</label>
          <input id="url" name="url" type="url" required placeholder="https://github.com/owner/repo" />
          <label for="iname">Name</label>
          <input id="iname" name="name" type="text" placeholder="defaults to remote name" />
          <p><button class="btn" type="submit">Import</button></p>
        </form>
      </div>
      <div class="card">
        <h2>Your repositories</h2>
        ${rows || '<p class="muted">none yet</p>'}
      </div>
    `;
  }
  return page(c, ctx, 'Home', body);
});

web.post('/new-repo', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const form = await c.req.parseBody();
  const result = await svc.createRepo(c.env, {
    ownerLogin: ctx.user.login,
    name: String(form.name ?? ''),
    description: String(form.description ?? '') || null,
    visibility: form.visibility === 'public' ? 'public' : 'private',
  });
  if (!result.ok) {
    return page(
      c,
      ctx,
      'Error',
      `<div class="flash err">${escapeHtml(result.error)}</div><a href="/">back</a>`,
      400,
    );
  }
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

web.post('/import-repo', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const form = await c.req.parseBody();
  const url = String(form.url ?? '');
  const result = await svc.importRepo(c.env, {
    ownerLogin: ctx.user.login,
    sourceUrl: url,
    name: String(form.name ?? url.split('/').pop() ?? ''),
    description: null,
  });
  if (!result.ok) {
    return page(
      c,
      ctx,
      'Error',
      `<div class="flash err">${escapeHtml(result.error)}</div><a href="/">back</a>`,
      400,
    );
  }
  return c.redirect(`/${result.value.owner_login}/${result.value.name}`);
});

// ---------------------------------------------------------------------------
// PAT settings
// ---------------------------------------------------------------------------

web.get('/settings/tokens', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, prefix, scopes, created_at, last_used_at FROM pat WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(ctx.user.id)
    .all<{ id: string; name: string; prefix: string; scopes: string; created_at: number; last_used_at: number | null }>();
  const rows = (results ?? [])
    .map(
      (t) => html`
        <div class="repo-row">
          <div>
            <strong>${t.name}</strong>
            <code>${t.prefix}…</code>
            <div class="muted">${escapeHtml(t.scopes)}</div>
          </div>
          <div>
            <span class="muted">${t.last_used_at ? timeAgo(t.last_used_at) : 'never used'}</span>
            <form method="post" action="/settings/tokens/${t.id}/delete" style="display:inline">
              <button class="btn" type="submit">Revoke</button>
            </form>
          </div>
        </div>
      `,
    )
    .join('');
  return page(
    c,
    ctx,
    'Access tokens',
    html`
      <div class="card">
        <h2>Personal access tokens</h2>
        <p class="muted">
          Used for git over HTTPS (<code>git clone https://user:PAT@host/owner/repo.git</code>),
          the REST API (<code>Authorization: Bearer PAT</code>), and MCP.
        </p>
        <form method="post" action="/settings/tokens">
          <label for="tname">Token name</label>
          <input id="tname" name="name" type="text" required placeholder="laptop, ci-bot…" />
          <p><button class="btn primary" type="submit">Generate token</button></p>
        </form>
        ${rows || '<p class="muted">no tokens yet</p>'}
      </div>
    `,
  );
});

web.post('/settings/tokens', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const form = await c.req.parseBody();
  const { mintPAT } = await import('../auth/pat');
  const minted = await mintPAT(c.env, ctx.user.id, String(form.name ?? 'token').slice(0, 100), [
    'read',
    'write',
    'api',
  ]);
  return page(
    c,
    ctx,
    'Token created',
    html`
      <div class="card">
        <div class="flash ok">Token created. Copy it now — it will not be shown again.</div>
        <pre><code>${minted.token}</code></pre>
        <p><a class="btn" href="/settings/tokens">Back to tokens</a></p>
      </div>
    `,
  );
});

web.post('/settings/tokens/:id/delete', async (c) => {
  const ctx = await requireSessionPage(c);
  if (ctx instanceof Response) return ctx;
  const { revokePAT } = await import('../auth/pat');
  await revokePAT(c.env, c.req.param('id'), ctx.user.id);
  return c.redirect('/settings/tokens');
});

// ---------------------------------------------------------------------------
// Minimal repo page (M2 replaces with the real tree browser)
// ---------------------------------------------------------------------------

web.get('/:owner/:repo', async (c) => {
  const actor = await apiActor(c);
  const repo = await getRepo(c.env.DB, c.req.param('owner'), c.req.param('repo'));
  if (!repo) return c.notFound();
  const canSee =
    repo.visibility === 'public' || (actor && (actor.user.login === repo.owner_login || actor.user.is_admin));
  if (!canSee) return c.notFound();

  const ctx = await pageCtx(c);
  const cloneUrl = `${new URL(c.req.url).origin}/${repo.owner_login}/${repo.name}.git`;
  return page(
    c,
    ctx,
    `${repo.owner_login}/${repo.name}`,
    html`
      <div class="card">
        <h2>
          ${repo.owner_login} / ${repo.name}
          <span class="badge">${repo.visibility}</span>
        </h2>
        <p class="muted">${repo.description ?? ''}</p>
        <p>Clone URL:</p>
        <pre><code>${cloneUrl}</code></pre>
        <p class="muted">
          Authenticate git with a personal access token from
          <a href="/settings/tokens">your token settings</a>.
        </p>
      </div>
    `,
  );
});
