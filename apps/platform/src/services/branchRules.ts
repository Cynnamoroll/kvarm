/**
 * Opt-in branch rules (architecture §11.1).
 *
 * A ref that matches any rule of its repo is protected. Direct git pushes may
 * not create, update or delete it for any principal: repo owners, org
 * owners/maintainers, write collaborators, agent tokens and the global
 * instance admin alike. Artifacts accepts any update whose expected old OID
 * is correct (fast-forward or not), so the git gate enforces this itself
 * from the receive-pack command list before anything reaches storage.
 *
 * Protected refs move only through the platform's publication path, which
 * must satisfy the union of the matching rules' `requiredChecks` and the
 * largest `requiredApprovals` (distinct human approvals of the current head,
 * never the change author's). Refs that match no rule keep the ordinary
 * push workflow unchanged.
 *
 * Rules are managed by repo admins through the shared policy; every change
 * appends an `events` audit row in the same batch.
 */

import { isSafeRefName, isValidRefPattern, refMatchesPattern } from '@forge/gitops';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import type { Actor } from './authz';

export const BRANCH_RULES_MAX = 50;
export const REQUIRED_CHECKS_MAX = 32;
export const CHECK_NAME_MAX = 100;
export const REQUIRED_APPROVALS_MAX = 10;

export const PROTECTED_REF_REASON = 'protected branch: direct pushes are not allowed';
export const INVALID_REF_REASON = 'invalid ref name';

export interface BranchRule {
  id: string;
  pattern: string;
  requiredChecks: string[];
  requiredApprovals: number;
  createdBy: string | null;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number;
}

export interface BranchRuleRow {
  id: string;
  pattern: string;
  required_checks: string;
  required_approvals: number;
  created_by_login?: string | null;
  created_at: number;
  updated_by_login?: string | null;
  updated_at: number;
}

export interface BranchPolicy {
  ref: string;
  protected: boolean;
  directPush: 'allowed' | 'denied';
  requiredChecks: string[];
  requiredApprovals: number;
  rules: string[];
}

function fail<T>(status: number, error: string, code: string): ServiceResult<T> {
  return { ok: false, status, error, code };
}

/**
 * Accepts a branch name (`main`, `release/*`) or a full ref pattern
 * (`refs/heads/main`, `refs/tags/*`) and returns the full form, or null.
 */
export function normalizeRulePattern(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw.length === 0) return null;
  const full = raw.startsWith('refs/') ? raw : `refs/heads/${raw}`;
  return isValidRefPattern(full) ? full : null;
}

/** A full ref name for policy lookups; branch names are expanded like patterns. */
export function normalizeRefName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const full = raw.startsWith('refs/') ? raw : `refs/heads/${raw}`;
  return isSafeRefName(full) ? full : null;
}

export function parseRequiredChecks(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length > REQUIRED_CHECKS_MAX) return null;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') return null;
    const name = v.trim();
    // eslint-disable-next-line no-control-regex
    if (name.length === 0 || name.length > CHECK_NAME_MAX || /[\x00-\x1f\x7f]/.test(name)) return null;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

export function parseRequiredApprovals(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) return null;
  return input >= 0 && input <= REQUIRED_APPROVALS_MAX ? input : null;
}

