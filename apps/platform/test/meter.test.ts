import { env as cfEnv, RpcStub, RpcTarget } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { LazyRepo, withRepo } from '../src/artifacts/repo';
import {
  CostMeter,
  CostSpan,
  countingFetch,
  withCostSpan,
  markCache,
  parseCostHeader,
  runWithMeter,
  withCostHeader,
  COST_HEADER,
} from '../src/cost/meter';

const env = cfEnv as unknown as Env;

interface FakeResult {
  results: Record<string, unknown>[];
  meta: { rows_read: number; rows_written: number };
}

/** Minimal D1 double: every statement returns the configured rows and meta. */
function fakeD1(result: FakeResult) {
  const batched: unknown[][] = [];
  class Stmt {
    constructor(readonly sql: string) {}
    bind() {
      return this;
    }
    async all() {
      return result;
    }
    async run() {
      return result;
    }
    async raw() {
      return result.results.map((r) => Object.values(r));
    }
    async first() {
      throw new Error('metered first() must go through all() to read meta');
    }
  }
  const db = {
    prepare: (sql: string) => new Stmt(sql),
    batch: async (stmts: unknown[]) => {
      batched.push(stmts);
      for (const s of stmts) if (!(s instanceof Stmt)) throw new Error('batch received a wrapped statement');
      return stmts.map(() => result);
    },
    exec: async () => ({ count: 1, duration: 0 }),
  };
  return { db, batched, Stmt };
}

function metered<T extends object>(bindings: T): { m: CostMeter; e: T } {
  const m = new CostMeter();
  return { m, e: m.wrapEnv(bindings) };
}

describe('CostMeter D1 counting', () => {
  const rows = { results: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], meta: { rows_read: 7, rows_written: 2 } };

  it('counts one round trip per statement call and sums meta rows', async () => {
    const { db } = fakeD1(rows);
    const { m, e } = metered({ DB: db as unknown as D1Database });
    expect(await e.DB.prepare('SELECT 1').bind(1).first()).toEqual({ id: 'a', n: 1 });
    expect(await e.DB.prepare('SELECT 1').first('n')).toBe(1);
    await e.DB.prepare('SELECT 1').all();
    await e.DB.prepare('UPDATE x').run();
    expect(m.snapshot()).toMatchObject({ d1: 4, rr: 28, rw: 8 });
  });

  it('counts a batch as one round trip and sums every statement result', async () => {
    const { db, batched } = fakeD1(rows);
    const { m, e } = metered({ DB: db as unknown as D1Database });
    const stmts = [e.DB.prepare('A'), e.DB.prepare('B').bind(1), e.DB.prepare('C')];
    const res = await e.DB.batch(stmts);
    expect(res).toHaveLength(3);
    expect(batched).toHaveLength(1);
    expect(m.snapshot()).toMatchObject({ d1: 1, rr: 21, rw: 6 });
  });

  it('counts exec and raw round trips (no row meta exposed)', async () => {
    const { db } = fakeD1(rows);
    const { m, e } = metered({ DB: db as unknown as D1Database });
    await e.DB.exec('PRAGMA x');
    await e.DB.prepare('SELECT 1').raw();
    expect(m.snapshot()).toMatchObject({ d1: 2, rr: 0, rw: 0 });
  });

  it('matches real D1 meta for writes, reads and batches', async () => {
    const { m, e } = metered({ DB: env.DB });
    const keys = ['meter-a', 'meter-b', 'meter-c'];
    await e.DB.batch(keys.map((k) => e.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(k, 'v')));
    expect(m.d1).toBe(1);
    expect(m.rw).toBeGreaterThanOrEqual(3);
    const before = m.rr;
    const all = await e.DB.prepare("SELECT * FROM settings WHERE key LIKE 'meter-%'").all();
    expect(all.results).toHaveLength(3);
    expect(m.d1).toBe(2);
    expect(m.rr - before).toBe(all.meta.rows_read);
    expect(m.rr - before).toBeGreaterThanOrEqual(3);
    const row = await e.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('meter-b').first<{ value: string }>();
    expect(row?.value).toBe('v');
    expect(await e.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('nope').first()).toBeNull();
    expect(m.d1).toBe(4);
  });
});

