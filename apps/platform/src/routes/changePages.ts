/**
 * Repository change list and review pages. Reads and writes stay on the
 * existing change, review, and compare services.
 */

import { Hono, type Context } from 'hono';
import { escapeHtml, html, raw, timeAgo } from '@kvarm/ui';
import { buildCoverage, fallbackGuide, parseReviewConfig, type CoverageFileInput, type ReviewTier } from '@kvarm/review';
import { readFileAt } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import { repoPage } from '../render/repoShell';
import { authorizeRoute, requestSession, type App } from './api';
import { csrfInput } from '../web/render';
import { resolveRepo, notFound, finish, sessionFormRefused, type Resolved } from './repoPages';
import * as changes from '../services/changes';
import * as reviews from '../services/reviews';
import * as compare from '../services/compare';
import { DIFF_CLIENT_TAG, renderCompareFileRow } from './comparePages';

export const changePages = new Hono<App>();

const HTML = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } as const;
const LIST_LIMIT = 25;
const COVERAGE_FILES = 30;
const COVERAGE_BYTES = 512 * 1024;
const CONFIG_BYTES = 64 * 1024;

type ReviewTierLabel = ReviewTier;

function base(repo: RepoRow): string {
  return `/${repo.owner_login}/${repo.name}`;
}

function page(c: Context<App>, resolved: Resolved, title: string, body: string, tab: 'changes' | 'review' = 'changes'): Response {
  const content = repoPage(
    c.env,
    { repo: resolved.repo, ref: resolved.repo.default_branch || 'main', tab: 'changes', title, head: tab === 'review' ? DIFF_CLIENT_TAG : undefined },
    resolved.viewer?.user.login ?? null,
    body,
  );
  return finish(c, new Response(content, { headers: HTML }));
}

function queryFlash(c: Context<App>): string {
  const error = c.req.query('error');
  const notice = c.req.query('notice');
  if (error) return html`<div class="flash err">${error.slice(0, 300)}</div>`;
  if (notice) return html`<div class="flash ok">${notice.slice(0, 300)}</div>`;
  return '';
}

function redirect(c: Context<App>, url: string, value: { error?: string; notice?: string }): Response {
  const query = new URLSearchParams();
  if (value.error) query.set('error', value.error);
  if (value.notice) query.set('notice', value.notice);
  return finish(c, c.redirect(`${url}?${query.toString()}`, 303));
}

function stateTag(state: string): string {
  const klass = state === 'merged' ? 'ok' : state === 'conflicted' ? 'err' : state === 'closed' ? 'muted' : 'signal';
  return html`<span class="tag ${klass}">${state}</span>`;
}

function checksSummary(checks: readonly { status: string; conclusion: string | null; required: boolean }[]): string {
  if (checks.length === 0) return html`<span class="muted">no checks reported</span>`;
  const required = checks.filter((check) => check.required);
  const rows = required.length > 0 ? required : checks;
  const failed = rows.filter((check) => check.conclusion === 'failure' || check.status === 'failure').length;
  const pending = rows.filter((check) => check.status !== 'completed' && check.conclusion === null).length;
  const passed = rows.filter((check) => check.conclusion === 'success' || check.status === 'success').length;
  if (failed) return html`<span class="err">${failed} failing</span>`;
  if (pending) return html`<span class="muted">${pending} pending</span>`;
  if (passed) return html`<span class="ok">${passed} passing</span>`;
  return html`<span class="muted">${rows.length} reported</span>`;
}

