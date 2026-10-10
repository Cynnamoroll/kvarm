import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { executeShell, runRunner } from '../src/runner.js';
import { tempDir } from './helpers';

const root = tempDir('forge-cli-runner-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('forge runner', () => {
  it('kills a timed-out command and its descendant process group', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"`;
    const result = await executeShell(command, root, 0.1);
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('does not expose the runner PAT to repository commands', async () => {
    const previous = process.env.FORGE_PAT;
    process.env.FORGE_PAT = 'forge_pat_runner_secret';
    try {
      const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.FORGE_PAT || 'absent')"`;
      const result = await executeShell(command, root, 5);
      expect(result).toMatchObject({ code: 0, stdout: 'absent', timedOut: false });
    } finally {
      if (previous === undefined) delete process.env.FORGE_PAT;
      else process.env.FORGE_PAT = previous;
    }
  });

  it('claims, checks out the exact immutable sha, runs the command and reports its summary', async () => {
    const sha = 'a'.repeat(40);
    const calls: Array<{ path: string; body: any }> = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path.endsWith('/claim')) {
        return Response.json({
          job: {
            id: 'job-1',
            name: 'build',
            command: 'cat ci-marker.txt',
            sha,
            treeSha: 'b'.repeat(40),
            generation: 3,
            runnerId: body.runnerId,
            timeoutSeconds: 30,
          },
        });
      }
      if (path.endsWith('/heartbeat')) return Response.json({ job: { leaseUntil: new Date(Date.now() + 120_000).toISOString() } });
      if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const checkoutFn = async (o: any) => {
      mkdirSync(o.dir, { recursive: true });
      writeFileSync(join(o.dir, 'ci-marker.txt'), 'marker-at-head\n');
      expect(o.ref).toBe(sha);
      return { source: 'snapshot' as const, sha, bytes: 1, files: 1 };
    };
    const execute = async (command: string, cwd: string) => ({
      code: readFileSync(join(cwd, 'ci-marker.txt'), 'utf8') === 'marker-at-head\n' && command === 'cat ci-marker.txt' ? 0 : 1,
      stdout: 'marker-at-head\n',
      stderr: '',
      timedOut: false,
      durationMs: 12,
    });

    const result = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'forge_pat_test',
      repo: 'cynthia/demo',
      once: true,
      runnerId: 'runner-test',
      apiFetch,
      checkoutFn,
      execute,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      tempRoot: root,
    });
    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(calls.map((c) => c.path)).toEqual([
      '/api/v1/repos/cynthia/demo/ci/jobs/claim',
      '/api/v1/repos/cynthia/demo/ci/jobs/job-1/report',
    ]);
    expect(calls[1]!.body).toMatchObject({
      runnerId: 'runner-test',
      generation: 3,
      conclusion: 'success',
      summary: { command: 'cat ci-marker.txt', exitCode: 0, timedOut: false, stdout: 'marker-at-head\n' },
    });
    expect(stdout.join('\n')).toMatch(/claimed build.*reported success/s);
    expect(stderr).toEqual([]);
  });

  it('reports a failed or timed-out command as failure and exits cleanly when no job is queued', async () => {
    let claims = 0;
    const reports: any[] = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        claims++;
        return claims === 1
          ? Response.json({ job: { id: 'job-2', name: 'test', command: 'exit 1', sha: 'c'.repeat(40), treeSha: 'd'.repeat(40), generation: 1, runnerId: body.runnerId, timeoutSeconds: 1 } })
          : new Response(null, { status: 204 });
      }
      reports.push(body);
      return Response.json({ run: { status: 'failure' } });
    };
    const checkoutFn = async (o: any) => {
      mkdirSync(o.dir, { recursive: true });
      return { source: 'clone' as const, sha: 'c'.repeat(40) };
    };
    const first = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'p',
      repo: 'cynthia/demo',
      once: true,
      runnerId: 'r',
      apiFetch,
      checkoutFn,
      execute: async () => ({ code: null, stdout: '', stderr: 'timed out', timedOut: true, durationMs: 1000 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
    });
    expect(first).toEqual({ claimed: 1, reported: 1 });
    expect(reports[0]).toMatchObject({ conclusion: 'failure', summary: { timedOut: true, stderr: 'timed out' } });
    const empty = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'p',
      repo: 'cynthia/demo',
      once: true,
      runnerId: 'r',
      apiFetch,
      checkoutFn,
      execute: async () => {
        throw new Error('not called');
      },
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
    });
    expect(empty).toEqual({ claimed: 0, reported: 0 });
  });

  it('retries the original successful report without changing its conclusion', async () => {
    const reports: any[] = [];
    let reportAttempts = 0;
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        return Response.json({
          job: { id: 'job-retry', name: 'build', command: 'true', sha: 'e'.repeat(40), generation: 1, timeoutSeconds: 10 },
        });
      }
      if (path.endsWith('/report')) {
        reports.push(body);
        reportAttempts++;
        if (reportAttempts === 1) return Response.json({ error: 'temporary' }, { status: 503 });
        return Response.json({ run: { status: 'success' } });
      }
      return Response.json({});
    };
    const result = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'p',
      repo: 'cynthia/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha: 'e'.repeat(40) };
      },
      execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
    });
    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(reports).toHaveLength(2);
    expect(reports.map((r) => r.conclusion)).toEqual(['success', 'success']);
  });
});
