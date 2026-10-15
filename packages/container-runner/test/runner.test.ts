import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { budgetDeltaReader, executeShell, runRunner } from '../src/runner.js';
import { tempDir } from './helpers';

/** These tests exercise host execution mechanics; the trust policy has its own tests. */
const HOST_TRUSTED = { trust: 'all', hostWarning: false } as const;

const root = tempDir('kvarm-cli-runner-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

type RunnerJob = Record<string, any>;

/**
 * The runner API the platform serves: a job queue behind /claim, a lease
 * answer behind /heartbeat, /report capturing bodies, and 404 for the rest
 * (`opts.route` serves extra paths first). `opts.claim`/`opts.report`
 * override a call's response by its 1-based index, for scripted sequences.
 */
function fakeRunnerApi(
  jobs: RunnerJob[] = [],
  opts: {
    claim?: (n: number, body: any) => Response;
    report?: (n: number, body: any) => Response;
    route?: (path: string, url: URL, body: any) => Response | undefined;
  } = {},
) {
  const calls: Array<{ path: string; body: any }> = [];
  const reports: any[] = [];
  /** Date.now() per claim, for backoff assertions under fake timers. */
  const claims: number[] = [];
  const queue = [...jobs];
  const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (path.endsWith('/claim')) {
      claims.push(Date.now());
      if (opts.claim) return opts.claim(claims.length, body);
      const next = queue.shift();
      return next ? Response.json({ job: { runnerId: body.runnerId, ...next } }) : new Response(null, { status: 204 });
    }
    if (path.endsWith('/heartbeat')) {
      return Response.json({ job: { leaseUntil: new Date(Date.now() + 120_000).toISOString() } });
    }
    if (path.endsWith('/report')) {
      reports.push(body);
      if (opts.report) return opts.report(reports.length, body);
      return Response.json({ run: { status: body.conclusion } });
    }
    const routed = opts.route?.(path, url, body);
    if (routed) return routed;
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  return { apiFetch, calls, reports, claims };
}

describe('kvarm runner', () => {
  it('caps the aggregate content fetched by one warm delta', async () => {
    let reads = 0;
    const read = budgetDeltaReader(async () => {
      reads++;
      return new Uint8Array(2);
    }, 3);
    await expect(read('first')).resolves.toHaveLength(2);
    await expect(read('second')).rejects.toThrow(/warm read budget of 3 bytes/);
    expect(reads).toBe(2);
  });

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
    const api = fakeRunnerApi([
      { id: 'job-1', name: 'build', command: 'cat ci-marker.txt', sha, treeSha: 'b'.repeat(40), generation: 3, timeoutSeconds: 30 },
    ]);
    const apiFetch = api.apiFetch;
    const calls = api.calls;
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

  it('uses the normalized encoded repository path for every runner API request', async () => {
    const api = fakeRunnerApi();
    const apiFetch = api.apiFetch;
    await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo.git',
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
      workRoot: join(root, 'repo-path-work'),
    });
    expect(api.calls.map((c) => c.path)).toEqual(['/api/v1/repos/alice/demo/ci/jobs/claim']);
  });

  it('reports a failed or timed-out command as failure and exits cleanly when no job is queued', async () => {
    const api = fakeRunnerApi([
      { id: 'job-2', name: 'test', command: 'exit 1', sha: 'c'.repeat(40), treeSha: 'd'.repeat(40), generation: 1, timeoutSeconds: 1 },
    ]);
    const apiFetch = api.apiFetch;
    const reports = api.reports;
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
    const api = fakeRunnerApi(
      [{ id: 'job-retry', name: 'build', command: 'true', sha: 'e'.repeat(40), generation: 1, timeoutSeconds: 10 }],
      { report: (n) => (n === 1 ? Response.json({ error: 'temporary' }, { status: 503 }) : Response.json({ run: { status: 'success' } })) },
    );
    const apiFetch = api.apiFetch;
    const reports = api.reports;
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
    const api = fakeRunnerApi([
      { id: 'job-byte-edge', name: 'build', command: 'node build.js', sha, generation: 4, timeoutSeconds: 10 },
    ]);
    const apiFetch = api.apiFetch;

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
    const report = api.reports[0]!;
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
    const api = fakeRunnerApi([
      { id: 'job-fits', name: 'build', command: 'node build.js', sha, generation: 2, timeoutSeconds: 10 },
    ]);
    const apiFetch = api.apiFetch;

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
    const report = api.reports[0]!;
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

  it('trims a summary whose command alone exceeds the budget, before any output', async () => {
    const sha = 'c'.repeat(40);
    const command = `echo ${'x'.repeat(70_000)}`;
    const api = fakeRunnerApi([{ id: 'job-cmd', name: 'build', command, sha, generation: 1, timeoutSeconds: 10 }]);
    const apiFetch = api.apiFetch;

    const result = await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha };
      },
      execute: async () => ({ code: 0, stdout: 'out\n', stderr: '', timedOut: false, durationMs: 3 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'command-trim-work'),
    });

    expect(result).toEqual({ claimed: 1, reported: 1 });
    const report = api.reports[0]!;
    expect(report.summary.command).not.toBe(command);
    expect(report.summary.command).toMatch(/…\[truncated\]$/);
    // The command is display metadata: it is cut first, leaving the output whole.
    expect(report.summary.stdout).toBe('out\n');
    expect(report.summary.stderr).toBe('');
    expect(new TextEncoder().encode(JSON.stringify(report.summary)).length).toBeLessThanOrEqual(65_536 - 1_024);
  });

  it('still fits the report when neither an oversized command nor its output fits alone', async () => {
    const sha = '4'.repeat(40);
    const command = `echo ${'y'.repeat(70_000)}`;
    const api = fakeRunnerApi([{ id: 'job-both', name: 'build', command, sha, generation: 1, timeoutSeconds: 10 }]);
    const apiFetch = api.apiFetch;

    const result = await runRunner({
      ...HOST_TRUSTED,
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      apiFetch,
      checkoutFn: async (o: any) => {
        mkdirSync(o.dir, { recursive: true });
        return { source: 'snapshot' as const, sha };
      },
      execute: async () => ({ code: 0, stdout: '😀'.repeat(16_500), stderr: '', timedOut: false, durationMs: 3 }),
      stdout: () => {},
      stderr: () => {},
      tempRoot: root,
      workRoot: join(root, 'command-both-work'),
    });

    expect(result).toEqual({ claimed: 1, reported: 1 });
    const report = api.reports[0]!;
    expect(new TextEncoder().encode(JSON.stringify(report.summary)).length).toBeLessThanOrEqual(65_536 - 1_024);
    // The command is display metadata: it is the one cut to the bare marker
    // so the oversized output keeps the largest share of the budget.
    expect(report.summary.command).toBe('…[truncated]');
    expect(report.summary.stdout).toMatch(/^(?:😀)*\n\[output truncated\]\n$/u);
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
      const api = fakeRunnerApi([], {
        claim: (n) => {
          if (n === 4) {
            return Response.json({ job: { id: 'j', name: 'build', command: 'true', sha: 'b'.repeat(40), generation: 1, timeoutSeconds: 30 } });
          }
          // A refused claim (bad credentials) ends the loop; a retriable one never would.
          if (n >= 7) return Response.json({ error: 'runner stopped' }, { status: 401 });
          return new Response(null, { status: 204 });
        },
      });
      const apiFetch = api.apiFetch;
      const calls = api.calls;
      const claims = api.claims;
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
      const nonClaim = calls.filter((c) => !c.path.endsWith('/claim'));
      expect(nonClaim).toHaveLength(1);
      expect(nonClaim[0]!.path).toMatch(/\/report$/);
      expect(calls.filter((c) => c.path.endsWith('/claim'))).toHaveLength(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drainUntilEmpty exits as soon as a claim finds no job, reporting every job it claimed', async () => {
    const api = fakeRunnerApi([
      { id: 'j1', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 },
      { id: 'j2', name: 'test', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 },
    ]);
    const apiFetch = api.apiFetch;
    const claims = api.claims;
    const reports = api.reports;
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
      const stderr: string[] = [];
      const api = fakeRunnerApi([], {
        claim: (n) => {
          if (n === 1) return Response.json({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '3' } });
          if (n === 2) throw new TypeError('fetch failed');
          if (n === 3) return Response.json({ error: 'storage unavailable' }, { status: 503 });
          return Response.json({ job: { id: 'j-r', name: 'build', command: 'true', sha: 'b'.repeat(40), generation: 1, timeoutSeconds: 30 } });
        },
      });
      const apiFetch = api.apiFetch;
      const claims = api.claims;
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
    const api = fakeRunnerApi([], {
      claim: () => Response.json({ error: 'unauthorized', code: 'INVALID_TOKEN' }, { status: 401 }),
    });
    const apiFetch = api.apiFetch;
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
    expect(api.claims).toHaveLength(1);
  });

  it('treats a malformed claim as a failed claim and retries it, never a crash', async () => {
    vi.useFakeTimers();
    try {
      const claims: string[] = [];
      const stderr: string[] = [];
      const replies = [
        { id: 'm1', name: 'build', command: 'true', sha: 'a'.repeat(40), timeoutSeconds: 30, generation: 0 },
        { id: 'm2', name: 'build', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 30 },
        { id: '../m3', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 2, timeoutSeconds: 30 },
        { id: 'm4', name: 'build', command: 'true', sha: '../bad', generation: 2, timeoutSeconds: 30 },
        { id: 'm5', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 2, timeoutSeconds: 30 },
      ];
      const api = fakeRunnerApi([], {
        claim: () => {
          const next = replies.shift();
          claims.push(next ? String(next.id) : 'gone');
          return next ? Response.json({ job: next }) : new Response(null, { status: 204 });
        },
      });
      const apiFetch = api.apiFetch;
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
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await run;
      expect(result).toEqual({ claimed: 1, reported: 1 });
      expect(claims).toEqual(['m1', 'm2', '../m3', 'm4', 'm5']);
      expect(stderr.filter((l) => l.startsWith('claim failed:'))).toHaveLength(4);
      expect(stderr[0]).toMatch(/^claim failed: claim returned an invalid job; retrying in (1\.\d|2\.0) s$/);
      expect(stderr[1]).toMatch(/^claim failed: claim returned an invalid job; retrying in ([23]\.\d|4\.0) s$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a claimed job whose timeoutSeconds is out of range at the platform default', async () => {
    const timeouts: number[] = [];
    const apiFetch = fakeRunnerApi([
      { id: 'j-t', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 1, timeoutSeconds: 'fast' },
    ]).apiFetch;
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

  it('refuses a repo that could retarget its authenticated requests, before any fetch', async () => {
    const api = fakeRunnerApi();
    const apiFetch = api.apiFetch;
    for (const repo of ['../demo', 'a%b/c', 'a#b/c', 'a?b/c', 'owner/..', 'owner/./demo']) {
      await expect(
        runRunner({
          ...HOST_TRUSTED,
          baseUrl: 'https://kvarm.test',
          pat: 'p',
          repo,
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
          workRoot: join(root, 'repo-guard-work'),
        }),
      ).rejects.toThrow(/invalid repository/);
    }
    expect(api.calls).toEqual([]);
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
      const stderr: string[] = [];
      const api = fakeRunnerApi([], {
        claim: (n) =>
          n === 1
            ? Response.json({ job: { id: 'job-x', name: 'build', command: 'true', sha: 'a'.repeat(40), generation: 5, timeoutSeconds: 30 } })
            : Response.json({ error: 'unauthorized' }, { status: 401 }),
        report: () => Response.json({ error: 'the CI job claim is stale', code: 'STALE_GENERATION' }, { status: 409 }),
      });
      const apiFetch = api.apiFetch;
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
      expect(api.reports).toHaveLength(3);
      expect(api.claims).toHaveLength(2);
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
    const stdout: string[] = [];
    const api = fakeRunnerApi(jobs, {
      route: (path, url) => {
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
      },
    });
    const apiFetch = api.apiFetch;
    const reports = api.reports;
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
    const api = fakeRunnerApi(jobs, {
      route: (path) => {
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
      },
    });
    const apiFetch = api.apiFetch;
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

  /** One queued job; records every call path (relative to the repo API) and report body. */
  function preparedPlatform(sha: string) {
    const api = fakeRunnerApi([{ id: 'job-p', name: 'build', command: 'build', sha, generation: 2, timeoutSeconds: 30 }]);
    return { apiFetch: api.apiFetch, calls: api.calls, reports: api.reports };
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
    expect(platform.calls.map((c) => c.path.slice('/api/v1/repos/alice/demo/'.length))).toEqual([
      'ci/jobs/claim',
      'ci/jobs/job-p/heartbeat',
      'ci/jobs/job-p/report',
    ]);
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
