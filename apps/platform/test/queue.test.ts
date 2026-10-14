/**
 * Merge queue and integration train (services/queue.ts) over the in-memory
 * Artifacts fake. Enqueue/dequeue/list go through the Worker's routes; train
 * runs are driven directly with injected kicks, checks-gate and (where a
 * test needs it) publication lease, so nothing depends on queue delivery
 * timing. The real MergeLock Durable Object serves the lease otherwise.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { CostMeter, runWithMeter, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { recordGuard } from '../src/services/changes';
import type { ChecksGate, CheckState } from '../src/services/checksGate';
import {
  TRAIN_LIMITS,
  defaultTrainDeps,
  mergeLockLease,
  onQueuedHeadMoved,
  runTrain,
  type TrainDeps,
  type TrainEvent,
} from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, installFakeGitRemote, lsRefsPrefixes, restoreFetch, writeTree, type Files } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, recordingEvents, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const fakeEvents = recordingEvents();
const sent = fakeEvents.sent;
const seedUser = (login: string) => seedUserBase(env, login, { userIds });
const seedRepo = async (name: string) => (await seedRepoBase(env, name, { owner: OWNER, visibility: 'public', repoIds })).repo;
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'mq-owner';
const MAIN = 'refs/heads/main';

/** Kicks recorded instead of delivered: train runs are driven by the tests. */

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', writer: '' };
const repoIds: Record<string, string> = {};
const userIds: Record<string, string> = {};

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const createChange = (repo: string, head: string, mergePolicy = 'review', token = tok.owner) =>
  call('POST', api(repo, '/changes'), token, { title: `Change ${head}`, base: 'main', head, mergePolicy });
const enqueue = (repo: string, n: number, body?: unknown, token = tok.owner) => call('POST', api(repo, `/changes/${n}/enqueue`), token, body);
const dequeue = (repo: string, n: number, token = tok.owner) => call('DELETE', api(repo, `/changes/${n}/enqueue`), token);
const queueOf = (repo: string, q = '', token: string | undefined = tok.owner) => call('GET', api(repo, `/queue${q}`), token);
const getChange = (repo: string, n: number) => call('GET', api(repo, `/changes/${n}`), tok.owner);

