/** Repo page chrome: header, tabs, branch selector, breadcrumbs, clone box. */

import { escapeHtml, html, raw } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { layout, requestOrigin, type PageOptions } from '../web/render';
import type { GitRef } from '@kvarm/gitops';

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(()=>{const o=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=o,1200)})});`;

export type RepoTab = 'code' | 'changes' | 'commits' | 'branches' | 'issues' | 'environments' | 'compare' | 'activity' | 'train' | 'settings';

export interface ShellOptions extends Pick<PageOptions, 'active' | 'needsYouCount' | 'inboxCount' | 'runningCount'> {
  repo: RepoRow;
  ref: string;
  path?: string;
  tab?: RepoTab;
  branches?: GitRef[];
  title?: string;
  /** Extra <head> content (a module script for pages with a client). */
  head?: string;
  showClone?: boolean;
}

export function repoTabHref(repo: RepoRow, tab: RepoTab, ref: string): string {
  const base = `/${repo.owner_login}/${repo.name}`;
  switch (tab) {
    case 'changes':
      return `${base}/changes`;
    case 'commits':
      return `${base}/commits?ref=${encodeURIComponent(ref)}`;
    case 'branches':
      return `${base}/branches`;
    case 'issues':
      return `${base}/issues`;
    case 'environments':
      return `${base}/environments`;
    case 'compare':
      return `${base}/compare`;
    case 'activity':
      return `${base}/activity`;
    case 'train':
      return `${base}/train`;
    case 'settings':
      return `${base}/settings`;
    default:
      return `${base}/tree/${encodeURIComponent(ref)}`;
  }
}

/** Breadcrumb links: path segments are percent-encoded in hrefs, escaped as text. */
function breadcrumbs(repo: RepoRow, ref: string, path: string): string {
  const base = `/${repo.owner_login}/${repo.name}/tree/${encodeURIComponent(ref)}`;
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  const crumbs = parts.map((p) => {
    acc = acc ? `${acc}/${p}` : p;
    return `<a href="${base}/${encodeURIComponent(acc)}">${escapeHtml(p)}</a>`;
  });
  return [
    `<a href="${base}">${escapeHtml(repo.name)}</a>`,
    ...crumbs,
  ].join(' <span class="muted">/</span> ');
}

export function cloneBox(env: Env, requestUrl: string, repo: RepoRow, ref: string, id?: string): string {
  const cloneCommand = `git clone ${requestOrigin(env, requestUrl)}/${repo.owner_login}/${repo.name}.git`;
  const checkoutCommand = `kvarm checkout ${repo.owner_login}/${repo.name} ${ref} <dir>`;
  return html`<div class="clone-box">
    <code ${raw(id ? `id="${escapeHtml(id)}"` : '')}>${cloneCommand}</code>
    <button class="btn" type="button" data-copy="${cloneCommand}">Copy</button>
    <code class="clone-cli m-agent">${checkoutCommand}</code>
  </div>`;
}

export function repoPage(env: Env, opts: ShellOptions, userLogin: string | null, body: string, requestUrl: string): string {
  const { repo } = opts;
  const ref = opts.ref;
  const branchList = (opts.branches ?? [])
    .map((b) => {
      const short = b.name.replace('refs/heads/', '');
      return `<li><a href="/${repo.owner_login}/${repo.name}/tree/${encodeURIComponent(short)}">${escapeHtml(short)}</a></li>`;
    })
    .join('');

  const tabs: RepoTab[] = ['code', 'changes', 'commits', 'branches', 'issues', 'compare', 'activity', 'train'];
  if (userLogin) tabs.push('environments');
  if (userLogin === repo.owner_login) tabs.push('settings');
  const tabHtml = tabs
    .map(
      (t) =>
        `<a class="tab ${opts.tab === t ? 'active' : ''}" href="${repoTabHref(repo, t, ref)}"${opts.tab === t ? ' aria-current="page"' : ''}>${t}</a>`,
    )
    .join('');

  const description = repo.description ? html`<p class="lede">${repo.description}</p>` : '';
  const crumbs =
    opts.path !== undefined && opts.tab !== 'settings' && opts.tab !== 'environments'
      ? `<div class="crumbs hud">${breadcrumbs(repo, ref, opts.path)}</div>`
      : '';
  const clone = opts.showClone === false
    ? ''
    : cloneBox(env, requestUrl, repo, ref, 'clone-url');

  const shellBody = html`
<header class="k-head repo-page-head">
  <div class="k-head-copy">
    <p class="hud k-head-hud"><a href="/${repo.owner_login}">${repo.owner_login}</a><span aria-hidden="true">/</span><a href="/${repo.owner_login}/${repo.name}">${repo.name}</a><span class="tag">${repo.visibility}</span><span class="k-ref">${ref}</span></p>
    <h1>${repo.name}</h1>
    ${raw(description)}
  </div>
  <div class="k-head-side">
    ${raw(clone)}
  </div>
</header>
<nav class="tabs k-tabs">${raw(tabHtml)}
  <span class="spacer"></span>
  <details class="branch-picker">
    <summary><code>${ref}</code> ▾</summary>
    <ul>${raw(branchList || '<li class="muted">loading…</li>')}</ul>
  </details>
</nav>
<div class="k-repo-content">
  ${raw(crumbs)}
  ${raw(body)}
</div>
`;
  return layout(
    env,
    {
      title: opts.title ?? `${repo.owner_login}/${repo.name}`,
      userLogin,
      contentInset: false,
      script: COPY_JS,
      head: opts.head,
      repos: [{ ownerLogin: repo.owner_login, name: repo.name }],
      active: opts.active,
      needsYouCount: opts.needsYouCount,
      inboxCount: opts.inboxCount,
      runningCount: opts.runningCount,
    },
    shellBody,
  );
}
