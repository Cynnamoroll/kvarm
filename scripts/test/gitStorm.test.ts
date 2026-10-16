import { accessSync, constants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  benchBranch,
  checkGitStormCaps,
  credentialForWriter,
  fixtureFiles,
  gitAuthorization,
  operationSummary,
  percentile,
  redactCredentials,
  resolveRemoteOwner,
  scratchDeleteError,
  summarize,
  validateExistingRepoTarget,
  writerCredentials,
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
  it('resolves the remote owner from the authenticated user endpoint', async () => {
    const token = 'owner-resolution-pat';
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://example.com/api/v1/user');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
      return new Response(JSON.stringify({ user: { login: 'bench-owner' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(resolveRemoteOwner({
      target: 'https://example.com',
      configuredOwner: 'bench-owner',
      token,
      fetchImpl,
    })).resolves.toBe('bench-owner');
    await expect(resolveRemoteOwner({
      target: 'https://example.com',
      configuredOwner: 'other-owner',
      token,
      fetchImpl,
    })).rejects.toThrow(/KVARM_USER.*does not match.*bench-owner/);
    await expect(resolveRemoteOwner({
      target: 'https://example.com',
      token,
      fetchImpl,
    })).resolves.toBe('bench-owner');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([200, 202, 204])('accepts scratch DELETE status %s', (status) => {
    expect(scratchDeleteError(status, 'bench-owner', 'storm-repo')).toBeNull();
  });

  it('treats scratch DELETE 404 as a cleanup failure naming the repository', () => {
    expect(scratchDeleteError(404, 'bench-owner', 'storm-repo'))
      .toMatch(/bench-owner\/storm-repo.*HTTP 404/);
  });

  it('uses workload-specific refs and round-robins writer credentials', () => {
    const tokens = ['writer-one-secret', 'writer-two-secret'];
    const credentials = writerCredentials({ KVARM_PATS: `${tokens[0]}\n${tokens[1]}` });
    expect([0, 1, 2, 3].map((writer) => credentialForWriter(credentials, writer))).toEqual([
      tokens[0], tokens[1], tokens[0], tokens[1],
    ]);
    expect(writerCredentials({ KVARM_PATS: `${tokens[0]}, ${tokens[1]}` })).toEqual(tokens);
    expect(writerCredentials({ KVARM_PAT: 'fallback-secret' })).toEqual(['fallback-secret']);
    expect(benchBranch(123, 'push-distinct', 0)).not.toBe(benchBranch(123, 'push-to-visible', 0));
    expect(benchBranch(123, 'push-contended', 'hot')).toContain('123-push-contended-hot');
  });

  it('redacts every PAT and its Basic encoding', () => {
    const tokens = ['writer-one-secret', 'writer-two-secret'];
    const message = tokens.flatMap((token) => [
      token,
      `Basic ${Buffer.from(`kvarm:${token}`).toString('base64')}`,
    ]).join(' ');
    const redacted = redactCredentials(message, tokens);
    for (const token of tokens) {
      expect(redacted).not.toContain(token);
      expect(redacted).not.toContain(Buffer.from(`kvarm:${token}`).toString('base64'));
    }
  });

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
      writer: null,
      rateLimit: null,
    };
    const summary = operationSummary(
      [{ start: 0, end: 10, ms: 10, ok: true }, { start: 20, end: 30, ms: 10, ok: false, status: 0 }],
      [
        request,
        { op: 'upload-pack', status: 429, reqBytes: 2, resBytes: 0, cost: {}, writer: 0, rateLimit: 'git-write' },
        { op: 'upload-pack', status: 429, reqBytes: 3, resBytes: 0, cost: {}, writer: 1, rateLimit: 'preauth' },
        { op: 'upload-pack', status: 429, reqBytes: 1, resBytes: 0, cost: {}, writer: null, rateLimit: null },
      ],
    );
    expect(summary.cost['upload-pack']).toEqual({ median: { d1: 0 }, total: { d1: 4 } });
    expect(summary.requests).toEqual({ 'upload-pack': 4 });
    expect(summary.totalReqBytes).toBe(10);
    expect(summary.totalResBytes).toBe(8);
    expect(summary.errors).toEqual({ 0: 1, 429: 3 });
    expect(summary.rateLimited).toEqual({
      byLimiter: { 'git-write': 1, preauth: 1, 'null': 1 },
      byWriter: { 0: 1, 1: 1, 'null': 1 },
    });
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
      const writerTokens = ['git-storm-writer-one-pat', 'git-storm-writer-two-pat'];
      const child = spawn(process.execPath, [script, '--target', 'local', '--fixture', 'small', '--n', '2', '--writers', '2', '--commits', '2', '--out', out], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, KVARM_PAT: token, KVARM_PATS: writerTokens.join(',') },
      });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      const code = await new Promise((resolve) => child.on('close', resolve));
      expect(code, text).toBe(0);
      const report = JSON.parse(await readFile(out, 'utf8'));
      expect(report.meta.credentials).toBe(2);
      for (const secret of [token, ...writerTokens]) {
        expect(text).not.toContain(secret);
        expect(text).not.toContain(Buffer.from(`kvarm:${secret}`).toString('base64'));
        expect(JSON.stringify(report)).not.toContain(secret);
        expect(JSON.stringify(report)).not.toContain(Buffer.from(`kvarm:${secret}`).toString('base64'));
      }
      const requestRows = report.requests as Array<{ writer?: unknown; rateLimit?: unknown }>;
      expect(requestRows.every((request) =>
        Object.hasOwn(request, 'writer') && Object.hasOwn(request, 'rateLimit'),
      )).toBe(true);
      expect(requestRows.some((request) => Number.isInteger(request.writer))).toBe(true);
      for (const workload of Object.values(report.workloads) as Array<{ metrics: { latencyMs: { n: number } }; errors: Record<string, number> }>) {
        expect(workload.metrics.latencyMs.n).toBeGreaterThan(0);
        expect(Object.values(workload.errors).reduce((a, b) => a + b, 0)).toBe(0);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('git-storm new remote scratch setup', () => {
  it('authenticates an anonymous setup push directly and fails cleanup on DELETE 404 without leaking the PAT', async () => {
    const work = await mkdtemp(join(tmpdir(), 'git-storm-scratch-test-'));
    const bin = join(work, 'bin');
    const reportPath = join(work, 'report.json');
    const gitLogPath = join(work, 'git.log');
    const token = 'anonymous-scratch-fixture-pat';
    const owner = 'bench-owner';
    const events: string[] = [];
    let repo = '';
    let server: ReturnType<typeof createServer> | undefined;
    try {
      const realGit = (process.env.PATH ?? '').split(delimiter).map((path) => join(path, 'git')).find((path) => {
        try {
          accessSync(path, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
      if (!realGit) throw new Error('git not found on PATH');

      server = createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (req.method === 'GET' && url.pathname === '/api/v1/user') {
          events.push('user');
          if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'UNAUTHENTICATED' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ user: { login: owner } }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/v1/repos') {
          events.push('create');
          let body = '';
          for await (const chunk of req) body += chunk;
          repo = JSON.parse(body).name;
          res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ repo: { name: repo } }));
          return;
        }
        if (url.pathname === `/api/v1/repos/${owner}/${repo}` && req.method === 'DELETE') {
          events.push('delete');
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'NOT_FOUND' }));
          return;
        }
        if (url.pathname === `/api/v1/repos/${owner}/${repo}` && req.method === 'GET') {
          events.push('readback');
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 'NOT_FOUND' }));
          return;
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('API fixture server did not bind a TCP port');

      await mkdir(bin);
      const wrapper = join(bin, 'git');
      await writeFile(wrapper, [
        '#!/usr/bin/env node',
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        'const args = process.argv.slice(2);',
        'const push = args.includes("push");',
        'const askpass = process.env.GIT_ASKPASS;',
        'const username = push && askpass ? spawnSync(askpass, ["Username"], { encoding: "utf8", env: process.env }).stdout.trim() : null;',
        'const password = push && askpass ? spawnSync(askpass, ["Password"], { encoding: "utf8", env: process.env }).stdout.trim() : null;',
        'const record = { args, askpass: Boolean(askpass), credentialHelperDisabled: args[0] === "-c" && args[1] === "credential.helper=", username, passwordMatches: password === process.env.GIT_STORM_TEST_TOKEN };',
        'appendFileSync(process.env.GIT_STORM_TEST_LOG, `${JSON.stringify(record)}\\n`);',
        'if (push) process.exit(0);',
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
        KVARM_E2E_TOKEN: token,
        GIT_STORM_TEST_TOKEN: token,
        GIT_STORM_TEST_LOG: gitLogPath,
        GIT_STORM_TEST_REAL_GIT: realGit,
      };
      delete childEnv.KVARM_USER;
      const script = fileURLToPath(new URL('../git-storm.mjs', import.meta.url));
      const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          script,
          '--target', `http://127.0.0.1:${address.port}`,
          '--workloads', '',
          '--git-auth', 'anonymous',
          '--n', '1',
          '--out', reportPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
        let text = '';
        child.stdout.on('data', (data) => { text += data; });
        child.stderr.on('data', (data) => { text += data; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, text }));
      });

      const reportText = await readFile(reportPath, 'utf8');
      const report = JSON.parse(reportText);
      const gitLog = await readFile(gitLogPath, 'utf8');
      const invocations = gitLog.trim().split('\n').map((line) => JSON.parse(line));
      const pushes = invocations.filter((entry) => entry.args.includes('push'));
      const remoteAdds = invocations.filter((entry) => entry.args[0] === 'remote' && entry.args[1] === 'add');
      expect(result.code).toBe(1);
      expect(events[0]).toBe('user');
      expect(events[1]).toBe('create');
      expect(events).toContain('delete');
      expect(events.filter((event) => event === 'delete')).toHaveLength(2);
      expect(result.text).toContain(`scratch repository cleanup failed for ${owner}/${repo}`);
      expect(result.text).toContain('HTTP 404');
      expect(pushes).toHaveLength(1);
      expect(remoteAdds).toHaveLength(1);
      expect(remoteAdds[0]!.args[3]).toBe(`http://kvarm@127.0.0.1:${address.port}/${owner}/${repo}.git`);
      expect(remoteAdds[0]!.args[3]).not.toContain('/__w/');
      expect(pushes[0].args.some((arg: string) => arg.includes('/__w/'))).toBe(false);
      expect(pushes[0].askpass).toBe(true);
      expect(pushes[0].credentialHelperDisabled).toBe(true);
      expect(pushes[0].username).toBe('kvarm');
      expect(pushes[0].passwordMatches).toBe(true);
      expect(report.requests.filter((request: { op: string }) => request.op !== 'api')).toHaveLength(0);
      expect(result.text).not.toContain(token);
      expect(gitLog).not.toContain(token);
      expect(reportText).not.toContain(token);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
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
        if (req.method === 'GET' && url.pathname === '/api/v1/user') {
          req.resume();
          const authorizedUser = req.headers.authorization === `Bearer ${token}`;
          res.writeHead(authorizedUser ? 200 : 401, { 'content-type': 'application/json' })
            .end(JSON.stringify(authorizedUser ? { user: { login: owner } } : { code: 'UNAUTHENTICATED' }));
          return;
        }
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
