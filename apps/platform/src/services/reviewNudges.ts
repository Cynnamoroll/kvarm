import type { BranchRuleRow } from './branchRules';
import { BRANCH_RULE_COLUMNS, effectivePolicy, ruleFromRow } from './branchRules';
import { attentionFor } from './attention';
import type { ReviewerCandidateRow } from './reviewerSelection';
import { reviewAuthorSelection, reviewerCandidates, selectReviewer } from './reviewerSelection';
import { parseReviewFacts, reviewFactsColumns, type ReviewFactsRow } from './reviewGate';

const NUDGE_KIND = 'review.nudge';
const MAX_DELAY_SECONDS = 43_200;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface ReviewNudgeMessage {
  kind: typeof NUDGE_KIND;
  repoId: string;
  changeId: string;
  headSha: string;
  waitingOn: 'reviewers' | 'human';
  seq: 1 | 2;
  notBefore?: number;
}

export function isNudgeMessage(value: unknown): value is ReviewNudgeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.kind === NUDGE_KIND &&
    typeof message.repoId === 'string' && message.repoId.length > 0 &&
    typeof message.changeId === 'string' && message.changeId.length > 0 &&
    typeof message.headSha === 'string' && SHA_RE.test(message.headSha) &&
    (message.waitingOn === 'reviewers' || message.waitingOn === 'human') &&
    (message.seq === 1 || message.seq === 2) &&
    (message.notBefore === undefined || (typeof message.notBefore === 'number' && Number.isFinite(message.notBefore)));
}

function delaySeconds(seconds: number): number {
  return Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.ceil(seconds)));
}

function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

interface NudgeFactsRow extends ReviewFactsRow {
  id: string;
  number: number;
  state: string;
  head_sha: string | null;
  base_ref: string;
  merge_policy: string;
  agent_meta: string | null;
  author_id: string | null;
  author_family: string | null;
  nudge_after_minutes: number | null;
  queue_state: string | null;
  checks_pending: number;
  checks_failing: number;
  request_changes: number;
}

const CHANGE_FACTS_SQL = `SELECT c.id, c.number, c.state, c.head_sha, c.base_ref, c.merge_policy, c.agent_meta, c.author_id,
    (SELECT a.model_family FROM agents a WHERE a.id = json_extract(c.agent_meta, '$.agentId')) AS author_family,
    p.nudge_after_minutes, ${reviewFactsColumns('c')},
    (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1 LIMIT 1) AS queue_state,
    EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS checks_pending,
    EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS checks_failing,
    EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS request_changes
  FROM change_sets c LEFT JOIN review_policies p ON p.repo_id = c.repo_id`;

