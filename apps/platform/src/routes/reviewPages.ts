/**
 * Guided review pages (architecture §0.4.1): /changes is the inbox split by
 * whose turn it is, /changes/:number walks the review guide. Thin adapters over
 * services/reviewGuide and services/reviews; rendering lives in render/reviewPage.
 */

import { Hono, type Context } from 'hono';
import { html } from '@kvarm/ui';
import type { App } from './api';
import { clientIp, requestCredential } from './api';
import { finish, notFound, type Resolved } from './repoPages';
import { repoPage } from '../render/repoShell';
import { changesInboxBody, reviewPageBody, type InboxItem, type ReviewView } from '../render/reviewPage';
import { resolveRepoAccess } from '../services/access';
import type { RepoNeed } from '../services/authz';
import type { BranchRule } from '../services/branchRules';
import type { ChangeContext } from '../services/changes';
import { ackUnits, getGuide, listAttention } from '../services/reviewGuide';
import { submitReview } from '../services/reviews';

export const reviewPages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

type PageResolved = Resolved & { branchRules: BranchRule[] };

async function resolve(c: Context<App>, need: RepoNeed = 'read'): Promise<PageResolved | null> {
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
    branchRules: true,
  });
  if (!access.ok) return null;
  return { repo: access.repo, viewer: access.actor, role: access.role, branchRules: access.branchRules ?? [] };
}

function changeCx(c: Context<App>, r: PageResolved): ChangeContext {
  return { env: c.env, repo: r.repo, actor: r.viewer, role: r.role, branchRules: r.branchRules, waitUntil: (p) => c.executionCtx.waitUntil(p) };
}

function canWrite(r: Resolved): boolean {
  return r.viewer !== null && (r.role === 'write' || r.role === 'admin');
}

function repoBase(r: Resolved): string {
  return `/${r.repo.owner_login}/${r.repo.name}`;
}

function page(c: Context<App>, r: Resolved, title: string, body: string, status = 200): Response {
  const shell = repoPage(
    c.env,
    { repo: r.repo, ref: r.repo.default_branch || 'main', tab: 'changes', title, head: '<script type="module" src="/assets/reviewClient.js"></script>' },
    r.viewer?.user.login ?? null,
    body,
  );
  return finish(c, new Response(shell, { status, headers: HTML }));
}

function errorPage(c: Context<App>, r: Resolved, status: number, error: string, code: string): Response {
  return page(c, r, 'Review unavailable', html`<div class="flash err"><strong>Review unavailable</strong> ${error} <code>${code}</code></div>`, status);
}

async function renderReview(c: Context<App>, r: PageResolved, flash: string | null): Promise<Response> {
  const number = c.req.param('number') ?? '';
  const mode: ReviewView = c.req.query('view') === 'risk' ? 'risk' : c.req.query('view') === 'files' ? 'files' : 'guided';
  const cx = changeCx(c, r);
  const focus = c.req.query('since') === 'parent';
  const guide = await getGuide(cx, number, { include: 'hunks', ...(focus ? { since: 'parent' } : {}) });
  if (!guide.ok) return guide.status === 404 ? notFound(c) : errorPage(c, r, guide.status, guide.error, guide.code ?? 'ERROR');
  const title = await c.env.DB.prepare('SELECT title FROM change_sets WHERE repo_id = ?1 AND number = ?2')
    .bind(r.repo.id, guide.value.number)
    .first<{ title: string }>();
  const writable = canWrite(r);
  const body = reviewPageBody({
    view: guide.value,
    title: title?.title ?? '',
    base: repoBase(r),
    mode,
    focus,
    canWrite: writable,
    canReview: writable,
    flash,
  });
  return page(c, r, `#${guide.value.number} ${title?.title ?? ''}`, body);
}

/** Only same-change fragments are valid return targets, so the form cannot redirect off-site. */
function returnTarget(r: Resolved, number: string, raw: unknown): string {
  const pageBase = `${repoBase(r)}/changes/${number}`;
  const value = typeof raw === 'string' ? raw : '';
  return value === pageBase || value.startsWith(`${pageBase}?`) || value.startsWith(`${pageBase}#`) ? value : pageBase;
}

reviewPages.get('/changes', async (c) => {
  const r = await resolve(c);
  if (!r) return notFound(c);
  const list = await listAttention(changeCx(c, r), { limit: '50' });
  if (!list.ok) return errorPage(c, r, list.status, list.error, list.code ?? 'ERROR');
  return page(c, r, 'Changes', changesInboxBody(repoBase(r), list.value.changes as unknown as InboxItem[], list.value.nextCursor !== null || list.value.truncated));
});

reviewPages.get('/changes/:number{[0-9]+}', async (c) => {
  const r = await resolve(c);
  if (!r) return notFound(c);
  return renderReview(c, r, null);
});

reviewPages.post('/changes/:number{[0-9]+}/ack', async (c) => {
  const r = await resolve(c, 'write');
  if (!r || !canWrite(r)) return notFound(c);
  const number = c.req.param('number') ?? '';
  const form = await c.req.parseBody();
  const keys = String(form.units ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const result = await ackUnits(changeCx(c, r), number, { keys, headSha: String(form.head ?? '') });
  if (!result.ok) return renderReview(c, r, `${result.error} (${result.code})`);
  if (c.req.header('x-kvarm-fetch') === '1') return finish(c, c.json(result.value));
  return finish(c, c.redirect(returnTarget(r, number, form.return), 303));
});

reviewPages.post('/changes/:number{[0-9]+}/review', async (c) => {
  const r = await resolve(c, 'write');
  if (!r || !canWrite(r)) return notFound(c);
  const number = c.req.param('number') ?? '';
  const form = await c.req.parseBody();
  const note = String(form.body ?? '').trim();
  const result = await submitReview(changeCx(c, r), number, {
    verdict: String(form.verdict ?? ''),
    headSha: String(form.head ?? '') || null,
    ...(note ? { body: note } : {}),
  });
  if (!result.ok) return renderReview(c, r, `${result.error} (${result.code})`);
  return finish(c, c.redirect(`${repoBase(r)}/changes/${number}`, 303));
});
