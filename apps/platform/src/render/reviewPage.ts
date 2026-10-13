/**
 * Guided review pages (architecture §0.4.1): the change inbox ordered by whose
 * turn it is, and the review page that walks a change chapter by chapter with
 * danger tiers, contracts, findings and per-unit acknowledgement. Pure string
 * renderers over the service views so they can be tested without a request.
 */

import { escapeHtml as esc, html, raw, timeAgo } from '@kvarm/ui';
import type { DiffLine, Hunk } from '@kvarm/diffcore';
import type { ReviewGuideView } from '../services/reviewGuide';

export type ReviewView = 'guided' | 'risk' | 'files';

type Unit = ReviewGuideView['units'][number];
type Finding = Record<string, unknown>;

interface Section {
  id: string;
  title: string;
  why?: string;
  tier: Unit['tier'];
  units: Unit[];
  notes?: Array<{ hunk?: string; kind?: string; text?: string }>;
}

const TIER_RANK: Record<Unit['tier'], number> = { scrutinize: 0, read: 1, receipt: 2 };
const TIER_LABEL: Record<Unit['tier'], string> = { scrutinize: 'scrutinize', read: 'read', receipt: 'receipt' };
const WAITING_LABEL: Record<string, string> = {
  none: 'done',
  human: 'waiting on a human',
  checks: 'waiting on checks',
  author: 'waiting on the author',
  reviewers: 'waiting on reviewers',
  queue: 'ready to queue',
};

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 10) : '—';
}

function anchor(key: string): string {
  return `u-${key}`;
}

function sectionsFor(view: ReviewGuideView, mode: ReviewView): Section[] {
  const byKey = new Map(view.units.map((u) => [u.key, u]));
  if (mode === 'guided') {
    return view.guide.chapters.map((ch) => ({
      id: ch.id,
      title: ch.title,
      ...(ch.why ? { why: ch.why } : {}),
      tier: ch.tier,
      units: ch.hunks.map((k) => byKey.get(k)).filter((u): u is Unit => u !== undefined),
      ...(ch.notes ? { notes: ch.notes as Section['notes'] } : {}),
    }));
  }
  if (mode === 'risk') {
    return (['scrutinize', 'read', 'receipt'] as const)
      .map((tier) => ({ id: `tier-${tier}`, title: TIER_LABEL[tier], tier, units: view.units.filter((u) => u.tier === tier) }))
      .filter((s) => s.units.length > 0);
  }
  const paths = new Map<string, Unit[]>();
  for (const u of view.units) paths.set(u.path, [...(paths.get(u.path) ?? []), u]);
  return [...paths.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, units], i) => ({
      id: `file-${i}`,
      title: path,
      tier: units.reduce<Unit['tier']>((t, u) => (TIER_RANK[u.tier] < TIER_RANK[t] ? u.tier : t), 'receipt'),
      units,
    }));
}

/** Unit ranges are half-open; an empty side (pure insert or delete) is omitted. */
function span(sign: string, start: number, end: number): string {
  if (end <= start) return '';
  return end - start === 1 ? `${sign}L${start}` : `${sign}L${start}–${end - 1}`;
}

function lineRow(line: DiffLine): string {
  const mark = line.type === 'ins' ? '+' : line.type === 'del' ? '−' : ' ';
  return `<tr class="rv-l ${line.type}"><td class="ln">${line.oldNo ?? ''}</td><td class="ln">${line.newNo ?? ''}</td><td class="mk">${mark}</td><td class="code">${esc(line.text)}</td></tr>`;
}

function hunkTable(hunks: Hunk[]): string {
  return `<table class="rv-diff">${hunks
    .map(
      (h) =>
        `<tr class="rv-l hunk"><td class="ln" colspan="3"></td><td class="code">@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@</td></tr>${h.lines.map(lineRow).join('')}`,
    )
    .join('')}</table>`;
}

function findingCard(f: Finding): string {
  const sev = String(f.severity ?? '');
  const open = f.status === 'open';
  const where = `${String(f.path ?? '')}:${String(f.startLine ?? '')}`;
  return html`<div class="rv-finding sev-${sev}${open ? '' : ' closed'}">
    <div class="rv-finding-head">
      <span class="chip sev">${sev}</span>
      <span class="chip">${String(f.category ?? '')}</span>
      <span class="chip">${String(f.confidence ?? '')}</span>
      <strong>${String(f.title ?? '')}</strong>
      <span class="spacer"></span>
      ${f.unitKey ? raw(`<a class="muted" href="#${anchor(String(f.unitKey))}"><code>${esc(where)}</code></a>`) : raw(`<code class="muted">${esc(where)}</code>`)}
      ${open ? '' : raw(`<span class="chip">${esc(String(f.status))}</span>`)}
    </div>
    ${f.scenario ? raw(html`<p><span class="muted">Scenario</span> ${String(f.scenario)}</p>`) : ''}
    ${f.verify ? raw(html`<p><span class="muted">Verify</span> ${String(f.verify)}</p>`) : ''}
    ${f.body ? raw(html`<p>${String(f.body)}</p>`) : ''}
  </div>`;
}

