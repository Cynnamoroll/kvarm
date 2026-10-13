/**
 * Crash-consistent merge-queue publication (services/queue.ts,
 * architecture §11.4): durable publication intents and their reconciliation
 * against the actual ref. Faults are injected only through the train's
 * dependencies (a `checkpoint` hook that throws or waits, a pusher whose reply
 * is lost, a lease whose holder "dies" and never releases); the production
 * code has no fault switch. Time passing is simulated by ageing the crashed
 * entry, the run claim and the real MergeLock lease, whose alarm then kicks
 * the train like it does in production.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { mergeLockAlarm, type Lease, type MergeLock } from '../src/do/mergeLock';
import worker from '../src/index';
import {
  PUBLICATION_RECONCILED_EVENT,
  RECONCILE_LIMITS,
  TRAIN_LIMITS,
  defaultTrainDeps,
  mergeLockLease,
  runTrain,
  type PublicationCheckpoint,
  type TrainDeps,
  type TrainEvent,
} from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, lsRefsPrefixes, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'pr-owner';
const MAIN = 'refs/heads/main';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const sent: Array<{ body: any; delaySeconds?: number }> = [];
const fakeEvents = {
  async send(body: unknown, opts?: { delaySeconds?: number }) {
    sent.push({ body, ...(opts?.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}) });
  },
  async sendBatch(msgs: Array<{ body: unknown }>) {
    for (const m of msgs) sent.push({ body: m.body });
  },
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '' };
const repoIds: Record<string, string> = {};
const savedAlarmEnv = mergeLockAlarm.env;

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return repo;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Authorization: `Bearer ${tok.owner}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const getChange = async (repo: string, n: number) => (await call('GET', api(repo, `/changes/${n}`))).json;

/**
 * main = README; branch `b<i>` = main + f<i>.txt; every change is enqueued.
 * With `merge`, main moves once after the branches were cut, so every
 * publication is a Kvarm merge commit rather than a fast-forward.
 */
async function setup(name: string, count: number, opts: { merge?: boolean } = {}): Promise<{ repo: FakeRepo; main: string; numbers: number[] }> {
  const repo = await seedRepo(name);
  const root = await commit(repo, { 'README.md': 'readme\n' });
  let main = root.sha;
  const numbers: number[] = [];
  const branches: string[] = [];
  for (let i = 1; i <= count; i++) {
    const b = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i}\n` }, [root.sha]);
    repo.refs.set(`refs/heads/b${i}`, b.sha);
    branches.push(`b${i}`);
  }
  if (opts.merge) main = (await commit(repo, { 'README.md': 'readme\n', 'base.txt': 'base\n' }, [root.sha])).sha;
  repo.refs.set(MAIN, main);
  for (const b of branches) {
    const r = await call('POST', api(name, '/changes'), { title: `Change ${b}`, base: 'main', head: b, mergePolicy: 'review' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    numbers.push(r.json.number as number);
    expect((await call('POST', api(name, `/changes/${r.json.number}/enqueue`))).status).toBe(201);
  }
  return { repo, main, numbers };
}

class Crash extends Error {}

type Deps = TrainDeps & { events: TrainEvent[]; crashed: () => boolean };

/**
 * Train deps with injected faults. `crashAt` throws at that checkpoint once
 * (the Worker dies there: the lease is never released and the run claim is
 * left behind); `hold` waits at that checkpoint until the test lets go.
 */
function trainDeps(over: Partial<TrainDeps> & { crashAt?: PublicationCheckpoint; hold?: { at: PublicationCheckpoint; reached: () => void; release: Promise<void> } } = {}): Deps {
  const events: TrainEvent[] = [];
  let crashed = false;
  const { crashAt, hold, ...rest } = over;
  let held = false;
  return {
    ...defaultTrainDeps,
    kick: async (_env, repoId, ref, reason, delaySeconds) => {
      sent.push({ body: { type: 'kvarm.train', repoId, ref, reason }, ...(delaySeconds ? { delaySeconds } : {}) });
    },
    observe: (e) => events.push(e),
    async checkpoint(step) {
      if (crashAt === step && !crashed) {
        crashed = true;
        throw new Crash(`crash at ${step}`);
      }
      if (hold && hold.at === step && !held) {
        held = true;
        hold.reached();
        await hold.release;
      }
    },
    lease(e, repoId, ref) {
      const real = mergeLockLease(e, repoId, ref);
      return {
        acquire: (owner, ttl) => real.acquire(owner, ttl),
        // A dead Worker releases nothing.
        release: async (owner, generation) => (crashed ? { released: false, code: 'DEAD' } : real.release(owner, generation)),
      };
    },
    events,
    crashed: () => crashed,
    ...rest,
  };
}

/** A pusher whose receive-pack reply is lost after the store processed the request. */
function lostReply(timeline?: string[]): Pick<TrainDeps, 'pusher'> {
  return {
    pusher(e, r) {
      const real = defaultTrainDeps.pusher(e, r);
      return {
        listRefs: () => real.listRefs(),
        updateRef: (command, objects) => {
          timeline?.push(`updateRef:${command.ref}`);
          return real.updateRef(command, objects);
        },
        async prepareUpdate(command, objects) {
          const prepared = await real.prepareUpdate(command, objects);
          return {
            async send() {
              const r = await prepared.send();
              return { ...r, status: 'unknown' as const, reason: 'connection reset' };
            },
          };
        },
      };
    },
  };
}

const lockStub = (name: string) => env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(`${repoIds[name]}:${MAIN}`));

async function leaseOf(name: string): Promise<Lease | null> {
  return (await (await lockStub(name).fetch('https://merge-lock/status')).json<{ lease: Lease | null }>()).lease;
}

/**
 * Lets the time a crashed publisher leaves behind pass: its publishing entry
 * and its run claim age past their bounds, and its lease is past expiry,
 * whose alarm then runs (kicking the train through the real event queue
 * message). Returns the kicks the alarm sent.
 */
async function letTimePass(name: string): Promise<Array<{ body: any }>> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE merge_queue SET updated_at = updated_at - ?2 WHERE repo_id = ?1 AND state = 'publishing'`).bind(repoIds[name], 3 * TRAIN_LIMITS.leaseTtlMs),
    env.DB.prepare('UPDATE merge_trains SET runner_until = 0 WHERE repo_id = ?1').bind(repoIds[name]),
  ]);
  const mark = sent.length;
  await runInDurableObject(lockStub(name), async (obj: MergeLock, state) => {
    const lease = await state.storage.get<Lease>('lease');
    if (!lease) return;
    await state.storage.put('lease', { ...lease, expiresAt: Date.now() - 1 });
    // The alarm the lease armed, as it fires at expiry.
    await obj.alarm();
  });
  return sent.slice(mark);
}