/** main = README; branch `b<i>` = main + its own file f<i>.txt. Returns the change numbers in creation order. */
async function setup(name: string, count: number, policy = 'review'): Promise<{ repo: FakeRepo; main: string; numbers: number[] }> {
  const repo = await seedRepo(name);
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set(MAIN, main.sha);
  const numbers: number[] = [];
  for (let i = 1; i <= count; i++) {
    const b = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i}\n` }, [main.sha]);
    repo.refs.set(`refs/heads/b${i}`, b.sha);
    const r = await createChange(name, `b${i}`, policy);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    numbers.push(r.json.number as number);
  }
  return { repo, main: main.sha, numbers };
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

/** First-parent chain of main back to `stop` (exclusive). */
function firstParents(repo: FakeRepo, stop: string): string[] {
  const out: string[] = [];
  let sha = repo.refs.get(MAIN);
  while (sha && sha !== stop) {
    out.push(sha);
    sha = commitOf(repo, sha).parents[0];
  }
  return out;
}

/** Tree of main + the given f<i>.txt files (what a composition of those changes must produce). */
async function treeWith(repo: FakeRepo, files: number[]): Promise<string> {
  const f: Files = { 'README.md': 'readme\n' };
  for (const i of files) f[`f${i}.txt`] = `file ${i}\n`;
  return writeTree(repo, f);
}

/** A gate whose answer per tree the test controls (default for unknown trees: `fallback`). */
function scriptedGate(fallback: CheckState = 'success') {
  const states = new Map<string, CheckState>();
  const asked: string[] = [];
  const gate: ChecksGate = {
    async requiredChecksFor(_repo, treeSha, configId) {
      asked.push(treeSha);
      const state = states.get(treeSha) ?? s.fallback;
      return { treeSha, configId, required: [{ name: 'ci/test', state, producer: 'test' }], state };
    },
  };
  const s = { gate, states, asked, fallback };
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

async function entries(name: string): Promise<Array<{ change_number: number; state: string; active: number; reason_code: string | null; generation: number; cost: string | null; head_sha: string }>> {
  return (
    (
      await env.DB.prepare('SELECT change_number, state, active, reason_code, generation, cost, head_sha FROM merge_queue WHERE repo_id = ? ORDER BY seq')
        .bind(repoIds[name])
        .all<{ change_number: number; state: string; active: number; reason_code: string | null; generation: number; cost: string | null; head_sha: string }>()
    ).results ?? []
  );
}

async function leaseStatus(name: string): Promise<{ lease: unknown; generation: number }> {
  const stub = env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(`${repoIds[name]}:${MAIN}`));
  return (await (await stub.fetch('https://merge-lock/status')).json()) as { lease: unknown; generation: number };
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.writer = (await mintPAT(env, await seedUser('mq-writer'), 'writer', FULL)).token;
});

afterAll(() => restoreFetch());

afterEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('enqueue, dequeue and the queue read', () => {
  it('lists enqueued changes in enqueue order with positions, and dequeue removes only that change', async () => {
    const { numbers } = await setup('order', 2);
    const [one, two] = numbers as [number, number];
    const e1 = await enqueue('order', one);
    expect(e1.status, JSON.stringify(e1.json)).toBe(201);
    expect(e1.json.entry).toMatchObject({ number: one, state: 'queued', target: 'main', position: null });
    expect(sent.map((m) => m.body)).toEqual([expect.objectContaining({ type: 'kvarm.train', repoId: repoIds.order, ref: MAIN, reason: 'enqueue' })]);
    expect((await enqueue('order', two)).status).toBe(201);

    const q = await queueOf('order', '?limit=10');
    expect(q.status).toBe(200);
    expect(q.json.entries.map((e: any) => [e.number, e.position, e.state])).toEqual([
      [one, 1, 'queued'],
      [two, 2, 'queued'],
    ]);
    expect(q.json.limits).toEqual({ window: TRAIN_LIMITS.window, runnerCapacity: TRAIN_LIMITS.runnerCapacity, admissionCapacity: TRAIN_LIMITS.admissionCapacity });
    expect((await getChange('order', one)).json.queueState).toBe('queued');

    const d = await dequeue('order', one);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ number: one, dequeued: true, entry: { state: 'dequeued' } });
    const after = await queueOf('order');
    expect(after.json.entries.map((e: any) => [e.number, e.position])).toEqual([[two, 1]]);
    const c1 = await getChange('order', one);
    expect(c1.json).toMatchObject({ state: 'open', queueState: null });
    expect((await dequeue('order', one)).json.code).toBe('NOT_QUEUED');
  });

  it('refuses a draft with 409 and enqueues it once its policy is review', async () => {
    const { numbers } = await setup('draft', 1, 'draft');
    const n = numbers[0]!;
    const r = await enqueue('draft', n);
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'DRAFT', error: expect.stringContaining('draft') });
    expect((await queueOf('draft')).json.entries).toEqual([]);
    expect((await getChange('draft', n)).json.state).toBe('open');
    expect(sent).toEqual([]);

    expect((await call('PATCH', api('draft', `/changes/${n}`), tok.owner, { mergePolicy: 'review' })).status).toBe(200);
    const ok = await enqueue('draft', n);
    expect(ok.status).toBe(201);
    expect((await queueOf('draft')).json.entries.map((e: any) => e.number)).toEqual([n]);
  });

  it('refuses a stale expected head or policy with 409 and creates no candidate', async () => {
    const { repo, numbers } = await setup('stale-expect', 1);
    const n = numbers[0]!;
    const head = repo.refs.get('refs/heads/b1')!;
    const wrong = 'f'.repeat(40);
    const r = await enqueue('stale-expect', n, { headSha: wrong });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'HEAD_MOVED', headSha: head });
    const p = await enqueue('stale-expect', n, { mergePolicy: 'auto' });
    expect(p.json.code).toBe('POLICY_CHANGED');
    expect(await entries('stale-expect')).toEqual([]);
    expect((await queueOf('stale-expect')).json.entries).toEqual([]);
    expect((await enqueue('stale-expect', n, { headSha: head, mergePolicy: 'review' })).status).toBe(201);
  });

  it('re-enqueueing a queued change checks its current state and the expected head and policy before the idempotent answer', async () => {
    const { numbers } = await setup('requeue', 1);
    const [n] = numbers as [number];
    expect((await enqueue('requeue', n)).status).toBe(201);
    const head = (await getChange('requeue', n)).json.headSha as string;
    const stale = await enqueue('requeue', n, { headSha: 'f'.repeat(40) });
    expect([stale.status, stale.json.code]).toEqual([409, 'HEAD_MOVED']);
    const policy = await enqueue('requeue', n, { mergePolicy: 'auto' });
    expect([policy.status, policy.json.code]).toEqual([409, 'POLICY_CHANGED']);
    const same = await enqueue('requeue', n, { headSha: head, mergePolicy: 'review' });
    expect(same.status, JSON.stringify(same.json)).toBe(200);
    expect(same.json).toMatchObject({ created: false, entry: { number: n, state: 'queued' } });
    expect((await call('PATCH', api('requeue', `/changes/${n}`), tok.owner, { mergePolicy: 'draft' })).status).toBe(200);
    const draft = await enqueue('requeue', n);
    expect([draft.status, draft.json.code]).toEqual([409, 'DRAFT']);
    expect(await entries('requeue')).toHaveLength(1);
  });

  it('answers 429 with Retry-After at admission capacity, without a hidden retry or a duplicate entry', async () => {
    const { numbers } = await setup('capacity', 3);
    const saved = TRAIN_LIMITS.admissionCapacity;
    TRAIN_LIMITS.admissionCapacity = 2;
    try {
      expect((await enqueue('capacity', numbers[0]!)).status).toBe(201);
      expect((await enqueue('capacity', numbers[1]!)).status).toBe(201);
      sent.length = 0;
      const full = await enqueue('capacity', numbers[2]!);
      expect(full.status).toBe(429);
      expect(full.json).toMatchObject({ code: 'QUEUE_FULL', retryAfter: TRAIN_LIMITS.retryAfterSeconds });
      expect(full.headers.get('retry-after')).toBe(String(TRAIN_LIMITS.retryAfterSeconds));
      // The refusal costs one explaining read after the guarded batch.
      expect(full.cost.d1).toBeLessThanOrEqual(3);
      expect(sent).toEqual([]);
      const again = await enqueue('capacity', numbers[0]!);
      expect(again.status).toBe(200);
      expect(again.json).toMatchObject({ created: false, entry: { number: numbers[0] } });
      const rows = await entries('capacity');
      expect(rows.map((r) => r.change_number)).toEqual([numbers[0], numbers[1]]);
      // Below capacity again, enqueue behaves as before.
      expect((await dequeue('capacity', numbers[1]!)).status).toBe(200);
      expect((await enqueue('capacity', numbers[2]!)).status).toBe(201);
    } finally {
      TRAIN_LIMITS.admissionCapacity = saved;
    }
  });

  it('keeps enqueue and the queue read within their work budgets, independent of history', async () => {
    const { numbers } = await setup('budget', 4);
    const first = await enqueue('budget', numbers[0]!);
    const second = await enqueue('budget', numbers[1]!);
    for (const r of [first, second]) {
      expect(r.cost.d1).toBeLessThanOrEqual(2);
      expect(r.cost.rr).toBeLessThanOrEqual(8);
      expect(r.cost.rw).toBeLessThanOrEqual(4);
      expect(r.cost.art).toBe(0);
      expect(r.cost.do).toBeLessThanOrEqual(1);
    }
    const before = await queueOf('budget', '?limit=10');
    for (let i = 0; i < 3; i++) {
      await dequeue('budget', numbers[2]!).catch(() => undefined);
      await enqueue('budget', numbers[2]!);
      await dequeue('budget', numbers[2]!);
    }
    const after = await queueOf('budget', '?limit=10');
    for (const r of [before, after]) {
      expect(r.cost).toMatchObject({ rw: 0, art: 0, do: 0 });
      expect(r.cost.d1).toBeLessThanOrEqual(2);
      expect(r.cost.rr).toBeLessThanOrEqual(20);
    }
    expect(after.cost.rr).toBe(before.cost.rr);
  });

  it('pages the queue with a cursor and keeps positions', async () => {
    const { numbers } = await setup('paging', 3);
    for (const n of numbers) await enqueue('paging', n);
    const p1 = await queueOf('paging', '?limit=2');
    expect(p1.json.entries.map((e: any) => e.position)).toEqual([1, 2]);
    expect(p1.json.truncated).toBe(true);
    const p2 = await queueOf('paging', `?limit=2&cursor=${p1.json.nextCursor}`);
    expect(p2.json.entries.map((e: any) => [e.number, e.position])).toEqual([[numbers[2], 3]]);
    expect(p2.json.nextCursor).toBeNull();
    expect((await queueOf('paging', '?limit=0')).status).toBe(400);
  });

  it('requires write access to enqueue and read access to list', async () => {
    const { numbers } = await setup('authz', 1);
    expect((await enqueue('authz', numbers[0]!, undefined, tok.writer)).status).toBe(403);
    expect((await call('POST', api('authz', `/changes/${numbers[0]}/enqueue`))).status).toBe(401);
    expect((await queueOf('authz', '', undefined)).status).toBe(200);
  });
});

describe('integration train', () => {
  it('lands two queued changes serially with linear first-parent history and no lost update (review enqueue approves the head)', async () => {
    const { repo, main, numbers } = await setup('two', 2);
    for (const n of numbers) expect((await enqueue('two', n)).status).toBe(201);
    const deps = trainDeps();
    const run = await runTrain(env, repoIds.two!, MAIN, deps);
    expect(run.published).toEqual(numbers);

    // The first lands as a fast-forward to its head; the second is a merge on top of it.
    const chain = firstParents(repo, main);
    expect(chain).toHaveLength(2);
    const [second, first] = chain as [string, string];
    expect(first).toBe(repo.refs.get('refs/heads/b1'));
    expect(commitOf(repo, first).parents).toEqual([main]);
    expect(commitOf(repo, second).parents).toEqual([first, repo.refs.get('refs/heads/b2')]);
    expect(commitOf(repo, second).tree).toBe(await treeWith(repo, [1, 2]));

    for (const [i, n] of numbers.entries()) {
      const c = await getChange('two', n);
      expect(c.json).toMatchObject({ state: 'merged', mergeCommit: chain[chain.length - 1 - i], queueState: null });
    }
    expect((await queueOf('two')).json.entries).toEqual([]);
    expect((await entries('two')).map((e) => e.state)).toEqual(['published', 'published']);
    expect((await leaseStatus('two')).lease).toBeNull();
    // The second candidate was composed on the first one's published result.
    const checks = deps.events.filter((e): e is Extract<TrainEvent, { type: 'checks' }> => e.type === 'checks' && e.number === numbers[1]);
    expect(checks.some((e) => e.baseSha === first)).toBe(true);
  });

  it(`keeps speculation within the window of ${TRAIN_LIMITS.window} and checking within runner capacity, with observable states`, async () => {
    const count = TRAIN_LIMITS.window + 2;
    const { repo, main, numbers } = await setup('window', count);
    for (const n of numbers) expect((await enqueue('window', n)).status).toBe(201);
    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });
    const waiting = await runTrain(env, repoIds.window!, MAIN, deps);
    expect(waiting.state).toBe('waiting');
    expect(waiting.maxPrepared).toBe(TRAIN_LIMITS.window);
    expect(waiting.maxPrepared).toBeLessThanOrEqual(TRAIN_LIMITS.window);
    expect(waiting.maxChecking).toBe(TRAIN_LIMITS.runnerCapacity);
    expect(repo.refs.get(MAIN)).toBe(main);
    // The waiting train asked for a bounded backstop kick, not a poll loop.
    expect(sent.filter((m) => m.body.reason === 'checks-backstop')).toEqual([expect.objectContaining({ delaySeconds: expect.any(Number) })]);

    const q = await queueOf('window', `?limit=${count + 5}`);
    const states = q.json.entries.map((e: any) => e.state);
    expect(states.filter((s: string) => s === 'checking')).toHaveLength(TRAIN_LIMITS.runnerCapacity);
    expect(states.filter((s: string) => s === 'preparing')).toHaveLength(TRAIN_LIMITS.window - TRAIN_LIMITS.runnerCapacity);
    expect(states.filter((s: string) => s === 'queued')).toHaveLength(count - TRAIN_LIMITS.window);
    expect(q.json.entries[0].composition).toMatchObject({ baseSha: main, treeSha: await treeWith(repo, [1]), checks: 'pending' });

    gate.fallback = 'success';
    const done = await runTrain(env, repoIds.window!, MAIN, deps);
    expect(done.published).toEqual(numbers);
    expect(done.maxPrepared).toBeLessThanOrEqual(TRAIN_LIMITS.window);
    for (const e of deps.events) if (e.type === 'window') expect(e.prepared).toBeLessThanOrEqual(TRAIN_LIMITS.window);
    expect(firstParents(repo, main)).toHaveLength(count);
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await treeWith(repo, numbers.map((_, i) => i + 1)));
  });

  it('ejects a failing candidate alone; the next proceeds and a later change still lands (lease free)', async () => {
    const { repo, main, numbers } = await setup('eject', 3);
    const [one, two, three] = numbers as [number, number, number];
    await enqueue('eject', one);
    await enqueue('eject', two);
    const gate = scriptedGate('success');
    gate.states.set(await treeWith(repo, [1]), 'failure');
    const deps = trainDeps({ gate: () => gate.gate });
    const run = await runTrain(env, repoIds.eject!, MAIN, deps);
    expect(run.ejected).toEqual([{ number: one, code: 'CHECKS_FAILED' }]);
    expect(run.published).toEqual([two]);
    expect((await getChange('eject', one)).json).toMatchObject({ state: 'open', queueState: null });
    expect((await queueOf('eject')).json.entries).toEqual([]);
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await treeWith(repo, [2]));

    await enqueue('eject', three);
    const later = await runTrain(env, repoIds.eject!, MAIN, deps);
    expect(later.published).toEqual([three]);
    expect(firstParents(repo, main)).toHaveLength(2);
    expect((await leaseStatus('eject')).lease).toBeNull();
    const rows = await entries('eject');
    expect(rows.map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [one, 'ejected', 'CHECKS_FAILED'],
      [two, 'published', null],
      [three, 'published', null],
    ]);
  });

  it('with the real gate, a change whose kvarm/guard failed is ejected and the clean ones behind it publish (VAL-QUEUE-005)', async () => {
    const repo = await seedRepo('guard-eject');
    const main = await commit(repo, { 'README.md': 'readme\n' });
    repo.refs.set(MAIN, main.sha);
    const heads: Files[] = [
      { 'README.md': 'readme\n', 'secrets.txt': `aws_key=${'AKIA' + 'IOSFODNN7EXAMPLE'}\n` },
      { 'README.md': 'readme\n', 'x.txt': 'x\n' },
      { 'README.md': 'readme\n', 'y.txt': 'y\n' },
    ];
    const numbers: number[] = [];
    for (const [i, files] of heads.entries()) {
      const b = await commit(repo, files, [main.sha]);
      repo.refs.set(`refs/heads/g${i}`, b.sha);
      numbers.push((await createChange('guard-eject', `g${i}`)).json.number as number);
    }
    const [bad, x, y] = numbers as [number, number, number];
    await enqueue('guard-eject', bad);
    await enqueue('guard-eject', x);
    const deps = trainDeps();
    const run = await runTrain(env, repoIds['guard-eject']!, MAIN, deps);
    expect(run.ejected).toEqual([{ number: bad, code: 'CHECKS_FAILED' }]);
    expect(run.published).toEqual([x]);
    expect((await getChange('guard-eject', bad)).json).toMatchObject({ state: 'open', queueState: null });
    expect((await queueOf('guard-eject')).json.entries).toEqual([]);

    await enqueue('guard-eject', y);
    const later = await runTrain(env, repoIds['guard-eject']!, MAIN, deps);
    expect(later.published).toEqual([y]);
    expect(firstParents(repo, main.sha)).toHaveLength(2);
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await writeTree(repo, { 'README.md': 'readme\n', 'x.txt': 'x\n', 'y.txt': 'y\n' }));
    expect((await leaseStatus('guard-eject')).lease).toBeNull();
  });

  it('does not let a passing guard from another change mask a queued failure on the same head', async () => {
    const repo = await seedRepo('guard-same-head');
    const main = await commit(repo, { 'README.md': 'readme\n' });
    const shared = await commit(repo, { 'README.md': 'readme\n', 'secret.txt': `token=${'kvarm_pat_' + 'a'.repeat(64)}\n` }, [main.sha]);
    repo.refs.set(MAIN, main.sha);
    repo.refs.set('refs/heads/b1', shared.sha);
    repo.refs.set('refs/heads/b2', shared.sha);
    const first = (await createChange('guard-same-head', 'b1')).json.number as number;
    const second = await call('POST', api('guard-same-head', '/changes'), tok.owner, {
      title: 'clean same head',
      base: 'b1',
      head: 'b2',
      mergePolicy: 'review',
    });
    expect(second.status).toBe(201);
    await enqueue('guard-same-head', first);
    const run = await runTrain(env, repoIds['guard-same-head']!, MAIN, trainDeps());
    expect(run.ejected).toEqual([{ number: first, code: 'CHECKS_FAILED' }]);
    expect(run.published).toEqual([]);
  });

  it('checks the exact composition: a failing combined tree ejects only the candidate that formed it', async () => {
    const { repo, main, numbers } = await setup('compose', 3);
    const [one, two, three] = numbers as [number, number, number];
    for (const n of numbers) await enqueue('compose', n);
    const gate = scriptedGate('success');
    // Each change alone passes; 1+2 together fails. 1+3 passes.
    gate.states.set(await treeWith(repo, [1, 2]), 'failure');
    const deps = trainDeps({ gate: () => gate.gate });
    const run = await runTrain(env, repoIds.compose!, MAIN, deps);
    expect(run.ejected).toEqual([{ number: two, code: 'CHECKS_FAILED' }]);
    expect(run.published).toEqual([one, three]);
    expect(gate.asked).toContain(await treeWith(repo, [1, 2]));
    expect(gate.asked).toContain(await treeWith(repo, [1, 3]));
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await treeWith(repo, [1, 3]));
    expect(firstParents(repo, main)).toHaveLength(2);
    // Publication re-asked the gate about the exact tree it published.
    const publishChecks = deps.events.filter((e) => e.type === 'checks' && e.phase === 'publish');
    expect(publishChecks.map((e) => (e as { treeSha: string }).treeSha)).toEqual([await treeWith(repo, [1]), await treeWith(repo, [1, 3])]);
  });

  it('recomposes and rechecks a prepared candidate when the base moves, then publishes that exact tree', async () => {
    const { repo, main, numbers } = await setup('base-move', 1);
    await enqueue('base-move', numbers[0]!);
    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });
    await runTrain(env, repoIds['base-move']!, MAIN, deps);
    const before = (await queueOf('base-move')).json.entries[0];
    expect(before.composition).toMatchObject({ baseSha: main, checks: 'pending' });

    const moved = await commit(repo, { 'README.md': 'readme\n', 'other.txt': 'other\n' }, [main]);
    repo.refs.set(MAIN, moved.sha);
    gate.fallback = 'success';
    const run = await runTrain(env, repoIds['base-move']!, MAIN, deps);
    expect(run.published).toEqual(numbers);
    const published = repo.refs.get(MAIN)!;
    expect(commitOf(repo, published).parents[0]).toBe(moved.sha);
    const composed = { 'README.md': 'readme\n', 'other.txt': 'other\n', 'f1.txt': 'file 1\n' };
    expect(commitOf(repo, published).tree).toBe(await writeTree(repo, composed));
    const checks = deps.events.filter((e): e is Extract<TrainEvent, { type: 'checks' }> => e.type === 'checks');
    expect(checks.map((c) => c.baseSha)).toEqual([main, moved.sha, moved.sha]);
    expect(checks.at(-1)!.treeSha).toBe(commitOf(repo, published).tree);
  });

  it('runs no checks or preparation under the publication lease, and spends two DO calls per publication chain', async () => {
    const { numbers } = await setup('timeline', 2);
    for (const n of numbers) await enqueue('timeline', n);
    const deps = trainDeps();
    const meter = new CostMeter();
    const run = await runWithMeter(meter, () => runTrain(meter.wrapEnv(env), repoIds.timeline!, MAIN, deps));
    expect(run.published).toEqual(numbers);
    let held = false;
    for (const e of deps.events) {
      if (e.type === 'lease') held = e.op === 'acquire' ? e.ok : false;
      if (e.type === 'checks' || e.type === 'window') expect(held, JSON.stringify(e)).toBe(false);
    }
    // Both ready candidates were one chain: one lease cycle for the pass.
    const leaseOps = deps.events.filter((e) => e.type === 'lease');
    expect(leaseOps.map((e) => (e as { op: string }).op)).toEqual(['acquire', 'release']);
    expect(meter.snapshot().do).toBe(2);

    for (const row of await entries('timeline')) {
      const cost = JSON.parse(row.cost!) as CostCounters;
      expect(cost.d1).toBeLessThanOrEqual(3);
      expect(cost.rr).toBeLessThanOrEqual(12);
      expect(cost.rw).toBeLessThanOrEqual(8);
      expect(cost.art).toBeLessThanOrEqual(4);
      expect(cost.do).toBeLessThanOrEqual(2);
    }
  });

  it('backs off with one delayed kick when another holder has the lease, then publishes after it is released', async () => {
    const { repo, main, numbers } = await setup('busy', 1);
    await enqueue('busy', numbers[0]!);
    const lease = mergeLockLease(env, repoIds.busy!, MAIN);
    const other = await lease.acquire('someone-else', 60_000);
    expect(other.acquired).toBe(true);
    sent.length = 0;
    const deps = trainDeps();
    const run = await runTrain(env, repoIds.busy!, MAIN, deps);
    expect(run.state).toBe('backoff');
    expect(run.retryAfterSeconds).toBeGreaterThan(0);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect(sent).toEqual([expect.objectContaining({ body: expect.objectContaining({ reason: 'backoff' }), delaySeconds: expect.any(Number) })]);
    expect((await queueOf('busy')).json.entries[0].state).toBe('ready');

    expect(await lease.release('someone-else', (other as { generation: number }).generation)).toMatchObject({ released: true });
    const after = await runTrain(env, repoIds.busy!, MAIN, deps);
    expect(after.published).toEqual(numbers);
  });

  it('a lost compare-and-swap leaves the sole winner in place and republishes on the new base', async () => {
    const { repo, main, numbers } = await setup('cas', 1);
    await enqueue('cas', numbers[0]!);
    const foreign = await commit(repo, { 'README.md': 'readme\n', 'foreign.txt': 'x\n' }, [main]);
    let raced = false;
    repo.hook = async (c) => {
      if (!raced && c.startsWith('receivePack:refs/heads/main')) {
        raced = true;
        repo.refs.set(MAIN, foreign.sha);
      }
    };
    try {
      const deps = trainDeps();
      const first = await runTrain(env, repoIds.cas!, MAIN, deps);
      const publishes = deps.events.filter((e) => e.type === 'publish').map((e) => (e as { status: string }).status);
      expect(publishes[0]).toBe('stale');
      // The winner's update is untouched by the loser.
      if (first.published.length === 0) {
        expect(repo.refs.get(MAIN)).toBe(foreign.sha);
        await runTrain(env, repoIds.cas!, MAIN, deps);
      }
      const tip = repo.refs.get(MAIN)!;
      expect(commitOf(repo, tip).parents).toEqual([foreign.sha, repo.refs.get('refs/heads/b1')]);
      expect((await getChange('cas', numbers[0]!)).json).toMatchObject({ state: 'merged', mergeCommit: tip });
      expect((await entries('cas')).map((e) => e.state)).toEqual(['published']);
    } finally {
      repo.hook = null;
    }
  });

  it('records nothing as merged when the store reply is lost and the ref did not move', async () => {
    const { repo, main, numbers } = await setup('lost-reply', 1);
    await enqueue('lost-reply', numbers[0]!);
    repo.receivePackStatus = 502;
    try {
      const deps = trainDeps();
      const run = await runTrain(env, repoIds['lost-reply']!, MAIN, deps);
      expect(run.published).toEqual([]);
      expect(repo.refs.get(MAIN)).toBe(main);
      expect((await getChange('lost-reply', numbers[0]!)).json.state).toBe('open');
      expect((await entries('lost-reply')).map((e) => [e.state, e.active])).toEqual([['queued', 1]]);
      expect(sent.some((m) => m.delaySeconds !== undefined && m.delaySeconds > 0)).toBe(true);
      expect((await leaseStatus('lost-reply')).lease).toBeNull();
    } finally {
      repo.receivePackStatus = null;
    }
    const again = await runTrain(env, repoIds['lost-reply']!, MAIN, trainDeps());
    expect(again.published).toEqual(numbers);
  });

  it('only one run works a partition at a time; a kick during a run marks it for another pass', async () => {
    const { numbers } = await setup('single-run', 2);
    await enqueue('single-run', numbers[0]!);
    let inner: Awaited<ReturnType<typeof runTrain>> | null = null;
    const deps = trainDeps();
    let once = false;
    deps.gate = () => ({
      async requiredChecksFor(_r, treeSha, configId) {
        if (!once) {
          once = true;
          inner = await runTrain(env, repoIds['single-run']!, MAIN, trainDeps());
          await enqueue('single-run', numbers[1]!);
        }
        return { treeSha, configId, required: [], state: 'success' };
      },
    });
    const run = await runTrain(env, repoIds['single-run']!, MAIN, deps);
    expect(inner!.state).toBe('busy');
    expect(run.published).toEqual(numbers);
  });

  it('restores progress when a publisher died mid-publication (stale publishing entry)', async () => {
    const { numbers } = await setup('crashed', 1);
    await enqueue('crashed', numbers[0]!);
    await env.DB.prepare(`UPDATE merge_queue SET state = 'publishing', generation = generation + 1, updated_at = ? WHERE repo_id = ?`)
      .bind(Date.now() - 10 * TRAIN_LIMITS.leaseTtlMs, repoIds.crashed)
      .run();
    const run = await runTrain(env, repoIds.crashed!, MAIN, trainDeps());
    expect(run.published).toEqual(numbers);
  });

  it('a review change whose head moves goes stale; an auto change follows its new head', async () => {
    const { repo, main, numbers } = await setup('head-move', 2);
    const [review, auto] = numbers as [number, number];
    await enqueue('head-move', review);
    // Move change 2 to auto after enqueue so that it is queued but not merged on its own by the auto policy.
    await enqueue('head-move', auto);
    await env.DB.prepare(`UPDATE change_sets SET merge_policy = 'auto' WHERE repo_id = ? AND number = ?`).bind(repoIds['head-move'], auto).run();
    await env.DB.prepare(`UPDATE merge_queue SET merge_policy = 'auto' WHERE repo_id = ? AND change_number = ?`).bind(repoIds['head-move'], auto).run();

    for (const [i, n] of [
      [1, review],
      [2, auto],
    ] as const) {
      const old = repo.refs.get(`refs/heads/b${i}`)!;
      const next = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i} v2\n` }, [old]);
      repo.refs.set(`refs/heads/b${i}`, next.sha);
      await deliver(pushBody('head-move', `refs/heads/b${i}`, old, next.sha, Date.now()));
      expect((await getChange('head-move', n)).json.headSha).toBe(next.sha);
    }
    const rows = await entries('head-move');
    expect(rows.map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [review, 'stale', 'HEAD_MOVED'],
      [auto, 'queued', null],
    ]);
    const q = (await queueOf('head-move')).json.entries;
    expect(q.map((e: any) => [e.number, e.headSha])).toEqual([[auto, repo.refs.get('refs/heads/b2')]]);
    const run = await runTrain(env, repoIds['head-move']!, MAIN, trainDeps());
    expect(run.published).toEqual([auto]);
    expect(repo.refs.get(MAIN)).toBe(repo.refs.get('refs/heads/b2'));
    expect(commitOf(repo, repo.refs.get(MAIN)!).parents).toEqual([repo.refs.get('refs/heads/b2') && commitOf(repo, repo.refs.get('refs/heads/b2')!).parents[0]]);
    expect(firstParents(repo, main)).toHaveLength(2);
  });

  it('a late head-move hook cannot stale or regress an entry approved for a newer head', async () => {
    const { repo, numbers } = await setup('late-hook', 2);
    const [review, auto] = numbers as [number, number];
    await enqueue('late-hook', review);
    await enqueue('late-hook', auto);
    await env.DB.prepare(`UPDATE change_sets SET merge_policy = 'auto' WHERE repo_id = ? AND number = ?`).bind(repoIds['late-hook'], auto).run();
    await env.DB.prepare(`UPDATE merge_queue SET merge_policy = 'auto' WHERE repo_id = ? AND change_number = ?`).bind(repoIds['late-hook'], auto).run();
    const ids = new Map<number, string>();
    for (const n of numbers) {
      ids.set(n, (await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = ?').bind(repoIds['late-hook'], n).first<{ id: string }>())!.id);
    }
    const b1 = 'refs/heads/b1';
    const b2 = 'refs/heads/b2';
    const before1 = repo.refs.get(b1)!;
    const before2 = repo.refs.get(b2)!;
    const entryHead = async (n: number): Promise<string> =>
      (
        await env.DB
          .prepare('SELECT head_sha FROM merge_queue WHERE repo_id = ? AND change_number = ? AND active = 1')
          .bind(repoIds['late-hook'], n)
          .first<{ head_sha: string }>()
      )!.head_sha;

    // Review: the push stales the entry; the reviewer approves the new head.
    const next1 = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'file 1 v2\n' }, [before1]);
    repo.refs.set(b1, next1.sha);
    await deliver(pushBody('late-hook', b1, before1, next1.sha, Date.now()));
    expect((await entries('late-hook')).map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [review, 'stale', 'HEAD_MOVED'],
      [auto, 'queued', null],
    ]);
    expect((await enqueue('late-hook', review, { headSha: next1.sha })).status).toBe(201);
    expect((await entries('late-hook')).map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [review, 'stale', 'HEAD_MOVED'],
      [auto, 'queued', null],
      [review, 'queued', null],
    ]);

    // A late redelivery of the first push's hook carries the approved head it
    // observed at its own ingest (before1) while the active entry already
    // records the newer approval (next1): it must not stale the fresh entry.
    await onQueuedHeadMoved({
      env,
      repoId: repoIds['late-hook']!,
      change: { id: ids.get(review)!, number: review, policy: 'review', headSha: next1.sha, queuedHead: before1 },
      headSha: next1.sha,
    });
    expect((await entries('late-hook')).map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [review, 'stale', 'HEAD_MOVED'],
      [auto, 'queued', null],
      [review, 'queued', null],
    ]);

    // Auto: the entry follows each delivered push. A late hook for the first
    // of two pushes must not regress the head the entry already follows.
    const next2a = await commit(repo, { 'README.md': 'readme\n', 'f2.txt': 'file 2 v2\n' }, [before2]);
    const next2b = await commit(repo, { 'README.md': 'readme\n', 'f2.txt': 'file 2 v3\n' }, [next2a.sha]);
    repo.refs.set(b2, next2b.sha);
    await deliver(pushBody('late-hook', b2, before2, next2a.sha, Date.now()));
    await deliver(pushBody('late-hook', b2, next2a.sha, next2b.sha, Date.now()));
    expect(await entryHead(auto)).toBe(next2b.sha);
    await onQueuedHeadMoved({
      env,
      repoId: repoIds['late-hook']!,
      change: { id: ids.get(auto)!, number: auto, policy: 'auto', headSha: next2a.sha, queuedHead: before2 },
      headSha: next2a.sha,
    });
    expect(await entryHead(auto)).toBe(next2b.sha);
  });

  it('a head push whose event is not yet delivered never lets the train publish the previous head', async () => {
    const { repo, main, numbers } = await setup('live-head', 2);
    const [review, auto] = numbers as [number, number];
    await enqueue('live-head', review);
    await enqueue('live-head', auto);
    await env.DB.prepare(`UPDATE change_sets SET merge_policy = 'auto' WHERE repo_id = ? AND number = ?`).bind(repoIds['live-head'], auto).run();
    await env.DB.prepare(`UPDATE merge_queue SET merge_policy = 'auto' WHERE repo_id = ? AND change_number = ?`).bind(repoIds['live-head'], auto).run();

    // Change 1 is force-pushed to a rewrite, change 2 gets a new commit; neither push event has been delivered.
    const old2 = repo.refs.get('refs/heads/b2')!;
    const rewritten = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'rewritten\n' }, [main]);
    const next2 = await commit(repo, { 'README.md': 'readme\n', 'f2.txt': 'file 2 v2\n' }, [old2]);
    repo.refs.set('refs/heads/b1', rewritten.sha);
    repo.refs.set('refs/heads/b2', next2.sha);

    const run = await runTrain(env, repoIds['live-head']!, MAIN, trainDeps());
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([{ number: review, code: 'HEAD_MOVED' }]);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect(repo.count('receivePack:')).toBe(0);
    expect((await entries('live-head')).map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [review, 'stale', 'HEAD_MOVED'],
      [auto, 'queued', null],
    ]);
    expect((await getChange('live-head', review)).json).toMatchObject({ state: 'open', mergeCommit: null });
    expect((await getChange('live-head', auto)).json).toMatchObject({ state: 'open', mergeCommit: null });

    // Once the event settles the auto change's head, the train publishes that head.
    await deliver(pushBody('live-head', 'refs/heads/b2', old2, next2.sha, Date.now()));
    const after = await runTrain(env, repoIds['live-head']!, MAIN, trainDeps());
    expect(after.published).toEqual([auto]);
    expect(repo.refs.get(MAIN)).toBe(next2.sha);
    expect((await getChange('live-head', auto)).json).toMatchObject({ state: 'merged', headSha: next2.sha, mergeCommit: next2.sha });
  });

  it('an auto entry whose recorded head moved before its head-moved hook ran publishes and records that head', async () => {
    const { repo, main, numbers } = await setup('auto-follow', 1, 'review');
    const [n] = numbers as [number];
    await enqueue('auto-follow', n);
    await env.DB.prepare(`UPDATE change_sets SET merge_policy = 'auto' WHERE repo_id = ? AND number = ?`).bind(repoIds['auto-follow'], n).run();
    await env.DB.prepare(`UPDATE merge_queue SET merge_policy = 'auto' WHERE repo_id = ? AND change_number = ?`).bind(repoIds['auto-follow'], n).run();
    const next = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'file 1 v2\n' }, [repo.refs.get('refs/heads/b1')!]);
    repo.refs.set('refs/heads/b1', next.sha);
    // The ingest batch moved the change's head and the guard hook judged it; the hook that moves the queue entry has not run.
    await env.DB.prepare('UPDATE change_sets SET head_sha = ? WHERE repo_id = ? AND number = ?').bind(next.sha, repoIds['auto-follow'], n).run();
    const changeId = (await env.DB.prepare('SELECT id FROM change_sets WHERE repo_id = ? AND number = ?').bind(repoIds['auto-follow'], n).first<{ id: string }>())!.id;
    expect(await recordGuard(env, repoIds['auto-follow']!, changeId, next.sha)).toBe('recorded');
    const run = await runTrain(env, repoIds['auto-follow']!, MAIN, trainDeps());
    expect(run.published).toEqual([n]);
    expect(repo.refs.get(MAIN)).toBe(next.sha);
    expect(firstParents(repo, main)).toEqual([next.sha, commitOf(repo, next.sha).parents[0]]);
    expect((await getChange('auto-follow', n)).json).toMatchObject({ state: 'merged', headSha: next.sha, mergeCommit: next.sha });
  });

  it('ejects a candidate whose enqueuer lost write access before publication', async () => {
    const { repo, main, numbers } = await setup('revoked', 1);
    await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(repoIds.revoked, userIds['mq-writer'], 'write', userIds[OWNER], Date.now(), Date.now())
      .run();
    expect((await enqueue('revoked', numbers[0]!, undefined, tok.writer)).status).toBe(201);
    await env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = ?').bind(repoIds.revoked, userIds['mq-writer']).run();
    const run = await runTrain(env, repoIds.revoked!, MAIN, trainDeps());
    expect(run.ejected).toEqual([{ number: numbers[0], code: 'AUTHORIZATION_REVOKED' }]);
    expect(repo.refs.get(MAIN)).toBe(main);
  });

  /** Train deps whose pusher runs `fn` once, after the real pusher minted its credential and built the pack, before anything is sent. */
  function preparing(fn: () => Promise<void>, over: Partial<TrainDeps> = {}): TrainDeps & { events: TrainEvent[] } {
    let pending: (() => Promise<void>) | null = fn;
    return trainDeps({
      pusher(e, r) {
        const real = defaultTrainDeps.pusher(e, r);
        return {
          listRefs: () => real.listRefs(),
          updateRef: (command, objects) => real.updateRef(command, objects),
          async prepareUpdate(command, objects) {
            const prepared = await real.prepareUpdate(command, objects);
            const run = pending;
            pending = null;
            await run?.();
            return prepared;
          },
        };
      },
      ...over,
    });
  }

  it('revalidates the change, enqueuer, rules and reviews after the pack is prepared, right before sending', async () => {
    const cases: Array<[string, (n: number, repo: FakeRepo) => Promise<void>, string]> = [
      [
        'prep-draft',
        async (n) => {
          expect((await call('PATCH', api('prep-draft', `/changes/${n}`), tok.owner, { mergePolicy: 'draft' })).status).toBe(200);
        },
        'DRAFT',
      ],
      [
        'prep-rules',
        async () => {
          await env.DB.prepare(
            `INSERT INTO branch_rules (id, repo_id, pattern, required_checks, required_approvals, created_by, created_at, updated_by, updated_at)
             VALUES (?, ?, 'refs/heads/main', '[]', 1, ?, ?, ?, ?)`,
          )
            .bind(crypto.randomUUID(), repoIds['prep-rules'], userIds[OWNER], Date.now(), userIds[OWNER], Date.now())
            .run();
        },
        'ANY',
      ],
      [
        'prep-revoked',
        async () => {
          await env.DB.prepare('DELETE FROM repo_grants WHERE repo_id = ? AND user_id = ?').bind(repoIds['prep-revoked'], userIds['mq-writer']).run();
        },
        'AUTHORIZATION_REVOKED',
      ],
    ];
    for (const [name, mutate, code] of cases) {
      const { repo, main, numbers } = await setup(name, 1);
      const [n] = numbers as [number];
      let token = tok.owner;
      if (name === 'prep-revoked') {
        await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(repoIds[name], userIds['mq-writer'], 'write', userIds[OWNER], Date.now(), Date.now())
          .run();
        token = tok.writer;
      }
      expect((await enqueue(name, n, undefined, token)).status).toBe(201);
      const run = await runTrain(env, repoIds[name]!, MAIN, preparing(() => mutate(n, repo)));
      expect(run.published, name).toEqual([]);
      expect(run.ejected, name).toHaveLength(1);
      if (code !== 'ANY') expect(run.ejected[0]!.code, name).toBe(code);
      expect(repo.count('receivePack:'), name).toBe(0);
      expect(repo.refs.get(MAIN), name).toBe(main);
      expect((await getChange(name, n)).json, name).toMatchObject({ state: 'open', mergeCommit: null });
      expect((await leaseStatus(name)).lease, name).toBeNull();
    }
  });

  it('keeps an equivalent non-auto queued entry active and re-points it after the head event', async () => {
    const { repo, numbers } = await setup('equivalent-queue', 1);
    const [n] = numbers as [number];
    await enqueue('equivalent-queue', n);
    const oldHead = repo.refs.get('refs/heads/b1')!;
    const equivalent = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'file 1\n' }, [oldHead]);
    repo.refs.set('refs/heads/b1', equivalent.sha);
    await deliver(pushBody('equivalent-queue', 'refs/heads/b1', oldHead, equivalent.sha, Date.now()));
    expect((await entries('equivalent-queue')).map((entry) => [entry.state, entry.head_sha, entry.active, entry.reason_code])).toEqual([
      ['queued', equivalent.sha, 1, null],
    ]);
  });

  it('waits for an equivalent in-run head move, then publishes after the head event re-points the entry', async () => {
    const { repo, main, numbers } = await setup('equivalent-live-head', 1);
    const [n] = numbers as [number];
    await enqueue('equivalent-live-head', n);
    const oldHead = repo.refs.get('refs/heads/b1')!;
    const equivalent = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'file 1\n' }, [oldHead]);
    const first = await runTrain(
      env,
      repoIds['equivalent-live-head']!,
      MAIN,
      preparing(async () => {
        repo.refs.set('refs/heads/b1', equivalent.sha);
      }),
    );
    expect(first.published).toEqual([]);
    expect(first.ejected).toEqual([]);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect((await entries('equivalent-live-head')).map((entry) => [entry.state, entry.active, entry.reason_code])).toEqual([['queued', 1, null]]);
    await deliver(pushBody('equivalent-live-head', 'refs/heads/b1', oldHead, equivalent.sha, Date.now()));
    const second = await runTrain(env, repoIds['equivalent-live-head']!, MAIN, trainDeps());
    expect(second.published).toEqual([n]);
    expect((await getChange('equivalent-live-head', n)).json.state).toBe('merged');
  });

  it('a force-push of the head while the pack is prepared stops publication of the composed head', async () => {
    const { repo, main, numbers } = await setup('prep-head', 1);
    const [n] = numbers as [number];
    await enqueue('prep-head', n);
    const rewritten = await commit(repo, { 'README.md': 'readme\n', 'f1.txt': 'rewritten\n' }, [main]);
    const run = await runTrain(
      env,
      repoIds['prep-head']!,
      MAIN,
      preparing(async () => {
        repo.refs.set('refs/heads/b1', rewritten.sha);
      }),
    );
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([{ number: n, code: 'HEAD_MOVED' }]);
    expect(repo.count('receivePack:')).toBe(0);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect((await getChange('prep-head', n)).json).toMatchObject({ state: 'open', mergeCommit: null });
  });

  it('a publisher whose entry was recovered while it sent records nothing and reports no publication', async () => {
    const { repo, numbers } = await setup('late-result', 1);
    const [n] = numbers as [number];
    await enqueue('late-result', n);
    const deps = trainDeps({
      pusher(e, r) {
        const real = defaultTrainDeps.pusher(e, r);
        return {
          listRefs: () => real.listRefs(),
          updateRef: (command, objects) => real.updateRef(command, objects),
          async prepareUpdate(command, objects) {
            const prepared = await real.prepareUpdate(command, objects);
            return {
              async send() {
                // Recovery took the entry over (as a later pass does for a publisher presumed dead).
                await env.DB.prepare(`UPDATE merge_queue SET state = 'queued', generation = generation + 1 WHERE repo_id = ? AND active = 1`)
                  .bind(repoIds['late-result'])
                  .run();
                return prepared.send();
              },
            };
          },
        };
      },
    });
    const run = await runTrain(env, repoIds['late-result']!, MAIN, deps);
    expect(run.published).not.toContain(n);
    expect(deps.events.filter((e) => e.type === 'publish' && (e as { status: string }).status === 'recorded')).toEqual([]);
    const change = (await getChange('late-result', n)).json;
    expect(change).toMatchObject({ state: 'open', mergeCommit: null });
    expect(repo.refs.get(MAIN)).toBe(repo.refs.get('refs/heads/b1'));
    expect((await entries('late-result')).map((e) => e.state)).not.toContain('published');
  });

  it('the queue consumer runs the train for a kick message', async () => {
    const { repo, main, numbers } = await setup('consumer', 1);
    await enqueue('consumer', numbers[0]!);
    const kick = sent.find((m) => m.body.type === 'kvarm.train')!;
    const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: kick.body }]);
    const ctx = createExecutionContext();
    await worker.queue!(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);
    expect(result.explicitAcks).toHaveLength(1);
    expect(firstParents(repo, main)).toHaveLength(1);
    expect((await getChange('consumer', numbers[0]!)).json.state).toBe('merged');
  });

  // -------------------------------------------------------------------------

  /** The published rows with their merge commits, in arrival order. */
  async function publishedRows(name: string): Promise<Array<{ change_number: number; state: string; reason_code: string | null; merge_commit: string | null }>> {
    return (
      (
        await env.DB.prepare('SELECT change_number, state, reason_code, merge_commit FROM merge_queue WHERE repo_id = ? ORDER BY seq')
          .bind(repoIds[name])
          .all<{ change_number: number; state: string; reason_code: string | null; merge_commit: string | null }>()
      ).results ?? []
    );
  }

  it('publishes a ready run of three as one chain: one lease, one push, one notes push', async () => {
    const { repo, main, numbers } = await setup('chain3', 3);
    for (const n of numbers) expect((await enqueue('chain3', n)).status).toBe(201);
    const deps = trainDeps();
    const meter = new CostMeter();
    const run = await runWithMeter(meter, () => runTrain(meter.wrapEnv(env), repoIds.chain3!, MAIN, deps));
    expect(run.published).toEqual(numbers);
    // One receive-pack moved the ref across all three candidates, under one lease.
    expect(repo.calls.filter((c) => c.startsWith(`receivePack:${MAIN}:`))).toHaveLength(1);
    expect(deps.events.filter((e) => e.type === 'lease').map((e) => (e as { op: string }).op)).toEqual(['acquire', 'release']);
    expect(firstParents(repo, main)).toHaveLength(3);
    // Each candidate recorded its own merge commit; the registry matches the stacked history.
    const rows = await publishedRows('chain3');
    expect(rows.map((r) => [r.change_number, r.state])).toEqual(numbers.map((n) => [n, 'published']));
    let tip = repo.refs.get(MAIN)!;
    for (const row of [...rows].reverse()) {
      expect(row.merge_commit).toBe(tip);
      tip = commitOf(repo, tip).parents[0]!;
    }
    // Two merge commits (the first change fast-forwards): one notes push carries both attributions.
    const merges = rows.filter((r) => r.change_number !== numbers[0]!);
    expect(merges.length).toBe(2);
    expect(repo.calls.filter((c) => c.startsWith('receivePack:refs/notes/kvarm-attribution:'))).toHaveLength(1);
    for (const row of merges) {
      const note = await call('GET', api('chain3', `/commits/${row.merge_commit}/attribution`));
      expect(note.status, JSON.stringify(note.json)).toBe(200);
      expect(note.json).toMatchObject({ session: `kvarm:merge/change-${row.change_number}` });
    }
    for (const row of rows) {
      const entry = (await entries('chain3')).find((e) => e.change_number === row.change_number)!;
      const cost = JSON.parse(entry.cost!) as CostCounters;
      expect(cost.do).toBeLessThanOrEqual(2);
    }
  });

  it('a change that closes while the chain is prepared truncates it: the prefix publishes, the rest recompose', async () => {
    const { repo, main, numbers } = await setup('chain-close', 3);
    for (const n of numbers) expect((await enqueue('chain-close', n)).status).toBe(201);
    const run = await runTrain(
      env,
      repoIds['chain-close']!,
      MAIN,
      preparing(async () => {
        expect((await call('PATCH', api('chain-close', `/changes/${numbers[1]}`), tok.owner, { state: 'closed' })).status).toBe(200);
      }),
    );
    // The prefix published in the chain's push; the closed candidate exited and nothing stacked on it was sent.
    // The run's next pass recomposed the third candidate on the published prefix and published it in its own push.
    expect(run.published).toEqual([numbers[0]!, numbers[2]!]);
    expect(run.ejected).toEqual([{ number: numbers[1]!, code: 'CHANGE_CLOSED' }]);
    expect(repo.calls.filter((c) => c.startsWith(`receivePack:${MAIN}:`))).toHaveLength(2);
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await treeWith(repo, [1, 3]));
    expect(firstParents(repo, main)).toHaveLength(2);
    const rows = await publishedRows('chain-close');
    expect(rows.map((r) => [r.change_number, r.state, r.reason_code])).toEqual([
      [numbers[0]!, 'published', null],
      [numbers[1]!, 'ejected', 'CHANGE_CLOSED'],
      [numbers[2]!, 'published', null],
    ]);
  });

  it('a head that moves while the chain is prepared truncates it: the prefix still publishes', async () => {
    const { repo, main, numbers } = await setup('chain-head', 2);
    for (const n of numbers) expect((await enqueue('chain-head', n)).status).toBe(201);
    const rewritten = await commit(repo, { 'README.md': 'readme\n', 'f2.txt': 'rewritten\n' }, [main]);
    const run = await runTrain(
      env,
      repoIds['chain-head']!,
      MAIN,
      preparing(async () => {
        repo.refs.set('refs/heads/b2', rewritten.sha);
      }),
    );
    expect(run.published).toEqual([numbers[0]!]);
    expect(run.ejected).toEqual([{ number: numbers[1]!, code: 'HEAD_MOVED' }]);
    expect(repo.calls.filter((c) => c.startsWith(`receivePack:${MAIN}:`))).toHaveLength(1);
    expect(commitOf(repo, repo.refs.get(MAIN)!).tree).toBe(await treeWith(repo, [1]));
    expect((await getChange('chain-head', numbers[1]!)).json).toMatchObject({ state: 'open', mergeCommit: null });
  });
});

