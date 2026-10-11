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

  it('gives repository commands only the allowlisted environment and disables git prompts', async () => {
    const injected = {
      FORGE_PAT: 'forge_pat_runner_secret',
      FORGE_PAT_BOT: 'forge_pat_bot_secret',
      FORGE_PAT_NO_CI: 'forge_pat_no_ci_secret',
      FORGE_PAT_ALIASED: 'forge_pat_aliased_secret',
      FORGE_OTHER_SECRET: 'forge_other_secret',
      GIT_ASKPASS: '/secret/askpass',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_OTHER_SECRET: 'git_other_secret',
      GIT_TERMINAL_PROMPT: '1',
      RUNNER_UNRELATED_SECRET: 'unrelated_secret',
      LANG: 'C',
      LC_FORGE_TEST: 'C',
      TZ: 'UTC',
      TMPDIR: process.env.TMPDIR ?? root,
    };
    const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      const script =
        "process.stdout.write(JSON.stringify({path:process.env.PATH,home:process.env.HOME,lang:process.env.LANG,lc:process.env.LC_FORGE_TEST,tz:process.env.TZ,tmpdir:process.env.TMPDIR,prompt:process.env.GIT_TERMINAL_PROMPT,unrelated:process.env.RUNNER_UNRELATED_SECRET,leaked:Object.fromEntries(Object.entries(process.env).filter(([key])=>(key.startsWith('FORGE_')||key.startsWith('GIT_'))&&key!=='GIT_TERMINAL_PROMPT'))}))";
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
      const result = await executeShell(command, root, 5);
      expect(result).toMatchObject({ code: 0, timedOut: false });
      expect(JSON.parse(result.stdout)).toEqual({
        path: process.env.PATH,
        home: process.env.HOME,
        lang: 'C',
        lc: 'C',
        tz: 'UTC',
        tmpdir: injected.TMPDIR,
        prompt: '0',
        leaked: {},
      });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

  it('UTF-8 safely truncates a byte-edge report while preserving its result metadata', async () => {
    const sha = 'f'.repeat(40);
    const stdout = '😀'.repeat(16_100);
    const stderr = 'stderr 😀';
    let report: any;
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        return Response.json({
          job: { id: 'job-byte-edge', name: 'build', command: 'node build.js', sha, generation: 4, timeoutSeconds: 10 },
        });
      }
      if (path.endsWith('/report')) {
        report = body;
        return Response.json({ run: { status: body.conclusion } });
      }
      return Response.json({});
    };

    const result = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'p',
      repo: 'cynthia/demo',
      once: true,
      runnerId: 'runner-byte-edge',
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha };
      },
      execute: async () => ({ code: 0, stdout, stderr, timedOut: false, durationMs: 17 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
    });

    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(report.conclusion).toBe('success');
    expect(report.summary).toMatchObject({
      command: 'node build.js',
      exitCode: 0,
      timedOut: false,
      durationMs: 17,
      stderr,
      source: 'snapshot',
      sha,
    });
    expect(report.summary.stdout).not.toBe(stdout);
    expect(report.summary.stdout).toMatch(/^(?:😀)*\n\[output truncated\]\n$/u);
    expect(report.summary.stdout).not.toContain('\uFFFD');
    expect(new TextEncoder().encode(JSON.stringify(report.summary)).length).toBeLessThanOrEqual(65_536 - 1_024);
  });

  it('leaves a fitting multibyte report unchanged', async () => {
    const sha = '9'.repeat(40);
    const stdout = '😀'.repeat(16_000);
    const stderr = 'fits 😀';
    let report: any;
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        return Response.json({
          job: { id: 'job-fits', name: 'build', command: 'node build.js', sha, generation: 2, timeoutSeconds: 10 },
        });
      }
      if (path.endsWith('/report')) {
        report = body;
        return Response.json({ run: { status: body.conclusion } });
      }
      return Response.json({});
    };

    const result = await runRunner({
      baseUrl: 'https://forge.test',
      pat: 'p',
      repo: 'cynthia/demo',
      once: true,
      runnerId: 'runner-fits',
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha };
      },
      execute: async () => ({ code: 0, stdout, stderr, timedOut: false, durationMs: 19 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
    });

    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(report.conclusion).toBe('success');
    expect(report.summary).toEqual({
      command: 'node build.js',
      exitCode: 0,
      timedOut: false,
      durationMs: 19,
      stdout,
      stderr,
      source: 'snapshot',
      sha,
    });
    expect(new TextEncoder().encode(JSON.stringify(report.summary)).length).toBeLessThanOrEqual(65_536 - 1_024);
  });
});
