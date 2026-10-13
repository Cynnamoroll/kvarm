/**
 * Issue pages under /:owner/:repo: the list (with a new-issue form), one
 * issue with its links, edit, close and reopen, and confirming or rejecting
 * a proposed link. SSR HTML over services/issues.ts, the same service the
 * REST, MCP and CLI surfaces use; no client JS.
 *
 * Issues change without a push, so these pages are never edge-cached.
 * Writes need the `write` role and come from same-origin forms only: the
 * browser's Origin and Sec-Fetch-Site headers are checked, because a session
 * cookie would otherwise ride along on a cross-site form post.
 *
 * Escaping convention (as in repoPages.ts): user data is interpolated bare
 * into html`` and escaped once; composed fragments and pre-encoded URLs go
 * through raw().
 */

import { Hono, type Context } from 'hono';
import { html, raw, timeAgo } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { clientIp, requestCredential } from './api';
import { repoPage } from '../render/repoShell';
import { renderMarkdown } from '../render/markdown';
import { resolveRepoAccess } from '../services/access';
import type { Actor, RepoNeed, RepoRole } from '../services/authz';
import * as svc from '../services/issues';

type App = { Bindings: Env; Variables: { refreshCookies: string[] } };
export const issuePages = new Hono<App>();

interface Resolved {
  repo: RepoRow;
  viewer: Actor | null;
  role: RepoRole;
}

const HTML = { 'content-type': 'text/html; charset=utf-8' } as const;
const STATES = ['open', 'closed', 'all'] as const;
const CLOSE_REASONS = [
  ['completed', 'Completed'],
  ['not_planned', 'Not planned'],
  ['duplicate', 'Duplicate'],
] as const;

function finish(c: Context<App>, res: Response): Response {
  for (const cookie of c.get('refreshCookies') ?? []) res.headers.append('Set-Cookie', cookie);
  return res;
}

function notFound(): Response {
  return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

async function resolveRepo(c: Context<App>, need: RepoNeed = 'read'): Promise<Resolved | null> {
  const owner = c.req.param('owner');
  const name = c.req.param('repo');
  if (!owner || !name) return null;
  const access = await resolveRepoAccess(c.env, {
    owner,
    name,
    need,
    transport: 'page',
    credential: await requestCredential(c),
    clientIp: clientIp(c),
    rejectedCredentialAsAnonymous: true,
  });
  if (!access.ok) return null;
  return { repo: access.repo, viewer: access.actor, role: access.role };
}

const canWrite = (r: Resolved) => r.viewer !== null && (r.role === 'write' || r.role === 'admin');

/** A form post that a browser sent from another site is refused. */
function crossSite(c: Context<App>): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return true;
  const origin = c.req.header('origin');
  return origin !== undefined && origin !== 'null' && origin !== new URL(c.req.url).origin;
}

const base = (repo: RepoRow) => `/${repo.owner_login}/${repo.name}`;

function page(c: Context<App>, r: Resolved, title: string, body: string, status = 200): Response {
  return finish(
    c,
    new Response(repoPage(c.env, { repo: r.repo, ref: r.repo.default_branch, tab: 'issues', title }, r.viewer?.user.login ?? null, body), {
      status,
      headers: HTML,
    }),
  );
}

function flash(c: Context<App>): string {
  const error = c.req.query('error');
  const notice = c.req.query('notice');
  if (error) return html`<div class="flash err">${error.slice(0, 300)}</div>`;
  if (notice) return html`<div class="flash ok">${notice.slice(0, 300)}</div>`;
  return '';
}

function redirect(c: Context<App>, to: string, q?: { error?: string; notice?: string }): Response {
  const params = new URLSearchParams();
  if (q?.error) params.set('error', q.error);
  if (q?.notice) params.set('notice', q.notice);
  const qs = params.toString();
  return finish(c, c.redirect(qs ? `${to}?${qs}` : to, 303));
}

function stateBadge(state: 'open' | 'closed', reason?: string | null): string {
  const label = state === 'open' ? 'open' : reason === 'not_planned' ? 'closed · not planned' : reason ? `closed · ${reason.replace('_', ' ')}` : 'closed';
  return html`<span class="badge issue-state ${state}">${label}</span>`;
}