describe('train CI staging of composed merges', () => {
  const CI_CONFIG = `${JSON.stringify({ jobs: [{ name: 'test', run: 'npm test', required: true }] })}\n`;
  const STAGING = 'refs/heads/kvarm-ci/';

  class CountingWorkflow {
    created: string[] = [];
    async create(opts: { id?: string }) {
      this.created.push(opts.id ?? '');
      return { id: opts.id ?? crypto.randomUUID() };
    }
    async get(id: string) {
      return { id };
    }
  }

  /** Records every SQL text the train runs, standalone or inside a batch. */
  class SpyStatement {
    constructor(
      readonly inner: D1PreparedStatement,
      readonly sql: string,
      private readonly log: string[],
    ) {}
    bind(...values: unknown[]): SpyStatement {
      return new SpyStatement(this.inner.bind(...values), this.sql, this.log);
    }
    first(col?: string) {
      this.log.push(`standalone:${this.sql}`);
      return col === undefined ? this.inner.first() : this.inner.first(col);
    }
    all() {
      this.log.push(`standalone:${this.sql}`);
      return this.inner.all();
    }
    run() {
      this.log.push(`standalone:${this.sql}`);
      return this.inner.run();
    }
    raw() {
      this.log.push(`standalone:${this.sql}`);
      return this.inner.raw();
    }
  }

  function spyDb(db: D1Database, log: string[]): D1Database {
    return new Proxy(db, {
      get(t, p) {
        if (p === 'prepare') return (sql: string) => new SpyStatement(t.prepare(sql), sql, log) as unknown as D1PreparedStatement;
        if (p === 'batch') {
          return (stmts: D1PreparedStatement[]) => {
            log.push(`batch:${stmts.map((s) => (s instanceof SpyStatement ? s.sql : '?')).join('\n;\n')}`);
            return t.batch(stmts.map((s) => (s instanceof SpyStatement ? s.inner : s)));
          };
        }
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
  }

  interface RunWork {
    run: Awaited<ReturnType<typeof runTrain>>;
    cost: CostCounters;
    configReads: number;
    stagingLsRefs: number;
    standaloneCiJobs: number;
    ciJobInserts: number;
    workflowCreates: number;
    stagedRefWrites: number;
  }

  /** One train run under a fresh meter, with the per-run work this suite pins. */
  async function measured(name: string, repo: FakeRepo, deps: TrainDeps, wf: CountingWorkflow): Promise<RunWork> {
    const log: string[] = [];
    const meter = new CostMeter();
    const metered = meter.wrapEnv({ ...env, CI_PIPELINE: wf as unknown as Env['CI_PIPELINE'] } as Env);
    const db = spyDb(metered.DB, log);
    const trainEnv = new Proxy(metered, { get: (t, p) => (p === 'DB' ? db : Reflect.get(t, p)) });
    const calls = repo.calls.length;
    const lsMark = lsRefsPrefixes.length;
    const wfMark = wf.created.length;
    const run = await runWithMeter(meter, () => runTrain(trainEnv, repoIds[name]!, MAIN, deps));
    const since = repo.calls.slice(calls);
    return {
      run,
      cost: meter.snapshot(),
      configReads: since.filter((c) => c.startsWith('readFile:') && c.endsWith(':.kvarm/ci.json')).length,
      stagingLsRefs: lsRefsPrefixes.slice(lsMark).filter((p) => p.some((x) => x.startsWith(STAGING))).length,
      standaloneCiJobs: log.filter((l) => l.startsWith('standalone:') && /\bci_jobs\b/.test(l)).length,
      ciJobInserts: log.filter((l) => /INSERT INTO ci_jobs/.test(l)).length,
      workflowCreates: wf.created.length - wfMark,
      stagedRefWrites: since.filter((c) => c.startsWith(`receivePack:${STAGING}`)).length,
    };
  }

  const stagedRefs = (repo: FakeRepo) => [...repo.refs].filter(([r]) => r.startsWith(STAGING));

  /** main moves after the change's branch forked, so the train composes (and stages) a real merge commit. */
  async function ciSetup(name: string, withConfig: boolean) {
    const repo = await seedRepo(name);
    const files: Files = { 'README.md': 'readme\n', ...(withConfig ? { '.kvarm/ci.json': CI_CONFIG } : {}) };
    const fork = await commit(repo, files);
    const head = await commit(repo, { ...files, 'f1.txt': 'file 1\n' }, [fork.sha]);
    repo.refs.set(MAIN, fork.sha);
    repo.refs.set('refs/heads/b1', head.sha);
    const created = await createChange(name, 'b1');
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const moved = await commit(repo, { ...files, 'other.txt': 'other\n' }, [fork.sha]);
    repo.refs.set(MAIN, moved.sha);
    const n = created.json.number as number;
    const queued = await enqueue(name, n);
    expect(queued.status, JSON.stringify(queued.json)).toBe(201);
    return { repo, n, files, head: head.sha, moved: moved.sha };
  }

  it('reuses the staged CI commit when the composition identity is unchanged: no config read, staging ls-refs, ci_jobs read or re-queue', async () => {
    const { repo, n, head, moved } = await ciSetup('ci-stage', true);
    const wf = new CountingWorkflow();
    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });

    const first = await measured('ci-stage', repo, deps, wf);
    expect(first.run).toMatchObject({ state: 'waiting', passes: 1 });
    expect(first.stagedRefWrites).toBe(1);
    expect(first.ciJobInserts).toBe(1);
    expect(first.workflowCreates).toBe(1);
    // hasCiJobs and the exact-tree queueing share one read of the head's config.
    expect(first.configReads).toBe(1);
    const staged = stagedRefs(repo);
    expect(staged).toHaveLength(1);
    const [stagedRef, stagedSha] = staged[0]!;
    expect(commitOf(repo, stagedSha).parents).toEqual([moved, head]);

    const second = await measured('ci-stage', repo, deps, wf);
    expect(second.run).toMatchObject({ state: 'waiting', passes: 1 });
    // The pass's own work (the run claim before it is the run's).
    expect(second.run.passCosts).toEqual([expect.objectContaining({ d1: second.cost.d1 - 1, sub: second.cost.sub, art: second.cost.art })]);
    expect(second.configReads).toBe(0);
    expect(second.stagingLsRefs).toBe(0);
    expect(second.standaloneCiJobs).toBe(0);
    expect(second.ciJobInserts).toBe(0);
    expect(second.workflowCreates).toBe(0);
    expect(second.stagedRefWrites).toBe(0);
    // Only the window's ls-refs (target + head branch) remains.
    expect(second.cost.sub).toBe(1);
    // Run claim, window batch, run release and the checks backstop: no CI round trip.
    expect(second.cost.d1).toBeLessThanOrEqual(4);
    expect(second.cost.d1).toBeLessThan(first.cost.d1);
    const entry = await env.DB.prepare('SELECT state, tree_sha FROM merge_queue WHERE repo_id = ? AND active = 1')
      .bind(repoIds['ci-stage'])
      .first<{ state: string; tree_sha: string }>();
    expect(entry).toEqual({ state: 'checking', tree_sha: stagedRef.slice(stagedRef.lastIndexOf('/') + 1) });

    // The checks pass: the train publishes exactly the commit the CI jobs ran on, then drops its staging ref.
    gate.fallback = 'success';
    const third = await measured('ci-stage', repo, deps, wf);
    expect(third.run.published).toEqual([n]);
    expect(third.configReads).toBe(0);
    expect(third.ciJobInserts).toBe(0);
    expect(repo.refs.get(MAIN)).toBe(stagedSha);
    expect(stagedRefs(repo)).toEqual([]);
    // Every CI job of the published tree ran on that one staged commit.
    const jobs = await env.DB.prepare('SELECT DISTINCT head_sha FROM ci_jobs WHERE repo_id = ? AND tree_sha = ?')
      .bind(repoIds['ci-stage'], commitOf(repo, stagedSha).tree)
      .all();
    expect(jobs.results).toEqual([{ head_sha: stagedSha }]);
  });

  it('re-reads the config and re-stages exactly once when the target moved under a staged candidate', async () => {
    const { repo, files, head, moved } = await ciSetup('ci-restage', true);
    const wf = new CountingWorkflow();
    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });
    await measured('ci-restage', repo, deps, wf);
    const [[oldRef]] = stagedRefs(repo) as [[string, string]];

    const movedAgain = await commit(repo, { ...files, 'other.txt': 'other\n', 'more.txt': 'more\n' }, [moved]);
    repo.refs.set(MAIN, movedAgain.sha);
    const changed = await measured('ci-restage', repo, deps, wf);
    expect(changed.run).toMatchObject({ state: 'waiting', passes: 1 });
    expect(changed.configReads).toBe(1);
    expect(changed.stagingLsRefs).toBe(1);
    expect(changed.stagedRefWrites).toBe(1);
    expect(changed.ciJobInserts).toBe(1);
    expect(changed.workflowCreates).toBe(1);
    const fresh = stagedRefs(repo).filter(([r]) => r !== oldRef);
    expect(fresh).toHaveLength(1);
    expect(commitOf(repo, fresh[0]![1]).parents).toEqual([movedAgain.sha, head]);

    // The new composition is now the recorded one: the next pass reuses it.
    const again = await measured('ci-restage', repo, deps, wf);
    expect(again.configReads).toBe(0);
    expect(again.stagingLsRefs).toBe(0);
    expect(again.ciJobInserts).toBe(0);
  });

  it('recovers a staged CI ref whose jobs were never queued (a crash between the staging push and the record)', async () => {
    const { repo, n, head, moved } = await ciSetup('ci-crash', true);
    const wf = new CountingWorkflow();
    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });

    const first = await measured('ci-crash', repo, deps, wf);
    expect(first.stagedRefWrites).toBe(1);
    const [[stagedRef, stagedSha]] = stagedRefs(repo) as [[string, string]];
    expect(commitOf(repo, stagedSha).parents).toEqual([moved, head]);

    // The Worker died between the staging push and the write batch: the ref
    // exists, but no check run or job names it (the entry's recorded staging
    // derives from ci_jobs, so deleting them is exactly that crash).
    // Previously every pass found the ref and threw RefStoreUnavailable
    // forever (state unavailable).
    await env.DB
      .prepare(`UPDATE merge_queue SET state = 'queued', base_sha = NULL, tree_sha = NULL, generation = generation + 1 WHERE repo_id = ?`)
      .bind(repoIds['ci-crash'])
      .run();
    await env.DB.prepare(`DELETE FROM ci_jobs WHERE repo_id = ?`).bind(repoIds['ci-crash']).run();
    await env.DB.prepare(`DELETE FROM check_runs WHERE repo_id = ? AND name != 'kvarm/guard'`).bind(repoIds['ci-crash']).run();

    const recovered = await measured('ci-crash', repo, deps, wf);
    expect(recovered.run).toMatchObject({ state: 'waiting', passes: 1 });
    expect(recovered.stagingLsRefs).toBe(1);
    expect(recovered.ciJobInserts).toBe(1);
    expect(recovered.workflowCreates).toBe(1);
    // This preparation re-derives the same immutable commit; the ref keeps it
    // and only the lost queueing is redone.
    expect(repo.refs.get(stagedRef)).toBe(stagedSha);
    expect(commitOf(repo, repo.refs.get(stagedRef)!).parents).toEqual([moved, head]);
    expect(repo.refs.get(MAIN)).toBe(moved);

    // The checks pass: the train publishes exactly the commit the CI jobs ran on.
    gate.fallback = 'success';
    const third = await measured('ci-crash', repo, deps, wf);
    expect(third.run.published).toEqual([n]);
    expect(repo.refs.get(MAIN)).toBe(stagedSha);
    expect(stagedRefs(repo)).toEqual([]);
  });

  it('a staging ref from another preparation of the same tree is re-pointed, not reused or refused', async () => {
    const { repo, head, moved } = await ciSetup('ci-repoint', true);
    const wf = new CountingWorkflow();
    const deps = trainDeps({ gate: () => scriptedGate('pending').gate });
    await measured('ci-repoint', repo, deps, wf);
    const [[stagedRef, stagedSha]] = stagedRefs(repo) as [[string, string]];
    expect(commitOf(repo, stagedSha).parents).toEqual([moved, head]);
    // The staging record is lost (a crash), and the ref holds a commit whose
    // parents are not this composition's (the base moved under an unchanged
    // result tree).
    await env.DB
      .prepare(`UPDATE merge_queue SET state = 'queued', base_sha = NULL, tree_sha = NULL, generation = generation + 1 WHERE repo_id = ?`)
      .bind(repoIds['ci-repoint'])
      .run();
    await env.DB.prepare(`DELETE FROM ci_jobs WHERE repo_id = ?`).bind(repoIds['ci-repoint']).run();
    await env.DB.prepare(`DELETE FROM check_runs WHERE repo_id = ? AND name != 'kvarm/guard'`).bind(repoIds['ci-repoint']).run();
    repo.refs.set(stagedRef, head);

    const recovered = await measured('ci-repoint', repo, deps, wf);
    expect(recovered.run).toMatchObject({ state: 'waiting', passes: 1 });
    expect(recovered.stagedRefWrites).toBe(1);
    expect(recovered.ciJobInserts).toBe(1);
    // The foreign commit was neither adopted nor refused: the ref is re-pointed
    // at a commit of this composition's identity.
    const nowStaged = repo.refs.get(stagedRef)!;
    expect(nowStaged).not.toBe(head);
    expect(commitOf(repo, nowStaged).parents).toEqual([moved, head]);
    expect(repo.refs.get(MAIN)).toBe(moved);
  });

  it('a pass without a CI config reads the config once and stages nothing', async () => {
    const { repo } = await ciSetup('ci-none', false);
    const wf = new CountingWorkflow();
    const deps = trainDeps({ gate: () => scriptedGate('pending').gate });
    const first = await measured('ci-none', repo, deps, wf);
    const second = await measured('ci-none', repo, deps, wf);
    for (const w of [first, second]) {
      expect(w.run).toMatchObject({ state: 'waiting', passes: 1 });
      expect(w.configReads).toBe(1);
      expect(w.stagingLsRefs + w.stagedRefWrites + w.ciJobInserts + w.workflowCreates + w.standaloneCiJobs).toBe(0);
    }
    expect(stagedRefs(repo)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Push events (head moves)
// ---------------------------------------------------------------------------

function pushBody(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}