async function readAttention(env: Env, repoId: string, changeId: string) {
  const [changeResult, rulesResult] = await env.DB.batch([
    env.DB.prepare(`${CHANGE_FACTS_SQL} WHERE c.repo_id = ?1 AND c.id = ?2`).bind(repoId, changeId),
    env.DB.prepare(`SELECT ${BRANCH_RULE_COLUMNS} FROM branch_rules b WHERE b.repo_id = ?1 LIMIT 50`).bind(repoId),
  ]);
  const change = (changeResult?.results as NudgeFactsRow[] | undefined)?.[0];
  if (!change || !change.head_sha) return null;
  const rules = ((rulesResult?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow);
  const policy = effectivePolicy(rules, branchRef(change.base_ref));
  const review = parseReviewFacts(change);
  const attention = attentionFor({
    state: change.state,
    escalations: review.open,
    checksPending: Boolean(change.checks_pending),
    checksFailing: Boolean(change.checks_failing),
    blockingFindings: review.blockingFindings ?? 0,
    requestChanges: Boolean(change.request_changes),
    guideRequired: Boolean(review.guideRequired),
    guidePresent: Boolean(review.guidePresent),
    undeclared: review.undeclared ?? 0,
    approvals: review.approvals,
    required: review.required,
    humans: review.humans,
    humansRequired: policy.requiredApprovals,
    mergePolicy: change.merge_policy,
    queueState: change.queue_state,
  });
  return { change, rules, attention };
}

export async function enqueueReviewNudge(env: Env, repoId: string, changeId: string, headSha: string): Promise<void> {
  const current = await readAttention(env, repoId, changeId);
  const minutes = current?.change.nudge_after_minutes;
  const waitingOn = current?.attention.waitingOn;
  if (!current || current.change.state !== 'open' || current.change.merge_policy === 'draft' || current.change.head_sha !== headSha ||
      minutes === null || minutes === undefined || (waitingOn !== 'reviewers' && waitingOn !== 'human')) return;
  const notBefore = Date.now() + minutes * 60_000;
  const message: ReviewNudgeMessage = { kind: NUDGE_KIND, repoId, changeId, headSha, waitingOn, seq: 1, notBefore };
  await env.EVENTS.send(message, { delaySeconds: delaySeconds(minutes * 60) });
}

export async function processReviewNudge(env: Env, message: ReviewNudgeMessage): Promise<void> {
  const now = Date.now();
  if (message.notBefore !== undefined && message.notBefore > now) {
    await env.EVENTS.send(message, { delaySeconds: delaySeconds((message.notBefore - now) / 1000) });
    return;
  }
  const first = await readAttention(env, message.repoId, message.changeId);
  if (!first || first.change.state !== 'open' || first.change.merge_policy === 'draft' || first.change.head_sha !== message.headSha ||
      first.attention.waitingOn !== message.waitingOn ||
      (first.attention.waitingOn !== 'reviewers' && first.attention.waitingOn !== 'human') ||
      first.change.nudge_after_minutes === null) return;

  let suggestedReviewer = null;
  if (message.waitingOn === 'reviewers') {
    const nowMs = Date.now();
    const [candidateResult] = await env.DB.batch([
      env.DB.prepare(
        `SELECT a.id, a.name, a.owner_login, a.model_family,
                EXISTS (SELECT 1 FROM change_reviews r JOIN change_sets c ON c.id = r.change_set_id AND r.head_sha = c.head_sha
                         WHERE c.repo_id = ?1 AND c.number = ?2 AND r.principal = 'agent:' || a.id) AS reviewed
           FROM agents a
          WHERE a.revoked_at IS NULL
            AND a.id IN (SELECT t.agent_id FROM agent_tokens t
                          WHERE t.repo_id = ?1 AND t.role = 'write' AND t.revoked_at IS NULL AND t.expires_at > ?3)
          ORDER BY a.name, a.id LIMIT 50`,
      ).bind(message.repoId, first.change.number, nowMs),
    ]);
    const author = reviewAuthorSelection(first.change.agent_meta, first.change.author_id, first.change.author_family);
    const candidates = reviewerCandidates(author, (candidateResult?.results as ReviewerCandidateRow[] | undefined) ?? []);
    suggestedReviewer = selectReviewer(candidates);
  }
  const nowAt = Date.now();
  const reasons = JSON.stringify(first.attention.reasons);
  const suggestionJson = JSON.stringify(suggestedReviewer);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO review_nudges (change_set_id, head_sha, waiting_on, seq, sent_at, reasons, suggested_principal)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 FROM change_sets c
        WHERE c.id = ?1 AND c.state = 'open' AND c.head_sha = ?2
       RETURNING seq`,
    ).bind(message.changeId, message.headSha, message.waitingOn, message.seq, nowAt, reasons, suggestedReviewer?.principal ?? null),
    env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, 'review.nudged',
         json_object('repoId', ?2, 'changeId', ?3, 'headSha', ?4, 'waitingOn', ?5, 'seq', ?6,
           'reasons', json(?7), 'suggestedReviewer', json(?8)), ?9, ?9
        WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), message.repoId, message.changeId, message.headSha, message.waitingOn, message.seq, reasons, suggestionJson, nowAt),
  ]);
  if ((results[0]?.results?.length ?? 0) > 0 && message.seq === 1) {
    const minutes = first.change.nudge_after_minutes!;
    const nextNotBefore = Date.now() + minutes * 60_000;
    await env.EVENTS.send(
      { ...message, seq: 2, notBefore: nextNotBefore },
      { delaySeconds: delaySeconds(minutes * 60) },
    );
  }
}