function filedBy(i: svc.IssueView): string {
  if (i.agent) return html`by agent <strong>${i.agent.name}</strong>`;
  if (i.author) return html`by <strong>${i.author}</strong>`;
  return html`by <strong>${i.source}</strong>`;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

issuePages.get('/issues', async (c) => {
  const r = await resolveRepo(c);
  if (!r) return notFound();
  const state = (STATES as readonly string[]).includes(c.req.query('state') ?? '') ? c.req.query('state')! : 'open';
  const source = c.req.query('source') ?? '';
  const listed = await svc.listIssues(c.env, r.repo, { state, source, cursor: c.req.query('cursor'), limit: '50' });
  if (!listed.ok) return redirect(c, `${base(r.repo)}/issues`, { error: listed.error });
  const href = (q: Record<string, string>) => {
    const p = new URLSearchParams({ state, ...(source ? { source } : {}), ...q });
    return `${base(r.repo)}/issues?${p.toString()}`;
  };
  const filters = STATES.map((s) => html`<a class="btn ${s === state ? 'primary' : ''}" href="${raw(href({ state: s }))}">${s}</a>`).join(' ');
  const sources = ['', ...svc.ISSUE_SOURCES]
    .map((s) => html`<option value="${s}" ${s === source ? raw('selected') : ''}>${s || 'any source'}</option>`)
    .join('');
  const rows = listed.value.issues
    .map(
      (i) => html`
      <div class="issue-row">
        <div class="issue-main">
          ${raw(stateBadge(i.state, i.closedReason))}
          <a class="issue-title" href="${raw(`${base(r.repo)}/issues/${i.number}`)}">${i.title}</a>
          ${i.source !== 'human' ? raw(html`<span class="badge">${i.source}</span>`) : ''}
          ${i.occurrences > 1 ? raw(html`<span class="badge" title="reports with the same fingerprint">×${i.occurrences}</span>`) : ''}
        </div>
        <div class="muted issue-meta">#${i.number} opened ${timeAgo(Date.parse(i.createdAt))} ${raw(filedBy(i))}${i.closedAt ? ` · closed ${timeAgo(Date.parse(i.closedAt))}` : ''}</div>
      </div>`,
    )
    .join('');
  const next = listed.value.nextCursor ? html`<a class="btn" href="${raw(href({ cursor: listed.value.nextCursor }))}">Older</a>` : '';
  const form = canWrite(r)
    ? html`
    <details class="card new-issue" ${c.req.query('new') ? raw('open') : ''}>
      <summary class="btn primary">New issue</summary>
      <form method="post" action="${raw(`${base(r.repo)}/issues`)}">
        <label for="title">Title</label>
        <input id="title" name="title" type="text" required maxlength="256" />
        <label for="body">Description (Markdown)</label>
        <textarea id="body" name="body" rows="8"></textarea>
        <label for="paths">Paths it is about, one per line (optional)</label>
        <textarea id="paths" name="paths" rows="2"></textarea>
        <label for="fingerprint">Fingerprint, to deduplicate repeat reports (optional)</label>
        <input id="fingerprint" name="fingerprint" type="text" maxlength="200" />
        <p><button class="btn primary" type="submit">Submit issue</button></p>
      </form>
    </details>`
    : '';
  const body = html`
    ${raw(flash(c))}
    ${raw(form)}
    <div class="card">
      <div class="card-title issue-filters">
        ${raw(filters)}
        <form method="get" class="inline">
          <input type="hidden" name="state" value="${state}" />
          <select name="source">${raw(sources)}</select>
          <button class="btn" type="submit">Filter</button>
        </form>
      </div>
      ${raw(rows || `<p class="muted">No ${state === 'all' ? '' : `${state} `}issues.</p>`)}
      <div class="pager">${raw(next)}</div>
    </div>`;
  return page(c, r, `Issues · ${r.repo.owner_login}/${r.repo.name}`, body);
});

function formPaths(v: unknown): string[] | undefined {
  if (typeof v !== 'string') return undefined;
  const paths = v
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return paths.length > 0 ? paths : undefined;
}

const formText = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);

issuePages.post('/issues', async (c) => {
  const r = await resolveRepo(c, 'write');
  if (!r || !canWrite(r)) return notFound();
  if (crossSite(c)) return new Response('cross-site form posts are refused', { status: 403 });
  const form = await c.req.parseBody();
  const filed = await svc.createIssue(
    { env: c.env, repo: r.repo, actor: r.viewer },
    { title: form.title, body: formText(form.body) ?? null, paths: formPaths(form.paths), fingerprint: formText(form.fingerprint) },
  );
  if (!filed.ok) return redirect(c, `${base(r.repo)}/issues`, { error: filed.error });
  const at = `${base(r.repo)}/issues/${filed.value.issue.number}`;
  return redirect(c, at, filed.value.created ? undefined : { notice: 'An open issue already has this fingerprint; your report was counted on it.' });
});