changePages.get('/changes', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  const state = c.req.query('state') ?? 'open';
  const [listed, pending] = await Promise.all([
    changes.listChanges(c.env, resolved.repo, { state, limit: String(LIST_LIMIT), cursor: c.req.query('cursor') }),
    reviews.pendingReviews(c.env, resolved.repo, { limit: '25' }),
  ]);
  if (!listed.ok) return page(c, resolved, 'Changes', html`<div class="flash err">${listed.error}</div>`);
  const checkResults = await Promise.all(
    listed.value.changes.map((change) => changes.listChangeChecks(c.env, resolved.repo, String(change.number))),
  );
  const checkByNumber = new Map<number, string>();
  listed.value.changes.forEach((change, index) => {
    const result = checkResults[index];
    checkByNumber.set(change.number, result?.ok ? checksSummary(result.value.checks) : html`<span class="muted">unavailable</span>`);
  });
  const pendingRows = pending.ok
    ? pending.value.changes.map((change) => html`
        <li><a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}"><span class="hud">#${change.number}</span> ${change.title}</a>
          <span class="muted">· ${change.approvals.count}/${change.approvals.required} approvals</span></li>`).join('')
    : html`<li class="muted">Review queue unavailable.</li>`;
  const pendingContent = pending.ok
    ? pending.value.changes.length
      ? html`<ul class="k-list">${raw(pendingRows)}</ul>`
      : html`<p class="muted">No changes are waiting for review.</p>`
    : html`<p class="muted">The review queue is unavailable.</p>`;
  const rows = listed.value.changes.map((change) => html`
    <tr>
      <td><a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}">#${change.number}</a></td>
      <td><a href="${raw(`${base(resolved.repo)}/changes/${change.number}`)}">${change.title}</a></td>
      <td><code>${change.head}</code> <span class="muted">→</span> <code>${change.base}</code></td>
      <td>${raw(stateTag(change.state))}</td>
      <td>${raw(checkByNumber.get(change.number) ?? '')}</td>
      <td class="muted">${timeAgo(Date.parse(change.updatedAt))}</td>
    </tr>`).join('');
  const filters = (['open', 'merged', 'closed'] as const).map((value) =>
    html`<a class="tab ${state === value ? 'active' : ''}" href="${raw(`${base(resolved.repo)}/changes?state=${value}`)}"${state === value ? ' aria-current="page"' : ''}>${value}</a>`,
  ).join('');
  const next = listed.value.nextCursor
    ? html`<p><a class="btn" href="${raw(`${base(resolved.repo)}/changes?state=${state}&cursor=${listed.value.nextCursor}`)}">Older changes</a></p>`
    : '';
  return page(c, resolved, 'Changes', html`
    ${raw(queryFlash(c))}
    <section class="card review-pending">
      <div class="card-title">Needs your review</div>
      ${raw(pendingContent)}
    </section>
    <section class="card">
      <div class="card-title">Changes</div>
      <nav class="tabs change-filters" aria-label="Filter changes">${raw(filters)}</nav>
      <div class="table-wrap"><table class="table changes-table">
        <thead><tr><th>Change</th><th>Title</th><th>Head → base</th><th>State</th><th>Checks</th><th>Updated</th></tr></thead>
        <tbody>${raw(rows || '<tr><td colspan="6" class="muted">No changes in this state.</td></tr>')}</tbody>
      </table></div>
      ${raw(next)}
    </section>`);
});

function stageStrip(change: changes.ChangeDetail, packet: reviews.ReviewPacket): string {
  const merged = change.state === 'merged';
  const failed = change.checks.some((check) => check.conclusion === 'failure' || check.status === 'failure');
  const checksDone =
    change.checks.length > 0 &&
    change.checks.every((check) => check.status === 'success' || check.status === 'failure' || check.status === 'skipped' || check.conclusion !== null);
  const queued = change.queueState !== null;
  const stages = [
    ['Checks', failed ? 'blocked' : checksDone ? 'done' : 'current'],
    ['Review', merged || packet.satisfied ? 'done' : failed ? 'pending' : 'current'],
    ['Train', merged ? 'done' : queued ? 'current' : 'pending'],
    ['Merged', merged ? 'done' : 'pending'],
  ] as const;
  return html`<ol class="change-stages">${raw(stages.map(([label, status]) => `<li class="${status}"><span class="stage-mark"></span><span>${label}</span></li>`).join(''))}</ol>`;
}

