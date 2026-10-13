/**
 * User-owned CI pipelines. `.kvarm/ci.json` is read at the immutable head,
 * each valid job becomes one queued check run and one generation-fenced
 * runner job, and claim/report use one D1 batch apiece.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { withLazyRepo } from '../artifacts/repo';
import { CHECK_RUN_COLUMNS, checkRunView, type CheckRunRow, type CheckRunView } from './checks';
import { CI_CONFIG_PATH, CI_LIMITS, parseCiConfig, type CiConfig } from './ciConfig';
import { flakeIssueStatement } from './issues';

export const CI_LEASE_SECONDS = 120;
export { CI_CONFIG_PATH, CI_LIMITS, type CiConfig } from './ciConfig';

/**
 * Parsed configs keyed by (Artifacts repo, commit). A commit's config never
 * changes, so one train run reads each head's config once however many
 * passes and calls ask for it.
 */
export type CiConfigMemo = Map<string, Promise<ServiceResult<CiConfig | null>>>;

type Fail = Extract<ServiceResult<never>, { ok: false }>;
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });

async function readConfigAt(env: Env, artifactsName: string, headSha: string): Promise<ServiceResult<CiConfig | null>> {
  return withLazyRepo(env, artifactsName, async (repo) => {
    const blob = await (await repo.get()).readFile({ ref: headSha, path: CI_CONFIG_PATH });
    if (!blob) return { ok: true, value: null };
    if (blob.size > CI_LIMITS.configBytes) return fail(422, `${CI_CONFIG_PATH} is too large`, 'CI_CONFIG_TOO_LARGE');
    return parseCiConfig(await blob.text());
  });
}

function configAt(env: Env, artifactsName: string, headSha: string, memo?: CiConfigMemo): Promise<ServiceResult<CiConfig | null>> {
  if (!memo) return readConfigAt(env, artifactsName, headSha);
  const key = `${artifactsName}:${headSha}`;
  let read = memo.get(key);
  if (!read) {
    read = readConfigAt(env, artifactsName, headSha);
    memo.set(key, read);
    // A failed read (storage, not config) is retried by the next caller instead of being remembered.
    read.catch(() => memo.delete(key));
  }
  return read;
}

export async function hasCiJobs(env: Env, artifactsName: string, headSha: string, memo?: CiConfigMemo): Promise<ServiceResult<boolean>> {
  const config = await configAt(env, artifactsName, headSha, memo);
  return config.ok ? { ok: true, value: (config.value?.jobs.length ?? 0) > 0 } : config;
}

export interface QueuedPipeline {
  jobs: number;
  workflowId: string | null;
}

