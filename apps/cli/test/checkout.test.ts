import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { checkout } from '../src/checkout.js';
import type { HttpFetch } from '../src/http.js';
import { diffTrees, gitCheckout, makeRepo, tarFromCommit, tempDir } from './helpers';

const root = tempDir('kvarm-cli-checkout-');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = makeRepo(root);
const tarMain = tarFromCommit(repo.bare, repo.main);
const expectedMain = join(root, 'expected-main');
gitCheckout(repo.bare, repo.main, expectedMain);
const expectedFeature = join(root, 'expected-feature');
gitCheckout(repo.bare, repo.feature, expectedFeature);

const BASE = 'https://kvarm.test';
const SNAP = `${BASE}/api/v1/repos/alice/demo/snapshots`;

type Call = { method: string; url: string; auth: string | null; accept: string | null };
type Download = Uint8Array | { status: number; body: unknown } | { status: 200; bytes: Uint8Array; contentType: string; chunk?: number };

/** A fake platform: `snapshots` maps a ref or sha to its metadata response. */
function fakeFetch(snapshots: Record<string, { status: number; body: unknown }>, downloads: Record<string, Download>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization'), accept: headers.get('accept') });
    if (!url.startsWith(`${SNAP}/`)) return new Response('{"error":"not found"}', { status: 404 });
    const rest = decodeURIComponent(url.slice(SNAP.length + 1));
    if (rest.endsWith('/download')) {
      const d = downloads[rest.slice(0, -'/download'.length)];
      if (!d) return Response.json({ error: 'snapshot not found', code: 'NOT_FOUND' }, { status: 404 });
      const sha = rest.slice(0, -'/download'.length);
      if (d instanceof Uint8Array) {
        return new Response(new Uint8Array(d), { status: 200, headers: { 'content-type': 'application/x-tar', 'x-kvarm-snapshot-sha': sha } });
      }
      if ('bytes' in d) {
        const headers = { 'content-type': d.contentType, 'x-kvarm-snapshot-sha': sha };
        if (d.chunk !== undefined) {
          let off = 0;
          const body = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (off >= d.bytes.length) return controller.close();
              controller.enqueue(d.bytes.subarray(off, off + d.chunk!));
              off += d.chunk!;
            },
          });
          return new Response(body, { status: 200, headers });
        }
        return new Response(new Uint8Array(d.bytes), { status: 200, headers });
      }
      return Response.json(d.body, { status: d.status });
    }
    const s = snapshots[rest];
    if (!s) return Response.json({ error: 'snapshot not found', code: 'NOT_FOUND' }, { status: 404 });
    return Response.json(s.body, { status: s.status });
  }) as unknown as HttpFetch;
  return { impl, calls };
}

function run(fetchImpl: HttpFetch, opts: { ref: string; dir: string; pat?: string }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const promise = checkout({
    baseUrl: BASE,
    pat: opts.pat,
    repo: 'alice/demo',
    ref: opts.ref,
    dir: opts.dir,
    fetch: fetchImpl,
    cloneUrl: `file://${repo.bare}`,
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
  });
  return { promise, stdout, stderr };
}

const ready = (sha: string, size: number, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: { ref: 'main', sha, tree: 't', state: 'ready', size, files: 9, started: false, ...extra },
});