// ---------------------------------------------------------------------------
// One issue
// ---------------------------------------------------------------------------

function linkRow(r: Resolved, issue: number, l: svc.IssueLinkView, writable: boolean): string {
  const target = l.change !== null ? html`change <strong>#${l.change}</strong>` : html`workspace <code>${l.workspace ?? ''}</code>`;
  const actions =
    writable && l.change !== null && l.state !== 'rejected' && (l.state === 'proposed' || l.source !== 'manual')
      ? html`
        <form method="post" action="${raw(`${base(r.repo)}/issues/${issue}/links`)}" class="inline">
          <input type="hidden" name="change" value="${l.change}" />
          ${l.state === 'proposed' ? raw('<button class="btn" name="state" value="confirmed" type="submit">Confirm</button>') : ''}
          <button class="btn" name="state" value="rejected" type="submit">Reject</button>
        </form>`
      : '';
  const hints: Record<svc.IssueLinkView['source'], string> = {
    branch: 'from the branch name',
    text: 'from the change text',
    workspace: 'workspace created for this issue',
    paths: "the change touches this issue's paths",
    manual: 'set by hand',
  };
  const hint = hints[l.source];
  return html`
    <div class="commit-row">
      <div>${raw(target)} <span class="badge">${l.kind}</span> <span class="badge">${l.state}</span>
        <span class="muted">${hint}${l.actor ? ` · ${l.actor}` : ''}</span></div>
      <div>${raw(actions)}</div>
    </div>`;
}

issuePages.get('/issues/:number', async (c) => {
  const r = await resolveRepo(c);
  if (!r) return notFound();
  const got = await svc.getIssue({ env: c.env, repo: r.repo, actor: r.viewer }, c.req.param('number'));
  if (!got.ok) return notFound();
  const i = got.value;
  const writable = canWrite(r);
  const at = `${base(r.repo)}/issues/${i.number}`;
  const tree = `${base(r.repo)}/tree/${encodeURIComponent(r.repo.default_branch)}`;
  const facts: string[] = [];
  facts.push(html`<div><span class="muted">Source</span> ${i.agent ? `agent ${i.agent.name}` : i.source}</div>`);
  if (i.fingerprint) facts.push(html`<div><span class="muted">Fingerprint</span> <code>${i.fingerprint}</code></div>`);
  if (i.occurrences > 1) facts.push(html`<div><span class="muted">Reported</span> ${i.occurrences} times, last ${timeAgo(Date.parse(i.lastSeenAt))}</div>`);
  if (i.paths.length > 0) {
    const paths = i.paths.map((p) => html`<a href="${raw(`${tree}/${p.split('/').map(encodeURIComponent).join('/')}`)}"><code>${p}</code></a>`).join(' ');
    facts.push(html`<div><span class="muted">Paths</span> ${raw(paths)}</div>`);
  }
  if (i.evidence) {
    const e = i.evidence;
    const parts = [
      e.sha ? html`commit <a href="${raw(`${base(r.repo)}/commit/${e.sha}`)}"><code>${e.sha.slice(0, 10)}</code></a>` : '',
      e.check ? html`check <code>${e.check}</code>` : '',
      e.runId ? html`run <code>${e.runId}</code>` : '',
      e.workspace ? html`workspace <code>${e.workspace}</code>` : '',
      e.url ? html`<a href="${e.url}" rel="nofollow noopener">link</a>` : '',
    ].filter(Boolean);
    facts.push(html`<div><span class="muted">Evidence</span> ${raw(parts.join(' · '))}</div>`);
  }
  if (i.state === 'closed' && i.closedBy) {
    const by = [
      i.closedBy.change !== null ? html`change <strong>#${i.closedBy.change}</strong>` : '',
      i.closedBy.commit ? html`commit <a href="${raw(`${base(r.repo)}/commit/${i.closedBy.commit}`)}"><code>${i.closedBy.commit.slice(0, 10)}</code></a>` : '',
    ].filter(Boolean);
    facts.push(html`<div><span class="muted">Closed by</span> ${raw(by.join(' at '))}${i.closedReason === 'verified' ? ' (the signal that filed it passed again)' : ''}</div>`);
  }
  const links = i.links.map((l) => linkRow(r, i.number, l, writable)).join('');
  const reasons = CLOSE_REASONS.map(([v, label]) => html`<option value="${v}">${label}</option>`).join('');
  const controls = writable
    ? html`
    <div class="card">
      <div class="card-title">${i.state === 'open' ? 'Close or edit' : 'Reopen or edit'}</div>
      <form method="post" action="${raw(at)}" class="inline">
        ${
          i.state === 'open'
            ? raw(html`<input type="hidden" name="action" value="close" /><select name="closedReason">${raw(reasons)}</select> <button class="btn" type="submit">Close issue</button>`)
            : raw(html`<input type="hidden" name="action" value="reopen" /><button class="btn" type="submit">Reopen issue</button>`)
        }
      </form>
      <details>
        <summary class="muted">Edit title and description</summary>
        <form method="post" action="${raw(at)}">
          <input type="hidden" name="action" value="edit" />
          <label for="title">Title</label>
          <input id="title" name="title" type="text" required maxlength="256" value="${i.title}" />
          <label for="body">Description (Markdown)</label>
          <textarea id="body" name="body" rows="8">${i.body ?? ''}</textarea>
          <p><button class="btn primary" type="submit">Save</button></p>
        </form>
      </details>
    </div>`
    : '';
  const body = html`
    ${raw(flash(c))}
    <div class="issue-head">
      <h2>${i.title} <span class="muted">#${i.number}</span></h2>
      <div>${raw(stateBadge(i.state, i.closedReason))} <span class="muted">opened ${timeAgo(Date.parse(i.createdAt))} ${raw(filedBy(i))}</span></div>
    </div>
    <div class="card md">${raw(i.body ? renderMarkdown(i.body) : '<p class="muted">No description.</p>')}</div>
    <div class="card issue-facts">${raw(facts.join(''))}</div>
    <div class="card">
      <div class="card-title">Linked changes and workspaces</div>
      ${raw(links || '<p class="muted">Nothing links this issue yet. A change closes it with <code>fixes #' + i.number + '</code> in its title, body or a commit message, a branch named like <code>fix/' + i.number + '-…</code>, or a workspace created for it.</p>')}
    </div>
    ${raw(controls)}
    <p><a href="${raw(`${base(r.repo)}/issues`)}">← All issues</a></p>`;
  return page(c, r, `${i.title} · Issue #${i.number}`, body);
});

