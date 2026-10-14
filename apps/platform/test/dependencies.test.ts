/**
 * Nexus pinned draft dependencies (services/dependencies.ts) through the
 * Worker's routes, the push queue and the integration train, over the
 * in-memory Artifacts fake. Train runs are driven directly with recorded
 * kicks, as in queue.test.ts.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decode } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { CostMeter, runWithMeter, type CostCounters } from '../src/cost/meter';
import { INTENT_PREFIX, mergeLockAlarm, type MergeLock, type SettleIntent } from '../src/do/mergeLock';
import worker from '../src/index';
import type { ChecksGate, CheckState } from '../src/services/checksGate';
import { DEPENDENCY_LIMITS, SETTLE_INTENT, SETTLE_LIMITS, WAKE_KIND, wakeClaimStatements, wakeSetOf } from '../src/services/dependencyGate';
import { TRAIN_LIMITS, defaultTrainDeps, fairOrder, runTrain, type TrainDeps, type TrainEvent } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';
import { call as apiCall, type Reply } from './helpers/http';
import { FakeWorkflow, recordingEvents, seedRepoWithCommit, seedUser as seedUserBase } from './helpers/seed';

const fakeEvents = recordingEvents();
const sent = fakeEvents.sent;
const failSends = fakeEvents.failSends;
const onSend = fakeEvents.onSend;
const seedUser = (login: string) => seedUserBase(env, login, { userIds });
const seedRepo = async (name: string) => { const { repo, main } = await seedRepoWithCommit(env, name, { owner: OWNER, visibility: 'public', repoIds }); repos[name] = repo; return { repo, main }; };
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'dep-owner';
const MAIN = 'refs/heads/main';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', writer: '' };
const repoIds: Record<string, string> = {};
const userIds: Record<string, string> = {};
const repos: Record<string, FakeRepo> = {};

/** A public repo whose main holds README.md. */

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const deps = (repo: string, ws: string) => api(repo, `/workspaces/${ws}/dependencies`);
const pin = (repo: string, ws: string, onWorkspace: string, revision: string, token = tok.owner) =>
  call('POST', deps(repo, ws), token, { onWorkspace, revision });
const listDeps = (repo: string, ws: string, token: string | undefined = tok.owner) => call('GET', deps(repo, ws), token);
const repin = (repo: string, ws: string, id: string, body: unknown) => call('POST', `${deps(repo, ws)}/${id}/repin`, tok.owner, body);
const detach = (repo: string, ws: string, id: string) => call('DELETE', `${deps(repo, ws)}/${id}`, tok.owner);
const enqueue = (repo: string, n: number, token = tok.owner) => call('POST', api(repo, `/changes/${n}/enqueue`), token);
const merge = (repo: string, n: number) => call('POST', api(repo, `/changes/${n}/merge`), tok.owner);
const getChange = (repo: string, n: number) => call('GET', api(repo, `/changes/${n}`), tok.owner);
const trainStatus = (repo: string, q = '') => call('GET', api(repo, `/train${q}`), tok.owner);

interface Ws {
  id: string;
  ref: string;
  head: string;
  change?: number;
}

function pushEvent(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliverRaw(body: unknown) {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  return result;
}

async function deliver(body: unknown) {
  expect((await deliverRaw(body)).explicitAcks).toHaveLength(1);
}

// The landing's durable settlement owner: the MergeLock of the landing's repo + target ref.
const lockOf = (name: string, ref = MAIN) => env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(`${repoIds[name]}:${ref}`));

async function intentsOf(name: string): Promise<SettleIntent[]> {
  return runInDurableObject(lockOf(name), async (_obj, state) => [...(await state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX })).values()]);
}

async function alarmOf(name: string): Promise<number | null> {
  return runInDurableObject(lockOf(name), async (_obj, state) => state.storage.getAlarm());
}

/** One owner wakeup: makes the pending intents due and runs the alarm; false when no intent was pending. */
async function fireOwner(name: string): Promise<boolean> {
  return runInDurableObject(lockOf(name), async (obj: MergeLock, state) => {
    const all = await state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX });
    if (all.size === 0) return false;
    for (const [key, intent] of all) await state.storage.put(key, { ...intent, deadline: Date.now() - 1 });
    await obj.alarm();
    return true;
  });
}

async function wakeMarks(name: string): Promise<number> {
  const prefix = `${repoIds[name]}/`;
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM fenced_claims WHERE kind = ?1 AND subject >= ?2 AND subject < ?3')
    .bind(WAKE_KIND, prefix, `${prefix.slice(0, -1)}0`)
    .first<{ n: number }>())!.n;
}

async function claimExpiry(name: string): Promise<number | null> {
  const prefix = `${repoIds[name]}/`;
  return (await env.DB.prepare(`SELECT MIN(expires_at) AS t FROM fenced_claims WHERE kind = ?1 AND subject >= ?2 AND subject < ?3 AND state = 'claimed'`)
    .bind(WAKE_KIND, prefix, `${prefix.slice(0, -1)}0`)
    .first<{ t: number | null }>())!.t;
}

/** Lets every live claim on the repo's wake marks lapse, as if its owner never came back. */
async function expireClaims(name: string): Promise<void> {
  const prefix = `${repoIds[name]}/`;
  await env.DB.prepare(`UPDATE fenced_claims SET expires_at = ?4 WHERE kind = ?1 AND subject >= ?2 AND subject < ?3 AND state = 'claimed'`)
    .bind(WAKE_KIND, prefix, `${prefix.slice(0, -1)}0`, Date.now() - 1)
    .run();
}

/** The statement that claims a landing's wake marks, and the one that confirms them (deletes them after their effect). */
const CLAIM_SQL = "UPDATE fenced_claims SET state = 'claimed'";
const CONFIRM_SQL = `DELETE FROM fenced_claims WHERE kind = '${WAKE_KIND}'`;

/**
 * A D1 binding whose statements matching `fails` reject (alone or inside a batch) while `budget.left` lasts; every other
 * statement reaches the real database. An injected storage fault, not a production switch.
 */
