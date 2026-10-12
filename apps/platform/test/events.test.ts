/**
 * Push event dispatcher (architecture §11.5).
 *
 * Artifacts push events arrive on the kvarm-events queue. Each message is
 * ingested in one D1 batch (event row insert-or-ignore, delivery count,
 * monotonic pushed_at, guarded ref position, read-back); its effects then run
 * independently and each completion is recorded, so a redelivery runs only
 * what is still missing. Snapshot work dedupes on immutable identity while
 * every genuine transition keeps its own audit row.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mintPAT } from '../src/auth/pat';
import { refGeneration } from '../src/cache/compare';
import { COST_HEADER, parseCostHeader } from '../src/cost/meter';
import { eventIdentity, parsePushEvent, snapshotInstanceId } from '../src/services/events';
import worker from '../src/index';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'ev-owner';
const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);

/** In-memory SnapshotBuilder binding: instance ids are unique, like the real one. */
class FakeWorkflow {
  instances = new Map<string, unknown>();
  creates = 0;
  failNext = 0;
  async create(opts: { id?: string; params?: unknown }) {
    this.creates++;
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated workflow outage');
    }
    const id = opts.id ?? crypto.randomUUID();
    if (this.instances.has(id)) throw new Error(`instance.already_exists: ${id}`);
    this.instances.set(id, opts.params);
    return { id };
  }
  async get(id: string) {
    if (!this.instances.has(id)) throw new Error('instance.not_found');
    return { id };
  }
}

function envWith(wf: FakeWorkflow): Env {
  return { ...baseEnv, SNAPSHOT_BUILDER: wf as unknown as Env['SNAPSHOT_BUILDER'] } as Env;
}

let seq = 0;
function msgId(): string {
  return `msg-${++seq}-${crypto.randomUUID()}`;
}

function pushBody(repoName: string, ref: string, before: string, after: string, at: string | null) {
  const body: Record<string, unknown> = {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1 },
  };
  if (at) (body.metadata as Record<string, unknown>).eventTimestamp = at;
  return body;
}

interface Delivery {
  id?: string;
  body: unknown;
  attempts?: number;
}

async function deliver(env: Env, messages: Delivery[]) {
  const batch = createMessageBatch(
    'kvarm-events',
    messages.map((m) => ({ id: m.id ?? msgId(), timestamp: new Date(), attempts: m.attempts ?? 1, body: m.body })),
  );
  // getQueueResult does not report retry delays, so they are observed here.
  const delays = new Map<string, number | undefined>();
  for (const m of batch.messages) {
    const retry = m.retry.bind(m);
    m.retry = (opts?: QueueRetryOptions) => {
      delays.set(m.id, opts?.delaySeconds);
      retry(opts);
    };
  }
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  return { batch, result, delays };
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public', defaultBranch = 'main') {
  const id = crypto.randomUUID();
  const artifactsName = `${OWNER}--${name}`;
  await baseEnv.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, defaultBranch, Date.now())
    .run();
  return { id, artifactsName };
}

interface EventRow {
  id: string;
  ref: string;
  before_sha: string;
  after_sha: string;
  deliveries: number;
  event_at: number;
  completed_at: number | null;
}

async function events(repoId: string): Promise<EventRow[]> {
  const { results } = await baseEnv.DB.prepare('SELECT * FROM push_events WHERE repo_id = ? ORDER BY event_at, id')
    .bind(repoId)
    .all<EventRow>();
  return results ?? [];
}

async function effects(eventId: string): Promise<Record<string, { state: string; detail: string | null }>> {
  const { results } = await baseEnv.DB.prepare('SELECT effect, state, detail FROM push_event_effects WHERE event_id = ?')
    .bind(eventId)
    .all<{ effect: string; state: string; detail: string | null }>();
  return Object.fromEntries((results ?? []).map((r) => [r.effect, { state: r.state, detail: r.detail }]));
}

async function refRow(repoId: string, ref: string) {
  return baseEnv.DB.prepare('SELECT sha, event_id, event_at FROM repo_refs WHERE repo_id = ? AND ref = ?')
    .bind(repoId, ref)
    .first<{ sha: string; event_id: string; event_at: number }>();
}

