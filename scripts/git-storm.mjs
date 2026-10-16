#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseCost } from './lib/fleet.mjs';
import { checkGitStormCaps, createRandom, fixtureFiles, operationSummary, opForPath } from './lib/git-storm.mjs';
import { forwardGitRequest } from './lib/git-storm-proxy.mjs';

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: process.env.KVARM_BASE_URL ?? 'http://localhost:8787' },
    fixture: { type: 'string', default: 'small' },
    n: { type: 'string', default: '20' },
    writers: { type: 'string', default: '10' },
    commits: { type: 'string', default: '10' },
    concurrency: { type: 'string', default: '3' },
    seed: { type: 'string', default: '1' },
    workloads: { type: 'string', default: 'all' },
    payload: { type: 'string', default: 'small' },
    out: { type: 'string' },
    dedicated: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    write: { type: 'boolean', default: false },
    'write-local': { type: 'boolean', default: false },
    'bench-id': { type: 'string', default: process.env.KVARM_BENCH_STACK_ID },
  },
  allowPositionals: true,
});
const flags = new Set(process.argv.slice(2).filter((x) => x.startsWith('--')).map((x) => x.split('=')[0]));
const target = args.target;
const local = target === 'local';
if (args['bench-id'] && !/^[a-z0-9]{4,12}$/.test(args['bench-id'])) throw new Error('--bench-id must be 4–12 lowercase letters or digits');
if (local && args['bench-id']) throw new Error('--bench-id requires a deployment target');
const base = local ? '' : new URL(target);
const n = Number(args.n);
const writers = Number(args.writers);
const commits = Number(args.commits);
const concurrency = Number(args.concurrency);
const seed = Number(args.seed);
const ts = Math.floor(Date.now() / 1000);
const owner = process.env.KVARM_USER ?? 'admin';
const repo = args['bench-id'] ? `kvarm-bench-${args['bench-id']}-storm-${ts}` : `bench-storm-${ts}`;
const outFile = args.out ? resolve(args.out) : resolve(`git-storm-${ts}.json`);
const allWorkloads = ['clone-cold', 'clone-shallow', 'fetch-noop', 'fetch-incremental', 'push-distinct', 'push-contended', ...(!local ? ['push-to-visible'] : [])];
const requested = args.workloads === 'all' ? allWorkloads : args.workloads.split(',').map((v) => v.trim()).filter(Boolean);
const workloadRequestLimit = 10_000 - (local ? 0 : 2);
const invalid = requested.find((w) => !allWorkloads.includes(w));
if (invalid) throw new Error(`unknown workload ${invalid}`);
if (!['small', 'mixed', 'large'].includes(args.fixture)) throw new Error('--fixture must be small, mixed, or large');
if (!['small', 'mixed'].includes(args.payload)) throw new Error('--payload must be small or mixed');
if (![n, writers, commits, concurrency, seed].every(Number.isSafeInteger) || n < 1 || writers < 1 || commits < 1 || seed < 0) {
  throw new Error('--n, --writers, --commits and --concurrency must be positive integers; --seed must be non-negative');
}
const capError = checkGitStormCaps({
  target: local ? 'local' : 'remote',
  concurrency,
  dedicated: flags.has('--dedicated'),
  dedicatedHost: process.env.KVARM_BENCH_DEDICATED,
  targetHost: local ? undefined : base.host,
});
if (capError) throw new Error(capError);
if (n * Math.max(1, requested.length) + writers * commits * 2 > 10_000) throw new Error('request projection exceeds the 10,000-request ceiling');
if (!local && !process.env.KVARM_PAT) throw new Error('KVARM_PAT is required for a deployment target');

