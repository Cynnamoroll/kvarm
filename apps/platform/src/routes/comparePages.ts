/**
 * The compare page (issue #6): the server-rendered file list of any two
 * refs, structure first, with the virtualized diff client (public/assets/
 * diffClient.js) expanding per-file line diffs on demand.
 *
 *  - First paint is O(files shown): the compare service's tree diff is
 *    O(changed files) and its line stats cover at most 300 files, so the
 *    page never reads file content the list does not need.
 *  - The file list works without JavaScript: plain <details> rows with a
 *    link to the per-file API. With JavaScript, expanding a row fetches the
 *    file's hunks once and renders them in a virtualized viewport of fixed
 *    row height (about 110 mounted rows for any file size, no scroll jumps).
 *  - Truncated and tooLarge states are explicit: a banner when the tree
 *    diff hit its budget, badges on files whose content is binary or over
 *    4 MiB, and a `statsOmitted` note when line counts are not known.
 *  - Anonymous public views are edge-cached: a SHA...SHA range is immutable
 *    (a pinned key), anything else is keyed by the repo view generation,
 *    exactly like the tree pages.
 *
 * Escaping convention: user data is interpolated bare into html`` (escaped
 * once); composed fragments and pre-encoded URLs go through raw().
 */

import { Hono, type Context } from 'hono';
import { escapeHtml as escape, html, raw } from '@kvarm/ui';
import { repoPage } from '../render/repoShell';
import { isCommitRef, listRefs } from '../artifacts/repo';
import { edgeCachedPage } from '../cache/edge';
import { repoViewGeneration } from '../services/pushFreshness';
import * as compare from '../services/compare';
import type { CompareFile } from '../services/compare';
import type { RepoRow } from '../db/repos';
import type { GitRef } from '@kvarm/gitops';
import { finish, notFound, resolveRepo, type Resolved } from './repoPages';

import type { App } from './api';
export const comparePages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8' };
/** Files per page; the service caps a page at 5,000, this stays lean. */
const PAGE_LIMIT = 200;
const DIFF_CLIENT_TAG = '<script type="module" src="/assets/diffClient.js"></script>';

type PageContext = Context<App>;

const short = (sha: string | null): string => (sha ? sha.slice(0, 10) : '');

/** A `base...head` range; ref names can contain "/" but never "..". */
function parseRange(encoded: string): { base: string; head: string } | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const split = decoded.indexOf('...');
  if (split <= 0) return null;
  const head = decoded.slice(split + 3);
  if (head.length === 0) return null;
  return { base: decoded.slice(0, split), head };
}

// ---------------------------------------------------------------------------
// Compare form
// ---------------------------------------------------------------------------

function branchOptions(branches: GitRef[], selected: string): string {
  return branches
    .map((b) => {
      const name = b.name.replace('refs/heads/', '');
      return `<option value="${escape(name)}"${name === selected ? ' selected' : ''}>${escape(name)}</option>`;
    })
    .join('');
}

async function compareForm(c: PageContext, resolved: Resolved, error: string | null): Promise<Response> {
  const repo = resolved.repo;
  let refs: Awaited<ReturnType<typeof listRefs>> | null = null;
  try {
    refs = await listRefs(c.env, repo);
  } catch {
    refs = null; // the form degrades to free-text inputs
  }
  const names = refs ? refs.branches.map((b) => b.name.replace('refs/heads/', '')) : [];
  const defaults = [repo.default_branch || 'main', ...names.filter((n) => n !== (repo.default_branch || 'main'))];
  const base = c.req.query('base') ?? defaults[0] ?? '';
  const head = c.req.query('head') ?? defaults[1] ?? '';
  const body = html`
    <div class="card">
      <div class="card-title">Compare refs</div>
      ${error ? raw(`<div class="flash err">${escape(error)}</div>`) : ''}
      <form method="get" action="/${repo.owner_login}/${repo.name}/compare" class="compare-form">
        ${
          names.length > 0
            ? raw(`
          <label for="cmp-a">Base</label>
          <select id="cmp-a" name="base">${branchOptions(refs!.branches, base)}</select>
          <label for="cmp-b">Compare</label>
          <select id="cmp-b" name="head">${branchOptions(refs!.branches, head)}</select>`)
            : raw(`
          <label for="cmp-a">Base (branch or commit SHA)</label>
          <input id="cmp-a" name="base" type="text" value="${escape(base)}" />
          <label for="cmp-b">Compare (branch or commit SHA)</label>
          <input id="cmp-b" name="head" type="text" value="${escape(head)}" />`)
        }
        <p><button class="btn primary" type="submit">Compare</button></p>
      </form>
      <p class="muted">The URL is <code>/compare/base...head</code> and accepts branch names and commit SHAs on either side.</p>
    </div>
  `;
  const page = repoPage(
    c.env,
    { repo, ref: repo.default_branch || 'main', tab: 'compare', title: 'Compare' },
    resolved.viewer?.user.login ?? null,
    body,
  );
  return finish(
    c,
    new Response(page, { status: 200, headers: { ...HTML, 'cache-control': 'no-store' } }),
  );
}

