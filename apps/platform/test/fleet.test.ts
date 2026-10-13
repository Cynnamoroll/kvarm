import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import type { RepoRow } from '../src/db/repos';
import type { Actor } from '../src/services/authz';
import {
  createEnvironment,
  archiveEnvironment,
  getEnvironment,
  listEnvironments,
  nextScheduledBuild,
  requestEnvironmentBuild,
  updateEnvironment,
  type EnvironmentContext,
  type EnvironmentRow,
} from '../src/services/environments';
import {
  decideSandboxApproval,
  execSandbox,
  listMyPendingApprovals,
  listMySandboxes,
  startSandbox,
  stopSandbox,
  type SandboxContext,
} from '../src/services/sandboxes';
import { SANDBOX_PROVIDERS, type SandboxProvider } from '../src/services/sandboxes/provider';
import { promoteBuild } from '../src/workflows/environmentBuild';
import { getRepoById } from '../src/db/repos';
import worker from '../src/index';
import { environmentBuildEffect } from '../src/services/events';

const baseEnv = cfEnv as unknown as Env;
const OWNER = 'fleet-owner';
const scopes: Scope[] = ['read', 'write', 'api'];

class FakeWorkflow {
  created: string[] = [];
  async create(options: { id: string }) {
    this.created.push(options.id);
    return { id: options.id };
  }
}

let env: Env;
let owner: Actor;
let writer: Actor;
let outsider: Actor;
let ownerId = '';
let writerId = '';
let repo: RepoRow;
let startResponse: unknown;
const starts: Array<{ sandboxId: string; tokenId: string; refs: string[] }> = [];
let oldLinux: SandboxProvider;

const human = (user: Actor['user']): Actor => ({ user, via: 'session', scopes: null });

async function seedUser(login: string): Promise<Actor['user']> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `fleet:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return (await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<Actor['user']>())!;
}

async function seedRepo(name = 'fleet'): Promise<RepoRow> {
  const id = crypto.randomUUID();
  const artifactsName = `${OWNER}--${name}`;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return (await getRepoById(env.DB, id))!;
}

async function seedAgent(actor: Actor, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at)
     VALUES (?, 'user', ?, ?, ?, ?, ?)`,
  )
    .bind(id, actor.user.id, actor.user.login, name, actor.user.id, Date.now())
    .run();
  return id;
}

async function seedEnvironment(options: { ready?: boolean; policy?: string } = {}) {
  const id = crypto.randomUUID();
  const buildId = options.ready ? crypto.randomUUID() : null;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO environments
      (id, repo_id, name, os, base_ref, instance, allowed_hosts, command_policy, config_hash,
       ready_build_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'linux', 'main', 'standard-1', '["registry.npmjs.org"]', ?, 'config', ?, ?, ?, ?)`,
  )
    .bind(id, repo.id, `env-${id.slice(0, 8)}`, options.policy ?? '{"deny":[],"approve":[]}', buildId, ownerId, now, now)
    .run();
  if (buildId) {
    await env.DB.prepare(
      `INSERT INTO environment_builds
        (id, environment_id, repo_id, seq, status, reason, config_hash, snapshot_id, phases, output_tail, created_at, finished_at)
       VALUES (?, ?, ?, 1, 'ready', 'create', 'config', 'build-snapshot', '{}', '', ?, ?)`,
    )
      .bind(buildId, id, repo.id, now, now)
      .run();
  }
  return { id, buildId };
}

async function seedWorkspace(agentId: string, createdBy = ownerId) {
  const id = crypto.randomUUID();
  const ref = `refs/heads/agents/${id}/fleet`;
  await env.DB.prepare(
    `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, created_at, ref, created_by, agent_id)
     VALUES (?, ?, ?, 'fleet test', 'agent', 'active', ?, ?, ?, ?)`,
  )
    .bind(id, repo.id, repo.artifacts_name, Date.now(), ref, createdBy, agentId)
    .run();
  return { id, ref };
}

async function seedSandbox(options: {
  agentId: string;
  environmentId: string;
  buildId: string;
  workspaceId: string;
  owner?: string;
  status?: 'running' | 'sleeping';
  tokenId?: string | null;
  expiresAt?: number;
}) {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sandboxes
      (id, repo_id, environment_id, build_id, workspace_id, owner_user_id, agent_id, token_id, status,
       task, last_active_at, expires_at, run_expires_at, sleep_snapshot_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'task', ?, ?, ?, ?, ?)`,
  )
    .bind(
      id, repo.id, options.environmentId, options.buildId, options.workspaceId, options.owner ?? ownerId,
      options.agentId, options.tokenId ?? null, options.status ?? 'running', now,
      options.expiresAt ?? now + 25 * 86400_000, now + 86400_000,
      options.status === 'sleeping' ? 'sleep-snapshot' : null, now,
    )
    .run();
  return id;
}