describe('CostMeter binding proxies', () => {
  it('counts Artifacts namespace and repo-handle RPCs, not disposal', async () => {
    let disposed = false;
    const handle = {
      readTree: async () => [],
      log: async () => [{ hash: 'x' }],
      [Symbol.dispose]: () => {
        disposed = true;
      },
    };
    const ns = { get: async () => handle, create: async () => ({ remote: 'r' }) };
    const { m, e } = metered({ ARTIFACTS: ns as unknown as Artifacts });
    const repo = await e.ARTIFACTS.get('r');
    await repo.readTree('t');
    await repo.log({ ref: 'main' });
    repo[Symbol.dispose]();
    await e.ARTIFACTS.create('n');
    expect(disposed).toBe(true);
    expect(m.art).toBe(4);
  });

  it('disposes a repo handle whose disposer requires the real handle as receiver, uncounted', async () => {
    let disposed = 0;
    const handle = {
      readTree: async () => [],
      [Symbol.dispose](this: unknown) {
        if (this !== handle) throw new TypeError('Illegal invocation');
        disposed++;
      },
    };
    const ns = { get: async () => handle };
    const { m, e } = metered({ ARTIFACTS: ns as unknown as Artifacts });
    const repo = await e.ARTIFACTS.get('r');
    repo[Symbol.dispose]();
    expect(disposed).toBe(1);
    await withRepo(e as unknown as Env, 'r', (h) => h.readTree('t'));
    expect(disposed).toBe(2);
    const lazy = new LazyRepo(e as unknown as Env, 'r');
    await (await lazy.get()).readTree('t');
    await lazy.dispose();
    expect(disposed).toBe(3);
    expect(m.art).toBe(5);
  });

  it('withRepo disposes a real RPC stub through the metered binding', async () => {
    let disposed = false;
    class Handle extends RpcTarget {
      readTree() {
        return [];
      }
      [Symbol.dispose]() {
        disposed = true;
      }
    }
    const ns = { get: async () => new RpcStub(new Handle()) };
    const { m, e } = metered({ ARTIFACTS: ns as unknown as Artifacts });
    await withRepo(e as unknown as Env, 'r', (h) => h.readTree('t'));
    await vi.waitFor(() => expect(disposed).toBe(true), { timeout: 1000 });
    expect(m.art).toBe(2);
  });

  it('counts repo-handle RPCs when the namespace returns a non-Promise thenable (Workers RPC)', async () => {
    const handle = { readTree: async () => [], createToken: async () => ({ plaintext: 't' }) };
    // A non-Promise thenable is exactly what Workers RPC returns, so it is the fixture.
    // oxlint-disable-next-line unicorn/no-thenable
    const rpcPromise = { then: (resolve: (v: unknown) => unknown) => resolve(handle) };
    const ns = { get: () => rpcPromise };
    const { m, e } = metered({ ARTIFACTS: ns as unknown as Artifacts });
    const repo = await e.ARTIFACTS.get('r');
    await repo.createToken('read', 60);
    await repo.readTree('t');
    expect(m.art).toBe(3);
  });

  it('counts Durable Object stub fetch and RPC calls but not id derivation', async () => {
    const stub = { id: { name: 'x' }, fetch: async () => new Response('ok'), check: async () => true };
    const ns = { idFromName: () => ({}), get: () => stub, getByName: () => stub };
    const { m, e } = metered({ TOKENS: ns as unknown as DurableObjectNamespace });
    const s = e.TOKENS.get(e.TOKENS.idFromName('k'));
    expect(s.id).toEqual({ name: 'x' });
    await s.fetch('https://do/x');
    await (e.TOKENS.getByName('k') as unknown as typeof stub).check();
    expect(m.do).toBe(2);
  });

  it('splits R2 operations into class A and class B', async () => {
    const upload = { uploadPart: async () => ({}), complete: async () => ({}), abort: async () => undefined };
    const bucket = {
      put: async () => ({}),
      list: async () => ({ objects: [] }),
      get: async () => null,
      head: async () => null,
      delete: async () => undefined,
      createMultipartUpload: async () => upload,
    };
    const { m, e } = metered({ SNAPSHOTS: bucket as unknown as R2Bucket });
    await e.SNAPSHOTS.put('k', 'v');
    await e.SNAPSHOTS.list();
    await e.SNAPSHOTS.get('k');
    await e.SNAPSHOTS.head('k');
    await e.SNAPSHOTS.delete('k');
    const mp = await e.SNAPSHOTS.createMultipartUpload('k');
    await mp.uploadPart(1, 'x');
    await mp.complete([]);
    await mp.abort();
    expect(m.snapshot()).toMatchObject({ r2a: 5, r2b: 2 });
  });

  it('counts a queue sendBatch as one send', async () => {
    const queue = { send: async () => undefined, sendBatch: async () => undefined };
    const { m, e } = metered({ EVENTS: queue as unknown as Queue });
    await e.EVENTS.send({ a: 1 });
    await e.EVENTS.sendBatch([{ body: 1 }, { body: 2 }, { body: 3 }]);
    expect(m.q).toBe(2);
  });

  it('leaves unmetered bindings untouched and reuses metered proxies', () => {
    const vars = { SITE_NAME: 'Kvarm', DB: env.DB };
    const { e } = metered(vars);
    expect(e.SITE_NAME).toBe('Kvarm');
    expect(e.DB).toBe(e.DB);
    expect(e.DB).not.toBe(env.DB);
  });
});

