import { newAgentToken } from '../auth/agentTokens';
import type { RepoRow } from '../db/repos';
import { hashAgentToken } from './agents';
import { resolveRepoAccessAs } from './access';
import type { Actor } from './authz';
import { matchCommandPolicy, sandboxPath, tailText } from '../containers/fleetJob';
import { createWorkspace, type WorkspaceContext, type WorkspaceRow } from './workspaces';
import { sandboxProvider } from './sandboxes/provider';
import type { ServiceResult } from '../repos/service';
import {
  nextScheduledBuild,
  requestEnvironmentBuild,
  type EnvironmentBuildState,
  type EnvironmentRow as EnvironmentScheduleRow,
} from './environments';

const RETENTION_MS = 25 * 24 * 60 * 60 * 1000;
const MAX_TTL_HOURS = 24 * 7;
const MAX_FILE_BYTES = 1_048_576;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_AUDIT_BYTES = 16 * 1024;

export interface SandboxContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
  origin: string;
  waitUntil(promise: Promise<unknown>): void;
}

export interface SandboxRow {
  id: string;
  repo_id: string;
  environment_id: string;
  build_id: string;
  workspace_id: string;
  owner_user_id: string;
  agent_id: string;
  token_id: string | null;
  status: 'starting' | 'running' | 'sleeping' | 'stopped' | 'failed';
  task: string | null;
  last_active_at: number;
  expires_at: number;
  run_expires_at: number;
  sleep_snapshot_id: string | null;
  created_at: number;
  stopped_at: number | null;
  error: string | null;
  workspace_ref?: string | null;
  repo_owner?: string;
  repo_name?: string;
  environment_name?: string;
  owner_login?: string;
  agent_name?: string;
}

export interface SandboxView {
  id: string;
  repo: string;
  repoId: string;
  environmentId: string;
  environmentName: string;
  buildId: string;
  workspaceId: string;
  workspaceRef: string | null;
  repoDirectory: string;
  pushRef: string | null;
  ownerUserId: string;
  agentId: string;
  agentName: string | null;
  status: SandboxRow['status'];
  task: string | null;
  lastActiveAt: string;
  expiresAt: string;
  runExpiresAt: string;
  sleepSnapshotId: string | null;
  createdAt: string;
  stoppedAt: string | null;
  error: string | null;
  resumed?: boolean;
  startedFrom?: 'build' | 'resume';
  buildOutdated?: boolean;
  localDiverged?: boolean;
}

export interface SandboxCommandView {
  id: string;
  sandboxId: string;
  actor: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  policy: 'allowed' | 'denied' | 'approved';
  approvalId: string | null;
  createdAt: string;
}