function tierFor(guide: ReturnType<typeof fallbackGuide>, keys: readonly string[]): ReviewTierLabel {
  const order: Record<ReviewTier, number> = { receipt: 0, read: 1, scrutinize: 2 };
  return keys.map((key) => guide.tiers[key] ?? 'read').reduce((a, b) => order[a] >= order[b] ? a : b, 'receipt');
}

function tierTag(tier: ReviewTier): string {
  const klass = tier === 'scrutinize' ? 'heat-3 fail' : tier === 'read' ? 'signal-hi' : 'steel';
  return html`<span class="tag review-tier ${klass}">${tier}</span>`;
}

function renderGuide(
  repo: RepoRow,
  encRange: string,
  result: compare.CompareResponse,
  guide: ReturnType<typeof fallbackGuide>,
  map: Awaited<ReturnType<typeof buildCoverage>>,
  configError: string | null,
): string {
  const units = new Map(map.units.map((unit) => [unit.key, unit]));
  const files = new Map(result.files.map((file) => [file.path, file]));
  const rows = guide.chapters.map((chapter) => {
    const keysByPath = new Map<string, string[]>();
    for (const key of chapter.hunks) {
      const unit = units.get(key);
      if (!unit) continue;
      const keys = keysByPath.get(unit.path) ?? [];
      keys.push(key);
      keysByPath.set(unit.path, keys);
    }
    const fileRows = [...keysByPath].map(([path, keys]) => {
      const file = files.get(path);
      if (!file) return '';
      return renderCompareFileRow(repo, encRange, file, tierFor(guide, keys));
    }).join('');
    return html`<section class="card guide-chapter">
      <div class="card-title">${chapter.title} ${raw(tierTag(chapter.tier))}</div>
      ${chapter.why ? raw(html`<p class="muted">${chapter.why}</p>`) : ''}
      ${raw(chapter.notes?.map((note) => html`<p class="guide-note">${note.body}</p>`).join('') ?? '')}
      <div class="compare-list">${raw(fileRows || '<p class="muted">No diff rows in this chapter.</p>')}</div>
    </section>`;
  }).join('');
  const counts = { scrutinize: new Set<string>(), read: new Set<string>(), receipt: new Set<string>() };
  for (const unit of map.units) {
    const tier = guide.tiers[unit.key] ?? unit.defaultTier;
    counts[tier].add(unit.path);
  }
  const summary = html`<section class="card coverage-summary">
    <div class="card-title">Coverage · ${guide.source === 'fallback' ? 'Generated guide' : 'Author guide'}</div>
    <div class="coverage-counts">
      <span>${raw(tierTag('scrutinize'))} ${counts.scrutinize.size} files</span>
      <span>${raw(tierTag('read'))} ${counts.read.size} files</span>
      <span>${raw(tierTag('receipt'))} ${counts.receipt.size} files</span>
    </div>
    ${map.truncated ? raw(html`<p class="flash warn">Coverage is truncated by the review-page diff budget.</p>`) : ''}
    ${configError ? raw(html`<p class="flash warn">${configError}</p>`) : ''}
  </section>`;
  return html`<div class="compare-root review-guide-root" data-file-api="/api/v1/repos/${repo.owner_login}/${repo.name}/compare/${raw(encRange)}/file">
    ${raw(summary)}
    ${raw(rows || '<p class="muted">No reviewable files in this change.</p>')}
  </div>`;
}

