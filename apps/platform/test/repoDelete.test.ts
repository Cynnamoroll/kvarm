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
import { listReposForOwner } from '../src/db/repos';
import { handleEventBatch } from '../src/services/events';
import { sweepRepoPurges } from '../src/services/repoPurge';
import { fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
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
    if (table === 'repo_purges') continue;
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
      await env.SNAPSHOTS.put(`snapshot/${repoId}/tree`, 'snapshot');
    }
    seeded.add(table);
  }
  expect([...seeded].sort()).toEqual(repoTables.filter((table) => table !== 'repo_purges').sort());
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
    r2_key: table === 'snapshot_trees' ? `snapshot/${repoId}/tree` : `snapshot/${table}`,
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
    for (const prefix of ['replica', 'fetch', 'bundles']) {
      await env.SNAPSHOTS.put(`${prefix}/${id}/object`, prefix);
    }
    const repoTables = await populateRepoTables(id, sha, userId);
    const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?').bind(id).first<{ artifacts_name: string }>();
    const historyStub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(id));
    await runInDurableObject(historyStub, async (_obj, state) => {
      state.storage.sql.exec(
        `INSERT INTO state(epoch,repo_name,ref,head_sha,head_seq,tail_next,tail_seq,gaps,known_sha,known_at,memo_at,updated_at)
         VALUES(1,?,'refs/heads/main',?,0,NULL,0,0,?,?,0,?)`,
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
    expect(failedInline).toMatchObject({ done_at: null, attempts: 1, last_error: 'artifacts:Error' });
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