function sandboxContext(actor: Actor, waitUntil: SandboxContext['waitUntil'] = () => undefined): SandboxContext {
  return { env, repo, actor, origin: 'https://kvarm.test', waitUntil };
}

function environmentBuilder(environmentId: string) {
  const stub = env.ENV_BUILDER.getByName(environmentId);
  return {
    stub,
    builder: stub as unknown as { schedule(id: string): Promise<void> },
  };
}

async function builderAlarm(environmentId: string): Promise<number | null> {
  const { stub } = environmentBuilder(environmentId);
  return runInDurableObject(stub, async (_instance, state) => state.storage.getAlarm());
}

beforeAll(async () => {
  const workflow = new FakeWorkflow();
  env = { ...baseEnv, ENVIRONMENT_BUILD: workflow as unknown as Env['ENVIRONMENT_BUILD'] } as Env;
  const ownerUser = await seedUser(OWNER);
  const writerUser = await seedUser('fleet-writer');
  const outsiderUser = await seedUser('fleet-outsider');
  ownerId = ownerUser.id;
  writerId = writerUser.id;
  owner = human(ownerUser);
  writer = human(writerUser);
  outsider = human(outsiderUser);
  repo = await seedRepo();
  await env.DB.prepare(
    `INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at)
     VALUES (?, ?, 'write', ?, ?, ?)`,
  )
    .bind(repo.id, writerId, ownerId, Date.now(), Date.now())
    .run();
  oldLinux = SANDBOX_PROVIDERS.linux!;
  SANDBOX_PROVIDERS.linux = {
    ...oldLinux,
    startEnvironmentBuild: async (boundEnv, buildId) => {
      if (boundEnv === env) {
        await (boundEnv.ENVIRONMENT_BUILD as unknown as FakeWorkflow).create({ id: buildId });
      }
    },
    agentSandbox: (boundEnv, sandboxId) => ({
      start: async (request) => {
        starts.push({ sandboxId, tokenId: request.tokenId, refs: JSON.parse(
          await boundEnv.DB.prepare('SELECT refs FROM agent_tokens WHERE id = ?').bind(request.tokenId).first<{ refs: string }>().then((row) => row?.refs ?? '[]'),
        ) as string[] });
        return startResponse;
      },
      sleep: async () => {
        const row = await boundEnv.DB.prepare('SELECT token_id FROM sandboxes WHERE id = ?').bind(sandboxId).first<{ token_id: string | null }>();
        await boundEnv.DB.batch([
          boundEnv.DB.prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(row?.token_id, Date.now()),
          boundEnv.DB.prepare("UPDATE sandboxes SET status = 'sleeping', token_id = NULL, sleep_snapshot_id = 'sleep-snapshot' WHERE id = ?1").bind(sandboxId),
        ]);
        return { ok: true, value: { sleeping: true, snapshotId: 'sleep-snapshot' } };
      },
      discard: async () => {
        const row = await boundEnv.DB.prepare('SELECT token_id FROM sandboxes WHERE id = ?').bind(sandboxId).first<{ token_id: string | null }>();
        await boundEnv.DB.batch([
          boundEnv.DB.prepare("UPDATE agent_tokens SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL").bind(row?.token_id, Date.now()),
          boundEnv.DB.prepare("UPDATE sandboxes SET status = 'stopped', token_id = NULL, sleep_snapshot_id = NULL WHERE id = ?1").bind(sandboxId),
        ]);
        return { ok: true, value: { stopped: true } };
      },
      exec: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      readFile: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      writeFile: async () => ({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' }),
      egressCredential: async () => null,
    }),
  };
  startResponse = { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' };
});

afterAll(() => {
  SANDBOX_PROVIDERS.linux = oldLinux;
});

describe('nextScheduledBuild', () => {
  const environment = { archived_at: null, max_build_age_hours: 12 } as EnvironmentRow;
  const finish = 1_000_000;

  it.each([
    {
      name: 'ignores an in-flight build',
      environment,
      ready: { created_at: finish },
      latest: { status: 'validating', attempt: 1, finished_at: null },
      expected: null,
    },
    {
      name: 'retries attempt one after two hours',
      environment,
      ready: null,
      latest: { status: 'failed', attempt: 1, finished_at: finish },
      expected: { at: finish + 2 * 3_600_000, reason: 'retry' },
    },
    {
      name: 'retries attempt five after twenty-four hours',
      environment,
      ready: null,
      latest: { status: 'failed', attempt: 5, finished_at: finish },
      expected: { at: finish + 24 * 3_600_000, reason: 'retry' },
    },
    {
      name: 'ages a ready build after the configured maximum',
      environment,
      ready: { created_at: finish },
      latest: null,
      expected: { at: finish + 12 * 3_600_000, reason: 'age' },
    },
    {
      name: 'uses failed-build retry backoff instead of the stale ready build age',
      environment,
      ready: { created_at: finish - 20 * 3_600_000 },
      latest: { status: 'failed', attempt: 1, finished_at: finish },
      expected: { at: finish + 2 * 3_600_000, reason: 'retry' },
    },
    {
      name: 'does not schedule archived environments',
      environment: { ...environment, archived_at: finish } as EnvironmentRow,
      ready: { created_at: finish },
      latest: null,
      expected: null,
    },
  ])('$name', async ({ environment: row, ready, latest, expected }) => {
    expect(nextScheduledBuild(row, ready, latest as Parameters<typeof nextScheduledBuild>[2])).toEqual(expected);
  });
});

describe('Durable Object alarm backoff', () => {
  it('re-arms the first failure after sixty seconds and clears failures after success', async () => {
    const { withAlarmBackoff } = await import('../src/containers/alarmBackoff');
    const now = 1_000_000;
    const values = new Map<string, unknown>();
    let alarmAt: number | null = null;
    const storage = {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
      delete: async (key: string) => values.delete(key),
      setAlarm: async (at: number) => {
        alarmAt = at;
      },
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await withAlarmBackoff(storage as never, 'test', async () => {
        throw new Error('failed');
      });
      expect(alarmAt).toBe(now + 60_000);
      expect([...values.values()]).toContain(1);
      expect(JSON.parse(warning.mock.calls[0]?.[0] ?? '{}')).toMatchObject({ error: expect.any(String) });
      await withAlarmBackoff(storage as never, 'test', async () => undefined);
      expect(values.size).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('fleet services', () => {
  it('authorizes environment CRUD, rejects non-Linux, and keeps read costs bounded', async () => {
    const cx: EnvironmentContext = { env, repo, actor: owner };
    const created = await createEnvironment(cx, { name: `env-${crypto.randomUUID().slice(0, 8)}` });
    expect(created.ok).toBe(true);
    if (created.ok) {
      const detail = await getEnvironment(env, repo, owner, created.value.environment.id);
      expect(detail).toMatchObject({ ok: true, value: { nextBuildAt: null, nextBuildReason: null } });
      expect(await getEnvironment(env, { ...repo, id: crypto.randomUUID() }, owner, created.value.environment.id)).toMatchObject({
        ok: false,
        status: 404,
        code: 'ENVIRONMENT_NOT_FOUND',
      });
    }
    expect((await createEnvironment({ ...cx, actor: writer }, { name: 'writer-env' })).ok).toBe(false);
    const agentId = await seedAgent(owner, `agent-${crypto.randomUUID()}`);
    const agent: Actor = { ...owner, agent: { agentId, agentName: 'fleet-agent', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const forbidden = await createEnvironment({ ...cx, actor: agent }, { name: 'agent-env' });
    expect(forbidden).toMatchObject({ ok: false, status: 403, code: 'AGENT_FORBIDDEN' });
    expect(await createEnvironment(cx, { name: 'bad-os', os: 'macos' })).toMatchObject({ ok: false, status: 422, code: 'OS_UNAVAILABLE' });
    expect((await createEnvironment({ ...cx, actor: outsider }, { name: 'outsider-env' })).ok).toBe(false);
    expect(await listEnvironments(env, repo, writer)).toMatchObject({ ok: true });
    const pat = (await mintPAT(env, ownerId, 'fleet-cost', scopes)).token;
    const response = await worker.fetch(
      new Request(`https://kvarm.test/api/v1/repos/${OWNER}/fleet/environments`, {
        headers: { Authorization: `Bearer ${pat}` },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.headers.get('x-kvarm-cost')).toBeTruthy();
  });

  it('keeps environment mutations successful when schedule arming fails', async () => {
    const provider = SANDBOX_PROVIDERS.linux!;
    let failWorkflow = false;
    SANDBOX_PROVIDERS.linux = {
      ...provider,
      startEnvironmentBuild: async (environment, buildId, params) => {
        if (failWorkflow) throw new Error('workflow unavailable');
        await provider.startEnvironmentBuild(environment, buildId, params);
      },
      environmentBuilder: () => ({
        build: async () => null,
        schedule: async () => {
          throw new Error('schedule unavailable');
        },
      }),
    };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const environment = await seedEnvironment({ ready: true });
      expect(
        await updateEnvironment({ env, repo, actor: owner }, environment.id, { maxBuildAgeHours: 3 }),
      ).toMatchObject({ ok: true });
      expect(await archiveEnvironment({ env, repo, actor: owner }, environment.id)).toMatchObject({ ok: true });

      const startFailure = await seedEnvironment();
      failWorkflow = true;
      expect(await requestEnvironmentBuild(env, startFailure.id, 'manual')).toMatchObject({
        ok: false,
        code: 'BUILD_START_FAILED',
      });
      expect(warning).toHaveBeenCalledTimes(3);
      expect(JSON.parse(warning.mock.calls[0]?.[0] ?? '{}')).toMatchObject({
        environmentSchedule: environment.id,
        error: 'schedule unavailable',
      });
    } finally {
      SANDBOX_PROVIDERS.linux = provider;
      warning.mockRestore();
    }
  });

  it('coalesces builds and supersedes the previous ready build on promotion', async () => {
    const { id: environmentId } = await seedEnvironment();
    const first = await requestEnvironmentBuild(env, environmentId, 'manual');
    const second = await requestEnvironmentBuild(env, environmentId, 'push');
    expect(first.ok && second.ok && first.value.id).toBe(second.ok ? second.value.id : '');
    expect((await env.DB.prepare('SELECT pending FROM environments WHERE id = ?').bind(environmentId).first<{ pending: number }>())?.pending).toBe(1);
    await env.DB.prepare("UPDATE environment_builds SET status = 'superseded' WHERE id = ?").bind(first.ok ? first.value.id : '').run();
    const oldId = crypto.randomUUID();
    const buildId = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(`INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, phases, output_tail, created_at) VALUES (?, ?, ?, 5, 'ready', 'create', 'config', '{}', '', ?)`).bind(oldId, environmentId, repo.id, now).run();
    await env.DB.prepare(`INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, phases, output_tail, created_at) VALUES (?, ?, ?, 6, 'building', 'manual', 'config', '{}', '', ?)`).bind(buildId, environmentId, repo.id, now).run();
    const build = await env.DB.prepare('SELECT * FROM environment_builds WHERE id = ?').bind(buildId).first<any>();
    expect(await promoteBuild(env, build, { id: 'snapshot-new', size: 9 }, {}, '')).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM environment_builds WHERE id = ?').bind(oldId).first()).toMatchObject({ status: 'superseded' });
    expect(await env.DB.prepare('SELECT ready_build_id FROM environments WHERE id = ?').bind(environmentId).first()).toMatchObject({ ready_build_id: buildId });
    const { builder } = environmentBuilder(environmentId);
    await builder.schedule(environmentId);
    const age = await env.DB.prepare(
      `SELECT b.created_at + e.max_build_age_hours * 3600000 AS at
         FROM environment_builds b JOIN environments e ON e.ready_build_id = b.id WHERE b.id = ?`,
    )
      .bind(buildId)
      .first<{ at: number }>();
    expect(await builderAlarm(environmentId)).toBe(age?.at);
  });

  it('schedules failed-build retries and removes alarms after archive', async () => {
    const retry = await seedEnvironment({ ready: true });
    const finishedAt = Date.now() - 60_000;
    await env.DB.prepare(
      `INSERT INTO environment_builds
        (id, environment_id, repo_id, seq, status, reason, config_hash, attempt, phases, output_tail, created_at, finished_at)
       VALUES (?, ?, ?, 2, 'failed', 'age', 'config', 1, '{}', '', ?, ?)`,
    )
      .bind(crypto.randomUUID(), retry.id, repo.id, finishedAt, finishedAt)
      .run();
    const { builder } = environmentBuilder(retry.id);
    await builder.schedule(retry.id);
    expect(await builderAlarm(retry.id)).toBe(finishedAt + 2 * 3_600_000);

    const archived = await seedEnvironment({ ready: true });
    const archiveBuilder = environmentBuilder(archived.id);
    await archiveBuilder.builder.schedule(archived.id);
    expect(await builderAlarm(archived.id)).not.toBeNull();
    expect(await archiveEnvironment({ env, repo, actor: owner }, archived.id)).toMatchObject({ ok: true });
    expect(await builderAlarm(archived.id)).toBeNull();
  });

  it('reschedules the age alarm when max build age changes', async () => {
    const environment = await seedEnvironment({ ready: true });
    const createdAt = Date.now();
    await env.DB.prepare('UPDATE environment_builds SET created_at = ? WHERE id = ?').bind(createdAt, environment.buildId).run();
    const updated = await updateEnvironment({ env, repo, actor: owner }, environment.id, { maxBuildAgeHours: 1 });
    expect(updated.ok).toBe(true);
    expect(await builderAlarm(environment.id)).toBe(createdAt + 3_600_000);
  });

  it('fires a due age alarm to queue a build and re-arms an early alarm', async () => {
    const due = await seedEnvironment({ ready: true });
    const oldCreatedAt = Date.now() - 3_600_000 + 60_000;
    await env.DB.batch([
      env.DB.prepare('UPDATE environments SET max_build_age_hours = 1 WHERE id = ?').bind(due.id),
      env.DB.prepare('UPDATE environment_builds SET created_at = ? WHERE id = ?').bind(oldCreatedAt, due.buildId),
    ]);
    expect(
      await env.DB.prepare('SELECT created_at FROM environment_builds WHERE id = ?').bind(due.buildId).first(),
    ).toEqual({ created_at: oldCreatedAt });
    const dueBuilder = environmentBuilder(due.id);
    await dueBuilder.builder.schedule(due.id);
    const dueAt = oldCreatedAt + 3_600_000;
    expect(await builderAlarm(due.id)).toBe(dueAt);
    vi.spyOn(Date, 'now').mockReturnValue(dueAt + 1);
    try {
      expect(await runDurableObjectAlarm(dueBuilder.stub)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(
      await env.DB.prepare("SELECT status, reason, attempt FROM environment_builds WHERE environment_id = ? ORDER BY seq DESC LIMIT 1")
        .bind(due.id)
        .first(),
    ).toMatchObject({ status: 'queued', reason: 'age', attempt: 0 });

    const early = await seedEnvironment({ ready: true });
    const earlyBuilder = environmentBuilder(early.id);
    await earlyBuilder.builder.schedule(early.id);
    const future = await builderAlarm(early.id);
    expect(future).toBeGreaterThan(Date.now());
    expect(await runDurableObjectAlarm(earlyBuilder.stub)).toBe(true);
    expect(await builderAlarm(early.id)).toBe(future);
  });

  it('fires a due retry alarm with an incremented attempt', async () => {
    const environment = await seedEnvironment();
    const finishedAt = Date.now() - 2 * 3_600_000 + 60_000;
    await env.DB.prepare(
      `INSERT INTO environment_builds
        (id, environment_id, repo_id, seq, status, reason, config_hash, attempt, phases, output_tail, created_at, finished_at)
       VALUES (?, ?, ?, 1, 'failed', 'age', 'config', 1, '{}', '', ?, ?)`,
    )
      .bind(crypto.randomUUID(), environment.id, repo.id, finishedAt, finishedAt)
      .run();
    const builder = environmentBuilder(environment.id);
    await builder.builder.schedule(environment.id);
    const retryAt = finishedAt + 2 * 3_600_000;
    expect(await builderAlarm(environment.id)).toBe(retryAt);
    vi.spyOn(Date, 'now').mockReturnValue(retryAt + 1);
    try {
      expect(await runDurableObjectAlarm(builder.stub)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
    expect(
      await env.DB.prepare("SELECT status, reason, attempt FROM environment_builds WHERE environment_id = ? ORDER BY seq DESC LIMIT 1")
        .bind(environment.id)
        .first(),
    ).toMatchObject({ status: 'queued', reason: 'retry', attempt: 2 });
  });

  it('does not rebuild a stale ready environment before the failed-build retry time', async () => {
    const environment = await seedEnvironment({ ready: true });
    const readyCreatedAt = Date.now() - 2 * 3_600_000;
    const finishedAt = Date.now() - 10 * 60_000;
    await env.DB.batch([
      env.DB.prepare('UPDATE environments SET max_build_age_hours = 1 WHERE id = ?').bind(environment.id),
      env.DB.prepare('UPDATE environment_builds SET created_at = ? WHERE id = ?').bind(readyCreatedAt, environment.buildId),
      env.DB.prepare(
        `INSERT INTO environment_builds
          (id, environment_id, repo_id, seq, status, reason, config_hash, attempt, phases, output_tail, created_at, finished_at)
         VALUES (?, ?, ?, 2, 'failed', 'age', 'config', 1, '{}', '', ?, ?)`,
      ).bind(crypto.randomUUID(), environment.id, repo.id, finishedAt, finishedAt),
    ]);
    const builder = environmentBuilder(environment.id);
    await builder.builder.schedule(environment.id);
    const retryAt = finishedAt + 2 * 3_600_000;
    expect(await builderAlarm(environment.id)).toBe(retryAt);
    expect(await runDurableObjectAlarm(builder.stub)).toBe(true);
    expect(
      await env.DB.prepare('SELECT status FROM environment_builds WHERE environment_id = ? ORDER BY seq DESC LIMIT 1')
        .bind(environment.id)
        .first(),
    ).toMatchObject({ status: 'failed' });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM environment_builds WHERE environment_id = ?')
        .bind(environment.id)
        .first(),
    ).toMatchObject({ count: 2 });
    expect(await builderAlarm(environment.id)).toBe(retryAt);
  });

  it('requests push builds only when rebuild paths are touched', async () => {
    const workflow = env.ENVIRONMENT_BUILD as unknown as FakeWorkflow;
    const previousRepo = repo;
    repo = await seedRepo('fleet-push');
    try {
    const { id: environmentId } = await seedEnvironment();
    const initialBuildRequests = workflow.created.length;
    const unchanged = {
      env,
      repoId: repo.id,
      event: { ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'a'.repeat(40) },
    } as Parameters<typeof environmentBuildEffect.run>[0];
    expect((await environmentBuildEffect.run(unchanged)).state).toBe('skipped');
    expect(workflow.created).toHaveLength(initialBuildRequests);
    await env.DB.prepare('UPDATE environments SET rebuild_paths = ?2 WHERE id = ?1')
      .bind(environmentId, '["package-lock.json"]')
      .run();
    const truncatedDiff = {
      ...unchanged,
      event: { ...unchanged.event, before: 'a'.repeat(40), after: '0'.repeat(40) },
    } as Parameters<typeof environmentBuildEffect.run>[0];
    expect(await environmentBuildEffect.run(truncatedDiff)).toMatchObject({ state: 'done' });
    expect(workflow.created).toHaveLength(initialBuildRequests + 1);
    } finally {
      repo = previousRepo;
    }
  });

  it('starts only from a ready build and cleans up the scoped token on container failure', async () => {
    const notReady = await seedEnvironment();
    expect(await startSandbox(sandboxContext(owner), { environment: notReady.id })).toMatchObject({ ok: false, status: 409, code: 'ENVIRONMENT_NOT_READY' });
    const agentId = await seedAgent(owner, `start-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'start', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const ready = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    starts.length = 0;
    startResponse = { ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE', error: 'container unavailable' };
    const result = await startSandbox(sandboxContext(actor), { environment: ready.id, workspace: workspace.id });
    expect(result).toMatchObject({ ok: false, status: 503, code: 'CONTAINER_UNAVAILABLE' });
    expect(starts[0]?.refs).toEqual([workspace.ref]);
    const row = await env.DB.prepare('SELECT status, token_id, workspace_id FROM sandboxes WHERE id = ?').bind(starts[0]?.sandboxId).first<any>();
    expect(row).toMatchObject({ status: 'failed', token_id: null, workspace_id: workspace.id });
    expect(await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').bind(starts[0]?.tokenId).first<{ revoked_at: number }>()).toMatchObject({ revoked_at: expect.any(Number) });
  });

  it('queues an age build for a stale ready environment and still starts the sandbox', async () => {
    const agentId = await seedAgent(owner, `stale-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'stale', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const ready = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    await env.DB.batch([
      env.DB.prepare('UPDATE environments SET max_build_age_hours = 1 WHERE id = ?').bind(ready.id),
      env.DB.prepare('UPDATE environment_builds SET created_at = ? WHERE id = ?').bind(Date.now() - 2 * 3_600_000, ready.buildId),
    ]);
    startResponse = { ok: true, value: { started: true, localDiverged: false } };
    const pending: Promise<unknown>[] = [];
    const result = await startSandbox(sandboxContext(actor, (promise) => pending.push(promise)), {
      environment: ready.id,
      workspace: workspace.id,
    });
    await Promise.all(pending);
    expect(result).toMatchObject({ ok: true });
    expect(
      await env.DB.prepare("SELECT status, reason FROM environment_builds WHERE environment_id = ? ORDER BY seq DESC LIMIT 1")
        .bind(ready.id)
        .first(),
    ).toMatchObject({ status: 'queued', reason: 'age' });
  });

  it('does not queue an age build for a stale ready environment still in retry backoff', async () => {
    const agentId = await seedAgent(owner, `retry-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'retry', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const readyCreatedAt = Date.now() - 2 * 3_600_000;
    const finishedAt = Date.now() - 10 * 60_000;
    await env.DB.batch([
      env.DB.prepare('UPDATE environments SET max_build_age_hours = 1 WHERE id = ?').bind(environment.id),
      env.DB.prepare('UPDATE environment_builds SET created_at = ? WHERE id = ?').bind(readyCreatedAt, environment.buildId),
      env.DB.prepare(
        `INSERT INTO environment_builds
          (id, environment_id, repo_id, seq, status, reason, config_hash, attempt, phases, output_tail, created_at, finished_at)
         VALUES (?, ?, ?, 2, 'failed', 'age', 'config', 1, '{}', '', ?, ?)`,
      ).bind(crypto.randomUUID(), environment.id, repo.id, finishedAt, finishedAt),
    ]);
    startResponse = { ok: true, value: { started: true, localDiverged: false } };
    const result = await startSandbox(sandboxContext(actor), {
      environment: environment.id,
      workspace: workspace.id,
    });
    expect(result).toMatchObject({ ok: true });
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM environment_builds WHERE environment_id = ?')
        .bind(environment.id)
        .first(),
    ).toMatchObject({ count: 2 });
  });

  it('resumes the same sleeping sandbox, rotates tokens, supports fresh and agent-scoped ownership', async () => {
    const agentId = await seedAgent(owner, `resume-${crypto.randomUUID()}`);
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'resume', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: ['refs/heads/agents/**'], expiresAt: Date.now() + 60_000 } };
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const previousToken = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at) VALUES (?, ?, 'old', 'old', ?, ?, 'write', ?, ?, ?, ?)`)
      .bind(previousToken, agentId, crypto.randomUUID(), repo.id, JSON.stringify([workspace.ref]), ownerId, Date.now(), Date.now() + 60_000).run();
    const id = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id, status: 'sleeping' });
    await env.DB.prepare('UPDATE sandboxes SET build_id = ?2, token_id = ?3 WHERE id = ?1').bind(id, environment.buildId, previousToken).run();
    await env.DB.prepare('UPDATE environments SET ready_build_id = ?2 WHERE id = ?1').bind(environment.id, crypto.randomUUID()).run();
    startResponse = { ok: true, value: { started: true, localDiverged: false } };
    const resumed = await startSandbox(sandboxContext(actor), { environment: environment.id });
    expect(resumed.ok && resumed.value).toMatchObject({ id, status: 'running', resumed: true, startedFrom: 'resume', buildOutdated: true, repo: `${OWNER}/fleet`, environmentName: expect.any(String), repoDirectory: '/workspace/fleet', pushRef: workspace.ref });
    expect(starts.at(-1)?.sandboxId).toBe(id);
    expect(await env.DB.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').bind(previousToken).first<{ revoked_at: number }>()).toMatchObject({ revoked_at: expect.any(Number) });
    const fresh = await startSandbox(sandboxContext(actor), { environment: environment.id, workspace: workspace.id, fresh: true });
    expect(fresh.ok && fresh.value.id).not.toBe(id);
    await env.DB.prepare('UPDATE environments SET ready_build_id = ?2 WHERE id = ?1').bind(environment.id, environment.buildId).run();
    const otherAgentId = await seedAgent(owner, `other-${crypto.randomUUID()}`);
    const other: Actor = { ...actor, agent: { ...actor.agent!, agentId: otherAgentId } };
    expect(await startSandbox(sandboxContext(other), { environment: environment.id, workspace: workspace.id })).toMatchObject({ ok: false, status: 403 });
  });

  it('sleeps by default, discards on request, and filters ownership', async () => {
    const agentId = await seedAgent(owner, `stop-${crypto.randomUUID()}`);
    const environment = await seedEnvironment({ ready: true });
    const workspace = await seedWorkspace(agentId);
    const tokenId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO agent_tokens (id, agent_id, name, prefix, hash, repo_id, role, refs, created_by, created_at, expires_at) VALUES (?, ?, 'run', 'run', ?, ?, 'write', ?, ?, ?, ?)`)
      .bind(tokenId, agentId, crypto.randomUUID(), repo.id, JSON.stringify([workspace.ref]), ownerId, Date.now(), Date.now() + 60_000).run();
    const id = await seedSandbox({ agentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: workspace.id, tokenId });
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'stop', ownerLogin: OWNER, ownerKind: 'user', tokenId, repoId: repo.id, role: 'write', refs: [workspace.ref], expiresAt: Date.now() + 60_000 } };
    expect((await stopSandbox(sandboxContext(actor), id)).ok).toBe(true);
    expect(await env.DB.prepare('SELECT status, token_id FROM sandboxes WHERE id = ?').bind(id).first()).toMatchObject({ status: 'sleeping', token_id: null });
    expect((await stopSandbox(sandboxContext(actor), id, { discard: true })).ok).toBe(true);
    expect(await env.DB.prepare('SELECT status FROM sandboxes WHERE id = ?').bind(id).first()).toMatchObject({ status: 'stopped' });
    const pendingId = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO sandbox_approvals (id, sandbox_id, repo_id, command, requested_by, status, created_at, expires_at) VALUES (?, ?, ?, 'npm install', ?, 'pending', ?, ?)`)
      .bind(pendingId, id, repo.id, ownerId, Date.now(), Date.now() + 60_000).run();
    expect(await listMyPendingApprovals(env, owner)).toMatchObject({ ok: true, value: [{ repo: `${OWNER}/fleet`, sandboxId: id }] });
    expect(await decideSandboxApproval(sandboxContext(actor), pendingId, 'approve')).toMatchObject({ ok: false, status: 403, code: 'AGENT_FORBIDDEN' });
    expect(await decideSandboxApproval(sandboxContext(owner), pendingId, 'approve')).toMatchObject({ ok: true, value: { status: 'approved', repo: `${OWNER}/fleet`, sandboxId: id } });
    const otherAgentId = await seedAgent(owner, `human-list-${crypto.randomUUID()}`);
    const otherWorkspace = await seedWorkspace(otherAgentId);
    const otherSandbox = await seedSandbox({ agentId: otherAgentId, environmentId: environment.id, buildId: environment.buildId!, workspaceId: otherWorkspace.id });
    const humanList = await listMySandboxes(env, owner);
    expect(humanList.ok && humanList.value.sandboxes.map((sandbox) => sandbox.id)).toContain(otherSandbox);
    const agentList = await listMySandboxes(env, actor);
    expect(agentList.ok && agentList.value.sandboxes.every((sandbox) => sandbox.agentId === agentId)).toBe(true);
  });

  it('applies deny and approval policy before execution and rejects a different owner', async () => {
    const agentId = await seedAgent(owner, `policy-${crypto.randomUUID()}`);
    const policy = await seedEnvironment({ ready: true, policy: '{"deny":["rm *"],"approve":["npm install"]}' });
    const workspace = await seedWorkspace(agentId);
    const id = await seedSandbox({ agentId, environmentId: policy.id, buildId: policy.buildId!, workspaceId: workspace.id });
    const actor: Actor = { ...owner, agent: { agentId, agentName: 'policy', ownerLogin: OWNER, ownerKind: 'user', tokenId: 'fixture', repoId: repo.id, role: 'write', refs: [workspace.ref], expiresAt: Date.now() + 60_000 } };
    expect(await execSandbox(sandboxContext(actor), id, { command: 'rm -rf /tmp/x' })).toMatchObject({ ok: false, status: 403, code: 'COMMAND_DENIED' });
    const approval = await execSandbox(sandboxContext(actor), id, { command: 'npm install' });
    expect(approval).toMatchObject({ ok: false, status: 409, code: 'APPROVAL_REQUIRED' });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM sandbox_commands WHERE sandbox_id = ?').bind(id).first()).toMatchObject({ n: 2 });
    expect(await execSandbox(sandboxContext(writer), id, { command: 'npm test' })).toMatchObject({ ok: false, status: 403, code: 'SANDBOX_NOT_OWNED' });
  });
});
