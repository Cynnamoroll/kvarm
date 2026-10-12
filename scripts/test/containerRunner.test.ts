/**
 * The Container CI runner writes the `kvarm runner` modules into its
 * container with one `node -e` exec and runs one job with per-exec
 * environment only. These tests run that exact payload with local node: the
 * committed module matches apps/cli/src, the writer lays the files out, and
 * the entry claims, snapshot-checks-out, runs and reports one job, exiting 3
 * when nothing is queued.
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { OUTPUT, renderRunnerSource } from '../gen-container-runner-source.mjs';
import { type ContainerLike, prepareAndRunJob } from '../../apps/platform/src/containers/ciRunnerJob';
import { PREPARED_LINE, WRITE_FILES_SCRIPT, containerRunnerFiles, runnerExecEnv } from '../../apps/platform/src/containers/runnerFiles';
import { git, startServer, tarFromCommit, tempDir } from '../../apps/cli/test/helpers';

const root = tempDir('kvarm-container-runner-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(cmd: string[], env: Record<string, string>, stdin?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Like ctx.container.exec(): only the given variables plus PATH.
    const child = spawn(cmd[0]!, cmd.slice(1), { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += String(c)));
    child.stderr.on('data', (c) => (stderr += String(c)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

describe('container runner payload', () => {
  it('the committed runner source matches apps/cli/src', () => {
    expect(readFileSync(OUTPUT, 'utf8')).toBe(renderRunnerSource());
  });

  it('writes the runner, then claims, checks out the snapshot, runs and reports one job with the per-exec token', async () => {
    const dir = join(root, 'opt', 'kvarm-runner');
    const files = containerRunnerFiles();
    const wrote = await run(['node', '-e', WRITE_FILES_SCRIPT], {}, JSON.stringify({ dir, files }));
    expect(wrote).toMatchObject({ code: 0 });
    for (const name of ['runner.js', 'checkout.js', 'workdir.js', 'git.js', 'http.js', 'untar.js', 'run.mjs', 'package.json']) {
      expect(existsSync(join(dir, name))).toBe(true);
    }

    const work = join(root, 'repo');
    mkdirSync(work);
    git(work, ['init', '-q', '-b', 'main']);
    writeFileSync(join(work, 'marker.txt'), 'container-marker\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'marker']);
    const sha = git(work, ['rev-parse', 'HEAD']);
    const tar = tarFromCommit(work, sha);
    const reports: any[] = [];
    let queued = true;
    const api = await startServer(root, async (req, res, body) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (path === '/api/v1/repos/o/r/ci/jobs/claim') {
        if (!queued) return res.writeHead(204).end(), true;
        queued = false;
        json(200, { job: { id: 'job-1', name: 'test', command: 'cat marker.txt', sha, generation: 1, timeoutSeconds: 30 } });
        return true;
      }
      if (path === `/api/v1/repos/o/r/snapshots/${sha}` && req.method === 'POST') return json(200, { state: 'ready', sha, size: tar.length }), true;
      if (path === `/api/v1/repos/o/r/snapshots/${sha}/download`) return res.writeHead(200, { 'x-kvarm-snapshot-sha': sha }).end(Buffer.from(tar)), true;
      if (path === '/api/v1/repos/o/r/ci/jobs/job-1/report') return reports.push(JSON.parse(body.toString())), json(200, { run: { id: 'run-1' } }), true;
      return json(404, { error: 'not found' }), true;
    });
    try {
      const env = runnerExecEnv({ baseUrl: api.url, token: 'kvarm_pat_container_secret', repo: 'o/r', runnerId: 'container-runner-1', workRoot: join(root, 'work-root') });
      expect(Object.keys(env).sort()).toEqual(['HOME', 'KVARM_BASE_URL', 'KVARM_PAT', 'KVARM_REPO', 'KVARM_RUNNER_ID', 'KVARM_WORK_ROOT']);
      const first = await run(['node', join(dir, 'run.mjs')], env);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain('claimed test (job-1)');
      expect(first.stdout).not.toContain('kvarm_pat_container_secret');
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({ runnerId: 'container-runner-1', generation: 1, conclusion: 'success', summary: { exitCode: 0, source: 'snapshot', sha } });
      expect(reports[0].summary.stdout).toBe('container-marker\n');
      expect(api.requests.filter((r) => r.url.includes('/ci/jobs/')).every((r) => r.auth === 'Bearer kvarm_pat_container_secret')).toBe(true);

      const idle = await run(['node', join(dir, 'run.mjs')], env);
      expect(idle.code).toBe(3);
      expect(reports).toHaveLength(1);
    } finally {
      api.server.close();
    }
  });
});

/**
 * A stand-in for ctx.container that runs each exec as a local process (only
 * the given env plus PATH, like the real exec) and snapshots by copying the
 * container's work root, which is where the runner keeps the prepared slot.
 */
