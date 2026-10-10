/**
 * The publication lease of one repository + target ref (architecture §11.4),
 * and the durable owner of dependency settlements that landed on that ref
 * (architecture §11.3).
 *
 * The integration train prepares and checks candidates outside any lease and
 * takes this lease only around the one-ref receive-pack update of a ready
 * candidate. Every acquire bumps a generation; release must name the
 * generation and owner it holds, so a stale holder can never free its
 * successor's lease. A lease expires on its own: the alarm kicks the train
 * and only then clears the lease, so a crashed publisher never blocks the
 * partition.
 *
 * A landing whose pin settlement does not fit one invocation writes a
 * settlement intent here (besides its queue continuation). The alarm runs
 * the settlement for a due intent, bounded per wakeup, and keeps the intent
 * until nothing fenced to its landing remains. The one alarm slot is shared:
 * every write that touches it targets the earliest of the lease expiry and
 * the pending intent deadlines, issued in the same storage transaction as
 * the state it arms for (no await in between).
 *
 *   POST /acquire {owner, ttlMs?, repoId?, ref?}  → {acquired:true, generation, expiresAt}
 *                                                  | {acquired:false, holder:{owner, generation, expiresAt}, retryAfterMs}
 *   POST /release {owner, generation}             → 200 {released:true} | 409 {released:false, code:'STALE_GENERATION', current}
 *   POST /settle-intent {repoId, changeSetId, mergedAt, mergeCommit, ref} → 200 {armed:true, deadline}
 *   GET  /status                                  → {lease, generation}
 */

import { CostMeter, runWithMeter } from '../cost/meter';
import { SETTLE_INTENT, SETTLE_MESSAGE, type SettleContinuationResult, type SettleMessage } from '../services/dependencyGate';
import { continueDependencySettlement } from '../services/dependencies';
import { kickTrain } from '../services/trainKick';

export interface Lease {
  owner: string;
  generation: number;
  expiresAt: number;
  repoId?: string;
  ref?: string;
  /** Failed expiry kicks so far (the backoff exponent); the expired lease stays until its kick succeeds or a new acquire replaces it. */
  kickAttempts?: number;
  /** When the alarm retries a failed expiry kick. */
  retryAt?: number;
}

export interface SettleIntent {
  repoId: string;
  changeSetId: string;
  mergedAt: number;
  mergeCommit: string;
  ref: string;
  /** When the alarm runs this settlement next. */
  deadline: number;
  /** Consecutive wakeups that failed or made no progress: the backoff exponent (logged), never a reason to drop the intent. */
  attempts: number;
  /** Wakeups that ran this settlement (logged). */
  fires: number;
  /** Changes on every write, so an alarm never overwrites a hand-off that arrived while it ran. */
  version: string;
}

export const LEASE_TTL = { defaultMs: 30_000, minMs: 1, maxMs: 120_000 };
export const LEASE_KICK = { retryMs: 5_000, retryMaxMs: 300_000 };

/** `base` × 2^(attempt − 1), capped at `max`. */
export function cappedBackoff(base: number, max: number, attempt: number): number {
  return Math.min(max, base * 2 ** Math.min(30, Math.max(0, attempt - 1)));
}

const LEASE = 'lease';
const GENERATION = 'generation';
/** Storage keys of settlement intents: INTENT_PREFIX + `${changeSetId}:${mergedAt}:${mergeCommit}`. */
export const INTENT_PREFIX = 'settle-intent:';
/** Intents read per alarm computation; more than this many concurrent exceptional landings on one ref still drain, the extra ones later. */
const INTENT_LIST_MAX = 256;

/** The environment the alarm's external effects run against (tests substitute their fakes). */
export const mergeLockAlarm = { env: (env: Env): Env => env };

const SHA_RE = /^[0-9a-f]{40}$/;

/** The alarm time for this state: the earliest of the lease's expiry (or expiry-kick retry) and the intent deadlines. */
export function alarmTarget(lease: Lease | undefined, intents: Iterable<SettleIntent>): number | null {
  let t = Number.POSITIVE_INFINITY;
  if (lease) t = lease.retryAt ?? lease.expiresAt;
  for (const i of intents) t = Math.min(t, i.deadline);
  return Number.isFinite(t) ? t : null;
}

