/**
 * The review gate (architecture §0.4 agent review policy, §9, §11.1): what a
 * change's reviews, escalations and the target's branch rules still require
 * before it may be published. Shared by explicit and auto merges
 * (services/changes.ts), enqueue and the integration train
 * (services/queue.ts) and the review packet (services/reviews.ts).
 *
 * - Approvals are bound to the exact head: only reviews of the change's
 *   current head count, so a head movement stales every earlier approval.
 * - The per-repo policy requires N approving reviews from distinct
 *   principals (humans or agents) other than the author.
 * - A protected target (any matching branch rule) needs `requiredApprovals`
 *   approvals from human principals other than the change author. A branch
 *   rule may opt different-family agents in for heads with no scrutinize files.
 * - An open escalation blocks until a human acts. Touching a protected
 *   target and a final arena selection open one once per change; the gate
 *   reports such a missing escalation so the caller records it.
 * - Reviews count only while their principal may still write to the repo
 *   (the minting human for agents) and the agent and its token are not
 *   revoked; the facts are re-read right before every publication.
 *
 * The facts are SQL column expressions over a `change_sets` row so they can
 * ride in a batch the caller already runs, and the same expressions guard
 * the enqueue insert.
 */

import type { ServiceResult } from '../repos/service';
import type { BranchPolicy } from './branchRules';

/** The model family reported for human principals. */
export const HUMAN_MODEL_FAMILY = 'human';
export const MODEL_FAMILY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** A model family for an agent principal: lowercase, 1-64 characters; `human` is reserved. */
export function parseModelFamily(v: unknown): ServiceResult<string | null> {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v !== 'string' || !MODEL_FAMILY_RE.test(v) || v === HUMAN_MODEL_FAMILY) {
    return {
      ok: false,
      status: 400,
      error: `modelFamily must be 1-64 lowercase letters, digits, dots, dashes or underscores (not "${HUMAN_MODEL_FAMILY}")`,
      code: 'INVALID_MODEL_FAMILY',
    };
  }
  return { ok: true, value: v };
}

export const ESCALATION_REASONS = ['reviewer-disagreement', 'review-blocked', 'protected-path', 'final-selection'] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/** Reasons opened once per change by the platform itself rather than by a review. */
export type StickyReason = 'protected-path' | 'final-selection';

/** The human-facing detail a platform-opened escalation row carries, one per sticky reason. */
const ESCALATION_DETAIL: Record<StickyReason, string> = {
  'protected-path': 'the change targets a ref covered by a branch rule',
  'final-selection': "an arena selection names this change's workspace as the winner; a human confirms the selection",
};

export type ReviewBlockCode = 'APPROVALS_REQUIRED' | 'ESCALATION_OPEN' | 'REVIEWS_REQUIRED';

export interface ReviewFacts {
  required: number;
  approvals: number;
  humans: number;
  agentFamilyApprovals: number;
  headTier: 'scrutinize' | 'read' | 'receipt' | null;
  open: EscalationReason[];
  protectedSeen: boolean;
  finalSelected: boolean;
  finalSeen: boolean;
}

export interface ReviewFactsRow {
  rv_required: number | null;
  rv_approvals: number | null;
  rv_humans: number | null;
  rv_agent_family_approvals?: number | null;
  rv_head_tier?: string | null;
  rv_open: string | null;
  rv_protected_seen: number | null;
  rv_final_selected: number | null;
  rv_final_seen: number | null;
}

export interface ReviewBlocker {
  code: ReviewBlockCode;
  error: string;
}

export interface ReviewBlockDetail {
  blockers: ReviewBlocker[];
  openEscalations: EscalationReason[];
  approvals: { count: number; required: number; humans: number; humansRequired: number; agentFamilyApprovals: number; lowRisk: boolean };
}

export interface ReviewRefusal {
  ok: false;
  status: 409;
  error: string;
  code: ReviewBlockCode;
  review: ReviewBlockDetail;
}

