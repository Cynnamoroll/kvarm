import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkGitStormCaps,
  fixtureFiles,
  gitAuthorization,
  operationSummary,
  percentile,
  summarize,
  validateExistingRepoTarget,
} from '../lib/git-storm.mjs';
import { forwardGitRequest } from '../lib/git-storm-proxy.mjs';

describe('git-storm streaming proxy', () => {
  it('preserves chunked request bytes and Git-Protocol while injecting PAT auth', async () => {
    let received = '';
    let authorization = '';
    let gitProtocol = '';
    const upstream = createServer((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk) => { received += chunk; });
      req.on('end', () => {
        authorization = req.headers.authorization ?? '';
        const protocol = req.headers['git-protocol'] ?? '';
        gitProtocol = Array.isArray(protocol) ? protocol.join(',') : protocol;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const proxy = createServer((req, res) => {
      forwardGitRequest(req, res, `http://127.0.0.1:${upstreamPort}`, {
        authorization: 'Bearer fixture-pat',
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/owner/repo.git/git-receive-pack',
          method: 'POST',
          headers: { 'content-type': 'application/x-git-receive-pack-request', 'git-protocol': 'version=2' },
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.write('0008one');
        req.end('0008two');
      });
      expect(response).toEqual({ status: 200, body: 'ok' });
      expect(received).toBe('0008one0008two');
      expect(authorization).toBe('Bearer fixture-pat');
      expect(gitProtocol).toBe('version=2');
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });
});

describe('git-storm helpers', () => {
  it('targets only benchmark repos and the requested clone/fetch workloads', () => {
    const workloads = ['clone-cold', 'clone-shallow', 'fetch-noop', 'fetch-incremental'];
    expect(validateExistingRepoTarget({
      benchId: 'smoke1',
      repo: 'kvarm-bench-smoke1-public-corpus',
      workloads,
    })).toBeNull();
    expect(validateExistingRepoTarget({
      benchId: 'smoke1',
      repo: 'kvarm-platform',
      workloads,
    })).toMatch(/under kvarm-bench-smoke1-/);
    expect(validateExistingRepoTarget({
      benchId: 'smoke1',
      repo: 'kvarm-bench-smoke1-public-corpus',
      workloads: [...workloads, 'push-distinct'],
    })).toMatch(/does not allow workload/);
    expect(gitAuthorization('anonymous', undefined)).toBeNull();
    expect(gitAuthorization('pat', 'fixture-pat')).toBe('Bearer fixture-pat');
    expect(() => gitAuthorization('pat')).toThrow(/KVARM_PAT/);
  });

  it('uses nearest-rank percentiles, including singleton and two-item vectors', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 99)).toBe(99);
    expect(summarize([10, 20])).toMatchObject({ n: 2, min: 10, mean: 15, p50: 10, p90: 20 });
  });

  it('summarizes request costs, status errors, and byte totals per workload', () => {
    const summary = operationSummary(
      [{ start: 0, end: 10, ms: 10, ok: true }, { start: 20, end: 30, ms: 10, ok: false, status: 0 }],
      [
        { op: 'upload-pack', status: 200, reqBytes: 4, resBytes: 8, cost: { d1: 4 } },
        { op: 'upload-pack', status: 429, reqBytes: 2, resBytes: 0, cost: {} },
      ],
    );
    expect(summary.cost['upload-pack']).toEqual({ median: { d1: 0 }, total: { d1: 4 } });
    expect(summary.requests).toEqual({ 'upload-pack': 2 });
    expect(summary.totalReqBytes).toBe(6);
    expect(summary.totalResBytes).toBe(8);
    expect(summary.errors).toEqual({ 0: 1, 429: 1 });
    expect(summary.metrics.giveUps).toBe(1);
  });

  it('makes fixture bytes reproducible for a seed', () => {
    const files = fixtureFiles('small', 9);
    expect(files).toEqual(fixtureFiles('small', 9));
    expect(fixtureFiles('small', 9)).not.toEqual(fixtureFiles('small', 10));
    expect(files).toHaveLength(50);
    expect(files.every(([, contents]) => Buffer.byteLength(contents) === 1024)).toBe(true);
    const mixed = fixtureFiles('mixed', 9);
    expect(mixed).toHaveLength(500);
    expect(mixed.every(([, contents]) => Buffer.byteLength(contents) >= 1024 && Buffer.byteLength(contents) <= 64 * 1024)).toBe(true);
  });

  it('enforces the live concurrency exception against the exact host', () => {
    expect(checkGitStormCaps({ target: 'remote', concurrency: 4 })).toMatch(/requires --dedicated/);
    expect(checkGitStormCaps({ target: 'remote', concurrency: 4, dedicated: true, dedicatedHost: 'example.com', targetHost: 'example.com' })).toBeNull();
    expect(checkGitStormCaps({ target: 'remote', concurrency: 4, dedicated: true, dedicatedHost: 'other.com', targetHost: 'example.com' })).toMatch(/requires/);
    expect(checkGitStormCaps({ target: 'local', concurrency: 64 })).toBeNull();
  });
});

describe('git-storm local smoke', () => {
  it('runs each workload against stock git http-backend without errors', async () => {
    const work = await mkdtemp(join(tmpdir(), 'git-storm-test-'));
    const out = join(work, 'smoke.json');
    try {
      const script = fileURLToPath(new URL('../git-storm.mjs', import.meta.url));
      const child = spawn(process.execPath, [script, '--target', 'local', '--fixture', 'small', '--n', '2', '--writers', '2', '--commits', '2', '--out', out], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code, text).toBe(0);
      const report = JSON.parse(await readFile(out, 'utf8'));
      for (const workload of Object.values(report.workloads) as Array<{ metrics: { latencyMs: { n: number } }; errors: Record<string, number> }>) {
        expect(workload.metrics.latencyMs.n).toBeGreaterThan(0);
        expect(Object.values(workload.errors).reduce((a, b) => a + b, 0)).toBe(0);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
