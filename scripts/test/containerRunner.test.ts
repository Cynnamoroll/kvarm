/**
 * The Container CI runner writes the `kvarm runner` modules into its
 * container with one `node -e` exec and runs one job with per-exec
 * environment only. These tests run that exact payload with local node: the
 * committed module matches apps/cli/src, the writer lays the files out, and
 * the entry claims, snapshot-checks-out, runs and reports one job, exiting 3
 * when nothing is queued.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { OUTPUT, renderRunnerSource } from '../gen-container-runner-source.mjs';
import { WRITE_FILES_SCRIPT, containerRunnerFiles, runnerExecEnv } from '../../apps/platform/src/containers/runnerFiles';
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
