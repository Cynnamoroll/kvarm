/**
 * Repo deletion: the DELETE batch is one D1 transaction whose end state must
 * hold no row still referencing a deleted parent (change review requests and
 * carried review files cascade off nothing, forks off nothing), and a repo
 * row whose Artifacts storage is already gone — the half-deleted leftover a
 * failed delete leaves — must purge cleanly and render a clear page.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { listReposForOwner, type RepoRow } from '../src/db/repos';
import { createRepo, deleteRepo, forkRepo, importRepo } from '../src/repos/service';
import { handleEventBatch } from '../src/services/events';
import { purgeRepo, purgeRepoById, sweepRepoPurges } from '../src/services/repoPurge';
import { FakeRepo, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { call } from './helpers/http';
import { seedRepo, seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'del-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const tok: Record<string, string> = {};

beforeAll(async () => {
  tok.owner = (await mintPAT(env, await seedUser(env, OWNER), 'owner', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

async function populateRepoTables(repoId: string, sha: string, userId: string): Promise<string[]> {
  const now = Date.now();
  const changeSetId = crypto.randomUUID();
  const issueId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const buildId = crypto.randomUUID();
  const sandboxId = crypto.randomUUID();
  const checkRunId = crypto.randomUUID();
  const decisionId = crypto.randomUUID();
  const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?').bind(repoId).first<{ artifacts_name: string }>();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, author_id, created_at)
       VALUES (?, ?, 1000, 'purge test', 'refs/heads/main', 'refs/heads/main', ?, ?, ?)`,
    ).bind(changeSetId, repoId, sha, userId, now),
    env.DB.prepare(
      'INSERT INTO issues (id, repo_id, number, title, created_at) VALUES (?, ?, 1000, ?, ?)',
    ).bind(issueId, repoId, 'purge test', now),
    env.DB.prepare(
      `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, created_by, created_at)
       VALUES (?, 'user', ?, ?, ?, ?, ?)`,
    ).bind(agentId, userId, OWNER, `purge-${repoId.slice(0, 8)}`, userId, now),
    env.DB.prepare(
      'INSERT INTO workspaces (id, repo_id, artifacts_name, created_at) VALUES (?, ?, ?, ?)',
    ).bind(workspaceId, repoId, repo?.artifacts_name ?? `${OWNER}--purge-test`, now),
    env.DB.prepare(
      `INSERT INTO environments (id, repo_id, name, config_hash, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'config', ?, ?, ?)`,
    ).bind(environmentId, repoId, `purge-${repoId.slice(0, 8)}`, userId, now, now),
    env.DB.prepare(
      `INSERT INTO environment_builds (id, environment_id, repo_id, seq, status, reason, config_hash, created_at)
       VALUES (?, ?, ?, 1, 'queued', 'create', 'config', ?)`,
    ).bind(buildId, environmentId, repoId, now),
    env.DB.prepare(
      `INSERT INTO check_runs (id, repo_id, head_sha, name, status, created_at)
       VALUES (?, ?, ?, 'purge-test', 'queued', ?)`,
    ).bind(checkRunId, repoId, sha, now),
    env.DB.prepare(
      `INSERT INTO agent_decisions (id, repo_id, paths, chosen_candidate, rejected_candidates, reason, actor, at)
       VALUES (?, ?, '[]', 'candidate', '[]', 'test', 'owner', ?)`,
    ).bind(decisionId, repoId, now),
    env.DB.prepare(
      `INSERT INTO sandboxes
       (id, repo_id, environment_id, build_id, workspace_id, owner_user_id, status, last_active_at, expires_at, run_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?, ?)`,
    ).bind(sandboxId, repoId, environmentId, buildId, workspaceId, userId, now, now, now, now),
  ]);

  const tableRows = await env.DB.prepare(
    `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all<{ name: string; sql: string | null }>();
  const schemas = new Map((tableRows.results ?? []).flatMap(({ name, sql }) =>
    sql ? [[name, parseTableSchema(sql)] as const] : [],
  ));
  const repoTables: string[] = [];
  for (const [name, schema] of schemas) {
    if (schema.columns.some((column) => column.name === 'repo_id')) repoTables.push(name);
  }
  const foreignValues: Record<string, Record<string, string>> = {
    repos: { id: repoId },
    users: { id: userId },
    change_sets: { id: changeSetId },
    issues: { id: issueId },
    agents: { id: agentId },
    workspaces: { id: workspaceId },
    environments: { id: environmentId },
    environment_builds: { id: buildId },
    sandboxes: { id: sandboxId },
    check_runs: { id: checkRunId },
    agent_decisions: { id: decisionId },
  };
  const seeded = new Set<string>();
  for (const table of repoTables) {
    if (table === 'repo_purges' || table === 'repo_purge_keys') continue;
    const quotedTable = `"${table.replaceAll('"', '""')}"`;
    const prior = await env.DB.prepare(`SELECT 1 AS found FROM ${quotedTable} WHERE repo_id = ? LIMIT 1`).bind(repoId).first();
    if (prior) {
      seeded.add(table);
      continue;
    }
    const schema = schemas.get(table)!;
    const values = new Map<string, unknown>();
    for (const column of schema.columns) {
      const foreign = schema.foreignKeys.find((key) => key.from === column.name);
      if (column.name === 'repo_id') values.set(column.name, repoId);
      else if (column.name === 'workspace_id' && table !== 'issue_links') values.set(column.name, workspaceId);
      else if (foreign) {
        const parentSchema = schemas.get(foreign.table);
        const parentKey = foreign.to ?? parentSchema?.columns.find((parentColumn) => parentColumn.pk > 0)?.name;
        const parent = parentKey ? foreignValues[foreign.table]?.[parentKey] : undefined;
        if (parent) values.set(column.name, parent);
      } else if (column.dflt_value === null && (column.required === 1 || column.pk > 0)) {
        values.set(column.name, column.checkValue ?? repoTableValue(table, column.name, column.type, now, sha, repoId));
      }
    }
    if (table === 'issue_links') values.set('change_set_id', changeSetId);
    const names = [...values.keys()];
    const placeholders = names.map(() => '?').join(', ');
    await env.DB.prepare(
      `INSERT INTO ${quotedTable} (${names.map((name) => `"${name.replaceAll('"', '""')}"`).join(', ')}) VALUES (${placeholders})`,
    ).bind(...names.map((name) => values.get(name))).run();
    if (table === 'snapshot_trees') {
      await env.SNAPSHOTS.put(`trees/v3/${repoId}/${sha}.tar.zst`, 'snapshot');
    }
    seeded.add(table);
  }
  expect([...seeded].sort()).toEqual(repoTables.filter((table) => table !== 'repo_purges' && table !== 'repo_purge_keys').sort());
  return repoTables;
}

interface RepoTableSchema {
  columns: Array<{ name: string; type: string; required: number; dflt_value: string | null; pk: number; checkValue: string | null }>;
  foreignKeys: Array<{ table: string; from: string; to: string | null }>;
}

function parseTableSchema(definition: string): RepoTableSchema {
  const parts: string[] = [];
  const opening = definition.indexOf('(');
  if (opening < 0) return { columns: [], foreignKeys: [] };
  let depth = 0;
  let quote = '';
  let part = '';
  for (let i = opening + 1; i < definition.length; i++) {
    const char = definition[i]!;
    if (!quote && char === '-' && definition[i + 1] === '-') {
      while (i < definition.length && definition[i] !== '\n') i++;
      part += ' ';
      continue;
    }
    if (quote) {
      part += char;
      if (quote === '[' && char === ']') quote = '';
      else if (char === quote) {
        if (definition[i + 1] === quote) part += definition[++i]!;
        else quote = '';
      }
    } else if (char === '"' || char === "'" || char === '`' || char === '[') {
      quote = char === '[' ? '[' : char;
      part += char;
    } else if (char === '(') {
      depth++;
      part += char;
    } else if (char === ')' && depth > 0) {
      depth--;
      part += char;
    } else if (char === ')' || (char === ',' && depth === 0)) {
      parts.push(part.trim());
      part = '';
      if (char === ')') break;
    } else {
      part += char;
    }
  }

  const identifier = (raw: string) => {
    const value = raw.trim();
    if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replaceAll('""', '"');
    if (value.startsWith('`') && value.endsWith('`')) return value.slice(1, -1);
    if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
    return value;
  };
  const foreignKeys: RepoTableSchema['foreignKeys'] = [];
  const columns: RepoTableSchema['columns'] = [];
  for (const entry of parts) {
    const tableForeignKey = /^\s*(?:CONSTRAINT\s+(?:"(?:[^"]|"")*"|\S+)\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+("(?:[^"]|"")*"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s*(?:\(([^)]+)\))?/i.exec(entry);
    if (tableForeignKey) {
      const from = tableForeignKey[1]!.split(',').map(identifier);
      const to = tableForeignKey[3]?.split(',').map(identifier) ?? [];
      const table = identifier(tableForeignKey[2]!);
      from.forEach((column, index) => foreignKeys.push({ table, from: column, to: to[index] ?? null }));
      continue;
    }
    if (/^\s*(?:CONSTRAINT\b|PRIMARY\b|UNIQUE\b|CHECK\b)/i.test(entry)) {
      const primaryKey = /^\s*(?:CONSTRAINT\s+(?:"(?:[^"]|"")*"|\S+)\s+)?PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(entry);
      if (primaryKey) {
        for (const name of primaryKey[1]!.split(',').map(identifier)) {
          const column = columns.find((item) => item.name === name);
          if (column) column.pk = 1;
        }
      }
      continue;
    }
    const columnEntry = /^\s*("(?:[^"]|"")*"|`[^`]+`|\[[^\]]+\]|\S+)\s+([\s\S]+)$/.exec(entry);
    if (!columnEntry) continue;
    const name = identifier(columnEntry[1]!);
    const rest = columnEntry[2]!;
    columns.push({
      name,
      type: rest.trim().split(/\s+/)[0] ?? 'TEXT',
      required: /\bNOT\s+NULL\b/i.test(rest) ? 1 : 0,
      dflt_value: /\bDEFAULT\b/i.test(rest) ? 'default' : null,
      pk: /\bPRIMARY\s+KEY\b/i.test(rest) ? 1 : 0,
      checkValue: /\bCHECK\s*\([^)]*\bIN\s*\(\s*'([^']+)'/i.exec(rest)?.[1] ?? null,
    });
    const inlineForeignKey = /\bREFERENCES\s+("(?:[^"]|"")*"|`[^`]+`|\[[^\]]+\]|[^\s(]+)\s*(?:\(([^)]+)\))?/i.exec(rest);
    if (inlineForeignKey) {
      foreignKeys.push({ table: identifier(inlineForeignKey[1]!), from: name, to: inlineForeignKey[2] ? identifier(inlineForeignKey[2]) : null });
    }
  }
  return { columns, foreignKeys };
}

function repoTableValue(table: string, column: string, type: string, now: number, sha: string, repoId: string): unknown {
  const states: Record<string, string> = {
    change_escalations: 'open',
    ci_jobs: 'queued',
    incident_events: 'opened',
    issue_links: 'confirmed',
    merge_queue: 'queued',
    path_history: 'added',
    sandbox_approvals: 'pending',
    snapshot_commits: 'building',
    snapshot_trees: 'building',
    webhook_deliveries: 'pending',
  };
  const values: Record<string, unknown> = {
    id: crypto.randomUUID(),
    number: 1001,
    seq: 2,
    attempt: 1,
    generation: 1,
    at: now,
    created_at: now,
    updated_at: now,
    requested_at: now,
    recorded_at: now,
    first_at: now,
    event_at: now,
    received_at: now,
    completed_at: now,
    next_attempt_at: now,
    expires_at: now + 60_000,
    last_active_at: now,
    run_expires_at: now + 60_000,
    started_at: now,
    finished_at: now,
    committed_at: now,
    tree_sha: sha,
    head_sha: sha,
    base_sha: sha,
    old_sha: sha,
    new_sha: sha,
    sha,
    commit_sha: sha,
    ref: 'refs/heads/main',
    target_ref: 'refs/heads/main',
    path: 'README.md',
    key: 'README.md',
    name: `${table}-test`,
    title: 'purge test',
    summary: 'purge test',
    description: 'purge test',
    task: 'purge test',
    body: 'purge test',
    detail: '{}',
    paths: '[]',
    candidates: '[]',
    sources: '[]',
    reasons: '[]',
    rejected_candidates: '[]',
    checks: '[]',
    events: '[]',
    status: states[table] ?? 'open',
    state: states[table] ?? 'open',
    kind: table === 'issue_links' ? 'refs' : table === 'workspace_semantic' ? 'import' : table === 'merge_publication_intents' ? 'fast-forward' : table === 'workspace_paths' ? 'declared' : 'test',
    source: table === 'issue_links' ? 'manual' : 'test',
    via: 'push',
    level: 'declared',
    token_kind: 'pat',
    role: 'read',
    verdict: 'approve',
    reason: table === 'change_escalations' ? 'review-blocked' : 'create',
    merge_policy: 'auto',
    principal: `user:${table}`,
    actor: 'owner',
    user_login: OWNER,
    owner_kind: 'user',
    owner_login: OWNER,
    url: 'https://example.test/hook',
    secret_ciphertext: 'ciphertext',
    secret_iv: 'iv',
    key_nonce: 'nonce',
    key_hash: 'hash',
    hash: crypto.randomUUID(),
    prefix: 'test',
    command: 'true',
    artifacts_name: `${OWNER}--purge-test`,
    r2_key: table === 'snapshot_trees' ? `trees/v3/${repoId}/${sha}.tar.zst` : `snapshot/${table}`,
    instance_id: crypto.randomUUID(),
    builder: crypto.randomUUID(),
    trigger: 'push',
    old_path: 'README.md',
    new_path: 'README.md',
    change_number: 1000,
    lease_generation: 1,
    config_hash: 'config',
    reason_code: 'test',
    claim: 'test',
    event_source: 'test',
    event_id: crypto.randomUUID(),
    subject_sha: sha,
    target: 'test',
    chosen_candidate: 'candidate',
    token_id: 'token',
  };
  if (column in values) return values[column];
  if (column.endsWith('_at')) return now;
  return type.toUpperCase().includes('INT') ? 1 : `${table}-${column}`;
}

describe('repo deletion', () => {
  it('removes repository rows from non-cascading stores in the delete transaction', async () => {
    const { id, main } = await seedRepoWithCommit(env, 'purge-everywhere', { owner: OWNER, visibility: 'private' });
    const now = Date.now();
    const sha = main;
    const ownerUser = await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(OWNER).first<{ id: string }>();
    expect(ownerUser).not.toBeNull();
    const userId = ownerUser!.id;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO push_events (id, repo_id, ref, before_sha, after_sha, transition_key, source, event_at, received_at)
         VALUES ('purge-event', ?, 'refs/heads/main', ?, ?, 'purge-transition', 'test', ?, ?)`,
      ).bind(id, sha, sha, now, now),
      env.DB.prepare(
        `INSERT INTO push_event_effects (event_id, effect, state, detail, completed_at)
         VALUES ('purge-event', 'snapshot', 'done', NULL, ?)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO repo_refs (repo_id, ref, sha, event_id, event_at, updated_at)
         VALUES (?, 'refs/heads/main', ?, 'purge-event', ?, ?)`,
      ).bind(id, sha, now, now),
      env.DB.prepare(
        `INSERT INTO snapshots (id, repo_id, sha, kind, r2_key) VALUES ('purge-snapshot', ?, ?, 'tree', 'snapshot/purge')`,
      ).bind(id, sha),
      env.DB.prepare('INSERT INTO stars (user_id, repo_id, created_at) VALUES ((SELECT id FROM users WHERE login = ?), ?, ?)').bind(OWNER, id, now),
      env.DB.prepare(
        `INSERT INTO ref_updates (id, repo_id, ref, old_sha, new_sha, via, at)
         VALUES ('purge-ref-update', ?, 'refs/heads/main', ?, ?, 'push', ?)`,
      ).bind(id, sha, sha, now),
      env.DB.prepare(
        `INSERT INTO attribution_evidence
         (repo_id, commit_sha, note_digest, notes_commit, source, agent, session, actor, level, reasons, at, recorded_at)
         VALUES (?, ?, 'digest', 'notes', 'api', 'agent', 'session', 'actor', 'declared', '[]', ?, ?)`,
      ).bind(id, sha, now, now),
    ]);
    await env.SNAPSHOTS.put('snapshot/purge', 'legacy snapshot');
    for (const version of ['v1', 'v2', 'v3']) {
      await env.SNAPSHOTS.put(`trees/${version}/${id}/legacy-object`, version);
    }
    for (const prefix of ['replica', 'fetch', 'bundles']) {
      await env.SNAPSHOTS.put(`${prefix}/${id}/object`, prefix);
    }
    const repoTables = await populateRepoTables(id, sha, userId);
    const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?').bind(id).first<{ artifacts_name: string }>();
    const historyStub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(id));
    await runInDurableObject(historyStub, async (_obj, state) => {
      state.storage.sql.exec(
        `INSERT INTO state(epoch,repo_id,repo_name,ref,head_sha,head_seq,tail_next,tail_seq,gaps,known_sha,known_at,memo_at,updated_at)
         VALUES(1,?,?,'refs/heads/main',?,0,NULL,0,0,?,?,0,?)`,
        id,
        repo?.artifacts_name ?? '',
        sha,
        sha,
        now,
        now,
      );
    });

    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/purge-everywhere`, { token: tok.owner });
    expect(del.status).toBe(200);
    for (const table of repoTables.filter((name) => name !== 'repo_purges')) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE repo_id = ?`).bind(id).first<{ n: number }>();
      expect(row?.n, table).toBe(0);
    }
    for (const prefix of ['replica', 'fetch', 'bundles']) {
      expect((await env.SNAPSHOTS.list({ prefix: `${prefix}/${id}/` })).objects).toHaveLength(0);
    }
    for (const version of ['v1', 'v2', 'v3']) {
      expect((await env.SNAPSHOTS.list({ prefix: `trees/${version}/${id}/` })).objects).toHaveLength(0);
    }
    expect((await env.SNAPSHOTS.list({ prefix: 'snapshot/' })).objects).toHaveLength(0);
    const historyTables = await runInDurableObject(historyStub, async (_obj, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray(),
    );
    expect(historyTables).toEqual([]);
    const tombstone = await env.DB.prepare('SELECT done_at, attempts FROM repo_purges WHERE repo_id = ?')
      .bind(id).first<{ done_at: number | null; attempts: number }>();
    expect(tombstone?.done_at).not.toBeNull();
    expect(tombstone?.attempts).toBe(0);
    expect((await listReposForOwner(env.DB, OWNER)).some((repo) => repo.id === id)).toBe(false);
  });

  it('retries failed cleanup from both the minute sweep and the event queue', async () => {
    const failingEnv = {
      ...env,
      ARTIFACTS: { ...fakeArtifacts, delete: async () => { throw new Error('storage unavailable'); } },
      EVENTS: { send: async () => {}, sendBatch: async () => {} },
    } as unknown as Env;
    const { id: sweepId } = await seedRepo(env, 'purge-sweep', { owner: OWNER, visibility: 'private' });
    expect((await call(failingEnv, 'DELETE', `/api/v1/repos/${OWNER}/purge-sweep`, { token: tok.owner })).status).toBe(200);
    const failedInline = await env.DB.prepare('SELECT done_at, attempts, last_error FROM repo_purges WHERE repo_id = ?')
      .bind(sweepId).first<{ done_at: number | null; attempts: number; last_error: string }>();
    expect(failedInline).toMatchObject({ done_at: null, attempts: 1, last_error: 'artifacts:Error:storage unavailable' });
    await env.DB.prepare('UPDATE repo_purges SET next_attempt_at = 0 WHERE repo_id = ?').bind(sweepId).run();
    expect(await sweepRepoPurges(env, { now: Date.now() })).toMatchObject({ count: 1, failed: 0 });
    const swept = await env.DB.prepare('SELECT done_at FROM repo_purges WHERE repo_id = ?')
      .bind(sweepId).first<{ done_at: number | null }>();
    expect(swept?.done_at).not.toBeNull();

    const { id: queueId } = await seedRepo(env, 'purge-queue', { owner: OWNER, visibility: 'private' });
    expect((await call(failingEnv, 'DELETE', `/api/v1/repos/${OWNER}/purge-queue`, { token: tok.owner })).status).toBe(200);
    const ack = vi.fn();
    const retry = vi.fn();
    const message = {
      id: 'repo-purge-test',
      body: { type: 'repo.purge', repoId: queueId },
      attempts: 1,
      ack,
      retry,
    };
    await handleEventBatch(
      { queue: 'kvarm-events', messages: [message] } as unknown as MessageBatch<unknown>,
      failingEnv,
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    const failedQueue = await env.DB.prepare('SELECT attempts FROM repo_purges WHERE repo_id = ?')
      .bind(queueId).first<{ attempts: number }>();
    expect(failedQueue?.attempts).toBe(2);

    const queueAck = vi.fn();
    const queueRetry = vi.fn();
    await handleEventBatch(
      {
        queue: 'kvarm-events',
        messages: [{
          id: 'repo-purge-test-retry',
          body: { type: 'repo.purge', repoId: queueId },
          attempts: 2,
          ack: queueAck,
          retry: queueRetry,
        }],
      } as unknown as MessageBatch<unknown>,
      env,
    );
    expect(queueAck).toHaveBeenCalledOnce();
    expect(queueRetry).not.toHaveBeenCalled();
    const queued = await env.DB.prepare('SELECT done_at FROM repo_purges WHERE repo_id = ?')
      .bind(queueId).first<{ done_at: number | null }>();
    expect(queued?.done_at).not.toBeNull();
  });

  it('continues snapshot-prefix deletion across page-limited purge sweeps', async () => {
    const { id } = await seedRepo(env, 'large-snapshot-prefix', { owner: OWNER, visibility: 'private' });
    const prefix = `trees/v1/${id}/`;
    for (let start = 0; start < 2001; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 2001 - start) }, (_, offset) =>
          env.SNAPSHOTS.put(`${prefix}${String(start + offset).padStart(5, '0')}`, 'tree'),
        ),
      );
    }

    expect((await call(env, 'DELETE', `/api/v1/repos/${OWNER}/large-snapshot-prefix`, { token: tok.owner })).status).toBe(200);
    const first = await env.DB.prepare('SELECT attempts, done_at FROM repo_purges WHERE repo_id = ?')
      .bind(id).first<{ attempts: number; done_at: number | null }>();
    expect(first).toMatchObject({ attempts: 1, done_at: null });
    expect((await env.SNAPSHOTS.list({ prefix })).objects).toHaveLength(1000);

    await env.DB.prepare('UPDATE repo_purges SET next_attempt_at = 0 WHERE repo_id = ?').bind(id).run();
    expect(await sweepRepoPurges(env)).toMatchObject({ count: 1, failed: 1 });
    expect((await env.SNAPSHOTS.list({ prefix })).objects).toHaveLength(1);

    await env.DB.prepare('UPDATE repo_purges SET next_attempt_at = 0 WHERE repo_id = ?').bind(id).run();
    expect(await sweepRepoPurges(env)).toMatchObject({ count: 1, failed: 0 });
    expect((await env.SNAPSHOTS.list({ prefix })).objects).toHaveLength(0);
    const completed = await env.DB.prepare('SELECT done_at, attempts FROM repo_purges WHERE repo_id = ?')
      .bind(id).first<{ done_at: number | null; attempts: number }>();
    expect(completed).toMatchObject({ attempts: 2 });
    expect(completed?.done_at).not.toBeNull();
  }, 60_000);

  it('does not wait for purge cleanup when a request lifetime callback is provided', async () => {
    const { id } = await seedRepo(env, 'wait-until-delete', { owner: OWNER, visibility: 'private' });
    const repo = await env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(id).first<RepoRow>();
    expect(repo).not.toBeNull();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deleting = new Promise<void>((resolve) => { entered = resolve; });
    const lifecycleEnv = {
      ...env,
      ARTIFACTS: {
        ...fakeArtifacts,
        async delete(name: string) {
          entered();
          await blocked;
          await fakeArtifacts.delete(name);
        },
      },
    } as unknown as Env;
    let cleanup: Promise<unknown> | undefined;
    const result = await deleteRepo(lifecycleEnv, repo!, { waitUntil: (promise) => { cleanup = promise; } });
    expect(result.ok).toBe(true);
    await deleting;
    expect(cleanup).toBeDefined();
    expect(await env.DB.prepare('SELECT 1 FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    release();
    await cleanup;
  });

  it('does not resurrect a completed tombstone when a concurrent runner fails late', async () => {
    const repoId = crypto.randomUUID();
    const artifactsName = `${OWNER}--concurrent-purge`;
    await env.DB.prepare(
      `INSERT INTO repo_purges (repo_id, artifacts_name, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(repoId, artifactsName, Date.now(), Date.now()).run();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const deleting = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const lifecycleEnv = {
      ...env,
      ARTIFACTS: {
        ...fakeArtifacts,
        async delete(name: string) {
          calls++;
          if (calls === 1) {
            entered();
            await blocked;
            throw new Error('late failure');
          }
          await fakeArtifacts.delete(name);
        },
      },
    } as unknown as Env;
    const tombstone = await env.DB.prepare('SELECT * FROM repo_purges WHERE repo_id = ?')
      .bind(repoId).first<import('../src/services/repoPurge').RepoPurgeTombstone>();
    expect(tombstone).not.toBeNull();
    const lateRunner = purgeRepo(lifecycleEnv, tombstone!);
    await deleting;
    expect((await purgeRepo(lifecycleEnv, tombstone!)).ok).toBe(true);
    release();
    expect((await lateRunner).ok).toBe(false);
    const completed = await env.DB.prepare('SELECT done_at, attempts FROM repo_purges WHERE repo_id = ?')
      .bind(repoId).first<{ done_at: number | null; attempts: number }>();
    expect(completed?.done_at).not.toBeNull();
    expect(completed?.attempts).toBe(0);
  });

  it('redacts long token-like purge errors and keeps them bounded', async () => {
    const repoId = crypto.randomUUID();
    const artifactsName = `${OWNER}--redacted-purge`;
    await env.DB.prepare(
      `INSERT INTO repo_purges (repo_id, artifacts_name, created_at, next_attempt_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(repoId, artifactsName, Date.now(), Date.now()).run();
    const lifecycleEnv = {
      ...env,
      ARTIFACTS: {
        ...fakeArtifacts,
        async delete() {
          throw new Error(`storage ${'x'.repeat(40)}${'y'.repeat(100)}`);
        },
      },
    } as unknown as Env;
    const tombstone = await env.DB.prepare('SELECT * FROM repo_purges WHERE repo_id = ?')
      .bind(repoId).first<import('../src/services/repoPurge').RepoPurgeTombstone>();
    expect(tombstone).not.toBeNull();
    await purgeRepo(lifecycleEnv, tombstone!);
    const failed = await env.DB.prepare('SELECT last_error FROM repo_purges WHERE repo_id = ?')
      .bind(repoId).first<{ last_error: string }>();
    expect(failed?.last_error).toMatch(/^artifacts:Error:storage …/);
    expect(failed?.last_error.length).toBeLessThanOrEqual(500);
    expect(failed?.last_error).not.toContain('x'.repeat(24));
  });

  it('recreates a deleted repo under a distinct Artifacts name without stale retry deleting it', async () => {
    const { id } = await seedRepo(env, 'name-reuse', { owner: OWNER, visibility: 'private' });
    const oldRepo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?')
      .bind(id).first<{ artifacts_name: string }>();
    expect(oldRepo).not.toBeNull();
    const deletedNames: string[] = [];
    let failDelete = true;
    const artifacts = {
      ...fakeArtifacts,
      async delete(name: string) {
        deletedNames.push(name);
        if (name === oldRepo!.artifacts_name && failDelete) {
          failDelete = false;
          throw new Error('storage unavailable');
        }
        await fakeArtifacts.delete(name);
      },
      async create(name: string) {
        fakeRepos.set(name, new FakeRepo());
        return { remote: `https://artifacts.invalid/${name}.git`, defaultBranch: 'main' };
      },
    } as unknown as Artifacts;
    const lifecycleEnv = { ...env, ARTIFACTS: artifacts } as Env;

    const deleted = await call(lifecycleEnv, 'DELETE', `/api/v1/repos/${OWNER}/name-reuse`, { token: tok.owner });
    expect(deleted.status).toBe(200);
    const failed = await env.DB.prepare('SELECT attempts, done_at FROM repo_purges WHERE repo_id = ?')
      .bind(id).first<{ attempts: number; done_at: number | null }>();
    expect(failed).toMatchObject({ attempts: 1, done_at: null });

    const recreated = await createRepo(lifecycleEnv, { ownerLogin: OWNER, name: 'name-reuse' });
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) throw new Error(recreated.error);
    expect(recreated.value.artifacts_name).not.toBe(oldRepo!.artifacts_name);
    expect(recreated.value.artifacts_name).toMatch(/^del-owner--name-reuse--[0-9a-f]{12}$/);

    expect((await purgeRepoById(lifecycleEnv, id)).ok).toBe(true);
    expect(deletedNames).toEqual([oldRepo!.artifacts_name, oldRepo!.artifacts_name]);
    expect(fakeRepos.has(recreated.value.artifacts_name)).toBe(true);
  });

  it('uses bounded randomized Artifacts names for create, import and fork', async () => {
    const { id: parentId } = await seedRepo(env, 'creation-parent', { owner: OWNER, visibility: 'private' });
    const parent = await env.DB.prepare('SELECT * FROM repos WHERE id = ?')
      .bind(parentId).first<RepoRow>();
    expect(parent).not.toBeNull();
    const createdNames: string[] = [];
    const artifacts = {
      ...fakeArtifacts,
      async create(name: string) {
        createdNames.push(name);
        fakeRepos.set(name, new FakeRepo());
        return { remote: `https://artifacts.invalid/${name}.git`, defaultBranch: 'main' };
      },
      async import(input: { target: { name: string } }) {
        createdNames.push(input.target.name);
        fakeRepos.set(input.target.name, new FakeRepo());
        return { remote: `https://artifacts.invalid/${input.target.name}.git`, defaultBranch: 'main' };
      },
      async get() {
        return {
          async fork(name: string) {
            createdNames.push(name);
            fakeRepos.set(name, new FakeRepo());
            return { remote: `https://artifacts.invalid/${name}.git`, defaultBranch: 'main' };
          },
        };
      },
    } as unknown as Artifacts;
    const serviceEnv = { ...env, ARTIFACTS: artifacts } as Env;
    const created = await createRepo(serviceEnv, { ownerLogin: OWNER, name: 'created-new' });
    const imported = await importRepo(serviceEnv, {
      ownerLogin: OWNER,
      name: 'imported-new',
      sourceUrl: 'https://source.example/repo.git',
    });
    const forked = await forkRepo(serviceEnv, parent!, OWNER, 'forked-new');
    expect([created, imported, forked].every((result) => result.ok)).toBe(true);
    if (!created.ok || !imported.ok || !forked.ok) throw new Error('repository setup failed');
    const names = [created.value.artifacts_name, imported.value.artifacts_name, forked.value.artifacts_name];
    expect(new Set(names).size).toBe(3);
    expect(createdNames).toEqual(names);
    for (const name of names) {
      expect(name).toMatch(/^del-owner--[a-z0-9._-]+--[0-9a-f]{12}$/);
      expect(name.length).toBeLessThanOrEqual(63);
    }
  });

  it('skips Artifacts and token deletion when a legacy tombstone name is currently in use', async () => {
    const { id } = await seedRepo(env, 'legacy-name-active', { owner: OWNER, visibility: 'private' });
    const active = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?')
      .bind(id).first<{ artifacts_name: string }>();
    expect(active).not.toBeNull();
    const tombstoneId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO repo_purges (repo_id, artifacts_name, created_at, attempts, next_attempt_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).bind(tombstoneId, active!.artifacts_name, Date.now(), Date.now()).run();
    const deleteSpy = vi.spyOn(fakeArtifacts, 'delete');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect((await purgeRepoById(env, tombstoneId)).ok).toBe(true);
    expect(deleteSpy).not.toHaveBeenCalledWith(active!.artifacts_name);
    const superseded = logSpy.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('"status":"superseded"'));
    expect(superseded).toHaveLength(2);
    expect(superseded.join('\n')).toContain('"step":"artifacts"');
    expect(superseded.join('\n')).toContain('"step":"tokens"');

    deleteSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('prunes completed purge tombstones after seven days', async () => {
    const { id } = await seedRepo(env, 'purge-prune', { owner: OWNER, visibility: 'private' });
    expect((await call(env, 'DELETE', `/api/v1/repos/${OWNER}/purge-prune`, { token: tok.owner })).status).toBe(200);
    const now = Date.now();
    await env.DB.prepare('UPDATE repo_purges SET done_at = ? WHERE repo_id = ?').bind(now - 8 * 24 * 60 * 60 * 1000, id).run();

    expect(await sweepRepoPurges(env, { now })).toMatchObject({ count: 0, failed: 0, pruned: 1 });
    expect(await env.DB.prepare('SELECT repo_id FROM repo_purges WHERE repo_id = ?').bind(id).first()).toBeNull();
  });

  it('deletes a repo whose changes still carry review requests and files, storage already gone', async () => {
    const reviewer = await seedUser(env, 'del-reviewer');
    const { id, main } = await seedRepoWithCommit(env, 'harness', { owner: OWNER, visibility: 'private' });
    const changeSet = crypto.randomUUID();
    const review = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at)
         VALUES (?, ?, 1, 'Add a token-bucket rate limit', 'refs/heads/main', 'refs/heads/agents/ws1/atlas', ?, 'open', ?, ?)`,
      ).bind(changeSet, id, main, reviewer, now),
      env.DB.prepare(
        `INSERT INTO change_reviews (id, repo_id, change_set_id, head_sha, principal, user_id, user_login, verdict, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'del-reviewer', 'approve', ?, ?)`,
      ).bind(review, id, changeSet, main, `user:${reviewer}`, reviewer, now, now),
      env.DB.prepare('INSERT INTO change_review_files (review_id, path, old_hash, new_hash) VALUES (?, ?, ?, ?)').bind(
        review,
        'src/util.js',
        'f'.repeat(40),
        'e'.repeat(40),
      ),
      env.DB.prepare('INSERT INTO change_review_requests (change_set_id, principal, requested_by, requested_at) VALUES (?, ?, ?, ?)').bind(
        changeSet,
        `user:${reviewer}`,
        reviewer,
        now,
      ),
    ]);
    // Storage already removed, as it is for every leftover a failed delete left.
    await env.ARTIFACTS.delete(`${OWNER}--harness`);
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/harness`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_reviews WHERE repo_id = ?').bind(id).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_files WHERE review_id = ?').bind(review).first()).toEqual({ n: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM change_review_requests WHERE change_set_id = ?').bind(changeSet).first()).toEqual({ n: 0 });
  });

  it('deleting a forked parent detaches the forks instead of failing whole', async () => {
    const { id } = await seedRepoWithCommit(env, 'parent', { owner: OWNER, visibility: 'private' });
    const { id: forkId } = await seedRepo(env, 'child-fork', { owner: OWNER, visibility: 'private' });
    await env.DB.prepare('UPDATE repos SET fork_parent_id = ? WHERE id = ?').bind(id, forkId).run();
    const del = await call(env, 'DELETE', `/api/v1/repos/${OWNER}/parent`, { token: tok.owner });
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM repos WHERE id = ?').bind(id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT fork_parent_id FROM repos WHERE id = ?').bind(forkId).first()).toEqual({ fork_parent_id: null });
  });
});

describe('a repo whose storage is gone', () => {
  it('renders a clear page, not a 500', async () => {
    const { id } = await seedRepoWithCommit(env, 'gone', { owner: OWNER, visibility: 'public' });
    await env.DB.prepare('UPDATE repos SET created_at = created_at - 3600000 WHERE id = ?').bind(id).run();
    await env.ARTIFACTS.delete(`${OWNER}--gone`);
    const res = await call(env, 'GET', `/${OWNER}/gone`);
    expect(res.status).toBe(410);
    expect(res.text).toContain('no longer available');
  });

  it('still shows the warming page while a fresh row could be an import settling', async () => {
    await seedRepoWithCommit(env, 'warming', { owner: OWNER, visibility: 'public' });
    await env.ARTIFACTS.delete(`${OWNER}--warming`);
    const res = await call(env, 'GET', `/${OWNER}/warming`);
    expect(res.status).toBe(202);
    expect(res.text).toContain('still being imported');
  });
});
