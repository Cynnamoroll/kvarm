/** Repo page chrome: header, tabs, branch selector, breadcrumbs, clone box. */

import { escapeHtml, html, raw } from '@kvarm/ui';
import type { RepoRow } from '../db/repos';
import { layout } from '../web/render';
import type { GitRef } from '@kvarm/gitops';

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(()=>{const o=b.textContent;b.textContent='copied';setTimeout(()=>b.textContent=o,1200)})});`;

export type RepoTab = 'code' | 'commits' | 'branches' | 'environments' | 'compare' | 'activity' | 'train' | 'settings';

export interface ShellOptions {
  repo: RepoRow;
  ref: string;
  path?: string;
  tab?: RepoTab;
  branches?: GitRef[];
  title?: string;
  /** Extra <head> content (a module script for pages with a client). */
  head?: string;
}

function tabHref(repo: RepoRow, tab: RepoTab, ref: string): string {
  const base = `/${repo.owner_login}/${repo.name}`;
  switch (tab) {
    case 'commits':
      return `${base}/commits?ref=${encodeURIComponent(ref)}`;
    case 'branches':
      return `${base}/branches`;
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

export function repoPage(env: Env, opts: ShellOptions, userLogin: string | null, body: string): string {
  const { repo } = opts;
  const ref = opts.ref;
  const branchList = (opts.branches ?? [])
    .map((b) => {
      const short = b.name.replace('refs/heads/', '');
      return `<li><a href="/${repo.owner_login}/${repo.name}/tree/${encodeURIComponent(short)}">${escapeHtml(short)}</a></li>`;
    })
    .join('');

  const tabs: RepoTab[] = ['code', 'commits', 'branches', 'compare', 'activity', 'train'];
  if (userLogin) tabs.push('environments');
  if (userLogin === repo.owner_login) tabs.push('settings');
  const tabHtml = tabs
    .map((t) => `<a class="tab ${opts.tab === t ? 'active' : ''}" href="${tabHref(repo, t, ref)}">${t}</a>`)
    .join('');

  const cloneUrl = `${env.APP_ORIGIN || 'http://localhost:8787'}/${repo.owner_login}/${repo.name}.git`;
  const description = repo.description ? html`<p class="muted">${repo.description}</p>` : '';
  const crumbs =
    opts.path !== undefined && opts.tab !== 'settings' && opts.tab !== 'environments'
      ? `<div class="crumbs">${breadcrumbs(repo, ref, opts.path)}</div>`
      : '';

  const shellBody = html`
<div class="repo-head">
  <div>
    <h1>
      <a href="/${repo.owner_login}">${repo.owner_login}</a>
      <span class="muted">/</span>
      <a href="/${repo.owner_login}/${repo.name}"><strong>${repo.name}</strong></a>
      <span class="badge">${repo.visibility}</span>
    </h1>
    ${raw(description)}
  </div>
  <div class="clone-box">
    <code id="clone-url">${cloneUrl}</code>
    <button class="btn" type="button" data-copy="${cloneUrl}">Copy</button>
  </div>
</div>
<nav class="tabs">${raw(tabHtml)}
  <span class="spacer"></span>
  <details class="branch-picker">
    <summary><code>${ref}</code> ▾</summary>
    <ul>${raw(branchList || '<li class="muted">loading…</li>')}</ul>
  </details>
</nav>
${raw(crumbs)}
${raw(body)}
`;
  return layout(
    env,
    {
      title: opts.title ?? `${repo.owner_login}/${repo.name}`,
      userLogin,
      script: COPY_JS,
      head: opts.head,
    },
    shellBody,
  );
}