function fakeContainer(workRoot: string, snapshots: string, events: string[], onSnapshot: () => void = () => {}): ContainerLike {
  return {
    async exec(cmd, options = {}) {
      // This host has no GNU coreutils `timeout`; the real container does.
      const argv = cmd[0] === 'timeout' ? cmd.slice(3) : cmd;
      events.push(`exec ${argv[0] === 'node' && argv[1] === '-e' && argv[2] === WRITE_FILES_SCRIPT ? 'node -e <write files>' : argv.join(' ')}`);
      const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: { PATH: process.env.PATH ?? '', ...options.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      if (options.stdin) Readable.fromWeb(options.stdin as never).pipe(child.stdin);
      else child.stdin.end();
      const exitCode = new Promise<number>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => resolve(code ?? 1));
      });
      const stdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
      const stderr = Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>;
      return {
        stdout,
        stderr,
        exitCode,
        async output() {
          const [o, e, code] = await Promise.all([new Response(stdout).arrayBuffer(), new Response(stderr).arrayBuffer(), exitCode]);
          return { stdout: o, stderr: e, exitCode: code };
        },
      };
    },
    async snapshotContainer(options) {
      events.push('snapshot');
      onSnapshot();
      rmSync(snapshots, { recursive: true, force: true });
      cpSync(workRoot, snapshots, { recursive: true, verbatimSymlinks: true });
      return { id: 'snap-1', size: 1, name: options.name };
    },
  };
}