async function queueJobs(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  configSha: string,
  headSha: string,
  treeSha: string | undefined,
  memo?: CiConfigMemo,
): Promise<ServiceResult<QueuedPipeline>> {
  const config = await configAt(env, repo.artifacts_name, configSha, memo);
  if (!config.ok) {
    const tree = await withLazyRepo(env, repo.artifacts_name, async (r) => (await (await r.get()).readCommit(headSha))?.treeHash);
    if (tree) {
      const now = Date.now();
      await env.DB.prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, conclusion, summary, attempt, required, quarantined, started_at, finished_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, 'kvarm/ci-config', 'failure', 'failure', ?6, 1, 1, 0, ?7, ?7, ?7
          WHERE NOT EXISTS (SELECT 1 FROM check_runs WHERE change_set_id = ?3 AND head_sha = ?4 AND name = 'kvarm/ci-config')`,
      )
        .bind(crypto.randomUUID(), repo.id, changeId, headSha, tree, JSON.stringify({ code: config.code, error: config.error }), now)
        .run();
    }
    return config;
  }
  if (config.value === null || config.value.jobs.length === 0) return { ok: true, value: { jobs: 0, workflowId: null } };
  let tree = treeSha;
  if (!tree) {
    tree = await withLazyRepo(env, repo.artifacts_name, async (r) => (await (await r.get()).readCommit(headSha))?.treeHash);
    if (!tree) return fail(503, `commit could not be read: ${headSha}`, 'STORAGE_UNAVAILABLE');
  }
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (const [position, job] of config.value.jobs.entries()) {
    const runId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    // A quarantined name still queues and runs; its runs are marked so the
    // checks gate and the rollup never count them (services/flakes.ts).
    statements.push(
      env.DB.prepare(
        `INSERT INTO check_runs (id, repo_id, change_set_id, head_sha, tree_sha, name, status, attempt, required, quarantined, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, 'queued', 1, ?7,
                CASE WHEN EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = ?6) THEN 1 ELSE 0 END,
                ?8
          WHERE NOT EXISTS (SELECT 1 FROM check_runs WHERE change_set_id = ?3 AND head_sha = ?4 AND name = ?6)`,
      ).bind(runId, repo.id, changeId, headSha, tree, job.name, job.required ? 1 : 0, now + position),
      env.DB.prepare(
        `INSERT INTO ci_jobs (id, repo_id, change_set_id, check_run_id, head_sha, tree_sha, name, command, required, timeout_seconds, created_at)
         SELECT ?1, ?2, ?3, k.id, ?4, ?5, ?6, ?7, ?8, ?9, ?10
           FROM check_runs k WHERE k.change_set_id = ?3 AND k.head_sha = ?4 AND k.name = ?6
         ON CONFLICT(change_set_id, head_sha, name) DO NOTHING`,
      ).bind(jobId, repo.id, changeId, headSha, tree, job.name, job.run, job.required ? 1 : 0, job.timeoutSeconds, now + position),
    );
  }
  await env.DB.batch(statements);
  const workflowId = `ci-${repo.id}-${headSha}`;
  const pipeline = env.CI_PIPELINE;
  if (!pipeline) return { ok: true, value: { jobs: config.value.jobs.length, workflowId: null } };
  try {
    await pipeline.create({ id: workflowId, params: { repoId: repo.id, changeId, headSha, treeSha: tree } });
  } catch {
    const exists = await pipeline.get(workflowId).then(
      () => true,
      () => false,
    );
    if (!exists) {
      console.error(JSON.stringify({ ciPipelineStartFailed: workflowId }));
      return { ok: true, value: { jobs: config.value.jobs.length, workflowId: null } };
    }
  }
  return { ok: true, value: { jobs: config.value.jobs.length, workflowId } };
}

/** Queue jobs whose config and execution commit are the same change head. */
export function queueChangeCi(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  headSha: string,
  treeSha?: string,
): Promise<ServiceResult<QueuedPipeline>> {
  return queueJobs(env, repo, changeId, headSha, headSha, treeSha);
}

/**
 * Queue jobs for an exact prepared/composed commit. The commands come from
 * the source head's config, but the runner receives only `executionSha` and
 * therefore cannot accidentally build the source or an unrelated ref.
 */
export function queueExactTreeCi(
  env: Env,
  repo: Pick<RepoRow, 'id' | 'artifacts_name'>,
  changeId: string,
  configSha: string,
  executionSha: string,
  treeSha: string,
  memo?: CiConfigMemo,
): Promise<ServiceResult<QueuedPipeline>> {
  return queueJobs(env, repo, changeId, configSha, executionSha, treeSha, memo);
}

interface JobRow {
  id: string;
  name: string;
  command: string;
  head_sha: string;
  tree_sha: string;
  generation: number;
  claimed_by: string;
  lease_until: number;
  timeout_seconds: number;
  required: number;
  status: string;
}

/**
 * What the platform knows about whose code a claimed job runs, so a runner
 * can decide before executing it whether to trust it (apps/cli runner trust
 * policy, architecture §0.5). The pusher of a head commit is not recorded,
 * so this names the change's author and whether any agent credential could
 * have written its head ref, not the identity that pushed `sha`.
 */
export interface JobProvenance {
  /** The change the job belongs to, or null for a job without one. */
  changeNumber: number | null;
  /** The change's head branch (without refs/heads/). */
  headRef: string | null;
  /** 'head' when `sha` is the change's current head; 'prepared' for a platform-built merge commit or a superseded head. */
  commit: 'head' | 'prepared';
  /** 'agent' when an agent token opened the change or its head is an agent workspace ref. */
  authorKind: 'human' | 'agent' | 'unknown';
  authorLogin: string | null;
  agent: { id: string; name: string } | null;
  /** The head ref is in the agent workspace namespace, which only agents may push. */
  agentWorkspaceRef: boolean;
  /**
   * Some write agent token of the repository (revoked and expired ones
   * included: the head may predate the revocation) was granted a pattern
   * matching the head ref, so an agent may have pushed the head.
   */
  agentWritableRef: boolean;
}

export interface ClaimedJob {
  id: string;
  name: string;
  command: string;
  sha: string;
  treeSha: string;
  generation: number;
  runnerId: string;
  leaseUntil: string;
  leaseSeconds: number;
  timeoutSeconds: number;
  required: boolean;
  /** Present on claim responses only. */
  provenance?: JobProvenance;
}

interface ProvenanceRow {
  change_number: number | null;
  change_head_ref: string | null;
  change_head_sha: string | null;
  change_agent_meta: string | null;
  change_author_login: string | null;
  /** 1 when some write agent token's grant matches the head ref. */
  agent_granted: number | null;
}

// The stable agent workspace namespace (AGENTS.md), as in
// services/workspaces.ts, which reaches this module through changes.ts, so
// importing it here would be a cycle.
const WORKSPACE_REF_PREFIX = 'refs/heads/agents/';
/**
 * Whether any write agent token of the job's repository has a ref grant
 * matching the change's head ref: exact, or a trailing `/*` prefix with a
 * non-empty rest, the same rule as refMatchesPattern in packages/gitops.
 * Revoked and expired tokens count, because the head may predate the
 * revocation, and an unreadable grant matches every ref. Evaluated in SQL
 * so the claim reads no grant rows back and has no row budget to exceed.
 */
const AGENT_GRANT_MATCH = `EXISTS (
  SELECT 1 FROM agent_tokens t, json_each(CASE WHEN json_valid(t.refs) THEN t.refs ELSE '["refs/*"]' END) g
   WHERE t.repo_id = j.repo_id AND t.role = 'write' AND c.head_ref IS NOT NULL AND g.type = 'text'
     AND (g.value = 'refs/heads/' || c.head_ref
          OR (substr(g.value, -2) = '/*'
              AND length('refs/heads/' || c.head_ref) > length(g.value) - 1
              AND substr('refs/heads/' || c.head_ref, 1, length(g.value) - 1) = substr(g.value, 1, length(g.value) - 1))))`;

// The same reading of change_sets.agent_meta as changes.ts parseAgent (a
// cycle again keeps it local).
function agentOf(meta: string | null): { id: string; name: string } | null {
  if (!meta) return null;
  try {
    const v = JSON.parse(meta) as { agentId?: unknown; agentName?: unknown };
    return typeof v.agentId === 'string' && typeof v.agentName === 'string' ? { id: v.agentId, name: v.agentName } : null;
  } catch {
    return null;
  }
}

function provenanceOf(r: JobRow & ProvenanceRow): JobProvenance {
  const headRef = r.change_head_ref;
  const fullRef = headRef === null ? null : headRef.startsWith('refs/') ? headRef : `refs/heads/${headRef}`;
  const agentWorkspaceRef = fullRef !== null && fullRef.startsWith(WORKSPACE_REF_PREFIX);
  const agent = agentOf(r.change_agent_meta);
  // Unparseable agent metadata still means an agent opened the change.
  const authorKind = r.change_number === null ? 'unknown' : agent || r.change_agent_meta || agentWorkspaceRef ? 'agent' : r.change_author_login ? 'human' : 'unknown';
  return {
    changeNumber: r.change_number,
    headRef,
    commit: r.change_head_sha !== null && r.change_head_sha === r.head_sha ? 'head' : 'prepared',
    authorKind,
    authorLogin: r.change_author_login,
    agent,
    agentWorkspaceRef,
    agentWritableRef: fullRef === null || agentWorkspaceRef || r.agent_granted === 1,
  };
}

function jobView(r: JobRow): ClaimedJob {
  return {
    id: r.id,
    name: r.name,
    command: r.command,
    sha: r.head_sha,
    treeSha: r.tree_sha,
    generation: r.generation,
    runnerId: r.claimed_by,
    leaseUntil: new Date(r.lease_until).toISOString(),
    leaseSeconds: CI_LEASE_SECONDS,
    timeoutSeconds: r.timeout_seconds,
    required: r.required === 1,
  };
}

function runnerIdOf(input: unknown): ServiceResult<string> {
  const id = (input as { runnerId?: unknown } | null)?.runnerId;
  return typeof id === 'string' && id.trim().length >= 1 && id.length <= 200
    ? { ok: true, value: id.trim() }
    : fail(422, 'runnerId is required (1-200 characters)', 'INVALID_RUNNER_ID');
}

/** Claims the oldest queued/expired job and explicitly demands its exact snapshot. */
export async function claimJob(env: Env, repo: RepoRow, input: unknown): Promise<ServiceResult<ClaimedJob | null>> {
  const owner = runnerIdOf(input);
  if (!owner.ok) return owner;
  const now = Date.now();
  const lease = now + CI_LEASE_SECONDS * 1000;
  const claimId = crypto.randomUUID();
  const candidate = `SELECT id FROM ci_jobs
    WHERE repo_id = ?1 AND (status = 'queued' OR (status = 'running' AND lease_until <= ?2))
    ORDER BY created_at, id LIMIT 1`;
  const [claimed, , , read] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET status = 'running', generation = generation + 1, claimed_by = ?3, claim_id = ?4,
          lease_until = ?5, started_at = COALESCE(started_at, ?2)
       WHERE id = (${candidate})
       RETURNING id`,
    ).bind(repo.id, now, owner.value, claimId, lease),
    env.DB.prepare(
      `UPDATE check_runs SET status = 'running', started_at = COALESCE(started_at, ?2)
        WHERE id = (SELECT check_run_id FROM ci_jobs WHERE repo_id = ?1 AND claim_id = ?3)`,
    ).bind(repo.id, now, claimId),
    env.DB.prepare(
      `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, attempt, requested_at)
       SELECT repo_id, head_sha, tree_sha, 'building', 'demand', 'snap-' || repo_id || '-' || head_sha, 0, ?2
         FROM ci_jobs WHERE repo_id = ?1 AND claim_id = ?3
       ON CONFLICT(repo_id, sha) DO NOTHING`,
    ).bind(repo.id, now, claimId),
    env.DB.prepare(
      `SELECT j.id, j.name, j.command, j.head_sha, j.tree_sha, j.generation, j.claimed_by, j.lease_until, j.timeout_seconds, j.required, j.status,
              c.number AS change_number, c.head_ref AS change_head_ref, c.head_sha AS change_head_sha, c.agent_meta AS change_agent_meta,
              u.login AS change_author_login,
              ${AGENT_GRANT_MATCH} AS agent_granted
         FROM ci_jobs j
         LEFT JOIN change_sets c ON c.id = j.change_set_id
         LEFT JOIN users u ON u.id = c.author_id
        WHERE j.repo_id = ?1 AND j.claim_id = ?2`,
    ).bind(repo.id, claimId),
  ]);
  if ((claimed?.results?.length ?? 0) === 0) return { ok: true, value: null };
  const row = (read?.results as Array<JobRow & ProvenanceRow> | undefined)?.[0];
  if (!row) return fail(500, 'claimed CI job could not be read', 'CLAIM_FAILED');
  const snapshotId = `snap-${repo.id}-${row.head_sha}`;
  try {
    await env.SNAPSHOT_BUILDER.create({ id: snapshotId, params: { repoId: repo.id, sha: row.head_sha, trigger: 'demand' } });
  } catch {
    // A push, workflow, checkout, or earlier claim may already own the same immutable build.
    await env.SNAPSHOT_BUILDER.get(snapshotId).catch(() => undefined);
  }
  return { ok: true, value: { ...jobView(row), provenance: provenanceOf(row) } };
}

interface FenceInput {
  runnerId: string;
  generation: number;
}

function parseFence(input: unknown): ServiceResult<FenceInput> {
  const owner = runnerIdOf(input);
  if (!owner.ok) return owner;
  const generation = (input as { generation?: unknown }).generation;
  return typeof generation === 'number' && Number.isInteger(generation) && generation >= 1
    ? { ok: true, value: { runnerId: owner.value, generation } }
    : fail(422, 'generation must be a positive integer', 'INVALID_GENERATION');
}

export async function heartbeatJob(env: Env, repo: RepoRow, id: string, input: unknown): Promise<ServiceResult<ClaimedJob>> {
  const p = parseFence(input);
  if (!p.ok) return p;
  const now = Date.now();
  const [renewed, current] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET lease_until = ?6
       WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = 'running' AND lease_until > ?5
       RETURNING id, name, command, head_sha, tree_sha, generation, claimed_by, lease_until, timeout_seconds, required, status`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, now, now + CI_LEASE_SECONDS * 1000),
    env.DB.prepare('SELECT generation, claimed_by, status FROM ci_jobs WHERE id = ? AND repo_id = ?').bind(id, repo.id),
  ]);
  const row = (renewed?.results as JobRow[] | undefined)?.[0];
  if (row) return { ok: true, value: jobView(row) };
  const exists = (current?.results?.length ?? 0) > 0;
  return fail(exists ? 409 : 404, exists ? 'the CI job claim is stale' : 'CI job not found', exists ? 'STALE_GENERATION' : 'CI_JOB_NOT_FOUND');
}

