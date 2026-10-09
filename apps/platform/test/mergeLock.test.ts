/**
 * Publication lease (do/mergeLock.ts) and generation/owner-fenced claims
 * (services/fencing.ts): a stale holder's late report or release never
 * overwrites or frees its successor, and expiry restores progress.
 * Deterministic clocks for claims; the real Durable Object (with its alarm
 * run directly) for the lease.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Lease } from '../src/do/mergeLock';
import { advanceFenced, claimFenced, readFenced, releaseFenced, reportFenced } from '../src/services/fencing';

const env = cfEnv as unknown as Env;

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
  };
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
