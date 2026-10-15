import type { BranchRuleRow } from './branchRules';
import { BRANCH_RULE_COLUMNS, effectivePolicy, ruleFromRow } from './branchRules';
import { remainingFor } from './remaining';
import type { ReviewerCandidateRow } from './reviewerSelection';
import { reviewAuthorSelection, reviewerCandidates, selectReviewer } from './reviewerSelection';
import { parseReviewFacts, reviewFactsColumns, reviewGate, type ReviewFactsRow } from './reviewGate';

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
  state: 'open' | 'conflicted' | 'merged' | 'closed';
  head_sha: string | null;
  base_ref: string;
  merge_policy: 'auto' | 'draft' | 'review';
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
    p.nudge_after_minutes, ${reviewFactsColumns('c', 'p')},
    (SELECT q.state FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1 LIMIT 1) AS queue_state,
    EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.status IN ('queued', 'running')) AS checks_pending,
    EXISTS (SELECT 1 FROM check_runs k WHERE k.change_set_id = c.id AND k.head_sha = c.head_sha AND k.conclusion = 'failure') AS checks_failing,
    EXISTS (SELECT 1 FROM change_reviews r WHERE r.change_set_id = c.id AND r.head_sha = c.head_sha AND r.verdict = 'request-changes') AS request_changes
  FROM change_sets c LEFT JOIN review_policies p ON p.repo_id = c.repo_id`;

async function readRemaining(env: Env, repoId: string, changeId: string) {
  const [changeResult, rulesResult] = await env.DB.batch([
    env.DB.prepare(`${CHANGE_FACTS_SQL} WHERE c.repo_id = ?1 AND c.id = ?2`).bind(repoId, changeId),
    env.DB.prepare(`SELECT ${BRANCH_RULE_COLUMNS} FROM branch_rules b WHERE b.repo_id = ?1 LIMIT 50`).bind(repoId),
  ]);
  const change = (changeResult?.results as NudgeFactsRow[] | undefined)?.[0];
  if (!change || !change.head_sha) return null;
  const rules = ((rulesResult?.results as BranchRuleRow[] | undefined) ?? []).map(ruleFromRow);
  const policy = effectivePolicy(rules, branchRef(change.base_ref));
  const review = parseReviewFacts(change);
  const gate = reviewGate(review, policy);
  const checksState = change.checks_failing ? 'failure' : change.checks_pending ? 'pending' : 'success';
  const remaining = remainingFor({
    change: {
      state: change.state,
      mergePolicy: change.merge_policy,
      author: { principal: reviewAuthorSelection(change.agent_meta, change.author_id, change.author_family).principal },
      queueState: change.queue_state,
      conflicts: [],
    },
    blockers: gate.blockers,
    approvals: {
      count: review.approvals,
      required: review.required,
      humans: review.humans,
      humansRequired: policy.requiredApprovals,
      agentFamilyApprovals: review.agentFamilyApprovals,
      lowRisk: policy.agentApprovals === 'low-risk' && review.headTier !== null && review.headTier !== 'scrutinize',
    },
    agentApprovals: policy.agentApprovals,
    mergeability: {
      status: 'known',
      mergeable: false,
      checks: { state: checksState, required: [{ name: 'checks', state: checksState }] },
    },
    dependency: null,
    resolveConflictTaskOpen: false,
    viewer: { principal: null, login: null, kind: null, writeAccess: false },
  });
  const waiting = remaining[0]?.who;
  const waitingOn = waiting === 'reviewer' ? 'reviewers' : waiting === 'human' ? 'human' : null;
  return { change, gate, remaining, waitingOn };
}

export async function enqueueReviewNudge(env: Env, repoId: string, changeId: string, headSha: string): Promise<void> {
  const current = await readRemaining(env, repoId, changeId);
  const minutes = current?.change.nudge_after_minutes;
  const waitingOn = current?.waitingOn;
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
  const first = await readRemaining(env, message.repoId, message.changeId);
  if (!first || first.change.state !== 'open' || first.change.merge_policy === 'draft' || first.change.head_sha !== message.headSha ||
      first.waitingOn !== message.waitingOn ||
      first.change.nudge_after_minutes === null) return;

  const requestedResult = message.waitingOn === 'reviewers'
    ? await env.DB.prepare(
      `SELECT rr.principal
         FROM change_review_requests rr
        WHERE rr.change_set_id = ?1
          AND NOT EXISTS (
            SELECT 1 FROM change_reviews r
             WHERE r.change_set_id = rr.change_set_id AND r.principal = rr.principal AND r.head_sha = ?2
          )
        ORDER BY rr.requested_at, rr.principal LIMIT 50`,
    ).bind(message.changeId, message.headSha).all<{ principal: string }>()
    : null;
  const requestedReviewers = requestedResult?.results?.map((row) => row.principal) ?? [];
  let suggestedReviewer: ReturnType<typeof selectReviewer> = null;
  if (message.waitingOn === 'reviewers' && requestedReviewers.length === 0) {
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
  const reasons = JSON.stringify(first.gate.blockers.map((blocker) => blocker.code));
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
           'reasons', json(?7), 'requestedReviewers', json(?8), 'suggestedReviewer', json(?9)), ?10, ?10
        WHERE changes() = 1`,
    ).bind(crypto.randomUUID(), message.repoId, message.changeId, message.headSha, message.waitingOn, message.seq, reasons,
      JSON.stringify(requestedReviewers), suggestionJson, nowAt),
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