function checkRows(change: changes.ChangeDetail): string {
  if (!change.checks.length) return html`<p class="muted">No checks have been reported.</p>`;
  return html`<ul class="k-list">${raw(change.checks.map((check) => {
    const state = check.conclusion ?? check.status;
    const klass = state === 'success' ? 'ok' : state === 'failure' ? 'err' : 'muted';
    const link = check.detailsUrl ? `<a href="${escapeHtml(check.detailsUrl)}" rel="nofollow noopener">${escapeHtml(check.name)}</a>` : escapeHtml(check.name);
    return `<li><span>${link}</span> <span class="tag ${klass}">${escapeHtml(state)}</span>${check.required ? ' <span class="muted">required</span>' : ''}</li>`;
  }).join(''))}</ul>`;
}

function reviewTimeline(packet: reviews.ReviewPacket): string {
  if (!packet.reviews.length) return html`<p class="muted">No reviews submitted yet.</p>`;
  return html`<ol class="review-timeline">${raw(packet.reviews.map((review) => `
    <li><div><strong>${escapeHtml(review.reviewer.agent?.name ?? review.reviewer.login)}</strong>
      <span class="tag ${review.verdict === 'approve' ? 'ok' : 'err'}">${escapeHtml(review.verdict)}</span>
      ${review.current ? '' : '<span class="muted"> · previous head</span>'}
      <span class="muted"> · ${timeAgo(Date.parse(review.updatedAt))}</span></div>
      ${review.body ? `<p>${escapeHtml(review.body)}</p>` : ''}</li>`).join(''))}</ol>`;
}