describe('request scope', () => {
  it('counts outbound fetches only inside a metered request', async () => {
    const inner = (async () => new Response('x')) as unknown as typeof fetch;
    const counted = countingFetch(inner);
    const m = new CostMeter();
    await runWithMeter(m, async () => {
      await counted('https://example.invalid/a');
      await counted('https://example.invalid/b');
    });
    await counted('https://example.invalid/outside');
    expect(m.sub).toBe(2);
  });

  it('a cost span counts the work of its own async context, not concurrent work on the same meter', async () => {
    const { db } = fakeD1({ results: [], meta: { rows_read: 5, rows_written: 1 } });
    const { m, e } = metered({ DB: db as unknown as D1Database });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const earlier = new CostSpan();
    let background!: Promise<unknown>;
    await withCostSpan(earlier, async () => {
      await e.DB.prepare('SELECT 1').all();
      // Left running after the earlier operation returned, like a deferred wake in waitUntil.
      background = gate.then(() => e.DB.batch([e.DB.prepare('UPDATE x')]));
    });
    const later = new CostSpan();
    await withCostSpan(later, async () => {
      await e.DB.prepare('SELECT 2').run();
      release();
      await background;
      await withCostSpan(new CostSpan(), () => e.DB.prepare('SELECT 3').all());
    });
    expect(m.snapshot()).toMatchObject({ d1: 4, rr: 20, rw: 4 });
    expect(later.snapshot()).toMatchObject({ d1: 2, rr: 10, rw: 2 });
    expect(earlier.snapshot()).toMatchObject({ d1: 2, rr: 10, rw: 2 });
  });

  it('keeps the first response-cache outcome', () => {
    const m = new CostMeter();
    runWithMeter(m, () => {
      markCache('miss');
      markCache('hit');
    });
    expect(m.cache).toBe('miss');
  });
});

describe('x-kvarm-cost header', () => {
  it('serializes every counter in the pinned grammar', () => {
    const m = new CostMeter();
    m.d1 = 2;
    m.rr = 5;
    m.markCache('hit');
    const header = m.header();
    expect(header).toBe('d1=2;rr=5;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=hit');
    expect(parseCostHeader(header)).toEqual(m.snapshot());
  });

  it('rejects missing, extra, reordered or non-integer fields', () => {
    for (const bad of [
      'd1=0;rr=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0',
      'd1=0;rr=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=none;x=1',
      'rr=0;d1=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=none',
      'd1=-1;rr=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=none',
      'd1=0;rr=0;rw=0;art=0;do=0;r2a=0;r2b=0;q=0;sub=0;cache=stale',
    ]) {
      expect(parseCostHeader(bad), bad).toBeNull();
    }
  });

  it('accepts the admin nocache bypass state', () => {
    const m = new CostMeter();
    m.markCache('bypass');
    m.markCache('hit');
    expect(m.header()).toMatch(/;cache=bypass$/);
    expect(parseCostHeader(m.header())?.cache).toBe('bypass');
  });

  it('stamps responses whose headers are immutable', () => {
    const m = new CostMeter();
    const immutable = Response.redirect('https://kvarm.test/x', 302);
    const out = withCostHeader(immutable, m);
    expect(out.status).toBe(302);
    expect(out.headers.get(COST_HEADER)).toBe(m.header());
  });
});