function unitBlock(u: Unit, chapterTier: Unit['tier'], findings: Finding[], ctx: PageCtx): string {
  const range = u.kind === 'file' ? 'whole file' : `${span('−', u.ranges.oldStart, u.ranges.oldEnd)} ${span('+', u.ranges.newStart, u.ranges.newEnd)}`.trim();
  const raised = TIER_RANK[u.floor] < TIER_RANK[chapterTier];
  const chips = [
    `<span class="chip tier-${u.tier}">${u.tier}</span>`,
    raised ? `<span class="chip signal" title="Kvarm raised this above the chapter's tier">raised from ${chapterTier}</span>` : '',
    u.contract ? '<span class="chip signal">contract</span>' : '',
    u.ackCount > 0 ? `<span class="chip" title="reviewers who acknowledged this unit">${u.ackCount} ack</span>` : '',
  ].join('');
  const body = u.receipt
    ? `<details class="rv-receipt"><summary>${esc(u.receipt)}</summary>${u.hunks ? hunkTable(u.hunks) : ''}</details>`
    : u.hunks
      ? hunkTable(u.hunks)
      : `<p class="muted">Diff not inlined for this unit; open it in <a href="${ctx.base}/compare/${encodeURIComponent(`${ctx.view.baseSha}...${ctx.view.headSha}`)}">compare</a>.</p>`;
  const ack = ctx.canWrite
    ? `<form method="post" action="${ctx.pageBase}/ack" class="rv-ack"><input type="hidden" name="head" value="${esc(ctx.view.headSha)}"><input type="hidden" name="units" value="${esc(u.key)}"><input type="hidden" name="return" value="${esc(ctx.returnTo)}#${anchor(u.key)}"><button class="btn" type="submit"${u.acked ? ' disabled' : ''}>${u.acked ? 'Reviewed' : 'Mark reviewed'}</button></form>`
    : '';
  return `<section class="rv-unit tier-${u.tier}${u.acked ? ' acked' : ''}" id="${anchor(u.key)}" data-key="${esc(u.key)}" tabindex="-1">
    <header><code>${esc(u.path)}</code> <span class="muted">${range}</span> ${chips}<span class="spacer"></span>${ack}</header>
    ${body}
    ${findings.map((f) => findingCard(f)).join('')}
  </section>`;
}

interface PageCtx {
  view: ReviewGuideView;
  base: string;
  pageBase: string;
  returnTo: string;
  canWrite: boolean;
}

export interface ReviewPageInput {
  view: ReviewGuideView;
  title: string;
  base: string;
  mode: ReviewView;
  canWrite: boolean;
  canReview: boolean;
  flash?: string | null;
}