interface ReportBody extends FenceInput {
  conclusion: 'success' | 'failure';
  summary: string;
}

function parseReport(input: unknown): ServiceResult<ReportBody> {
  const fence = parseFence(input);
  if (!fence.ok) return fence;
  const b = input as Record<string, unknown>;
  if (b.conclusion !== 'success' && b.conclusion !== 'failure') return fail(422, 'conclusion must be success or failure', 'INVALID_CONCLUSION');
  const summary = JSON.stringify(b.summary ?? null);
  if (new TextEncoder().encode(summary).length > CI_LIMITS.summaryBytes) return fail(422, `summary must be at most ${CI_LIMITS.summaryBytes} bytes`, 'SUMMARY_TOO_LARGE');
  return { ok: true, value: { ...fence.value, conclusion: b.conclusion, summary } };
}

export interface ReportedJob {
  run: CheckRunView;
  change: { number: number; policy: string; baseRef: string; queued: boolean } | null;
  treeSha: string;
  /** True when this failure requeued the check's one automatic retry. */
  retried: boolean;
}

/**
 * Terminal update + check run + readback, atomically fenced by generation
 * and owner. A failure of a required, non-quarantined check at attempt 1 is
 * not terminal: the same check run is requeued at attempt 2 with this
 * report's summary kept as its evidence, and the job row is replaced by a
 * fresh queued copy (INSERT OR REPLACE on the job's immutable identity)
 * that re-runs the same head and tree. Attempt 2 is always terminal, and
 * a pass there records the flake (services/flakes.ts); the composition
 * readback recomputes from the check runs, so it stays pending through a
 * retry and concludes on the final attempt.
 */
