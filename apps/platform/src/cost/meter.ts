/**
 * Per-request application work counters (architecture §10).
 *
 * Every request gets a fresh CostMeter. Bindings on `env` are replaced by
 * counting proxies, outbound `fetch` is counted through AsyncLocalStorage, and
 * response-level Cache API layers report hit/miss. The totals are emitted as
 *
 *   x-forge-cost: d1=..;rr=..;rw=..;art=..;do=..;r2a=..;r2b=..;q=..;sub=..;cache=hit|miss|none|bypass
 *
 * These are work counters, not a bill: CPU, duration, storage, payload sizes
 * and background (waitUntil) work after the response are not included.
 *
 * Counting rules:
 *  - d1: D1 round trips. One statement call (first/all/run/raw) or one
 *    batch() or exec() is 1; rr/rw sum `meta.rows_read`/`meta.rows_written`
 *    over every statement result (raw() and exec() expose no row meta).
 *  - art: Artifacts RPCs, on the namespace and on repo handles.
 *  - do: Durable Object stub calls (fetch or RPC methods).
 *  - r2a/r2b: R2 class A (put, list, multipart create/part/complete) and
 *    class B (get, head) operations. delete is free and not counted.
 *  - q: queue sends; sendBatch counts 1.
 *  - sub: outbound global fetch() subrequests.
 *  - cache: the first response-level cache lookup (page, info/refs, content
 *    caches), or `bypass` when an admin `?nocache=1` skipped it. Internal
 *    metadata caches (PAT, repo row, upstream token) do not set it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const COST_HEADER = 'x-forge-cost';

export type CacheState = 'hit' | 'miss' | 'none' | 'bypass';

export interface CostCounters {
  d1: number;
  rr: number;
  rw: number;
  art: number;
  do: number;
  r2a: number;
  r2b: number;
  q: number;
  sub: number;
  cache: CacheState;
}

type BindingKind = 'd1' | 'artifacts' | 'do' | 'r2' | 'queue';

/** Bindings that get counting proxies. New bindings must be added here. */
export const METERED_BINDINGS: Readonly<Record<string, BindingKind>> = {
  DB: 'd1',
  ARTIFACTS: 'artifacts',
  SNAPSHOTS: 'r2',
  EVENTS: 'queue',
  TOKENS: 'do',
  RATE_LIMIT: 'do',
  REALTIME: 'do',
  MERGE_LOCK: 'do',
};

interface D1Meta {
  rows_read?: number;
  rows_written?: number;
}

export class CostMeter {
  d1 = 0;
  rr = 0;
  rw = 0;
  art = 0;
  do = 0;
  r2a = 0;
  r2b = 0;
  q = 0;
  sub = 0;
  cache: CacheState = 'none';

  /** Records the outermost response-cache outcome; later lookups don't override it. */
  markCache(state: 'hit' | 'miss' | 'bypass'): void {
    if (this.cache === 'none') this.cache = state;
  }

  addRows(meta: D1Meta | undefined | null): void {
    if (!meta) return;
    this.rr += toCount(meta.rows_read);
    this.rw += toCount(meta.rows_written);
  }

  snapshot(): CostCounters {
    return {
      d1: this.d1,
      rr: this.rr,
      rw: this.rw,
      art: this.art,
      do: this.do,
      r2a: this.r2a,
      r2b: this.r2b,
      q: this.q,
      sub: this.sub,
      cache: this.cache,
    };
  }

  header(): string {
    const s = this.snapshot();
    return `d1=${s.d1};rr=${s.rr};rw=${s.rw};art=${s.art};do=${s.do};r2a=${s.r2a};r2b=${s.r2b};q=${s.q};sub=${s.sub};cache=${s.cache}`;
  }

  /** A per-request view of `env` whose metered bindings count into this meter. */
  wrapEnv<E extends object>(env: E): E {
    const wrapped = new Map<string, unknown>();
    return new Proxy(env, {
      get: (target, prop) => {
        const value: unknown = Reflect.get(target, prop);
        if (typeof prop !== 'string' || value === null) return value;
        if (typeof value !== 'object' && typeof value !== 'function') return value;
        const kind = METERED_BINDINGS[prop];
        if (!kind) return value;
        let proxy = wrapped.get(prop);
        if (!proxy) {
          proxy = wrapBinding(kind, value, this);
          wrapped.set(prop, proxy);
        }
        return proxy;
      },
    });
  }
}

function toCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Strict parser for the header grammar; returns null on any deviation. */
export function parseCostHeader(value: string | null | undefined): CostCounters | null {
  if (!value) return null;
  const m = value.match(
    /^d1=(\d+);rr=(\d+);rw=(\d+);art=(\d+);do=(\d+);r2a=(\d+);r2b=(\d+);q=(\d+);sub=(\d+);cache=(hit|miss|none|bypass)$/,
  );
  if (!m) return null;
  const n = (i: number) => Number(m[i]);
  return {
    d1: n(1),
    rr: n(2),
    rw: n(3),
    art: n(4),
    do: n(5),
    r2a: n(6),
    r2b: n(7),
    q: n(8),
    sub: n(9),
    cache: m[10] as CacheState,
  };
}

// ---------------------------------------------------------------------------
// Binding proxies
// ---------------------------------------------------------------------------

function wrapBinding(kind: BindingKind, binding: object, m: CostMeter): unknown {
  switch (kind) {
    case 'd1':
      return wrapD1(binding as D1Database, m);
    case 'artifacts':
      return wrapArtifacts(binding, m);
    case 'do':
      return wrapDurableObjectNamespace(binding, m);
    case 'r2':
      return wrapR2(binding, m);
    case 'queue':
      return wrapQueue(binding, m);
  }
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Proxies `target` so each method call runs `onCall(name)` first. Property
 * reads use the real target as receiver (native bindings reject foreign
 * receivers). `then` and symbols pass through uncounted so RPC stubs never
 * become thenables and disposal stays uncounted; symbol-keyed methods are
 * bound to the real target, because `stub[Symbol.dispose]()` called with
 * the proxy as receiver throws and leaves the stub undisposed.
 */
function countCalls<T extends object>(
  target: T,
  onCall: (name: string) => void,
  wrapResult?: (name: string, result: unknown) => unknown,
): T {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop);
      if (typeof prop === 'symbol') return typeof value === 'function' ? (value as AnyFn).bind(t) : value;
      if (prop === 'then' || typeof value !== 'function') return value;
      const fn = value as AnyFn;
      return (...args: unknown[]) => {
        onCall(prop);
        const result: unknown = Reflect.apply(fn, t, args);
        return wrapResult ? wrapResult(prop, result) : result;
      };
    },
  });
}

function isObjectLike(v: unknown): v is object {
  return v !== null && (typeof v === 'object' || typeof v === 'function');
}

/**
 * Workers RPC results are `RpcPromise` thenables (often callable proxies),
 * not `Promise` instances, so detect any thenable and wrap the resolved value.
 */
function mapAsync(result: unknown, map: (v: object) => unknown): unknown {
  if (isObjectLike(result) && typeof (result as { then?: unknown }).then === 'function') {
    return Promise.resolve(result).then((v: unknown) => (isObjectLike(v) ? map(v) : v));
  }
  return isObjectLike(result) ? map(result) : result;
}

function wrapArtifacts(ns: object, m: CostMeter): object {
  const countArt = () => {
    m.art++;
  };
  return countCalls(ns, countArt, (name, result) =>
    name === 'get' ? mapAsync(result, (handle) => countCalls(handle, countArt)) : result,
  );
}

function wrapDurableObjectNamespace(ns: object, m: CostMeter): object {
  const stub = (s: object) =>
    countCalls(s, () => {
      m.do++;
    });
  return new Proxy(ns, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop);
      if (typeof prop === 'symbol' || typeof value !== 'function') return value;
      const fn = value as AnyFn;
      if (prop === 'get' || prop === 'getByName') {
        return (...args: unknown[]) => mapAsync(Reflect.apply(fn, t, args), stub);
      }
      if (prop === 'jurisdiction') {
        return (...args: unknown[]) =>
          mapAsync(Reflect.apply(fn, t, args), (sub) => wrapDurableObjectNamespace(sub, m));
      }
      return (...args: unknown[]) => Reflect.apply(fn, t, args);
    },
  });
}

const R2_CLASS_A = new Set(['put', 'list', 'createMultipartUpload', 'uploadPart', 'complete']);
const R2_CLASS_B = new Set(['get', 'head']);

function wrapR2(bucket: object, m: CostMeter): object {
  const count = (name: string) => {
    if (R2_CLASS_A.has(name)) m.r2a++;
    else if (R2_CLASS_B.has(name)) m.r2b++;
  };
  const upload = (u: object) => countCalls(u, count);
  return countCalls(bucket, count, (name, result) =>
    name === 'createMultipartUpload' || name === 'resumeMultipartUpload' ? mapAsync(result, upload) : result,
  );
}