const work = mkdtempSync(join(tmpdir(), 'git-storm-'));
const bareRoot = join(work, `${repo}.git`);
const seedRepo = join(work, 'seed');
const perWorkload = new Map();
const requestRows = [];
let requestsSeen = 0;
let requestCeilingExceeded = false;
let localBackend;
let proxy;
let createdRemote = false;
let remoteDeleted = false;
let subscribed = false;
const benchStack = (action) => {
  const result = spawnSync(process.execPath, [
    resolve('scripts/bench-stack.mjs'), action, '--id', args['bench-id'], '--repo', repo,
  ], { encoding: 'utf8', env: process.env });
  if (result.status !== 0) throw new Error(`bench-stack ${action} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
};
let activeWorkload = 'setup';
const limit = (max) => {
  let live = 0;
  const waiters = [];
  return async (fn) => {
    if (live >= max) await new Promise((resolve) => waiters.push(resolve));
    live++;
    try { return await fn(); } finally { live--; waiters.shift()?.(); }
  };
};
const runGit = limit(concurrency);
const httpLimit = limit(5);
const tailText = (text, fallback) => text.trim().slice(-400) || fallback;
const gitErrorStatus = (message) => Number(/(?:returned error:\s*|HTTP\/\d(?:\.\d)?\s+|status code\s+)(\d{3})/i.exec(message)?.[1] ?? 0);
const git = (cwd, argv) => runGit(() => new Promise((resolve, reject) => {
  const processStart = performance.now();
  const child = spawn('git', argv, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', (error) => reject(Object.assign(error, { processStart, processEnd: performance.now() })));
  child.on('close', (code) => {
    const processEnd = performance.now();
    if (code === 0) resolve({ processStart, processEnd });
    else {
      const message = tailText(stderr, `git exited ${code}`);
      reject(Object.assign(new Error(message), { status: gitErrorStatus(message), processStart, processEnd }));
    }
  });
}));
const gitOutput = (cwd, argv) => runGit(() => new Promise((resolve, reject) => {
  const child = spawn('git', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) resolve(stdout.trim());
    else {
      const message = tailText(stderr, `git exited ${code}`);
      reject(Object.assign(new Error(message), { status: gitErrorStatus(message) }));
    }
  });
}));
const api = async (path, method = 'GET', body) => {
  for (;;) {
    if (requestCeilingExceeded && activeWorkload !== 'cleanup') throw new Error('request ceiling exceeded');
    requestsSeen++;
    if (requestsSeen > 10_000) throw new Error('request ceiling exceeded');
    if (requestsSeen >= workloadRequestLimit && activeWorkload !== 'cleanup') requestCeilingExceeded = true;
    const bodyText = body ? JSON.stringify(body) : undefined;
    let started = 0;
    const response = await httpLimit(() => {
      started = performance.now();
      return fetch(`${base.origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.KVARM_PAT}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(bodyText ? { body: bodyText } : {}),
      });
    });
    const responseAt = performance.now();
    const responseBytes = await response.clone().arrayBuffer();
    const costHeader = response.headers.get('x-kvarm-cost');
    requestRows.push({
      workload: activeWorkload,
      op: opForPath(path),
      status: response.status,
      ttfbMs: responseAt - started,
      totalMs: performance.now() - started,
      reqBytes: bodyText ? Buffer.byteLength(bodyText) : 0,
      resBytes: responseBytes.byteLength,
      cost: costHeader ? parseCost(costHeader) : {},
      retryAfter: response.headers.get('retry-after'),
    });
    if (response.status !== 429) return response;
    const retryAfter = response.headers.get('retry-after');
    const retrySeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const retryDate = retryAfter === null ? Number.NaN : Date.parse(retryAfter);
    const delay = Number.isFinite(retrySeconds)
      ? Math.max(0, retrySeconds * 1000)
      : Number.isFinite(retryDate)
        ? Math.max(0, retryDate - Date.now())
        : 1000;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};