export async function reportJob(env: Env, repo: RepoRow, id: string, input: unknown): Promise<ServiceResult<ReportedJob>> {
  const p = parseReport(input);
  if (!p.ok) return p;
  const now = Date.now();
  const flakeId = crypto.randomUUID();
  const [job, , runRead, , changeRead] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE ci_jobs SET status = ?5, summary = ?6, finished_at = ?7, lease_until = NULL
       WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = 'running' AND lease_until > ?7
       RETURNING tree_sha, check_run_id`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, p.value.conclusion, p.value.summary, now),
    env.DB.prepare(
      `INSERT INTO ci_flakes (id, repo_id, name, tree_sha, head_sha, change_set_id, attempt, summary, seen_at)
       SELECT ?3, ?2, k.name, j.tree_sha, j.head_sha, j.change_set_id, k.attempt, k.summary, ?4
         FROM check_runs k JOIN ci_jobs j ON j.check_run_id = k.id
        WHERE j.id = ?1 AND j.repo_id = ?2 AND j.status = 'success' AND k.attempt = 2
          AND NOT EXISTS (
            SELECT 1 FROM ci_flakes f
             WHERE f.repo_id = ?2 AND f.name = k.name AND f.head_sha = j.head_sha AND f.tree_sha = j.tree_sha
          )`,
    ).bind(id, repo.id, flakeId, now),
    env.DB.prepare(
      `UPDATE check_runs SET
         attempt = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN 2 ELSE check_runs.attempt END,
         status = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN 'queued' ELSE ?5 END,
         conclusion = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN NULL ELSE ?5 END,
         summary = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN (SELECT summary FROM ci_jobs WHERE id = ?1) ELSE ?6 END,
         started_at = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN NULL ELSE check_runs.started_at END,
         finished_at = CASE WHEN ?5 = 'failure'
                            AND (SELECT required FROM ci_jobs WHERE id = ?1) = 1
                            AND check_runs.attempt = 1
                            AND NOT EXISTS (SELECT 1 FROM ci_quarantine q WHERE q.repo_id = ?2 AND q.name = check_runs.name)
                       THEN NULL ELSE ?7 END
       WHERE id = (SELECT check_run_id FROM ci_jobs
                    WHERE id = ?1 AND repo_id = ?2 AND generation = ?3 AND claimed_by = ?4 AND status = ?5 AND finished_at = ?7)
       RETURNING ${CHECK_RUN_COLUMNS.replaceAll('k.', '')}`,
    ).bind(id, repo.id, p.value.generation, p.value.runnerId, p.value.conclusion, p.value.summary, now),
    env.DB.prepare(
      `INSERT OR REPLACE INTO ci_jobs (id, repo_id, change_set_id, check_run_id, head_sha, tree_sha, name, command, required, timeout_seconds, created_at)
       SELECT ?4, repo_id, change_set_id, check_run_id, head_sha, tree_sha, name, command, required, timeout_seconds, ?3
         FROM ci_jobs
        WHERE id = ?1 AND repo_id = ?2
          AND EXISTS (SELECT 1 FROM check_runs k WHERE k.id = ci_jobs.check_run_id AND k.status = 'queued' AND k.attempt = 2)`,
    ).bind(id, repo.id, now, crypto.randomUUID()),
    env.DB.prepare(
      `SELECT c.number, c.merge_policy, c.base_ref,
              EXISTS (SELECT 1 FROM merge_queue q WHERE q.change_set_id = c.id AND q.active = 1) AS queued
         FROM change_sets c WHERE c.id = (SELECT change_set_id FROM ci_jobs WHERE id = ?1 AND repo_id = ?2)`,
    ).bind(id, repo.id),
    env.DB.prepare(
      `UPDATE compositions
          SET checks = json_object(
                'treeSha', tree_sha,
                'configId', NULL,
                'required', (
                  SELECT json_group_array(json_object(
                    'name', x.name,
                    'state', CASE x.status WHEN 'failure' THEN 'failure' WHEN 'success' THEN 'success' WHEN 'skipped' THEN 'success' ELSE 'pending' END,
                    'producer', 'check-runs',
                    'runId', x.id
                  ))
                  FROM check_runs x
                  WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0
                    AND NOT EXISTS (
                      SELECT 1 FROM check_runs newer
                       WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                         AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id))
                    )
                ),
                'state', CASE
                  WHEN EXISTS (
                    SELECT 1 FROM check_runs x
                     WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND x.status = 'failure'
                       AND NOT EXISTS (SELECT 1 FROM check_runs newer
                         WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                           AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                  )
                    THEN 'failure'
                  WHEN EXISTS (
                    SELECT 1 FROM check_runs x
                     WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND x.status IN ('queued','running')
                       AND NOT EXISTS (SELECT 1 FROM check_runs newer
                         WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                           AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                  )
                    THEN 'pending'
                  ELSE 'success'
                END
              ),
              conflict_kind = CASE
                WHEN EXISTS (
                  SELECT 1 FROM check_runs x
                   WHERE x.repo_id = ?2 AND x.tree_sha = compositions.tree_sha AND x.required = 1 AND x.quarantined = 0 AND x.status = 'failure'
                     AND NOT EXISTS (SELECT 1 FROM check_runs newer
                       WHERE newer.repo_id = x.repo_id AND newer.tree_sha = x.tree_sha AND newer.name = x.name
                         AND (newer.created_at > x.created_at OR (newer.created_at = x.created_at AND newer.id > x.id)))
                )
                  THEN 'semantic'
                ELSE NULL
              END
        WHERE repo_id = ?2 AND tree_sha = (SELECT tree_sha FROM ci_jobs WHERE id = ?1 AND repo_id = ?2)`,
    ).bind(id, repo.id),
    // A flake registered above files (or counts on) the check's issue (services/issues.ts).
    flakeIssueStatement(env.DB, repo.id, flakeId, now),
  ]);
  const moved = (job?.results as Array<{ tree_sha: string; check_run_id: string }> | undefined)?.[0];
  const run = (runRead?.results as CheckRunRow[] | undefined)?.[0];
  if (!moved || !run) {
    const exists = await env.DB.prepare('SELECT 1 FROM ci_jobs WHERE id = ? AND repo_id = ?').bind(id, repo.id).first();
    return fail(exists ? 409 : 404, exists ? 'the CI job claim is stale' : 'CI job not found', exists ? 'STALE_GENERATION' : 'CI_JOB_NOT_FOUND');
  }
  const c = (changeRead?.results as Array<{ number: number; merge_policy: string; base_ref: string; queued: number }> | undefined)?.[0];
  return {
    ok: true,
    value: {
      run: checkRunView(run),
      treeSha: moved.tree_sha,
      change: c ? { number: c.number, policy: c.merge_policy, baseRef: c.base_ref, queued: c.queued === 1 } : null,
      retried: p.value.conclusion === 'failure' && run.status === 'queued' && (run.attempt ?? 1) === 2,
    },
  };
}

export function ciCleanupStatement(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM ci_flakes WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM ci_quarantine WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM ci_jobs WHERE repo_id = ?').bind(repoId),
  ];
}

// ---------------------------------------------------------------------------
// Queue visibility
// ---------------------------------------------------------------------------

const JOBS_PAGE_DEFAULT = 50;
const JOBS_PAGE_MAX = 100;

export interface CiJobView {
  id: string;
  name: string;
  status: string;
  required: boolean;
  quarantined: boolean;
  change: number | null;
  headSha: string;
  treeSha: string;
  runnerId: string | null;
  leaseUntil: string | null;
  timeoutSeconds: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CiJobsView {
  jobs: CiJobView[];
  nextCursor: string | null;
}

interface CiJobListRow {
  id: string;
  name: string;
  status: string;
  required: number;
  quarantined: number | null;
  change_number: number | null;
  head_sha: string;
  tree_sha: string;
  claimed_by: string | null;
  lease_until: number | null;
  timeout_seconds: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const isoOrNull = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function encodeJobsCursor(createdAt: number, id: string): string {
  return btoa(`${createdAt}:${id}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeJobsCursor(cursor: string): { createdAt: number; id: string } | null {
  try {
    const text = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const m = /^(\d{1,16}):([0-9a-f-]{36})$/.exec(text);
    return m ? { createdAt: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
}

/** One bounded page of the repository's runner jobs, newest first: the queue every runner claims from. */
export async function listCiJobs(env: Env, repo: RepoRow, page: { limit?: string; cursor?: string }): Promise<ServiceResult<CiJobsView>> {
  let limit = JOBS_PAGE_DEFAULT;
  if (page.limit !== undefined) {
    limit = /^\d{1,4}$/.test(page.limit) ? Number(page.limit) : 0;
    if (limit < 1 || limit > JOBS_PAGE_MAX) {
      return { ok: false, status: 400, error: `limit must be an integer from 1 to ${JOBS_PAGE_MAX}`, code: 'INVALID_LIMIT' };
    }
  }
  const after = page.cursor === undefined ? null : decodeJobsCursor(page.cursor);
  if (page.cursor !== undefined && !after) {
    return { ok: false, status: 400, error: 'invalid cursor', code: 'INVALID_CURSOR' };
  }
  const select = `SELECT j.id, j.name, j.status, j.required, k.quarantined, c.number AS change_number,
         j.head_sha, j.tree_sha, j.claimed_by, j.lease_until, j.timeout_seconds, j.created_at, j.started_at, j.finished_at
    FROM ci_jobs j JOIN check_runs k ON k.id = j.check_run_id LEFT JOIN change_sets c ON c.id = j.change_set_id
   WHERE j.repo_id = ?1`;
  const stmt = after
    ? env.DB.prepare(`${select} AND (j.created_at < ?2 OR (j.created_at = ?2 AND j.id < ?3)) ORDER BY j.created_at DESC, j.id DESC LIMIT ?4`).bind(repo.id, after.createdAt, after.id, limit + 1)
    : env.DB.prepare(`${select} ORDER BY j.created_at DESC, j.id DESC LIMIT ?2`).bind(repo.id, limit + 1);
  const rows = (await stmt.all<CiJobListRow>()).results ?? [];
  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    ok: true,
    value: {
      jobs: pageRows.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        required: r.required === 1,
        quarantined: r.quarantined === 1,
        change: r.change_number ?? null,
        headSha: r.head_sha,
        treeSha: r.tree_sha,
        runnerId: r.claimed_by,
        leaseUntil: isoOrNull(r.lease_until),
        timeoutSeconds: r.timeout_seconds,
        createdAt: new Date(r.created_at).toISOString(),
        startedAt: isoOrNull(r.started_at),
        finishedAt: isoOrNull(r.finished_at),
      })),
      nextCursor: more && last ? encodeJobsCursor(last.created_at, last.id) : null,
    },
  };
}