function wrapQueue(queue: object, m: CostMeter): object {
  return countCalls(queue, (name) => {
    if (name === 'send' || name === 'sendBatch') m.q++;
  });
}

class MeteredStatement {
  constructor(
    readonly inner: D1PreparedStatement,
    private readonly m: CostMeter,
  ) {}

  bind(...values: unknown[]): MeteredStatement {
    return new MeteredStatement(this.inner.bind(...values), this.m);
  }

  // first() hides D1 meta, so run the identical query through all() (first()
  // never adds a LIMIT) and pick the first row.
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    this.m.d1++;
    const res = await this.inner.all<Record<string, unknown>>();
    this.m.addRows(res.meta);
    const row = res.results?.[0];
    if (!row) return null;
    if (colName === undefined) return row as T;
    return (row[colName] ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.m.d1++;
    const res = await this.inner.all<T>();
    this.m.addRows(res.meta);
    return res;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.m.d1++;
    const res = await this.inner.run<T>();
    this.m.addRows(res.meta);
    return res;
  }

  raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    this.m.d1++;
    return this.inner.raw<T>(options as { columnNames: true }) as Promise<T[]>;
  }
}

function unwrapStatement(s: D1PreparedStatement): D1PreparedStatement {
  return s instanceof MeteredStatement ? s.inner : s;
}

interface D1Like {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

function wrapD1Like<T extends D1Like>(db: T, m: CostMeter): T {
  return new Proxy(db, {
    get(t, prop) {
      if (prop === 'prepare') {
        return (query: string) => new MeteredStatement(t.prepare(query), m) as unknown as D1PreparedStatement;
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          m.d1++;
          const results = await t.batch(statements.map(unwrapStatement));
          for (const r of results) m.addRows(r.meta);
          return results;
        };
      }
      if (prop === 'exec') {
        return (query: string) => {
          m.d1++;
          return (t as unknown as D1Database).exec(query);
        };
      }
      if (prop === 'withSession') {
        return (constraint?: string) =>
          wrapD1Like((t as unknown as D1Database).withSession(constraint as D1SessionConstraint), m);
      }
      const value: unknown = Reflect.get(t, prop);
      return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value as AnyFn, t, args) : value;
    },
  });
}

function wrapD1(db: D1Database, m: CostMeter): D1Database {
  return wrapD1Like(db, m);
}

// ---------------------------------------------------------------------------
// Request scope: outbound fetch + cache marks
// ---------------------------------------------------------------------------

const scope = new AsyncLocalStorage<CostMeter>();

export function currentMeter(): CostMeter | undefined {
  return scope.getStore();
}

export function runWithMeter<R>(meter: CostMeter, fn: () => R): R {
  return scope.run(meter, fn);
}

/** Marks the response-level cache outcome on the current request's meter. */
export function markCache(state: 'hit' | 'miss' | 'bypass'): void {
  scope.getStore()?.markCache(state);
}

/** Wraps a fetch implementation so calls count as subrequests on the active meter. */
export function countingFetch(inner: typeof fetch): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const meter = scope.getStore();
    if (meter) meter.sub++;
    return Reflect.apply(inner, globalThis, [input, init]) as Promise<Response>;
  }) as typeof fetch;
}

let fetchInstalled = false;

/** Installs the counting wrapper on global fetch once per isolate. */
export function installFetchMeter(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;
  globalThis.fetch = countingFetch(globalThis.fetch);
}

/** Sets the cost header, rebuilding the response when its headers are immutable. */
export function withCostHeader(res: Response, meter: CostMeter): Response {
  if (res.webSocket) return res;
  const value = meter.header();
  try {
    res.headers.set(COST_HEADER, value);
    return res;
  } catch {
    const out = new Response(res.body, res);
    out.headers.set(COST_HEADER, value);
    return out;
  }
}

/** Runs one request under a fresh meter and stamps the response with its counters. */
export async function serveMetered<E extends object>(
  request: Request,
  env: E,
  ctx: ExecutionContext,
  handler: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>,
): Promise<Response> {
  const meter = new CostMeter();
  const res = await runWithMeter(meter, () => handler(request, meter.wrapEnv(env), ctx));
  return withCostHeader(res, meter);
}