export interface SandboxApprovalView {
  id: string;
  repo: string;
  sandboxId: string;
  command: string;
  requestedBy: string;
  agentId?: string | null;
  agentName?: string | null;
  status: 'pending' | 'approved' | 'denied' | 'used';
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface StartSandboxInput {
  environment: string;
  workspace?: string;
  task?: string;
  ttlHours?: number;
  fresh?: boolean;
}

function fail<T>(status: number, error: string, code: string, extra: Record<string, unknown> = {}): ServiceResult<T> {
  return { ok: false, status, error, code, ...extra };
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function sandboxView(row: SandboxRow, extra: Partial<SandboxView> = {}): SandboxView {
  const workspaceRef = row.workspace_ref ?? null;
  return {
    id: row.id,
    repo: `${row.repo_owner ?? ''}/${row.repo_name ?? ''}`,
    repoId: row.repo_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name ?? '',
    buildId: row.build_id,
    workspaceId: row.workspace_id,
    workspaceRef,
    repoDirectory: repoDirectoryName(row.repo_name ?? ''),
    pushRef: workspaceRef,
    ownerUserId: row.owner_user_id,
    agentId: row.agent_id,
    agentName: row.agent_name ?? null,
    status: row.status,
    task: row.task,
    lastActiveAt: new Date(row.last_active_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    runExpiresAt: new Date(row.run_expires_at).toISOString(),
    sleepSnapshotId: row.sleep_snapshot_id,
    createdAt: new Date(row.created_at).toISOString(),
    stoppedAt: iso(row.stopped_at),
    error: row.error,
    ...extra,
  };
}

async function authorized(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  need: 'read' | 'write',
): Promise<ServiceResult<true>> {
  if (!actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  const access = await resolveRepoAccessAs(env, actor, repo.owner_login, repo.name, need);
  if (!access.ok) return fail(access.status, access.error, access.code);
  return { ok: true, value: true };
}

async function sandboxAgentId(env: Env, actor: Actor, create: boolean): Promise<string | null> {
  if (actor.agent) return actor.agent.agentId;
  const row = await env.DB.prepare(
    "SELECT id FROM agents WHERE owner_kind = 'user' AND owner_id = ?1 AND name = 'sandbox' AND revoked_at IS NULL",
  )
    .bind(actor.user.id)
    .first<{ id: string }>();
  if (row || !create) return row?.id ?? null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, description, created_by, created_at)
     VALUES (?1, 'user', ?2, ?3, 'sandbox', 'Agent principal for reusable repository sandboxes', ?2, ?4)
     ON CONFLICT (owner_id, name) DO NOTHING`,
  )
    .bind(id, actor.user.id, actor.user.login, Date.now())
    .run();
  return (await env.DB.prepare("SELECT id FROM agents WHERE owner_kind = 'user' AND owner_id = ?1 AND name = 'sandbox'")
    .bind(actor.user.id)
    .first<{ id: string }>())?.id ?? null;
}

function repoDirectory(repo: RepoRow): string {
  return repoDirectoryName(repo.name);
}

function repoDirectoryName(name: string): string {
  return `/workspace/${name.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

const SANDBOX_SELECT = `SELECT s.*, w.ref AS workspace_ref, r.owner_login AS repo_owner,
       r.name AS repo_name, e.name AS environment_name, a.name AS agent_name
  FROM sandboxes s
  LEFT JOIN workspaces w ON w.id = s.workspace_id
  LEFT JOIN agents a ON a.id = s.agent_id
  JOIN repos r ON r.id = s.repo_id
  JOIN environments e ON e.id = s.environment_id`;

async function sandboxRow(env: Env, repoId: string, id: string): Promise<SandboxRow | null> {
  return env.DB.prepare(
    `${SANDBOX_SELECT} WHERE s.repo_id = ?1 AND s.id = ?2`,
  )
    .bind(repoId, id)
    .first<SandboxRow>();
}

async function mintSandboxToken(
  env: Env,
  actor: Actor,
  repo: RepoRow,
  agentId: string,
  ref: string,
  expiresAt: number,
  sandboxId: string,
): Promise<{ id: string; token: string } | null> {
  const { token, prefix } = newAgentToken();
  const id = crypto.randomUUID();
  const hash = await hashAgentToken(token);
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at)
       SELECT ?1, a.id, 'sandbox run', ?2, ?3, ?4, 'write', ?5, ?6, ?7, ?8
        FROM agents a WHERE a.id = ?9 AND a.revoked_at IS NULL`,
    ).bind(id, prefix, hash, repo.id, JSON.stringify([ref]), actor.user.id, now, expiresAt, agentId),
    env.DB.prepare(
      `INSERT INTO events (id, type, payload, processed_at, created_at)
       SELECT ?1, 'agent.token.created', ?2, ?3, ?3
        WHERE EXISTS (SELECT 1 FROM agent_tokens WHERE id = ?4)`,
    ).bind(crypto.randomUUID(), JSON.stringify({ tokenId: id, prefix, sandboxId, repo: `${repo.owner_login}/${repo.name}` }), now, id),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 0) return null;
  return { id, token };
}

async function readWorkspace(
  env: Env,
  repoId: string,
  workspaceId: string,
): Promise<(WorkspaceRow & { created_by: string | null }) | null> {
  return env.DB.prepare(
    'SELECT w.* FROM workspaces w WHERE w.repo_id = ?1 AND w.id = ?2',
  )
    .bind(repoId, workspaceId)
    .first<WorkspaceRow & { created_by: string | null }>();
}

async function pickWorkspace(
  cx: SandboxContext,
  environment: { base_ref: string; id: string },
  agentId: string,
  workspaceId: string | undefined,
  task: string | undefined,
): Promise<ServiceResult<{ id: string; ref: string }>> {
  if (workspaceId) {
    const workspace = await readWorkspace(cx.env, cx.repo.id, workspaceId);
    if (!workspace || workspace.status !== 'active' || !workspace.ref) return fail(404, 'workspace not found', 'WORKSPACE_NOT_FOUND');
    if (workspace.agent_id && workspace.agent_id !== agentId) return fail(403, 'workspace belongs to another agent', 'FORBIDDEN');
    if (!cx.actor?.agent && workspace.created_by && workspace.created_by !== cx.actor?.user.id) {
      return fail(403, 'workspace belongs to another user', 'FORBIDDEN');
    }
    if (!workspace.agent_id) {
      await cx.env.DB.prepare('UPDATE workspaces SET agent_id = ?3, agent = COALESCE(agent, ?4) WHERE repo_id = ?1 AND id = ?2')
        .bind(cx.repo.id, workspaceId, agentId, 'sandbox')
        .run();
    }
    return { ok: true, value: { id: workspace.id, ref: workspace.ref } };
  }
  const context: WorkspaceContext = {
    env: cx.env,
    repo: cx.repo,
    actor: cx.actor,
    origin: cx.origin,
    waitUntil: cx.waitUntil,
  };
  const created = await createWorkspace(context, {
    task: task?.trim() || `sandbox ${environment.id}`,
    base: environment.base_ref,
    agent: cx.actor?.agent?.agentName ?? 'sandbox',
  });
  if (!created.ok) return created;
  if (!cx.actor?.agent) {
    await cx.env.DB.prepare('UPDATE workspaces SET agent_id = ?, agent = COALESCE(agent, ?) WHERE repo_id = ? AND id = ?')
      .bind(agentId, 'sandbox', cx.repo.id, created.value.id)
      .run();
  }
  const row = await readWorkspace(cx.env, cx.repo.id, created.value.id);
  if (!row?.ref) return fail(500, 'workspace ref could not be read', 'WORKSPACE_CREATE_FAILED');
  return { ok: true, value: { id: row.id, ref: row.ref } };
}

function rpcFailure(value: unknown): value is { ok: false; status: number; code: string; error: string } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

function rpcSuccess<T>(value: unknown): value is { ok: true; value: T } {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === true;
}

function scheduleStaleBuild(cx: SandboxContext, environment: StartEnvironmentRow): void {
  const next = nextScheduledBuild(
    environment,
    environment.ready_build_created_at === null ? null : { created_at: environment.ready_build_created_at },
    environment.latest_build_status === null
      ? null
      : {
          status: environment.latest_build_status,
          attempt: environment.latest_build_attempt ?? 0,
          finished_at: environment.latest_build_finished_at,
        },
  );
  if (!next || next.at > Date.now()) return;
  cx.waitUntil(
    requestEnvironmentBuild(cx.env, environment.id, next.reason)
      .then((result) => {
        if (!result.ok && result.code !== 'BUILD_NOT_QUEUED') {
          console.warn(JSON.stringify({ staleEnvironmentBuild: environment.id, error: result.error }));
        }
      })
      .catch((error: unknown) => {
        console.warn(
          JSON.stringify({
            staleEnvironmentBuild: environment.id,
            error: String(error instanceof Error ? error.message : error),
          }),
        );
      }),
  );
}

export async function startSandbox(
  cx: SandboxContext,
  input: StartSandboxInput,
): Promise<ServiceResult<SandboxView>> {
  const access = await authorized(cx.env, cx.repo, cx.actor, 'write');
  if (!access.ok) return access;
  if (typeof input.environment !== 'string') return fail(422, 'environment is required', 'INVALID_ENVIRONMENT');
  const environment = await cx.env.DB.prepare(
    `SELECT e.*, b.created_at AS ready_build_created_at,
        (SELECT status FROM environment_builds WHERE environment_id = e.id ORDER BY seq DESC LIMIT 1) AS latest_build_status,
        (SELECT attempt FROM environment_builds WHERE environment_id = e.id ORDER BY seq DESC LIMIT 1) AS latest_build_attempt,
        (SELECT finished_at FROM environment_builds WHERE environment_id = e.id ORDER BY seq DESC LIMIT 1) AS latest_build_finished_at
       FROM environments e
      LEFT JOIN environment_builds b ON b.id = e.ready_build_id AND b.status = 'ready'
      WHERE e.repo_id = ?1 AND e.id = ?2 AND e.archived_at IS NULL`,
  )
    .bind(cx.repo.id, input.environment)
    .first<StartEnvironmentRow>();
  if (!environment) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  const agentId = await sandboxAgentId(cx.env, cx.actor!, true);
  if (!agentId) return fail(409, 'sandbox agent could not be created', 'AGENT_CREATE_FAILED');
  const now = Date.now();
  const ttlHours = input.ttlHours ?? 24;
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    return fail(422, `ttlHours must be from 1 to ${MAX_TTL_HOURS}`, 'INVALID_TTL');
  }
  scheduleStaleBuild(cx, environment);
  const runExpiresAt = now + ttlHours * 60 * 60 * 1000;
  let workspace: { id: string; ref: string } | null = null;
  let existing: SandboxRow | null = null;
  if (!input.fresh) {
    if (input.workspace) {
      const candidate = await cx.env.DB.prepare(
        `${SANDBOX_SELECT}
          WHERE s.repo_id = ?1 AND s.workspace_id = ?2 AND s.environment_id = ?3
            AND s.owner_user_id = ?4 AND s.agent_id = ?5 AND s.status IN ('running','sleeping')
          ORDER BY s.last_active_at DESC LIMIT 1`,
      )
        .bind(cx.repo.id, input.workspace, environment.id, cx.actor!.user.id, agentId)
        .first<SandboxRow>();
      if (
        candidate &&
        candidate.status !== 'stopped' &&
        candidate.workspace_id === input.workspace
      ) {
        existing = candidate;
      }
    } else {
      existing = await cx.env.DB.prepare(
        `${SANDBOX_SELECT}
          WHERE s.repo_id = ?1 AND s.environment_id = ?2 AND s.owner_user_id = ?3 AND s.agent_id = ?4
            AND s.status IN ('running','sleeping') ORDER BY s.last_active_at DESC LIMIT 1`,
      )
        .bind(cx.repo.id, environment.id, cx.actor!.user.id, agentId)
        .first<SandboxRow>();
    }
  }
  if (existing?.status === 'running') {
    return {
      ok: true,
      value: sandboxView(existing, {
        resumed: true,
        startedFrom: 'resume',
        buildOutdated: existing.build_id !== environment.ready_build_id,
        localDiverged: false,
      }),
    };
  }
  if (existing?.status === 'sleeping') {
    const woken = await wakeSandbox(cx, existing, ttlHours);
    if (!woken.ok) return woken;
    return {
      ok: true,
      value: sandboxView(woken.value.row, {
        resumed: true,
        startedFrom: 'resume',
        buildOutdated: existing.build_id !== environment.ready_build_id,
        localDiverged: woken.value.localDiverged,
      }),
    };
  }
  const buildId = existing?.build_id ?? environment.ready_build_id;
  if (!buildId) return fail(409, 'environment has no ready build', 'ENVIRONMENT_NOT_READY');
  const build = await cx.env.DB.prepare(
    `SELECT snapshot_id FROM environment_builds WHERE id = ?1 AND environment_id = ?2
       AND status IN ('ready','superseded')`,
  )
    .bind(buildId, environment.id)
    .first<{ snapshot_id: string | null }>();
  if (!build?.snapshot_id) return fail(409, 'environment has no ready build', 'ENVIRONMENT_NOT_READY');
  if (existing?.workspace_ref) workspace = { id: existing.workspace_id, ref: existing.workspace_ref };
  if (!workspace) {
    const picked = await pickWorkspace(cx, environment, agentId, input.workspace, input.task);
    if (!picked.ok) return picked;
    workspace = picked.value;
  }
  const id = existing?.id ?? crypto.randomUUID();
  const expiresAt = now + RETENTION_MS;
  const minted = await mintSandboxToken(cx.env, cx.actor!, cx.repo, agentId, workspace.ref, runExpiresAt, id);
  if (!minted) return fail(409, 'sandbox agent is revoked', 'AGENT_REVOKED');
  const sleepSnapshotId = existing?.sleep_snapshot_id ?? null;
  if (existing) {
    await cx.env.DB.batch([
      cx.env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1')
        .bind(existing.token_id, now),
      cx.env.DB.prepare(
        `UPDATE sandboxes SET status = 'starting', token_id = ?2, expires_at = ?3, run_expires_at = ?4,
          last_active_at = ?5, error = NULL WHERE id = ?1 AND status = 'sleeping'`,
      ).bind(id, minted.id, expiresAt, runExpiresAt, now),
    ]);
  } else {
    await cx.env.DB.prepare(
      `INSERT INTO sandboxes
        (id, repo_id, environment_id, build_id, workspace_id, owner_user_id, agent_id, token_id, status, task,
         last_active_at, expires_at, run_expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'starting', ?9, ?10, ?11, ?12, ?10)`,
    )
      .bind(id, cx.repo.id, environment.id, buildId, workspace.id, cx.actor!.user.id, agentId, minted.id, input.task ?? null, now, expiresAt, runExpiresAt)
      .run();
  }
  const provider = sandboxProvider(environment.os);
  if (!provider) return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  const doResult = await provider.agentSandbox(cx.env, id).start({
    sandboxId: id,
    environmentId: environment.id,
    buildSnapshotId: build.snapshot_id,
    sleepSnapshotId,
    instance: environment.instance,
    idleMinutes: environment.idle_minutes,
    expiresAt,
    runExpiresAt,
    repoDirectory: repoDirectory(cx.repo),
    repositoryUrl: `${cx.origin}/${cx.repo.owner_login}/${cx.repo.name}.git`,
    allowedHosts: JSON.parse(environment.allowed_hosts) as string[],
    workspaceRef: workspace.ref,
    baseRef: environment.base_ref,
    token: minted.token,
    tokenId: minted.id,
  });
  if (!rpcSuccess<{ started: true; localDiverged: boolean }>(doResult)) {
    const failure = rpcFailure(doResult) ? doResult : { status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'sandbox container could not start' };
    await cx.env.DB.batch([
      cx.env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1').bind(minted.id, Date.now()),
      cx.env.DB.prepare(
        `UPDATE sandboxes SET status = ?2, token_id = NULL, error = ?3
          WHERE id = ?1 AND status = 'starting'`,
      ).bind(id, existing ? 'sleeping' : 'failed', failure.error.slice(0, 1000)),
    ]);
    return fail(failure.status, failure.error, failure.code);
  }
  await cx.env.DB.prepare(
    "UPDATE sandboxes SET status = 'running', sleep_snapshot_id = NULL, last_active_at = ?2 WHERE id = ?1",
  )
    .bind(id, Date.now())
    .run();
  const row = await sandboxRow(cx.env, cx.repo.id, id);
  if (!row) return fail(500, 'sandbox could not be read after start', 'SANDBOX_START_FAILED');
  return {
    ok: true,
    value: sandboxView(row, {
      resumed: Boolean(existing),
      startedFrom: existing ? 'resume' : 'build',
      buildOutdated: buildId !== environment.ready_build_id,
      localDiverged: doResult.value.localDiverged,
    }),
  };
}

interface EnvironmentRow extends EnvironmentScheduleRow {
  id: string;
  repo_id: string;
  name: string;
  os: string;
  base_ref: string;
  instance: string;
  idle_minutes: number;
  allowed_hosts: string;
  command_policy: string;
  ready_build_id: string | null;
  max_build_age_hours: number;
  ready_build_created_at: number | null;
}

interface StartEnvironmentRow extends EnvironmentRow {
  latest_build_status: EnvironmentBuildState | null;
  latest_build_attempt: number | null;
  latest_build_finished_at: number | null;
}

function ownsSandbox(actor: Actor | null, row: SandboxRow): boolean {
  return Boolean(
    actor &&
      actor.user.id === row.owner_user_id &&
      (!actor.agent || actor.agent.agentId === row.agent_id),
  );
}

async function wakeSandbox(
  cx: SandboxContext,
  row: SandboxRow,
  ttlHours = 24,
): Promise<ServiceResult<{ row: SandboxRow; localDiverged: boolean }>> {
  if (!cx.actor || !ownsSandbox(cx.actor, row)) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  if (row.status !== 'sleeping' || !row.agent_id || !row.workspace_ref) {
    return fail(409, 'sandbox is not ready to wake', 'SANDBOX_NOT_READY');
  }
  const [environment, build] = await Promise.all([
    cx.env.DB.prepare('SELECT * FROM environments WHERE id = ?1 AND repo_id = ?2')
      .bind(row.environment_id, row.repo_id)
      .first<EnvironmentRow>(),
    cx.env.DB.prepare(
      `SELECT snapshot_id FROM environment_builds
        WHERE id = ?1 AND environment_id = ?2 AND status IN ('ready','superseded')`,
    )
      .bind(row.build_id, row.environment_id)
      .first<{ snapshot_id: string | null }>(),
  ]);
  if (!environment || !build?.snapshot_id) return fail(409, 'sandbox build snapshot is unavailable', 'ENVIRONMENT_NOT_READY');
  const now = Date.now();
  const runExpiresAt = now + ttlHours * 60 * 60 * 1000;
  const expiresAt = now + RETENTION_MS;
  const minted = await mintSandboxToken(
    cx.env,
    cx.actor,
    cx.repo,
    row.agent_id,
    row.workspace_ref,
    runExpiresAt,
    row.id,
  );
  if (!minted) return fail(409, 'sandbox agent is revoked', 'AGENT_REVOKED');
  const updated = await cx.env.DB.batch([
    cx.env.DB.prepare(
      `UPDATE sandboxes SET status = 'starting', token_id = ?2, expires_at = ?3,
        run_expires_at = ?4, last_active_at = ?5, error = NULL
        WHERE id = ?1 AND status = 'sleeping' AND token_id IS ?6`,
    ).bind(row.id, minted.id, expiresAt, runExpiresAt, now, row.token_id),
    cx.env.DB.prepare(
      `UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2)
        WHERE id = ?1 AND EXISTS (SELECT 1 FROM sandboxes WHERE id = ?3 AND token_id = ?4)`,
    ).bind(row.token_id, now, row.id, minted.id),
  ]);
  if ((updated[0]?.meta?.changes ?? 0) !== 1) {
    await cx.env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1')
      .bind(minted.id, Date.now())
      .run();
    return fail(409, 'sandbox is already being woken', 'SANDBOX_BUSY');
  }
  const provider = sandboxProvider(environment.os);
  if (!provider) return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  let allowedHosts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(environment.allowed_hosts);
    if (Array.isArray(parsed)) allowedHosts = parsed.filter((host): host is string => typeof host === 'string');
  } catch {
    allowedHosts = [];
  }
  const result = await provider.agentSandbox(cx.env, row.id).start({
    sandboxId: row.id,
    environmentId: row.environment_id,
    buildSnapshotId: build.snapshot_id,
    sleepSnapshotId: row.sleep_snapshot_id,
    instance: environment.instance,
    idleMinutes: environment.idle_minutes,
    expiresAt,
    runExpiresAt,
    repoDirectory: repoDirectory(cx.repo),
    repositoryUrl: `${cx.origin}/${cx.repo.owner_login}/${cx.repo.name}.git`,
    allowedHosts,
    workspaceRef: row.workspace_ref,
    baseRef: environment.base_ref,
    token: minted.token,
    tokenId: minted.id,
  });
  if (!rpcSuccess<{ started: true; localDiverged: boolean }>(result)) {
    const failure = rpcFailure(result)
      ? result
      : { status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'sandbox container could not start' };
    await cx.env.DB.batch([
      cx.env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?2) WHERE id = ?1')
        .bind(minted.id, Date.now()),
      cx.env.DB.prepare(
        `UPDATE sandboxes SET status = 'sleeping', token_id = NULL, error = ?2
          WHERE id = ?1 AND status = 'starting' AND token_id = ?3`,
      ).bind(row.id, failure.error.slice(0, 1000), minted.id),
    ]);
    return fail(failure.status, failure.error, failure.code);
  }
  await cx.env.DB.prepare(
    `UPDATE sandboxes SET status = 'running', sleep_snapshot_id = NULL, last_active_at = ?2
      WHERE id = ?1 AND status IN ('starting','running')`,
  )
    .bind(row.id, Date.now())
    .run();
  const current = await sandboxRow(cx.env, cx.repo.id, row.id);
  if (!current) return fail(500, 'sandbox could not be read after wake', 'SANDBOX_WAKE_FAILED');
  return { ok: true, value: { row: current, localDiverged: result.value.localDiverged } };
}

export async function getSandbox(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  id: string,
): Promise<ServiceResult<SandboxView>> {
  const access = await authorized(env, repo, actor, 'read');
  if (!access.ok) return access;
  const row = await sandboxRow(env, repo.id, id);
  if (!row) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  return { ok: true, value: sandboxView(row) };
}

export async function listSandboxes(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  page: { cursor?: string; limit?: number } = {},
): Promise<ServiceResult<{ sandboxes: SandboxView[]; nextCursor: string | null }>> {
  const access = await authorized(env, repo, actor, 'read');
  if (!access.ok) return access;
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 100);
  let createdAt = Number.MAX_SAFE_INTEGER;
  let cursorId = '\uffff';
  if (page.cursor) {
    const parts = page.cursor.split(':');
    if (parts.length !== 2 || !Number.isFinite(Number(parts[0]))) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
    createdAt = Number(parts[0]);
    cursorId = parts[1]!;
  }
  const rows = await env.DB.prepare(
    `${SANDBOX_SELECT}
      WHERE s.repo_id = ?1 AND (s.created_at < ?2 OR (s.created_at = ?2 AND s.id < ?3))
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?4`,
  )
    .bind(repo.id, createdAt, cursorId, limit + 1)
    .all<SandboxRow>();
  const values = rows.results ?? [];
  const more = values.length > limit;
  const selected = more ? values.slice(0, limit) : values;
  const last = selected.at(-1);
  return {
    ok: true,
    value: {
      sandboxes: selected.map((row) => sandboxView(row)),
      nextCursor: more && last ? `${last.created_at}:${last.id}` : null,
    },
  };
}

export async function listMySandboxes(
  env: Env,
  actor: Actor | null,
  page: { cursor?: string; limit?: number } = {},
): Promise<ServiceResult<{ sandboxes: SandboxView[]; nextCursor: string | null }>> {
  if (!actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 100);
  let createdAt = Number.MAX_SAFE_INTEGER;
  let cursorId = '\uffff';
  if (page.cursor) {
    const parts = page.cursor.split(':');
    if (parts.length !== 2 || !Number.isFinite(Number(parts[0]))) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
    createdAt = Number(parts[0]);
    cursorId = parts[1]!;
  }
  const agentClause = actor.agent ? ' AND s.agent_id = ?4 AND s.repo_id = ?5' : '';
  const rows = await env.DB.prepare(
    `${SANDBOX_SELECT}
      WHERE s.owner_user_id = ?1
        AND (s.created_at < ?2 OR (s.created_at = ?2 AND s.id < ?3))${agentClause}
      ORDER BY s.created_at DESC, s.id DESC LIMIT ?${actor.agent ? 6 : 4}`,
  )
    .bind(
      actor.user.id,
      createdAt,
      cursorId,
      ...(actor.agent ? [actor.agent.agentId, actor.agent.repoId, limit + 1] : [limit + 1]),
    )
    .all<SandboxRow>();
  const values = rows.results ?? [];
  const more = values.length > limit;
  const selected = more ? values.slice(0, limit) : values;
  const last = selected.at(-1);
  return {
    ok: true,
    value: {
      sandboxes: selected.map((row) => sandboxView(row)),
      nextCursor: more && last ? `${last.created_at}:${last.id}` : null,
    },
  };
}

export async function stopSandbox(
  cx: SandboxContext,
  id: string,
  options: { discard?: boolean } = {},
): Promise<ServiceResult<SandboxView>> {
  const access = await authorized(cx.env, cx.repo, cx.actor, 'write');
  if (!access.ok) return access;
  const row = await sandboxRow(cx.env, cx.repo.id, id);
  if (!row) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  if (!ownsSandbox(cx.actor, row)) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  if (row.status === 'stopped') return { ok: true, value: sandboxView(row) };
  const provider = sandboxProvider('linux');
  if (!provider) return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  if (options.discard) {
    const result = await provider.agentSandbox(cx.env, id).discard();
    if (!rpcSuccess(result)) {
      const failure = rpcFailure(result) ? result : { status: 503, code: 'SANDBOX_DISCARD_FAILED', error: 'sandbox could not be discarded' };
      return fail(failure.status, failure.error, failure.code);
    }
  } else if (row.status === 'running' || row.status === 'starting') {
    const result = await provider.agentSandbox(cx.env, id).sleep();
    if (!rpcSuccess(result)) {
      const failure = rpcFailure(result) ? result : { status: 503, code: 'SANDBOX_SLEEP_FAILED', error: 'sandbox could not be put to sleep' };
      return fail(failure.status, failure.error, failure.code);
    }
  }
  const updated = await sandboxRow(cx.env, cx.repo.id, id);
  return { ok: true, value: sandboxView(updated ?? row) };
}

async function authorizeOwner(
  cx: SandboxContext,
  id: string,
): Promise<ServiceResult<SandboxRow>> {
  const access = await authorized(cx.env, cx.repo, cx.actor, 'write');
  if (!access.ok) return access;
  const row = await sandboxRow(cx.env, cx.repo.id, id);
  if (!row) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  if (!ownsSandbox(cx.actor, row)) return fail(403, 'sandbox is owned by another principal', 'SANDBOX_NOT_OWNED');
  if (row.status === 'stopped' || row.status === 'failed') return fail(410, 'sandbox is stopped', 'SANDBOX_STOPPED');
  return { ok: true, value: row };
}

async function auditCommand(
  cx: SandboxContext,
  input: {
    sandboxId: string;
    command: string;
    cwd: string;
    policy: 'allowed' | 'denied' | 'approved';
    approvalId?: string | null;
    exitCode?: number | null;
    durationMs?: number;
    stdout?: string;
    stderr?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  await cx.env.DB.prepare(
    `INSERT INTO sandbox_commands (id, sandbox_id, actor, command, cwd, exit_code, duration_ms, stdout_tail, stderr_tail, policy, approval_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
  )
    .bind(
      id,
      input.sandboxId,
      cx.actor?.agent?.agentName ?? cx.actor?.user.login ?? 'anonymous',
      input.command,
      input.cwd,
      input.exitCode ?? null,
      input.durationMs ?? 0,
      tailText(input.stdout ?? '', MAX_AUDIT_BYTES),
      tailText(input.stderr ?? '', MAX_AUDIT_BYTES),
      input.policy,
      input.approvalId ?? null,
      Date.now(),
    )
    .run();
  return id;
}

async function approveOrRequest(
  cx: SandboxContext,
  row: SandboxRow,
  command: string,
  approvalId?: string,
): Promise<ServiceResult<{ approvalId: string | null }>> {
  if (approvalId) {
    const consumed = await cx.env.DB.prepare(
      `UPDATE sandbox_approvals SET status = 'used', decided_at = COALESCE(decided_at, ?4)
        WHERE id = ?1 AND sandbox_id = ?2 AND command = ?3 AND status = 'approved' AND expires_at > ?4
        RETURNING id`,
    )
      .bind(approvalId, row.id, command, Date.now())
      .first<{ id: string }>();
    if (!consumed) return fail(403, 'approval is invalid, expired, or already used', 'APPROVAL_INVALID');
    return { ok: true, value: { approvalId: consumed.id } };
  }
  const pending = await cx.env.DB.prepare(
    `SELECT id FROM sandbox_approvals WHERE sandbox_id = ?1 AND command = ?2 AND status = 'pending' AND expires_at > ?3
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(row.id, command, Date.now())
    .first<{ id: string }>();
  if (pending) return fail(409, 'command approval is required', 'APPROVAL_REQUIRED', { approvalId: pending.id });
  const id = crypto.randomUUID();
  const now = Date.now();
  await cx.env.DB.prepare(
    `INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
  )
    .bind(id, row.id, row.repo_id, command, cx.actor!.user.id, now, now + 60 * 60 * 1000)
    .run();
  return fail(409, 'command approval is required', 'APPROVAL_REQUIRED', { approvalId: id });
}

export async function execSandbox(
  cx: SandboxContext,
  id: string,
  input: { command: string; cwd?: string; timeoutSeconds?: number; approvalId?: string },
): Promise<ServiceResult<{ exitCode: number; stdout: string; stderr: string; durationMs: number; commandId: string }>> {
  const loaded = await authorizeOwner(cx, id);
  if (!loaded.ok) return loaded;
  if (typeof input.command !== 'string' || input.command.length === 0 || input.command.length > 10_000) {
    return fail(422, 'command must be a non-empty string up to 10000 characters', 'INVALID_COMMAND');
  }
  const timeoutSeconds = input.timeoutSeconds ?? 120;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
    return fail(422, 'timeoutSeconds must be from 1 to 600', 'INVALID_TIMEOUT');
  }
  const environment = await cx.env.DB.prepare('SELECT command_policy FROM environments WHERE id = ?1')
    .bind(loaded.value.environment_id)
    .first<{ command_policy: string }>();
  let policy = { deny: [] as string[], approve: [] as string[] };
  try {
    const parsed = JSON.parse(environment?.command_policy ?? '{}') as { deny?: unknown; approve?: unknown };
    if (Array.isArray(parsed.deny)) policy.deny = parsed.deny.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(parsed.approve)) policy.approve = parsed.approve.filter((x): x is string => typeof x === 'string');
  } catch {
    return fail(500, 'sandbox command policy is invalid', 'INVALID_COMMAND_POLICY');
  }
  const classification = matchCommandPolicy(input.command, policy);
  const cwd = sandboxPath(`/workspace/${cx.repo.name.replace(/[^A-Za-z0-9._-]/g, '-')}`, input.cwd ?? '.');
  if (!cwd) return fail(422, 'cwd must stay within /workspace', 'INVALID_PATH');
  if (classification === 'denied') {
    await auditCommand(cx, { sandboxId: id, command: input.command, cwd, policy: 'denied', exitCode: null });
    return fail(403, 'command is denied by sandbox policy', 'COMMAND_DENIED');
  }
  let approvalId: string | null = null;
  if (classification === 'approved') {
    const approved = await approveOrRequest(cx, loaded.value, input.command, input.approvalId);
    if (!approved.ok) {
      await auditCommand(cx, { sandboxId: id, command: input.command, cwd, policy: 'approved', approvalId: (approved as { approvalId?: string }).approvalId });
      return approved;
    }
    approvalId = approved.value.approvalId;
  }
  if (loaded.value.status === 'sleeping') {
    const resumed = await wakeSandbox(cx, loaded.value);
    if (!resumed.ok) return resumed;
  }
  const provider = sandboxProvider('linux');
  if (!provider) return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  const result = await provider.agentSandbox(cx.env, id).exec({ command: input.command, cwd, timeoutSeconds });
  if (!rpcSuccess<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>(result)) {
    const failure = rpcFailure(result) ? result : { status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'sandbox container could not execute the command' };
    const commandId = await auditCommand(cx, {
      sandboxId: id,
      command: input.command,
      cwd,
      policy: classification === 'approved' ? 'approved' : 'allowed',
      approvalId,
      stderr: failure.error,
    });
    return fail(failure.status, failure.error, failure.code, { commandId });
  }
  const output = result.value;
  const commandId = await auditCommand(cx, {
    sandboxId: id,
    command: input.command,
    cwd,
    policy: classification === 'approved' ? 'approved' : 'allowed',
    approvalId,
    exitCode: output.exitCode,
    durationMs: output.durationMs,
    stdout: output.stdout,
    stderr: output.stderr,
  });
  return {
    ok: true,
    value: {
      exitCode: output.exitCode,
      stdout: tailText(output.stdout, MAX_OUTPUT_BYTES / 2),
      stderr: tailText(output.stderr, MAX_OUTPUT_BYTES / 2),
      durationMs: output.durationMs,
      commandId,
    },
  };
}

export async function readSandboxFile(
  cx: SandboxContext,
  id: string,
  path: string,
): Promise<ServiceResult<{ content: string; size: number }>> {
  const loaded = await authorizeOwner(cx, id);
  if (!loaded.ok) return loaded;
  if (loaded.value.status === 'sleeping') {
    const resumed = await wakeSandbox(cx, loaded.value);
    if (!resumed.ok) return resumed;
  }
  const provider = sandboxProvider('linux');
  const result = await provider?.agentSandbox(cx.env, id).readFile({ path });
  if (!rpcSuccess<{ content: string; size: number }>(result)) {
    const failure = rpcFailure(result) ? result : { status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'sandbox container could not read the file' };
    return fail(failure.status, failure.error, failure.code);
  }
  return { ok: true, value: result.value };
}

export async function writeSandboxFile(
  cx: SandboxContext,
  id: string,
  input: { path: string; content: string },
): Promise<ServiceResult<{ written: number }>> {
  const loaded = await authorizeOwner(cx, id);
  if (!loaded.ok) return loaded;
  if (new TextEncoder().encode(input.content).byteLength > MAX_FILE_BYTES) return fail(413, 'sandbox files are limited to 1 MiB', 'FILE_TOO_LARGE');
  if (loaded.value.status === 'sleeping') {
    const resumed = await wakeSandbox(cx, loaded.value);
    if (!resumed.ok) return resumed;
  }
  const result = await sandboxProvider('linux')?.agentSandbox(cx.env, id).writeFile(input);
  if (!rpcSuccess<{ written: number }>(result)) {
    const failure = rpcFailure(result) ? result : { status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'sandbox container could not write the file' };
    return fail(failure.status, failure.error, failure.code);
  }
  return { ok: true, value: result.value };
}

export async function listSandboxCommands(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  sandboxId: string,
  limit = 50,
): Promise<ServiceResult<SandboxCommandView[]>> {
  const access = await authorized(env, repo, actor, 'read');
  if (!access.ok) return access;
  const sandbox = await env.DB.prepare('SELECT id FROM sandboxes WHERE repo_id = ?1 AND id = ?2')
    .bind(repo.id, sandboxId)
    .first<{ id: string }>();
  if (!sandbox) return fail(404, 'sandbox not found', 'SANDBOX_NOT_FOUND');
  const rows = await env.DB.prepare(
    `SELECT * FROM sandbox_commands WHERE sandbox_id = ?1
      ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(sandboxId, Math.min(Math.max(Math.trunc(limit), 1), 100))
    .all<SandboxCommandView & { created_at: number; sandbox_id: string; approval_id: string | null; stdout_tail: string; stderr_tail: string; exit_code: number | null; duration_ms: number }>();
  return {
    ok: true,
    value: (rows.results ?? []).map((row) => ({
      id: row.id,
      sandboxId: row.sandbox_id,
      actor: row.actor,
      command: row.command,
      cwd: row.cwd,
      exitCode: row.exit_code,
      durationMs: row.duration_ms,
      stdoutTail: row.stdout_tail,
      stderrTail: row.stderr_tail,
      policy: row.policy,
      approvalId: row.approval_id,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function listSandboxApprovals(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  limit = 100,
): Promise<ServiceResult<SandboxApprovalView[]>> {
  const access = await authorized(env, repo, actor, 'read');
  if (!access.ok) return access;
  const rows = await env.DB.prepare(
    `SELECT a.*, r.owner_login AS repo_owner, r.name AS repo_name,
            s.agent_id AS agent_id, ag.name AS agent_name
       FROM sandbox_approvals a JOIN repos r ON r.id = a.repo_id
       JOIN sandboxes s ON s.id = a.sandbox_id
       LEFT JOIN agents ag ON ag.id = s.agent_id
      WHERE a.repo_id = ?1 ORDER BY a.created_at DESC LIMIT ?2`,
  )
    .bind(repo.id, Math.min(Math.max(Math.trunc(limit), 1), 200))
    .all<SandboxApprovalView & { repo_owner: string; repo_name: string; sandbox_id: string; requested_by: string; agent_id: string | null; agent_name: string | null; decided_by: string | null; decided_at: number | null; created_at: number; expires_at: number }>();
  return {
    ok: true,
    value: (rows.results ?? []).map((row) => ({
      id: row.id,
      repo: `${row.repo_owner}/${row.repo_name}`,
      sandboxId: row.sandbox_id,
      command: row.command,
      requestedBy: row.requested_by,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: iso(row.decided_at),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    })),
  };
}

export async function listMyPendingApprovals(
  env: Env,
  actor: Actor | null,
): Promise<ServiceResult<SandboxApprovalView[]>> {
  if (!actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (actor.agent) return fail(403, 'agents cannot list human approvals', 'AGENT_FORBIDDEN');
  const rows = await env.DB.prepare(
    `SELECT a.*, r.owner_login AS repo_owner, r.name AS repo_name,
            s.agent_id AS agent_id, ag.name AS agent_name
       FROM sandbox_approvals a
       JOIN sandboxes s ON s.id = a.sandbox_id
       JOIN repos r ON r.id = a.repo_id
       LEFT JOIN agents ag ON ag.id = s.agent_id
      WHERE s.owner_user_id = ?1 AND a.status = 'pending' AND a.expires_at > ?2
      ORDER BY a.created_at DESC LIMIT 100`,
  )
    .bind(actor.user.id, Date.now())
    .all<SandboxApprovalView & { repo_owner: string; repo_name: string; sandbox_id: string; requested_by: string; agent_id: string | null; agent_name: string | null; decided_by: string | null; decided_at: number | null; created_at: number; expires_at: number }>();
  return {
    ok: true,
    value: (rows.results ?? []).map((row) => ({
      id: row.id,
      repo: `${row.repo_owner}/${row.repo_name}`,
      sandboxId: row.sandbox_id,
      command: row.command,
      requestedBy: row.requested_by,
      agentId: row.agent_id,
      agentName: row.agent_name,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: iso(row.decided_at),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    })),
  };
}

export async function decideSandboxApproval(
  cx: SandboxContext,
  approvalId: string,
  decision: 'approve' | 'deny',
): Promise<ServiceResult<SandboxApprovalView>> {
  if (cx.actor?.agent) return fail(403, 'agents cannot decide sandbox approvals', 'AGENT_FORBIDDEN');
  const access = await authorized(cx.env, cx.repo, cx.actor, 'write');
  if (!access.ok) return access;
  const sandbox = await cx.env.DB.prepare(
    `SELECT s.owner_user_id FROM sandbox_approvals a
       JOIN sandboxes s ON s.id = a.sandbox_id
      WHERE a.id = ?1 AND a.repo_id = ?2`,
  )
    .bind(approvalId, cx.repo.id)
    .first<{ owner_user_id: string }>();
  if (!sandbox) return fail(404, 'pending sandbox approval not found', 'APPROVAL_NOT_FOUND');
  if (sandbox.owner_user_id !== cx.actor!.user.id) {
    const admin = await resolveRepoAccessAs(cx.env, cx.actor!, cx.repo.owner_login, cx.repo.name, 'admin');
    if (!admin.ok) return fail(403, 'only the sandbox owner or a repository admin can decide approvals', 'FORBIDDEN');
  }
  const now = Date.now();
  const status = decision === 'approve' ? 'approved' : 'denied';
  const changed = await cx.env.DB.prepare(
    `UPDATE sandbox_approvals SET status = ?3, decided_by = ?4, decided_at = ?5
      WHERE id = ?1 AND repo_id = ?2 AND status = 'pending' AND expires_at > ?5
      RETURNING id`,
  )
    .bind(approvalId, cx.repo.id, status, cx.actor!.user.id, now)
    .first<{ id: string }>();
  if (!changed) return fail(404, 'pending sandbox approval not found', 'APPROVAL_NOT_FOUND');
  const row = await cx.env.DB.prepare(
    `SELECT a.*, r.owner_login AS repo_owner, r.name AS repo_name FROM sandbox_approvals a
       JOIN repos r ON r.id = a.repo_id WHERE a.id = ?1 AND a.repo_id = ?2`,
  )
    .bind(approvalId, cx.repo.id)
    .first<SandboxApprovalView & { repo_owner: string; repo_name: string; sandbox_id: string; requested_by: string; decided_by: string | null; decided_at: number | null; created_at: number; expires_at: number }>();
  if (!row || row.status !== status) return fail(404, 'pending sandbox approval not found', 'APPROVAL_NOT_FOUND');
  return {
    ok: true,
    value: {
      id: row.id,
      repo: `${row.repo_owner}/${row.repo_name}`,
      sandboxId: row.sandbox_id,
      command: row.command,
      requestedBy: row.requested_by,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: iso(row.decided_at),
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    },
  };
}
