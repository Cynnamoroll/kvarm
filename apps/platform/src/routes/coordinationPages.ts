/**
 * Coordination pages (issue #7): repository activity (workspaces with their
 * agents, model families, declared intents, pinned chains and the overlap
 * pairs of one base), candidate comparison (arenas and free-form candidate
 * sets, ranked, each candidate diffed against the base and against each
 * other) and the live integration train with its exit history and open
 * resolve-conflict tasks.
 *
 * SSR only, no client JS. The train view polls by reload (a `refresh`
 * response header). Nothing here writes except the arena selection, one form
 * POST over the same service the REST route uses. Every page is composed of
 * bounded indexed service reads and conceals private repositories through the
 * shared authorization service like every other page.
 *
 * Escaping convention (packages/ui): user data is interpolated bare into
 * html`` (escaped once); composed fragments and pre-encoded URLs go through
 * raw(). Never pre-escape a value that html`` will interpolate.
 */

import { Hono, type Context } from 'hono';
import { escapeHtml as escape, html, raw, timeAgo, type Raw } from '@kvarm/ui';
import { repoPage } from '../render/repoShell';
import { finish, notFound, resolveRepo, sessionFormRefused, type Resolved } from './repoPages';
import { csrfInput } from '../web/render';
import * as activity from '../services/activity';
import * as candidates from '../services/candidates';
import type { ArenaView } from '../services/candidates';
import type { CheckState } from '../services/checksGate';
import { TRAIN_VIEW_LIMITS, trainView } from '../services/trainView';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';

import { requestSession, type App } from './api';
export const coordinationPages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8' };
/** Live coordination state: never cached, public or not. */
const NO_STORE = { 'cache-control': 'no-store' };
const TRAIN_REFRESH_SECONDS = '10';

type PageContext = Context<App>;
type CandidatesCx = candidates.CandidatesContext;

const ago = (iso: string | null): string => (iso ? timeAgo(Date.parse(iso)) : '');
const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 10) : '');

function respond(c: PageContext, body: string, status = 200, headers: Record<string, string> = {}): Response {
  return finish(c, new Response(body, { status, headers: { ...HTML, ...NO_STORE, ...headers } }));
}

/** A failed composed read becomes a readable error card inside the repo shell. */
function errorCard(c: PageContext, resolved: Resolved, tab: 'activity' | 'train', title: string, r: Extract<ServiceResult<never>, { ok: false }>): Response {
  const page = repoPage(
    c.env,
    { repo: resolved.repo, ref: resolved.repo.default_branch || 'main', tab, title },
    resolved.viewer?.user.login ?? null,
    html`<div class="flash err"><strong>${title}</strong> ${r.error} <code>${r.code}</code></div>`,
  );
  return respond(c, page, r.status as number);
}

function canWrite(resolved: Resolved): resolved is Resolved & { viewer: NonNullable<Resolved['viewer']> } {
  return resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin');
}

/** The shared candidates context for read and select page calls. */
function candidatesCx(c: PageContext, resolved: Resolved): CandidatesCx {
  return {
    env: c.env,
    repo: resolved.repo,
    actor: resolved.viewer,
    origin: new URL(c.req.url).origin,
    branchRules: [],
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  };
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const STATE_CLASS: Record<string, string> = {
  queued: 'muted',
  preparing: 'warn',
  checking: 'info',
  ready: 'ok',
  publishing: 'ok',
  published: 'ok',
  active: '',
  merged: 'ok',
  open: '',
  selected: 'ok',
  claimed: 'warn',
  completed: 'ok',
  obsolete: 'muted',
  ejected: 'err',
  stale: 'err',
  broken: 'err',
  dequeued: 'muted',
  abandoned: 'muted',
};

function stateBadge(state: string): Raw {
  return raw(`<span class="badge state ${STATE_CLASS[state] ?? 'err'}">${escape(state)}</span>`);
}

function checksBadge(state: CheckState): Raw {
  return raw(`<span class="badge state ${state === 'success' ? 'ok' : state === 'failure' ? 'err' : 'warn'}">checks: ${escape(state)}</span>`);
}

/** Up to `limit` path chips plus a "+n" tail; the caller wraps the result in raw(). */
function chips(items: string[], limit: number): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return shown.map((i) => `<code class="chip">${escape(i)}</code>`).join(' ') + (rest > 0 ? ` <span class="muted">+${rest}</span>` : '');
}