issuePages.post('/issues/:number', async (c) => {
  const r = await resolveRepo(c, 'write');
  if (!r || !canWrite(r)) return notFound();
  if (crossSite(c)) return new Response('cross-site form posts are refused', { status: 403 });
  const at = `${base(r.repo)}/issues/${c.req.param('number')}`;
  const form = await c.req.parseBody();
  let patch: Record<string, unknown>;
  if (form.action === 'close') patch = { state: 'closed', closedReason: form.closedReason ?? 'completed' };
  else if (form.action === 'reopen') patch = { state: 'open' };
  else if (form.action === 'edit') patch = { title: form.title, body: typeof form.body === 'string' && form.body.length > 0 ? form.body : null };
  else return redirect(c, at, { error: 'unknown action' });
  const updated = await svc.updateIssue({ env: c.env, repo: r.repo, actor: r.viewer }, c.req.param('number'), patch);
  if (!updated.ok) {
    if (updated.status === 404) return notFound();
    return redirect(c, at, { error: updated.error });
  }
  return redirect(c, at);
});

issuePages.post('/issues/:number/links', async (c) => {
  const r = await resolveRepo(c, 'write');
  if (!r || !canWrite(r)) return notFound();
  if (crossSite(c)) return new Response('cross-site form posts are refused', { status: 403 });
  const number = c.req.param('number');
  const at = `${base(r.repo)}/issues/${number}`;
  const form = await c.req.parseBody();
  const change = typeof form.change === 'string' ? form.change : '';
  const linked = await svc.linkIssue({ env: c.env, repo: r.repo, actor: r.viewer }, change, {
    issue: Number(number),
    state: form.state === 'rejected' ? 'rejected' : 'confirmed',
  });
  if (!linked.ok) return redirect(c, at, { error: linked.error });
  return redirect(c, at, { notice: form.state === 'rejected' ? `Change #${change} will not close this issue.` : `Change #${change} will close this issue when it merges.` });
});
