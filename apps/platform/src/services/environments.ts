import type { RepoRow } from '../db/repos';
import { resolveRepoAccess, resolveRepoAccessAs } from './access';
import type { Actor } from './authz';
import { isValidRefName } from './refs';
import type { ServiceResult } from '../repos/service';
import { fail, isUniqueViolation, objectBody } from './result';
import { sandboxProvider } from './sandboxes/provider';

export const DEFAULT_ENVIRONMENT_HOSTS = [
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
];

export const DEFAULT_REBUILD_PATHS = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'go.sum',
  'poetry.lock',
  'uv.lock',
  'requirements*.txt',
  'Gemfile.lock',
  '.kvarm/**',
];

const LIVE_BUILD_STATES = ['queued', 'building', 'validating'] as const;
const ENVIRONMENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const INSTANCE_TYPES = ['basic', 'standard-1', 'standard-2', 'standard-3', 'standard-4'] as const;
const MAX_LIST = 100;

export type EnvironmentBuildReason = 'create' | 'config' | 'push' | 'age' | 'manual' | 'retry';
export type EnvironmentBuildState = 'queued' | 'building' | 'validating' | 'ready' | 'failed' | 'superseded';

export interface EnvironmentRow {
  id: string;
  repo_id: string;
  name: string;
  os: string;
  base_ref: string;
  instance: string;
  setup_script: string;
  validate_script: string;
  env_vars: string;
  allowed_hosts: string;
  command_policy: string;
  rebuild_paths: string;
  max_build_age_hours: number;
  idle_minutes: number;
  config_hash: string;
  ready_build_id: string | null;
  pending: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface EnvironmentBuildRow {
  id: string;
  environment_id: string;
  repo_id: string;
  seq: number;
  status: EnvironmentBuildState;
  reason: EnvironmentBuildReason;
  base_sha: string | null;
  config_hash: string;
  snapshot_id: string | null;
  snapshot_size: number | null;
  phases: string;
  output_tail: string;
  error: string | null;
  attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface EnvironmentView {
  id: string;
  repoId: string;
  name: string;
  os: string;
  baseRef: string;
  instance: string;
  setupScript: string;
  validateScript: string;
  envVars: Record<string, string>;
  allowedHosts: string[];
  commandPolicy: { deny: string[]; approve: string[] };
  rebuildPaths: string[];
  maxBuildAgeHours: number;
  idleMinutes: number;
  configHash: string;
  readyBuildId: string | null;
  pending: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

/** A recorded build phase: a bare duration in ms, or a `{durationMs, status}` detail. */
export type BuildPhase = number | { durationMs?: number; status?: string };

export interface EnvironmentBuildView {
  id: string;
  environmentId: string;
  seq: number;
  status: EnvironmentBuildState;
  reason: EnvironmentBuildReason;
  baseSha: string | null;
  configHash: string;
  snapshotId: string | null;
  snapshotSize: number | null;
  phases: Record<string, BuildPhase>;
  outputTail: string;
  error: string | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnvironmentContext {
  env: Env;
  repo: RepoRow;
  actor: Actor | null;
}

export interface EnvironmentInput {
  name?: string;
  os?: string;
  baseRef?: string;
  instance?: string;
  setupScript?: string;
  validateScript?: string;
  envVars?: Record<string, string>;
  allowedHosts?: string[];
  commandPolicy?: { deny?: string[]; approve?: string[] };
  rebuildPaths?: string[];
  maxBuildAgeHours?: number;
  idleMinutes?: number;
}

export interface CreateEnvironmentInput extends EnvironmentInput {
  name: string;
}

export type UpdateEnvironmentInput = EnvironmentInput;

/** Non-archived environments an owner has, for the fleet overview count (fleetPages). */
export async function countEnvironmentsForOwner(env: Env, ownerLogin: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM environments e JOIN repos r ON r.id = e.repo_id
     WHERE r.owner_login = ? AND e.archived_at IS NULL`,
  ).bind(ownerLogin).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export interface EnvironmentBuildRequest {
  environmentId: string;
  buildId: string;
}


function json<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function environmentView(row: EnvironmentRow): EnvironmentView {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    os: row.os,
    baseRef: row.base_ref,
    instance: row.instance,
    setupScript: row.setup_script,
    validateScript: row.validate_script,
    envVars: json(row.env_vars, {}),
    allowedHosts: json(row.allowed_hosts, DEFAULT_ENVIRONMENT_HOSTS),
    commandPolicy: json(row.command_policy, { deny: [], approve: [] }),
    rebuildPaths: json(row.rebuild_paths, DEFAULT_REBUILD_PATHS),
    maxBuildAgeHours: row.max_build_age_hours,
    idleMinutes: row.idle_minutes,
    configHash: row.config_hash,
    readyBuildId: row.ready_build_id,
    pending: row.pending === 1,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    archivedAt: iso(row.archived_at),
  };
}

function buildView(row: EnvironmentBuildRow): EnvironmentBuildView {
  return {
    id: row.id,
    environmentId: row.environment_id,
    seq: row.seq,
    status: row.status,
    reason: row.reason,
    baseSha: row.base_sha,
    configHash: row.config_hash,
    snapshotId: row.snapshot_id,
    snapshotSize: row.snapshot_size,
    phases: json(row.phases, {}),
    outputTail: row.output_tail,
    error: row.error,
    attempt: row.attempt,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

async function authorize(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  need: 'read' | 'write' | 'admin',
): Promise<ServiceResult<true>> {
  const access = actor
    ? await resolveRepoAccessAs(env, actor, repo.owner_login, repo.name, need)
    : await resolveRepoAccess(env, {
        owner: repo.owner_login,
        name: repo.name,
        need,
        transport: 'api',
        credential: { kind: 'anonymous' },
        clientIp: null,
      });
  if (!access.ok) return fail(access.status, access.error, access.code);
  return { ok: true, value: true };
}

function baseRef(value: unknown, fallback: string): string | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') return null;
  const ref = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
  return ref.length > 0 && isValidRefName(ref) ? ref : null;
}

function parseStringArray(value: unknown, field: string, maxItems: number, maxLength: number): ServiceResult<string[]> {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > maxLength)) {
    return fail(422, `${field} must be an array of at most ${maxItems} non-empty strings of at most ${maxLength} characters`, 'INVALID_ENVIRONMENT');
  }
  return { ok: true, value: value as string[] };
}

function parseEnvVars(value: unknown): ServiceResult<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(422, 'envVars must be an object of non-secret string values', 'INVALID_ENVIRONMENT');
  }
  const entries = Object.entries(value);
  if (entries.length > 50 || entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== 'string' || item.length > 10_000)) {
    return fail(422, 'envVars must contain at most 50 valid keys with string values up to 10000 characters', 'INVALID_ENVIRONMENT');
  }
  return { ok: true, value: Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))) };
}

function parsePolicy(value: unknown): ServiceResult<{ deny: string[]; approve: string[] }> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(422, 'commandPolicy must contain deny and approve glob arrays', 'INVALID_ENVIRONMENT');
  }
  const policy = value as Record<string, unknown>;
  const deny = parseStringArray(policy.deny ?? [], 'commandPolicy.deny', 200, 500);
  if (!deny.ok) return deny;
  const approve = parseStringArray(policy.approve ?? [], 'commandPolicy.approve', 200, 500);
  if (!approve.ok) return approve;
  return { ok: true, value: { deny: deny.value, approve: approve.value } };
}

async function configHash(input: {
  os: string;
  instance: string;
  setupScript: string;
  validateScript: string;
  envVars: Record<string, string>;
  baseRef: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    os: input.os,
    instance: input.instance,
    setupScript: input.setupScript,
    validateScript: input.validateScript,
    envVars: input.envVars,
    baseRef: input.baseRef,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseConfig(
  input: unknown,
  current?: EnvironmentRow,
): ServiceResult<{
  name: string;
  os: 'linux';
  baseRef: string;
  instance: string;
  setupScript: string;
  validateScript: string;
  envVars: Record<string, string>;
  allowedHosts: string[];
  commandPolicy: { deny: string[]; approve: string[] };
  rebuildPaths: string[];
  maxBuildAgeHours: number;
  idleMinutes: number;
}> {
  const parsed = objectBody(input);
  if (!parsed.ok) return parsed;
  const body = parsed.value;
  const name = body.name === undefined ? current?.name : body.name;
  if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) {
    return fail(422, 'name must match ^[a-z][a-z0-9-]{0,62}$', 'INVALID_ENVIRONMENT');
  }
  const os = body.os === undefined ? (current?.os ?? 'linux') : body.os;
  if (os !== 'linux') return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  const base = baseRef(body.baseRef, current?.base_ref ?? 'main');
  if (!base) return fail(422, 'baseRef must be a valid branch name', 'INVALID_ENVIRONMENT');
  const instance = body.instance === undefined ? (current?.instance ?? 'standard-1') : body.instance;
  if (typeof instance !== 'string' || !(INSTANCE_TYPES as readonly string[]).includes(instance)) {
    return fail(422, 'instance must be basic or standard-1 through standard-4', 'INVALID_ENVIRONMENT');
  }
  const setupScript = body.setupScript === undefined ? (current?.setup_script ?? '') : body.setupScript;
  const validateScript = body.validateScript === undefined ? (current?.validate_script ?? '') : body.validateScript;
  if (typeof setupScript !== 'string' || setupScript.length > 10_000 || typeof validateScript !== 'string' || validateScript.length > 10_000) {
    return fail(422, 'setupScript and validateScript must be strings up to 10000 characters', 'INVALID_ENVIRONMENT');
  }
  const envVars = parseEnvVars(body.envVars === undefined ? json(current?.env_vars ?? '{}', {}) : body.envVars);
  if (!envVars.ok) return envVars;
  const allowedHosts = parseStringArray(
    body.allowedHosts === undefined ? json(current?.allowed_hosts ?? JSON.stringify(DEFAULT_ENVIRONMENT_HOSTS), DEFAULT_ENVIRONMENT_HOSTS) : body.allowedHosts,
    'allowedHosts',
    200,
    253,
  );
  if (!allowedHosts.ok) return allowedHosts;
  const commandPolicy = parsePolicy(body.commandPolicy === undefined ? json(current?.command_policy ?? '{"deny":[],"approve":[]}', { deny: [], approve: [] }) : body.commandPolicy);
  if (!commandPolicy.ok) return commandPolicy;
  const rebuildPaths = parseStringArray(
    body.rebuildPaths === undefined ? json(current?.rebuild_paths ?? JSON.stringify(DEFAULT_REBUILD_PATHS), DEFAULT_REBUILD_PATHS) : body.rebuildPaths,
    'rebuildPaths',
    200,
    500,
  );
  if (!rebuildPaths.ok) return rebuildPaths;
  const maxBuildAgeHours = body.maxBuildAgeHours === undefined ? (current?.max_build_age_hours ?? 72) : body.maxBuildAgeHours;
  const idleMinutes = body.idleMinutes === undefined ? (current?.idle_minutes ?? 30) : body.idleMinutes;
  if (typeof maxBuildAgeHours !== 'number' || !Number.isInteger(maxBuildAgeHours) || maxBuildAgeHours < 1 || maxBuildAgeHours > 600) {
    return fail(422, 'maxBuildAgeHours must be an integer between 1 and 600', 'INVALID_ENVIRONMENT');
  }
  if (typeof idleMinutes !== 'number' || !Number.isInteger(idleMinutes) || idleMinutes < 1 || idleMinutes > 360) {
    return fail(422, 'idleMinutes must be an integer between 1 and 360', 'INVALID_ENVIRONMENT');
  }
  return {
    ok: true,
    value: {
      name,
      os: 'linux',
      baseRef: base,
      instance,
      setupScript,
      validateScript,
      envVars: envVars.value,
      allowedHosts: allowedHosts.value,
      commandPolicy: commandPolicy.value,
      rebuildPaths: rebuildPaths.value,
      maxBuildAgeHours,
      idleMinutes,
    },
  };
}

async function byId(env: Env, repoId: string, id: string, activeOnly = true): Promise<EnvironmentRow | null> {
  return env.DB.prepare(`SELECT * FROM environments WHERE repo_id = ?1 AND id = ?2 ${activeOnly ? 'AND archived_at IS NULL' : ''}`)
    .bind(repoId, id)
    .first<EnvironmentRow>();
}

export async function listEnvironments(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
): Promise<ServiceResult<EnvironmentView[]>> {
  const access = await authorize(env, repo, actor, 'read');
  if (!access.ok) return access;
  const rows = await env.DB.prepare('SELECT * FROM environments WHERE repo_id = ?1 AND archived_at IS NULL ORDER BY name LIMIT ?2')
    .bind(repo.id, MAX_LIST)
    .all<EnvironmentRow>();
  return { ok: true, value: (rows.results ?? []).map(environmentView) };
}

export async function getEnvironment(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  id: string,
): Promise<ServiceResult<EnvironmentView>> {
  const access = await authorize(env, repo, actor, 'read');
  if (!access.ok) return access;
  const row = await byId(env, repo.id, id);
  if (!row) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  return { ok: true, value: environmentView(row) };
}

export async function createEnvironment(
  cx: EnvironmentContext,
  input: CreateEnvironmentInput,
): Promise<ServiceResult<{ environment: EnvironmentView; build: EnvironmentBuildView }>> {
  if (!cx.actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (cx.actor.agent) return fail(403, 'agent credentials cannot manage environments', 'AGENT_FORBIDDEN');
  const access = await authorize(cx.env, cx.repo, cx.actor, 'admin');
  if (!access.ok) return access;
  const createInput =
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    !Object.prototype.hasOwnProperty.call(input, 'baseRef')
      ? { ...input, baseRef: cx.repo.default_branch }
      : input;
  const parsed = parseConfig(createInput);
  if (!parsed.ok) return parsed;
  const values = parsed.value;
  const hash = await configHash({
    os: values.os,
    instance: values.instance,
    setupScript: values.setupScript,
    validateScript: values.validateScript,
    envVars: values.envVars,
    baseRef: values.baseRef,
  });
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await cx.env.DB.prepare(
      `INSERT INTO environments
       (id, repo_id, name, os, base_ref, instance, setup_script, validate_script, env_vars, allowed_hosts,
        command_policy, rebuild_paths, max_build_age_hours, idle_minutes, config_hash, created_by, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`,
    )
      .bind(
        id,
        cx.repo.id,
        values.name,
        values.os,
        values.baseRef,
        values.instance,
        values.setupScript,
        values.validateScript,
        JSON.stringify(values.envVars),
        JSON.stringify(values.allowedHosts),
        JSON.stringify(values.commandPolicy),
        JSON.stringify(values.rebuildPaths),
        values.maxBuildAgeHours,
        values.idleMinutes,
        hash,
        cx.actor.user.id,
        now,
      )
      .run();
  } catch (error) {
    if (isUniqueViolation(error, 'environments.repo_id, environments.name')) return fail(409, 'an environment with that name already exists', 'ENVIRONMENT_NAME_TAKEN');
    throw error;
  }
  const build = await requestEnvironmentBuild(cx.env, id, 'create');
  if (!build.ok) return build;
  const row = await byId(cx.env, cx.repo.id, id);
  if (!row) return fail(500, 'environment could not be read after creation', 'ENVIRONMENT_CREATE_FAILED');
  return { ok: true, value: { environment: environmentView(row), build: build.value } };
}

export async function updateEnvironment(
  cx: EnvironmentContext,
  id: string,
  input: UpdateEnvironmentInput,
): Promise<ServiceResult<{ environment: EnvironmentView; build: EnvironmentBuildView | null }>> {
  if (!cx.actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (cx.actor.agent) return fail(403, 'agent credentials cannot manage environments', 'AGENT_FORBIDDEN');
  const access = await authorize(cx.env, cx.repo, cx.actor, 'admin');
  if (!access.ok) return access;
  const current = await byId(cx.env, cx.repo.id, id);
  if (!current) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  const parsed = parseConfig(input, current);
  if (!parsed.ok) return parsed;
  const values = parsed.value;
  const hash = await configHash({
    os: values.os,
    instance: values.instance,
    setupScript: values.setupScript,
    validateScript: values.validateScript,
    envVars: values.envVars,
    baseRef: values.baseRef,
  });
  const now = Date.now();
  await cx.env.DB.prepare(
    `UPDATE environments SET name = ?3, os = ?4, base_ref = ?5, instance = ?6, setup_script = ?7, validate_script = ?8,
      env_vars = ?9, allowed_hosts = ?10, command_policy = ?11, rebuild_paths = ?12, max_build_age_hours = ?13,
      idle_minutes = ?14, config_hash = ?15, updated_at = ?16
     WHERE repo_id = ?1 AND id = ?2 AND archived_at IS NULL`,
  )
    .bind(
      cx.repo.id,
      id,
      values.name,
      values.os,
      values.baseRef,
      values.instance,
      values.setupScript,
      values.validateScript,
      JSON.stringify(values.envVars),
      JSON.stringify(values.allowedHosts),
      JSON.stringify(values.commandPolicy),
      JSON.stringify(values.rebuildPaths),
      values.maxBuildAgeHours,
      values.idleMinutes,
      hash,
      now,
    )
    .run();
  let build: EnvironmentBuildView | null = null;
  if (hash !== current.config_hash) {
    const requested = await requestEnvironmentBuild(cx.env, id, 'config');
    if (!requested.ok) return requested;
    build = requested.value;
  }
  const row = await byId(cx.env, cx.repo.id, id);
  if (!row) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  return { ok: true, value: { environment: environmentView(row), build } };
}

export async function archiveEnvironment(
  cx: EnvironmentContext,
  id: string,
): Promise<ServiceResult<{ archived: true }>> {
  if (!cx.actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (cx.actor.agent) return fail(403, 'agent credentials cannot manage environments', 'AGENT_FORBIDDEN');
  const access = await authorize(cx.env, cx.repo, cx.actor, 'admin');
  if (!access.ok) return access;
  const result = await cx.env.DB.prepare(
    'UPDATE environments SET archived_at = ?3, updated_at = ?3 WHERE repo_id = ?1 AND id = ?2 AND archived_at IS NULL',
  )
    .bind(cx.repo.id, id, Date.now())
    .run();
  if ((result.meta?.changes ?? 0) === 0) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  return { ok: true, value: { archived: true } };
}

export async function requestEnvironmentBuild(
  env: Env,
  environmentId: string,
  reason: EnvironmentBuildReason,
): Promise<ServiceResult<EnvironmentBuildView>> {
  const environment = await env.DB.prepare('SELECT * FROM environments WHERE id = ?1 AND archived_at IS NULL')
    .bind(environmentId)
    .first<EnvironmentRow>();
  if (!environment) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  const provider = sandboxProvider(environment.os);
  if (!provider) return fail(422, 'only Linux sandboxes are available on Cloudflare', 'OS_UNAVAILABLE');
  const id = crypto.randomUUID();
  const now = Date.now();
  const inserted = await env.DB.prepare(
    `INSERT INTO environment_builds
       (id, environment_id, repo_id, seq, status, reason, config_hash, created_at)
     SELECT ?1, e.id, e.repo_id,
       COALESCE((SELECT MAX(seq) + 1 FROM environment_builds WHERE environment_id = e.id), 1),
       'queued', ?2, e.config_hash, ?3
      FROM environments e
     WHERE e.id = ?4 AND e.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM environment_builds b WHERE b.environment_id = e.id AND b.status IN ('queued','building','validating'))
     ON CONFLICT DO NOTHING`,
  )
    .bind(id, reason, now, environmentId)
    .run();
  if ((inserted.meta?.changes ?? 0) === 1) {
    if (reason === 'retry') {
      const previous = await env.DB.prepare(
        'SELECT attempt FROM environment_builds WHERE environment_id = ?1 AND id <> ?2 ORDER BY seq DESC LIMIT 1',
      )
        .bind(environmentId, id)
        .first<{ attempt: number }>();
      await env.DB.prepare('UPDATE environment_builds SET attempt = ?2 WHERE id = ?1')
        .bind(id, (previous?.attempt ?? 0) + 1)
        .run();
    }
    try {
      await provider.startEnvironmentBuild(env, id, { environmentId, buildId: id });
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error).slice(0, 300);
      await env.DB.prepare(
        "UPDATE environment_builds SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1 AND status = 'queued'",
      )
        .bind(id, `build workflow could not start: ${message}`, Date.now())
        .run();
      return fail(503, 'environment build could not be started', 'BUILD_START_FAILED');
    }
  } else {
    await env.DB.prepare(
      `UPDATE environments SET pending = 1, updated_at = ?2
        WHERE id = ?1 AND archived_at IS NULL
          AND EXISTS (SELECT 1 FROM environment_builds b WHERE b.environment_id = ?1 AND b.status IN ('queued','building','validating'))`,
    )
      .bind(environmentId, Date.now())
      .run();
  }
  const row = await env.DB.prepare(
    `SELECT * FROM environment_builds WHERE environment_id = ?1
      ORDER BY CASE WHEN status IN ('queued','building','validating') THEN 0 ELSE 1 END, seq DESC LIMIT 1`,
  )
    .bind(environmentId)
    .first<EnvironmentBuildRow>();
  if (!row) return fail(409, 'environment build was not queued', 'BUILD_NOT_QUEUED');
  return { ok: true, value: buildView(row) };
}

export async function rebuildEnvironment(
  cx: EnvironmentContext,
  id: string,
): Promise<ServiceResult<EnvironmentBuildView>> {
  if (!cx.actor) return fail(401, 'authentication required', 'UNAUTHENTICATED');
  if (cx.actor.agent) return fail(403, 'agents cannot request environment rebuilds', 'AGENT_FORBIDDEN');
  const access = await authorize(cx.env, cx.repo, cx.actor, 'admin');
  if (!access.ok) return access;
  if (!(await byId(cx.env, cx.repo.id, id))) return fail(404, 'environment not found', 'ENVIRONMENT_NOT_FOUND');
  return requestEnvironmentBuild(cx.env, id, 'manual');
}

export async function listEnvironmentBuilds(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  environmentId: string,
  limit = 50,
): Promise<ServiceResult<EnvironmentBuildView[]>> {
  const environment = await getEnvironment(env, repo, actor, environmentId);
  if (!environment.ok) return environment;
  const rows = await env.DB.prepare('SELECT * FROM environment_builds WHERE environment_id = ?1 ORDER BY seq DESC LIMIT ?2')
    .bind(environmentId, Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST))
    .all<EnvironmentBuildRow>();
  return { ok: true, value: (rows.results ?? []).map(buildView) };
}

export async function getEnvironmentBuild(
  env: Env,
  repo: RepoRow,
  actor: Actor | null,
  environmentId: string,
  buildId: string,
): Promise<ServiceResult<EnvironmentBuildView>> {
  const environment = await getEnvironment(env, repo, actor, environmentId);
  if (!environment.ok) return environment;
  const row = await env.DB.prepare('SELECT * FROM environment_builds WHERE environment_id = ?1 AND id = ?2')
    .bind(environmentId, buildId)
    .first<EnvironmentBuildRow>();
  if (!row) return fail(404, 'environment build not found', 'BUILD_NOT_FOUND');
  return { ok: true, value: buildView(row) };
}

export function environmentNameValid(name: string): boolean {
  return ENVIRONMENT_NAME.test(name);
}

export function configHashForEnvironment(row: EnvironmentRow): Promise<string> {
  return configHash({
    os: row.os,
    instance: row.instance,
    setupScript: row.setup_script,
    validateScript: row.validate_script,
    envVars: json(row.env_vars, {}),
    baseRef: row.base_ref,
  });
}

export function liveBuildStates(): readonly EnvironmentBuildState[] {
  return LIVE_BUILD_STATES;
}
