/**
 * Publication lease (do/mergeLock.ts) and generation/owner-fenced claims
 * (services/fencing.ts): a stale holder's late report or release never
 * overwrites or frees its successor, and expiry restores progress.
 * Deterministic clocks for claims; the real Durable Object (with its alarm
 * run directly) for the lease.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { INTENT_PREFIX, LEASE_KICK, mergeLockAlarm, type Lease, type MergeLock, type SettleIntent } from '../src/do/mergeLock';
import { SETTLE_INTENT } from '../src/services/dependencyGate';
import { advanceFenced, claimFenced, readFenced, releaseFenced, reportFenced } from '../src/services/fencing';

const env = cfEnv as unknown as Env;
const savedIntent = { ...SETTLE_INTENT };
const savedKick = { ...LEASE_KICK };
const savedAlarmEnv = mergeLockAlarm.env;

afterEach(() => {
  Object.assign(SETTLE_INTENT, savedIntent);
  Object.assign(LEASE_KICK, savedKick);
  mergeLockAlarm.env = savedAlarmEnv;
});

function lock(name: string) {
  const stub = env.MERGE_LOCK.get(env.MERGE_LOCK.idFromName(name));
  const post = async (path: string, body: unknown) => {
    const res = await stub.fetch(`https://merge-lock${path}`, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return {
    stub,
    acquire: (owner: string, ttlMs?: number) => post('/acquire', { owner, ...(ttlMs !== undefined ? { ttlMs } : {}) }),
    release: (owner: string, generation: number) => post('/release', { owner, generation }),
    status: async () => (await (await stub.fetch('https://merge-lock/status')).json()) as { lease: Lease | null; generation: number },
    intend: (landing: Partial<SettleIntent> = {}) =>
      post('/settle-intent', {
        repoId: `repo-${name}`,
        changeSetId: 'change-1',
        mergedAt: 1_000,
        mergeCommit: 'a'.repeat(40),
        ref: 'refs/heads/main',
        ...landing,
      }),
    alarmAt: () => runInDurableObject(stub, async (_obj, state) => state.storage.getAlarm()),
    intents: () => runInDurableObject(stub, async (_obj, state) => [...(await state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX })).values()]),
    /** Makes every pending intent due and runs the alarm handler once. */
    fireDue: () =>
      runInDurableObject(stub, async (obj: MergeLock, state) => {
        for (const [key, intent] of await state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX })) {
          await state.storage.put(key, { ...intent, deadline: Date.now() - 1 });
        }
        await obj.alarm();
      }),
  };
}

/** An env whose queue sends reject or record, for the alarm's own effects. */
function alarmEnv(over: { send?: (body: unknown) => Promise<void>; db?: D1Database } = {}): (e: Env) => Env {
  return (e) => ({ ...e, ...(over.db ? { DB: over.db } : {}), EVENTS: { send: over.send ?? (async () => {}), sendBatch: async () => {} } as unknown as Env['EVENTS'] });
}