function faultyDb(real: D1Database, fails: (sql: string) => boolean, budget = { left: Number.POSITIVE_INFINITY }): D1Database {
  const inner = new WeakMap<object, D1PreparedStatement>();
  const boom = () => {
    budget.left--;
    return Promise.reject(new Error('D1 statement failed (test)'));
  };
  const failing = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        if (k === 'bind') return (...args: unknown[]) => failing(t.bind(...args));
        if ((k === 'run' || k === 'all' || k === 'first' || k === 'raw') && budget.left > 0) return boom;
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    inner.set(p, s);
    return p;
  };
  return new Proxy(real, {
    get(t, k) {
      if (k === 'prepare') return (sql: string) => (fails(sql) ? failing(t.prepare(sql)) : t.prepare(sql));
      if (k === 'batch') {
        return (stmts: D1PreparedStatement[]) => (stmts.some((s) => inner.has(s)) && budget.left > 0 ? boom() : t.batch(stmts.map((s) => inner.get(s) ?? s)));
      }
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

let clock = Date.now();

/** Moves a ref to a new commit (as a git push would) and delivers its push event. */
async function push(name: string, ref: string, files: Files, parents: string[]): Promise<string> {
  const repo = repos[name]!;
  const before = repo.refs.get(ref) ?? '0'.repeat(40);
  const c = await commit(repo, files, parents);
  repo.refs.set(ref, c.sha);
  clock += 1000;
  await deliver(pushEvent(name, ref, before, c.sha, clock));
  return c.sha;
}

/** A workspace with one pushed commit adding `<file>`; optionally a change set opened from it. */
async function workspace(name: string, file: string, opts: { change?: 'review' | 'auto' | false; token?: string; base?: string } = {}): Promise<Ws> {
  const created = await call('POST', api(name, '/workspaces'), opts.token ?? tok.owner, { task: `work on ${file}`, agent: 'agent', ...(opts.base ? { base: opts.base } : {}) });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const { id, ref, baseSha } = created.json as { id: string; ref: string; baseSha: string };
  const head = await push(name, ref, { 'README.md': 'readme\n', [file]: `${file}\n` }, [baseSha]);
  const ws: Ws = { id, ref, head };
  if (opts.change !== false && opts.change !== undefined) {
    const ch = await call('POST', api(name, `/workspaces/${id}/change-set`), opts.token ?? tok.owner, {
      title: `Change ${file}`,
      mergePolicy: opts.change,
      ...(opts.base ? { base: opts.base } : {}),
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    ws.change = ch.json.number as number;
  }
  return ws;
}

function commitOf(repo: FakeRepo, sha: string): { tree: string; parents: string[] } {
  const o = repo.objects.get(sha);
  expect(o?.type).toBe('commit');
  const head = decode(o!.content).split('\n\n')[0]!;
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
  };
}

function isAncestorOf(repo: FakeRepo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    stack.push(...commitOf(repo, sha).parents);
  }
  return false;
}

function firstParents(repo: FakeRepo, stop: string, ref = MAIN): string[] {
  const out: string[] = [];
  let sha = repo.refs.get(ref);
  while (sha && sha !== stop) {
    out.push(sha);
    sha = commitOf(repo, sha).parents[0];
  }
  return out;
}

function scriptedGate(fallback: CheckState = 'success') {
  const states = new Map<string, CheckState>();
  const s: { fallback: CheckState; states: Map<string, CheckState>; gate: ChecksGate } = {
    fallback,
    states,
    gate: {
      async requiredChecksFor(_repo, treeSha, configId) {
        const state: CheckState = states.get(treeSha) ?? s.fallback;
        return { treeSha, configId, required: [{ name: 'ci/test', state, producer: 'test' }], state };
      },
    } as ChecksGate,
  };
  return s;
}

function trainDeps(over: Partial<TrainDeps> = {}): TrainDeps & { events: TrainEvent[] } {
  const events: TrainEvent[] = [];
  return {
    ...defaultTrainDeps,
    kick: async (_env, repoId, ref, reason, delaySeconds) => {
      sent.push({ body: { type: 'kvarm.train', repoId, ref, reason }, ...(delaySeconds ? { delaySeconds } : {}) });
    },
    observe: (e) => events.push(e),
    events,
    ...over,
  };
}

async function rows(name: string): Promise<Array<{ change_number: number; state: string; active: number; reason_code: string | null; merge_commit: string | null }>> {
  return (
    (
      await env.DB.prepare('SELECT change_number, state, active, reason_code, merge_commit FROM merge_queue WHERE repo_id = ? ORDER BY seq')
        .bind(repoIds[name])
        .all<{ change_number: number; state: string; active: number; reason_code: string | null; merge_commit: string | null }>()
    ).results ?? []
  );
}

const savedIntent = { ...SETTLE_INTENT };
const savedAlarmEnv = mergeLockAlarm.env;

beforeAll(async () => {
  installFakeGitRemote();
  // Owner wakeups are driven explicitly (fireOwner); no settlement alarm comes due on its own during the run.
  SETTLE_INTENT.delayMs = 3_600_000;
  SETTLE_INTENT.stepMs = 3_600_000;
  mergeLockAlarm.env = () => env;
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.writer = (await mintPAT(env, await seedUser('dep-writer'), 'writer', FULL)).token;
});

afterAll(() => {
  restoreFetch();
  Object.assign(SETTLE_INTENT, savedIntent);
  mergeLockAlarm.env = savedAlarmEnv;
});

afterEach(() => {
  sent.length = 0;
  failSends.match = null;
  onSend.fn = null;
});

// ---------------------------------------------------------------------------

describe('explicit pins', () => {
  it('creates an exact-revision pin only on request and lists it with its state and depth', async () => {
    await seedRepo('pin');
    const a = await workspace('pin', 'a.txt');
    const b = await workspace('pin', 'b.txt');
    const c = await workspace('pin', 'c.txt');

    const created = await pin('pin', b.id, a.id, a.head);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json).toMatchObject({ workspaceId: b.id, onWorkspace: a.id, revision: a.head, state: 'active', depth: 2, sourceHead: a.head });
    expect(created.json.id).toEqual(expect.any(String));
    expect(created.cost.d1).toBeLessThanOrEqual(3);
    expect(created.cost.rr).toBeLessThanOrEqual(16);
    expect(created.cost.do).toBe(0);

    const listed = await listDeps('pin', b.id);
    expect(listed.status).toBe(200);
    expect(listed.json.dependencies).toEqual([created.json]);
    // Nothing is inferred: C has no edge, and neither has A.
    expect((await listDeps('pin', c.id)).json.dependencies).toEqual([]);
    expect((await listDeps('pin', a.id)).json.dependencies).toEqual([]);

    const warm = await listDeps('pin', b.id);
    expect(warm.cost).toMatchObject({ art: 0, do: 0, rw: 0 });
    expect(warm.cost.d1).toBeLessThanOrEqual(3);
  });

  it('refuses a missing, malformed or non-current revision and an unknown source, creating nothing', async () => {
    await seedRepo('bad-pin');
    const a = await workspace('bad-pin', 'a.txt');
    const b = await workspace('bad-pin', 'b.txt');
    const cases: Array<[unknown, number, string]> = [
      [{ onWorkspace: a.id }, 422, 'INVALID_REVISION'],
      [{ onWorkspace: a.id, revision: 'abc' }, 422, 'INVALID_REVISION'],
      [{ onWorkspace: a.id, revision: 'f'.repeat(40) }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: a.head }, 422, 'INVALID_WORKSPACE'],
      [{ onWorkspace: 'nope0000', revision: a.head }, 404, 'SOURCE_NOT_FOUND'],
      [{ onWorkspace: b.id, revision: b.head }, 422, 'DEPENDENCY_CYCLE'],
      [[1], 400, 'INVALID_BODY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('POST', deps('bad-pin', b.id), tok.owner, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
      expect(r.json.error).toEqual(expect.any(String));
    }
    const notCurrent = await pin('bad-pin', b.id, a.id, 'f'.repeat(40));
    expect(notCurrent.json).toMatchObject({ currentRevision: a.head });
    expect((await call('POST', deps('bad-pin', 'nope0000'), tok.owner, { onWorkspace: a.id, revision: a.head })).json.code).toBe('WORKSPACE_NOT_FOUND');
    expect((await listDeps('bad-pin', b.id)).json.dependencies).toEqual([]);
    // Writers only; readers may list.
    expect((await pin('bad-pin', b.id, a.id, a.head, tok.writer)).status).toBe(403);
    expect((await listDeps('bad-pin', b.id, undefined)).status).toBe(200);
    expect((await pin('bad-pin', b.id, a.id, a.head)).status).toBe(201);
    const dup = await pin('bad-pin', b.id, a.id, a.head);
    expect([dup.status, dup.json.code]).toEqual([409, 'DEPENDENCY_EXISTS']);
  });

  it('caps the chain at depth 4 with an actionable error, and a detach makes room again', async () => {
    await seedRepo('depth');
    const d = [];
    for (let i = 1; i <= 6; i++) d.push(await workspace('depth', `d${i}.txt`));
    const [d1, d2, d3, d4, d5, d6] = d as [Ws, Ws, Ws, Ws, Ws, Ws];
    expect((await pin('depth', d2.id, d1.id, d1.head)).json.depth).toBe(2);
    const e32 = await pin('depth', d3.id, d2.id, d2.head);
    expect(e32.json.depth).toBe(3);
    const e43 = await pin('depth', d4.id, d3.id, d3.head);
    expect(e43.status).toBe(201);
    expect(e43.json.depth).toBe(4);
    expect((await listDeps('depth', d4.id)).json.dependencies.map((e: any) => e.depth)).toEqual([4]);

    const deep = await pin('depth', d5.id, d4.id, d4.head);
    expect(deep.status).toBe(422);
    expect(deep.json).toMatchObject({ code: 'DEPENDENCY_DEPTH_EXCEEDED', maxDepth: 4, depth: 5, path: [d5.id, d4.id, d3.id, d2.id, d1.id] });
    expect(deep.json.error).toContain('4');
    expect(deep.cost.d1).toBeLessThanOrEqual(3);
    expect((await listDeps('depth', d5.id)).json.dependencies).toEqual([]);
    // Lengthening the chain from below is refused the same way.
    const below = await pin('depth', d1.id, d6.id, d6.head);
    expect([below.status, below.json.code]).toEqual([422, 'DEPENDENCY_DEPTH_EXCEEDED']);

    const off = await detach('depth', d3.id, e32.json.id);
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ detached: true, dependency: { id: e32.json.id } });
    expect((await listDeps('depth', d4.id)).json.dependencies.map((e: any) => e.depth)).toEqual([2]);
    const again = await pin('depth', d5.id, d4.id, d4.head);
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect(again.json.depth).toBe(3);
  });

  it('rejects two- and three-node cycles naming the offending path, leaving every list unchanged', async () => {
    await seedRepo('cycle');
    const a = await workspace('cycle', 'a.txt');
    const b = await workspace('cycle', 'b.txt');
    const c = await workspace('cycle', 'c.txt');
    expect((await pin('cycle', b.id, a.id, a.head)).status).toBe(201);
    const two = await pin('cycle', a.id, b.id, b.head);
    expect(two.status).toBe(422);
    expect(two.json).toMatchObject({ code: 'DEPENDENCY_CYCLE', path: [a.id, b.id, a.id] });
    expect(two.json.error).toContain(`${a.id} -> ${b.id} -> ${a.id}`);
    expect((await listDeps('cycle', a.id)).json.dependencies).toEqual([]);
    expect((await listDeps('cycle', b.id)).json.dependencies).toHaveLength(1);

    expect((await pin('cycle', c.id, b.id, b.head)).status).toBe(201);
    const three = await pin('cycle', a.id, c.id, c.head);
    expect(three.status).toBe(422);
    expect(three.json).toMatchObject({ code: 'DEPENDENCY_CYCLE', path: [a.id, c.id, b.id, a.id] });
    expect((await listDeps('cycle', a.id)).json.dependencies).toEqual([]);
  });

  it('refuses a cross-repo source with no side effect in either repo', async () => {
    const one = await seedRepo('cross-one');
    await seedRepo('cross-two');
    const w1 = await workspace('cross-one', 'w1.txt');
    const w2 = await workspace('cross-two', 'w2.txt');
    const refsBefore = [...one.repo.refs.entries()];
    const r = await pin('cross-two', w2.id, w1.id, w1.head);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('SOURCE_NOT_FOUND');
    expect(r.json.error).toContain('same repository');
    expect((await listDeps('cross-two', w2.id)).json.dependencies).toEqual([]);
    expect((await listDeps('cross-one', w1.id)).json.dependencies).toEqual([]);
    expect([...one.repo.refs.entries()]).toEqual(refsBefore);
  });

  it('a concurrent pin cannot combine with another into a chain deeper than 4', async () => {
    const { repo } = await seedRepo('race-depth');
    const w: Ws[] = [];
    for (let i = 1; i <= 5; i++) w.push(await workspace('race-depth', `w${i}.txt`));
    const [w1, w2, w3, w4, w5] = w as [Ws, Ws, Ws, Ws, Ws];
    expect((await pin('race-depth', w1.id, w2.id, w2.head)).status).toBe(201);
    expect((await pin('race-depth', w2.id, w3.id, w3.head)).status).toBe(201);
    // w3 -> w4 (a 4-chain) and w4 -> w5 are each valid alone; together they make w1..w5.
    let other: Reply | null = null;
    let armed = true;
    repo.hook = async (call) => {
      if (call !== 'lsRefs' || !armed) return;
      armed = false;
      other = await pin('race-depth', w4.id, w5.id, w5.head);
    };
    const first = await pin('race-depth', w3.id, w4.id, w4.head);
    repo.hook = null;
    expect(other!.status, JSON.stringify(other!.json)).toBe(201);
    expect(first.status, JSON.stringify(first.json)).toBeGreaterThanOrEqual(409);
    expect(['DEPENDENCY_CONFLICT', 'DEPENDENCY_DEPTH_EXCEEDED']).toContain(first.json.code);
    expect((await listDeps('race-depth', w3.id)).json.dependencies).toEqual([]);
    const retry = await pin('race-depth', w3.id, w4.id, w4.head);
    expect([retry.status, retry.json.code]).toEqual([422, 'DEPENDENCY_DEPTH_EXCEEDED']);
  });

  it('a repin onto a deeper source is bounded by the depth cap at the write', async () => {
    const { repo } = await seedRepo('race-repin');
    const w: Ws[] = [];
    for (let i = 1; i <= 5; i++) w.push(await workspace('race-repin', `w${i}.txt`));
    const [w1, w2, w3, w4, w5] = w as [Ws, Ws, Ws, Ws, Ws];
    expect((await pin('race-repin', w1.id, w2.id, w2.head)).status).toBe(201);
    const edge = (await pin('race-repin', w2.id, w3.id, w3.head)).json;
    expect((await pin('race-repin', w4.id, w5.id, w5.head)).status).toBe(201);
    // Repin w2 -> w4 (w1 w2 w4 w5: 4) while w5 concurrently gains a source (w1 w2 w4 w5 w6: 5).
    const w6 = await workspace('race-repin', 'w6.txt');
    let armed = true;
    let other: Reply | null = null;
    repo.hook = async (call) => {
      if (call !== 'lsRefs' || !armed) return;
      armed = false;
      other = await pin('race-repin', w5.id, w6.id, w6.head);
    };
    const moved = await repin('race-repin', w2.id, edge.id, { onWorkspace: w4.id, revision: w4.head });
    repo.hook = null;
    expect(other!.status, JSON.stringify(other!.json)).toBe(201);
    expect(moved.status, JSON.stringify(moved.json)).toBeGreaterThanOrEqual(409);
    expect((await listDeps('race-repin', w2.id)).json.dependencies).toEqual([expect.objectContaining({ onWorkspace: w3.id })]);
  });

  it('concurrent pins cannot exceed the direct-dependency limit', async () => {
    const { repo } = await seedRepo('race-direct');
    const dep = await workspace('race-direct', 'dep.txt');
    const sources: Ws[] = [];
    for (let i = 0; i < 9; i++) sources.push(await workspace('race-direct', `s${i}.txt`));
    for (let i = 0; i < 7; i++) expect((await pin('race-direct', dep.id, sources[i]!.id, sources[i]!.head)).status).toBe(201);
    let armed = true;
    let other: Reply | null = null;
    repo.hook = async (call) => {
      if (call !== 'lsRefs' || !armed) return;
      armed = false;
      other = await pin('race-direct', dep.id, sources[8]!.id, sources[8]!.head);
    };
    const first = await pin('race-direct', dep.id, sources[7]!.id, sources[7]!.head);
    repo.hook = null;
    expect(other!.status).toBe(201);
    expect(first.status).toBeGreaterThanOrEqual(409);
    expect((await listDeps('race-direct', dep.id)).json.dependencies).toHaveLength(8);
  });

  it('a chain walk past its path budget fails closed instead of trusting a partial walk', async () => {
    await seedRepo('wide');
    const saved = DEPENDENCY_LIMITS.walkMax;
    try {
      const d = await workspace('wide', 'd.txt');
      const x1 = await workspace('wide', 'x1.txt');
      const x2 = await workspace('wide', 'x2.txt');
      const z = await workspace('wide', 'z.txt');
      const y = await workspace('wide', 'y.txt');
      const s = await workspace('wide', 's.txt');
      const t = await workspace('wide', 't.txt');
      for (const [a, b] of [[x1, d], [x2, d], [z, d], [y, z], [s, t]] as const) expect((await pin('wide', a.id, b.id, b.head)).status).toBe(201);
      DEPENDENCY_LIMITS.walkMax = 2;
      // Above d: x1, x2 and y -> z -> d (three paths); d -> s -> t would make y z d s t, five long.
      const r = await pin('wide', d.id, s.id, s.head);
      expect(r.status, JSON.stringify(r.json)).toBe(422);
      expect(['DEPENDENCY_GRAPH_TOO_WIDE', 'DEPENDENCY_DEPTH_EXCEEDED']).toContain(r.json.code);
      expect(r.json.error).toContain(d.id);
      expect((await listDeps('wide', d.id)).json.dependencies).toEqual([]);
    } finally {
      DEPENDENCY_LIMITS.walkMax = saved;
    }
  });

  it('validates and lists with work independent of unrelated workspaces', async () => {
    await seedRepo('cost-small');
    await seedRepo('cost-big');
    const measure = async (name: string) => {
      const chain: Ws[] = [];
      for (let i = 1; i <= 4; i++) chain.push(await workspace(name, `c${i}.txt`));
      for (let i = 1; i < 4; i++) expect((await pin(name, chain[i]!.id, chain[i - 1]!.id, chain[i - 1]!.head)).status).toBe(201);
      const extra = await workspace(name, 'x.txt');
      const create = await pin(name, extra.id, chain[0]!.id, chain[0]!.head);
      const reject = await pin(name, extra.id, chain[3]!.id, chain[3]!.head);
      const cycle = await pin(name, chain[0]!.id, chain[2]!.id, chain[2]!.head);
      await listDeps(name, chain[3]!.id);
      const list = await listDeps(name, chain[3]!.id);
      return { create: create.cost, reject: reject.cost, cycle: cycle.cost, list: list.cost, codes: [create.status, reject.json.code, cycle.json.code] };
    };
    // Many unrelated workspaces, half of them pinned to each other.
    const noise: Ws[] = [];
    for (let i = 0; i < 16; i++) noise.push(await workspace('cost-big', `noise${i}.txt`));
    for (let i = 1; i < 16; i += 2) expect((await pin('cost-big', noise[i]!.id, noise[i - 1]!.id, noise[i - 1]!.head)).status).toBe(201);
    const small = await measure('cost-small');
    const big = await measure('cost-big');
    expect(small.codes).toEqual([201, 'DEPENDENCY_DEPTH_EXCEEDED', 'DEPENDENCY_CYCLE']);
    expect(big.codes).toEqual(small.codes);
    // Rows read follow the chain; an index range probe may read one boundary row past its last match.
    const bound = { create: 16, reject: 20, cycle: 22, list: 22 };
    for (const k of ['create', 'reject', 'cycle', 'list'] as const) {
      expect(big[k].d1, k).toBe(small[k].d1);
      expect(Math.abs(big[k].rr - small[k].rr), k).toBeLessThanOrEqual(3);
      expect(big[k].rr, k).toBeLessThanOrEqual(bound[k]);
      expect(small[k].rr, k).toBeLessThanOrEqual(bound[k]);
      expect(big[k].do, k).toBe(0);
      expect(big[k].d1, k).toBeLessThanOrEqual(3);
    }
    expect(small.list).toMatchObject({ art: 0, rw: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('a source push marks the pin stale without repinning it, and the dependent cannot publish', async () => {
    const { repo } = await seedRepo('stale');
    const a = await workspace('stale', 'a.txt', { change: 'review' });
    const b = await workspace('stale', 'b.txt', { change: 'review' });
    const edge = (await pin('stale', b.id, a.id, a.head)).json;
    const r2 = await push('stale', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);

    const listed = (await listDeps('stale', b.id)).json.dependencies;
    expect(listed).toEqual([expect.objectContaining({ id: edge.id, state: 'stale', revision: a.head, sourceHead: r2 })]);
    const q = await enqueue('stale', b.change!);
    expect(q.status).toBe(409);
    expect(q.json.code).toBe('DEPENDENCY_STALE');
    expect(q.json.error).toContain(a.id);
    expect(q.json.dependencies).toEqual([expect.objectContaining({ id: edge.id, state: 'stale' })]);
    const m = await merge('stale', b.change!);
    expect([m.status, m.json.code]).toEqual([409, 'DEPENDENCY_STALE']);
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect(repo.refs.get(a.ref)).toBe(r2);
    expect((await getChange('stale', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head, queueState: null });
  });

  it('a pin confirmed live stays active while its push event lags, until a newer push moves the source', async () => {
    const saved = clock;
    clock = Date.now() - 600_000;
    const { repo } = await seedRepo('lag');
    const a = await workspace('lag', 'a.txt');
    const b = await workspace('lag', 'b.txt');
    // The source moves, but its push event has not been delivered yet.
    const moved = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
    repo.refs.set(a.ref, moved.sha);

    const old = await pin('lag', b.id, a.id, a.head);
    expect([old.status, old.json.code, old.json.currentRevision]).toEqual([422, 'REVISION_NOT_CURRENT', moved.sha]);
    const created = await pin('lag', b.id, a.id, moved.sha);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'active', sourceHead: moved.sha })]);

    // The late event for the pinned push is older than the pin and agrees with it.
    await deliver(pushEvent('lag', a.ref, a.head, moved.sha, Date.now() - 1000));
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'active', sourceHead: moved.sha })]);

    clock = Math.max(saved, Date.now() + 5000);
    const r3 = await push('lag', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v3\n' }, [moved.sha]);
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'stale', sourceHead: r3, revision: moved.sha })]);
  });

  it('repin and detach are explicit and validated; neither touches the dependent', async () => {
    const { repo } = await seedRepo('repin');
    const a = await workspace('repin', 'a.txt');
    const b = await workspace('repin', 'b.txt', { change: 'review' });
    const other = await seedRepo('repin-other');
    const foreign = await workspace('repin-other', 'f.txt');
    const edge = (await pin('repin', b.id, a.id, a.head)).json;
    const r2 = await push('repin', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);

    for (const [body, status, code] of [
      [{ revision: 'f'.repeat(40) }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: a.head }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: foreign.head }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: r2, onWorkspace: foreign.id }, 404, 'SOURCE_NOT_FOUND'],
      [{}, 422, 'INVALID_REVISION'],
    ] as const) {
      const r = await repin('repin', b.id, edge.id, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await repin('repin', b.id, edge.id, { revision: 'f'.repeat(40) })).json.currentRevision).toBe(r2);
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([expect.objectContaining({ revision: a.head, state: 'stale' })]);
    expect(other.repo.refs.get(foreign.ref)).toBe(foreign.head);

    const ok = await repin('repin', b.id, edge.id, { revision: r2 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({
      id: edge.id,
      revision: r2,
      state: 'active',
      previous: { onWorkspace: a.id, revision: a.head, state: 'stale', reason: { code: 'SOURCE_MOVED' } },
    });
    expect(ok.cost.d1).toBeLessThanOrEqual(3);
    expect(ok.cost.do).toBe(0);
    const { previous: _previous, ...repinned } = ok.json;
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([repinned]);
    expect((await repin('repin', b.id, 'nope', { revision: r2 })).json.code).toBe('DEPENDENCY_NOT_FOUND');

    const off = await detach('repin', b.id, edge.id);
    expect(off.status).toBe(200);
    expect(off.cost.d1).toBeLessThanOrEqual(3);
    expect(off.cost.do).toBe(0);
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([]);
    expect((await detach('repin', b.id, edge.id)).status).toBe(404);
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect((await getChange('repin', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head });
    // Without the pin the dependent publishes.
    expect((await merge('repin', b.change!)).status).toBe(200);
  });

  it('abandoning the source breaks the pin; the dependent is blocked but otherwise intact, and recovers explicitly', async () => {
    const { repo } = await seedRepo('broken');
    const a = await workspace('broken', 'a.txt', { change: 'review' });
    const b = await workspace('broken', 'b.txt', { change: 'review' });
    const c = await workspace('broken', 'c.txt', { change: 'review' });
    const edge = (await pin('broken', b.id, a.id, a.head)).json;
    expect((await call('POST', api('broken', `/workspaces/${a.id}/abandon`), tok.owner)).status).toBe(200);

    expect((await listDeps('broken', b.id)).json.dependencies).toEqual([expect.objectContaining({ id: edge.id, state: 'broken', revision: a.head })]);
    for (const r of [await enqueue('broken', b.change!), await merge('broken', b.change!)]) {
      expect([r.status, r.json.code]).toEqual([409, 'DEPENDENCY_BROKEN']);
      expect(r.json.error).toContain(a.id);
    }
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect((await getChange('broken', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head });

    // A repin onto the abandoned source is refused; onto a live workspace at its head it recovers.
    const dead = await repin('broken', b.id, edge.id, { revision: a.head });
    expect([dead.status, dead.json.code]).toEqual([409, 'SOURCE_NOT_ACTIVE']);
    const moved = await repin('broken', b.id, edge.id, { onWorkspace: c.id, revision: c.head });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json).toMatchObject({
      id: edge.id,
      onWorkspace: c.id,
      revision: c.head,
      state: 'active',
      previous: { onWorkspace: a.id, revision: a.head, state: 'broken', reason: { code: 'SOURCE_ABANDONED' } },
    });
    // Pending until C lands; then satisfied and B merges with C in its ancestry.
    expect((await merge('broken', b.change!)).json.code).toBe('DEPENDENCY_PENDING');
    expect((await merge('broken', c.change!)).status).toBe(200);
    expect((await listDeps('broken', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'satisfied' })]);
    const done = await merge('broken', b.change!);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(isAncestorOf(repo, c.head, repo.refs.get(MAIN)!)).toBe(true);
    expect(repo.refs.get(b.ref)).toBe(b.head);
  });

  it('a pin is satisfied only when the landed result preserves the pinned revision', async () => {
    const { repo } = await seedRepo('satisfy');
    const a = await workspace('satisfy', 'a.txt', { change: 'review' });
    const b = await workspace('satisfy', 'b.txt', { change: 'review' });
    expect((await pin('satisfy', b.id, a.id, a.head)).status).toBe(201);
    expect((await merge('satisfy', b.change!)).json.code).toBe('DEPENDENCY_PENDING');
    const landed = await merge('satisfy', a.change!);
    expect(landed.status).toBe(200);
    expect(isAncestorOf(repo, a.head, repo.refs.get(MAIN)!)).toBe(true);
    const sat = (await listDeps('satisfy', b.id)).json.dependencies;
    expect(sat).toEqual([expect.objectContaining({ state: 'satisfied', satisfiedBy: landed.json.merge.mergeCommit })]);
    expect((await merge('satisfy', b.change!)).status).toBe(200);

    // Rewritten source: the pinned revision is not in the landed commit's ancestry.
    const second = await seedRepo('unsatisfied');
    const a2 = await workspace('unsatisfied', 'a.txt', { change: 'review' });
    const b2 = await workspace('unsatisfied', 'b.txt', { change: 'review' });
    expect((await pin('unsatisfied', b2.id, a2.id, a2.head)).status).toBe(201);
    const rewritten = await push('unsatisfied', a2.ref, { 'README.md': 'readme\n', 'a.txt': 'rewritten\n' }, [second.main]);
    expect((await getChange('unsatisfied', a2.change!)).json.headSha).toBe(rewritten);
    expect((await merge('unsatisfied', a2.change!)).status).toBe(200);
    expect(isAncestorOf(second.repo, a2.head, second.repo.refs.get(MAIN)!)).toBe(false);
    const listed = (await listDeps('unsatisfied', b2.id)).json.dependencies;
    expect(listed).toEqual([expect.objectContaining({ state: 'broken', reason: expect.objectContaining({ code: 'NOT_PRESERVED' }) })]);
    const refused = await merge('unsatisfied', b2.change!);
    expect([refused.status, refused.json.code]).toEqual([409, 'DEPENDENCY_BROKEN']);
  });

  it('a pin satisfied by a landing elsewhere does not let the dependent publish without the pinned revision', async () => {
    const { repo, main } = await seedRepo('elsewhere');
    repo.refs.set('refs/heads/dev', main);
    const a = await workspace('elsewhere', 'a.txt', { change: 'review', base: 'dev' });
    const b = await workspace('elsewhere', 'b.txt', { change: 'review' });
    expect((await pin('elsewhere', b.id, a.id, a.head)).status).toBe(201);
    expect((await merge('elsewhere', a.change!)).status).toBe(200);
    expect((await listDeps('elsewhere', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'satisfied' })]);

    const m = await merge('elsewhere', b.change!);
    expect([m.status, m.json.code]).toEqual([409, 'DEPENDENCY_NOT_PRESERVED']);
    expect(m.json.error).toContain(a.head);
    expect(repo.refs.get(MAIN)).toBe(main);

    expect((await enqueue('elsewhere', b.change!)).status).toBe(201);
    const run = await runTrain(env, repoIds.elsewhere!, MAIN, trainDeps());
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([{ number: b.change, code: 'DEPENDENCY_NOT_PRESERVED' }]);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect((await getChange('elsewhere', b.change!)).json).toMatchObject({ state: 'open', mergeCommit: null });
  });

  it('landing settles every pin of the source and still wakes waiting partitions, in bounded batches', async () => {
    const { repo } = await seedRepo('settle-many');
    const saved = DEPENDENCY_LIMITS.readMax;
    try {
      const a = await workspace('settle-many', 'a.txt', { change: 'review' });
      const pinned: Ws[] = [];
      for (let i = 0; i < 3; i++) {
        const d = await workspace('settle-many', `d${i}.txt`);
        expect((await pin('settle-many', d.id, a.id, a.head)).status).toBe(201);
        pinned.push(d);
      }
      // The source moves on; its earlier pins are settled by ancestry when it lands.
      const r2 = await push('settle-many', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      const q = await workspace('settle-many', 'q.txt', { change: 'review' });
      expect((await pin('settle-many', q.id, a.id, r2)).status).toBe(201);
      expect((await enqueue('settle-many', q.change!)).status).toBe(201);
      DEPENDENCY_LIMITS.readMax = 2;
      sent.length = 0;
      const landed = await merge('settle-many', a.change!);
      expect(landed.status).toBe(200);
      // Within one invocation's budget: no settlement intent, no continuation.
      expect(landed.cost.do).toBe(0);
      expect(await intentsOf('settle-many')).toEqual([]);
      for (const d of pinned) expect((await listDeps('settle-many', d.id)).json.dependencies, d.id).toEqual([expect.objectContaining({ state: 'satisfied' })]);
      expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'kvarm.train', ref: MAIN, reason: 'dependency-landed' }));
      expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
      expect(await wakeMarks('settle-many')).toBe(0);
      expect(repo.refs.get(a.ref)).toBe(r2);
    } finally {
      DEPENDENCY_LIMITS.readMax = saved;
    }
  });

  it('settlement past the per-message page ceiling continues on the events queue until every preserved pin is settled and wakes its dependents', async () => {
    const name = 'settle-continue';
    const { repo } = await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const a = await workspace(name, 'a.txt', { change: 'review' });
      const edgeOf = new Map<string, string>();
      const dependents: Ws[] = [];
      for (let i = 0; i < 9; i++) {
        const d = await workspace(name, `d${i}.txt`);
        const edge = await pin(name, d.id, a.id, a.head);
        expect(edge.status).toBe(201);
        edgeOf.set(d.id, edge.json.id as string);
        dependents.push(d);
      }
      // Settlement pages run in edge-id order: the last pins are the ones left to continuations.
      dependents.sort((x, y) => (edgeOf.get(x.id)! < edgeOf.get(y.id)! ? -1 : 1));
      const queued = dependents[7]!;
      const last = dependents[8]!;
      const qn = (await call('POST', api(name, `/workspaces/${queued.id}/change-set`), tok.owner, { title: 'queued dependent', mergePolicy: 'review' })).json.number as number;
      expect((await enqueue(name, qn)).status).toBe(201);
      const autoN = (await call('POST', api(name, `/workspaces/${last.id}/change-set`), tok.owner, { title: 'auto dependent', mergePolicy: 'auto' })).json.number as number;
      expect((await getChange(name, autoN)).json.state).toBe('open');
      // The source moves on while keeping the pinned revision: every pin settles by ancestry, none by exact head.
      const r2 = await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);

      // Two pages of two edges per message.
      DEPENDENCY_LIMITS.readMax = 2;
      SETTLE_LIMITS.maxPages = 2;
      const satisfied = async () => {
        const out: boolean[] = [];
        for (const d of dependents) out.push((await listDeps(name, d.id)).json.dependencies[0].state === 'satisfied');
        return out;
      };
      const continuations = () => sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body);
      const pushRows = async () =>
        (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_events WHERE repo_id = ?').bind(repoIds[name]).first<{ n: number }>())!.n;

      sent.length = 0;
      const landed = await merge(name, a.change!);
      expect(landed.status, JSON.stringify(landed.json)).toBe(200);
      const mergeCommit = landed.json.merge.mergeCommit as string;
      expect(await satisfied()).toEqual([true, true, true, true, false, false, false, false, false]);
      // Two independent owners of the rest: the queue continuation (fast path) and the MergeLock intent (one DO call).
      expect(continuations()).toEqual([
        { type: 'kvarm.dependency-settle', repoId: repoIds[name], changeSetId: expect.any(String), mergedAt: expect.any(Number), mergeCommit, ref: MAIN },
      ]);
      const first = continuations()[0];
      expect(landed.cost.do).toBe(1);
      const [intent] = await intentsOf(name);
      expect(intent).toMatchObject({ repoId: repoIds[name], changeSetId: first.changeSetId, mergedAt: first.mergedAt, mergeCommit, ref: MAIN });
      expect(await alarmOf(name)).toBe(intent!.deadline);
      expect((await getChange(name, autoN)).json.state).toBe('open');
      const pushesBefore = await pushRows();

      // A continuation for another landing identity, or a malformed one, settles and schedules nothing.
      sent.length = 0;
      await deliver({ ...first, mergeCommit: 'f'.repeat(40) });
      await deliver({ ...first, mergedAt: first.mergedAt - 1 });
      await deliver({ ...first, changeSetId: crypto.randomUUID() });
      await deliver({ type: 'kvarm.dependency-settle', repoId: repoIds[name] });
      expect(sent).toEqual([]);
      expect((await satisfied()).filter(Boolean)).toHaveLength(4);

      // The first continuation settles the next two pages, wakes the queued dependent's partition and schedules one more.
      await deliver(first);
      expect(await satisfied()).toEqual([true, true, true, true, true, true, true, true, false]);
      expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'kvarm.train', ref: MAIN, reason: 'dependency-settled' }));
      expect(continuations()).toEqual([first]);
      expect((await getChange(name, autoN)).json.state).toBe('open');

      // The next one settles the last preserved pin and resumes the open auto dependent; nothing is left to schedule.
      sent.length = 0;
      await deliver(first);
      expect(await satisfied()).toEqual(Array(9).fill(true));
      expect(continuations()).toEqual([]);
      expect((await getChange(name, autoN)).json).toMatchObject({ state: 'merged' });
      expect(isAncestorOf(repo, last.head, repo.refs.get(MAIN)!)).toBe(true);

      // A replayed continuation finds nothing unsettled: no writes, no wake-ups, no further continuation.
      sent.length = 0;
      expect(await wakeMarks(name)).toBe(0);
      const before = (await env.DB.prepare('SELECT MAX(updated_at) AS t FROM workspace_dependencies WHERE repo_id = ?').bind(repoIds[name]).first<{ t: number }>())!.t;
      await deliver(first);
      expect(sent).toEqual([]);
      // The second owner's wakeup finds nothing fenced to this landing either: it clears its intent and disarms.
      expect(await fireOwner(name)).toBe(true);
      expect(await intentsOf(name)).toEqual([]);
      expect(await alarmOf(name)).toBeNull();
      expect(sent).toEqual([]);
      expect((await env.DB.prepare('SELECT MAX(updated_at) AS t FROM workspace_dependencies WHERE repo_id = ?').bind(repoIds[name]).first<{ t: number }>())!.t).toBe(before);
      // Internal messages never enter the push-event log.
      expect(await pushRows()).toBe(pushesBefore);
      for (const d of dependents) {
        expect((await listDeps(name, d.id)).json.dependencies[0]).toMatchObject({ state: 'satisfied', satisfiedBy: mergeCommit });
      }

      // The woken partition publishes the queued dependent.
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      const run = await runTrain(env, repoIds[name]!, MAIN, trainDeps());
      expect(run.published).toContain(qn);
      expect(repo.refs.get(a.ref)).toBe(r2);
    } finally {
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('a source published by the train hands its unsettled pins to a continuation too', async () => {
    const name = 'settle-train';
    await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const a = await workspace(name, 'a.txt', { change: 'review' });
      const dependents: Ws[] = [];
      for (let i = 0; i < 3; i++) {
        const d = await workspace(name, `d${i}.txt`);
        expect((await pin(name, d.id, a.id, a.head)).status).toBe(201);
        dependents.push(d);
      }
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      expect((await enqueue(name, a.change!)).status).toBe(201);
      DEPENDENCY_LIMITS.readMax = 1;
      SETTLE_LIMITS.maxPages = 1;
      sent.length = 0;
      const deps = trainDeps();
      const meter = new CostMeter();
      const run = await runWithMeter(meter, () => runTrain(meter.wrapEnv(env), repoIds[name]!, MAIN, deps));
      expect(run.published).toEqual([a.change]);
      const continuation = sent.map((m) => m.body).filter((b) => b?.type === 'kvarm.dependency-settle');
      const mergeCommit = (await getChange(name, a.change!)).json.mergeCommit as string;
      expect(continuation).toEqual([expect.objectContaining({ repoId: repoIds[name], mergeCommit, ref: MAIN })]);
      // The intent is written after the recorded publication cost: that stays acquire + release.
      const recorded = deps.events.find((e): e is Extract<TrainEvent, { type: 'publish' }> => e.type === 'publish' && e.status === 'recorded');
      expect(recorded?.cost?.do).toBe(2);
      const entry = await env.DB.prepare('SELECT cost FROM merge_queue WHERE repo_id = ? AND change_number = ?').bind(repoIds[name], a.change).first<{ cost: string }>();
      expect((JSON.parse(entry!.cost) as CostCounters).do).toBe(2);
      expect(meter.snapshot().do).toBe(3);
      expect(await intentsOf(name)).toEqual([expect.objectContaining({ repoId: repoIds[name], mergeCommit, ref: MAIN })]);
      for (let i = 0; i < 4 && sent.some((m) => m.body?.type === 'kvarm.dependency-settle'); i++) {
        const next = sent.find((m) => m.body?.type === 'kvarm.dependency-settle')!.body;
        sent.length = 0;
        await deliver(next);
      }
      for (const d of dependents) expect((await listDeps(name, d.id)).json.dependencies[0].state).toBe('satisfied');
      expect(await fireOwner(name)).toBe(true);
      expect(await intentsOf(name)).toEqual([]);
    } finally {
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  /** A source with `n` dependents pinned on its first head, sorted in settlement (edge id) order, after it moved on keeping that head. */
  async function pinnedSource(name: string, n: number) {
    const a = await workspace(name, 'a.txt', { change: 'review' });
    const edgeOf = new Map<string, string>();
    const dependents: Ws[] = [];
    for (let i = 0; i < n; i++) {
      const d = await workspace(name, `d${i}.txt`);
      const edge = await pin(name, d.id, a.id, a.head);
      expect(edge.status).toBe(201);
      edgeOf.set(d.id, edge.json.id as string);
      dependents.push(d);
    }
    dependents.sort((x, y) => (edgeOf.get(x.id)! < edgeOf.get(y.id)! ? -1 : 1));
    const changeFor = async (d: Ws, mergePolicy: 'review' | 'auto') =>
      (await call('POST', api(name, `/workspaces/${d.id}/change-set`), tok.owner, { title: `dependent ${d.id}`, mergePolicy })).json.number as number;
    return { a, dependents, changeFor };
  }

  const states = async (name: string, ds: Ws[]) => {
    const out: string[] = [];
    for (const d of ds) out.push((await listDeps(name, d.id)).json.dependencies[0].state as string);
    return out;
  };

  const settleLines = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as Record<string, any>;
        } catch {
          return null;
        }
      })
      .filter((l): l is Record<string, any> => l?.mergeLock === 'dependency-settle');

  it('VAL-DEP-010: a rejected landing continuation send does not strand the pins: the MergeLock intent settles them in bounded wakeups', async () => {
    const name = 'settle-owner';
    const { repo } = await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    const logs = vi.spyOn(console, 'log');
    try {
      const { a, dependents, changeFor } = await pinnedSource(name, 9);
      const queuedN = await changeFor(dependents[7]!, 'review');
      expect((await enqueue(name, queuedN)).status).toBe(201);
      const autoN = await changeFor(dependents[8]!, 'auto');
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      DEPENDENCY_LIMITS.readMax = 2;
      SETTLE_LIMITS.maxPages = 2;

      // Injected failure: every continuation send rejects, at the landing and after it.
      failSends.match = (b) => b?.type === 'kvarm.dependency-settle';
      sent.length = 0;
      const landed = await merge(name, a.change!);
      expect(landed.status, JSON.stringify(landed.json)).toBe(200);
      const mergeCommit = landed.json.merge.mergeCommit as string;
      expect(landed.cost.do).toBe(1);
      expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
      expect(await states(name, dependents)).toEqual([...Array(4).fill('satisfied'), ...Array(5).fill('stale')]);

      // The durable owner exists: the intent names the exact landing and the alarm is armed for it.
      const [intent] = await intentsOf(name);
      expect(intent).toMatchObject({ repoId: repoIds[name], mergedAt: expect.any(Number), mergeCommit, ref: MAIN, attempts: 0 });
      expect(await alarmOf(name)).toBe(intent!.deadline);

      // Ordinary dependency reads stay read-only: they settle nothing.
      const read = await listDeps(name, dependents[8]!.id);
      expect(read.cost).toMatchObject({ rw: 0, q: 0, do: 0 });
      expect(read.json.dependencies[0].state).toBe('stale');

      // The owner's wakeups settle the rest, bounded pages per wakeup (2 pages of 2 pins here).
      sent.length = 0;
      logs.mockClear();
      let wakeups = 0;
      while (wakeups < 6 && (await fireOwner(name))) wakeups++;
      expect(wakeups).toBe(2);
      expect(await intentsOf(name)).toEqual([]);
      expect(await alarmOf(name)).toBeNull();
      for (const d of dependents) {
        expect((await listDeps(name, d.id)).json.dependencies[0]).toMatchObject({ state: 'satisfied', satisfiedBy: mergeCommit });
      }
      // The queued dependent's partition is kicked once and the open auto dependent resumed and merged.
      expect(sent.map((m) => m.body)).toEqual([{ type: 'kvarm.train', repoId: repoIds[name], ref: MAIN, reason: 'dependency-settled' }]);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(isAncestorOf(repo, dependents[8]!.head, repo.refs.get(MAIN)!)).toBe(true);
      expect(await wakeMarks(name)).toBe(0);

      // One {cost} line per wakeup: the first (4 pins, 2 pages) within d1 ≤ 2 + maxPages, the last done.
      const lines = settleLines(logs);
      expect(lines.map((l) => l.outcome)).toEqual(['continue', 'done']);
      expect(lines[0]!.cost).toMatchObject({ d1: 2 + SETTLE_LIMITS.maxPages, q: 1, do: 0 });
      expect(lines[0]!.settle).toMatchObject({ settled: 4, kicked: 1, remaining: true });
      expect(lines[1]!.settle).toMatchObject({ settled: 1, resumed: 1, remaining: false });

      // An intent for another identity of this landing (a superseded or replayed one) settles and writes nothing.
      const stale = await lockOf(name).fetch('https://merge-lock/settle-intent', {
        method: 'POST',
        body: JSON.stringify({ ...intent, mergeCommit: 'f'.repeat(40) }),
      });
      expect(stale.status).toBe(200);
      const before = (await env.DB.prepare('SELECT MAX(updated_at) AS t FROM workspace_dependencies WHERE repo_id = ?').bind(repoIds[name]).first<{ t: number }>())!.t;
      sent.length = 0;
      logs.mockClear();
      expect(await fireOwner(name)).toBe(true);
      expect(await fireOwner(name)).toBe(false);
      expect(sent).toEqual([]);
      expect(settleLines(logs)).toEqual([expect.objectContaining({ outcome: 'done', cost: expect.objectContaining({ d1: 1, rw: 0, q: 0 }) })]);
      expect((await env.DB.prepare('SELECT MAX(updated_at) AS t FROM workspace_dependencies WHERE repo_id = ?').bind(repoIds[name]).first<{ t: number }>())!.t).toBe(before);

      // The woken partition publishes the queued dependent.
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      expect((await runTrain(env, repoIds[name]!, MAIN, trainDeps())).published).toContain(queuedN);
    } finally {
      logs.mockRestore();
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('VAL-DEP-011: a continuation retry after its edge writes committed re-derives the wake/resume work from D1, without duplicates', async () => {
    const name = 'settle-retry';
    const { repo } = await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const { a, dependents, changeFor } = await pinnedSource(name, 4);
      const queuedN = await changeFor(dependents[2]!, 'review');
      expect((await enqueue(name, queuedN)).status).toBe(201);
      const autoN = await changeFor(dependents[3]!, 'auto');
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      DEPENDENCY_LIMITS.readMax = 2;
      SETTLE_LIMITS.maxPages = 1;
      sent.length = 0;
      expect((await merge(name, a.change!)).status).toBe(200);
      expect(await states(name, dependents)).toEqual(['satisfied', 'satisfied', 'stale', 'stale']);
      const first = sent.find((m) => m.body?.type === 'kvarm.dependency-settle')!.body;

      // Injected failures after the segment's edge writes commit: the kick send rejects, and the real resume adapter's
      // merge of the auto dependent meets an unavailable ref store (503 STORAGE_UNAVAILABLE: operational, not a refusal).
      failSends.match = (b) => b?.type === 'kvarm.train';
      let lsRefsFailures = 0;
      repo.hook = async (call) => {
        if (call === 'lsRefs') {
          lsRefsFailures++;
          throw new Error('ls-refs unavailable (test)');
        }
      };
      sent.length = 0;
      const failed = await deliverRaw(first);
      repo.hook = null;
      expect(failed.explicitAcks).toEqual([]);
      expect(failed.retryMessages).toHaveLength(1);
      expect(await states(name, dependents)).toEqual(Array(4).fill('satisfied'));
      expect(lsRefsFailures).toBeGreaterThan(0);
      expect(sent).toEqual([]);
      // The obligations are durable: one wake-pending mark per affected dependent survives the failure.
      expect(await wakeMarks(name)).toBe(2);
      expect((await getChange(name, autoN)).json.state).toBe('open');

      // The retry finds no unsettled pin, but re-derives the wake work from the marks and finishes it.
      failSends.match = null;
      sent.length = 0;
      await deliver(first);
      const kicks = sent.filter((m) => m.body?.type === 'kvarm.train' && m.body.reason === 'dependency-settled');
      expect(kicks.map((m) => m.body)).toEqual([{ type: 'kvarm.train', repoId: repoIds[name], ref: MAIN, reason: 'dependency-settled' }]);
      expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(isAncestorOf(repo, dependents[3]!.head, repo.refs.get(MAIN)!)).toBe(true);
      expect(await wakeMarks(name)).toBe(0);

      // Another redelivery has nothing pending: no kick, merge or continuation.
      sent.length = 0;
      await deliver(first);
      expect(sent).toEqual([]);
      expect(await fireOwner(name)).toBe(true);
      expect(sent).toEqual([]);

      DEPENDENCY_LIMITS.readMax = saved.readMax;
      expect((await runTrain(env, repoIds[name]!, MAIN, trainDeps())).published).toEqual([queuedN]);
    } finally {
      repos[name]!.hook = null;
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('a resumed auto dependent that is not ready (a 4xx refusal) clears its mark with no retry; its own recovery path merges it later', async () => {
    const name = 'settle-not-ready';
    const { repo } = await seedRepo(name);
    const a = await workspace(name, 'a.txt', { change: 'review' });
    const b = await workspace(name, 'b.txt', { change: 'review' });
    const d = await workspace(name, 'd.txt');
    expect((await pin(name, d.id, a.id, a.head)).status).toBe(201);
    expect((await pin(name, d.id, b.id, b.head)).status).toBe(201);
    const dn = (await call('POST', api(name, `/workspaces/${d.id}/change-set`), tok.owner, { title: 'auto dependent', mergePolicy: 'auto' })).json.number as number;
    expect((await getChange(name, dn)).json.state).toBe('open');

    // The first source lands: the dependent's resume is refused DEPENDENCY_PENDING (its pin on b), which is not an operational failure.
    sent.length = 0;
    const landed = await merge(name, a.change!);
    expect(landed.status).toBe(200);
    expect(landed.cost.do).toBe(0);
    expect(await wakeMarks(name)).toBe(0);
    expect(await intentsOf(name)).toEqual([]);
    expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
    expect((await getChange(name, dn)).json.state).toBe('open');

    // Landing the second source wakes it again through its own mark, and it merges.
    expect((await merge(name, b.change!)).status).toBe(200);
    expect((await getChange(name, dn)).json.state).toBe('merged');
    expect(isAncestorOf(repo, d.head, repo.refs.get(MAIN)!)).toBe(true);
    expect(await wakeMarks(name)).toBe(0);
  });

  it('a landing whose post-page wake read fails after the edges committed hands off to both owners before the error propagates; they finish once', async () => {
    const name = 'settle-post-page';
    const { repo } = await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    const real = env.DB;
    try {
      const { a, dependents, changeFor } = await pinnedSource(name, 2);
      const queuedN = await changeFor(dependents[0]!, 'review');
      expect((await enqueue(name, queuedN)).status).toBe(201);
      const autoN = await changeFor(dependents[1]!, 'auto');
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      // Exactly one full page: the page after it is empty, so the marks are claimed in a separate statement after the
      // committed page, and that statement rejects.
      DEPENDENCY_LIMITS.readMax = 2;
      SETTLE_LIMITS.maxPages = 2;
      (env as { DB: D1Database }).DB = faultyDb(real, (sql) => sql.includes(CLAIM_SQL), { left: 1 });
      sent.length = 0;
      const landed = await merge(name, a.change!);
      (env as { DB: D1Database }).DB = real;
      expect(landed.status).toBeGreaterThanOrEqual(500);
      expect((await getChange(name, a.change!)).json.state).toBe('merged');
      expect(await states(name, dependents)).toEqual(['satisfied', 'satisfied']);
      expect(await wakeMarks(name)).toBe(2);
      // Both owners exist before the error propagated; nothing was woken yet.
      const handed = sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body);
      expect(handed).toEqual([expect.objectContaining({ repoId: repoIds[name], ref: MAIN })]);
      expect(await intentsOf(name)).toHaveLength(1);
      expect(sent.filter((m) => m.body?.type === 'kvarm.train')).toEqual([]);

      sent.length = 0;
      await deliver(handed[0]);
      expect(sent.map((m) => m.body)).toEqual([{ type: 'kvarm.train', repoId: repoIds[name], ref: MAIN, reason: 'dependency-settled' }]);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(await wakeMarks(name)).toBe(0);
      // The second owner and a replay find nothing left: no kick, the intent is cleaned by its first wakeup.
      sent.length = 0;
      expect(await fireOwner(name)).toBe(true);
      expect(await intentsOf(name)).toEqual([]);
      await deliver(handed[0]);
      expect(sent).toEqual([]);
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      expect((await runTrain(env, repoIds[name]!, MAIN, trainDeps())).published).toEqual([queuedN]);
      expect(isAncestorOf(repo, dependents[1]!.head, repo.refs.get(MAIN)!)).toBe(true);
    } finally {
      (env as { DB: D1Database }).DB = real;
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  /** A landing whose own kick of its one queued dependent was rejected: the mark is left (released) for the owners. */
  async function strandedKick(name: string) {
    await seedRepo(name);
    const { a, dependents, changeFor } = await pinnedSource(name, 1);
    const queuedN = await changeFor(dependents[0]!, 'review');
    expect((await enqueue(name, queuedN)).status).toBe(201);
    failSends.match = (b) => b?.type === 'kvarm.train';
    sent.length = 0;
    const landed = await merge(name, a.change!);
    expect(landed.status).toBe(200);
    failSends.match = null;
    expect(await wakeMarks(name)).toBe(1);
    const handed = sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body);
    expect(handed).toHaveLength(1);
    expect(await intentsOf(name)).toHaveLength(1);
    sent.length = 0;
    return handed[0];
  }

  const kicksSent = () => sent.filter((m) => m.body?.type === 'kvarm.train');

  it('a kick whose mark deletion failed is not sent again by a retry while its claim is live', async () => {
    const name = 'settle-confirm-fail';
    const real = env.DB;
    try {
      const msg = await strandedKick(name);
      // The kick succeeds, then its confirming delete rejects.
      (env as { DB: D1Database }).DB = faultyDb(real, (sql) => sql.includes(CONFIRM_SQL), { left: 1 });
      const first = await deliverRaw(msg);
      (env as { DB: D1Database }).DB = real;
      expect(first.retryMessages).toHaveLength(1);
      expect(kicksSent()).toHaveLength(1);
      expect(await wakeMarks(name)).toBe(1);

      // Retries by either owner while the claim is live send nothing new.
      sent.length = 0;
      const retry = await deliverRaw(msg);
      expect(retry.retryMessages).toHaveLength(1);
      expect(await fireOwner(name)).toBe(true);
      expect(sent).toEqual([]);
      expect(await wakeMarks(name)).toBe(1);
      // The owner keeps its intent and revisits at the claim's expiry.
      const [intent] = await intentsOf(name);
      const until = await claimExpiry(name);
      expect(intent!.deadline).toBeLessThanOrEqual(until!);
      expect(await alarmOf(name)).toBe(intent!.deadline);

      // The documented residual: once the claim lapsed unconfirmed, the next owner sends the kick once more and confirms.
      await expireClaims(name);
      expect(await fireOwner(name)).toBe(true);
      expect(kicksSent()).toHaveLength(1);
      expect(await wakeMarks(name)).toBe(0);
      expect(await intentsOf(name)).toEqual([]);
    } finally {
      (env as { DB: D1Database }).DB = real;
    }
  });

  it('overlapping owners (the alarm firing while a continuation is in flight) send the kick exactly once', async () => {
    const name = 'settle-overlap';
    const msg = await strandedKick(name);
    let nested: Promise<boolean> | null = null;
    onSend.fn = async (body) => {
      // While the continuation's kick is being sent, its claim is live: the alarm must not act on the same mark.
      if (body?.type === 'kvarm.train' && !nested) {
        nested = fireOwner(name);
        await nested;
      }
    };
    try {
      await deliver(msg);
    } finally {
      onSend.fn = null;
    }
    expect(await nested).toBe(true);
    expect(kicksSent()).toHaveLength(1);
    expect(await wakeMarks(name)).toBe(0);
    // The alarm kept its intent (the mark was held, not done); its next wakeup finds nothing and cleans up.
    expect(await intentsOf(name)).toHaveLength(1);
    sent.length = 0;
    expect(await fireOwner(name)).toBe(true);
    expect(sent).toEqual([]);
    expect(await intentsOf(name)).toEqual([]);
  });

  it('a settlement intent outlives an outage longer than any failure count and settles every pin when it ends', async () => {
    const name = 'settle-outage';
    await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const { a, dependents } = await pinnedSource(name, 5);
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      DEPENDENCY_LIMITS.readMax = 1;
      SETTLE_LIMITS.maxPages = 1;
      failSends.match = (b) => b?.type === 'kvarm.dependency-settle';
      expect((await merge(name, a.change!)).status).toBe(200);
      expect(await states(name, dependents)).toEqual(['satisfied', ...Array(4).fill('stale')]);

      // D1 is down for every owner wakeup, well past any patience counter.
      mergeLockAlarm.env = () => ({ ...env, DB: faultyDb(env.DB, () => true) });
      for (let i = 1; i <= 12; i++) {
        expect(await fireOwner(name)).toBe(true);
        expect(await intentsOf(name)).toEqual([expect.objectContaining({ attempts: i })]);
        expect(await alarmOf(name)).not.toBeNull();
      }
      mergeLockAlarm.env = () => env;
      let wakeups = 0;
      while (wakeups < 10 && (await fireOwner(name))) wakeups++;
      expect(wakeups).toBe(4);
      expect(await states(name, dependents)).toEqual(Array(5).fill('satisfied'));
      expect(await intentsOf(name)).toEqual([]);
      expect(await alarmOf(name)).toBeNull();
    } finally {
      mergeLockAlarm.env = () => env;
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  /**
   * A source with `older` dependents pinned on its first head (settled by pages, in edge id order) whose workspace ids
   * sort before that of `auto`'s workspace, an open unqueued auto dependent pinned on the head that lands: its wake
   * mark is born claimed by the landing and sorts after every page-born mark.
   */
  async function displacedAuto(name: string, older: number) {
    const { repo } = await seedRepo(name);
    const a = await workspace(name, 'a.txt', { change: 'review' });
    const ws: Ws[] = [];
    for (let i = 0; i <= older; i++) ws.push(await workspace(name, `d${i}.txt`));
    ws.sort((x, y) => (x.id < y.id ? -1 : 1));
    const auto = ws.pop()!;
    const edgeOf = new Map<string, string>();
    for (const d of ws) {
      const edge = await pin(name, d.id, a.id, a.head);
      expect(edge.status).toBe(201);
      edgeOf.set(d.id, edge.json.id as string);
    }
    ws.sort((x, y) => (edgeOf.get(x.id)! < edgeOf.get(y.id)! ? -1 : 1));
    const head = await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
    expect((await pin(name, auto.id, a.id, head)).status).toBe(201);
    const autoN = (await call('POST', api(name, `/workspaces/${auto.id}/change-set`), tok.owner, { title: 'auto dependent', mergePolicy: 'auto' })).json
      .number as number;
    expect((await getChange(name, autoN)).json.state).toBe('open');
    return { repo, a, older: ws, auto, autoN };
  }

  const settleSends = () => sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body);

  it('the wake accounting reports every mark of the landing that the bounded claim did not return', async () => {
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    const id = { repoId: crypto.randomUUID(), changeSetId: crypto.randomUUID(), mergedAt: 1, mergeCommit: 'c'.repeat(40) };
    const prefix = `${id.repoId}/${id.changeSetId}/${id.mergedAt}/`;
    const now = Date.now();
    type Mark = [subject: string, state: 'open' | 'claimed', owner: string | null, expiresAt: number | null];
    const account = async (marks: Mark[]) => {
      await env.DB.prepare('DELETE FROM fenced_claims WHERE kind = ?1 AND identity = ?2').bind(WAKE_KIND, id.mergeCommit).run();
      for (const [subject, state, owner, expiresAt] of marks) {
        await env.DB.prepare('INSERT INTO fenced_claims (kind, subject, generation, owner, identity, state, expires_at, updated_at) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7)')
          .bind(WAKE_KIND, prefix + subject, owner, id.mergeCommit, state, expiresAt, now)
          .run();
      }
      const [claimed, rest] = await env.DB.batch(wakeClaimStatements(env.DB, id, 'me', now));
      const set = wakeSetOf(claimed, rest);
      return { rows: set.rows.map((r) => r.id!.slice(prefix.length)), more: set.more, held: set.held };
    };
    try {
      DEPENDENCY_LIMITS.readMax = 1;
      SETTLE_LIMITS.maxPages = 1;
      const live = now + 60_000;
      // The claim's one slot takes the earliest claimable mark; what it leaves out is remaining work or held.
      expect(await account([['a', 'open', null, null], ['b', 'claimed', 'me', live]])).toEqual({ rows: ['a'], more: true, held: 0 });
      expect(await account([['a', 'open', null, null], ['b', 'claimed', 'me', now - 1]])).toEqual({ rows: ['a'], more: true, held: 0 });
      expect(await account([['a', 'open', null, null], ['b', 'claimed', 'other', now - 1]])).toEqual({ rows: ['a'], more: true, held: 0 });
      expect(await account([['a', 'open', null, null], ['b', 'open', null, null]])).toEqual({ rows: ['a'], more: true, held: 0 });
      expect(await account([['a', 'open', null, null], ['b', 'claimed', 'other', live]])).toEqual({ rows: ['a'], more: false, held: 1 });
      // Everything the owner holds was returned: nothing else remains.
      expect(await account([['a', 'claimed', 'me', live]])).toEqual({ rows: ['a'], more: false, held: 0 });
      expect(await account([['a', 'claimed', 'me', now - 1], ['b', 'claimed', 'other', live]])).toEqual({ rows: ['a'], more: false, held: 1 });
    } finally {
      await env.DB.prepare('DELETE FROM fenced_claims WHERE kind = ?1 AND identity = ?2').bind(WAKE_KIND, id.mergeCommit).run();
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('VAL-DEP-011: a landing whose bounded wake claim displaces a mark it already owns hands it to the owners; the auto dependent resumes at claim expiry', async () => {
    const name = 'settle-displaced';
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const { repo, a, older, auto, autoN } = await displacedAuto(name, 1);
      // Wake limit one: the page-born mark of the older dependent takes the final claim's only slot.
      DEPENDENCY_LIMITS.readMax = 1;
      SETTLE_LIMITS.maxPages = 1;
      sent.length = 0;
      const landed = await merge(name, a.change!);
      expect(landed.status, JSON.stringify(landed.json)).toBe(200);
      const mergeCommit = landed.json.merge.mergeCommit as string;
      expect(await states(name, [...older, auto])).toEqual(['satisfied', 'satisfied']);
      expect((await getChange(name, autoN)).json.state).toBe('open');
      expect(await wakeMarks(name)).toBe(1);
      // The displaced mark is still the landing's work: both owners exist.
      const handed = settleSends();
      expect(handed).toEqual([{ type: 'kvarm.dependency-settle', repoId: repoIds[name], changeSetId: expect.any(String), mergedAt: expect.any(Number), mergeCommit, ref: MAIN }]);
      expect(await intentsOf(name)).toEqual([expect.objectContaining({ mergeCommit, ref: MAIN })]);

      // While the landing's claim is live, a fresh owner does not act on the mark and its delivery is retried, not acknowledged.
      sent.length = 0;
      const early = await deliverRaw(handed[0]);
      expect(early.explicitAcks).toEqual([]);
      expect(early.retryMessages).toHaveLength(1);
      expect((await getChange(name, autoN)).json.state).toBe('open');
      expect(sent).toEqual([]);

      // At the claim's expiry the retry resumes the auto dependent once.
      await expireClaims(name);
      await deliver(handed[0]);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(isAncestorOf(repo, auto.head, repo.refs.get(MAIN)!)).toBe(true);
      expect(await wakeMarks(name)).toBe(0);
      expect(await fireOwner(name)).toBe(true);
      expect(await intentsOf(name)).toEqual([]);
      expect(await alarmOf(name)).toBeNull();
    } finally {
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  /** displacedAuto with two older dependents, landed at wake limit one: one older pin is left, and the landing's claim on the auto dependent's mark has lapsed. */
  async function displacedContinuation(name: string) {
    const d = await displacedAuto(name, 2);
    DEPENDENCY_LIMITS.readMax = 1;
    SETTLE_LIMITS.maxPages = 1;
    sent.length = 0;
    const landed = await merge(name, d.a.change!);
    expect(landed.status, JSON.stringify(landed.json)).toBe(200);
    expect(await states(name, [...d.older, d.auto])).toEqual(['satisfied', 'stale', 'satisfied']);
    expect((await getChange(name, d.autoN)).json.state).toBe('open');
    const handed = settleSends();
    expect(handed).toHaveLength(1);
    expect(await intentsOf(name)).toHaveLength(1);
    // The next owner claims the auto dependent's mark first, then the last page's earlier-sorting mark displaces it.
    await expireClaims(name);
    sent.length = 0;
    return { ...d, msg: handed[0] };
  }

  it('a continuation whose bounded wake claim displaces a mark it claimed reports remaining work; a retry under a fresh owner resumes the dependent', async () => {
    const name = 'settle-displaced-queue';
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    try {
      const { repo, older, auto, autoN, msg } = await displacedContinuation(name);
      const first = await deliverRaw(msg);
      expect(await states(name, [...older, auto])).toEqual(Array(3).fill('satisfied'));
      expect((await getChange(name, autoN)).json.state).toBe('open');
      expect(await wakeMarks(name)).toBe(1);
      // Not done: the delivery hands the displaced mark on (successor continuation and the kept intent) before it is acknowledged.
      expect(first.explicitAcks).toHaveLength(1);
      expect(settleSends()).toEqual([msg]);
      expect(await intentsOf(name)).toHaveLength(1);

      // The successor runs under a fresh owner token: the live claim is held, so its delivery is retried, not acknowledged.
      sent.length = 0;
      const held = await deliverRaw(msg);
      expect(held.explicitAcks).toEqual([]);
      expect(held.retryMessages).toHaveLength(1);
      expect((await getChange(name, autoN)).json.state).toBe('open');

      // At the claim's expiry the retry resumes it.
      await expireClaims(name);
      await deliver(msg);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(isAncestorOf(repo, auto.head, repo.refs.get(MAIN)!)).toBe(true);
      expect(await wakeMarks(name)).toBe(0);
      expect(settleSends()).toEqual([]);
      expect(await fireOwner(name)).toBe(true);
      expect(await intentsOf(name)).toEqual([]);
    } finally {
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('an alarm wakeup whose bounded wake claim displaces a mark it claimed keeps the intent, re-arms by the claim expiry and resumes the dependent', async () => {
    const name = 'settle-displaced-alarm';
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    const logs = vi.spyOn(console, 'log');
    try {
      const { repo, older, auto, autoN } = await displacedContinuation(name);
      logs.mockClear();
      expect(await fireOwner(name)).toBe(true);
      expect(await states(name, [...older, auto])).toEqual(Array(3).fill('satisfied'));
      expect((await getChange(name, autoN)).json.state).toBe('open');
      expect(await wakeMarks(name)).toBe(1);
      expect(settleLines(logs)).toEqual([expect.objectContaining({ outcome: 'continue', settle: expect.objectContaining({ settled: 1, remaining: true }) })]);
      expect(await intentsOf(name)).toHaveLength(1);

      // The next wakeup (a fresh token) finds the mark under that wakeup's live claim: held, revisited by its expiry.
      logs.mockClear();
      expect(await fireOwner(name)).toBe(true);
      expect(settleLines(logs)).toEqual([expect.objectContaining({ outcome: 'held', settle: expect.objectContaining({ held: 1, remaining: true }) })]);
      const [intent] = await intentsOf(name);
      expect(intent!.deadline).toBeLessThanOrEqual((await claimExpiry(name))!);
      expect(await alarmOf(name)).toBe(intent!.deadline);
      expect((await getChange(name, autoN)).json.state).toBe('open');

      await expireClaims(name);
      logs.mockClear();
      expect(await fireOwner(name)).toBe(true);
      expect((await getChange(name, autoN)).json.state).toBe('merged');
      expect(isAncestorOf(repo, auto.head, repo.refs.get(MAIN)!)).toBe(true);
      expect(settleLines(logs)).toEqual([expect.objectContaining({ outcome: 'done', settle: expect.objectContaining({ resumed: 1, remaining: false }) })]);
      expect(await wakeMarks(name)).toBe(0);
      expect(await intentsOf(name)).toEqual([]);
      expect(await alarmOf(name)).toBeNull();
    } finally {
      logs.mockRestore();
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('a landing whose own wake effects fail hands them to the owners, which finish them once', async () => {
    const name = 'settle-landing-wake';
    await seedRepo(name);
    const { a, dependents, changeFor } = await pinnedSource(name, 1);
    const queuedN = await changeFor(dependents[0]!, 'review');
    expect((await enqueue(name, queuedN)).status).toBe(201);
    // The pin is on the landed head: the merged-record batch satisfies it and records its wake mark.
    failSends.match = (b) => b?.type === 'kvarm.train';
    sent.length = 0;
    const landed = await merge(name, a.change!);
    expect(landed.status).toBe(200);
    expect(await states(name, dependents)).toEqual(['satisfied']);
    expect(await wakeMarks(name)).toBe(1);
    const handed = sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body);
    expect(handed).toEqual([expect.objectContaining({ repoId: repoIds[name], mergeCommit: landed.json.merge.mergeCommit, ref: MAIN })]);
    expect(await intentsOf(name)).toHaveLength(1);

    failSends.match = null;
    sent.length = 0;
    await deliver(handed[0]);
    expect(sent.map((m) => m.body)).toEqual([{ type: 'kvarm.train', repoId: repoIds[name], ref: MAIN, reason: 'dependency-settled' }]);
    expect(await wakeMarks(name)).toBe(0);
    sent.length = 0;
    expect(await fireOwner(name)).toBe(true);
    expect(sent).toEqual([]);
    expect(await intentsOf(name)).toEqual([]);
  });

  it('a failed settlement intent write falls back to the queue continuation after bounded retries', async () => {
    const name = 'settle-fallback';
    await seedRepo(name);
    const saved = { readMax: DEPENDENCY_LIMITS.readMax, maxPages: SETTLE_LIMITS.maxPages };
    const real = env.MERGE_LOCK;
    let writes = 0;
    try {
      const { a } = await pinnedSource(name, 3);
      await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
      DEPENDENCY_LIMITS.readMax = 1;
      SETTLE_LIMITS.maxPages = 1;
      (env as { MERGE_LOCK: unknown }).MERGE_LOCK = {
        idFromName: (n: string) => real.idFromName(n),
        get: () => ({
          fetch: async () => {
            writes++;
            throw new Error('MergeLock unavailable (test)');
          },
        }),
      };
      sent.length = 0;
      const landed = await merge(name, a.change!);
      expect(landed.status).toBe(200);
      expect(writes).toBe(SETTLE_INTENT.writeAttempts);
      expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle').map((m) => m.body)).toEqual([
        expect.objectContaining({ repoId: repoIds[name], mergeCommit: landed.json.merge.mergeCommit, ref: MAIN }),
      ]);
    } finally {
      (env as { MERGE_LOCK: unknown }).MERGE_LOCK = real;
      DEPENDENCY_LIMITS.readMax = saved.readMax;
      SETTLE_LIMITS.maxPages = saved.maxPages;
    }
  });

  it('an Artifacts push event is still dispatched as a push while settlement continuations share the queue', async () => {
    const name = 'settle-dispatch';
    await seedRepo(name);
    const pushesBefore = (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_events WHERE repo_id = ?').bind(repoIds[name]).first<{ n: number }>())!.n;
    // A push body is never read as a continuation, even when it carries continuation-like fields.
    const body = { ...pushEvent(name, 'refs/heads/side', '0'.repeat(40), repos[name]!.refs.get(MAIN)!, (clock += 1000)), repoId: repoIds[name], mergeCommit: 'a'.repeat(40), mergedAt: 1, changeSetId: 'x' };
    sent.length = 0;
    await deliver(body);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM push_events WHERE repo_id = ?').bind(repoIds[name]).first<{ n: number }>())!.n).toBe(pushesBefore + 1);
    expect(sent.filter((m) => m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
  });

  it('an auto dependent that is not queued resumes when its source lands or its pin is detached', async () => {
    const { repo } = await seedRepo('auto-resume');
    const autoChange = async (w: Ws) => {
      const ch = await call('POST', api('auto-resume', `/workspaces/${w.id}/change-set`), tok.owner, { title: `Change ${w.id}`, mergePolicy: 'auto' });
      expect(ch.status, JSON.stringify(ch.json)).toBe(201);
      return ch.json.number as number;
    };
    const a = await workspace('auto-resume', 'a.txt', { change: 'review' });
    const b = await workspace('auto-resume', 'b.txt');
    expect((await pin('auto-resume', b.id, a.id, a.head)).status).toBe(201);
    const bn = await autoChange(b);
    expect((await getChange('auto-resume', bn)).json).toMatchObject({ state: 'open', queueState: null });
    expect((await merge('auto-resume', a.change!)).status).toBe(200);
    expect((await getChange('auto-resume', bn)).json).toMatchObject({ state: 'merged' });
    expect(isAncestorOf(repo, b.head, repo.refs.get(MAIN)!)).toBe(true);

    const c = await workspace('auto-resume', 'c.txt', { change: 'review' });
    const d = await workspace('auto-resume', 'd.txt');
    const edge = (await pin('auto-resume', d.id, c.id, c.head)).json;
    const dn = await autoChange(d);
    expect((await getChange('auto-resume', dn)).json.state).toBe('open');
    expect((await detach('auto-resume', d.id, edge.id)).status).toBe(200);
    expect((await getChange('auto-resume', dn)).json).toMatchObject({ state: 'merged' });
  });
});

// ---------------------------------------------------------------------------

describe('integration train', () => {
  it('publishes the predecessor first, unrelated work proceeds, and the dependent lands after it', async () => {
    const { repo, main } = await seedRepo('train-order');
    const a = await workspace('train-order', 'a.txt', { change: 'review' });
    const b = await workspace('train-order', 'b.txt', { change: 'review' });
    const c = await workspace('train-order', 'c.txt', { change: 'review' });
    const edge = (await pin('train-order', b.id, a.id, a.head)).json;
    for (const n of [b.change!, a.change!, c.change!]) expect((await enqueue('train-order', n)).status).toBe(201);

    // While A's checks run, B waits with a machine-readable reason and is not ejected.
    const gate = scriptedGate('pending');
    const waiting = await runTrain(env, repoIds['train-order']!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(waiting.published).toEqual([]);
    expect(waiting.ejected).toEqual([]);
    const status = await trainStatus('train-order');
    expect(status.status).toBe(200);
    expect(status.cost).toMatchObject({ rw: 0, q: 0, art: 0, do: 0 });
    expect(status.cost.d1).toBeLessThanOrEqual(3);
    const bEntry = status.json.entries.find((e: any) => e.number === b.change);
    expect(bEntry).toMatchObject({
      state: 'queued',
      waiting: { code: 'DEPENDENCY_PENDING' },
      dependencies: [expect.objectContaining({ id: edge.id, onWorkspace: a.id, state: 'active' })],
    });
    expect(status.json.dependencies).toEqual([expect.objectContaining({ id: edge.id, workspaceId: b.id })]);
    expect(status.json.entries.find((e: any) => e.number === a.change).waiting).toBeNull();
    expect((await trainStatus('train-order')).json).toEqual(status.json);

    gate.fallback = 'success';
    const run = await runTrain(env, repoIds['train-order']!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(run.published.indexOf(a.change!)).toBeGreaterThanOrEqual(0);
    expect(run.published.indexOf(a.change!)).toBeLessThan(run.published.indexOf(b.change!));
    expect(run.published).toContain(c.change);
    const chain = firstParents(repo, main).reverse();
    expect(chain).toHaveLength(3);
    const commits = (await rows('train-order')).map((r) => r.merge_commit);
    expect(new Set(commits).size).toBe(3);
    const at = (n: number) => chain.indexOf((rowsByNumber.get(n) ?? '') as string);
    const rowsByNumber = new Map((await rows('train-order')).map((r) => [r.change_number, r.merge_commit]));
    expect(at(a.change!)).toBeLessThan(at(b.change!));
    expect(isAncestorOf(repo, a.head, rowsByNumber.get(b.change!)!)).toBe(true);
    expect((await listDeps('train-order', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'satisfied' })]);
    expect((await rows('train-order')).map((r) => r.state)).toEqual(['published', 'published', 'published']);
  });

  it('a stacked dependent whose merge base moved when its source landed is judged again by the guard and publishes', async () => {
    const { repo, main } = await seedRepo('train-stacked');
    const a = await workspace('train-stacked', 'a.txt', { change: 'review' });
    const created = await call('POST', api('train-stacked', '/workspaces'), tok.owner, { task: 'work on b.txt over a', agent: 'agent' });
    expect(created.status).toBe(201);
    const bHead = await push('train-stacked', created.json.ref, { 'README.md': 'readme\n', 'a.txt': 'a.txt\n', 'b.txt': 'b.txt\n' }, [a.head]);
    const bChange = await call('POST', api('train-stacked', `/workspaces/${created.json.id}/change-set`), tok.owner, { title: 'Change b.txt', mergePolicy: 'review' });
    expect(bChange.status).toBe(201);
    const b = bChange.json.number as number;
    expect((await pin('train-stacked', created.json.id, a.id, a.head)).status).toBe(201);
    for (const n of [b, a.change!]) expect((await enqueue('train-stacked', n)).status).toBe(201);
    const guardBases = async () =>
      (
        await env.DB.prepare(
          `SELECT json_extract(summary, '$.baseTree') AS base FROM check_runs WHERE repo_id = ?1 AND head_sha = ?2 AND name = 'kvarm/guard' ORDER BY created_at`,
        )
          .bind(repoIds['train-stacked'], bHead)
          .all<{ base: string }>()
      ).results.map((r) => r.base);
    expect(await guardBases()).toEqual([commitOf(repo, main).tree]);

    sent.length = 0;
    const first = await runTrain(env, repoIds['train-stacked']!, MAIN, trainDeps());
    expect(first.published).toEqual([a.change]);
    // The source landed: B's merge base is now A's head, so its creation-time guard (judged against main's old tree) no longer answers.
    expect(await guardBases()).toEqual([commitOf(repo, main).tree, commitOf(repo, a.head).tree]);
    expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'kvarm.train', ref: MAIN, reason: 'guard-recorded' }));

    const second = await runTrain(env, repoIds['train-stacked']!, MAIN, trainDeps());
    expect(second.published).toEqual([b]);
    expect(repo.refs.get(MAIN)).toBe(bHead);
    expect((await rows('train-stacked')).map((r) => r.state)).toEqual(['published', 'published']);
    // A repeated pass over a judged head records nothing more.
    expect(await guardBases()).toHaveLength(2);
  });

  it('an explicit merge of a stacked change after its base landed answers pending once and judges the new base for the retry', async () => {
    await seedRepo('merge-stacked');
    const a = await workspace('merge-stacked', 'a.txt', { change: 'review' });
    const created = await call('POST', api('merge-stacked', '/workspaces'), tok.owner, { task: 'work on b.txt over a', agent: 'agent' });
    await push('merge-stacked', created.json.ref, { 'README.md': 'readme\n', 'a.txt': 'a.txt\n', 'b.txt': 'b.txt\n' }, [a.head]);
    const b = (await call('POST', api('merge-stacked', `/workspaces/${created.json.id}/change-set`), tok.owner, { title: 'Change b.txt', mergePolicy: 'review' })).json
      .number as number;
    expect((await merge('merge-stacked', a.change!)).status).toBe(200);
    const refused = await merge('merge-stacked', b);
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe('REQUIRED_CHECKS_PENDING');
    const retried = await merge('merge-stacked', b);
    expect(retried.status, JSON.stringify(retried.json)).toBe(200);
  });

  it('a broken pin keeps the queued dependent waiting (never ejected); detaching lets it publish', async () => {
    const { repo, main } = await seedRepo('train-broken');
    const a = await workspace('train-broken', 'a.txt', { change: 'review' });
    const b = await workspace('train-broken', 'b.txt', { change: 'review' });
    const edge = (await pin('train-broken', b.id, a.id, a.head)).json;
    expect((await enqueue('train-broken', b.change!)).status).toBe(201);
    expect((await call('POST', api('train-broken', `/workspaces/${a.id}/abandon`), tok.owner)).status).toBe(200);
    const run = await runTrain(env, repoIds['train-broken']!, MAIN, trainDeps());
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([]);
    expect((await rows('train-broken')).map((r) => [r.state, r.active, r.reason_code])).toEqual([['queued', 1, 'DEPENDENCY_BROKEN']]);
    expect(repo.refs.get(MAIN)).toBe(main);

    sent.length = 0;
    expect((await detach('train-broken', b.id, edge.id)).status).toBe(200);
    expect(sent.map((m) => m.body)).toEqual([expect.objectContaining({ type: 'kvarm.train', ref: MAIN })]);
    const after = await runTrain(env, repoIds['train-broken']!, MAIN, trainDeps());
    expect(after.published).toEqual([b.change]);
    expect(repo.refs.get(b.ref)).toBe(b.head);
  });

  it('an explicit merge of the source kicks the queued dependent, which then publishes', async () => {
    await seedRepo('train-kick');
    const a = await workspace('train-kick', 'a.txt', { change: 'review' });
    const b = await workspace('train-kick', 'b.txt', { change: 'review' });
    expect((await pin('train-kick', b.id, a.id, a.head)).status).toBe(201);
    expect((await enqueue('train-kick', b.change!)).status).toBe(201);
    expect((await runTrain(env, repoIds['train-kick']!, MAIN, trainDeps())).published).toEqual([]);
    sent.length = 0;
    expect((await merge('train-kick', a.change!)).status).toBe(200);
    expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'kvarm.train', ref: MAIN, reason: 'dependency-landed' }));
    expect((await runTrain(env, repoIds['train-kick']!, MAIN, trainDeps())).published).toEqual([b.change]);
  });

  it('an older entry of one principal is prepared in the first window despite a stream from another', async () => {
    await seedRepo('fair');
    await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(repoIds.fair, userIds['dep-writer'], 'write', userIds[OWNER], Date.now(), Date.now())
      .run();
    const stream: number[] = [];
    for (let i = 0; i < TRAIN_LIMITS.window + 2; i++) {
      const w = await workspace('fair', `s${i}.txt`, { change: 'review' });
      stream.push(w.change!);
    }
    const lone = await workspace('fair', 'lone.txt', { change: 'review', token: tok.writer });
    for (const n of stream) expect((await enqueue('fair', n)).status).toBe(201);
    expect((await enqueue('fair', lone.change!, tok.writer)).status).toBe(201);

    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });
    const first = await runTrain(env, repoIds.fair!, MAIN, deps);
    expect(first.maxPrepared).toBe(TRAIN_LIMITS.window);
    const window = deps.events.find((e): e is Extract<TrainEvent, { type: 'window' }> => e.type === 'window')!;
    const prepared = window.states.filter((s) => s.state !== 'queued').map((s) => s.number);
    expect(prepared).toHaveLength(TRAIN_LIMITS.window);
    expect(prepared).toContain(lone.change);
    // The other principal's oldest entry stays ahead; its later ones make room.
    expect(prepared[0]).toBe(stream[0]);

    gate.fallback = 'success';
    const run = await runTrain(env, repoIds.fair!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(run.published.indexOf(lone.change!)).toBeLessThan(TRAIN_LIMITS.window);
    expect(run.published).toHaveLength(stream.length + 1);
  });

  it('orders the read-ahead fairly across principals while composed entries keep their place', () => {
    const e = (id: string, seq: number, principal: string, state = 'queued') => ({ id, seq, principal, state });
    const rows = [e('a1', 1, 'A', 'checking'), e('a2', 2, 'A', 'checking'), e('a3', 3, 'A'), e('a4', 4, 'A'), e('b1', 5, 'B'), e('a5', 6, 'A'), e('b2', 7, 'B')];
    expect(fairOrder(rows).map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'a3', 'a4', 'a5']);
    // All queued: one entry per principal per round, arrival order within a round and within a principal.
    const queued = rows.map((r) => ({ ...r, state: 'queued' }));
    expect(fairOrder(queued).map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'a4', 'a5']);
  });

  it('entries waiting on pins never hide a later prerequisite or unrelated work from a pass', async () => {
    const { repo } = await seedRepo('hidden');
    const saved = TRAIN_LIMITS.readAhead;
    try {
      const a = await workspace('hidden', 'a.txt', { change: 'review' });
      const b1 = await workspace('hidden', 'b1.txt', { change: 'review' });
      const b2 = await workspace('hidden', 'b2.txt', { change: 'review' });
      const c = await workspace('hidden', 'c.txt', { change: 'review' });
      for (const b of [b1, b2]) expect((await pin('hidden', b.id, a.id, a.head)).status).toBe(201);
      for (const n of [b1.change!, b2.change!, a.change!, c.change!]) expect((await enqueue('hidden', n)).status).toBe(201);
      TRAIN_LIMITS.readAhead = 2;
      const run = await runTrain(env, repoIds.hidden!, MAIN, trainDeps());
      expect(run.ejected).toEqual([]);
      expect([...run.published].sort()).toEqual([a.change, b1.change, b2.change, c.change].sort());
      expect(run.published.indexOf(a.change!)).toBeLessThan(run.published.indexOf(b1.change!));
      expect(isAncestorOf(repo, a.head, repo.refs.get(MAIN)!)).toBe(true);
    } finally {
      TRAIN_LIMITS.readAhead = saved;
    }
  });

  it('a window whose pins exceed one read cap still sees every entry pin and never prepares a waiting dependent', async () => {
    await seedRepo('pins-cap');
    const saved = DEPENDENCY_LIMITS.readMax;
    try {
      const a = await workspace('pins-cap', 'a.txt', { change: 'review' });
      const x = await workspace('pins-cap', 'x.txt', { change: 'review' });
      const b1 = await workspace('pins-cap', 'b1.txt', { change: 'review' });
      const b2 = await workspace('pins-cap', 'b2.txt', { change: 'review' });
      const b3 = await workspace('pins-cap', 'b3.txt', { change: 'review' });
      const c = await workspace('pins-cap', 'c.txt', { change: 'review' });
      const edges = [
        (await pin('pins-cap', b1.id, a.id, a.head)).json,
        (await pin('pins-cap', b1.id, x.id, x.head)).json,
        (await pin('pins-cap', b2.id, a.id, a.head)).json,
        (await pin('pins-cap', b3.id, x.id, x.head)).json,
      ];
      for (const n of [b1.change!, b2.change!, b3.change!, c.change!]) expect((await enqueue('pins-cap', n)).status).toBe(201);
      // Every workspace stays within the cap; the window's four pins together exceed it.
      DEPENDENCY_LIMITS.readMax = 2;

      const gate = scriptedGate('pending');
      const deps = trainDeps({ gate: () => gate.gate });
      const run = await runTrain(env, repoIds['pins-cap']!, MAIN, deps);
      expect(run.published).toEqual([]);
      expect(run.ejected).toEqual([]);
      const window = deps.events.find((e): e is Extract<TrainEvent, { type: 'window' }> => e.type === 'window')!;
      const state = new Map(window.states.map((s) => [s.number, s.state]));
      for (const b of [b1, b2, b3]) expect(state.get(b.change!), `#${b.change}`).toBe('queued');
      expect(state.get(c.change!)).not.toBe('queued');
      const composed = deps.events.filter((e): e is Extract<TrainEvent, { type: 'checks' }> => e.type === 'checks').map((e) => e.number);
      expect(composed).toEqual([c.change]);
      expect((await rows('pins-cap')).filter((r) => r.change_number !== c.change).map((r) => r.reason_code)).toEqual([
        'DEPENDENCY_PENDING',
        'DEPENDENCY_PENDING',
        'DEPENDENCY_PENDING',
      ]);

      const status = await trainStatus('pins-cap');
      expect(status.status).toBe(200);
      for (const b of [b1, b2, b3]) {
        expect(status.json.entries.find((e: any) => e.number === b.change), `#${b.change}`).toMatchObject({ waiting: { code: 'DEPENDENCY_PENDING' } });
      }
      expect(status.json.entries.find((e: any) => e.number === b1.change).dependencies).toHaveLength(2);
      expect(status.json.entries.find((e: any) => e.number === c.change).waiting).toBeNull();
      expect(status.json.dependencies.map((d: any) => d.id).sort()).toEqual(edges.map((e) => e.id).sort());
      expect(status.cost).toMatchObject({ rw: 0, q: 0, art: 0, do: 0 });
      expect(status.cost.d1).toBeLessThanOrEqual(3);
    } finally {
      DEPENDENCY_LIMITS.readMax = saved;
    }
  });

  it('a source ejected from the train breaks only the pins on its ejected head, recoverable by repin', async () => {
    for (const [name, cause] of [
      ['eject-conflict', 'MERGE_CONFLICT'],
      ['eject-checks', 'CHECKS_FAILED'],
      ['eject-guard', 'GUARD_INCOMPLETE'],
    ] as const) {
      const { main } = await seedRepo(name);
      if (cause === 'GUARD_INCOMPLETE') {
        // A rule requiring a complete guard; dep-writer approves so the protected ref's review gate holds.
        const now = Date.now();
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO branch_rules (id, repo_id, pattern, required_checks, required_approvals, guard_completeness, created_by, created_at, updated_by, updated_at)
             VALUES (?, ?, 'refs/heads/main', '[]', 0, 'required', ?, ?, ?, ?)`,
          ).bind(crypto.randomUUID(), repoIds[name], userIds[OWNER], now, userIds[OWNER], now),
          env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
            repoIds[name],
            userIds['dep-writer'],
            'write',
            userIds[OWNER],
            now,
            now,
          ),
        ]);
      }
      const a = await workspace(name, 'a.txt', { change: 'review' });
      const b = await workspace(name, 'b.txt', { change: 'review' });
      const other = await workspace(name, 'o.txt', { change: 'review' });
      const c = await workspace(name, 'c.txt');
      const edge = (await pin(name, b.id, a.id, a.head)).json;
      const unrelated = (await pin(name, c.id, other.id, other.head)).json;
      if (cause === 'GUARD_INCOMPLETE') {
        for (const n of [a.change!, b.change!]) expect((await call('POST', api(name, `/changes/${n}/approve`), tok.writer, {})).status).toBe(201);
      }
      for (const n of [a.change!, b.change!]) expect((await enqueue(name, n)).status).toBe(201);
      let deps = trainDeps();
      if (cause === 'MERGE_CONFLICT') await push(name, MAIN, { 'README.md': 'readme\n', 'a.txt': 'main a\n' }, [main]);
      else if (cause === 'GUARD_INCOMPLETE') {
        const gate: ChecksGate = {
          async requiredChecksFor(_repo, treeSha, configId) {
            return { treeSha, configId, required: [{ name: 'kvarm/guard', state: 'success', producer: 'test', incomplete: true, uninspected: 1 }], state: 'success' };
          },
        };
        deps = trainDeps({ gate: () => gate });
      } else deps = trainDeps({ gate: () => scriptedGate('failure').gate });
      const run = await runTrain(env, repoIds[name]!, MAIN, deps);
      expect(run.ejected, name).toEqual([{ number: a.change, code: cause }]);
      expect(run.published, name).toEqual([]);
      const listed = (await listDeps(name, b.id)).json.dependencies;
      expect(listed, name).toEqual([expect.objectContaining({ id: edge.id, state: 'broken', reason: expect.objectContaining({ code: 'SOURCE_EJECTED' }) })]);
      expect(listed[0].reason.message, name).toContain(cause);
      expect((await listDeps(name, c.id)).json.dependencies, name).toEqual([expect.objectContaining({ id: unrelated.id, state: 'active' })]);
      expect((await rows(name)).find((r) => r.change_number === b.change), name).toMatchObject({ state: 'queued', active: 1 });
      const back = await repin(name, b.id, edge.id, { revision: a.head });
      expect(back.status, name).toBe(200);
      expect(back.json, name).toMatchObject({ state: 'active', previous: { state: 'broken', reason: { code: 'SOURCE_EJECTED' } } });
    }
  });

  /** The train publication's merged-record batch: the one whose first statement records the entry published. */
  interface RecordedStatement {
    sql: string;
    result: D1Result;
  }
  function batchRecorder(real: D1Database): { db: D1Database; batches: RecordedStatement[][] } {
    const sqlOf = new WeakMap<object, string>();
    const batches: RecordedStatement[][] = [];
    const tracked = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
      const p = new Proxy(s, {
        get(t, k) {
          if (k === 'bind') return (...args: unknown[]) => tracked(t.bind(...args), sql);
          const v = Reflect.get(t, k);
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      sqlOf.set(p, sql);
      return p;
    };
    const db = new Proxy(real, {
      get(t, k) {
        if (k === 'prepare') return (sql: string) => tracked(t.prepare(sql), sql);
        if (k === 'batch') {
          return async (stmts: D1PreparedStatement[]) => {
            const out = await t.batch(stmts);
            batches.push(stmts.map((s, i) => ({ sql: sqlOf.get(s) ?? '', result: out[i]! })));
            return out;
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    return { db, batches };
  }
  const isRecordBatch = (b: RecordedStatement[]) => b[0]?.sql.includes("SET state = 'published'") ?? false;
  const DEPENDENCY_STATEMENTS = {
    wakeMarks: (sql: string) => sql.includes('INSERT OR IGNORE INTO fenced_claims'),
    satisfy: (sql: string) => sql.includes('UPDATE workspace_dependencies SET satisfied_commit'),
    dependents: (sql: string) => sql.includes("'edge' AS kind"),
  };
  const dependencyStatementsOf = (b: RecordedStatement[]) =>
    b.filter((s) => Object.values(DEPENDENCY_STATEMENTS).some((is) => is(s.sql)));

  it('a train landing of a change no workspace is linked to composes no dependency statements in its merged-record batch', async () => {
    const name = 'record-branch';
    const { repo, main } = await seedRepo(name);
    const head = await commit(repo, { 'README.md': 'readme\n', 'f.txt': 'f\n' }, [main]);
    repo.refs.set('refs/heads/feature', head.sha);
    const created = await call('POST', api(name, '/changes'), tok.owner, { title: 'branch change', base: 'main', head: 'feature', mergePolicy: 'review' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const n = created.json.number as number;
    expect((await enqueue(name, n)).status).toBe(201);
    const rec = batchRecorder(env.DB);
    const deps = trainDeps();
    const meter = new CostMeter();
    const run = await runWithMeter(meter, () => runTrain(meter.wrapEnv({ ...env, DB: rec.db }), repoIds[name]!, MAIN, deps));
    expect(run.published).toEqual([n]);
    const records = rec.batches.filter(isRecordBatch);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(dependencyStatementsOf(record).map((s) => s.sql.slice(0, 60))).toEqual([]);
    // The rest of the merged record is unchanged: the change, its (absent) workspace, signals and conflict task.
    expect(record.some((s) => s.sql.includes("UPDATE change_sets SET state = 'merged'") && s.result.meta.changes === 1)).toBe(true);
    expect(record.some((s) => s.sql.includes("UPDATE workspaces SET status = 'merged'"))).toBe(true);
    const merged = (await getChange(name, n)).json;
    expect(merged).toMatchObject({ state: 'merged', mergeCommit: repo.refs.get(MAIN) });
    expect(await wakeMarks(name)).toBe(0);
    expect(sent.filter((m) => m.body?.reason === 'dependency-landed' || m.body?.type === 'kvarm.dependency-settle')).toEqual([]);
    const recorded = deps.events.find((e): e is Extract<TrainEvent, { type: 'publish' }> => e.type === 'publish' && e.status === 'recorded');
    expect(recorded?.cost).toMatchObject({ do: 2, sub: 2 });
    expect(recorded!.cost!.d1).toBeLessThanOrEqual(3);
    expect(recorded!.cost!.rr).toBeLessThanOrEqual(12);
    expect(recorded!.cost!.rw).toBeLessThanOrEqual(8);
  });

  it('a train landing with pins on its head runs the wake-mark, satisfaction and landed-dependents statements in its merged-record batch', async () => {
    const name = 'record-edges';
    await seedRepo(name);
    const a = await workspace(name, 'a.txt', { change: 'review' });
    // c pins a's first head (settled by ancestry after the batch), b pins the head that lands (satisfied in the batch).
    const c = await workspace(name, 'c.txt');
    const older = (await pin(name, c.id, a.id, a.head)).json;
    const landed = await push(name, a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
    const b = await workspace(name, 'b.txt', { change: 'review' });
    const edge = (await pin(name, b.id, a.id, landed)).json;
    expect((await enqueue(name, b.change!)).status).toBe(201);
    expect((await enqueue(name, a.change!)).status).toBe(201);
    sent.length = 0;
    const rec = batchRecorder(env.DB);
    const first = await runTrain({ ...env, DB: rec.db }, repoIds[name]!, MAIN, trainDeps());
    expect(first.published).toContain(a.change);
    const records = rec.batches.filter(isRecordBatch);
    const record = records[0]!;
    const deps = dependencyStatementsOf(record);
    expect(deps.map((s) => Object.entries(DEPENDENCY_STATEMENTS).find(([, is]) => is(s.sql))![0])).toEqual(['wakeMarks', 'satisfy', 'dependents']);
    // They close the batch, in that order.
    expect(record.slice(-3)).toEqual(deps);
    const mergeCommit = (await getChange(name, a.change!)).json.mergeCommit as string;
    expect(deps[0]!.result.meta.changes).toBe(1);
    expect(deps[1]!.result.meta.changes).toBe(1);
    const landedRows = deps[2]!.result.results as Array<{ kind: string; id: string; target_ref: string | null }>;
    expect(landedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'edge', id: older.id }),
        expect.objectContaining({ kind: 'wake', id: expect.stringContaining(b.id), target_ref: MAIN }),
      ]),
    );
    expect((await listDeps(name, b.id)).json.dependencies).toEqual([expect.objectContaining({ id: edge.id, state: 'satisfied', satisfiedBy: mergeCommit })]);
    expect((await listDeps(name, c.id)).json.dependencies).toEqual([expect.objectContaining({ id: older.id, state: 'satisfied', satisfiedBy: mergeCommit })]);
    expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'kvarm.train', ref: MAIN, reason: 'dependency-landed' }));
    expect(await wakeMarks(name)).toBe(0);
    if (!first.published.includes(b.change!)) expect((await runTrain(env, repoIds[name]!, MAIN, trainDeps())).published).toEqual([b.change]);
  });

  it('a pin written on the source while it publishes is still satisfied by the landing', async () => {
    const name = 'record-late-pin';
    await seedRepo(name);
    const a = await workspace(name, 'a.txt', { change: 'review' });
    const b = await workspace(name, 'b.txt');
    expect((await enqueue(name, a.change!)).status).toBe(201);
    let late: Record<string, any> | null = null;
    // After the publication's claim batch (which sees no pin on the source) and before the record batch.
    const pusher: TrainDeps['pusher'] = (e, r) => {
      const real = defaultTrainDeps.pusher(e, r);
      return {
        ...real,
        async prepareUpdate(...args: Parameters<typeof real.prepareUpdate>) {
          const update = await real.prepareUpdate(...args);
          return {
            ...update,
            async send() {
              const res = await pin(name, b.id, a.id, a.head);
              expect(res.status, JSON.stringify(res.json)).toBe(201);
              late = res.json;
              return update.send();
            },
          };
        },
      };
    };
    const run = await runTrain(env, repoIds[name]!, MAIN, trainDeps({ pusher }));
    expect(run.published).toEqual([a.change]);
    expect(late).not.toBeNull();
    const mergeCommit = (await getChange(name, a.change!)).json.mergeCommit as string;
    expect((await listDeps(name, b.id)).json.dependencies).toEqual([expect.objectContaining({ id: late!.id, state: 'satisfied', satisfiedBy: mergeCommit })]);
  });

  it('independent target partitions continue separately while a dependent waits', async () => {
    const { repo, main } = await seedRepo('partitions');
    repo.refs.set('refs/heads/dev', main);
    const a = await workspace('partitions', 'a.txt', { change: 'review' });
    const b = await workspace('partitions', 'b.txt', { change: 'review' });
    const d = await workspace('partitions', 'd.txt', { change: 'review', base: 'dev' });
    expect((await pin('partitions', b.id, a.id, a.head)).status).toBe(201);
    expect((await enqueue('partitions', b.change!)).status).toBe(201);
    expect((await enqueue('partitions', d.change!)).status).toBe(201);
    expect((await runTrain(env, repoIds.partitions!, MAIN, trainDeps())).published).toEqual([]);
    expect((await runTrain(env, repoIds.partitions!, 'refs/heads/dev', trainDeps())).published).toEqual([d.change]);
    expect(repo.refs.get(MAIN)).toBe(main);
  });
});