async function renderDetail(c: Context<App>, resolved: Resolved, number: string): Promise<Response> {
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: resolved.repo,
    actor: resolved.viewer,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const [detail, packet] = await Promise.all([
    changes.getChange(cx, number),
    reviews.getReviewPacket(c.env, resolved.repo, number),
  ]);
  if (!detail.ok || !packet.ok) return notFound(c);
  const change = detail.value;
  const reviewPacket = packet.value;
  const path = `${base(resolved.repo)}/changes/${change.number}`;
  const encRange = encodeURIComponent(`${change.base}...${change.headSha ?? change.head}`);
  let coverageBody = html`<div class="flash warn">The base or head commit is unavailable for a bounded diff.</div>`;
  let configError: string | null = null;
  if (change.headSha) {
    const diff = await compare.compare(
      { env: c.env, repo: resolved.repo, bypass: false, waitUntil: (promise) => c.executionCtx.waitUntil(promise) },
      change.base,
      change.headSha,
      { order: 'path', limit: '100' },
    );
    if (diff.ok) {
      const response = diff.value.response;
      const inputs: CoverageFileInput[] = [];
      let reads = 0;
      let usedBytes = 0;
      let exhausted = response.truncated || response.nextCursor !== undefined;
      for (const file of response.files) {
        let hunks: CoverageFileInput['hunks'] = null;
        let truncated = false;
        if (!file.binary && !file.tooLarge && !exhausted && reads < COVERAGE_FILES) {
          const found = await compare.fileDiff(
            { env: c.env, repo: resolved.repo, bypass: false, waitUntil: (promise) => c.executionCtx.waitUntil(promise) },
            change.base,
            change.headSha,
            file.path,
          );
          reads++;
          if (found.ok && !found.value.response.binary && !found.value.response.tooLarge) {
            const size = new TextEncoder().encode(JSON.stringify(found.value.response.hunks)).byteLength;
            if (usedBytes + size <= COVERAGE_BYTES) {
              hunks = found.value.response.hunks;
              usedBytes += size;
              truncated = found.value.response.truncated === true;
            } else {
              truncated = true;
              exhausted = true;
            }
          } else if (!found.ok) {
            truncated = true;
            exhausted = true;
          }
        } else if (!file.binary && !file.tooLarge && !exhausted) {
          truncated = true;
          exhausted = true;
        } else if (!file.binary && !file.tooLarge && exhausted) {
          truncated = true;
        }
        inputs.push({
          path: file.path,
          ...(file.oldPath ? { oldPath: file.oldPath } : {}),
          status: file.status,
          oldHash: file.oldHash,
          newHash: file.newHash,
          additions: file.additions,
          deletions: file.deletions,
          tags: file.risk.tags,
          hunks,
          ...(truncated ? { truncated: true } : {}),
        });
      }
      let config: Parameters<typeof buildCoverage>[1] = {};
      try {
        const blob = await readFileAt(c.env, resolved.repo.artifacts_name, change.headSha, '.kvarm/review.json');
        if (blob) {
          if (blob.size > CONFIG_BYTES) {
            configError = '.kvarm/review.json exceeds the 64 KiB config limit; default review tiers are used.';
          } else {
            const parsed = parseReviewConfig(await blob.text());
            if (parsed.ok) config = parsed.value;
            else configError = `${parsed.error}; default review tiers are used.`;
          }
        }
      } catch {
        configError = 'Could not read .kvarm/review.json; default review tiers are used.';
      }
      const map = await buildCoverage(inputs, config);
      if (response.truncated || response.nextCursor !== undefined) map.truncated = true;
      const guide = fallbackGuide(map);
      coverageBody = renderGuide(resolved.repo, encRange, response, guide, map, configError);
    } else {
      coverageBody = html`<div class="flash warn">Diff coverage unavailable: ${diff.error}</div>`;
    }
  }
  const checkTags = change.checks.map((check) => html`<span class="tag">${check.name}: ${check.conclusion ?? check.status}</span>`).join(' ');
  const reviewRows = reviewTimeline(reviewPacket);
  const writable = resolved.viewer !== null && (resolved.role === 'write' || resolved.role === 'admin');
  const csrf = writable ? csrfInput((await requestSession(c))?.csrfToken) : '';
  const author =
    reviewPacket.author.agent && reviewPacket.author.login
      ? html`agent <strong>${reviewPacket.author.agent.name}</strong> for ${reviewPacket.author.login}`
      : reviewPacket.author.agent
        ? html`agent <strong>${reviewPacket.author.agent.name}</strong>`
        : html`<strong>${reviewPacket.author.login ?? 'unknown'}</strong>`;
  const blockers = reviewPacket.blockers.map((item) => `<li>${escapeHtml(item.error)}</li>`).join('');
  const reasons = change.rating?.reasons.map((reason) => html`<li>${reason}</li>`).join('') ?? '';
  const body = html`
    ${raw(queryFlash(c))}
    <header class="k-head change-head">
      <p class="hud">#${change.number} · ${change.head} → ${change.base} · ${change.state}</p>
      <h1>${change.title}</h1>
      <p class="lede">by ${raw(author)} · mergeability:
        ${change.mergeability ? raw(stateTag(change.mergeability.status)) : html`<span class="tag muted">not evaluated</span>`}</p>
    </header>
    ${raw(stageStrip(change, reviewPacket))}
    <div class="change-review-grid">
      <main class="change-review-main">
        <section class="card review-packet">
          <div class="card-title">Review packet <span class="tag ${change.rating?.level ?? 'muted'}">${change.rating ? `${change.rating.level} risk · ${change.rating.score}` : 'risk unavailable'}</span></div>
          ${change.rating?.reasons.length
            ? raw(html`<ul>${raw(reasons)}</ul>`)
            : raw(html`<p class="muted">No risk reasons recorded.</p>`)}
          <div class="guard-results"><strong>Guard results</strong><div>${raw(checkTags || '<span class="muted">No check results yet.</span>')}</div></div>
        </section>
        ${raw(coverageBody)}
        <section class="card">
          <div class="card-title">Reviews</div>
          ${raw(reviewRows)}
        </section>
        ${writable ? raw(html`<section class="card review-form-card">
          <div class="card-title">Submit a review</div>
          <form method="post" action="${raw(`${path}/review`)}">
            ${raw(csrf)}
            <input type="hidden" name="headSha" value="${change.headSha ?? ''}" />
            <label for="review-body">Review note</label>
            <textarea id="review-body" name="body" rows="6" maxlength="65536"></textarea>
            <div class="review-actions">
              <button class="btn primary" type="submit" name="verdict" value="approve">Approve</button>
              <button class="btn" type="submit" name="verdict" value="request-changes">Request changes</button>
              <button class="btn" type="submit" disabled aria-describedby="comment-only-note">Comment</button>
            </div>
            <p id="comment-only-note" class="muted">Comment-only reviews are not supported by the current review service.</p>
          </form>
        </section>`) : ''}
      </main>
      <aside class="change-review-side">
        <section class="card"><div class="card-title">Checks</div>${raw(checkRows(change))}</section>
        <section class="card"><div class="card-title">Mergeability</div>
          <p>${change.mergeability ? raw(stateTag(change.mergeability.status)) : html`<span class="muted">Not available for this state.</span>`}</p>
          ${change.mergeability?.unknownReason ? raw(html`<p class="muted">${change.mergeability.unknownReason}</p>`) : ''}
          ${change.mergeability?.conflicts?.length ? raw(html`<ul>${raw(change.mergeability.conflicts.map((conflict) => `<li><code>${escapeHtml(conflict.path)}</code></li>`).join(''))}</ul>`) : ''}
          ${blockers ? raw(html`<ul>${raw(blockers)}</ul>`) : ''}
        </section>
        <section class="card"><div class="card-title">Policy & reviewers</div>
          <p>${reviewPacket.policy.requiredReviews} required approval(s); ${reviewPacket.policy.humanApprovalsRequired} human approval(s).</p>
          <p class="muted">${reviewPacket.policy.protected ? 'Protected target' : 'No protected-target rule'} · ${reviewPacket.policy.branchRules.length} branch rule(s)</p>
        </section>
        <section class="card"><div class="card-title">Escalations</div>
          ${reviewPacket.escalations.length
            ? raw(html`<ul class="k-list">${raw(reviewPacket.escalations.map((item) => `<li><span class="tag ${item.state === 'open' ? 'err' : 'muted'}">${escapeHtml(item.state)}</span> ${escapeHtml(item.reason)}${item.detail ? ` · ${escapeHtml(item.detail)}` : ''}</li>`).join(''))}</ul>`)
            : raw(html`<p class="muted">No escalations.</p>`)}
        </section>
      </aside>
    </div>`;
  return page(c, resolved, `#${change.number} · ${change.title}`, body, 'review');
}