describe('kvarm checkout', () => {
  it.each(['../secret', 'main/..', 'refs/heads/.'])('rejects unsafe ref path segments before any request (%s)', async (ref) => {
    const f = fakeFetch({}, {});
    const r = run(f.impl, { ref, dir: join(root, `bad-ref-${ref.replaceAll('/', '-')}`), pat: 'p' });
    await expect(r.promise).rejects.toThrow(/invalid ref/);
    expect(f.calls).toHaveLength(0);
  });

  it('does not request a snapshot download for a malformed metadata sha', async () => {
    const f = fakeFetch({ main: ready('../outside', tarMain.length) }, {});
    const r = run(f.impl, { ref: 'main', dir: join(root, 'bad-snapshot-sha'), pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`${SNAP}/main`);
  });

  it('caps a snapshot transfer even when its metadata understates the size', async () => {
    const frames = new Uint8Array((1024 * 1024) + 8);
    for (let off = 0; off < frames.length; off += 8) frames.set([0x50, 0x2a, 0x4d, 0x18], off);
    const f = fakeFetch(
      { main: ready(repo.main, 0, { encoding: 'zstd', encodedSize: 0 }) },
      { [repo.main]: { status: 200, bytes: frames, contentType: 'application/zstd' } },
    );
    const r = run(f.impl, { ref: 'main', dir: join(root, 'oversized-snapshot'), pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(r.stderr.join('\n')).toMatch(/snapshot download exceeds the 1048576-byte transfer budget/);
  });

  it('demands the snapshot, downloads it by sha and extracts a tree equal to git checkout', async () => {
    const f = fakeFetch({ main: ready(repo.main, tarMain.length) }, { [repo.main]: tarMain });
    const dir = join(root, 'snap-main');
    const r = run(f.impl, { ref: 'main', dir, pat: 'kvarm_pat_test' });
    await expect(r.promise).resolves.toMatchObject({ source: 'snapshot', sha: repo.main, bytes: tarMain.length });
    expect(r.stdout[0]).toBe('source: snapshot');
    expect(r.stdout).toContain(`sha: ${repo.main}`);
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
    expect(existsSync(join(dir, '.git'))).toBe(false);
    expect(f.calls.map((c) => [c.method, c.url.slice(SNAP.length)])).toEqual([
      ['POST', '/main'],
      ['GET', `/${repo.main}/download`],
    ]);
    expect(f.calls.every((c) => c.auth === 'Bearer kvarm_pat_test')).toBe(true);
  });

  it('falls back to git clone while the demanded snapshot is building, at the demanded ref', async () => {
    const f = fakeFetch({ feature: { status: 202, body: { ref: 'feature', sha: repo.feature, state: 'building', started: true } } }, {});
    const dir = join(root, 'clone-feature');
    const r = run(f.impl, { ref: 'feature', dir, pat: 'kvarm_pat_test' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.feature });
    expect(r.stdout[0]).toBe('source: clone');
    expect(r.stderr.join('\n')).toMatch(/snapshot building for [0-9a-f]{12} \(build started\); falling back to git clone/);
    expect(diffTrees(dir, expectedFeature)).toEqual({ code: 0, out: '' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.method).toBe('POST');
  });

  it('uses the snapshot on a later checkout once the demanded build is ready', async () => {
    const tarFeature = tarFromCommit(repo.bare, repo.feature);
    const f = fakeFetch({ feature: ready(repo.feature, tarFeature.length) }, { [repo.feature]: tarFeature });
    const dir = join(root, 'snap-feature');
    const r = run(f.impl, { ref: 'feature', dir, pat: 'kvarm_pat_test' });
    await expect(r.promise).resolves.toMatchObject({ source: 'snapshot', sha: repo.feature });
    expect(diffTrees(dir, expectedFeature)).toEqual({ code: 0, out: '' });
  });

  it('without a token reads metadata (no demand) and clones when the snapshot is absent', async () => {
    const f = fakeFetch({ main: { status: 202, body: { ref: 'main', sha: repo.main, state: 'absent' } } }, {});
    const dir = join(root, 'anon-absent');
    const r = run(f.impl, { ref: 'main', dir });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(f.calls.map((c) => [c.method, c.auth])).toEqual([['GET', null]]);
    expect(r.stderr.join('\n')).toMatch(/set KVARM_PAT to request a build/);
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  });

  it('falls back to clone and leaves no snapshot leftovers when the download is short', async () => {
    const f = fakeFetch({ main: ready(repo.main, tarMain.length + 512) }, { [repo.main]: tarMain });
    const dir = join(root, 'short-download');
    mkdirSync(dir);
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(r.stderr.join('\n')).toMatch(/snapshot download failed: downloaded \d+ bytes, metadata size is \d+/);
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  });

  it('falls back to clone when the token is refused, the snapshot failed or the API is unreachable', async () => {
    const cases: Array<[string, HttpFetch]> = [
      ['refused', fakeFetch({ main: { status: 401, body: { error: 'unauthorized' } } }, {}).impl],
      ['failed', fakeFetch({ main: { status: 409, body: { sha: repo.main, state: 'failed', code: 'SNAPSHOT_FAILED' } } }, {}).impl],
      ['notready', fakeFetch({ main: ready(repo.main, tarMain.length) }, { [repo.main]: { status: 409, body: { code: 'SNAPSHOT_NOT_READY' } } }).impl],
      ['offline', (async () => { throw new TypeError('fetch failed'); }) as HttpFetch],
    ];
    for (const [name, impl] of cases) {
      const dir = join(root, `fallback-${name}`);
      const r = run(impl, { ref: 'main', dir, pat: 'p' });
      await expect(r.promise, name).resolves.toMatchObject({ source: 'clone', sha: repo.main });
      expect(diffTrees(dir, expectedMain), name).toEqual({ code: 0, out: '' });
    }
  });

  it('refuses a non-empty destination before any request', async () => {
    const f = fakeFetch({}, {});
    const dir = join(root, 'not-empty');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'mine');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).rejects.toThrow(/already exists and is not empty/);
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('reports an unknown ref as a failure and removes the directory it created', async () => {
    const f = fakeFetch({}, {});
    const dir = join(root, 'unknown-ref');
    const r = run(f.impl, { ref: 'no-such-ref', dir, pat: 'p' });
    await expect(r.promise).rejects.toThrow(/git checkout no-such-ref failed/);
    expect(r.stderr.join('\n')).toMatch(/snapshot API returned 404/);
    expect(existsSync(dir)).toBe(false);
  });

  // The platform stores one zstd frame per build step; the object served is
  // the concatenation, and a capable client decodes every frame.
  const half = Math.floor(tarMain.length / 2);
  const zstdObj = new Uint8Array([...zstdCompressSync(tarMain.subarray(0, half)), ...zstdCompressSync(tarMain.subarray(half))]);

  it('downloads a multi-frame zstd snapshot declared by content type and prints transfer stats', async () => {
    const f = fakeFetch(
      { main: ready(repo.main, tarMain.length, { encoding: 'zstd', encodedSize: zstdObj.length }) },
      { [repo.main]: { status: 200, bytes: zstdObj, contentType: 'application/zstd' } },
    );
    const dir = join(root, 'snap-zstd');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({
      source: 'snapshot',
      sha: repo.main,
      bytes: tarMain.length,
      transferBytes: zstdObj.length,
      encoding: 'zstd',
    });
    expect(r.stdout).toContain(`transfer: ${zstdObj.length}`);
    expect(r.stdout).toContain('encoding: zstd');
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
    const dl = f.calls.find((c) => c.url.endsWith('/download'));
    expect(dl?.accept).toContain('application/zstd');
  });

  it('sniffs a zstd snapshot served without a zstd content type', async () => {
    const f = fakeFetch(
      { main: ready(repo.main, tarMain.length, { encoding: 'zstd', encodedSize: zstdObj.length }) },
      { [repo.main]: { status: 200, bytes: zstdObj, contentType: 'application/octet-stream' } },
    );
    const dir = join(root, 'snap-zstd-sniffed');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'snapshot', bytes: tarMain.length, encoding: 'zstd' });
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  });

  it('falls back to clone when the zstd object is truncated mid-frame', async () => {
    const f = fakeFetch(
      { main: ready(repo.main, tarMain.length, { encoding: 'zstd', encodedSize: zstdObj.length }) },
      { [repo.main]: { status: 200, bytes: zstdObj.subarray(0, zstdObj.length - 1), contentType: 'application/zstd' } },
    );
    const dir = join(root, 'snap-zstd-trunc');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  });

  it('decodes a multi-frame zstd object delivered in 7-byte chunks', async () => {
    const f = fakeFetch(
      { main: ready(repo.main, tarMain.length, { encoding: 'zstd', encodedSize: zstdObj.length }) },
      { [repo.main]: { status: 200, bytes: zstdObj, contentType: 'application/zstd', chunk: 7 } },
    );
    const dir = join(root, 'snap-zstd-tiny');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'snapshot', bytes: tarMain.length, transferBytes: zstdObj.length });
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  });

  it('falls back to clone when a zstd frame is corrupt, without hanging', async () => {
    const corrupt = new Uint8Array(zstdObj);
    // Break the second frame's magic so the decode path errors mid-object.
    const frame2 = zstdCompressSync(tarMain.subarray(0, half)).length;
    corrupt[frame2] = (corrupt[frame2] ?? 0) ^ 0xff;
    const f = fakeFetch(
      { main: ready(repo.main, tarMain.length, { encoding: 'zstd', encodedSize: corrupt.length }) },
      { [repo.main]: { status: 200, bytes: corrupt, contentType: 'application/zstd' } },
    );
    const dir = join(root, 'snap-zstd-corrupt');
    const r = run(f.impl, { ref: 'main', dir, pat: 'p' });
    await expect(r.promise).resolves.toMatchObject({ source: 'clone', sha: repo.main });
    expect(diffTrees(dir, expectedMain)).toEqual({ code: 0, out: '' });
  }, 15_000);
});
