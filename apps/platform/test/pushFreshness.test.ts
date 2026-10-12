/**
 * Push freshness at the git gate.
 *
 * Only a protocol-confirmed receive-pack report (complete, `unpack ok`, at
 * least one `ok <ref>`) moves the repo's view generation: the colo ref
 * generation is bumped and `pushed_at` advances before the final bytes of the
 * reply reach the client. Anonymous tree pages and info/refs advertisements
 * for mutable refs are keyed by that generation, so the first read after
 * `git push` returns misses the old entry. Rejected, failed or truncated
 * reports change nothing.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReportStatus, pktLine } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { refGeneration } from '../src/cache/compare';
import { pageCacheKey } from '../src/cache/edge';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import type { RepoRow } from '../src/db/repos';
import { infoRefsCacheKey } from '../src/routes/git';
import { relayReceivePackReply, repoViewGeneration } from '../src/services/pushFreshness';
import worker from '../src/index';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'pf-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Current head mark per Artifacts repo name; a confirmed upstream push moves it. */
const heads = new Map<string, number>();
/** The receive-pack reply the fake upstream sends, per Artifacts repo name. */
const reports = new Map<string, { body: Uint8Array; moves: boolean }>();
const originalFetch = globalThis.fetch;
let token = '';

function nameOf(repo: string): string {
  return `${OWNER}--${repo}`;
}

function remoteOf(repo: string): string {
  return `https://artifacts.invalid/git/default/${nameOf(repo)}.git`;
}

function mark(artifactsName: string): string {
  return `MARK-${artifactsName}-${heads.get(artifactsName) ?? 0}`;
}

function hex(n: number, ch: string): string {
  return n.toString(16).padStart(8, '0') + ch.repeat(32);
}