changePages.get('/changes/:number', async (c) => {
  const resolved = await resolveRepo(c);
  if (!resolved) return notFound(c);
  return renderDetail(c, resolved, c.req.param('number'));
});

changePages.post('/changes/:number/review', async (c) => {
  const number = c.req.param('number');
  const url = `/${c.req.param('owner')}/${c.req.param('repo')}/changes/${number}`;
  const form = await c.req.parseBody();
  const auth = await authorizeRoute(c, 'write', { requireActor: true, branchRules: true });
  if (!auth.ok) return redirect(c, url, { error: auth.error });
  if (!auth.actor) return redirect(c, url, { error: 'Sign in to review this change.' });
  const refused = await sessionFormRefused(c, auth.actor, form);
  if (refused) return refused;
  const verdict = form.verdict;
  if (verdict !== 'approve' && verdict !== 'request-changes') {
    return redirect(c, url, { error: 'Comment-only reviews are not supported by the current review service.' });
  }
  const cx: changes.ChangeContext = {
    env: c.env,
    repo: auth.repo,
    actor: auth.actor,
    branchRules: auth.branchRules ?? [],
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
  };
  const result = await reviews.submitReview(cx, number, { body: String(form.body ?? ''), headSha: form.headSha }, verdict);
  if (!result.ok) return redirect(c, url, { error: result.error });
  return redirect(c, url, { notice: `${verdict === 'approve' ? 'Approval' : 'Request for changes'} recorded.` });
});