export class MergeLock implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  private live(lease: Lease | undefined, now: number): Lease | null {
    return lease && lease.expiresAt > now ? lease : null;
  }

  private async read(): Promise<{ lease: Lease | undefined; intents: Map<string, SettleIntent> }> {
    const [lease, intents] = await Promise.all([
      this.state.storage.get<Lease>(LEASE),
      this.state.storage.list<SettleIntent>({ prefix: INTENT_PREFIX, limit: INTENT_LIST_MAX }),
    ]);
    return { lease, intents };
  }

  /** The alarm write for `target`; callers issue it with the state change it arms for, with no await in between. */
  private arm(target: number | null): Promise<void> {
    return target === null ? this.state.storage.deleteAlarm() : this.state.storage.setAlarm(target);
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
    if (url.pathname === '/settle-intent') return this.intend(body);
    return new Response('not found', { status: 404 });
  }

  private async acquire(body: Record<string, unknown>): Promise<Response> {
    const owner = typeof body.owner === 'string' && body.owner.length > 0 ? body.owner : null;
    if (!owner) return Response.json({ error: 'owner is required', code: 'INVALID_OWNER' }, { status: 400 });
    const ttlRaw = typeof body.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : LEASE_TTL.defaultMs;
    const ttl = Math.min(LEASE_TTL.maxMs, Math.max(LEASE_TTL.minMs, Math.floor(ttlRaw)));
    const now = Date.now();
    const { lease: stored, intents } = await this.read();
    const held = this.live(stored, now);
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
    await Promise.all([this.state.storage.put({ [LEASE]: lease, [GENERATION]: generation }), this.arm(alarmTarget(lease, intents.values()))]);
    return Response.json({ acquired: true, generation, expiresAt: lease.expiresAt });
  }

  private async release(body: Record<string, unknown>): Promise<Response> {
    const { lease, intents } = await this.read();
    const current = lease ? { owner: lease.owner, generation: lease.generation, expiresAt: lease.expiresAt } : null;
    if (!lease || lease.generation !== body.generation || lease.owner !== body.owner) {
      return Response.json({ released: false, code: 'STALE_GENERATION', current }, { status: 409 });
    }
    // A pending settlement keeps the alarm; it is deleted only when neither a lease nor an intent remains.
    await Promise.all([this.state.storage.delete(LEASE), this.arm(alarmTarget(undefined, intents.values()))]);
    return Response.json({ released: true, generation: lease.generation });
  }

  /** Records (or refreshes) a landing's settlement intent and arms the alarm for it in one storage transaction. */
  private async intend(body: Record<string, unknown>): Promise<Response> {
    const { repoId, changeSetId, mergedAt, mergeCommit, ref } = body;
    if (
      typeof repoId !== 'string' ||
      typeof changeSetId !== 'string' ||
      typeof mergedAt !== 'number' ||
      !Number.isSafeInteger(mergedAt) ||
      typeof mergeCommit !== 'string' ||
      !SHA_RE.test(mergeCommit) ||
      typeof ref !== 'string' ||
      ref.length === 0
    ) {
      return Response.json({ error: 'a settlement intent names repoId, changeSetId, mergedAt, mergeCommit and ref', code: 'INVALID_INTENT' }, { status: 400 });
    }
    const key = `${INTENT_PREFIX}${changeSetId}:${mergedAt}:${mergeCommit}`;
    const { lease, intents } = await this.read();
    const intent: SettleIntent = {
      repoId,
      changeSetId,
      mergedAt,
      mergeCommit,
      ref,
      deadline: Date.now() + SETTLE_INTENT.delayMs,
      attempts: 0,
      fires: intents.get(key)?.fires ?? 0,
      version: crypto.randomUUID(),
    };
    intents.set(key, intent);
    await Promise.all([this.state.storage.put(key, intent), this.arm(alarmTarget(lease, intents.values()))]);
    return Response.json({ armed: true, deadline: intent.deadline });
  }

  /**
   * One wakeup: an expired lease's train kick (the lease is cleared only
   * after it), then at most one due settlement intent, then the alarm is
   * re-armed from what storage holds now (or deleted when nothing does).
   * Storage is re-read after every external await. Each step catches its
   * own failures: recovery never depends on the platform's alarm retries.
   */
  async alarm(): Promise<void> {
    try {
      await this.expireLease();
    } catch (err) {
      console.warn(JSON.stringify({ mergeLockAlarmFailed: { step: 'lease', error: String(err).slice(0, 200) } }));
    }
    try {
      await this.settleDue();
    } catch (err) {
      console.warn(JSON.stringify({ mergeLockAlarmFailed: { step: 'settle', error: String(err).slice(0, 200) } }));
    }
    const { lease, intents } = await this.read();
    await this.arm(alarmTarget(lease, intents.values()));
  }

  /**
   * An expired lease is kept until its train kick succeeded: a failed kick
   * re-arms with capped exponential backoff, however often it failed. A new
   * acquire (the lease is not held once expired) replaces it, and the
   * generation re-read below then leaves the successor alone.
   */
  private async expireLease(): Promise<void> {
    const lease = await this.state.storage.get<Lease>(LEASE);
    const now = Date.now();
    if (!lease || lease.expiresAt > now || (lease.retryAt ?? 0) > now) return;
    let kicked = true;
    let error: string | undefined;
    if (lease.repoId && lease.ref) {
      try {
        await kickTrain(mergeLockAlarm.env(this.env), lease.repoId, lease.ref, 'lease-expired');
      } catch (err) {
        kicked = false;
        error = String(err).slice(0, 200);
      }
    }
    const current = await this.state.storage.get<Lease>(LEASE);
    if (!current || current.generation !== lease.generation || current.owner !== lease.owner) return;
    const log = { owner: lease.owner, generation: lease.generation, repoId: lease.repoId, ref: lease.ref, kicked, ...(error ? { error } : {}) };
    if (kicked) {
      await this.state.storage.delete(LEASE);
      console.log(JSON.stringify({ mergeLockExpired: log }));
      return;
    }
    const attempts = (current.kickAttempts ?? 0) + 1;
    await this.state.storage.put(LEASE, { ...current, kickAttempts: attempts, retryAt: Date.now() + cappedBackoff(LEASE_KICK.retryMs, LEASE_KICK.retryMaxMs, attempts) });
    console.warn(JSON.stringify({ mergeLockExpiryKickFailed: { ...log, attempts } }));
  }

  private async settleDue(): Promise<void> {
    const now = Date.now();
    const { intents } = await this.read();
    let due: [string, SettleIntent] | null = null;
    for (const entry of intents) if (entry[1].deadline <= now && (!due || entry[1].deadline < due[1].deadline)) due = entry;
    if (!due) return;
    const [key, intent] = due;
    const msg: SettleMessage = {
      type: SETTLE_MESSAGE,
      repoId: intent.repoId,
      changeSetId: intent.changeSetId,
      mergedAt: intent.mergedAt,
      mergeCommit: intent.mergeCommit,
      ref: intent.ref,
    };
    const meter = new CostMeter();
    let result: SettleContinuationResult | null = null;
    let error: string | undefined;
    try {
      const env = meter.wrapEnv(mergeLockAlarm.env(this.env));
      result = await runWithMeter(meter, () => continueDependencySettlement(env, msg, undefined, 'alarm'));
    } catch (err) {
      error = String(err).slice(0, 200);
    }

    const current = await this.state.storage.get<SettleIntent>(key);
    const t = Date.now();
    // Marks another owner holds are neither work nor failure: revisit them when that claim expires, if not sooner.
    const revisit = (deadline: number) => (result?.heldUntil ? Math.min(deadline, Math.max(t, result.heldUntil)) : deadline);
    let outcome: 'done' | 'continue' | 'held' | 'retry' | 'superseded';
    if (!current || current.version !== intent.version) {
      // A hand-off rewrote (or a run cleared) the intent while this one ran: its own deadline stands.
      outcome = 'superseded';
    } else if (result && !result.remaining) {
      // The only way an intent ends: nothing fenced to its landing remains (no unsettled pin, no mark, no failed effect).
      outcome = 'done';
      await this.state.storage.delete(key);
    } else if (result && !result.failed && (result.settled > 0 || result.cleared > 0)) {
      outcome = 'continue';
      await this.state.storage.put(key, { ...current, deadline: revisit(t + SETTLE_INTENT.stepMs), attempts: 0, fires: current.fires + 1 });
    } else if (result && !result.failed && result.held > 0) {
      outcome = 'held';
      await this.state.storage.put(key, { ...current, deadline: revisit(t + SETTLE_INTENT.retryMaxMs), fires: current.fires + 1 });
    } else {
      // A failure or a wakeup without progress: retried with capped backoff for as long as fenced work remains.
      outcome = 'retry';
      const attempts = current.attempts + 1;
      const backoff = cappedBackoff(SETTLE_INTENT.retryBaseMs, SETTLE_INTENT.retryMaxMs, attempts);
      await this.state.storage.put(key, { ...current, deadline: revisit(t + backoff), attempts, fires: current.fires + 1 });
    }
    console.log(
      JSON.stringify({
        cost: meter.snapshot(),
        mergeLock: 'dependency-settle',
        repo: intent.repoId,
        change: intent.changeSetId,
        mergeCommit: intent.mergeCommit,
        fire: intent.fires + 1,
        outcome,
        ...(result ? { settle: result } : {}),
        ...(error ? { error } : {}),
      }),
    );
  }
}