/** Delivers kick messages to the Worker's queue consumer, the production path. */
async function deliver(kicks: Array<{ body: any }>): Promise<void> {
  const batch = createMessageBatch('kvarm-events', kicks.map((k) => ({ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: k.body })));
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
}

interface EntrySnap {
  change_number: number;
  state: string;
  active: number;
  generation: number;
  merge_commit: string | null;
  reason_code: string | null;
}

async function entries(name: string): Promise<EntrySnap[]> {
  return (
    (
      await env.DB.prepare('SELECT change_number, state, active, generation, merge_commit, reason_code FROM merge_queue WHERE repo_id = ? ORDER BY seq')
        .bind(repoIds[name])
        .all<EntrySnap>()
    ).results ?? []
  );
}

interface IntentSnap {
  queue_id: string;
  generation: number;
  state: string;
  old_sha: string;
  new_sha: string;
  observed_sha: string | null;
  attempt: number;
}

async function intents(name: string): Promise<IntentSnap[]> {
  return (
    (
      await env.DB.prepare('SELECT queue_id, generation, state, old_sha, new_sha, observed_sha, attempt FROM merge_publication_intents WHERE repo_id = ? ORDER BY created_at, generation')
        .bind(repoIds[name])
        .all<IntentSnap>()
    ).results ?? []
  );
}

async function reconciledEvents(name: string): Promise<Array<{ outcome: string; change: number; newSha: string; observedSha: string | null }>> {
  const rows =
    (
      await env.DB.prepare(`SELECT payload FROM events WHERE type = ?1 AND json_extract(payload, '$.source') = ?2 ORDER BY created_at`)
        .bind(PUBLICATION_RECONCILED_EVENT, `/repos/${OWNER}/${name}`)
        .all<{ payload: string }>()
    ).results ?? [];
  return rows.map((r) => JSON.parse(r.payload).data);
}

const pushesTo = (repo: FakeRepo, ref: string) => repo.calls.filter((c) => c.startsWith(`receivePack:${ref}:`));