function parseStoredChecks(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function ruleFromRow(row: BranchRuleRow): BranchRule {
  return {
    id: row.id,
    pattern: row.pattern,
    requiredChecks: parseStoredChecks(row.required_checks),
    requiredApprovals: Number(row.required_approvals) || 0,
    createdBy: row.created_by_login ?? null,
    createdAt: row.created_at,
    updatedBy: row.updated_by_login ?? null,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

export function matchingRules(rules: readonly BranchRule[], ref: string): BranchRule[] {
  return rules.filter((r) => refMatchesPattern(r.pattern, ref));
}

/** The combined policy of every rule matching `ref`. */
export function effectivePolicy(rules: readonly BranchRule[], ref: string): BranchPolicy {
  const matched = matchingRules(rules, ref);
  const checks = new Set<string>();
  let approvals = 0;
  for (const r of matched) {
    for (const c of r.requiredChecks) checks.add(c);
    approvals = Math.max(approvals, r.requiredApprovals);
  }
  return {
    ref,
    protected: matched.length > 0,
    directPush: matched.length > 0 ? 'denied' : 'allowed',
    requiredChecks: [...checks].sort(),
    requiredApprovals: approvals,
    rules: matched.map((r) => r.id),
  };
}

/**
 * The `ng` reason for a direct push command on `ref`, or null when the rules
 * allow it. With rules present, refs outside the conservative safe-name subset
 * are refused too, so an unusual spelling cannot slip past pattern matching.
 */
export function directPushDenial(rules: readonly BranchRule[], ref: string): string | null {
  if (rules.length === 0) return null;
  if (!isSafeRefName(ref)) return INVALID_REF_REASON;
  return matchingRules(rules, ref).length > 0 ? PROTECTED_REF_REASON : null;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const RULE_SELECT = `SELECT b.id, b.pattern, b.required_checks, b.required_approvals, b.created_at, b.updated_at,
       cu.login AS created_by_login, uu.login AS updated_by_login
  FROM branch_rules b LEFT JOIN users cu ON cu.id = b.created_by LEFT JOIN users uu ON uu.id = b.updated_by`;

/**
 * The repo's rules by owner/name, for the git gate's authoritative batch
 * (services/access.ts). Bounded by BRANCH_RULES_MAX through the write guard.
 */
export function branchRulesSelect(db: D1Database, owner: string, name: string): D1PreparedStatement {
  return db
    .prepare(
      `SELECT b.id, b.pattern, b.required_checks, b.required_approvals, b.created_at, b.updated_at
         FROM branch_rules b JOIN repos r ON r.id = b.repo_id
        WHERE r.owner_login = ?1 AND r.name = ?2
        LIMIT ${BRANCH_RULES_MAX}`,
    )
    .bind(owner, name);
}

export async function listRules(env: Env, repo: RepoRow): Promise<BranchRule[]> {
  const { results } = await env.DB.prepare(`${RULE_SELECT} WHERE b.repo_id = ? ORDER BY b.pattern LIMIT ?`)
    .bind(repo.id, BRANCH_RULES_MAX)
    .all<BranchRuleRow>();
  return (results ?? []).map(ruleFromRow);
}

export async function getRule(env: Env, repo: RepoRow, id: string): Promise<ServiceResult<BranchRule>> {
  const row = await env.DB.prepare(`${RULE_SELECT} WHERE b.id = ? AND b.repo_id = ?`)
    .bind(id, repo.id)
    .first<BranchRuleRow>();
  return row ? { ok: true, value: ruleFromRow(row) } : fail(404, 'branch rule not found', 'RULE_NOT_FOUND');
}

/** Audit row built from the stored rule, written only while the rule exists. */
function auditRule(db: D1Database, type: string, ruleId: string, repo: RepoRow, actor: Actor, now: number) {
  return db
    .prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, ?2, json_object('repoId', b.repo_id, 'repo', ?5, 'ruleId', b.id, 'pattern', b.pattern,
                                  'requiredChecks', json(b.required_checks),
                                  'requiredApprovals', b.required_approvals, 'actor', ?6),
              ?7, ?7
         FROM branch_rules b WHERE b.id = ?3 AND b.repo_id = ?4`,
    )
    .bind(crypto.randomUUID(), type, ruleId, repo.id, `${repo.owner_login}/${repo.name}`, actor.user.login, now);
}

export interface RuleInput {
  pattern: unknown;
  requiredChecks?: unknown;
  requiredApprovals?: unknown;
}

function validateSettings(
  input: { requiredChecks?: unknown; requiredApprovals?: unknown },
): ServiceResult<{ checks: string[] | undefined; approvals: number | undefined }> {
  let checks: string[] | undefined;
  let approvals: number | undefined;
  if (input.requiredChecks !== undefined) {
    const parsed = parseRequiredChecks(input.requiredChecks);
    if (!parsed) {
      return fail(
        400,
        `requiredChecks must be an array of at most ${REQUIRED_CHECKS_MAX} check names (1-${CHECK_NAME_MAX} characters)`,
        'INVALID_CHECKS',
      );
    }
    checks = parsed;
  }
  if (input.requiredApprovals !== undefined) {
    const parsed = parseRequiredApprovals(input.requiredApprovals);
    if (parsed === null) {
      return fail(400, `requiredApprovals must be an integer from 0 to ${REQUIRED_APPROVALS_MAX}`, 'INVALID_APPROVALS');
    }
    approvals = parsed;
  }
  return { ok: true, value: { checks, approvals } };
}

export async function createRule(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  input: RuleInput,
): Promise<ServiceResult<BranchRule>> {
  const pattern = normalizeRulePattern(input.pattern);
  if (!pattern) {
    return fail(
      400,
      'pattern must be a branch name, a full ref name, or a prefix ending in /* (for example main, release/*, refs/tags/*)',
      'INVALID_PATTERN',
    );
  }
  const settings = validateSettings(input);
  if (!settings.ok) return settings;
  const id = crypto.randomUUID();
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO branch_rules (id, repo_id, pattern, required_checks, required_approvals,
                                 created_by, created_at, updated_by, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?7
        WHERE (SELECT COUNT(*) FROM branch_rules WHERE repo_id = ?2) < ?8
       ON CONFLICT (repo_id, pattern) DO NOTHING`,
    ).bind(
      id,
      repo.id,
      pattern,
      JSON.stringify(settings.value.checks ?? []),
      settings.value.approvals ?? 0,
      actor.user.id,
      now,
      BRANCH_RULES_MAX,
    ),
    auditRule(env.DB, 'branch_rule.created', id, repo, actor, now),
    env.DB.prepare(`${RULE_SELECT} WHERE b.id = ?`).bind(id),
    env.DB.prepare(
      'SELECT EXISTS (SELECT 1 FROM branch_rules WHERE repo_id = ?1 AND pattern = ?2) AS taken',
    ).bind(repo.id, pattern),
  ]);
  const row = results[2]?.results?.[0] as BranchRuleRow | undefined;
  if (row) return { ok: true, value: ruleFromRow(row) };
  const taken = (results[3]?.results?.[0] as { taken: number } | undefined)?.taken === 1;
  if (taken) return fail(409, 'a rule with this pattern already exists', 'RULE_EXISTS');
  return fail(422, `a repository can have at most ${BRANCH_RULES_MAX} branch rules`, 'TOO_MANY_RULES');
}

export async function updateRule(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  id: string,
  input: { requiredChecks?: unknown; requiredApprovals?: unknown },
): Promise<ServiceResult<BranchRule>> {
  const settings = validateSettings(input);
  if (!settings.ok) return settings;
  const { checks, approvals } = settings.value;
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE branch_rules
          SET required_checks = COALESCE(?3, required_checks),
              required_approvals = COALESCE(?4, required_approvals),
              updated_by = ?5, updated_at = ?6
        WHERE id = ?1 AND repo_id = ?2`,
    ).bind(id, repo.id, checks === undefined ? null : JSON.stringify(checks), approvals ?? null, actor.user.id, now),
    auditRule(env.DB, 'branch_rule.updated', id, repo, actor, now),
    env.DB.prepare(`${RULE_SELECT} WHERE b.id = ? AND b.repo_id = ?`).bind(id, repo.id),
  ]);
  const row = results[2]?.results?.[0] as BranchRuleRow | undefined;
  return row ? { ok: true, value: ruleFromRow(row) } : fail(404, 'branch rule not found', 'RULE_NOT_FOUND');
}

export async function deleteRule(
  env: Env,
  repo: RepoRow,
  actor: Actor,
  id: string,
): Promise<ServiceResult<{ deleted: true; rule: BranchRule }>> {
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`${RULE_SELECT} WHERE b.id = ? AND b.repo_id = ?`).bind(id, repo.id),
    auditRule(env.DB, 'branch_rule.deleted', id, repo, actor, now),
    env.DB.prepare('DELETE FROM branch_rules WHERE id = ? AND repo_id = ?').bind(id, repo.id),
  ]);
  const row = results[0]?.results?.[0] as BranchRuleRow | undefined;
  if (!row) return fail(404, 'branch rule not found', 'RULE_NOT_FOUND');
  return { ok: true, value: { deleted: true, rule: ruleFromRow(row) } };
}