function handle(name: string): ArtifactsRepo {
  return {
    async log() {
      const n = heads.get(name) ?? 0;
      const who = { name: 'pf', email: 'pf@forge.invalid' };
      return [
        { hash: hex(n, 'a'), treeHash: hex(n, 'b'), message: 'm', author: who, committer: who, parents: [], authoredAt: 0, committedAt: 0 },
      ];
    },
    async readTree() {
      return [{ name: `${mark(name)}.txt`, mode: '100644', hash: 'c'.repeat(40), type: 'blob' }];
    },
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

/**
 * Local D1 writes finish before a relayed body drains, so the pushed_at write
 * is slowed down: a reply that ends without awaiting it becomes observable.
 */
const SLOW_PUSHED_AT_MS = 150;

function slowPushedAt(db: D1Database): D1Database {
  return new Proxy(db, {
    get(t, prop) {
      if (prop === 'prepare') {
        return (query: string) => {
          const stmt = t.prepare(query);
          if (!query.includes('SET pushed_at')) return stmt;
          return {
            bind: (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return {
                run: async () => {
                  await new Promise((r) => setTimeout(r, SLOW_PUSHED_AT_MS));
                  return bound.run();
                },
              };
            },
          } as unknown as D1PreparedStatement;
        };
      }
      const value: unknown = Reflect.get(t, prop);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}

const env = {
  ...baseEnv,
  DB: slowPushedAt(baseEnv.DB),
  ARTIFACTS: { get: async (name: string) => handle(name) } as unknown as Artifacts,
} as Env;

interface Sent {
  status: number;
  bytes: Uint8Array;
  text: string;
  cost: CostCounters;
  /** Resolves once every waitUntil task of the request has settled. */
  settled: Promise<void>;
}

/** Reads the full response body but does not wait for background tasks. */
async function send(path: string, init: RequestInit = {}): Promise<Sent> {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, init);
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  return { status: res.status, bytes, text: dec.decode(bytes), cost: cost!, settled: waitOnExecutionContext(ctx) };
}

async function get(path: string): Promise<Sent> {
  const r = await send(path);
  await r.settled;
  return r;
}

function basic(): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

function push(repo: string): Promise<Sent> {
  return send(`/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { ...basic(), 'content-type': 'application/x-git-receive-pack-request' },
    body: enc.encode('0000PACK-not-inspected-by-the-fake'),
  });
}

async function repoRow(repo: string): Promise<RepoRow> {
  const row = await env.DB.prepare('SELECT * FROM repos WHERE owner_login = ? AND name = ?').bind(OWNER, repo).first<RepoRow>();
  return row!;
}

async function seedRepo(repo: string, report: Uint8Array, moves: boolean): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at) VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, repo, nameOf(repo), remoteOf(repo), Date.now())
    .run();
  heads.set(nameOf(repo), 1);
  reports.set(nameOf(repo), { body: report, moves });
  for (const scope of ['read', 'write'] as const) {
    await writeCachedJson(internalKey('gittoken', nameOf(repo), scope), { token: 'fake', expiresAt: Date.now() + 86_400_000 }, 86_400);
  }
}

function cat(...parts: (Uint8Array | string)[]): Uint8Array {
  const bufs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function band(n: 1 | 2 | 3, payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === 'string' ? enc.encode(payload) : payload;
  return pktLine(cat(new Uint8Array([n]), bytes));
}

/** Streams the reply in small pieces with pauses, like a real upstream. */
function trickle(body: Uint8Array): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (off >= body.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 2));
      controller.enqueue(body.slice(off, off + 7));
      off += 7;
    },
  });
}

const OK_MAIN = { ref: 'refs/heads/main', ok: true };
const okSideband = buildReportStatus([OK_MAIN], 'side-band-64k');
const okPlain = buildReportStatus([OK_MAIN], 'none');

/** Repo name -> the receive-pack reply its fake upstream returns. */
const SCENARIOS: Record<string, { body: Uint8Array; label: string }> = {
  'rejected': {
    label: 'ng non-fast-forward',
    body: buildReportStatus([{ ref: 'refs/heads/main', ok: false, reason: 'non-fast-forward' }], 'side-band-64k'),
  },
  'unpack-failed': {
    label: 'unpack failure',
    body: cat(pktLine('unpack index-pack abnormal exit\n'), pktLine('ng refs/heads/main unpacker error\n'), '0000'),
  },
  'fatal': {
    label: 'band-3 fatal',
    body: cat(band(3, 'fatal: the remote end hung up\n'), band(1, okPlain), '0000'),
  },
  'truncated': {
    label: 'truncated report',
    body: okPlain.subarray(0, okPlain.length - 4),
  },
  'no-outer-flush': {
    label: 'side-band reply missing its outer flush',
    body: okSideband.subarray(0, okSideband.length - 4),
  },
  'partial-outer': {
    label: 'side-band reply ending inside a subsequent outer packet',
    body: cat(okSideband.subarray(0, okSideband.length - 4), band(2, 'remote: done\n').subarray(0, 9)),
  },
};

beforeAll(async () => {
  const userId = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(userId, `test:${OWNER}`, OWNER, `${OWNER}@forge.invalid`, OWNER, Date.now())
    .run();
  token = (await mintPAT(env, userId, 'pf-owner', FULL)).token;
  await seedRepo('fresh', okSideband, true);
  await seedRepo('again', okPlain, true);
  for (const [repo, s] of Object.entries(SCENARIOS)) await seedRepo(repo, s.body, false);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const name = url.pathname.split('/').find((s) => s.endsWith('.git'))!.replace(/\.git$/, '');
    if (url.pathname.endsWith('/git-receive-pack')) {
      if (init?.body) await new Response(init.body).arrayBuffer();
      const report = reports.get(name)!;
      if (report.moves) heads.set(name, (heads.get(name) ?? 0) + 1);
      return new Response(trickle(report.body), {
        headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' },
      });
    }
    return new Response(`advertisement ${mark(name)}`, {
      headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'cache-control': 'no-cache' },
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

const INFO_REFS = '.git/info/refs?service=git-upload-pack';

/** Warms the anonymous tree page and info/refs; the repeat must be a cache hit. */
async function warm(repo: string): Promise<string> {
  const m = mark(nameOf(repo));
  for (const path of [`/${OWNER}/${repo}`, `/${OWNER}/${repo}${INFO_REFS}`]) {
    const cold = await get(path);
    expect(cold.status, `cold ${path}`).toBe(200);
    expect(cold.text).toContain(m);
    const hot = await get(path);
    expect(hot.text).toContain(m);
    expect(hot.cost.cache, `warm ${path}`).toBe('hit');
  }
  return m;
}

describe('confirmed push freshness', () => {
  it('shows the new head on the anonymous tree page and info/refs as soon as the push reply completes', async () => {
    const before = await repoRow('fresh');
    const oldMark = await warm('fresh');
    const genBefore = await refGeneration(before.id);

    const pushed = await push('fresh');
    expect(pushed.status).toBe(200);
    // The reply is relayed byte for byte, final chunk included.
    expect(pushed.bytes).toEqual(okSideband);

    // Nothing below waits for the push's background tasks.
    const after = await repoRow('fresh');
    expect(after.pushed_at).not.toBeNull();
    expect(after.pushed_at!).toBeGreaterThan(before.pushed_at ?? 0);
    expect(await refGeneration(before.id)).not.toBe(genBefore);

    const newMark = mark(nameOf('fresh'));
    expect(newMark).not.toBe(oldMark);
    const page = await send(`/${OWNER}/fresh`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(newMark);
    expect(page.text).not.toContain(oldMark);
    expect(page.cost).toMatchObject({ cache: 'miss', do: 0 });
    expect(page.cost.d1).toBe(1);

    const refs = await send(`/${OWNER}/fresh${INFO_REFS}`);
    expect(refs.status).toBe(200);
    expect(refs.text).toBe(`advertisement ${newMark}`);
    expect(refs.cost).toMatchObject({ cache: 'miss', do: 0, d1: 1 });

    await Promise.all([pushed.settled, page.settled, refs.settled]);
    // The new entries are warm under the new generation.
    expect((await get(`/${OWNER}/fresh`)).cost.cache).toBe('hit');
    expect((await get(`/${OWNER}/fresh${INFO_REFS}`)).cost.cache).toBe('hit');
  });

  it('advances pushed_at monotonically across back-to-back confirmed pushes', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await push('again');
      expect(r.bytes).toEqual(okPlain);
      seen.push((await repoRow('again')).pushed_at!);
      await r.settled;
    }
    expect(seen[1]!).toBeGreaterThan(seen[0]!);
    expect(seen[2]!).toBeGreaterThan(seen[1]!);
  });
});

describe('unconfirmed pushes change nothing', () => {
  for (const [repo, s] of Object.entries(SCENARIOS)) {
    it(`keeps the generation, pushed_at and cached views on a ${s.label}`, async () => {
      const before = await repoRow(repo);
      const m = await warm(repo);
      const genBefore = await refGeneration(before.id);

      const pushed = await push(repo);
      expect(pushed.status).toBe(200);
      expect(pushed.bytes).toEqual(s.body);
      await pushed.settled;

      expect((await repoRow(repo)).pushed_at).toBe(before.pushed_at);
      expect(await refGeneration(before.id)).toBe(genBefore);
      for (const path of [`/${OWNER}/${repo}`, `/${OWNER}/${repo}${INFO_REFS}`]) {
        const r = await get(path);
        expect(r.text, path).toContain(m);
        expect(r.cost.cache, path).toBe('hit');
      }
    });
  }
});

describe('receive-pack reply relay', () => {
  async function drain(stream: ReadableStream<Uint8Array>, log: string[]): Promise<Uint8Array> {
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    log.push('reply-complete');
    return bytes;
  }

  function relay(body: Uint8Array, onConfirmed: (refs: string[]) => Promise<void>, timeoutMs?: number) {
    const pending: Promise<unknown>[] = [];
    const stream = relayReceivePackReply(trickle(body), {
      onConfirmed,
      waitUntil: (p) => pending.push(p),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    return { stream, settled: () => Promise.all(pending) };
  }

  it('holds the final chunk until the confirmed push is recorded', async () => {
    const log: string[] = [];
    const r = relay(okSideband, async (refs) => {
      log.push(`confirmed ${refs.join(',')}`);
      await new Promise((res) => setTimeout(res, 50));
      log.push('recorded');
    });
    expect(await drain(r.stream, log)).toEqual(okSideband);
    expect(log).toEqual(['confirmed refs/heads/main', 'recorded', 'reply-complete']);
    await r.settled();
  });

  it('releases the reply after the bound when recording stalls, and keeps the work alive', async () => {
    const log: string[] = [];
    let finish: () => void = () => undefined;
    const r = relay(
      okPlain,
      () =>
        new Promise<void>((res) => {
          finish = () => {
            log.push('recorded');
            res();
          };
        }),
      30,
    );
    expect(await drain(r.stream, log)).toEqual(okPlain);
    expect(log).toEqual(['reply-complete']);
    finish();
    await r.settled();
    expect(log).toEqual(['reply-complete', 'recorded']);
  });

  it('never records an unconfirmed report', async () => {
    for (const s of Object.values(SCENARIOS)) {
      let calls = 0;
      const r = relay(s.body, async () => {
        calls++;
      });
      expect(await drain(r.stream, [])).toEqual(s.body);
      await r.settled();
      expect(calls, s.label).toBe(0);
    }
  });
});

describe('generation-keyed caches', () => {
  it('varies info/refs keys by generation and keeps the Git-Protocol variation', () => {
    const remote = remoteOf('keys');
    const search = '?service=git-upload-pack';
    const urls = [
      infoRefsCacheKey(remote, search, null, 'g1').url,
      infoRefsCacheKey(remote, search, null, 'g2').url,
      infoRefsCacheKey(remote, search, 'version=2', 'g1').url,
      infoRefsCacheKey(remote, search, 'version=2', 'g2').url,
    ];
    expect(new Set(urls).size).toBe(4);
    expect(infoRefsCacheKey(remote, search, null, 'g1').url).toBe(infoRefsCacheKey(remote, search, null, 'g1').url);
  });

  it('varies mutable page keys by generation and keys commit-SHA pages in a versioned namespace', () => {
    const branch = new Request(`${ORIGIN}/${OWNER}/keys/tree/main/src`);
    expect(pageCacheKey(branch, 'g1').url).not.toBe(pageCacheKey(branch, 'g2').url);
    expect(pageCacheKey(branch, 'g1').url).toContain('/keys/tree/main/src');
    const pinned = new Request(`${ORIGIN}/${OWNER}/keys/tree/${'d'.repeat(40)}/src`);
    // The pre-cutover key was the bare request URL; the versioned key never equals it.
    expect(pageCacheKey(pinned, null).url).not.toBe(pinned.url);
    expect(pageCacheKey(pinned, null).url).toContain(`/keys/tree/${'d'.repeat(40)}/src`);
    expect(pageCacheKey(pinned, null).url).toBe(pageCacheKey(new Request(pinned.url), null).url);
    expect(pageCacheKey(pinned, null).url).not.toBe(pageCacheKey(branch, 'g1').url);
  });

  async function fetchPage(path: string): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(new Request(`${ORIGIN}${path}`) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it('never serves a retained pre-cutover commit-pinned page or its retired cache header', async () => {
    const path = `/${OWNER}/fresh/tree/${'e'.repeat(40)}`;
    await caches.default.put(
      new Request(`${ORIGIN}${path}`),
      new Response('<html><title>Forge</title>RETAINED-PRE-CUTOVER-CHROME</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000', 'x-forge-cache': 'miss' },
      }),
    );
    const res = await fetchPage(path);
    const text = await res.text();
    expect(text).not.toContain('RETAINED-PRE-CUTOVER-CHROME');
    expect(res.headers.get('x-forge-cache')).toBeNull();

    // An entry already in the versioned namespace that still carries a retired header loses it on the hit path.
    const pinned = `/${OWNER}/fresh/tree/${'f'.repeat(40)}`;
    await caches.default.put(
      pageCacheKey(new Request(`${ORIGIN}${pinned}`), null),
      new Response('<html>VERSIONED-ENTRY</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=31536000', 'x-forge-cache': 'miss', 'x-forge-cost': 'd1=0' },
      }),
    );
    const hit = await fetchPage(pinned);
    expect(await hit.text()).toContain('VERSIONED-ENTRY');
    expect(hit.headers.get('x-kvarm-cache')).toBe('hit');
    expect([...hit.headers.keys()].filter((k) => k.startsWith('x-forge-'))).toEqual([]);
  });

  it('derives the view generation from both pushed_at and the colo ref generation', async () => {
    const row = await repoRow('fresh');
    const g = await repoViewGeneration(row);
    expect(await repoViewGeneration({ ...row, pushed_at: (row.pushed_at ?? 0) + 1 })).not.toBe(g);
    expect(await repoViewGeneration(row)).toBe(g);
  });
});