export interface ReviewGate {
  /** The first unmet requirement, or null when the change may be published. */
  block: ReviewRefusal | null;
  blockers: ReviewBlocker[];
  /** Escalations the change must have that were never recorded (the caller records them). */
  missing: StickyReason[];
}

/** Whether the review `r` still counts for the change `c`: its principal may still write to the repo. */
function reviewerAuthorized(r: string, c: string): string {
  return `EXISTS (SELECT 1 FROM users u, repos rp WHERE u.id = ${r}.user_id AND rp.id = ${c}.repo_id AND (
            (rp.owner_org_id IS NULL AND u.login = rp.owner_login)
            OR u.is_admin = 1
            OR (rp.owner_org_id IS NOT NULL AND EXISTS (SELECT 1 FROM org_members m
                  WHERE m.org_id = rp.owner_org_id AND m.user_id = u.id AND m.role IN ('owner', 'maintainer')))
            OR ((rp.owner_org_id IS NULL OR EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = rp.owner_org_id AND m.user_id = u.id))
                AND EXISTS (SELECT 1 FROM repo_grants g WHERE g.repo_id = rp.id AND g.user_id = u.id AND g.role IN ('write', 'admin')))))
     AND (${r}.agent_id IS NULL OR EXISTS (SELECT 1 FROM agent_tokens t JOIN agents a ON a.id = t.agent_id
            WHERE t.id = ${r}.token_id AND t.revoked_at IS NULL AND a.revoked_at IS NULL))`;
}

function approvedOnHead(c: string): string {
  return `r.change_set_id = ${c}.id AND r.head_sha = ${c}.head_sha AND r.verdict = 'approve' AND ${reviewerAuthorized('r', c)}`;
}

/** The fact expressions over the change row aliased `c`. */
export function reviewFactExpressions(c = 'c') {
  return {
    required: `COALESCE((SELECT p.required_reviews FROM review_policies p WHERE p.repo_id = ${c}.repo_id), 0)`,
    approvals: `(SELECT COUNT(*) FROM change_reviews r WHERE ${approvedOnHead(c)})`,
    humans: `(SELECT COUNT(*) FROM change_reviews r WHERE ${approvedOnHead(c)} AND r.agent_id IS NULL AND r.user_id IS NOT ${c}.author_id)`,
    agentFamilyApprovals: `(SELECT COUNT(*) FROM change_reviews r WHERE ${approvedOnHead(c)}
      AND r.agent_id IS NOT NULL AND r.model_family IS NOT NULL
      AND (${c}.agent_meta IS NULL OR EXISTS (
        SELECT 1 FROM agents author_agent WHERE author_agent.id = json_extract(${c}.agent_meta, '$.agentId')
          AND author_agent.model_family IS NOT NULL AND r.model_family != author_agent.model_family)))`,
    headTier: `(SELECT h.max_tier FROM change_head_tiers h WHERE h.change_set_id = ${c}.id AND h.head_sha = ${c}.head_sha LIMIT 1)`,
    open: `(SELECT json_group_array(e.reason) FROM change_escalations e WHERE e.change_set_id = ${c}.id AND e.state = 'open')`,
    openCount: `(SELECT COUNT(*) FROM change_escalations e WHERE e.change_set_id = ${c}.id AND e.state = 'open')`,
    protectedSeen: `EXISTS (SELECT 1 FROM change_escalations e WHERE e.change_set_id = ${c}.id AND e.reason = 'protected-path')`,
    // A change is linked to at most one workspace: LIMIT 1 ends the idx_ws_change probe at that row.
    finalSelected: `COALESCE((SELECT a.selected_workspace = w.id FROM workspaces w LEFT JOIN arenas a ON a.id = w.arena_id WHERE w.change_set_id = ${c}.id LIMIT 1), 0)`,
    finalSeen: `EXISTS (SELECT 1 FROM change_escalations e WHERE e.change_set_id = ${c}.id AND e.reason = 'final-selection')`,
  };
}