comparePages.get('/compare', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const base = c.req.query('base');
  const head = c.req.query('head');
  if (base && head) {
    const path = `/${resolved.repo.owner_login}/${resolved.repo.name}/compare/${encodeURIComponent(`${base}...${head}`)}`;
    return finish(c, c.redirect(path));
  }
  if (base || head) return compareForm(c, resolved, 'Pick both a base and a head to compare.');
  return compareForm(c, resolved, null);
});

// ---------------------------------------------------------------------------
// Compare view
// ---------------------------------------------------------------------------

const STATUS_MARK: Record<string, string> = {
  added: 'A',
  removed: 'D',
  modified: 'M',
  renamed: 'R',
  typechange: 'T',
};

const HIGH_SIGNAL_TAGS = new Set(['ci-config', 'test-deletion', 'security-sensitive', 'new-dependency']);

function fileRow(repo: RepoRow, encRange: string, f: CompareFile): string {
  const mark = STATUS_MARK[f.status] ?? '·';
  const stats =
    f.additions !== undefined && f.deletions !== undefined
      ? `<span class="ok">+${f.additions}</span> <span class="err">−${f.deletions}</span>`
      : '<span class="muted">no line stats</span>';
  const marks = [
    ...(f.binary ? ['binary'] : []),
    ...(f.tooLarge ? ['too large'] : []),
    ...(f.approximate ? ['approximate'] : []),
  ]
    .map((m) => `<span class="chip">${escape(m)}</span>`)
    .join(' ');
  const tags = f.risk.tags
    .map((t) => `<span class="chip${HIGH_SIGNAL_TAGS.has(t) ? ' signal' : ''}" title="risk ${f.risk.score}">${escape(t)}</span>`)
    .join(' ');
  const rename = f.oldPath && f.oldPath !== f.path ? `<span class="muted">${escape(f.oldPath)} →</span> ` : '';
  // The client fetches from this pre-encoded per-file API endpoint; binary
  // and too-large files are known server-side and never fetched.
  const data = [
    `data-path="${escape(f.path)}"`,
    f.binary ? 'data-binary="1"' : '',
    f.tooLarge ? 'data-toolarge="1"' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `<details class="diff-file" ${data}>
    <summary>
      <span class="diff-status ${f.status}">${mark}</span>
      ${rename}<code>${escape(f.path)}</code>
      <span class="diff-stat">${stats}</span>${marks ? ` ${marks}` : ''}${tags ? ` ${tags}` : ''}
    </summary>
    <div class="diff-body">
      <noscript><p class="muted">The line diff needs JavaScript. It is also available as JSON at <a href="/api/v1/repos/${repo.owner_login}/${repo.name}/compare/${encRange}/file?path=${encodeURIComponent(f.path)}">the file diff API</a>.</p></noscript>
    </div>
  </details>`;
}

async function renderCompare(c: PageContext, resolved: Resolved, range: { base: string; head: string }, encRange: string): Promise<Response> {
  const repo = resolved.repo;
  const order = c.req.query('order') === 'path' ? 'path' : 'risk';
  const r = await compare.compare(
    {
      env: c.env,
      repo,
      bypass: false,
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    },
    range.base,
    range.head,
    { order, limit: String(PAGE_LIMIT), cursor: c.req.query('cursor') },
  );
  if (!r.ok) {
    // The form is the friendlier 404 for a bad ref; concealment is unaffected.
    if (r.status === 404) return compareForm(c, resolved, r.error);
    const page = repoPage(
      c.env,
      { repo, ref: repo.default_branch || 'main', tab: 'compare', title: 'Compare' },
      resolved.viewer?.user.login ?? null,
      html`<div class="flash err"><strong>Compare unavailable</strong> ${r.error} <code>${r.code}</code></div>`,
    );
    return finish(c, new Response(page, { status: r.status as number, headers: { ...HTML, 'cache-control': 'no-store' } }));
  }
  const res = r.value.response;
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const base = `/${repo.owner_login}/${repo.name}`;
  const fileApi = `/api/v1/repos/${repo.owner_login}/${repo.name}/compare/${encRange}/file`;
  const rows = res.files.map((f) => fileRow(repo, encRange, f)).join('');
  const shown = res.files.length;
  const offset = c.req.query('cursor') ? ' (continuing)' : '';

  const refLink = (ref: string | null, sha: string | null): string =>
    sha ? `<a href="${base}/commit/${sha}"><code>${ref ?? short(sha)}</code></a>` : `<code>${ref ?? '—'}</code>`;

  const body = html`
    <div class="compare-root" data-file-api="${raw(fileApi)}">
      <div class="card">
        <div class="card-title">
          Compare
          <span class="muted">
            ${raw(refLink(res.base.ref, res.base.sha))}
            <span class="muted">…</span>
            ${raw(refLink(res.head.ref, res.head.sha))}
          </span>
        </div>
        <div class="compare-summary">
          <span class="ok">+${res.totals.additions ?? '?'}</span>
          <span class="err">−${res.totals.deletions ?? '?'}</span>
          <span class="muted">across ${res.totals.files} file(s)${res.totalsComplete ? '' : ' (at least)'}</span>
          <span class="chip">risk ${res.rating.level} (${res.rating.score})</span>
        </div>
        ${res.rating.reasons.length > 0 ? raw(`<div class="muted">${res.rating.reasons.map((x) => escape(x)).join(' · ')}</div>`) : ''}
        ${
          res.truncated
            ? raw(`<div class="flash warn">The comparison is truncated: ${escape(res.truncatedReason ?? 'bounded read')} — the totals are a lower bound over the discovered files.</div>`)
            : ''
        }
        ${res.statsOmitted ? raw('<div class="flash warn">Line stats are omitted: more than 300 files changed, so per-file counts are not shown.</div>') : ''}
        <div class="pager">
          <span class="muted">order</span>
          <a href="${base}/compare/${raw(encodeURIComponent(`${range.base}...${range.head}`))}?order=risk">risk</a>
          <a href="${base}/compare/${raw(encodeURIComponent(`${range.base}...${range.head}`))}?order=path">path</a>
          <span class="spacer"></span>
          <span class="muted">expand a file for its line diff · first ${shown} file(s)${offset}</span>
        </div>
        <div class="compare-list">
          ${raw(rows || '<p class="muted">no changed files</p>')}
        </div>
        ${
          res.nextCursor
            ? raw(
                `<div class="pager"><a class="btn" href="${base}/compare/${encodeURIComponent(`${range.base}...${range.head}`)}?order=${order}&cursor=${encodeURIComponent(res.nextCursor)}">More files</a></div>`,
              )
            : ''
        }
      </div>
    </div>
  `;
  const page = repoPage(
    c.env,
    { repo, ref: repo.default_branch || 'main', tab: 'compare', title: `Compare ${range.base}...${range.head}`, head: DIFF_CLIENT_TAG },
    viewerLogin,
    body,
  );
  return finish(c, new Response(page, { status: 200, headers: HTML }));
}

comparePages.get('/compare/:range{.+}', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const segments = new URL(c.req.url).pathname.split('/').filter(Boolean);
  // [owner, repo, compare, ...range]
  const encRange = segments.slice(3).join('/');
  const range = parseRange(encRange);
  if (!range) return notFound(c);
  const render = () => renderCompare(c, resolved, range, encRange);
  // Immutable when both sides are pinned to commits; otherwise the mutable-ref
  // generation moves on every confirmed push (services/pushFreshness.ts).
  const pinned = isCommitRef(range.base) && isCommitRef(range.head);
  if (pinned) return edgeCachedPage(c, 31_536_000, null, render);
  return edgeCachedPage(c, 60, await repoViewGeneration(resolved.repo), render);
});