/** The invariant every scenario ends in: registry == ref, one publication per change, no lost one. */
async function expectConsistent(name: string, repo: FakeRepo, numbers: number[]): Promise<void> {
  const rows = await entries(name);
  const published = rows.filter((r) => r.state === 'published');
  expect(published.map((r) => r.change_number).sort()).toEqual([...numbers].sort());
  expect(rows.filter((r) => r.active === 1)).toEqual([]);
  for (const n of numbers) {
    const c = await getChange(name, n);
    expect(c.state, `change ${n}`).toBe('merged');
    expect(published.filter((r) => r.change_number === n)).toHaveLength(1);
    expect(published.find((r) => r.change_number === n)!.merge_commit).toBe(c.mergeCommit);
  }
  // The last publication is the ref; the registry never runs ahead of or behind it.
  const last = published.at(-1)!;
  expect(repo.refs.get(MAIN)).toBe(last.merge_commit);
  // Every publication intent is resolved.
  expect((await intents(name)).filter((i) => i.state === 'pending')).toEqual([]);
}

beforeAll(async () => {
  installFakeGitRemote();
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${OWNER}`, OWNER, `${OWNER}@kvarm.invalid`, OWNER, Date.now())
    .run();
  tok.owner = (await mintPAT(env, id, 'owner', FULL)).token;
  // The lease alarm's kick goes to the recording queue, so a test can deliver it.
  mergeLockAlarm.env = (e) => ({ ...e, EVENTS: fakeEvents as unknown as Env['EVENTS'] });
});

afterAll(() => {
  restoreFetch();
  mergeLockAlarm.env = savedAlarmEnv;
});

afterEach(() => {
  sent.length = 0;
});

describe('publication intents', () => {
  it('records the intended ref move before the push and resolves it with the record in one batch', async () => {
    const { repo, main, numbers } = await setup('intent-normal', 1, { merge: true });
    let seen: IntentSnap[] | null = null;
    const deps = trainDeps({
      async checkpoint(step) {
        if (step === 'intent-recorded') {
          seen = await intents('intent-normal');
          // Nothing was sent yet.
          expect(pushesTo(repo, MAIN)).toHaveLength(0);
        }
      },
    });
    const run = await runTrain(env, repoIds['intent-normal']!, MAIN, deps);
    expect(run.published).toEqual(numbers);
    expect(seen).toEqual([expect.objectContaining({ state: 'pending', old_sha: main, new_sha: repo.refs.get(MAIN) })]);
    expect(await intents('intent-normal')).toEqual([expect.objectContaining({ state: 'published', new_sha: repo.refs.get(MAIN) })]);
    expect(await reconciledEvents('intent-normal')).toEqual([]);
    await expectConsistent('intent-normal', repo, numbers);
    expect(await leaseOf('intent-normal')).toBeNull();
  });

  it('a publisher whose claim is lost writes no intent and sends nothing', async () => {
    const { repo, main, numbers } = await setup('intent-lost-claim', 1, { merge: true });
    let once = true;
    const deps = trainDeps({
      pusher(e, r) {
        const real = defaultTrainDeps.pusher(e, r);
        return {
          listRefs: () => real.listRefs(),
          updateRef: (command, objects) => real.updateRef(command, objects),
          async prepareUpdate(command, objects) {
            const prepared = await real.prepareUpdate(command, objects);
            if (once) {
              once = false;
              // Another writer moves the entry on while the pack is prepared, so the claim finds nothing to claim.
              await env.DB.prepare('UPDATE merge_queue SET generation = generation + 1 WHERE repo_id = ? AND active = 1').bind(repoIds['intent-lost-claim']).run();
            }
            return prepared;
          },
        };
      },
    });
    const run = await runTrain(env, repoIds['intent-lost-claim']!, MAIN, deps);
    // The lost claim sends nothing; the next pass of the same run publishes at the new generation.
    expect(pushesTo(repo, MAIN)).toHaveLength(run.published.length);
    expect(repo.refs.get(MAIN) === main).toBe(run.published.length === 0);
    const rows = await intents('intent-lost-claim');
    expect(rows.every((i) => i.state === 'published')).toBe(true);
    expect(rows).toHaveLength(run.published.length);
    if (run.published.length === 0) await runTrain(env, repoIds['intent-lost-claim']!, MAIN, trainDeps());
    await expectConsistent('intent-lost-claim', repo, numbers);
    expect(await intents('intent-lost-claim')).toHaveLength(1);
  });

  it('a publisher that refuses after its claim withdraws its intent with the refusal', async () => {
    const { repo, main, numbers } = await setup('intent-withdrawn', 1, { merge: true });
    // The target moves after the pass composed the candidate: the publisher's ls-refs sees it and sends nothing.
    const deps = trainDeps({
      pusher(e, r) {
        const real = defaultTrainDeps.pusher(e, r);
        return {
          listRefs: () => real.listRefs(),
          updateRef: (command, objects) => real.updateRef(command, objects),
          async prepareUpdate(command, objects) {
            const prepared = await real.prepareUpdate(command, objects);
            if (repo.refs.get(MAIN) === main) repo.refs.set(MAIN, (await commit(repo, { 'README.md': 'readme\n', 'base.txt': 'base\n', 'other.txt': 'o\n' }, [main])).sha);
            return prepared;
          },
        };
      },
    });
    await runTrain(env, repoIds['intent-withdrawn']!, MAIN, deps);
    const rows = await intents('intent-withdrawn');
    expect(rows[0]).toMatchObject({ state: 'withdrawn', old_sha: main });
    expect(pushesTo(repo, MAIN).filter((c) => c.includes(`:${main}->`))).toEqual([]);
    if ((await entries('intent-withdrawn')).some((r) => r.active === 1)) await runTrain(env, repoIds['intent-withdrawn']!, MAIN, trainDeps());
    await expectConsistent('intent-withdrawn', repo, numbers);
  });
});

describe('injected failures converge to registry == ref', () => {
  it('(a) a crash before the push: reconciliation finds the old value, releases and the train republishes once', async () => {
    const { repo, main, numbers } = await setup('crash-before-push', 1, { merge: true });
    const deps = trainDeps({ crashAt: 'intent-recorded' });
    await expect(runTrain(env, repoIds['crash-before-push']!, MAIN, deps)).rejects.toThrow(Crash);
    expect(repo.refs.get(MAIN)).toBe(main);
    expect(pushesTo(repo, MAIN)).toHaveLength(0);
    expect((await entries('crash-before-push')).map((e) => e.state)).toEqual(['publishing']);
    expect((await intents('crash-before-push')).map((i) => i.state)).toEqual(['pending']);

    // The lease's alarm kicks the train; the consumer's run reconciles and publishes with no manual step.
    const kicks = await letTimePass('crash-before-push');
    expect(kicks.map((k) => k.body.reason)).toEqual(['lease-expired']);
    await deliver(kicks);

    await expectConsistent('crash-before-push', repo, numbers);
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect((await intents('crash-before-push')).map((i) => [i.state, i.observed_sha, i.attempt])).toEqual([
      ['not_applied', main, 0],
      // The recovered attempt counts: the retry is attempt 1.
      ['published', null, 1],
    ]);
    expect((await reconciledEvents('crash-before-push')).map((e) => e.outcome)).toEqual(['not_applied']);
  });

  it('(b) a crash after the push was accepted, before the record: reconciliation completes the record exactly once', async () => {
    const { repo, numbers } = await setup('crash-after-push', 1, { merge: true });
    const deps = trainDeps({ crashAt: 'pushed' });
    await expect(runTrain(env, repoIds['crash-after-push']!, MAIN, deps)).rejects.toThrow(Crash);
    const landed = repo.refs.get(MAIN)!;
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    // The registry lags the ref: the change is still open, the entry publishing.
    expect((await getChange('crash-after-push', numbers[0]!)).state).toBe('open');
    expect((await entries('crash-after-push')).map((e) => e.state)).toEqual(['publishing']);

    await deliver(await letTimePass('crash-after-push'));

    await expectConsistent('crash-after-push', repo, numbers);
    // No second push, no second merge commit.
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect(repo.refs.get(MAIN)).toBe(landed);
    expect((await entries('crash-after-push'))[0]).toMatchObject({ state: 'published', merge_commit: landed, reason_code: 'PUBLICATION_RECONCILED' });
    expect((await intents('crash-after-push')).map((i) => [i.state, i.observed_sha])).toEqual([['reconciled', landed]]);
    expect(await reconciledEvents('crash-after-push')).toEqual([expect.objectContaining({ outcome: 'completed', change: numbers[0], newSha: landed, observedSha: landed })]);

    // Another pass (a redelivered kick) changes nothing and records no second event.
    await runTrain(env, repoIds['crash-after-push']!, MAIN, trainDeps());
    expect(await reconciledEvents('crash-after-push')).toHaveLength(1);
    await expectConsistent('crash-after-push', repo, numbers);
  });

  it('(c) a crash after the record, before the lease release: the next entry publishes once the lease expires', async () => {
    const { repo, numbers } = await setup('crash-after-record', 2, { merge: true });
    const deps = trainDeps({ crashAt: 'recorded' });
    await expect(runTrain(env, repoIds['crash-after-record']!, MAIN, deps)).rejects.toThrow(Crash);
    // The record landed with the push: registry == ref for the first change.
    const first = await getChange('crash-after-record', numbers[0]!);
    expect(first).toMatchObject({ state: 'merged', mergeCommit: repo.refs.get(MAIN) });
    expect(await leaseOf('crash-after-record')).not.toBeNull();

    // While the dead publisher's lease is live, the train backs off instead of publishing around it.
    await env.DB.prepare('UPDATE merge_trains SET runner_until = 0 WHERE repo_id = ?1').bind(repoIds['crash-after-record']).run();
    const blocked = await runTrain(env, repoIds['crash-after-record']!, MAIN, trainDeps());
    expect(blocked.state).toBe('backoff');
    expect(blocked.published).toEqual([]);

    await deliver(await letTimePass('crash-after-record'));
    await expectConsistent('crash-after-record', repo, numbers);
    expect(pushesTo(repo, MAIN)).toHaveLength(2);
    expect((await intents('crash-after-record')).map((i) => i.state)).toEqual(['published', 'published']);
    expect(await reconciledEvents('crash-after-record')).toEqual([]);
  });

  it('(d) a crash during reconciliation itself: reconciling again converges, still exactly once', async () => {
    const { repo, numbers } = await setup('crash-reconcile', 1, { merge: true });
    await expect(runTrain(env, repoIds['crash-reconcile']!, MAIN, trainDeps({ crashAt: 'pushed' }))).rejects.toThrow(Crash);
    const landed = repo.refs.get(MAIN)!;
    await letTimePass('crash-reconcile');

    await expect(runTrain(env, repoIds['crash-reconcile']!, MAIN, trainDeps({ crashAt: 'reconcile-decided' }))).rejects.toThrow(Crash);
    // The interrupted reconciliation wrote nothing.
    expect((await entries('crash-reconcile')).map((e) => e.state)).toEqual(['publishing']);
    expect((await intents('crash-reconcile')).map((i) => i.state)).toEqual(['pending']);
    expect(await reconciledEvents('crash-reconcile')).toEqual([]);

    await letTimePass('crash-reconcile');
    await runTrain(env, repoIds['crash-reconcile']!, MAIN, trainDeps());
    await expectConsistent('crash-reconcile', repo, numbers);
    expect(repo.refs.get(MAIN)).toBe(landed);
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect((await reconciledEvents('crash-reconcile')).map((e) => e.outcome)).toEqual(['completed']);
  });

  it('(e) a lost reply whose push landed is completed by reconciliation in the same run, not guessed', async () => {
    const { repo, numbers } = await setup('lost-moved', 1, { merge: true });
    const timeline: string[] = [];
    const deps = trainDeps({
      ...lostReply(timeline),
      observe: (e) => {
        if (e.type === 'lease') timeline.push(`lease:${e.op}`);
      },
    });
    const run = await runTrain(env, repoIds['lost-moved']!, MAIN, deps);
    expect(run.published).toEqual(numbers);
    await expectConsistent('lost-moved', repo, numbers);
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect((await intents('lost-moved')).map((i) => i.state)).toEqual(['reconciled']);
    expect((await reconciledEvents('lost-moved')).map((e) => e.outcome)).toEqual(['completed']);
    expect(await leaseOf('lost-moved')).toBeNull();
    // The follow-up of the reconciled record (the merge commit's attribution note) runs after the lease is released.
    expect(timeline).toEqual(['lease:acquire', 'lease:release', 'updateRef:refs/notes/kvarm-attribution']);
  });

  it('a crashed publication someone already built on is completed, not counted as a base move, even with its attempts spent', async () => {
    const { repo, numbers } = await setup('built-on', 1, { merge: true });
    await expect(runTrain(env, repoIds['built-on']!, MAIN, trainDeps({ crashAt: 'pushed' }))).rejects.toThrow(Crash);
    const landed = repo.refs.get(MAIN)!;
    const onTop = await commit(repo, { 'README.md': 'readme\n', 'base.txt': 'base\n', 'f1.txt': 'file 1\n', 'later.txt': 'l\n' }, [landed]);
    repo.refs.set(MAIN, onTop.sha);
    await env.DB.prepare('UPDATE merge_queue SET attempts = ?2 WHERE repo_id = ?1').bind(repoIds['built-on'], TRAIN_LIMITS.maxAttempts - 1).run();

    await deliver(await letTimePass('built-on'));
    const [entry] = await entries('built-on');
    expect(entry).toMatchObject({ state: 'published', merge_commit: landed, reason_code: 'PUBLICATION_RECONCILED' });
    expect(await getChange('built-on', numbers[0]!)).toMatchObject({ state: 'merged', mergeCommit: landed });
    expect(repo.refs.get(MAIN)).toBe(onTop.sha);
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect((await intents('built-on')).map((i) => [i.state, i.observed_sha])).toEqual([['reconciled', onTop.sha]]);
    expect((await reconciledEvents('built-on')).map((e) => e.outcome)).toEqual(['completed']);
  });

  it('an earlier attempt that landed late is recognized even after a newer attempt failed on it', async () => {
    const { repo, main, numbers } = await setup('late-older', 1, { merge: true });
    // Attempt 1 stalls right before its send.
    let reachedA!: () => void;
    const atA = new Promise<void>((r) => (reachedA = r));
    let letGoA!: () => void;
    const releaseA = new Promise<void>((r) => (letGoA = r));
    const runA = runTrain(env, repoIds['late-older']!, MAIN, trainDeps({ hold: { at: 'intent-recorded', reached: reachedA, release: releaseA } }));
    await atA;

    // Attempt 1 is reconciled as not applied (the ref still holds main); attempt 2 is claimed, and right before
    // its own send attempt 1's push lands, so attempt 2's push is answered stale.
    await letTimePass('late-older');
    const b = trainDeps({
      async checkpoint(step) {
        if (step !== 'intent-recorded') return;
        letGoA();
        for (let i = 0; i < 200 && repo.refs.get(MAIN) === main; i++) await new Promise((r) => setTimeout(r, 10));
      },
    });
    await runTrain(env, repoIds['late-older']!, MAIN, b);
    await runA;
    const landed = repo.refs.get(MAIN)!;
    expect(landed).not.toBe(main);
    const first = (await intents('late-older'))[0]!;
    expect(first).toMatchObject({ old_sha: main, new_sha: landed });

    for (let i = 0; i < 3 && (await entries('late-older')).some((r) => r.active === 1); i++) {
      await env.DB.prepare('UPDATE merge_trains SET runner_until = 0 WHERE repo_id = ?1').bind(repoIds['late-older']).run();
      await runTrain(env, repoIds['late-older']!, MAIN, trainDeps());
    }
    await expectConsistent('late-older', repo, numbers);
    expect(repo.refs.get(MAIN)).toBe(landed);
    const states = (await intents('late-older')).map((i) => i.state);
    expect(states[0]).toBe('reconciled');
    expect(states.slice(1).every((s) => s === 'moved')).toBe(true);
  });

  it('(e) a lost reply whose read-back also fails stays pending, then a later pass completes it', async () => {
    const { repo, numbers } = await setup('lost-unread', 1, { merge: true });
    let armed = false;
    repo.hook = async (c) => {
      if (c.startsWith('receivePack:')) armed = true;
      else if (c === 'lsRefs' && armed) {
        armed = false;
        throw new Error('read-back failed');
      }
    };
    try {
      const run = await runTrain(env, repoIds['lost-unread']!, MAIN, trainDeps(lostReply()));
      expect(run.published).toEqual([]);
      expect(run.state).toBe('backoff');
    } finally {
      repo.hook = null;
    }
    // Unknown is not "failed": the entry keeps its claim and nothing is retried on top of the possibly landed push.
    expect((await entries('lost-unread')).map((e) => e.state)).toEqual(['publishing']);
    expect((await intents('lost-unread')).map((i) => i.state)).toEqual(['pending']);
    expect((await getChange('lost-unread', numbers[0]!)).state).toBe('open');

    // The run's own delayed backoff kick (the publisher released its lease, so no alarm is involved) drives the recovery.
    const kicks = sent.filter((m) => m.body.reason === 'backoff' && m.delaySeconds !== undefined);
    expect(kicks).toHaveLength(1);
    await letTimePass('lost-unread');
    await deliver(kicks);
    await expectConsistent('lost-unread', repo, numbers);
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect((await reconciledEvents('lost-unread')).map((e) => e.outcome)).toEqual(['completed']);
  });

  it('(f) a lost reply with the ref not moved releases the entry to retry with backoff, then publishes once', async () => {
    const { repo, main, numbers } = await setup('lost-unmoved', 1, { merge: true });
    repo.receivePackStatus = 502;
    try {
      const run = await runTrain(env, repoIds['lost-unmoved']!, MAIN, trainDeps());
      expect(run.published).toEqual([]);
      expect(run.state).toBe('backoff');
      expect(run.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      repo.receivePackStatus = null;
    }
    expect(repo.refs.get(MAIN)).toBe(main);
    expect((await entries('lost-unmoved')).map((e) => [e.state, e.active])).toEqual([['queued', 1]]);
    expect((await intents('lost-unmoved')).map((i) => [i.state, i.observed_sha])).toEqual([['not_applied', main]]);
    expect((await reconciledEvents('lost-unmoved')).map((e) => e.outcome)).toEqual(['not_applied']);

    const again = await runTrain(env, repoIds['lost-unmoved']!, MAIN, trainDeps());
    expect(again.published).toEqual(numbers);
    await expectConsistent('lost-unmoved', repo, numbers);
  });

  it('(f) a crash after a push whose ref was then moved by someone else: the entry recomposes, nothing is overwritten', async () => {
    const { repo, numbers } = await setup('moved-by-other', 1, { merge: true });
    await expect(runTrain(env, repoIds['moved-by-other']!, MAIN, trainDeps({ crashAt: 'intent-recorded' }))).rejects.toThrow(Crash);
    // Someone else moved main meanwhile (the crashed push never happened).
    const foreign = await commit(repo, { 'README.md': 'readme\n', 'base.txt': 'base\n', 'foreign.txt': 'x\n' }, [repo.refs.get(MAIN)!]);
    repo.refs.set(MAIN, foreign.sha);

    await deliver(await letTimePass('moved-by-other'));
    expect((await intents('moved-by-other')).map((i) => [i.state, i.observed_sha])).toEqual([
      ['moved', foreign.sha],
      ['published', null],
    ]);
    await expectConsistent('moved-by-other', repo, numbers);
    // The foreign commit survives under the republished merge.
    const tip = repo.refs.get(MAIN)!;
    expect(new TextDecoder().decode(repo.objects.get(tip)!.content)).toContain(`parent ${foreign.sha}`);
    expect((await reconciledEvents('moved-by-other')).map((e) => e.outcome)).toEqual(['moved']);
  });

  it('(g) a publisher that resumes after a newer generation reconciled its entry and published the next one changes nothing', async () => {
    const { repo, numbers } = await setup('zombie', 2, { merge: true });
    let reached!: () => void;
    const atPushed = new Promise<void>((r) => (reached = r));
    let letGo!: () => void;
    const release = new Promise<void>((r) => (letGo = r));
    const a = trainDeps({ hold: { at: 'pushed', reached, release } });
    const runA = runTrain(env, repoIds.zombie!, MAIN, a);
    await atPushed;
    const firstLanded = repo.refs.get(MAIN)!;
    const leaseA = await leaseOf('zombie');
    expect(leaseA).not.toBeNull();

    // A stalls past its lease; a newer run reconciles A's entry and publishes the next under a newer lease generation.
    await letTimePass('zombie');
    const b = trainDeps();
    const runB = await runTrain(env, repoIds.zombie!, MAIN, b);
    expect(runB.published).toEqual(numbers);
    const leaseOps = b.events.filter((e): e is Extract<TrainEvent, { type: 'lease' }> => e.type === 'lease' && e.op === 'acquire');
    expect(leaseOps[0]!.generation).toBeGreaterThan(leaseA!.generation);
    const tipAfterB = repo.refs.get(MAIN)!;

    letGo();
    const resultA = await runA;
    // A's late success is fenced out: no second record, no event, no lease release over B's generation.
    expect(resultA.published).toEqual([]);
    expect(a.events.filter((e) => e.type === 'publish' && (e as { status: string }).status === 'recorded')).toEqual([]);
    const releaseA = a.events.find((e): e is Extract<TrainEvent, { type: 'lease' }> => e.type === 'lease' && e.op === 'release');
    expect(releaseA?.ok).toBe(false);
    expect(repo.refs.get(MAIN)).toBe(tipAfterB);
    expect(pushesTo(repo, MAIN)).toHaveLength(2);
    await expectConsistent('zombie', repo, numbers);
    expect((await entries('zombie'))[0]!.merge_commit).toBe(firstLanded);
    expect((await reconciledEvents('zombie')).map((e) => [e.outcome, e.change])).toEqual([['completed', numbers[0]]]);
  });

  it('a publisher whose entry was rolled back while its push was in flight: the late landing is recorded, not lost', async () => {
    const { repo, numbers } = await setup('late-landing', 1, { merge: true });
    let reached!: () => void;
    const atIntent = new Promise<void>((r) => (reached = r));
    let letGo!: () => void;
    const release = new Promise<void>((r) => (letGo = r));
    const a = trainDeps({ hold: { at: 'intent-recorded', reached, release } });
    const runA = runTrain(env, repoIds['late-landing']!, MAIN, a);
    await atIntent;

    // Reconciliation sees the old value and rolls the entry back; A's lease still blocks republishing.
    await env.DB.batch([
      env.DB.prepare(`UPDATE merge_queue SET updated_at = updated_at - ?2 WHERE repo_id = ?1 AND state = 'publishing'`).bind(repoIds['late-landing'], 3 * TRAIN_LIMITS.leaseTtlMs),
      env.DB.prepare('UPDATE merge_trains SET runner_until = 0 WHERE repo_id = ?1').bind(repoIds['late-landing']),
    ]);
    const b = await runTrain(env, repoIds['late-landing']!, MAIN, trainDeps());
    expect(b.published).toEqual([]);
    expect((await intents('late-landing')).map((i) => i.state)).toEqual(['not_applied']);

    // A's push still lands (Artifacts knows nothing of D1 fences); its own record is fenced out, and its run's
    // next pass finds the head already in the target and recognizes the entry's own landed publication.
    letGo();
    const resultA = await runA;
    const landed = repo.refs.get(MAIN)!;
    expect(pushesTo(repo, MAIN)).toHaveLength(1);
    expect(a.events.filter((e) => e.type === 'publish' && (e as { status: string }).status === 'recorded')).toEqual([]);
    expect(resultA.published).toEqual(numbers);
    expect(a.events.filter((e) => e.type === 'publish' && (e as { status: string }).status === 'reconciled')).toHaveLength(1);

    // Further passes change nothing.
    await env.DB.prepare('UPDATE merge_trains SET runner_until = 0 WHERE repo_id = ?1').bind(repoIds['late-landing']).run();
    expect((await runTrain(env, repoIds['late-landing']!, MAIN, trainDeps())).published).toEqual([]);
    await expectConsistent('late-landing', repo, numbers);
    expect(repo.refs.get(MAIN)).toBe(landed);
    expect((await intents('late-landing')).map((i) => i.state)).toEqual(['reconciled']);
    expect((await reconciledEvents('late-landing')).map((e) => e.outcome)).toEqual(['not_applied', 'completed']);
  });
});

describe('reconciliation budget', () => {
  it('reads no extra ref for a crashed entry (the pass read the target once) and reconciles at most RECONCILE_LIMITS.perPass per pass', async () => {
    expect(RECONCILE_LIMITS.perPass).toBeGreaterThan(0);
    const { repo, numbers } = await setup('budget', 1, { merge: true });
    await expect(runTrain(env, repoIds.budget!, MAIN, trainDeps({ crashAt: 'pushed' }))).rejects.toThrow(Crash);
    await letTimePass('budget');
    const mark = lsRefsPrefixes.length;
    const deps = trainDeps();
    const run = await runTrain(env, repoIds.budget!, MAIN, deps);
    expect(run.published).toEqual(numbers);
    // The target is read once, by the pass's own ls-refs (with the head branch); reconciliation adds no read of it.
    const targetReads = lsRefsPrefixes.slice(mark).filter((p) => p.includes(MAIN));
    expect(targetReads).toHaveLength(1);
    expect(targetReads[0]).toContain('refs/heads/b1');
    await expectConsistent('budget', repo, numbers);
  });
});
