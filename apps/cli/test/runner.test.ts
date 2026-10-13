import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { executeShell, runRunner } from '../src/runner.js';
import { tempDir } from './helpers';

/** These tests exercise host execution mechanics; the trust policy has its own tests. */
const HOST_TRUSTED = { trust: 'all', hostWarning: false } as const;

const root = tempDir('kvarm-cli-runner-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('kvarm runner', () => {
  it('kills a timed-out command and its descendant process group', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"`;
    const result = await executeShell(command, root, 0.1);
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('gives repository commands only the allowlisted environment and disables git prompts', async () => {
    const injected = {
      KVARM_PAT: 'kvarm_pat_runner_secret',
      KVARM_PAT_BOT: 'kvarm_pat_bot_secret',
      KVARM_PAT_NO_CI: 'kvarm_pat_no_ci_secret',
      KVARM_PAT_ALIASED: 'kvarm_pat_aliased_secret',
      KVARM_OTHER_SECRET: 'kvarm_other_secret',
      GIT_ASKPASS: '/secret/askpass',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_OTHER_SECRET: 'git_other_secret',
      GIT_TERMINAL_PROMPT: '1',
      RUNNER_UNRELATED_SECRET: 'unrelated_secret',
      LANG: 'C',
      LC_KVARM_TEST: 'C',
      TZ: 'UTC',
      TMPDIR: process.env.TMPDIR ?? root,
    };
    const previous = Object.fromEntries(Object.keys(injected).map((key) => [key, process.env[key]]));
    Object.assign(process.env, injected);
    try {
      const script =
        "process.stdout.write(JSON.stringify({path:process.env.PATH,home:process.env.HOME,lang:process.env.LANG,lc:process.env.LC_KVARM_TEST,tz:process.env.TZ,tmpdir:process.env.TMPDIR,prompt:process.env.GIT_TERMINAL_PROMPT,unrelated:process.env.RUNNER_UNRELATED_SECRET,leaked:Object.fromEntries(Object.entries(process.env).filter(([key])=>(key.startsWith('KVARM_')||key.startsWith('GIT_'))&&key!=='GIT_TERMINAL_PROMPT'))}))";
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
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'kvarm_pat_test',
      repo: 'alice/demo',
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
      '/api/v1/repos/alice/demo/ci/jobs/claim',
      '/api/v1/repos/alice/demo/ci/jobs/job-1/report',
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
      if (path.endsWith('/report')) reports.push(body);
      return Response.json({ run: { status: 'failure' } });
    };
    const checkoutFn = async (o: any) => {
      mkdirSync(o.dir, { recursive: true });
      return { source: 'clone' as const, sha: 'c'.repeat(40) };
    };
    const first = await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
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
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
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
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
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
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
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
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
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
      executor: 'host',
    });
    expect(new TextEncoder().encode(JSON.stringify(report.summary)).length).toBeLessThanOrEqual(65_536 - 1_024);
  });

  it('grows the idle claim delay from 2 s to a 10 s cap', async () => {
    const { idleDelayMs } = await import('../src/runner.js');
    expect([0, 1, 2, 3, 4, 5, 12].map((consecutive) => idleDelayMs(consecutive))).toEqual([
      2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000,
    ]);
  });

  it('waits adaptively between idle claims, resets after a job, and polls exactly one claim per wait', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const claims: number[] = [];
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push(path);
        if (path.endsWith('/claim')) {
          claims.push(Date.now());
          if (claims.length === 4) {
            return Response.json({ job: { id: 'j', name: 'build', command: 'true', sha: 'b'.repeat(40), generation: 1, timeoutSeconds: 30 } });
          }
          // A refused claim (bad credentials) ends the loop; a retriable one never would.
          if (claims.length >= 7) return Response.json({ error: 'runner stopped' }, { status: 401 });
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
        return Response.json({});
      };
      const run = runRunner({
      ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'alice/demo',
        apiFetch,
        checkoutFn: async (o: any) => {
          mkdirSync(o.dir, { recursive: true });
          return { source: 'snapshot' as const, sha: o.ref };
        },
        execute: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
        stdout: () => {},
        stderr: () => {},
        tempRoot: root,
        workRoot: join(root, 'backoff-work'),
      });
      const done = expect(run).rejects.toThrow(/runner stopped/);
      await vi.advanceTimersByTimeAsync(30_000);
      await done;
      const waits = claims.slice(1).map((t, i) => t - claims[i]!);
      expect(waits).toEqual([2_000, 4_000, 8_000, 0, 2_000, 4_000]);
      // Each idle poll is one claim; the only other call is the job's report.
      const nonClaim = calls.filter((c) => !c.endsWith('/claim'));
      expect(nonClaim).toHaveLength(1);
      expect(nonClaim[0]).toMatch(/\/report$/);
      expect(calls.filter((c) => c.endsWith('/claim'))).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drainUntilEmpty exits as soon as a claim finds no job, reporting every job it claimed', async () => {
    const jobs = [
      { id: 'j1', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 },
      { id: 'j2', name: 'test', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 },
    ];
    const claims: number[] = [];
    const reports: any[] = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        claims.push(Date.now());
        const job = jobs.shift();
        return job ? Response.json({ job }) : new Response(null, { status: 204 });
      }
      if (path.endsWith('/report')) {
        reports.push(body);
        return Response.json({ run: { status: 'success' } });
      }
      return Response.json({});
    };
    const result = await runRunner({
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      apiFetch,
      // The jobs carry no provenance; without host trust a runner with docker reachable would run them in containers.
      ...HOST_TRUSTED,
      drainUntilEmpty: true,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha: o.ref };
      },
      execute: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'drain-work'),
    });
    expect(result).toEqual({ claimed: 2, reported: 2 });
    // Two jobs claimed, then one empty claim that ends the drain; no idle backoff in between.
    expect(claims).toHaveLength(3);
    expect(claims[1]! - claims[0]!).toBeLessThan(2_000);
    expect(reports.map((r: any) => r.runnerId)).toHaveLength(2);
  });

  it('retries a claim on a 429, a network error and a 5xx, honoring Retry-After, and keeps serving', async () => {
    vi.useFakeTimers();
    try {
      const claims: number[] = [];
      const stderr: string[] = [];
      let claim = 0;
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path.endsWith('/claim')) {
          claims.push(Date.now());
          claim++;
          if (claim === 1) return Response.json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } });
          if (claim === 2) throw new TypeError('fetch failed');
          if (claim === 3) return Response.json({ error: 'storage unavailable' }, { status: 503 });
          return Response.json({ job: { id: 'j-r', name: 'build', command: 'true', sha: 'b'.repeat(40), generation: 1, timeoutSeconds: 30 } });
        }
        if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
        return Response.json({});
      };
      const run = runRunner({
        ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'alice/demo',
        once: true,
        apiFetch,
        checkoutFn: async (o: any) => {
          mkdirSync(o.dir, { recursive: true });
          return { source: 'snapshot' as const, sha: o.ref };
        },
        execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
        stdout: () => {},
        stderr: (l) => stderr.push(l),
        tempRoot: root,
        workRoot: join(root, 'claim-retry-work'),
      });
      // Retry-After 3 s is honored exactly; the doubling ramp for the network
      // error and the 503 stays within 4 s and 8 s even with jitter.
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await run;
      expect(result).toEqual({ claimed: 1, reported: 1 });
      expect(claims).toHaveLength(4);
      expect(claims[1]! - claims[0]!).toBe(3_000);
      expect(claims[2]! - claims[1]!).toBeGreaterThanOrEqual(2_000);
      expect(claims[2]! - claims[1]!).toBeLessThan(4_000);
      expect(claims[3]! - claims[2]!).toBeGreaterThanOrEqual(4_000);
      expect(claims[3]! - claims[2]!).toBeLessThan(8_000);
      expect(stderr[0]).toBe('claim failed: ci/jobs/claim: slow down; retrying in 3.0 s');
      expect(stderr[1]).toMatch(/^claim failed: fetch failed; retrying in ([23]\.\d|4\.0) s$/);
      expect(stderr[2]).toMatch(/^claim failed: ci\/jobs\/claim: storage unavailable; retrying in ([4-7]\.\d|8\.0) s$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays fatal on a refused claim: bad credentials are actionable, not retriable', async () => {
    let claims = 0;
    const apiFetch = async () => {
      claims++;
      return Response.json({ error: 'unauthorized', code: 'INVALID_TOKEN' }, { status: 401 });
    };
    await expect(
      runRunner({
        ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'alice/demo',
        once: true,
        apiFetch,
        checkoutFn: async () => {
          throw new Error('never claimed');
        },
        execute: async () => {
          throw new Error('never ran');
        },
        stdout: () => {},
        stderr: () => {},
        tempRoot: root,
        workRoot: join(root, 'claim-fatal-work'),
      }),
    ).rejects.toThrow(/unauthorized \(INVALID_TOKEN\)/);
    expect(claims).toBe(1);
  });

  it('treats a malformed claim as a failed claim and retries it, never a crash', async () => {
    vi.useFakeTimers();
    try {
      const claims: string[] = [];
      const stderr: string[] = [];
      const replies = [
        { job: { id: 'm1', name: 'build', command: 'true', sha: 'a'.repeat(40), timeoutSeconds: 30, generation: 0 } },
        { job: { id: 'm2', name: 'build', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 } },
        { job: { id: 'm3', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 2, timeoutSeconds: 30 } },
      ];
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path.endsWith('/claim')) {
          const next = replies.shift();
          claims.push(next ? String(next.job.id) : 'gone');
          return next ? Response.json(next) : new Response(null, { status: 204 });
        }
        if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
        return Response.json({});
      };
      const run = runRunner({
        ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'alice/demo',
        once: true,
        apiFetch,
        checkoutFn: async (o: any) => {
          mkdirSync(o.dir, { recursive: true });
          return { source: 'snapshot' as const, sha: o.ref };
        },
        execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
        stdout: () => {},
        stderr: (l) => stderr.push(l),
        tempRoot: root,
        workRoot: join(root, 'claim-malformed-work'),
      });
      await vi.advanceTimersByTimeAsync(8_000);
      const result = await run;
      expect(result).toEqual({ claimed: 1, reported: 1 });
      expect(claims).toEqual(['m1', 'm2', 'm3']);
      expect(stderr.filter((l) => l.startsWith('claim failed:'))).toHaveLength(2);
      expect(stderr[0]).toMatch(/^claim failed: claim returned an invalid job; retrying in (1\.\d|2\.0) s$/);
      expect(stderr[1]).toMatch(/^claim failed: claim returned an invalid job; retrying in ([23]\.\d|4\.0) s$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a claimed job whose timeoutSeconds is out of range at the platform default', async () => {
    const timeouts: number[] = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        return Response.json({ job: { id: 'j-t', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 'fast' } });
      }
      if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
      return Response.json({});
    };
    const result = await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha: o.ref };
      },
      execute: async (_command, _cwd, timeoutSeconds) => {
        timeouts.push(timeoutSeconds);
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      },
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'claim-timeout-work'),
    });
    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(timeouts).toEqual([900]);
  });

  it('derives the claim retry delay from Retry-After, else a doubling ramp to a 60 s cap', async () => {
    const { claimRetryMs } = await import('../src/runner.js');
    expect(claimRetryMs('7', 0)).toBe(7_000);
    expect(claimRetryMs('120', 0)).toBe(60_000);
    expect(claimRetryMs('soon', 0)).toBe(2_000);
    expect(claimRetryMs(null, 0)).toBe(2_000);
    expect(claimRetryMs(null, 1)).toBe(4_000);
    expect(claimRetryMs(null, 2)).toBe(8_000);
    expect(claimRetryMs(null, 12)).toBe(60_000);
  });

  it('keeps claiming after a fenced-away report (409 STALE_GENERATION) instead of dying with it', async () => {
    vi.useFakeTimers();
    try {
      let reports = 0;
      const claims: string[] = [];
      let jobClaimed = false;
      const stderr: string[] = [];
      const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (path.endsWith('/claim')) {
          if (!jobClaimed) {
            jobClaimed = true;
            claims.push('job');
            return Response.json({ job: { id: 'job-x', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 5, timeoutSeconds: 30 } });
          }
          claims.push('after-report');
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        if (path.endsWith('/report')) {
          reports++;
          return Response.json({ error: 'the CI job claim is stale', code: 'STALE_GENERATION' }, { status: 409 });
        }
        return Response.json({});
      };
      const run = runRunner({
        ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'alice/demo',
        apiFetch,
        checkoutFn: async (o: any) => {
          mkdirSync(o.dir, { recursive: true });
          return { source: 'snapshot' as const, sha: o.ref };
        },
        execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
        stdout: () => {},
        stderr: (l) => stderr.push(l),
        tempRoot: root,
        workRoot: join(root, 'report-fenced-work'),
      });
      const done = expect(run).rejects.toThrow(/unauthorized/);
      // Three report attempts (250 ms and 500 ms between them), then the loop claims again.
      await vi.advanceTimersByTimeAsync(3_000);
      await done;
      expect(reports).toBe(3);
      expect(claims).toEqual(['job', 'after-report']);
      expect(stderr.filter((l) => l.startsWith('warning:'))).toEqual([
        'warning: could not report build (job-x) after 3 attempts: ci/jobs/job-x/report: the CI job claim is stale (STALE_GENERATION); the platform requeues the job when the lease expires',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('materializes a warm job through the compare delta without a checkout and reports source delta', async () => {
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const blobSha = (content: string) => {
      const bytes = Buffer.from(content);
      return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    };
    const jobs = [
      { id: 'ja', name: 'build', command: 'true', sha: a, generation: 1, timeoutSeconds: 30 },
      { id: 'jb', name: 'build', command: 'true', sha: b, generation: 1, timeoutSeconds: 30 },
    ];
    let checkouts = 0;
    const contentsGets: string[] = [];
    const reports: any[] = [];
    const stdout: string[] = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (path.endsWith('/claim')) {
        const next = jobs.shift();
        return next ? Response.json({ job: next }) : new Response(null, { status: 204 });
      }
      if (path.endsWith('/report')) {
        reports.push(body);
        return Response.json({ run: { status: body.conclusion } });
      }
      if (path === `/api/v1/repos/alice/demo/compare/${a}...${b}`) {
        return Response.json({
          files: [
            { path: 'a.txt', status: 'modified', oldHash: blobSha('v1\n'), newHash: blobSha('v2\n'), oldMode: '100644', newMode: '100644' },
          ],
          truncated: false,
        });
      }
      if (path === '/api/v1/repos/alice/demo/contents') {
        contentsGets.push(String(url.searchParams.get('path')));
        return Response.json({ ref: b, path: 'a.txt', size: 4, encoding: 'utf-8', content: 'v2\n' });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    const options = {
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        checkouts++;
        mkdirSync(o.dir, { recursive: true });
        writeFileSync(join(o.dir, 'a.txt'), o.ref === a ? 'v1\n' : 'v2\n');
        writeFileSync(join(o.dir, 'b.txt'), 'same\n');
        return { source: 'snapshot' as const, sha: o.ref };
      },
      execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
      stdout: (line: string) => stdout.push(line),
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'delta-work'),
    };
    const first = await runRunner(options);
    expect(first).toEqual({ claimed: 1, reported: 1 });
    expect(stdout.join('\n')).toContain('workdir: fresh');
    expect(stdout.join('\n')).not.toContain('workdir: warm');
    expect(checkouts).toBe(1);

    const second = await runRunner(options);
    expect(second).toEqual({ claimed: 1, reported: 1 });
    // The warm job used the delta: no second checkout, one compare, one file transfer.
    expect(checkouts).toBe(1);
    expect(contentsGets).toEqual(['a.txt']);
    expect(stdout.join('\n')).toContain('workdir: warm');
    expect(reports[1]).toMatchObject({ conclusion: 'success', summary: { sha: b, source: 'delta' } });
    const work = join(root, 'delta-work', 'alice', 'demo', 'slot-0', 'work');
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(work, 'b.txt'), 'utf8')).toBe('same\n');
  });

  it('falls back to a full checkout when the delta exceeds the changed-path budget', async () => {
    const a = 'a'.repeat(40);
    const c = 'c'.repeat(40);
    const jobs = [
      { id: 'ka', name: 'build', command: 'true', sha: a, generation: 1, timeoutSeconds: 30 },
      { id: 'kc', name: 'build', command: 'true', sha: c, generation: 1, timeoutSeconds: 30 },
    ];
    let checkouts = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const apiFetch = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/claim')) {
        const next = jobs.shift();
        return next ? Response.json({ job: next }) : new Response(null, { status: 204 });
      }
      if (path.endsWith('/report')) return Response.json({ run: { status: 'success' } });
      if (path === `/api/v1/repos/alice/demo/compare/${a}...${c}`) {
        return Response.json({
          files: Array.from({ length: 1_500 }, (_, i) => ({
            path: `f${i}.txt`,
            status: 'added',
            oldHash: null,
            oldMode: null,
            newHash: String(i).padStart(40, '0'),
            newMode: '100644',
          })),
          truncated: false,
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    const options = {
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        checkouts++;
        mkdirSync(o.dir, { recursive: true });
        writeFileSync(join(o.dir, 'seed.txt'), `seed ${o.ref}\n`);
        return { source: 'snapshot' as const, sha: o.ref };
      },
      execute: async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 }),
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      tempRoot: root,
      workRoot: join(root, 'delta-budget-work'),
    };
    const first = await runRunner(options);
    expect(first).toEqual({ claimed: 1, reported: 1 });
    const second = await runRunner(options);
    expect(second).toEqual({ claimed: 1, reported: 1 });
    expect(checkouts).toBe(2);
    expect(stderr.join('\n')).toMatch(/warm sync failed: .*warm budget/);
    expect(stdout.join('\n')).not.toContain('workdir: warm');
    const work = join(root, 'delta-budget-work', 'alice', 'demo', 'slot-0', 'work');
    expect(readFileSync(join(work, 'seed.txt'), 'utf8')).toBe(`seed ${c}\n`);
  });

  /** One queued job; records every call path and report body. */
  function preparedPlatform(sha: string) {
    const calls: string[] = [];
    const reports: any[] = [];
    let queued = true;
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push(path.slice('/api/v1/repos/alice/demo/'.length));
      if (path.endsWith('/claim')) {
        if (!queued) return new Response(null, { status: 204 });
        queued = false;
        return Response.json({ job: { id: 'job-p', name: 'build', command: 'build', sha, generation: 2, timeoutSeconds: 30 } });
      }
      if (path.endsWith('/heartbeat')) return Response.json({ job: {} });
      if (path.endsWith('/report')) return reports.push(body), Response.json({ run: { status: body.conclusion } });
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    return { apiFetch, calls, reports };
  }

  it('awaits the prepared hook after the workspace is materialized and before the command runs, heartbeating meanwhile', async () => {
    const sha = 'd'.repeat(40);
    const platform = preparedPlatform(sha);
    const order: string[] = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const result = await runRunner({
      ...HOST_TRUSTED,
        baseUrl: 'https://kvarm.test',
        pat: 'kvarm_pat_test',
        repo: 'alice/demo',
        once: true,
        runnerId: 'runner-prepared',
        apiFetch: platform.apiFetch,
        checkoutFn: async (o: any) => {
          order.push('checkout');
          mkdirSync(o.dir, { recursive: true });
          writeFileSync(join(o.dir, 'seed.txt'), 'seed\n');
          return { source: 'snapshot' as const, sha: o.ref };
        },
        prepared: async (info) => {
          order.push(`prepared ${info.job.id} ${info.job.sha === sha} ${info.workdir} ${info.source}`);
          expect(readFileSync(join(info.work, 'seed.txt'), 'utf8')).toBe('seed\n');
          // The lease stays alive while the caller holds the job at the prepared point.
          vi.advanceTimersByTime(40_000);
          await new Promise((r) => setTimeout(r, 0));
          order.push('released');
        },
        execute: async () => {
          order.push('execute');
          return { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 };
        },
        stdout: () => {},
        stderr: () => {},
        tempRoot: root,
        workRoot: join(root, 'prepared-work'),
      });
      expect(result).toEqual({ claimed: 1, reported: 1 });
    } finally {
      vi.useRealTimers();
    }
    expect(order).toEqual(['checkout', `prepared job-p true fresh snapshot`, 'released', 'execute']);
    expect(platform.calls).toEqual(['ci/jobs/claim', 'ci/jobs/job-p/heartbeat', 'ci/jobs/job-p/report']);
    expect(platform.reports[0]).toMatchObject({ conclusion: 'success', generation: 2 });
  });

  it('reports failure without running the command when the prepared hook fails', async () => {
    const sha = 'e'.repeat(40);
    const platform = preparedPlatform(sha);
    let executed = false;
    const result = await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'kvarm_pat_test',
      repo: 'alice/demo',
      once: true,
      apiFetch: platform.apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha: o.ref };
      },
      prepared: async () => {
        throw new Error('no go signal after the workspace was prepared');
      },
      execute: async () => {
        executed = true;
        return { code: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 };
      },
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'prepared-fail-work'),
    });
    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(executed).toBe(false);
    expect(platform.reports[0]).toMatchObject({ conclusion: 'failure', summary: { stderr: 'no go signal after the workspace was prepared' } });
  });
});
