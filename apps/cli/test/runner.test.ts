import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { executeShell, runRunner } from '../src/runner.js';
import { tempDir } from './helpers';

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
      baseUrl: 'https://kvarm.test',
      pat: 'kvarm_pat_test',
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
      if (path.endsWith('/report')) reports.push(body);
      return Response.json({ run: { status: 'failure' } });
    };
    const checkoutFn = async (o: any) => {
      mkdirSync(o.dir, { recursive: true });
      return { source: 'clone' as const, sha: 'c'.repeat(40) };
    };
    const first = await runRunner({
      baseUrl: 'https://kvarm.test',
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
      baseUrl: 'https://kvarm.test',
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
      baseUrl: 'https://kvarm.test',
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
      baseUrl: 'https://kvarm.test',
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
      baseUrl: 'https://kvarm.test',
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
          if (claims.length >= 7) return Response.json({ error: 'runner stopped' }, { status: 500 });
          return new Response(null, { status: 204 });
        }
        if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
        return Response.json({});
      };
      const run = runRunner({
        baseUrl: 'https://kvarm.test',
        pat: 'p',
        repo: 'cynthia/demo',
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
      if (path === `/api/v1/repos/cynthia/demo/compare/${a}...${b}`) {
        return Response.json({
          files: [
            { path: 'a.txt', status: 'modified', oldHash: blobSha('v1\n'), newHash: blobSha('v2\n'), oldMode: '100644', newMode: '100644' },
          ],
          truncated: false,
        });
      }
      if (path === '/api/v1/repos/cynthia/demo/contents') {
        contentsGets.push(String(url.searchParams.get('path')));
        return Response.json({ ref: b, path: 'a.txt', size: 4, encoding: 'utf-8', content: 'v2\n' });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    };
    const options = {
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'cynthia/demo',
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
    const work = join(root, 'delta-work', 'cynthia', 'demo', 'slot-0', 'work');
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
      if (path === `/api/v1/repos/cynthia/demo/compare/${a}...${c}`) {
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
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'cynthia/demo',
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
    const work = join(root, 'delta-budget-work', 'cynthia', 'demo', 'slot-0', 'work');
    expect(readFileSync(join(work, 'seed.txt'), 'utf8')).toBe(`seed ${c}\n`);
  });
});
