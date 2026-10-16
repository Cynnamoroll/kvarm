import { accessSync, constants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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

const httpsRequestMock = vi.hoisted(() => vi.fn());
vi.mock('node:https', () => ({ request: httpsRequestMock }));

describe('git-storm streaming proxy', () => {
  it('preserves chunked request bytes and Git-Protocol while injecting Basic PAT auth', async () => {
    let received = '';
    let authorization = '';
    let gitProtocol = '';
    const token = 'fixture-pat';
    const authHeader = gitAuthorization('pat', token, 'fixture-user');
    if (!authHeader) throw new Error('expected PAT authorization');
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
        authorization: authHeader,
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
      expect(authorization).toBe(authHeader);
      expect(Buffer.from(authorization.slice('Basic '.length), 'base64').toString()).toBe(`fixture-user:${token}`);
      expect(authorization).not.toContain(token);
      expect(gitProtocol).toBe('version=2');
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => proxy.close(() => resolve())),
        new Promise<void>((resolve) => upstream.close(() => resolve())),
      ]);
    }
  });

  it('uses the HTTPS transport for HTTPS upstreams', async () => {
    let receivedPath = '';
    const upstream = createServer((req, res) => {
      receivedPath = req.url ?? '';
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as { port: number }).port;
    httpsRequestMock.mockImplementation((url, options, callback) => {
      const localUrl = new URL(url);
      localUrl.protocol = 'http:';
      return httpRequest(localUrl, options, callback);
    });
    const proxy = createServer((req, res) => {
      forwardGitRequest(req, res, `https://127.0.0.1:${upstreamPort}`);
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        httpRequest({
          hostname: '127.0.0.1',
          port: proxyPort,
          path: '/owner/repo.git/info/refs?service=git-upload-pack',
        }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        }).on('error', reject).end();
      });
      expect(response).toEqual({ status: 200, body: 'ok' });
      expect(receivedPath).toBe('/owner/repo.git/info/refs?service=git-upload-pack');
      expect(httpsRequestMock).toHaveBeenCalledOnce();
    } finally {
      httpsRequestMock.mockReset();
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
    const token = 'fixture-pat';
    const authHeader = gitAuthorization('pat', token, 'fixed-user');
    expect(authHeader).toBe(`Basic ${Buffer.from(`fixed-user:${token}`).toString('base64')}`);
    expect(Buffer.from(authHeader!.slice('Basic '.length), 'base64').toString()).toBe(`fixed-user:${token}`);
    expect(authHeader).not.toContain(token);
    expect(() => gitAuthorization('pat')).toThrow(/KVARM_PAT/);
    expect(() => gitAuthorization('pat', token)).toThrow(/username/);
  });

  it('uses nearest-rank percentiles, including singleton and two-item vectors', () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([10, 20], 50)).toBe(10);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 99)).toBe(99);
    expect(summarize([10, 20])).toMatchObject({ n: 2, min: 10, mean: 15, p50: 10, p90: 20 });
  });

  it('summarizes request costs, status errors, and byte totals per workload', () => {
    const token = 'fixture-pat-secret';
    const authHeader = gitAuthorization('pat', token, 'fixed-user')!;
    const request = {
      op: 'upload-pack',
      status: 200,
      reqBytes: 4,
      resBytes: 8,
      cost: { d1: 4 },
      authorization: authHeader,
    };
    const summary = operationSummary(
      [{ start: 0, end: 10, ms: 10, ok: true }, { start: 20, end: 30, ms: 10, ok: false, status: 0 }],
      [
        request,
        { op: 'upload-pack', status: 429, reqBytes: 2, resBytes: 0, cost: {} },
      ],
    );
    expect(summary.cost['upload-pack']).toEqual({ median: { d1: 0 }, total: { d1: 4 } });
    expect(summary.requests).toEqual({ 'upload-pack': 2 });
    expect(summary.totalReqBytes).toBe(6);
    expect(summary.totalResBytes).toBe(8);
    expect(summary.errors).toEqual({ 0: 1, 429: 1 });
    expect(summary.metrics.giveUps).toBe(1);
    expect(JSON.stringify(summary)).not.toContain(authHeader);
    expect(JSON.stringify(summary)).not.toContain(token);
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
      const token = 'git-storm-test-pat';
      const child = spawn(process.execPath, [script, '--target', 'local', '--fixture', 'small', '--n', '2', '--writers', '2', '--commits', '2', '--out', out], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KVARM_PAT: token },
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code, text).toBe(0);
      const report = JSON.parse(await readFile(out, 'utf8'));
      expect(text).not.toContain(token);
      expect(JSON.stringify(report)).not.toContain(token);
      for (const workload of Object.values(report.workloads) as Array<{ metrics: { latencyMs: { n: number } }; errors: Record<string, number> }>) {
        expect(workload.metrics.latencyMs.n).toBeGreaterThan(0);
        expect(Object.values(workload.errors).reduce((a, b) => a + b, 0)).toBe(0);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('git-storm existing-repository setup', () => {
  it('uses PAT askpass for direct setup writes without leaking it into argv, logs, or report', async () => {
    const work = await mkdtemp(join(tmpdir(), 'git-storm-existing-test-'));
    const owner = 'bench-test';
    const repo = 'kvarm-bench-test1-public';
    const token = 'git-storm-setup-test-pat';
    const bareRoot = join(work, `${repo}.git`);
    const source = join(work, 'source');
    const bin = join(work, 'bin');
    const reportPath = join(work, 'report.json');
    const gitLogPath = join(work, 'git-argv.jsonl');
    const remoteRequests: Array<{ service: string; authorizationPresent: boolean; authorized: boolean }> = [];
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const realGit = (process.env.PATH ?? '').split(delimiter)
        .map((dir) => join(dir, 'git'))
        .find((path) => {
          try {
            accessSync(path, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (!realGit) throw new Error('git not found on PATH');

      const runGit = (cwd: string, args: string[]) => {
        const result = spawnSync(realGit, args, { cwd, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr || `git ${args[0]} failed`);
      };
      await mkdir(source);
      runGit(work, ['init', '--bare', '--initial-branch=main', bareRoot]);
      runGit(source, ['init', '-b', 'main']);
      await writeFile(join(source, 'README.md'), 'existing fixture\n');
      runGit(source, ['add', 'README.md']);
      runGit(source, ['commit', '-m', 'seed']);
      runGit(source, ['push', bareRoot, 'HEAD:refs/heads/main']);
      runGit(bareRoot, ['config', 'http.receivepack', 'true']);

      const expectedAuthorization = `Basic ${Buffer.from(`kvarm:${token}`).toString('base64')}`;
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const service = url.searchParams.get('service')
          ?? (url.pathname.endsWith('/git-receive-pack') ? 'git-receive-pack' : url.pathname.endsWith('/git-upload-pack') ? 'git-upload-pack' : '');
        const authorization = req.headers.authorization;
        const authorized = authorization === expectedAuthorization;
        remoteRequests.push({ service, authorizationPresent: Boolean(authorization), authorized });
        if (service === 'git-receive-pack' && !authorized) {
          req.resume();
          res.writeHead(401, { 'www-authenticate': 'Basic realm="git-storm-test"' }).end();
          return;
        }

        const gitProtocol = req.headers['git-protocol'];
        const child = spawn(realGit, ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: work,
            GIT_HTTP_EXPORT_ALL: '1',
            PATH_INFO: url.pathname.replace(/^\/[^/]+/, ''),
            QUERY_STRING: url.searchParams.toString(),
            REQUEST_METHOD: req.method ?? 'GET',
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            CONTENT_LENGTH: req.headers['content-length'] ?? '',
            SERVER_PROTOCOL: 'HTTP/1.1',
            REMOTE_USER: authorized ? 'kvarm' : '',
            ...(typeof gitProtocol === 'string' ? { HTTP_GIT_PROTOCOL: gitProtocol } : {}),
          },
        });
        let header = Buffer.alloc(0);
        let sent = false;
        child.stderr.resume();
        child.stdout.on('data', (chunk: Buffer) => {
          if (sent) {
            res.write(chunk);
            return;
          }
          header = Buffer.concat([header, chunk]);
          const at = header.indexOf('\r\n\r\n');
          if (at < 0) return;
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of header.subarray(0, at).toString().split('\r\n')) {
            const index = line.indexOf(':');
            if (index < 0) continue;
            const name = line.slice(0, index).trim();
            const value = line.slice(index + 1).trim();
            if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3));
            else headers[name] = value;
          }
          res.writeHead(status, headers);
          sent = true;
          res.write(header.subarray(at + 4));
          header = Buffer.alloc(0);
        });
        child.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
        child.on('close', (code) => {
          if (!sent) res.writeHead(code === 0 ? 200 : 500);
          res.end();
        });
        req.pipe(child.stdin);
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server!.address();
      if (!address || typeof address === 'string') throw new Error('Git fixture server did not bind a TCP port');
      const target = `http://127.0.0.1:${address.port}`;
      const script = fileURLToPath(new URL('../git-storm.mjs', import.meta.url));
      const args = [
        script, '--target', target, '--existing-repo', repo, '--bench-id', 'test1',
        '--workloads', 'fetch-incremental', '--git-auth', 'anonymous', '--n', '1',
        '--concurrency', '1', '--out', reportPath,
      ];
      const runStorm = (env: NodeJS.ProcessEnv) => new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let text = '';
        child.stdout.on('data', (data) => { text += data; });
        child.stderr.on('data', (data) => { text += data; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, text }));
      });

      await mkdir(bin);
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        'const record = { args, askpass: Boolean(process.env.GIT_ASKPASS), credentialHelperDisabled: args[0] === \'-c\' && args[1] === \'credential.helper=\', tokenPresent: process.env.KVARM_E2E_TOKEN === process.env.GIT_STORM_TEST_TOKEN };',
        'appendFileSync(process.env.GIT_STORM_TEST_LOG, `${JSON.stringify(record)}\\n`);',
        "const result = spawnSync(process.env.GIT_STORM_TEST_REAL_GIT, args, { env: process.env, stdio: 'inherit' });",
        'if (result.error) throw result.error;',
        'process.exit(result.status ?? 1);',
        '',
      ].join('\n'));
      await chmod(wrapper, 0o700);

      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        KVARM_PAT: token,
        KVARM_USER: owner,
        GIT_STORM_TEST_LOG: gitLogPath,
        GIT_STORM_TEST_REAL_GIT: realGit,
        GIT_STORM_TEST_TOKEN: token,
      };
      const missingPatEnv = { ...childEnv };
      delete missingPatEnv.KVARM_PAT;
      delete missingPatEnv.KVARM_E2E_TOKEN;
      const missingPat = await runStorm(missingPatEnv);
      expect(missingPat.code).not.toBe(0);
      expect(missingPat.text).toContain('KVARM_PAT is required for the existing-repository fetch-incremental setup push');
      expect(remoteRequests).toHaveLength(0);

      const result = await runStorm(childEnv);
      expect(result.code).toBe(0);
      const reportText = await readFile(reportPath, 'utf8');
      const report = JSON.parse(reportText);
      const gitLog = await readFile(gitLogPath, 'utf8');
      const invocations = gitLog.trim().split('\n').map((line) => JSON.parse(line));
      const pushes = invocations.filter((invocation) => invocation.args.includes('push'));
      expect(pushes).toHaveLength(1);
      const setupPush = pushes[0]!;
      expect(setupPush.args.slice(0, 3)).toEqual(['-c', 'credential.helper=', 'push']);
      expect(setupPush.args[3]).toBe(`${target.replace('://', '://kvarm@')}/${owner}/${repo}.git`);
      expect(setupPush.args.some((arg: string) => arg.includes('/__w/'))).toBe(false);
      expect(setupPush.askpass).toBe(true);
      expect(setupPush.credentialHelperDisabled).toBe(true);
      expect(setupPush.tokenPresent).toBe(true);
      expect(remoteRequests.some((request) => request.service === 'git-receive-pack' && request.authorized)).toBe(true);
      const uploadRequests = remoteRequests.filter((request) => request.service === 'git-upload-pack');
      expect(uploadRequests.length).toBeGreaterThan(0);
      expect(uploadRequests.every((request) => !request.authorizationPresent)).toBe(true);
      expect(report.requests.length).toBeGreaterThan(0);
      expect(report.requests.every((request: { workload: string }) => request.workload === 'fetch-incremental')).toBe(true);
      expect(result.text.includes(token)).toBe(false);
      expect(gitLog.includes(token)).toBe(false);
      expect(reportText.includes(token)).toBe(false);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});
