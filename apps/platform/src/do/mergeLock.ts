/**
 * The publication lease of one repository + target ref (architecture §11.4).
 *
 * The integration train prepares and checks candidates outside any lease and
 * takes this lease only around the one-ref receive-pack update of a ready
 * candidate. Every acquire bumps a generation; release must name the
 * generation and owner it holds, so a stale holder can never free its
 * successor's lease. A lease expires on its own: the alarm clears it and
 * kicks the train, so a crashed publisher never blocks the partition.
 *
 *   POST /acquire {owner, ttlMs?, repoId?, ref?} → {acquired:true, generation, expiresAt}
 *                                                 | {acquired:false, holder:{owner, generation, expiresAt}, retryAfterMs}
 *   POST /release {owner, generation}            → 200 {released:true} | 409 {released:false, code:'STALE_GENERATION', current}
 *   GET  /status                                 → {lease, generation}
 */

import { kickTrain } from '../services/trainKick';

export interface Lease {
  owner: string;
  generation: number;
  expiresAt: number;
  repoId?: string;
  ref?: string;
}

export const LEASE_TTL = { defaultMs: 30_000, minMs: 1, maxMs: 120_000 };

const LEASE = 'lease';
const GENERATION = 'generation';

export class MergeLock implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private live(lease: Lease | undefined, now: number): Lease | null {
    return lease && lease.expiresAt > now ? lease : null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/status') {
      const now = Date.now();
      const lease = this.live(await this.state.storage.get<Lease>(LEASE), now);
      return Response.json({ lease, generation: (await this.state.storage.get<number>(GENERATION)) ?? 0 });
    }
    if (request.method !== 'POST') return new Response('not found', { status: 404 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (url.pathname === '/acquire') return this.acquire(body);
    if (url.pathname === '/release') return this.release(body);
    return new Response('not found', { status: 404 });
  }

  private async acquire(body: Record<string, unknown>): Promise<Response> {
    const owner = typeof body.owner === 'string' && body.owner.length > 0 ? body.owner : null;
    if (!owner) return Response.json({ error: 'owner is required', code: 'INVALID_OWNER' }, { status: 400 });
    const ttlRaw = typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : LEASE_TTL.defaultMs;
    const ttl = Math.min(LEASE_TTL.maxMs, Math.max(LEASE_TTL.minMs, Math.floor(ttlRaw)));
    const now = Date.now();
    const held = this.live(await this.state.storage.get<Lease>(LEASE), now);
    if (held) {
      return Response.json({
        acquired: false,
        holder: { owner: held.owner, generation: held.generation, expiresAt: held.expiresAt },
        retryAfterMs: held.expiresAt - now,
      });
    }
    const generation = ((await this.state.storage.get<number>(GENERATION)) ?? 0) + 1;
    const lease: Lease = { owner, generation, expiresAt: now + ttl };
    if (typeof body.repoId === 'string') lease.repoId = body.repoId;
    if (typeof body.ref === 'string') lease.ref = body.ref;
    await this.state.storage.put({ [LEASE]: lease, [GENERATION]: generation });
    await this.state.storage.setAlarm(lease.expiresAt);
    return Response.json({ acquired: true, generation, expiresAt: lease.expiresAt });
  }

  private async release(body: Record<string, unknown>): Promise<Response> {
    const lease = await this.state.storage.get<Lease>(LEASE);
    const current = lease ? { owner: lease.owner, generation: lease.generation, expiresAt: lease.expiresAt } : null;
    if (!lease || lease.generation !== body.generation || lease.owner !== body.owner) {
      return Response.json({ released: false, code: 'STALE_GENERATION', current }, { status: 409 });
    }
    await this.state.storage.delete(LEASE);
    await this.state.storage.deleteAlarm();
    return Response.json({ released: true, generation: lease.generation });
  }

  /** Expiry: the holder is presumed dead; clear it and wake the train so the partition makes progress. */
  async alarm(): Promise<void> {
    const lease = await this.state.storage.get<Lease>(LEASE);
    if (!lease) return;
    const now = Date.now();
    if (lease.expiresAt > now) {
      await this.state.storage.setAlarm(lease.expiresAt);
      return;
    }
    await this.state.storage.delete(LEASE);
    console.log(JSON.stringify({ mergeLockExpired: { owner: lease.owner, generation: lease.generation, repoId: lease.repoId, ref: lease.ref } }));
    if (lease.repoId && lease.ref) await kickTrain(this.env, lease.repoId, lease.ref, 'lease-expired');
  }
}
