/**
 * Hosted CI execution: the opt-in lane in which the platform's own Container
 * CI runner (containers/ciRunnerSandbox.ts) drains the repository's queued
 * jobs, so a team that runs no `kvarm runner` of its own still gets CI. A
 * repo admin enables it per repository (PUT …/ci/hosted); the user-owned
 * `kvarm runner` keeps racing on the same fenced queue, so both lanes are
 * interchangeable and neither is a single point of failure.
 *
 * The runner inside the container needs a credential exactly like a human's.
 * The platform runs it under a dedicated non-admin service identity that
 * holds an explicit write grant on every repository with hosted CI enabled,
 * and each drain mints a short-lived PAT (2 h expiry, revoked when the drain
 * ends, and swept on the next mint if an isolate died mid-drain). The
 * plaintext token reaches the container only through the runner exec's
 * environment and is never written to its filesystem, which a container
 * snapshot would capture (containers/runnerFiles.ts).
 */

import { mintPAT, revokePAT, type Scope } from '../auth/pat';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';

export const HOSTED_CI_LOGIN = 'kvarm-hosted-ci';
const HOSTED_PAT_TTL_MS = 2 * 60 * 60 * 1000;
/** The proven `kvarm runner` profile: claim/report (ci) plus the snapshot, tree and compare reads a checkout needs. */
const HOSTED_SCOPES: Scope[] = ['read', 'write', 'api', 'ci'];

/** The service identity, created idempotently on first use. */
export async function ensureHostedCiUser(env: Env): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(HOSTED_CI_LOGIN).first<{ id: string }>();
  if (existing) return existing.id;
  await env.DB.prepare(
    `INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at)
     SELECT ?, ?, ?, ?, ?, 0, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE login = ?)`,
  )
    .bind(crypto.randomUUID(), 'kvarm-hosted:ci', HOSTED_CI_LOGIN, `${HOSTED_CI_LOGIN}@kvarm.invalid`, 'Kvarm hosted CI', Date.now(), HOSTED_CI_LOGIN)
    .run();
  const row = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(HOSTED_CI_LOGIN).first<{ id: string }>();
  if (!row) throw new Error('the hosted CI service user could not be created');
  return row.id;
}

export interface HostedCiSettings {
  enabled: boolean;
}

/** Enables or disables hosted CI for the repository, moving the service identity's grant with it. */
export async function setHostedCi(env: Env, repo: RepoRow, enabled: boolean, actorId: string | null): Promise<ServiceResult<HostedCiSettings>> {
  const now = Date.now();
  if (enabled) {
    const userId = await ensureHostedCiUser(env);
    await env.DB.batch([
      env.DB.prepare('UPDATE repos SET hosted_ci = 1 WHERE id = ?').bind(repo.id),
      env.DB.prepare(
        `INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at)
         VALUES (?, ?, 'write', ?, ?, ?)
           ON CONFLICT(repo_id, user_id) DO UPDATE SET role = 'write', updated_at = excluded.updated_at`,
      ).bind(repo.id, userId, actorId, now, now),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('UPDATE repos SET hosted_ci = 0 WHERE id = ?').bind(repo.id),
      env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = (SELECT id FROM users WHERE login = ?)').bind(repo.id, HOSTED_CI_LOGIN),
    ]);
  }
  return { ok: true, value: { enabled } };
}

export interface HostedRunnerCredential {
  id: string;
  userId: string;
  /** Plaintext; reaches only the runner exec's environment and is never persisted by the platform. */
  token: string;
}

export async function mintHostedRunnerPat(env: Env, repo: RepoRow): Promise<HostedRunnerCredential> {
  const userId = await ensureHostedCiUser(env);
  const now = Date.now();
  // An isolate that died mid-drain cannot revoke its own credential; the
  // expiry bounds it and this sweep removes the row.
  await env.DB.prepare('DELETE FROM pat WHERE user_id = ? AND created_at < ?').bind(userId, now - HOSTED_PAT_TTL_MS).run();
  const minted = await mintPAT(env, userId, `hosted-${repo.id.slice(0, 8)}-${Math.floor(now / 1000)}`, HOSTED_SCOPES, now + HOSTED_PAT_TTL_MS);
  return { id: minted.id, userId, token: minted.token };
}

export async function revokeHostedRunnerPat(env: Env, credential: HostedRunnerCredential): Promise<void> {
  await revokePAT(env, credential.id, credential.userId);
}

export interface HostedKick {
  /** False when the repository has hosted CI off or no container runtime is bound; never an error. */
  kicked: boolean;
  /** True when this kick started a drain; false when one was already running. */
  started: boolean;
  /** True when a drain was already running and this kick will be picked up after it. */
  queued: boolean;
}

const NO_KICK: HostedKick = { kicked: false, started: false, queued: false };

/**
 * Wakes the repository's hosted drain. Called from every path that queues CI
 * jobs (queueJobs, and the report route after a retry), where a failed kick
 * must never fail the caller: the DO coalesces kicks, and the next queueing
 * event kicks again.
 */
export async function kickHostedCi(env: Env, repo: Pick<RepoRow, 'id' | 'hosted_ci'>): Promise<HostedKick> {
  if (repo.hosted_ci !== 1 || !env.CI_SANDBOX) return NO_KICK;
  try {
    const r = await env.CI_SANDBOX.getByName(repo.id).kick();
    return { kicked: true, started: r.started, queued: r.queued };
  } catch (err) {
    console.warn(JSON.stringify({ hostedCiKickFailed: { repo: repo.id, error: String(err).slice(0, 200) } }));
    return NO_KICK;
  }
}

export interface HostedCiView {
  enabled: boolean;
  /** Claimable jobs now (queued, or running on an expired lease). */
  queued: number;
  running: number;
}

export async function hostedCiView(env: Env, repo: RepoRow): Promise<HostedCiView> {
  const now = Date.now();
  const counts = await env.DB.prepare(
    `SELECT SUM(CASE WHEN status = 'queued' OR (status = 'running' AND lease_until <= ?2) THEN 1 ELSE 0 END) AS queued,
            SUM(CASE WHEN status = 'running' AND lease_until > ?2 THEN 1 ELSE 0 END) AS running
       FROM ci_jobs WHERE repo_id = ?1`,
  )
    .bind(repo.id, now)
    .first<{ queued: number | null; running: number | null }>();
  return { enabled: repo.hosted_ci === 1, queued: counts?.queued ?? 0, running: counts?.running ?? 0 };
}