const recordRequest = (req, pathname, workload, started) => {
  if (!requestCeilingExceeded) {
    requestsSeen++;
    if (requestsSeen >= workloadRequestLimit) requestCeilingExceeded = true;
  }
  const row = { reqBytes: 0, resBytes: 0 };
  req.on('data', (chunk) => { row.reqBytes += chunk.length; });
  const save = (status, headers, ttfbMs) => {
    requestRows.push({
      workload,
      op: opForPath(pathname),
      status,
      ttfbMs,
      totalMs: performance.now() - started,
      reqBytes: row.reqBytes,
      resBytes: row.resBytes,
      cost: typeof headers['x-kvarm-cost'] === 'string' ? parseCost(headers['x-kvarm-cost']) : {},
      retryAfter: headers['retry-after'] ?? null,
    });
  };
  const meter = (reply) => {
    const ttfbMs = performance.now() - started;
    reply.on('data', (chunk) => { row.resBytes += chunk.length; });
    reply.on('end', () => save(reply.statusCode ?? 0, reply.headers, ttfbMs));
  };
  meter.blocked = (status) => {
    const ttfbMs = performance.now() - started;
    req.on('end', () => save(status, {}, ttfbMs));
    req.resume();
  };
  return meter;
};
const cgiServer = async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://local');
  const match = /^\/[^/]+\/[^/]+\.git(\/.*)?$/.exec(url.pathname);
  if (!match) { res.writeHead(404).end(); return; }
  const pathInfo = url.pathname.replace(/^\/[^/]+/, '');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: work,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      QUERY_STRING: url.searchParams.toString(),
      REQUEST_METHOD: req.method ?? 'GET',
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: req.headers['content-length'] ?? '',
      SERVER_PROTOCOL: 'HTTP/1.1',
      REMOTE_USER: 'bench',
      ...(req.headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-400); });
  let header = Buffer.alloc(0);
  let sent = false;
  child.stdout.on('data', (chunk) => {
    if (sent) {
      res.write(chunk);
      return;
    }
    header = Buffer.concat([header, chunk]);
    const at = header.indexOf('\r\n\r\n');
    if (at < 0) return;
    const lines = header.subarray(0, at).toString().split('\r\n');
    let status = 200;
    const headers = {};
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (name.toLowerCase() === 'status') status = Number(value.slice(0, 3));
      else headers[name] = value;
    }
    res.writeHead(status, headers);
    sent = true;
    res.write(header.subarray(at + 4));
    header = Buffer.alloc(0);
  });
  child.on('close', (code) => {
    if (code !== 0) console.error(`git http-backend exited ${code}: ${stderr}`);
    if (!sent) res.writeHead(code === 0 ? 200 : 500);
    res.end();
  });
  req.pipe(child.stdin);
};
const createLocalProxy = async () => {
  localBackend = createServer(cgiServer);
  await new Promise((resolve) => localBackend.listen(0, '127.0.0.1', resolve));
  const backendPort = localBackend.address().port;
  proxy = createServer((req, res) => {
    const started = performance.now();
    const bits = (req.url ?? '/').split('/');
    const workload = decodeURIComponent(bits[2] ?? 'setup');
    const forwardedPath = `/${bits.slice(3).join('/')}`;
    const meter = recordRequest(req, forwardedPath, workload, started);
    if (requestCeilingExceeded) { meter.blocked(429); res.writeHead(429, { 'retry-after': '0' }).end(); return; }
    forwardGitRequest(req, res, `http://127.0.0.1:${backendPort}`, {
      path: forwardedPath,
      authorization: null,
      onResponse: meter,
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${proxy.address().port}`;
};
const startProxy = async () => {
  if (local) return createLocalProxy();
  proxy = createServer((req, res) => {
    const started = performance.now();
    const bits = (req.url ?? '/').split('/');
    const workload = decodeURIComponent(bits[2] ?? 'setup');
    const forwardedPath = `/${bits.slice(3).join('/')}`;
    const meter = recordRequest(req, forwardedPath, workload, started);
    if (requestCeilingExceeded) { meter.blocked(429); res.writeHead(429, { 'retry-after': '0' }).end(); return; }
    forwardGitRequest(req, res, base.origin, {
      path: forwardedPath,
      authorization: `Bearer ${process.env.KVARM_PAT}`,
      onResponse: meter,
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${proxy.address().port}`;
};
const record = (name) => {
  const rows = perWorkload.get(name) ?? [];
  perWorkload.set(name, rows);
  return async (run) => {
    const start = performance.now();
    try {
      const value = await run();
      const processStart = value?.processStart ?? start;
      const processEnd = value?.processEnd ?? performance.now();
      rows.push({ start: processStart, end: processEnd, ms: processEnd - processStart, ok: true, ...(Number.isFinite(value?.attempts) ? { attempts: value.attempts } : {}) });
    } catch (err) {
      const processStart = err.processStart ?? start;
      const processEnd = err.processEnd ?? performance.now();
      rows.push({
        start: processStart,
        end: processEnd,
        ms: processEnd - processStart,
        ok: false,
        status: err.status ?? 0,
        message: String(err.message ?? err).split('\n').slice(-2).join(' | ').slice(0, 200),
      });
    }
    perWorkload.set(name, rows);
  };
};
const recordFailure = (name, error) => {
  const now = performance.now();
  const start = error?.processStart ?? now;
  const end = error?.processEnd ?? now;
  const rows = perWorkload.get(name) ?? [];
  rows.push({
    start,
    end,
    ms: end - start,
    ok: false,
    status: error?.status ?? 0,
    message: String(error?.message ?? error).split('\n').slice(-2).join(' | ').slice(0, 200),
  });
  perWorkload.set(name, rows);
};
const recordProcess = (name, timing) => {
  const rows = perWorkload.get(name) ?? [];
  rows.push({ start: timing.processStart, end: timing.processEnd, ms: timing.processEnd - timing.processStart, ok: true });
  perWorkload.set(name, rows);
};
const cloneInto = (root, workload, shallow = false) => {
  const dest = join(root, `clone-${Math.random().toString(36).slice(2)}`);
  const url = `${proxyUrl}/__w/${encodeURIComponent(workload)}/${owner}/${repo}.git`;
  return git(work, ['clone', ...(shallow ? ['--depth', '1'] : []), url, dest]).then(
    (timing) => ({ path: dest, ...timing }),
    (error) => {
      rmSync(dest, { recursive: true, force: true });
      throw error;
    },
  );
};
let proxyUrl = '';
const addCommit = async (cwd, files, message) => {
  for (const [path, text] of files) {
    const full = join(cwd, path);
    mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
    writeFileSync(full, text);
  }
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message, '--allow-empty']);
};
const push = (cwd, workload, ref = 'refs/heads/main') => git(cwd, ['-c', `remote.origin.url=${proxyUrl}/__w/${encodeURIComponent(workload)}/${owner}/${repo}.git`, 'push', 'origin', `HEAD:${ref}`]);
try {
  proxyUrl = await startProxy();
  if (local) {
    mkdirSync(bareRoot, { recursive: true });
    await git(work, ['init', '--bare', bareRoot]);
    await git(bareRoot, ['config', 'http.receivepack', 'true']);
  } else {
    const created = await api('/api/v1/repos', 'POST', { name: repo, visibility: 'public' });
    if (created.status !== 201) throw new Error(`repo create failed: HTTP ${created.status}`);
    createdRemote = true;
    if (args['bench-id']) {
      benchStack('subscribe');
      subscribed = true;
    }
  }
  mkdirSync(seedRepo, { recursive: true });
  await git(work, ['init', '-b', 'main', seedRepo]);
  const files = fixtureFiles(args.fixture, seed);
  if (args.fixture === 'mixed') {
    for (let i = 0; i < files.length; i += 25) await addCommit(seedRepo, files.slice(i, i + 25), `git-storm seed ${Math.floor(i / 25) + 1}/20`);
  } else {
    await addCommit(seedRepo, files, 'git-storm seed');
  }
  await git(seedRepo, ['remote', 'add', 'origin', `${proxyUrl}/__w/setup/${owner}/${repo}.git`]);
  await push(seedRepo, 'setup');
  if (local) await git(bareRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  const results = {};
  const runClones = async (name, shallow) => {
    await Promise.all(Array.from({ length: n }, async () => {
      try {
        const clone = await cloneInto(work, name, shallow);
        recordProcess(name, clone);
        rmSync(clone.path, { recursive: true, force: true });
      } catch (error) {
        recordFailure(name, error);
      }
    }));
  };
  for (const name of requested) {
    activeWorkload = name;
    if (name === 'clone-cold' || name === 'clone-shallow') await runClones(name, name === 'clone-shallow');
    else if (name === 'fetch-noop') {
      const clones = (await Promise.all(Array.from({ length: Math.min(concurrency, n) }, async () => {
        try { return await cloneInto(work, name); } catch (error) { recordFailure(name, error); return null; }
      }))).filter((clone) => clone !== null);
      const each = record(name);
      await Promise.all(clones.map((clone, lane) => (async () => {
        for (let i = lane; i < n; i += clones.length) await each(() => git(clone.path, ['fetch', 'origin']));
      })()));
    } else if (name === 'fetch-incremental') {
      const clones = (await Promise.all(Array.from({ length: Math.min(concurrency, n) }, async () => {
        try { return await cloneInto(work, name); } catch (error) { recordFailure(name, error); return null; }
      }))).filter((clone) => clone !== null);
      const each = record(name);
      await addCommit(seedRepo, [['incremental.txt', `${seed}-${ts}\n`]], 'git-storm incremental');
      try { await push(seedRepo, name); } catch (error) { recordFailure(name, error); }
      await Promise.all(clones.map((clone, lane) => (async () => {
        for (let i = lane; i < n; i += clones.length) await each(() => git(clone.path, ['fetch', 'origin']));
      })()));
    } else if (name === 'push-distinct' || name === 'push-to-visible') {
      perWorkload.set(name, []);
      const ops = [];
      for (let i = 0; i < writers; i++) {
        const branch = `refs/heads/bench/${ts}-${i}`;
        ops.push((async () => {
          let clone;
          try { clone = await cloneInto(work, name); } catch (error) { recordFailure(name, error); return; }
          for (let k = 0; k < commits; k++) {
            let payloadSize = args.payload === 'mixed' ? 4096 : 1024;
            let content = 'x'.repeat(payloadSize);
            let commitFiles = [[`writer-${i}-${k}.txt`, `${content.slice(0, payloadSize - 1)}\n`]];
            if (args.payload === 'mixed') {
              const random = createRandom(seed + i * 100_000 + k);
              commitFiles = Array.from({ length: 10 }, (_, fileIndex) => {
                payloadSize = 1024 + Math.floor(random() * 63 * 1024);
                content = '';
                while (content.length < payloadSize) content += Math.floor(random() * 36).toString(36);
                return [`writer-${i}-${k}-${fileIndex}.txt`, `${content.slice(0, payloadSize - 1)}\n`];
              });
            }
            await addCommit(clone.path, commitFiles, `writer ${i} commit ${k}`);
            let started;
            try {
              const sha = name === 'push-to-visible' ? await gitOutput(clone.path, ['rev-parse', 'HEAD']) : null;
              const pushed = await push(clone.path, name, branch);
              started = pushed.processStart;
              if (name === 'push-to-visible') await waitVisible(clone.path, branch, sha);
              const end = name === 'push-to-visible' ? performance.now() : pushed.processEnd;
              perWorkload.set(name, [...(perWorkload.get(name) ?? []), { start: started, end, ms: end - started, ok: true }]);
            } catch (err) {
              const end = performance.now();
              const start = started ?? err.processStart ?? end;
              perWorkload.set(name, [...(perWorkload.get(name) ?? []), {
                start,
                end,
                ms: end - start,
                ok: false,
                status: err.status ?? 0,
                message: String(err.message ?? err).split('\n').slice(-2).join(' | ').slice(0, 200),
              }]);
              return;
            }
          }
        })());
      }
      await Promise.all(ops);
    } else if (name === 'push-contended') {
      const hot = 'refs/heads/bench/' + ts + '-hot';
      const clones = (await Promise.all(Array.from({ length: writers }, async () => {
        try { return await cloneInto(work, name); } catch (error) { recordFailure(name, error); return null; }
      }))).filter((clone) => clone !== null);
      const ready = [];
      for (const clone of clones) {
        try {
          await git(clone.path, ['fetch', 'origin']);
          await git(clone.path, ['checkout', '-B', hot.slice('refs/heads/'.length), 'origin/main']);
          ready.push(clone);
        } catch (error) {
          recordFailure(name, error);
        }
      }
      await Promise.all(ready.map(async (clone, i) => {
        for (let k = 0; k < commits; k++) {
          await addCommit(clone.path, [[`hot-${i}-${k}.txt`, `${i}-${k}\n`]], `hot ${i} ${k}`);
          let attempts = 0;
          let started = null;
          let completed = false;
          while (attempts < 20) {
            attempts++;
            try {
              const pushed = await push(clone.path, name, hot);
              started ??= pushed.processStart;
              const end = pushed.processEnd;
              perWorkload.set(name, [...(perWorkload.get(name) ?? []), { start: started, end, ms: end - started, ok: true, attempts }]);
              completed = true;
              break;
            } catch (error) {
              started ??= error.processStart ?? performance.now();
              if (error.status === 429) {
                perWorkload.set(name, [...(perWorkload.get(name) ?? []), {
                  start: started,
                  end: performance.now(),
                  ms: performance.now() - started,
                  ok: false,
                  status: 429,
                  attempts,
                  message: String(error.message ?? error).split('\n').slice(-2).join(' | ').slice(0, 200),
                }]);
                return;
              }
              if (!/non-fast-forward|fetch first|cannot lock ref|reference already exists|same ref|integrate the remote changes/i.test(error.message)) {
                perWorkload.set(name, [...(perWorkload.get(name) ?? []), {
                  start: started,
                  end: performance.now(),
                  ms: performance.now() - started,
                  ok: false,
                  status: error.status ?? 0,
                  attempts,
                  message: String(error.message ?? error).split('\n').slice(-2).join(' | ').slice(0, 200),
                }]);
                return;
              }
              try {
                await git(clone.path, ['pull', '--rebase', 'origin', hot.slice('refs/heads/'.length)]);
              } catch (rebaseError) {
                perWorkload.set(name, [...(perWorkload.get(name) ?? []), {
                  start: started,
                  end: performance.now(),
                  ms: performance.now() - started,
                  ok: false,
                  status: rebaseError.status ?? 0,
                  attempts,
                  message: String(rebaseError.message ?? rebaseError).split('\n').slice(-2).join(' | ').slice(0, 200),
                }]);
                return;
              }
            }
          }
          if (!completed && attempts >= 20) {
            const end = performance.now();
            perWorkload.set(name, [...(perWorkload.get(name) ?? []), {
              start: started ?? end,
              end,
              ms: end - (started ?? end),
              ok: false,
              status: 0,
              attempts,
              message: 'push retry limit reached',
            }]);
          }
        }
      }));
    }
    const relevant = requestRows.filter((r) => r.workload === name);
    const samples = perWorkload.get(name) ?? [];
    results[name] = {
      ...operationSummary(samples, relevant),
      failures: samples.filter((sample) => !sample.ok).map(({ status, message }) => ({ status, message })),
    };
  }
  async function waitVisible(cwd, ref, expectedSha) {
    const end = Date.now() + 30_000;
    while (Date.now() < end) {
      const refs = await gitOutput(cwd, ['ls-remote', 'origin', ref]);
      if (refs.split('\t')[0] === expectedSha) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`push-to-visible timed out for ${ref}`);
  }
  activeWorkload = 'cleanup';
  if (createdRemote && !args.keep) {
    const cleanupErrors = [];
    try {
      if (subscribed) {
        benchStack('unsubscribe');
        subscribed = false;
      }
      const deleted = await api(`/api/v1/repos/${owner}/${repo}`, 'DELETE');
      if (![200, 202, 204, 404].includes(deleted.status)) throw new Error(`scratch repo cleanup failed: HTTP ${deleted.status}`);
      const readback = await api(`/api/v1/repos/${owner}/${repo}`);
      if (readback.status !== 404) throw new Error(`scratch repo cleanup readback was HTTP ${readback.status}`);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error(`scratch repository cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
      process.exitCode = 1;
    } else {
      remoteDeleted = true;
    }
  }
  const report = {
    meta: {
      git: (await new Promise((resolve) => { const child = spawn('git', ['--version']); let s = ''; child.stdout.on('data', (d) => (s += d)); child.on('close', () => resolve(s.trim())); })),
      node: process.version, os: `${platform()} ${release()}`, cpus: cpus().length,
      target: local ? 'local' : base.host, args: { ...args, target }, seed, ts,
    },
    workloads: results,
    requests: requestRows,
  };
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  if (args.write) {
    if (local && !args['write-local']) throw new Error('refusing to write local-target results to docs without --write-local');
    const docs = resolve('docs/benchmarks');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'git-storm.json'), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(docs, 'git-storm.md'), `# Git storm benchmark\n\n| Workload | n | p50 ms | p90 ms | Errors |\n|---|---:|---:|---:|---:|\n${Object.entries(results).map(([name, value]) => `| ${name} | ${value.metrics.latencyMs.n} | ${value.metrics.latencyMs.p50 ?? '—'} | ${value.metrics.latencyMs.p90 ?? '—'} | ${Object.values(value.errors).reduce((a, b) => a + b, 0)} |`).join('\n')}\n`);
  }
  console.log(`git-storm report: ${outFile}`);
  if (Object.values(results).some((result) =>
    result.metrics.giveUps > 0 || Object.values(result.errors).some((count) => count > 0))) process.exitCode = 1;
} finally {
  if (proxy) await new Promise((resolve) => proxy.close(resolve));
  if (localBackend) await new Promise((resolve) => localBackend.close(resolve));
  if (createdRemote && !args.keep && !remoteDeleted) {
    activeWorkload = 'cleanup';
    let cleanupError;
    try {
      if (subscribed) {
        benchStack('unsubscribe');
        subscribed = false;
      }
      const deleted = await api(`/api/v1/repos/${owner}/${repo}`, 'DELETE');
      if (![200, 202, 204, 404].includes(deleted.status)) {
        cleanupError = new Error(`scratch repo cleanup failed: HTTP ${deleted.status}`);
      } else {
        const readback = await api(`/api/v1/repos/${owner}/${repo}`);
        if (readback.status !== 404) cleanupError = new Error(`scratch repo cleanup readback was HTTP ${readback.status}`);
      }
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      console.error(`scratch repository cleanup failed: ${cleanupError.message ?? cleanupError}`);
      process.exitCode = 1;
    } else {
      remoteDeleted = true;
    }
  }
  rmSync(work, { recursive: true, force: true });
}