describe('container runner prepared-workspace snapshot', () => {
  it('snapshots after the claim prepared the workspace, and the restored run reuses it with no second checkout', async () => {
    const base = join(root, 'prepared');
    const runnerDir = join(base, 'opt', 'kvarm-runner');
    const workRoot = join(base, 'var', 'lib', 'kvarm-runner');
    const snapshots = join(base, 'snapshot-fs');
    const goFile = join(base, 'tmp', 'kvarm-runner-go');
    mkdirSync(join(base, 'tmp'), { recursive: true });

    const src = join(base, 'repo');
    mkdirSync(src, { recursive: true });
    git(src, ['init', '-q', '-b', 'main']);
    writeFileSync(join(src, 'limits.txt'), 'steady 10\n');
    git(src, ['add', '-A']);
    git(src, ['commit', '-q', '-m', 'head']);
    const sha = git(src, ['rev-parse', 'HEAD']);
    const tar = tarFromCommit(src, sha);

    const reports: any[] = [];
    const jobs = ['job-cold', 'job-warm'];
    let downloads = 0;
    const compares: string[] = [];
    const api = await startServer(root, async (req, res, body) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const json = (status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (path === '/api/v1/repos/o/r/ci/jobs/claim') {
        const id = jobs.shift();
        if (!id) return res.writeHead(204).end(), true;
        return json(200, { job: { id, name: 'typecheck', command: 'cat limits.txt', sha, generation: 1, timeoutSeconds: 30 } }), true;
      }
      if (path === `/api/v1/repos/o/r/snapshots/${sha}` && req.method === 'POST') return json(200, { state: 'ready', sha, size: tar.length }), true;
      if (path === `/api/v1/repos/o/r/snapshots/${sha}/download`) return downloads++, res.writeHead(200, { 'x-kvarm-snapshot-sha': sha }).end(Buffer.from(tar)), true;
      if (path.startsWith('/api/v1/repos/o/r/compare/')) return compares.push(path.slice('/api/v1/repos/o/r/compare/'.length)), json(200, { files: [], truncated: false }), true;
      if (/\/ci\/jobs\/[^/]+\/report$/.test(path)) return reports.push(JSON.parse(body.toString())), json(200, { run: { id: `run-${reports.length}` } }), true;
      if (/\/ci\/jobs\/[^/]+\/heartbeat$/.test(path)) return json(200, { job: {} }), true;
      return json(404, { error: 'not found' }), true;
    });
    const job = (cold: boolean, container: ContainerLike) =>
      prepareAndRunJob(container, {
        cold,
        started: Date.now(),
        exec: { baseUrl: api.url, token: 'kvarm_pat_container_secret', repo: 'o/r', runnerId: cold ? 'cold-runner' : 'warm-runner', workRoot },
        runnerDir,
        goFile,
        toolchain: ['node', '-e', '0'],
        snapshotName: 'kvarm-ci-workspace',
      });
    try {
      const coldEvents: string[] = [];
      let atSnapshot: { reports: number; state: boolean; work: string | null } | null = null;
      const slot = join(workRoot, 'o', 'r', 'slot-0');
      const cold = await job(
        true,
        fakeContainer(workRoot, snapshots, coldEvents, () => {
          atSnapshot = {
            reports: reports.length,
            state: existsSync(join(slot, 'state.json')),
            work: existsSync(join(slot, 'work', 'limits.txt')) ? readFileSync(join(slot, 'work', 'limits.txt'), 'utf8') : null,
          };
        }),
      );
      expect(cold.runner.exitCode, cold.runner.stderr).toBe(0);
      // The snapshot holds the claimed job's prepared workspace, taken before its command ran.
      expect(atSnapshot).toEqual({ reports: 0, state: true, work: 'steady 10\n' });
      expect(coldEvents).toEqual(['exec node --version', 'exec node -e <write files>', 'exec node -e 0', `exec node ${runnerDir}/run.mjs`, 'snapshot', `exec touch ${goFile}`]);
      expect(cold.snapshot).toEqual({ id: 'snap-1', size: 1, name: 'kvarm-ci-workspace' });
      expect(cold.phases.setup).not.toBeNull();
      expect(cold.phases.workspace).not.toBeNull();
      expect(cold.phases.snapshot).not.toBeNull();
      expect(cold.runner.stdout).toContain(PREPARED_LINE);
      expect(cold.runner.stdout).toContain('workdir: fresh');
      expect(downloads).toBe(1);
      expect(reports[0]).toMatchObject({ runnerId: 'cold-runner', conclusion: 'success', summary: { source: 'snapshot', sha, stdout: 'steady 10\n' } });
      expect(readFileSync(join(snapshots, 'o', 'r', 'slot-0.lock'), 'utf8')).toContain('"pid"');
      expect(JSON.stringify(cold)).not.toContain('kvarm_pat_container_secret');

      // Restore: the container filesystem is the snapshot, on a host with another name.
      rmSync(workRoot, { recursive: true, force: true });
      cpSync(snapshots, workRoot, { recursive: true, verbatimSymlinks: true });
      const lock = join(workRoot, 'o', 'r', 'slot-0.lock');
      writeFileSync(lock, JSON.stringify({ ...JSON.parse(readFileSync(lock, 'utf8')), host: 'the-snapshotted-container' }));
      const warmEvents: string[] = [];
      const warm = await job(false, fakeContainer(workRoot, snapshots, warmEvents));
      expect(warm.runner.exitCode, warm.runner.stderr).toBe(0);
      expect(warmEvents).toEqual(['exec node --version', `exec node ${runnerDir}/run.mjs`, `exec touch ${goFile}`]);
      expect(warm.phases).toMatchObject({ setup: null, snapshot: null });
      expect(warm.phases.workspace).not.toBeNull();
      expect(warm.snapshot).toBeNull();
      expect(warm.runner.stdout).toContain('workdir: warm');
      expect(warm.runner.stderr).not.toContain('warm sync failed');
      // No second snapshot download or checkout: the same-head warm sync asked only for an empty delta.
      expect(downloads).toBe(1);
      expect(compares).toEqual([`${sha}...${sha}`]);
      expect(existsSync(join(workRoot, 'o', 'r', 'slot-1'))).toBe(false);
      expect(reports[1]).toMatchObject({ runnerId: 'warm-runner', conclusion: 'success', summary: { source: 'delta', sha, stdout: 'steady 10\n', command: 'cat limits.txt' } });
    } finally {
      api.server.close();
    }
  });
});