/** Select-list columns (`rv_*`) carrying the review facts of the change row aliased `c`. */
export function reviewFactsColumns(c = 'c'): string {
  const f = reviewFactExpressions(c);
  return `${f.required} AS rv_required, ${f.approvals} AS rv_approvals, ${f.humans} AS rv_humans,
          ${f.agentFamilyApprovals} AS rv_agent_family_approvals, ${f.headTier} AS rv_head_tier, ${f.open} AS rv_open,
          ${f.protectedSeen} AS rv_protected_seen, ${f.finalSelected} AS rv_final_selected, ${f.finalSeen} AS rv_final_seen`;
}

/**
 * A WHERE condition that holds exactly when `reviewGate` finds no blocker,
 * given `humansParam`/`protectedParam` bound to the target's
 * `requiredApprovals` and protection (1/0). A NULL `humansParam` means the
 * caller has not read the branch rules: the condition then holds only while
 * the repo has none.
 */
export function reviewGuardCondition(c: string, humansParam: string, protectedParam: string, agentApprovalsParam = "'never'"): string {
  const f = reviewFactExpressions(c);
  const lowRisk = `(${agentApprovalsParam} = 'low-risk' AND ${f.headTier} IS NOT NULL AND ${f.headTier} != 'scrutinize')`;
  return `(${f.openCount} = 0 AND ${f.approvals} >= ${f.required}
           AND ((${humansParam} IS NULL AND NOT EXISTS (SELECT 1 FROM branch_rules b WHERE b.repo_id = ${c}.repo_id))
                OR (${humansParam} IS NOT NULL AND (${f.humans} + CASE WHEN ${lowRisk} THEN ${f.agentFamilyApprovals} ELSE 0 END) >= ${humansParam}
                    AND (${protectedParam} = 0 OR ${f.protectedSeen} OR ${lowRisk})))
           AND (NOT ${f.finalSelected} OR ${f.finalSeen}))`;
}

/** The facts statement for one change by repo and number. */
export function reviewFactsSelect(db: D1Database, repoId: string, number: number): D1PreparedStatement {
  return db.prepare(`SELECT c.id, ${reviewFactsColumns('c')} FROM change_sets c WHERE c.repo_id = ?1 AND c.number = ?2`).bind(repoId, number);
}

/** The facts statement for one change by id. */
export function reviewFactsSelectById(db: D1Database, changeId: string): D1PreparedStatement {
  return db.prepare(`SELECT c.id, ${reviewFactsColumns('c')} FROM change_sets c WHERE c.id = ?1`).bind(changeId);
}

function isReason(v: unknown): v is EscalationReason {
  return typeof v === 'string' && (ESCALATION_REASONS as readonly string[]).includes(v);
}

export function parseReviewFacts(row: Partial<ReviewFactsRow> | null | undefined): ReviewFacts {
  let open: EscalationReason[] = [];
  try {
    const parsed: unknown = JSON.parse(row?.rv_open ?? '[]');
    if (Array.isArray(parsed)) open = parsed.filter(isReason);
  } catch {
    open = [];
  }
  return {
    required: Number(row?.rv_required ?? 0) || 0,
    approvals: Number(row?.rv_approvals ?? 0) || 0,
    humans: Number(row?.rv_humans ?? 0) || 0,
    agentFamilyApprovals: Number(row?.rv_agent_family_approvals ?? 0) || 0,
    headTier: row?.rv_head_tier === 'scrutinize' || row?.rv_head_tier === 'read' || row?.rv_head_tier === 'receipt'
      ? row.rv_head_tier
      : null,
    open: [...new Set(open)].sort(),
    protectedSeen: Boolean(row?.rv_protected_seen),
    finalSelected: Boolean(row?.rv_final_selected),
    finalSeen: Boolean(row?.rv_final_seen),
  };
}