export function reviewPageBody(input: ReviewPageInput): string {
  const { view, base, mode } = input;
  const pageBase = `${base}/changes/${view.number}`;
  const returnTo = `${pageBase}?view=${mode}`;
  const ctx: PageCtx = { view, base, pageBase, returnTo, canWrite: input.canWrite };
  const sections = sectionsFor(view, mode);
  const findingsByUnit = new Map<string, Finding[]>();
  const loose: Finding[] = [];
  for (const f of view.findings.items) {
    const k = typeof f.unitKey === 'string' ? f.unitKey : null;
    if (k && view.units.some((u) => u.key === k)) findingsByUnit.set(k, [...(findingsByUnit.get(k) ?? []), f]);
    else loose.push(f);
  }
  const acked = view.units.filter((u) => u.acked).length;
  const scrutinize = view.units.filter((u) => u.tier === 'scrutinize');
  const scrutinizeOpen = scrutinize.filter((u) => !u.acked).length;
  const waiting = view.attention.waitingOn;
  const blockers = (view.review.blockers as Array<{ code?: string; error?: string }>).map(
    (b) => `<li><code>${esc(b.code ?? '')}</code> ${esc(b.error ?? '')}</li>`,
  );
  const sourceNote: Record<string, string> = {
    author: 'Guide written by the author',
    reviewer: 'Guide written by a reviewer',
    carried: `Guide carried forward from ${short(view.fromHead)}; new hunks are in Unguided`,
    fallback: 'No guide submitted; Kvarm grouped the change by path',
  };

  const rail = sections
    .map((s) => {
      const done = s.units.filter((u) => u.acked).length;
      return `<li class="${done === s.units.length && s.units.length > 0 ? 'done' : ''}"><a href="#ch-${esc(s.id)}"><span class="dot tier-${s.tier}"></span>${esc(s.title)}</a> <span class="muted">${done}/${s.units.length}</span></li>`;
    })
    .join('');

  const chapters = sections
    .map((s) => {
      const notes = (s.notes ?? []).filter((n) => !n.hunk && n.text).map((n) => `<p class="rv-note"><span class="chip">${esc(n.kind ?? 'note')}</span> ${esc(n.text)}</p>`);
      const unackedKeys = s.units.filter((u) => !u.acked).map((u) => u.key);
      const ackAll =
        input.canWrite && unackedKeys.length > 1
          ? `<form method="post" action="${pageBase}/ack" class="rv-ack"><input type="hidden" name="head" value="${esc(view.headSha)}"><input type="hidden" name="units" value="${esc(unackedKeys.join(','))}"><input type="hidden" name="return" value="${esc(returnTo)}#ch-${esc(s.id)}"><button class="btn" type="submit">Mark chapter reviewed</button></form>`
          : '';
      return `<section class="rv-chapter" id="ch-${esc(s.id)}">
        <h2><span class="chip tier-${s.tier}">${s.tier}</span> ${esc(s.title)} <span class="spacer"></span>${ackAll}</h2>
        ${s.why ? `<p class="muted">${esc(s.why)}</p>` : ''}${notes.join('')}
        ${s.units.map((u) => unitBlock(u, s.tier, findingsByUnit.get(u.key) ?? [], ctx)).join('') || '<p class="muted">No changed units.</p>'}
      </section>`;
    })
    .join('');

  const g = view.guide;
  const overview = html`
    <div class="card rv-overview">
      <div class="card-title">Intent <span class="chip">${g.source}</span></div>
      <p>${g.intent}</p>
      ${g.steps && g.steps.length ? raw(`<ol class="rv-steps">${g.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`) : ''}
      ${
        g.beforeAfter && g.beforeAfter.length
          ? raw(
              `<div class="rv-ba"><div class="h"></div><div class="h">Before</div><div class="h">After</div>${g.beforeAfter
                .map((b) => `<div class="lane">${esc(b.lane)}</div><div>${esc(b.before)}</div><div>${esc(b.after)}</div>`)
                .join('')}</div>`,
            )
          : ''
      }
      <p class="muted">${sourceNote[g.source] ?? ''}</p>
    </div>`;

  const contracts = view.contracts;
  const impact = html`
    <div class="card rv-impact">
      <div class="card-title">Danger and impact</div>
      <ul class="rv-facts">
        <li><strong>${scrutinize.length}</strong> unit(s) need scrutiny${scrutinizeOpen ? raw(` · <span class="err">${scrutinizeOpen} not yet reviewed</span>`) : ''}</li>
        <li><strong>${contracts.changed.length}</strong> contract surface(s) changed${
          contracts.undeclared.length ? raw(` · <span class="err">${contracts.undeclared.length} undeclared</span>`) : ''
        }</li>
        <li><strong>${view.findings.open}</strong> open finding(s), ${view.findings.resolved} resolved</li>
        <li><strong>${view.coverage.gaps}</strong> unguided unit(s) of ${view.coverage.units}${view.coverage.truncated ? raw(' · <span class="err">truncated</span>') : ''}</li>
      </ul>
      ${
        contracts.changed.length
          ? raw(
              `<table class="rv-contracts">${contracts.changed
                .map((p) => {
                  const d = contracts.declared.find((x) => x.surface === p);
                  const state = d ? `<span class="chip${d.impact === 'breaking' ? ' signal' : ''}">${esc(d.impact)}</span>${d.note ? ` <span class="muted">${esc(d.note)}</span>` : ''}` : '<span class="chip err">undeclared</span>';
                  return `<tr><td><code>${esc(p)}</code></td><td>${state}</td></tr>`;
                })
                .join('')}</table>`,
            )
          : ''
      }
      ${g.unchanged && g.unchanged.length ? raw(`<p class="muted">Author says unchanged: ${g.unchanged.map((x) => esc(x)).join(' · ')}</p>`) : ''}
      ${view.configError ? raw(`<div class="flash warn">.kvarm/review.json on the base is invalid: ${esc(view.configError)}</div>`) : ''}
    </div>`;

  const decision = input.canReview
    ? html`<div class="card rv-decision" id="decision">
        <div class="card-title">Verdict at <code>${short(view.headSha)}</code></div>
        ${scrutinizeOpen ? raw(`<p class="flash warn">${scrutinizeOpen} scrutinize unit(s) are not marked reviewed yet.</p>`) : ''}
        <form method="post" action="${raw(pageBase)}/review">
          <input type="hidden" name="head" value="${view.headSha}">
          <textarea name="body" rows="3" placeholder="Optional note"></textarea>
          <p><button class="btn primary" name="verdict" value="approve" type="submit">Approve</button>
          <button class="btn" name="verdict" value="request-changes" type="submit">Request changes</button></p>
        </form>
      </div>`
    : '';

  return html`
    <div class="rv-root" data-ack-url="${raw(pageBase)}/ack">
      ${input.flash ? raw(`<div class="flash err">${esc(input.flash)}</div>`) : ''}
      <div class="card rv-head">
        <div class="card-title"><strong>#${view.number} ${input.title}</strong> <span class="muted">head <code>${short(view.headSha)}</code></span></div>
        <div class="rv-strip">
          <span class="badge state rv-wait-${waiting}">${WAITING_LABEL[waiting] ?? waiting}</span>
          <span>${view.review.approvals.count}/${view.review.approvals.required} approvals</span>
          <span class="rv-progress" data-total="${view.units.length}"><span class="bar"><span style="width:${raw(String(view.units.length ? Math.round((acked / view.units.length) * 100) : 100))}%"></span></span> <span class="n">${acked}</span>/${view.units.length} reviewed</span>
          ${view.attention.reasons.length ? raw(`<span class="muted">${view.attention.reasons.map((r) => esc(r)).join(' · ')}</span>`) : ''}
        </div>
        ${blockers.length ? raw(`<ul class="rv-blockers">${blockers.join('')}</ul>`) : ''}
        ${view.truncated || view.hunksTruncated ? raw('<div class="flash warn">Some hunks are not inlined (bounded read); the coverage counts still include them.</div>') : ''}
        <div class="pager">
          <span class="muted">view</span>
          ${raw((['guided', 'risk', 'files'] as const).map((m) => (m === mode ? `<strong>${m}</strong>` : `<a href="${pageBase}?view=${m}">${m}</a>`)).join(' '))}
          <span class="spacer"></span>
          <span class="muted">keys: j/k next/previous unit · a mark reviewed</span>
        </div>
      </div>
      <div class="rv-layout">
        <nav class="rv-rail"><ol>${raw(rail)}</ol></nav>
        <div class="rv-main">
          ${raw(overview)}
          ${raw(impact)}
          ${loose.length ? raw(`<div class="card"><div class="card-title">Findings outside the current diff</div>${loose.map((f) => findingCard(f)).join('')}</div>`) : ''}
          ${raw(chapters)}
          ${raw(decision)}
        </div>
      </div>
    </div>`;
}

export interface InboxItem {
  number: number;
  title: string;
  state: string;
  attention: { waitingOn: string; reasons: string[] };
  yourTurn: boolean;
  risk: { score: number | null; level: string | null };
  updatedAt: string;
  review: { approvals: { count: number; required: number } };
}

export function changesInboxBody(base: string, items: InboxItem[], truncated: boolean): string {
  const row = (c: InboxItem): string => `<div class="repo-row rv-inbox-row">
      <div><a href="${base}/changes/${c.number}"><strong>#${c.number}</strong> ${esc(c.title)}</a>
      <div class="muted">${esc(WAITING_LABEL[c.attention.waitingOn] ?? c.attention.waitingOn)}${c.attention.reasons.length ? ` · ${c.attention.reasons.map((r) => esc(r)).join(' · ')}` : ''}</div></div>
      <div>${c.risk.level ? `<span class="chip${c.risk.level === 'high' ? ' signal' : ''}">risk ${esc(c.risk.level)}</span>` : ''}
      <span class="chip">${c.review.approvals.count}/${c.review.approvals.required}</span>
      <span class="muted">${timeAgo(Date.parse(c.updatedAt))}</span></div>
    </div>`;
  const mine = items.filter((c) => c.yourTurn);
  const others = items.filter((c) => !c.yourTurn);
  return html`
    <div class="card">
      <div class="card-title">Your turn <span class="muted">${mine.length}</span></div>
      ${raw(mine.map(row).join('') || '<p class="muted">Nothing is waiting on you.</p>')}
    </div>
    <div class="card">
      <div class="card-title">Waiting on others <span class="muted">${others.length}</span></div>
      ${raw(others.map(row).join('') || '<p class="muted">No other open changes.</p>')}
      ${truncated ? raw('<div class="flash warn">Showing the first page of open changes.</div>') : ''}
    </div>`;
}