describe('MergeLock publication lease', () => {
  it('release is reachable and frees the lease for the next holder', async () => {
    const l = lock('release-reachable');
    const a = await l.acquire('a');
    expect(a.json).toMatchObject({ acquired: true, generation: 1 });
    const busy = await l.acquire('b');
    expect(busy.json).toMatchObject({ acquired: false, holder: { owner: 'a', generation: 1 } });
    expect(busy.json.retryAfterMs).toBeGreaterThan(0);
    const rel = await l.release('a', 1);
    expect(rel).toMatchObject({ status: 200, json: { released: true, generation: 1 } });
    expect((await l.status()).lease).toBeNull();
    expect((await l.acquire('b')).json).toMatchObject({ acquired: true, generation: 2 });
  });

  it("a stale generation's late release cannot free its successor's lease", async () => {
    const l = lock('stale-release');
    expect((await l.acquire('gen1', 1)).json).toMatchObject({ acquired: true, generation: 1 });
    await new Promise((r) => setTimeout(r, 5));
    const g2 = await l.acquire('gen2', 60_000);
    expect(g2.json).toMatchObject({ acquired: true, generation: 2 });

    const late = await l.release('gen1', 1);
    expect(late.status).toBe(409);
    expect(late.json).toMatchObject({ released: false, code: 'STALE_GENERATION', current: { owner: 'gen2', generation: 2 } });
    // Same owner name but a stale generation is also refused.
    expect((await l.release('gen2', 1)).status).toBe(409);
    expect((await l.status()).lease).toMatchObject({ owner: 'gen2', generation: 2 });
    expect((await l.acquire('other')).json.acquired).toBe(false);

    expect((await l.release('gen2', 2)).json).toMatchObject({ released: true });
    expect((await l.status()).lease).toBeNull();
  });

  it('the alarm clears an expired lease so the partition makes progress without polling', async () => {
    const l = lock('alarm-expiry');
    expect((await l.acquire('crashed', 1)).json).toMatchObject({ acquired: true, generation: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // The scheduled alarm may already have run; run it now if it has not.
    await runDurableObjectAlarm(l.stub);
    expect(await runInDurableObject(l.stub, async (_obj, state) => state.storage.get<Lease>('lease'))).toBeUndefined();

    // The handler itself, on a stored expired lease, deterministically.
    await runInDurableObject(l.stub, async (obj, state) => {
      await state.storage.put('lease', { owner: 'crashed-again', generation: 1, expiresAt: Date.now() - 1 } satisfies Lease);
      await obj.alarm!();
      expect(await state.storage.get('lease')).toBeUndefined();
    });
    expect((await l.release('crashed', 1)).status).toBe(409);
    expect((await l.acquire('next')).json).toMatchObject({ acquired: true, generation: 2 });
  });

  it('an alarm firing before expiry keeps the live lease and re-arms', async () => {
    const l = lock('early-alarm');
    expect((await l.acquire('live', 60_000)).json.acquired).toBe(true);
    expect(await runDurableObjectAlarm(l.stub)).toBe(true);
    expect((await l.status()).lease).toMatchObject({ owner: 'live', generation: 1 });
    const alarm = await runInDurableObject(l.stub, async (_obj, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
  });

  it('rejects an acquire without an owner', async () => {
    const r = await lock('no-owner').acquire('');
    expect(r.status).toBe(400);
  });

  it('an expired lease is cleared only after its train kick succeeds', async () => {
    const l = lock('expiry-kick');
    const kicks: unknown[] = [];
    let fail = true;
    mergeLockAlarm.env = alarmEnv({
      send: async (body) => {
        if (fail) throw new Error('queue send rejected (test)');
        kicks.push(body);
      },
    });
    await runInDurableObject(l.stub, async (obj: MergeLock, state) => {
      await state.storage.put('lease', { owner: 'dead', generation: 1, expiresAt: Date.now() - 1, repoId: 'r', ref: 'refs/heads/main' } satisfies Lease);
      await obj.alarm();
      // The kick failed: the lease stays (expired, so not held) and the alarm retries it.
      const kept = await state.storage.get<Lease>('lease');
      expect(kept).toMatchObject({ owner: 'dead', generation: 1, kickAttempts: 1 });
      expect(await state.storage.getAlarm()).toBe(kept!.retryAt);
      fail = false;
      await state.storage.put('lease', { ...kept!, retryAt: Date.now() - 1 });
      await obj.alarm();
      expect(await state.storage.get('lease')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(kicks).toEqual([{ type: 'kvarm.train', repoId: 'r', ref: 'refs/heads/main', reason: 'lease-expired' }]);
  });

  it('an expired lease whose kick keeps failing is kept with capped backoff past any attempt count, and cleared once a kick succeeds', async () => {
    LEASE_KICK.retryMs = 1_000;
    LEASE_KICK.retryMaxMs = 4_000;
    const l = lock('expiry-kick-persist');
    const kicks: unknown[] = [];
    let fail = true;
    mergeLockAlarm.env = alarmEnv({
      send: async (body) => {
        if (fail) throw new Error('queue send rejected (test)');
        kicks.push(body);
      },
    });
    await runInDurableObject(l.stub, async (obj: MergeLock, state) => {
      await state.storage.put('lease', { owner: 'dead', generation: 1, expiresAt: Date.now() - 1, repoId: 'r', ref: 'refs/heads/main' } satisfies Lease);
      for (let i = 1; i <= 9; i++) {
        const before = Date.now();
        await obj.alarm();
        const kept = await state.storage.get<Lease>('lease');
        // Never dropped while its kick has not succeeded: the attempt count only grows the (capped) backoff.
        expect(kept).toMatchObject({ owner: 'dead', generation: 1, kickAttempts: i });
        const delay = kept!.retryAt! - before;
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(LEASE_KICK.retryMaxMs + 50);
        if (i >= 4) expect(delay).toBeGreaterThanOrEqual(LEASE_KICK.retryMaxMs - 50);
        expect(await state.storage.getAlarm()).toBe(kept!.retryAt);
        await state.storage.put('lease', { ...kept!, retryAt: Date.now() - 1 });
      }
      fail = false;
      await obj.alarm();
      expect(await state.storage.get('lease')).toBeUndefined();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(kicks).toEqual([{ type: 'kvarm.train', repoId: 'r', ref: 'refs/heads/main', reason: 'lease-expired' }]);
  });

  it('an acquire on an expired lease with a pending kick retry succeeds and supersedes the retry', async () => {
    LEASE_KICK.retryMs = 60_000;
    const l = lock('expiry-kick-acquire');
    mergeLockAlarm.env = alarmEnv({
      send: async () => {
        throw new Error('queue send rejected (test)');
      },
    });
    await runInDurableObject(l.stub, async (obj: MergeLock, state) => {
      await state.storage.put('generation', 1);
      await state.storage.put('lease', { owner: 'dead', generation: 1, expiresAt: Date.now() - 1, repoId: 'r', ref: 'refs/heads/main' } satisfies Lease);
      for (let i = 0; i < 6; i++) {
        const kept = await state.storage.get<Lease>('lease');
        await state.storage.put('lease', { ...kept!, retryAt: Date.now() - 1 });
        await obj.alarm();
      }
      expect(await state.storage.get<Lease>('lease')).toMatchObject({ owner: 'dead', kickAttempts: 6 });
    });
    // The expired lease is not held: a publisher acquires it at once; its own run replaces the dead holder's kick.
    const next = await l.acquire('next', 30_000);
    expect(next.json).toMatchObject({ acquired: true, generation: 2 });
    const lease = await runInDurableObject(l.stub, async (_obj, state) => state.storage.get<Lease>('lease'));
    expect(lease).toMatchObject({ owner: 'next', generation: 2 });
    expect(lease!.kickAttempts).toBeUndefined();
    expect(lease!.retryAt).toBeUndefined();
    expect(await l.alarmAt()).toBe(next.json.expiresAt);
  });
});

describe('MergeLock settlement intents (one alarm slot shared with the lease)', () => {
  it('an intent write arms the alarm in the same transaction; release keeps it and a fresh acquire never clobbers it', async () => {
    SETTLE_INTENT.delayMs = 50_000;
    const l = lock('intent-coexist');
    const written = await l.intend();
    expect(written).toMatchObject({ status: 200, json: { armed: true } });
    const [intent] = await l.intents();
    expect(intent).toMatchObject({ repoId: 'repo-intent-coexist', changeSetId: 'change-1', mergedAt: 1_000, mergeCommit: 'a'.repeat(40), ref: 'refs/heads/main', attempts: 0 });
    expect(await l.alarmAt()).toBe(intent!.deadline);

    // A shorter lease takes the slot; its release hands it back to the intent instead of deleting it.
    const short = await l.acquire('short', 20_000);
    expect(await l.alarmAt()).toBe(short.json.expiresAt);
    expect((await l.release('short', short.json.generation)).status).toBe(200);
    expect(await l.alarmAt()).toBe(intent!.deadline);

    // A longer lease leaves the earlier intent deadline armed.
    const long = await l.acquire('long', 120_000);
    expect(long.json).toMatchObject({ acquired: true, generation: 2 });
    expect(await l.alarmAt()).toBe(intent!.deadline);
    expect((await l.release('long', 2)).status).toBe(200);
    expect(await l.alarmAt()).toBe(intent!.deadline);
    expect(await l.status()).toEqual({ lease: null, generation: 2 });

    // An early fire for the lease keeps both and re-arms the earliest.
    const live = await l.acquire('live', 10_000);
    expect(await runDurableObjectAlarm(l.stub)).toBe(true);
    expect((await l.status()).lease).toMatchObject({ owner: 'live', generation: 3 });
    expect(await l.alarmAt()).toBe(live.json.expiresAt);
    expect(await l.intents()).toHaveLength(1);
    expect((await l.release('live', 3)).status).toBe(200);

    // A landing nothing in D1 knows: the due intent settles nothing, is cleared, and with no lease the alarm is deleted.
    await l.fireDue();
    expect(await l.intents()).toEqual([]);
    expect(await l.alarmAt()).toBeNull();
  });

  it('release without lease or intent deletes the alarm; an invalid intent is refused', async () => {
    const l = lock('intent-none');
    const a = await l.acquire('a', 20_000);
    expect(await l.alarmAt()).toBe(a.json.expiresAt);
    await l.release('a', 1);
    expect(await l.alarmAt()).toBeNull();
    expect((await l.intend({ mergeCommit: 'nope' })).status).toBe(400);
    expect(await l.intents()).toEqual([]);
  });

  it('a failing settlement keeps its intent past any failure count with capped backoff, and is deleted only once a wakeup finds nothing fenced', async () => {
    SETTLE_INTENT.delayMs = 3_600_000;
    SETTLE_INTENT.retryBaseMs = 1_000;
    SETTLE_INTENT.retryMaxMs = 4_000;
    const l = lock('intent-persist');
    let reads = 0;
    let down = true;
    const outageDb = {
      prepare: () => ({ bind: () => ({}) }),
      batch: async () => {
        reads++;
        if (down) throw new Error('D1 unavailable (test)');
        // The outage ended: nothing fenced to this landing remains.
        return [{ results: [] }, { results: [] }, { results: [] }, { results: [{ held: 0, held_until: null, more: 0 }] }];
      },
    } as unknown as D1Database;
    mergeLockAlarm.env = alarmEnv({ db: outageDb });
    await l.intend();
    const failures = 12;
    for (let i = 1; i <= failures; i++) {
      const before = Date.now();
      await l.fireDue();
      const [kept] = await l.intents();
      // Never abandoned: the attempt count only grows the capped backoff.
      expect(kept).toMatchObject({ attempts: i, fires: i });
      const delay = kept!.deadline - before;
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(SETTLE_INTENT.retryMaxMs + 50);
      if (i >= 3) expect(delay).toBeGreaterThanOrEqual(SETTLE_INTENT.retryMaxMs - 50);
      expect(await l.alarmAt()).toBe(kept!.deadline);
    }
    expect(reads).toBe(failures);
    down = false;
    await l.fireDue();
    expect(await l.intents()).toEqual([]);
    expect(await l.alarmAt()).toBeNull();
    expect(reads).toBe(failures + 1);
  });

  it('an intent rewritten while its settlement ran keeps the new hand-off', async () => {
    SETTLE_INTENT.delayMs = 3_600_000;
    const l = lock('intent-rewrite');
    await l.intend();
    await runInDurableObject(l.stub, async (obj: MergeLock, state) => {
      const [key, intent] = [...(await state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX }))][0]!;
      await state.storage.put(key!, { ...intent!, deadline: Date.now() - 1 });
      // While the alarm's settlement awaits D1, a fresh hand-off rewrites the intent: the alarm must not drop it.
      mergeLockAlarm.env = alarmEnv({
        db: {
          prepare: () => ({ bind: () => ({}) }),
          batch: async () => {
            await state.storage.put(key!, { ...intent!, version: 'rewritten', attempts: 0, deadline: Date.now() + SETTLE_INTENT.delayMs });
            return [{ results: [] }, { results: [] }, { results: [] }];
          },
        } as unknown as D1Database,
      });
      await obj.alarm();
    });
    const [kept] = await l.intents();
    expect(kept).toMatchObject({ attempts: 0 });
    expect(kept!.deadline).toBeGreaterThan(Date.now() + 3_000_000);
    expect(await l.alarmAt()).toBe(kept!.deadline);
  });
});

describe('generation/owner-fenced claims', () => {
  const db = () => env.DB;

  it('a stale runner cannot report or release after the head moved; generation 2 completes', async () => {
    const subject = `check:${crypto.randomUUID()}`;
    const g1 = await claimFenced(db(), { kind: 'check', subject, owner: 'runner-1', identity: 'head-A', ttlMs: 60_000, now: 1_000 });
    expect(g1).toMatchObject({ ok: true, value: { generation: 1, owner: 'runner-1', state: 'claimed' } });

    // The change moves to a new head: earlier claims no longer apply.
    expect(await advanceFenced(db(), 'check', subject, 'head-B', 2_000)).toMatchObject({ generation: 2, state: 'open', owner: null });
    const g2 = await claimFenced(db(), { kind: 'check', subject, owner: 'runner-2', identity: 'head-B', ttlMs: 60_000, now: 2_500 });
    expect(g2).toMatchObject({ ok: true, value: { generation: 3, owner: 'runner-2' } });
    const gen2 = (g2 as { value: { generation: number } }).value.generation;

    const lateReport = await reportFenced(db(), { kind: 'check', subject, generation: 1, owner: 'runner-1', result: { state: 'success' }, now: 3_000 });
    expect(lateReport).toMatchObject({ ok: false, status: 409, code: 'STALE_GENERATION', current: { generation: gen2, owner: 'runner-2', state: 'claimed' } });
    const lateRelease = await releaseFenced(db(), { kind: 'check', subject, generation: 1, owner: 'runner-1', now: 3_000 });
    expect(lateRelease).toMatchObject({ ok: false, code: 'STALE_GENERATION' });
    expect(await readFenced(db(), 'check', subject)).toMatchObject({ generation: gen2, owner: 'runner-2', state: 'claimed', result: null });

    const done = await reportFenced(db(), { kind: 'check', subject, generation: gen2, owner: 'runner-2', identity: 'head-B', result: { state: 'failure' }, now: 4_000 });
    expect(done).toMatchObject({ ok: true, value: { state: 'done', result: { state: 'failure' } } });
  });

  it('expiry hands a stranded task to a new worker; the dead worker cannot report or release it', async () => {
    const subject = `task:${crypto.randomUUID()}`;
    const g1 = await claimFenced(db(), { kind: 'task', subject, owner: 'agent-1', identity: null, ttlMs: 1_000, now: 10_000 });
    expect(g1.ok).toBe(true);
    const tooEarly = await claimFenced(db(), { kind: 'task', subject, owner: 'agent-2', identity: null, ttlMs: 1_000, now: 10_500 });
    expect(tooEarly).toMatchObject({ ok: false, code: 'CLAIMED', retryAfterMs: 500 });

    const g2 = await claimFenced(db(), { kind: 'task', subject, owner: 'agent-2', identity: null, ttlMs: 1_000, now: 11_001 });
    expect(g2).toMatchObject({ ok: true, value: { generation: 2, owner: 'agent-2' } });

    expect(await reportFenced(db(), { kind: 'task', subject, generation: 1, owner: 'agent-1', result: 'late', now: 11_100 })).toMatchObject({ ok: false, code: 'STALE_GENERATION' });
    expect(await releaseFenced(db(), { kind: 'task', subject, generation: 1, owner: 'agent-1', now: 11_100 })).toMatchObject({ ok: false, code: 'STALE_GENERATION' });
    // The current generation with the wrong owner is refused too.
    expect(await reportFenced(db(), { kind: 'task', subject, generation: 2, owner: 'agent-1', result: 'spoof', now: 11_100 })).toMatchObject({ ok: false });
    expect(await readFenced(db(), 'task', subject)).toMatchObject({ generation: 2, owner: 'agent-2', state: 'claimed' });

    expect(await releaseFenced(db(), { kind: 'task', subject, generation: 2, owner: 'agent-2', now: 11_200 })).toMatchObject({ ok: true, value: { state: 'open' } });
    const g3 = await claimFenced(db(), { kind: 'task', subject, owner: 'agent-3', identity: null, ttlMs: 1_000, now: 11_300 });
    expect(g3).toMatchObject({ ok: true, value: { generation: 3 } });
    expect(await reportFenced(db(), { kind: 'task', subject, generation: 3, owner: 'agent-3', result: { ok: true }, now: 11_400 })).toMatchObject({ ok: true });
    expect(await claimFenced(db(), { kind: 'task', subject, owner: 'agent-4', identity: null, ttlMs: 1_000, now: 99_000 })).toMatchObject({ ok: false, code: 'CLAIM_DONE' });
  });
});