async function pushedAt(repoId: string): Promise<number | null> {
  const row = await baseEnv.DB.prepare('SELECT pushed_at FROM repos WHERE id = ?').bind(repoId).first<{ pushed_at: number | null }>();
  return row?.pushed_at ?? null;
}

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-08T12:00:00.000Z');

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parsePushEvent / eventIdentity', () => {
  it('parses the documented Artifacts push event (account and repo-level sources)', () => {
    for (const type of ['artifacts', 'artifacts.repo']) {
      const body = pushBody('o--r', 'refs/heads/main', A, B, '2026-10-08T12:00:00.123Z');
      (body.source as Record<string, unknown>).type = type;
      expect(parsePushEvent(body)).toEqual({
        namespace: 'default',
        repoName: 'o--r',
        ref: 'refs/heads/main',
        before: A,
        after: B,
        eventAt: Date.parse('2026-10-08T12:00:00.123Z'),
        sourceId: null,
        source: type,
      });
    }
  });

  it('rejects other event types and malformed bodies', () => {
    expect(parsePushEvent({ ...pushBody('o--r', 'refs/heads/main', A, B, null), type: 'cf.artifacts.repo.created' })).toBeNull();
    expect(parsePushEvent(pushBody('o--r', 'refs/heads/main', 'xyz', B, null))).toBeNull();
    expect(parsePushEvent(pushBody('o--r', 'not-a-ref', A, B, null))).toBeNull();
    expect(parsePushEvent('{"type":"cf.artifacts.repo.pushed"}')).toBeNull();
    expect(parsePushEvent(null)).toBeNull();
  });

  it('uses the source timestamp for identity and falls back to the message id', async () => {
    const at = parsePushEvent(pushBody('o--r', 'refs/heads/main', A, B, iso(T0)))!;
    const later = parsePushEvent(pushBody('o--r', 'refs/heads/main', A, B, iso(T0 + 1)))!;
    const untimed = parsePushEvent(pushBody('o--r', 'refs/heads/main', A, B, null))!;
    expect(await eventIdentity(at, 'm1')).toBe(await eventIdentity(at, 'm2'));
    expect(await eventIdentity(at, 'm1')).not.toBe(await eventIdentity(later, 'm1'));
    expect(await eventIdentity(untimed, 'm1')).not.toBe(await eventIdentity(untimed, 'm2'));
    expect(await eventIdentity(untimed, 'm1')).toBe(await eventIdentity(untimed, 'm1'));
  });
});