/** Evaluates the review requirements for publishing a change into `policy.ref`. */
export function reviewGate(facts: ReviewFacts, policy: BranchPolicy): ReviewGate {
  const missing: StickyReason[] = [];
  const lowRisk = policy.agentApprovals === 'low-risk' && facts.headTier !== null && facts.headTier !== 'scrutinize';
  const countedHumans = facts.humans + (lowRisk ? facts.agentFamilyApprovals : 0);
  if (policy.protected && !facts.protectedSeen && !lowRisk) missing.push('protected-path');
  if (facts.finalSelected && !facts.finalSeen) missing.push('final-selection');
  const open = [...new Set([...facts.open, ...missing])].sort();
  const blockers: ReviewBlocker[] = [];
  if (countedHumans < policy.requiredApprovals) {
    blockers.push({
      code: 'APPROVALS_REQUIRED',
      error:
        `${policy.ref} requires ${policy.requiredApprovals} approving review(s) of the current head from a human principal other than the author; ` +
        `different-family agent approvals count only under the agentApprovals low-risk option when this head has no scrutinize files; ${countedHumans} so far`,
    });
  }
  if (open.length > 0) {
    blockers.push({
      code: 'ESCALATION_OPEN',
      error: `open escalation(s) need a human: ${open.join(', ')}; a human approves the current head or resolves each escalation`,
    });
  }
  if (facts.approvals < facts.required) {
    blockers.push({
      code: 'REVIEWS_REQUIRED',
      error: `the review policy requires ${facts.required} approving review(s) of the current head from distinct principals other than the author; ${facts.approvals} so far`,
    });
  }
  const first = blockers[0];
  const detail: ReviewBlockDetail = {
    blockers,
    openEscalations: open,
    approvals: {
      count: facts.approvals,
      required: facts.required,
      humans: facts.humans,
      humansRequired: policy.requiredApprovals,
      agentFamilyApprovals: facts.agentFamilyApprovals,
      lowRisk,
    },
  };
  return {
    block: first ? { ok: false, status: 409, error: first.error, code: first.code, review: detail } : null,
    blockers,
    missing,
  };
}

/**
 * Records an escalation the gate found missing. It is opened once per change
 * and reason: a resolved one is not reopened.
 */
export function recordMissingEscalation(db: D1Database, changeId: string, reason: StickyReason, now: number): D1PreparedStatement {
  const detail = ESCALATION_DETAIL[reason];
  return db
    .prepare(
      `INSERT OR IGNORE INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at)
       SELECT ?1, c.repo_id, c.id, c.number, ?3, 'open', c.head_sha, ?4, 'system', ?5 FROM change_sets c
        WHERE c.id = ?2 AND c.state IN ('open', 'conflicted')
          AND NOT EXISTS (SELECT 1 FROM change_escalations e WHERE e.change_set_id = ?2 AND e.reason = ?3)`,
    )
    .bind(crypto.randomUUID(), changeId, reason, detail, now);
}

/**
 * Opens a final-selection escalation on the live change linked to `workspaceId`
 * (a new selection asks again). With `arenaId`, the row is written only when
 * the arena still names `workspaceId` as its winner, so a selection that lost
 * a race to another winner cannot orphan an escalation.
 */
export function finalSelectionEscalation(db: D1Database, repoId: string, workspaceId: string, now: number, arenaId?: string): D1PreparedStatement {
  const onlyIfSelected =
    arenaId === undefined
      ? ''
      : ` AND EXISTS (SELECT 1 FROM arenas a2 WHERE a2.repo_id = ?2 AND a2.id = ?5 AND a2.selected_workspace = ?3 AND a2.state = 'selected')`;
  return db
    .prepare(
      `INSERT OR IGNORE INTO change_escalations (id, repo_id, change_set_id, change_number, reason, state, head_sha, detail, opened_by, opened_at)
       SELECT ?1, c.repo_id, c.id, c.number, 'final-selection', 'open', c.head_sha, ?6, 'system', ?4
         FROM workspaces w JOIN change_sets c ON c.id = w.change_set_id
        WHERE w.repo_id = ?2 AND w.id = ?3 AND c.state IN ('open', 'conflicted')${onlyIfSelected}`,
    )
    .bind(crypto.randomUUID(), repoId, workspaceId, now, arenaId ?? null, ESCALATION_DETAIL['final-selection']);
}