function compareHref(repo: RepoRow, base: string, head: string): string {
  return `/${repo.owner_login}/${repo.name}/compare/${encodeURIComponent(`${base}...${head}`)}`;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

async function activityPage(c: PageContext): Promise<Response> {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const repo = resolved.repo;
  const act = await activity.repoActivity(c.env, repo, new URL(c.req.url).origin, {
    status: c.req.query('status'),
    cursor: c.req.query('cursor'),
    base: c.req.query('base'),
  });
  if (!act.ok) return errorCard(c, resolved, 'activity', 'Activity unavailable', act);
  const a = act.value;
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const base = `/${repo.owner_login}/${repo.name}`;

  // The overlap pairs of one base, highlighted back onto the workspace rows.
  const overlapOf = new Map<string, { with: string[]; paths: number }>();
  for (const pair of a.overlap.pairs) {
    for (const [me, other] of [
      [pair.workspaces[0], pair.workspaces[1]],
      [pair.workspaces[1], pair.workspaces[0]],
    ] as const) {
      const entry = overlapOf.get(me) ?? { with: [], paths: 0 };
      entry.with.push(other);
      entry.paths += pair.pathCount;
      overlapOf.set(me, entry);
    }
  }

  // One bounded form: pick any 1-8 active workspaces and compare them at a base.
  const formBases = [
    ...new Set([repo.default_branch || 'main', ...a.workspaces.map((w) => w.base).filter((b): b is string => b !== null)]),
  ];
  const baseOptions = formBases
    .map((b) => html`<option value="${b}"${raw(b === a.base ? ' selected' : '')}>${b}</option>`)
    .join('');
  const canCompare = a.status === 'active';
  const rows = a.workspaces
    .map((w) => {
      const overlap = overlapOf.get(w.id);
      const branchHref = w.branch ? `${base}/tree/${encodeURIComponent(w.branch)}` : '';
      const diffHref = w.branch ? compareHref(repo, w.base ?? a.base, w.branch) : '';
      const agentLine = w.agent
        ? html`<strong>${w.agent}</strong>${w.modelFamily ? raw(html` <span class="chip">${w.modelFamily}</span>`) : ''}`
        : html`<strong>workspace</strong> <span class="muted">by ${w.createdBy ?? 'unknown'}</span>`;
      const pins =
        w.dependencies.length > 0
          ? html`<div class="ws-pins">pins ${raw(
              w.dependencies
                .map((d) => html`<span class="chip">${d.onWorkspace}<span class="muted">@${short(d.revision)}</span>${stateBadge(d.state)}</span>`)
                .join(' '),
            )}</div>`
          : '';
      return html`
        <div class="ws-row" id="ws-${w.id}">
          <div class="ws-main">
            <div>${raw(agentLine)} ${stateBadge(w.status)}</div>
            <div class="muted">${w.task ?? ''}</div>
            <div class="ws-meta">
              ${raw(w.branch ? html`<a href="${branchHref}"><code>${w.branch}</code></a>` : '<span class="muted">no branch</span>')}
              <span class="muted">base</span> <code>${w.base ?? '—'}</code>
              <span class="muted">head</span> <code>${short(w.headSha) || '—'}</code>
              <span class="muted">updated ${ago(w.updatedAt)}</span>
              ${w.changeSet !== null ? raw(html` · <span class="muted">change</span> #${w.changeSet}`) : ''}
              ${w.arena ? raw(html` · <a href="${base}/arenas/${w.arena}">arena</a>`) : ''}
            </div>
            ${w.declaredPaths.length > 0 ? raw(html`<div class="ws-paths">intent ${raw(chips(w.declaredPaths, 6))}</div>`) : ''}
            ${raw(pins)}
            ${overlap ? raw(html`<div><span class="badge state warn">overlap</span> with ${raw(chips(overlap.with, 4))} · ${overlap.paths} shared path(s) · <a href="#overlap">details</a></div>`) : ''}
          </div>
          <div class="ws-actions">
            ${canCompare ? raw(html`<label class="muted"><input type="checkbox" name="workspaces" value="${w.id}" /> compare</label>`) : ''}
            ${diffHref ? raw(html`<a class="btn" href="${diffHref}">diff</a>`) : ''}
          </div>
        </div>
      `;
    })
    .join('');

  const pairs = a.overlap.pairs
    .map((p) => {
      const head = (i: 0 | 1) =>
        html`<a href="#ws-${p.workspaces[i]}">${p.workspaces[i]}</a>${p.heads[i].agent ? raw(html` <span class="muted">${p.heads[i].agent}</span>`) : ''}`;
      return html`
        <div class="pair-row">
          <div>${raw(head(0))} <span class="muted">↔</span> ${raw(head(1))}</div>
          <div class="ws-paths">${raw(chips(p.paths, 5))} ${p.pathCount > 5 ? raw(html`<span class="muted">of ${p.pathCount}</span>`) : ''}</div>
          <div class="muted">observed ${ago(p.heads[0].observedAt)}</div>
        </div>
      `;
    })
    .join('');

  const incomplete = a.overlap.incomplete?.map((i) => html`<code class="chip">${i.workspace}</code>`).join(' ') ?? '';
  const arenas = a.arenas.arenas
    .map((ar) => {
      const winner = ar.selection ? html` · selected <code class="chip">${ar.selection.selectedWorkspace}</code>` : '';
      return html`
        <div class="pair-row">
          <div>
            <a href="${base}/arenas/${ar.id}"><strong>${ar.brief}</strong></a>
            ${stateBadge(ar.state)} <span class="muted">${ar.candidates} candidates on <code>${ar.base}</code>${raw(winner)}</span>
          </div>
          <div class="muted">opened ${ago(ar.createdAt)} by ${ar.createdBy ?? 'unknown'}</div>
        </div>
      `;
    })
    .join('');

  const query = (params: Record<string, string | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, value);
    const qs = search.toString();
    return qs ? `&${qs}` : '';
  };
  const body = html`
    <form method="get" action="${base}/candidates" class="card">
      <div class="card-title">
        Workspaces
        <span class="muted"><a href="${base}/activity?status=active${raw(query({ base: c.req.query('base') }))}">active</a> · <a href="${base}/activity?status=all${raw(query({ base: c.req.query('base') }))}">all</a></span>
      </div>
      ${raw(rows || '<p class="muted">no workspaces</p>')}
      ${
        canCompare
          ? raw(html`
        <div class="pager">
          <label for="cmp-base">Compare selected at base</label>
          <select id="cmp-base" name="base">${raw(baseOptions)}</select>
          <button class="btn" type="submit">Compare</button>
          <span class="muted">select 1-8 workspaces above</span>
        </div>`)
          : ''
      }
      ${
        a.workspacesNextCursor
          ? raw(
              html`<div class="pager"><a class="btn" href="${base}/activity?status=${encodeURIComponent(a.status)}${raw(query({ cursor: a.workspacesNextCursor, base: c.req.query('base') }))}">Older workspaces</a></div>`,
            )
          : ''
      }
    </form>
    <div class="card" id="overlap">
      <div class="card-title">Overlap forecast <span class="muted">advisory · base <code>${a.base}</code></span></div>
      <p class="muted">${a.overlap.advisoryNote}</p>
      ${raw(pairs || '<p class="muted">no overlapping workspaces on this base</p>')}
      ${
        a.overlap.truncated
          ? raw(html`<div class="flash warn">Pairs are truncated: ${a.overlap.truncatedReason ?? 'bounded read'} — an empty or short list is not proof of compatibility.</div>`)
          : ''
      }
      ${incomplete ? raw(html`<p class="muted">Incomplete observed index (may overlap without being reported): ${raw(incomplete)}</p>`) : ''}
    </div>
    <div class="card">
      <div class="card-title">Arenas <span class="muted"><a href="${base}/arenas">all arenas</a></span></div>
      ${raw(arenas || '<p class="muted">no arenas yet</p>')}
    </div>
  `;
  const page = repoPage(c.env, { repo, ref: repo.default_branch || 'main', tab: 'activity', title: 'Activity' }, viewerLogin, body);
  return respond(c, page);
}

coordinationPages.get('/activity', (c) => activityPage(c));

// ---------------------------------------------------------------------------
// Candidate comparison (shared renderer)
// ---------------------------------------------------------------------------

interface ComparisonOptions {
  repo: RepoRow;
  canSelect: boolean;
  arenaId: string;
  /** Session CSRF token for the select form (architecture §11.1). */
  csrf?: string | null;
}

function candidateCards(res: candidates.CandidatesResponse | candidates.ArenaCandidatesResponse, opts: ComparisonOptions): string {
  return res.candidates
    .map((cand) => {
      const rank = res.ranking.find((r) => r.workspace === cand.workspace);
      const files = cand.vsBase.files
        .slice(0, 8)
        .map((f) => {
          const stats =
            f.additions !== undefined && f.deletions !== undefined ? ` <span class="ok">+${f.additions}</span> <span class="err">−${f.deletions}</span>` : '';
          const mark = f.binary ? ' <span class="chip">binary</span>' : f.tooLarge ? ' <span class="chip">too large</span>' : '';
          return html`<div class="file-line"><span class="diff-status ${f.status}">${f.status[0]!.toUpperCase()}</span> <code>${f.path}</code>${raw(stats)}${raw(mark)}</div>`;
        })
        .join('');
      const more = cand.vsBase.filesTruncated ? '<div class="muted">+ more files — open the full diff</div>' : '';
      const failing = rank && rank.factors.failingChecks.length > 0 ? html`<div class="muted">failing: ${raw(chips(rank.factors.failingChecks, 4))}</div>` : '';
      const select = opts.canSelect
        ? html`<form method="post" action="/${opts.repo.owner_login}/${opts.repo.name}/arenas/${opts.arenaId}/select">
             ${raw(csrfInput(opts.csrf))}
             <input type="hidden" name="workspace" value="${cand.workspace}" />
             <button class="btn" type="submit">Select winner</button>
           </form>`
        : '';
      return html`
        <div class="candidate-card">
          <div class="card-title">${rank ? raw(html`<span class="rank">#${rank.rank}</span> `) : ''}${cand.agent ?? 'workspace'} ${checksBadge(cand.checks.state)}</div>
          <div class="ws-meta">
            <a href="/${opts.repo.owner_login}/${opts.repo.name}/tree/${encodeURIComponent(cand.branch)}"><code>${cand.branch}</code></a>
            <span class="muted">head</span> <code>${short(cand.headSha)}</code>
            ${cand.changeSet !== null ? raw(html`<span class="muted">change</span> #${cand.changeSet}`) : ''}
            ${cand.baseMatches ? '' : raw('<span class="badge state warn">different base</span>')}
          </div>
          <div class="ws-meta">
            <span class="ok">+${cand.vsBase.totals.additions ?? '?'}</span>
            <span class="err">−${cand.vsBase.totals.deletions ?? '?'}</span>
            <span class="muted">in ${cand.vsBase.totals.files} file(s)</span>
            <span class="chip">risk ${cand.vsBase.rating.level}</span>
          </div>
          ${raw(failing)}
          <div class="file-list">${raw(files || '<div class="muted">no changed files</div>')}${raw(more)}</div>
          <div class="pager">
            <a class="btn" href="${raw(compareHref(opts.repo, res.base.ref ?? '', cand.branch))}">Full diff</a>
            ${raw(select)}
          </div>
        </div>
      `;
    })
    .join('');
}

function pairwiseTable(res: candidates.CandidatesResponse | candidates.ArenaCandidatesResponse): string {
  if (res.pairwise.length === 0) return '';
  const rows = res.pairwise
    .map(
      (p) => html`
        <div class="pair-row">
          <div><code>${p.workspaces[0]}</code> <span class="muted">vs</span> <code>${p.workspaces[1]}</code></div>
          <div><span class="muted">${p.fileCount} differing file(s)</span> · <span class="ok">${p.identical} identical</span></div>
          <div class="ws-paths">${raw(chips(p.files.slice(0, 6).map((f) => f.path), 6))}</div>
          ${p.truncated ? raw(html`<div class="flash warn">${p.truncatedReason ?? 'pairwise file list truncated'}</div>`) : ''}
        </div>
      `,
    )
    .join('');
  return html`<div class="card"><div class="card-title">Candidate against candidate</div>${raw(rows)}</div>`;
}

function rankingTable(res: candidates.CandidatesResponse | candidates.ArenaCandidatesResponse): string {
  if (res.ranking.length === 0) return '';
  const rows = res.ranking
    .map(
      (r) => html`
        <div class="pair-row">
          <div><span class="rank">#${r.rank}</span> <code>${r.workspace}</code>${r.changeSet !== null ? raw(html` · <span class="muted">change</span> #${r.changeSet}`) : ''}</div>
          <div class="muted">
            ${checksBadge(r.factors.checks)} · risk ${r.factors.riskLevel} (${r.factors.riskScore}) ·
            ${r.factors.changedLines ?? '?'} line(s) in ${r.factors.changedFiles} file(s)
            ${r.factors.complete ? '' : raw('<span class="badge state warn">incomplete stats</span>')}
          </div>
        </div>
      `,
    )
    .join('');
  return html`<div class="card"><div class="card-title">Ranking <span class="muted">${res.rankingFactors.join(' > ')}</span></div>${raw(rows)}</div>`;
}

function comparisonBody(res: candidates.CandidatesResponse | candidates.ArenaCandidatesResponse, opts: ComparisonOptions): string {
  const overlap = 'overlap' in res ? res.overlap : null;
  const duplication = 'duplication' in res ? res.duplication : null;
  const pairRows = (pairs: ReadonlyArray<{ workspaces: [string, string]; pathCount: number; paths: string[] }>): string =>
    pairs
      .map(
        (p) => html`
          <div class="pair-row">
            <div><code>${p.workspaces[0]}</code> <span class="muted">↔</span> <code>${p.workspaces[1]}</code></div>
            <div class="ws-paths">${raw(chips(p.paths, 6))} <span class="muted">${p.pathCount} shared</span></div>
          </div>
        `,
      )
      .join('');
  const excluded =
    'excluded' in res && res.excluded.length > 0
      ? html`<div class="card">
          <div class="card-title">Excluded</div>
          ${raw(res.excluded.map((e) => html`<div><code>${e.workspace}</code> <span class="muted">${e.reason}</span></div>`).join(''))}
        </div>`
      : '';
  return html`
    ${res.truncated ? raw(html`<div class="flash warn">Comparison truncated: ${res.truncatedReason ?? 'bounded read'} — the shown files and totals cover the discovered subset only.</div>`) : ''}
    ${raw(rankingTable(res))}
    <div class="card">
      <div class="card-title">Candidates against base <code>${res.base.ref}</code> <span class="muted">@ <code>${short(res.base.sha)}</code></span></div>
      <div class="candidate-grid">${raw(candidateCards(res, opts))}</div>
    </div>
    ${raw(pairwiseTable(res))}
    ${raw(excluded)}
    ${
      duplication
        ? raw(
            html`<div class="card"><div class="card-title">Duplication (advisory)</div>${raw(pairRows(duplication.pairs) || '<p class="muted">no duplicated paths between candidates</p>')}${
              duplication.truncated ? raw(html`<div class="flash warn">${duplication.truncatedReason ?? 'bounded read'}</div>`) : ''
            }</div>`,
          )
        : ''
    }
    ${
      overlap
        ? raw(
            html`<div class="card"><div class="card-title">Overlap with other workspaces (advisory)</div>${raw(pairRows(overlap.pairs) || '<p class="muted">none reported</p>')}${
              overlap.truncated ? raw(html`<div class="flash warn">${overlap.truncatedReason ?? 'bounded read'}</div>`) : ''
            }</div>`,
          )
        : ''
    }
  `;
}

// ---------------------------------------------------------------------------
// Free-form candidate comparison
// ---------------------------------------------------------------------------

function candidatesForm(repo: RepoRow, base: string, message: string | null): string {
  return html`
    <div class="card">
      <div class="card-title">Compare workspaces</div>
      ${message ? raw(html`<div class="flash err">${message}</div>`) : raw('<p class="muted">Pick 1-8 workspace ids of this repository and a base branch.</p>')}
      <form method="get" action="/${repo.owner_login}/${repo.name}/candidates">
        <label for="cw-base">Base branch</label>
        <input id="cw-base" name="base" type="text" value="${base}" placeholder="${repo.default_branch || 'main'}" />
        <label for="cw-ids">Workspace ids (comma-separated)</label>
        <input id="cw-ids" name="workspaces" type="text" placeholder="a1b2c3, d4e5f6" />
        <p><button class="btn primary" type="submit">Compare</button></p>
      </form>
    </div>
  `;
}

coordinationPages.get('/candidates', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const repo = resolved.repo;
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const ref = repo.default_branch || 'main';
  const baseQ = c.req.query('base') ?? ref;
  const ids = [
    ...new Set(
      (c.req.queries('workspaces') ?? [])
        .flatMap((v) => v.split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
  if (ids.length === 0) {
    return respond(c, repoPage(c.env, { repo, ref, tab: 'activity', title: 'Candidates' }, viewerLogin, candidatesForm(repo, baseQ, null)));
  }
  const r = await candidates.candidates(candidatesCx(c, resolved), { base: baseQ, workspaces: ids.join(',') });
  if (!r.ok) {
    return respond(
      c,
      repoPage(c.env, { repo, ref, tab: 'activity', title: 'Candidates' }, viewerLogin, candidatesForm(repo, baseQ, r.error)),
      r.status as number,
    );
  }
  const body = html`
    <div class="card">
      <div class="card-title">Candidate comparison</div>
      <p class="muted">${ids.length} workspace(s) at base <code>${r.value.base.ref}</code>. Selection and merging go through the normal change and queue policy.</p>
    </div>
    ${raw(comparisonBody(r.value, { repo, canSelect: false, arenaId: '' }))}
  `;
  return respond(c, repoPage(c.env, { repo, ref, tab: 'activity', title: 'Candidates' }, viewerLogin, body));
});

// ---------------------------------------------------------------------------
// Arenas
// ---------------------------------------------------------------------------

coordinationPages.get('/arenas', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const repo = resolved.repo;
  const ref = repo.default_branch || 'main';
  const viewerLogin = resolved.viewer?.user.login ?? null;
  const r = await candidates.listArenas(candidatesCx(c, resolved), {
    limit: c.req.query('limit') ?? '20',
    cursor: c.req.query('cursor'),
  });
  if (!r.ok) return errorCard(c, resolved, 'activity', 'Arenas unavailable', r);
  const base = `/${repo.owner_login}/${repo.name}`;
  const rows = r.value.arenas
    .map((ar) => {
      const winner = ar.selection
        ? html` · selected <code class="chip">${ar.selection.selectedWorkspace}</code> by ${ar.selection.selectedBy.login ?? ar.selection.selectedBy.agent ?? 'unknown'}`
        : '';
      return html`
        <div class="pair-row">
          <div>
            <a href="${base}/arenas/${ar.id}"><strong>${ar.brief}</strong></a>
            ${stateBadge(ar.state)}
            <span class="muted">${ar.candidates} candidates on <code>${ar.base}</code>${raw(winner)}</span>
          </div>
          <div class="muted">opened ${ago(ar.createdAt)} by ${ar.createdBy ?? 'unknown'} · base <code>${short(ar.baseSha)}</code></div>
        </div>
      `;
    })
    .join('');
  const next = r.value.nextCursor
    ? raw(html`<div class="pager"><a class="btn" href="${base}/arenas?cursor=${encodeURIComponent(r.value.nextCursor)}">Older arenas</a></div>`)
    : '';
  const body = html`<div class="card"><div class="card-title">Arenas</div>${raw(rows || '<p class="muted">no arenas yet</p>')}${next}</div>`;
  return respond(c, repoPage(c.env, { repo, ref, tab: 'activity', title: 'Arenas' }, viewerLogin, body));
});

function arenaBody(arena: ArenaView, res: candidates.ArenaCandidatesResponse, opts: ComparisonOptions): string {
  const winner = arena.selection
    ? raw(
        html`<p><span class="badge state ok">selected</span> <code>${arena.selection.selectedWorkspace}</code> by ${
          arena.selection.selectedBy.login ?? arena.selection.selectedBy.agent ?? 'unknown'
        } ${ago(arena.selection.selectedAt)} — the winner merges through its own change set under the normal policy; the other candidates stay open until abandoned.</p>`,
      )
    : opts.canSelect
      ? raw(
          "<p class=\"muted\">Pick the winner below. Selection records the decision and opens the final-selection escalation on the winner's change set; merging still goes through the normal merge policy.</p>",
        )
      : raw('<p class="muted">Sign in with write access to select the winner. Selection records the decision; merging still goes through the normal merge policy.</p>');
  return html`
    <div class="card">
      <div class="card-title">Arena <span class="muted">${arena.id}</span> ${stateBadge(arena.state)}</div>
      <p><strong>${arena.brief}</strong></p>
      <p class="muted">${arena.candidates} candidates at base <code>${arena.base}</code> <code>${short(arena.baseSha)}</code> · opened ${ago(arena.createdAt)} by ${arena.createdBy ?? 'unknown'}</p>
      ${winner}
    </div>
    ${raw(comparisonBody(res, opts))}
  `;
}

async function arenaPage(c: PageContext, resolved: Resolved, flash: string | null): Promise<Response> {
  const repo = resolved.repo;
  const id = c.req.param('id') ?? '';
  const cx = candidatesCx(c, resolved);
  const [arena, res] = await Promise.all([candidates.getArena(cx, id), candidates.arenaCandidates(cx, id)]);
  if (!arena.ok) return errorCard(c, resolved, 'activity', 'Arena unavailable', arena);
  if (!res.ok) return errorCard(c, resolved, 'activity', 'Candidates unavailable', res);
  const flashCard = flash ? raw(html`<div class="flash err">${flash}</div>`) : '';
  const body = html`${flashCard}${raw(
    arenaBody(arena.value, res.value, {
      repo,
      canSelect: arena.value.state === 'open' && canWrite(resolved),
      arenaId: id,
      csrf: (await requestSession(c))?.csrfToken,
    }),
  )}`;
  return respond(
    c,
    repoPage(
      c.env,
      { repo, ref: repo.default_branch || 'main', tab: 'activity', title: `Arena ${arena.value.brief.slice(0, 60)}` },
      resolved.viewer?.user.login ?? null,
      body,
    ),
  );
}

coordinationPages.get('/arenas/:id', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  return arenaPage(c, resolved, null);
});

coordinationPages.post('/arenas/:id/select', async (c) => {
  const resolved = await resolveRepo(c, 'write');
  if (!resolved) return notFound(c);
  if (!canWrite(resolved)) return notFound(c);
  const form = await c.req.parseBody();
  const refused = await sessionFormRefused(c, resolved.viewer, form);
  if (refused) return refused;
  const workspace = String(form.workspace ?? '');
  const id = c.req.param('id') ?? '';
  const r = await candidates.selectArena(candidatesCx(c, resolved), id, { workspace });
  if (!r.ok) return arenaPage(c, resolved, `${r.error} (${r.code})`);
  return finish(c, c.redirect(`/${resolved.repo.owner_login}/${resolved.repo.name}/arenas/${id}`));
});

// ---------------------------------------------------------------------------
// Train
// ---------------------------------------------------------------------------

coordinationPages.get('/train', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const repo = resolved.repo;
  const r = await trainView(c.env, repo, { base: c.req.query('base') ?? undefined });
  if (!r.ok) return errorCard(c, resolved, 'train', 'Train unavailable', r);
  const tv = r.value;

  // Entries arrive grouped by target, in train order; render one card each.
  const groups: Array<{ target: string; rows: string[] }> = [];
  for (const e of tv.train.entries) {
    let g = groups[groups.length - 1];
    if (!g || g.target !== e.target) {
      g = { target: e.target, rows: [] };
      groups.push(g);
    }
    const waiting = e.waiting
      ? raw(html`<div><span class="badge state warn">waiting</span> ${e.waiting.message} <span class="muted">(pins: ${e.waiting.dependencies.join(', ')})</span></div>`)
      : '';
    const composition = e.composition
      ? raw(html`<div class="muted">composed on <code>${short(e.composition.baseSha)}</code> · tree <code>${short(e.composition.treeSha)}</code></div>`)
      : '';
    g.rows.push(html`
      <div class="pair-row">
        <div>
          <span class="rank">${e.position ?? '·'}</span>
          <strong>#${e.number}</strong> <span class="muted">${e.mergePolicy}</span>
          ${stateBadge(e.state)}
          ${e.agent ? raw(html`<span class="muted">${e.agent.name}</span>`) : e.enqueuedBy ? raw(html`<span class="muted">${e.enqueuedBy}</span>`) : ''}
        </div>
        <div class="muted">enqueued ${ago(e.enqueuedAt)} · head <code>${short(e.headSha)}</code>${e.attempts > 0 ? ` · attempt ${e.attempts + 1}` : ''}</div>
        ${waiting}
        ${composition}
        ${e.reason ? raw(html`<div class="muted">${e.reason.code}: ${e.reason.message ?? ''}</div>`) : ''}
      </div>
    `);
  }
  const groupHtml = groups
    .map((g) => html`<div class="card"><div class="card-title">→ <code>${g.target}</code></div>${raw(g.rows.join(''))}</div>`)
    .join('');

  const exits = tv.exits.exits
    .map(
      (e) => html`
        <div class="pair-row">
          <div><strong>#${e.number}</strong> ${stateBadge(e.state)} <span class="muted">${e.mergePolicy}</span></div>
          <div>${e.reason ? raw(html`<code>${e.reason.code}</code> ${e.reason.message ?? ''}`) : '<span class="muted">no reason recorded</span>'}</div>
          <div class="muted">left the train ${ago(e.exitedAt)}</div>
        </div>
      `,
    )
    .join('');

  const tasks = tv.tasks.tasks
    .map((t) => {
      const paths = t.conflicts?.map((cf) => cf.path) ?? [];
      const needsRegen = t.conflicts?.some((cf) => cf.needsRegeneration) === true;
      const compare = t.baseSha && t.headSha ? raw(html`<a class="btn" href="${compareHref(repo, t.baseSha, t.headSha)}">diff</a>`) : '';
      return html`
        <div class="pair-row">
          <div>
            <strong>${t.kind}</strong> for change #${t.change?.number ?? '—'}
            ${stateBadge(t.lease?.expired ? 'open' : t.status)}
            ${t.claimedBy ? raw(html`<span class="muted">claimed by ${t.claimedBy}${t.lease?.expired ? ' (lease expired)' : ''}</span>`) : ''}
          </div>
          <div class="ws-paths">
            ${raw(chips(paths, 6))}${t.conflictsTruncated ? raw('<span class="muted">+ more paths</span>') : ''}
            ${needsRegen ? raw('<span class="badge state err">needs regeneration</span>') : ''}
          </div>
          <div class="pager"><span class="muted">head <code>${short(t.headSha)}</code> · base <code>${short(t.baseSha)}</code></span> ${compare}</div>
        </div>
      `;
    })
    .join('');

  const limits = tv.train.limits;
  const body = html`
    <div class="card">
      <div class="card-title">
        Integration train
        <span class="muted">window ${limits.window} · ${limits.runnerCapacity} checking at once · admission ${limits.admissionCapacity} · auto-refreshes every ${TRAIN_REFRESH_SECONDS}s</span>
      </div>
      ${tv.train.truncated ? raw(`<div class="flash warn">Only the first ${TRAIN_VIEW_LIMITS.entries} entries are shown; older entries exist.</div>`) : ''}
      ${raw(groupHtml || '<p class="muted">the train is empty — enqueued changes appear here</p>')}
    </div>
    <div class="card">
      <div class="card-title">Recent exits</div>
      ${raw(exits || '<p class="muted">no ejections yet</p>')}
      ${tv.exits.truncated ? raw('<div class="muted">older exits exist and are not shown</div>') : ''}
    </div>
    <div class="card">
      <div class="card-title">Open conflict tasks</div>
      ${raw(tasks || '<p class="muted">no open resolve-conflict tasks</p>')}
      ${tv.tasks.nextCursor ? raw('<div class="muted">more tasks exist</div>') : ''}
    </div>
  `;
  return respond(
    c,
    repoPage(c.env, { repo, ref: repo.default_branch || 'main', tab: 'train', title: 'Train' }, resolved.viewer?.user.login ?? null, body),
    200,
    { refresh: TRAIN_REFRESH_SECONDS },
  );
});