describe('queue dispatcher', () => {
  it('ingests a default-branch push: ref position, pushed_at, purge and an eager snapshot', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('basic');
    const genBefore = await refGeneration(repo.id);
    const log = vi.spyOn(console, 'log');

    const { batch, result } = await deliver(env, [{ body: pushBody(repo.artifactsName, 'refs/heads/main', ZERO, A, iso(T0)) }]);

    expect(result.explicitAcks).toEqual([batch.messages[0]!.id]);
    expect(result.retryMessages).toEqual([]);
    const [ev] = await events(repo.id);
    expect(ev).toMatchObject({ ref: 'refs/heads/main', before_sha: ZERO, after_sha: A, deliveries: 1, event_at: T0 });
    expect(ev!.completed_at).not.toBeNull();
    expect(await refRow(repo.id, 'refs/heads/main')).toMatchObject({ sha: A, event_id: ev!.id });
    expect(await pushedAt(repo.id)).toBe(T0);
    expect(await refGeneration(repo.id)).not.toBe(genBefore);
    expect(await effects(ev!.id)).toMatchObject({
      purge: { state: 'done' },
      snapshot: { state: 'done', detail: `created ${snapshotInstanceId(repo.id, A)}` },
      'intent-index': { state: 'skipped' },
      'change-hooks': { state: 'skipped', detail: 'no open changes' },
    });
    expect([...wf.instances.keys()]).toEqual([snapshotInstanceId(repo.id, A)]);

    // One {cost} log line per message: the ingest batch plus the completion batch.
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('{"cost"'));
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { cost: { d1: number; art: number; do: number }; outcome: string; wf: number };
    expect(line.outcome).toBe('processed');
    expect(line.cost.d1).toBeLessThanOrEqual(2);
    expect(line.cost.art).toBe(0);
    expect(line.cost.do).toBe(0);
    expect(line.wf).toBe(1);
  });

  it('absorbs duplicate deliveries without duplicating effects', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('dupes');
    const body = pushBody(repo.artifactsName, 'refs/heads/main', ZERO, A, iso(T0));

    await deliver(env, [{ body }]);
    const gen = await refGeneration(repo.id);
    const log = vi.spyOn(console, 'log');
    // The same event redelivered: in a later batch, and twice within one batch.
    const again = await deliver(env, [{ body }]);
    const twice = await deliver(env, [{ body }, { body }]);

    expect(again.result.explicitAcks).toHaveLength(1);
    expect(twice.result.explicitAcks).toHaveLength(2);
    const rows = await events(repo.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveries).toBe(4);
    expect(wf.creates).toBe(1);
    expect(await refGeneration(repo.id)).toBe(gen);
    // A completed event costs the ingest batch only.
    const costs = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{"cost"'))
      .map((l) => JSON.parse(l) as { cost: { d1: number }; outcome: string });
    expect(costs).toHaveLength(3);
    for (const c of costs) {
      expect(c.outcome).toBe('duplicate');
      expect(c.cost.d1).toBe(1);
    }
  });

  it('retries with backoff when an effect fails and the replay finishes only the missing effect', async () => {
    const wf = new FakeWorkflow();
    wf.failNext = 1;
    const env = envWith(wf);
    const repo = await seedRepo('interrupted');
    const body = pushBody(repo.artifactsName, 'refs/heads/main', A, B, iso(T0));

    const first = await deliver(env, [{ id: 'interrupted-1', body, attempts: 1 }]);
    expect(first.result.explicitAcks).toEqual([]);
    expect(first.result.retryMessages).toHaveLength(1);
    expect(first.result.retryMessages[0]!.msgId).toBe('interrupted-1');
    const firstDelay = first.delays.get('interrupted-1')!;
    expect(firstDelay).toBeGreaterThan(0);

    const [ev] = await events(repo.id);
    expect(ev!.completed_at).toBeNull();
    expect(await effects(ev!.id)).toEqual({
      purge: { state: 'done', detail: null },
      'intent-index': expect.objectContaining({ state: 'skipped' }) as unknown,
      'change-hooks': { state: 'skipped', detail: 'no open changes' },
    });
    const gen = await refGeneration(repo.id);

    // A second failure backs off further.
    wf.failNext = 1;
    const second = await deliver(env, [{ id: 'interrupted-1', body, attempts: 2 }]);
    expect(second.result.retryMessages.map((m) => m.msgId)).toEqual(['interrupted-1']);
    expect(second.delays.get('interrupted-1')!).toBeGreaterThan(firstDelay);

    const replay = await deliver(env, [{ id: 'interrupted-1', body, attempts: 3 }]);
    expect(replay.result.explicitAcks).toEqual(['interrupted-1']);
    const [done] = await events(repo.id);
    expect(done!.deliveries).toBe(3);
    expect(done!.completed_at).not.toBeNull();
    expect((await effects(ev!.id)).snapshot).toEqual({ state: 'done', detail: `created ${snapshotInstanceId(repo.id, B)}` });
    // purge already completed: the replay did not run it again.
    expect(await refGeneration(repo.id)).toBe(gen);
    expect(wf.instances.size).toBe(1);

    // Replaying the finished event changes nothing.
    await deliver(env, [{ body }]);
    expect(wf.instances.size).toBe(1);
    expect((await events(repo.id))[0]!.deliveries).toBe(4);
  });

  it('keeps distinct audit rows for genuine A-B-A-B transitions while snapshots are reused', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('abab');
    const main = 'refs/heads/main';
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, ZERO, A, iso(T0)) }]);
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, A, B, iso(T0 + 1000)) }]);
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, B, A, iso(T0 + 2000)) }]);
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, A, B, iso(T0 + 3000)) }]);

    const rows = await events(repo.id);
    expect(rows.map((r) => `${r.before_sha[0]}>${r.after_sha[0]}`)).toEqual(['0>a', 'a>b', 'b>a', 'a>b']);
    const ab = rows.filter((r) => r.before_sha === A && r.after_sha === B);
    expect(ab).toHaveLength(2);
    expect(ab[0]!.id).not.toBe(ab[1]!.id);
    expect(ab[0]!.event_at).not.toBe(ab[1]!.event_at);
    expect(rows.every((r) => r.completed_at !== null && r.deliveries === 1)).toBe(true);

    expect([...wf.instances.keys()].sort()).toEqual([snapshotInstanceId(repo.id, A), snapshotInstanceId(repo.id, B)].sort());
    expect((await effects(rows[2]!.id)).snapshot).toEqual({ state: 'done', detail: `reused ${snapshotInstanceId(repo.id, A)}` });
    expect((await effects(rows[3]!.id)).snapshot).toEqual({ state: 'done', detail: `reused ${snapshotInstanceId(repo.id, B)}` });
    expect(await refRow(repo.id, main)).toMatchObject({ sha: B, event_id: rows[3]!.id });
  });

  it('never moves ref state or pushed_at backwards for out-of-order events', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('ooo');
    const main = 'refs/heads/main';
    // The newest event arrives first, the older one afterwards.
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, B, C, iso(T0 + 2000)) }]);
    await deliver(env, [{ body: pushBody(repo.artifactsName, main, A, B, iso(T0 + 1000)) }]);

    expect(await refRow(repo.id, main)).toMatchObject({ sha: C, event_at: T0 + 2000 });
    expect(await pushedAt(repo.id)).toBe(T0 + 2000);
    const rows = await events(repo.id);
    expect(rows).toHaveLength(2);
    const older = rows.find((r) => r.after_sha === B)!;
    expect((await effects(older.id)).snapshot).toEqual({ state: 'skipped', detail: 'superseded' });
    expect(older.completed_at).not.toBeNull();
    expect([...wf.instances.keys()]).toEqual([snapshotInstanceId(repo.id, C)]);

    // Same within one batch, in either order.
    const other = await seedRepo('ooo-batch');
    await deliver(env, [
      { body: pushBody(other.artifactsName, main, C, D, iso(T0 + 5000)) },
      { body: pushBody(other.artifactsName, main, B, C, iso(T0 + 4000)) },
    ]);
    expect(await refRow(other.id, main)).toMatchObject({ sha: D });
    expect(await pushedAt(other.id)).toBe(T0 + 5000);
  });

  for (const [label, at] of [
    ['no timestamp', null],
    ['an invalid timestamp', 'not-a-date'],
  ] as const) {
    it(`replays an untimed event (${label}) at its original position without rolling the ref back`, async () => {
      const wf = new FakeWorkflow();
      const env = envWith(wf);
      const repo = await seedRepo(`untimed-${at ?? 'none'}`);
      const main = 'refs/heads/main';
      const m1 = { id: `untimed-m1-${at ?? 'none'}`, body: pushBody(repo.artifactsName, main, ZERO, A, at) };
      const m2 = { id: `untimed-m2-${at ?? 'none'}`, body: pushBody(repo.artifactsName, main, A, B, at) };
      const now = vi.spyOn(Date, 'now');

      now.mockReturnValue(T0 + 1000);
      await deliver(env, [m1]);
      now.mockReturnValue(T0 + 2000);
      await deliver(env, [m2]);
      const gen = await refGeneration(repo.id);
      const log = vi.spyOn(console, 'log');
      now.mockReturnValue(T0 + 3000);
      const replay = await deliver(env, [{ ...m1, attempts: 2 }]);
      now.mockRestore();

      expect(replay.result.explicitAcks).toEqual([m1.id]);
      const rows = await events(repo.id);
      expect(rows.map((r) => [r.after_sha[0], r.event_at, r.deliveries])).toEqual([
        ['a', T0 + 1000, 2],
        ['b', T0 + 2000, 1],
      ]);
      expect(await refRow(repo.id, main)).toMatchObject({ sha: B, event_id: rows[1]!.id, event_at: T0 + 2000 });
      expect(await pushedAt(repo.id)).toBe(T0 + 2000);
      expect(await refGeneration(repo.id)).toBe(gen);
      expect([...wf.instances.keys()].sort()).toEqual([snapshotInstanceId(repo.id, A), snapshotInstanceId(repo.id, B)].sort());
      const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"cost"'))!;
      expect(JSON.parse(line)).toMatchObject({ outcome: 'duplicate', cost: { d1: 1 } });
    });
  }

  it('skips an interrupted untimed event superseded before its replay', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('untimed-interrupted');
    const main = 'refs/heads/main';
    const m1 = { id: 'untimed-int-m1', body: pushBody(repo.artifactsName, main, ZERO, A, null) };
    const m2 = { id: 'untimed-int-m2', body: pushBody(repo.artifactsName, main, A, B, null) };
    const now = vi.spyOn(Date, 'now');

    now.mockReturnValue(T0 + 1000);
    wf.failNext = 1;
    const first = await deliver(env, [m1]);
    expect(first.result.retryMessages.map((m) => m.msgId)).toEqual([m1.id]);
    now.mockReturnValue(T0 + 2000);
    await deliver(env, [m2]);
    now.mockReturnValue(T0 + 3000);
    const replay = await deliver(env, [{ ...m1, attempts: 2 }]);
    now.mockRestore();

    expect(replay.result.explicitAcks).toEqual([m1.id]);
    const rows = await events(repo.id);
    expect(rows.map((r) => r.after_sha[0])).toEqual(['a', 'b']);
    expect(await refRow(repo.id, main)).toMatchObject({ sha: B, event_id: rows[1]!.id });
    expect(await pushedAt(repo.id)).toBe(T0 + 2000);
    expect((await effects(rows[0]!.id)).snapshot).toEqual({ state: 'skipped', detail: 'superseded' });
    expect(rows[0]!.completed_at).not.toBeNull();
    expect([...wf.instances.keys()]).toEqual([snapshotInstanceId(repo.id, B)]);
  });

  it('does not lower a pushed_at that the git gate already advanced', async () => {
    const env = envWith(new FakeWorkflow());
    const repo = await seedRepo('gate-ahead');
    await baseEnv.DB.prepare('UPDATE repos SET pushed_at = ? WHERE id = ?').bind(T0 + 9000, repo.id).run();
    await deliver(env, [{ body: pushBody(repo.artifactsName, 'refs/heads/main', ZERO, A, iso(T0)) }]);
    expect(await pushedAt(repo.id)).toBe(T0 + 9000);
  });

  it('acks and ignores unknown repos and malformed messages; later messages still process', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('after-unknown');
    const log = vi.spyOn(console, 'log');
    const otherNamespace = {
      ...pushBody(repo.artifactsName, 'refs/heads/main', ZERO, B, iso(T0 + 1000)),
      source: { type: 'artifacts', namespace: 'elsewhere', repoName: repo.artifactsName },
    };
    const { batch, result } = await deliver(env, [
      { body: pushBody('val-orphans-123', 'refs/heads/main', ZERO, A, iso(T0)) },
      { body: { type: 'cf.artifacts.repo.created', source: { type: 'artifacts', namespace: 'default', repoName: 'x' } } },
      { body: 'not json at all' },
      { body: otherNamespace },
      { body: pushBody(repo.artifactsName, 'refs/heads/main', ZERO, A, iso(T0)) },
    ]);
    expect(result.explicitAcks).toEqual(batch.messages.map((m) => m.id));
    expect(result.retryMessages).toEqual([]);
    const orphan = await baseEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM push_events WHERE repo_id NOT IN (SELECT id FROM repos)",
    ).first<{ n: number }>();
    expect(orphan!.n).toBe(0);
    expect(await events(repo.id)).toHaveLength(1);
    expect(wf.instances.size).toBe(1);
    const outcomes = log.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{"cost"'))
      .map((l) => (JSON.parse(l) as { outcome: string; cost: { d1: number } }));
    expect(outcomes.map((o) => o.outcome)).toEqual(['unknown-repo', 'ignored', 'ignored', 'unknown-repo', 'processed']);
    expect(outcomes[0]!.cost.d1).toBe(1);
    expect(outcomes[1]!.cost.d1).toBe(0);
    expect(outcomes[3]!.cost.d1).toBe(0);
    expect((await refRow(repo.id, 'refs/heads/main'))?.sha).toBe(A);
  });

  it('builds snapshots lazily for non-default and workspace refs, and skips deleted refs', async () => {
    const wf = new FakeWorkflow();
    const env = envWith(wf);
    const repo = await seedRepo('lazy', 'public', 'trunk');
    await deliver(env, [
      { body: pushBody(repo.artifactsName, 'refs/heads/main', ZERO, A, iso(T0)) },
      { body: pushBody(repo.artifactsName, 'refs/heads/agents/ws1/fix', ZERO, B, iso(T0 + 1)) },
      { body: pushBody(repo.artifactsName, 'refs/heads/trunk', A, ZERO, iso(T0 + 2)) },
    ]);
    const rows = await events(repo.id);
    expect(rows).toHaveLength(3);
    const byRef = Object.fromEntries(await Promise.all(rows.map(async (r) => [r.ref, await effects(r.id)] as const)));
    expect(byRef['refs/heads/main']!.snapshot).toEqual({ state: 'skipped', detail: 'lazy: not the default branch' });
    expect(byRef['refs/heads/agents/ws1/fix']!.snapshot).toEqual({ state: 'skipped', detail: 'lazy: not the default branch' });
    expect(byRef['refs/heads/agents/ws1/fix']!['intent-index']).toEqual({ state: 'skipped', detail: 'no workspace for this ref' });
    expect(byRef['refs/heads/main']!['intent-index']).toEqual({ state: 'skipped', detail: 'not a workspace ref' });
    expect(byRef['refs/heads/trunk']!.snapshot).toEqual({ state: 'skipped', detail: 'ref deleted' });
    expect(wf.instances.size).toBe(0);
    expect(await refRow(repo.id, 'refs/heads/trunk')).toMatchObject({ sha: ZERO });
  });
});

describe('GET /api/v1/repos/:o/:r/events', () => {
  let token = '';
  let pub: { id: string; artifactsName: string };
  let priv: { id: string; artifactsName: string };

  beforeAll(async () => {
    const userId = crypto.randomUUID();
    await baseEnv.DB.prepare(
      'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    )
      .bind(userId, `test:${OWNER}`, OWNER, `${OWNER}@kvarm.invalid`, OWNER, Date.now())
      .run();
    token = (await mintPAT(baseEnv, userId, 'events', ['read', 'write', 'api'])).token;
    pub = await seedRepo('api-public');
    priv = await seedRepo('api-private', 'private');
    const env = envWith(new FakeWorkflow());
    const main = 'refs/heads/main';
    await deliver(env, [
      { body: pushBody(pub.artifactsName, main, ZERO, A, iso(T0)) },
      { body: pushBody(pub.artifactsName, main, A, B, iso(T0 + 1000)) },
      { body: pushBody(pub.artifactsName, main, B, A, iso(T0 + 2000)) },
      { body: pushBody(pub.artifactsName, main, A, B, iso(T0 + 3000)) },
      { body: pushBody(priv.artifactsName, main, ZERO, A, iso(T0)) },
    ]);
  });

  async function get(path: string, auth = true) {
    const ctx = createExecutionContext();
    const req = new Request(`${ORIGIN}/api/v1/repos/${OWNER}/${path}`, {
      headers: auth ? { Authorization: `Bearer ${token}` } : {},
    });
    const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, baseEnv, ctx);
    await waitOnExecutionContext(ctx);
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, cost: parseCostHeader(res.headers.get(COST_HEADER))! };
  }

  interface ApiEvent {
    id: string;
    ref: string;
    before: string;
    after: string;
    deliveries: number;
    eventAt: string;
    receivedAt: string;
    completedAt: string | null;
    effects: { effect: string; state: string; detail: string | null; completedAt: string }[];
  }

  it('lists events newest first with effects, distinguishing repeated transitions', async () => {
    const r = await get('api-public/events', false);
    expect(r.status).toBe(200);
    const list = r.body.events as ApiEvent[];
    expect(list.map((e) => `${e.before[0]}>${e.after[0]}`)).toEqual(['a>b', 'b>a', 'a>b', '0>a']);
    expect(list[0]!.eventAt).toBe(iso(T0 + 3000));
    expect(list[2]!.eventAt).toBe(iso(T0 + 1000));
    expect(list[0]!.id).not.toBe(list[2]!.id);
    expect(list[0]!.completedAt).toMatch(/Z$/);
    expect(list[0]!.effects.map((e) => e.effect).sort()).toEqual(['change-hooks', 'intent-index', 'purge', 'snapshot']);
    expect(r.body.nextCursor).toBeNull();
    expect(r.cost.d1).toBeLessThanOrEqual(2);
    expect(r.cost.art).toBe(0);
    expect(r.cost.do).toBe(0);
  });

  it('paginates with limit and cursor', async () => {
    const first = await get('api-public/events?limit=3');
    expect((first.body.events as ApiEvent[]).length).toBe(3);
    expect(typeof first.body.nextCursor).toBe('string');
    const second = await get(`api-public/events?limit=3&cursor=${encodeURIComponent(first.body.nextCursor as string)}`);
    const ids = [...(first.body.events as ApiEvent[]), ...(second.body.events as ApiEvent[])].map((e) => e.id);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(second.body.nextCursor).toBeNull();
  });

  it('validates limit and cursor', async () => {
    expect((await get('api-public/events?limit=0')).body.code).toBe('INVALID_LIMIT');
    expect((await get('api-public/events?limit=101')).body.code).toBe('INVALID_LIMIT');
    expect((await get('api-public/events?cursor=%%%')).body.code).toBe('INVALID_CURSOR');
  });

  it('conceals private repos from anonymous callers and serves the owner', async () => {
    const anon = await get('api-private/events', false);
    expect(anon.status).toBe(404);
    expect(anon.body).toEqual({ error: 'not found', code: 'NOT_FOUND' });
    expect(anon.cost.d1).toBe(1);
    const owner = await get('api-private/events');
    expect(owner.status).toBe(200);
    expect((owner.body.events as ApiEvent[]).length).toBe(1);
  });
});
