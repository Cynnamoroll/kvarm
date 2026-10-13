import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CONTAINER_WORKDIR,
  DEFAULT_IMAGE,
  containerConfigError,
  containerEnvironment,
  containerName,
  containerCreateArgs,
  detectRuntime,
  executeContainer,
  planExecution,
  trustOf,
  type JobProvenance,
} from '../src/executor.js';
import { main } from '../src/main.js';
import { runRunner } from '../src/runner.js';
import { tempDir } from './helpers';

const root = tempDir('kvarm-cli-trust-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HUMAN: JobProvenance = {
  changeNumber: 7,
  headRef: 'feature',
  commit: 'head',
  authorKind: 'human',
  authorLogin: 'alice',
  agent: null,
  agentWorkspaceRef: false,
  agentWritableRef: false,
};
const DOCKER = { runtime: 'docker', rootless: false } as const;
const AGENT: JobProvenance = { ...HUMAN, authorKind: 'agent', agent: { id: 'a1', name: 'builder' } };

/** A fake child process: emits the given output, then closes with `code` unless held open. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(String(signal ?? 'SIGTERM'));
    return true;
  }
  finish(code: number | null, out = '', err = '') {
    if (out) this.stdout.write(out);
    if (err) this.stderr.write(err);
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code));
  }
}

function fakeSpawn(onSpawn: (command: string, args: readonly string[], child: FakeChild) => void) {
  const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
  const spawn = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args: [...args], options });
    const child = new FakeChild();
    onSpawn(command, args, child);
    return child as unknown as ChildProcess;
  }) as Parameters<typeof executeContainer>[3]['spawn'];
  return { spawn, calls };
}

describe('execution-trust policy', () => {
  it('trusts every job under all, none under none, and only exact human change heads under humans', () => {
    expect(trustOf('all', AGENT).trusted).toBe(true);
    expect(trustOf('none', HUMAN).trusted).toBe(false);
    expect(trustOf('humans', HUMAN)).toEqual({ trusted: true, reason: 'change #7 is human-authored (alice)' });
    expect(trustOf('humans', AGENT)).toEqual({ trusted: false, reason: 'change #7 is agent-authored (agent "builder")' });
    expect(trustOf('humans', { ...HUMAN, agentWorkspaceRef: true, headRef: 'agents/w/x' }).trusted).toBe(false);
    expect(trustOf('humans', { ...HUMAN, authorKind: 'agent', agent: null, agentWorkspaceRef: true, headRef: 'agents/w/x' }).reason).toContain('agent workspace ref agents/w/x');
    expect(trustOf('humans', { ...HUMAN, commit: 'prepared' }).reason).toContain('platform-prepared commit');
    expect(trustOf('humans', { ...HUMAN, authorKind: 'unknown' }).trusted).toBe(false);
    expect(trustOf('humans', { ...HUMAN, agentWritableRef: true })).toEqual({ trusted: false, reason: 'an agent token may push the head ref feature of change #7' });
    const { agentWritableRef: _omitted, ...older } = HUMAN;
    expect(trustOf('humans', older).trusted).toBe(false);
    expect(trustOf('humans', undefined)).toEqual({ trusted: false, reason: 'the platform sent no provenance for this job' });
    expect(trustOf('humans', {}).trusted).toBe(false);
  });

  it('runs trusted jobs on the host, isolates untrusted ones when a runtime exists, refuses otherwise, and probes only when needed', async () => {
    let probes = 0;
    const plan = async (trust: 'all' | 'humans' | 'none', executor: 'auto' | 'host' | 'container', provenance: JobProvenance | undefined, available: boolean) =>
      (await planExecution({ trust, executor, provenance, runtime: async () => (probes++, available ? DOCKER : null) })).run;
    expect(await plan('humans', 'auto', HUMAN, false)).toBe('host');
    expect(await plan('humans', 'host', AGENT, true)).toBeNull();
    expect(await plan('all', 'auto', AGENT, false)).toBe('host');
    expect(probes).toBe(0);
    expect(await plan('humans', 'auto', AGENT, true)).toBe('container');
    expect(await plan('humans', 'auto', AGENT, false)).toBeNull();
    expect(await plan('humans', 'container', HUMAN, true)).toBe('container');
    expect(await plan('humans', 'container', HUMAN, false)).toBeNull();
    expect(await plan('none', 'auto', HUMAN, true)).toBe('container');
    expect(await plan('none', 'auto', HUMAN, false)).toBeNull();
    expect(await plan('all', 'container', AGENT, true)).toBe('container');
    expect(probes).toBe(7);
    const refused = await planExecution({ trust: 'humans', executor: 'auto', provenance: AGENT, runtime: async () => null });
    expect(refused).toEqual({
      run: null,
      trusted: false,
      reason: 'change #7 is agent-authored (agent "builder"), and no container runtime (docker or podman) answered to isolate it',
      runtime: null,
    });
  });
});

describe('container executor', () => {
  it('builds an isolated run: removed, named, one writable bind mount, read-only root, limits, filtered env, non-root user', () => {
    const args = containerCreateArgs(
      { runtime: 'docker', image: 'node:24.1.0-bookworm', network: 'none', cpus: '1.5', memory: '2g', pidsLimit: 256, user: '1000:1000' },
      { name: 'kvarm-job-x', workdir: '/work/slot', command: 'npm test', env: [['LANG', 'C']] },
    );
    expect(args).toEqual([
      'create',
      '--rm',
      '--name',
      'kvarm-job-x',
      '--init',
      '--mount',
      `type=bind,source=/work/slot,target=${CONTAINER_WORKDIR}`,
      '--workdir',
      CONTAINER_WORKDIR,
      '--read-only',
      '--tmpfs',
      '/tmp:rw,exec',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--cpus',
      '1.5',
      '--memory',
      '2g',
      '--pids-limit',
      '256',
      '--user',
      '1000:1000',
      '--network',
      'none',
      '--env',
      'LANG=C',
      '--entrypoint',
      '/bin/sh',
      'node:24.1.0-bookworm',
      '-c',
      'npm test',
    ]);
    expect(args.filter((a: string) => a === '--mount' || a === '-v' || a === '--volume')).toEqual(['--mount']);
  });

  it('defaults to the pinned image, this user, the runtime network and sane limits, and maps ids for rootless runtimes', () => {
    const docker = containerCreateArgs({ runtime: 'docker' }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(docker).toContain(DEFAULT_IMAGE);
    expect(docker).not.toContain('--network');
    expect(docker.slice(docker.indexOf('--cpus'), docker.indexOf('--pids-limit') + 2)).toEqual(['--cpus', '2', '--memory', '4g', '--pids-limit', '1024']);
    if (typeof process.getuid === 'function') expect(docker[docker.indexOf('--user') + 1]).toBe(`${process.getuid()}:${process.getgid!()}`);
    const podman = containerCreateArgs({ runtime: 'podman', rootless: true, user: '501:20' }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(podman.slice(podman.indexOf('--user'), podman.indexOf('--user') + 4)).toEqual(['--user', '501:20', '--userns', 'keep-id']);
    // keep-id is rootless-only; rootful podman refuses it.
    expect(containerCreateArgs({ runtime: 'podman', rootless: false, user: '501:20' }, { name: 'n', workdir: '/w', command: 'true', env: [] })).not.toContain('--userns');
    // Rootless docker: container root is this user on the host.
    const rootlessDocker = containerCreateArgs({ runtime: 'docker', rootless: true }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(rootlessDocker[rootlessDocker.indexOf('--user') + 1]).toBe('0:0');
    const imageUser = containerCreateArgs({ runtime: 'docker', user: null }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(imageUser).not.toContain('--user');
  });

  it('passes only the time zone and a fixed locale, never host paths, host locales or credentials', () => {
    const injected = { KVARM_PAT: 'kvarm_pat_secret', GIT_ASKPASS: '/secret', AWS_SECRET_ACCESS_KEY: 'x', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', TZ: 'UTC' };
    const previous = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
    Object.assign(process.env, injected);
    try {
      const env = Object.fromEntries(containerEnvironment());
      expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0', HOME: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC' });
      const args = containerCreateArgs({ runtime: 'docker' }, { name: 'n', workdir: '/w', command: 'true' });
      const flat = args.join('\n');
      expect(flat).not.toContain('kvarm_pat_secret');
      expect(flat).not.toContain('/secret');
      expect(flat).not.toMatch(/^PATH=/m);
      expect(flat).not.toContain('LC_CTYPE');
      expect(args).toContain('HOME=/tmp');
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('rejects settings a runtime would parse as options and paths a bind mount cannot carry', () => {
    expect(containerConfigError({ image: '--privileged' })).toMatch(/invalid image/);
    expect(containerConfigError({ network: '-x' })).toMatch(/invalid network/);
    expect(containerConfigError({ network: 'host' })).toMatch(/share a network namespace/);
    expect(containerConfigError({ network: 'container:db' })).toMatch(/share a network namespace/);
    expect(containerConfigError({ network: 'bridge' })).toBeNull();
    expect(containerConfigError({ cpus: '0' })).toMatch(/invalid cpus/);
    expect(containerConfigError({ memory: 'lots' })).toMatch(/invalid memory/);
    expect(containerConfigError({ pidsLimit: Number.NaN })).toMatch(/invalid pids limit/);
    expect(containerConfigError({ user: '--privileged' })).toMatch(/invalid container user/);
    expect(containerConfigError({ runtime: 'lxc' as never })).toMatch(/container runtime/);
    expect(containerConfigError({ image: 'ghcr.io/org/img:1@sha256:abc', network: 'none', cpus: '0.5', memory: '512m', pidsLimit: 64, user: '1000' })).toBeNull();
    expect(() => containerCreateArgs({ runtime: 'docker' }, { name: 'n', workdir: '/a,b', command: 'true', env: [] })).toThrow(/comma/);
    expect(containerName('job/1 2')).toMatch(/^kvarm-job-job-1-2-[0-9a-f]{8}$/);
  });

  it('creates the container, then starts it attached and collects bounded output and the exit code', async () => {
    const { spawn, calls } = fakeSpawn((_command, args, child) => (args[0] === 'create' ? child.finish(0, 'abc123\n') : child.finish(3, 'out\n', 'err\n')));
    const result = await executeContainer('make', '/w', 30, { runtime: 'podman', name: 'kvarm-job-a', user: null, spawn });
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
    expect(calls.map((c) => [c.command, ...c.args.slice(0, 3)])).toEqual([
      ['podman', 'create', '--rm', '--name'],
      ['podman', 'start', '--attach', 'kvarm-job-a'],
    ]);
  });

  it('removes the created container when the attached start cannot be spawned', async () => {
    const { spawn, calls } = fakeSpawn((_command, args, child) => {
      if (args[0] === 'create') child.finish(0);
      else if (args[0] === 'start') setImmediate(() => child.emit('error', new Error('spawn EAGAIN')));
      else child.finish(0);
    });
    await expect(executeContainer('make', '/w', 30, { runtime: 'docker', name: 'kvarm-job-e', user: null, spawn })).rejects.toThrow('EAGAIN');
    expect(calls.map((c) => c.args.slice(0, 2))).toEqual([
      ['create', '--rm'],
      ['start', '--attach'],
      ['rm', '--force'],
    ]);
  });

  it('measures the command, not the image pull, as the job duration', async () => {
    const { spawn } = fakeSpawn((_command, args, child) => {
      if (args[0] === 'create') setTimeout(() => child.finish(0), 120);
      else child.finish(0);
    });
    const result = await executeContainer('true', '/w', 30, { runtime: 'docker', name: 'kvarm-job-d', user: null, spawn });
    expect(result.code).toBe(0);
    expect(result.durationMs).toBeLessThan(100);
  });

  it('reports a failed create (an image that cannot be pulled) without starting anything', async () => {
    const { spawn, calls } = fakeSpawn((_command, args, child) => (args[0] === 'create' ? child.finish(125, '', 'pull access denied\n') : child.finish(0)));
    const result = await executeContainer('make', '/w', 30, { runtime: 'docker', name: 'kvarm-job-c', user: null, spawn });
    expect(result).toMatchObject({ code: 125, timedOut: false, stdout: '' });
    expect(result.stderr).toBe('docker create failed\npull access denied\n');
    expect(calls.map((c) => c.args[0])).toEqual(['create', 'rm']);
  });

  it('does not count a slow create against the job timeout, and gives up on one past its own budget', async () => {
    let creating: FakeChild | undefined;
    const { spawn, calls } = fakeSpawn((_command, args, child) => {
      if (args[0] === 'create') creating = child;
      else if (args[0] === 'rm') child.finish(0);
    });
    const pending = executeContainer('make', '/w', 0.01, { runtime: 'docker', name: 'kvarm-job-p', user: null, spawn, createTimeoutMs: 80 });
    await new Promise((r) => setTimeout(r, 40));
    expect(calls.map((c) => c.args[0])).toEqual(['create']);
    const result = await new Promise<Awaited<typeof pending>>((resolve) => {
      const tick = setInterval(() => {
        if (creating!.killed.length > 0) {
          clearInterval(tick);
          creating!.finish(null);
          void pending.then(resolve);
        }
      }, 5);
    });
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/^creating the container \(pulling node:24-bookworm\) took longer than 0 s/);
    expect(calls.map((c) => c.args[0])).toEqual(['create', 'rm']);
  });

  it('kills the container by name on timeout, then removes it, and reports the job as timed out', async () => {
    let started: FakeChild | undefined;
    const { spawn, calls } = fakeSpawn((_command, args, child) => {
      if (args[0] === 'create') child.finish(0);
      else if (args[0] === 'start') started = child;
      else if (args[0] === 'kill') {
        child.finish(0);
        started!.finish(137);
      } else child.finish(0);
    });
    const t0 = Date.now();
    const result = await executeContainer('sleep 600', '/w', 0.05, { runtime: 'docker', name: 'kvarm-job-t', user: null, spawn });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(137);
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(calls.map((c) => [c.command, ...c.args.slice(0, 2)])).toEqual([
      ['docker', 'create', '--rm'],
      ['docker', 'start', '--attach'],
      ['docker', 'kill', 'kvarm-job-t'],
      ['docker', 'rm', '--force'],
    ]);
  });

  it('detects the first runtime whose daemon answers and whether it runs rootless, honoring a requested one', async () => {
    const { spawn, calls } = fakeSpawn((command, _args, child) => (command === 'docker' ? child.finish(1) : child.finish(0, 'true\n')));
    expect(await detectRuntime({ spawn })).toEqual({ runtime: 'podman', rootless: true });
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['docker', 'info', '--format', '{{json .SecurityOptions}}'],
      ['podman', 'info', '--format', '{{.Host.Security.Rootless}}'],
    ]);
    const rootless = fakeSpawn((_command, _args, child) => child.finish(0, '["name=seccomp,profile=builtin","name=rootless"]\n'));
    expect(await detectRuntime({ spawn: rootless.spawn })).toEqual({ runtime: 'docker', rootless: true });
    const rootful = fakeSpawn((_command, _args, child) => child.finish(0, '["name=seccomp,profile=builtin"]\n'));
    expect(await detectRuntime({ spawn: rootful.spawn })).toEqual({ runtime: 'docker', rootless: false });
    const missing = fakeSpawn((_command, _args, child) => setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))));
    expect(await detectRuntime({ spawn: missing.spawn })).toBeNull();
    const only = fakeSpawn((_command, _args, child) => child.finish(0, 'false\n'));
    expect(await detectRuntime({ preferred: 'podman', spawn: only.spawn })).toEqual({ runtime: 'podman', rootless: false });
    expect(only.calls.map((c) => c.command)).toEqual(['podman']);
  });

  // Opt-in: needs a running docker daemon and the default image already pulled (the suite makes no network calls).
  const dockerReady =
    process.env.KVARM_TEST_DOCKER === '1' &&
    spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0 &&
    spawnSync('docker', ['image', 'inspect', DEFAULT_IMAGE], { stdio: 'ignore' }).status === 0;
  it.skipIf(!dockerReady)('runs a command in a real container with only the workdir writable and no network', async () => {
    const work = join(root, 'docker-work');
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, 'in.txt'), 'hello\n');
    const result = await executeContainer('cat in.txt > out.txt && ! touch /etc/x 2>/dev/null && ! getent hosts example.com', work, 60, {
      runtime: 'docker',
      network: 'none',
      name: containerName('docker-test'),
    });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(readFileSync(join(work, 'out.txt'), 'utf8')).toBe('hello\n');
  });
});

describe('kvarm runner trust enforcement', () => {
  function harness(provenance: JobProvenance | undefined) {
    const calls: Array<{ path: string; body: any }> = [];
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (path.endsWith('/claim')) {
        return Response.json({
          job: { id: 'job-t', name: 'test', command: 'npm test', sha: 'a'.repeat(40), treeSha: 'b'.repeat(40), generation: 2, runnerId: body.runnerId, timeoutSeconds: 30, provenance },
        });
      }
      if (path.endsWith('/report')) return Response.json({ run: { status: body.conclusion } });
      return Response.json({ job: {} });
    };
    const checkouts: string[] = [];
    const checkoutFn = async (o: any) => {
      checkouts.push(o.dir);
      mkdirSync(o.dir, { recursive: true });
      return { source: 'snapshot' as const, sha: o.ref };
    };
    const host: string[] = [];
    const isolated: Array<{ cwd: string; runtime: string; rootless: boolean; jobId: string }> = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const base = {
      baseUrl: 'https://kvarm.test',
      pat: 'p',
      repo: 'alice/demo',
      once: true,
      runnerId: 'trust-runner',
      apiFetch,
      checkoutFn,
      execute: async (_command: string, cwd: string) => {
        host.push(cwd);
        return { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 };
      },
      executeContainer: async (_command: string, cwd: string, _t: number, info: { jobId: string; runtime: 'docker' | 'podman'; rootless: boolean }) => {
        isolated.push({ cwd, ...info });
        return { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 };
      },
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
      tempRoot: root,
      workRoot: join(root, `work-${crypto.randomUUID()}`),
    };
    const report = () => calls.find((c) => c.path.endsWith('/report'))?.body;
    return { base, calls, checkouts, host, isolated, stdout, stderr, report };
  }

  it('refuses an agent-authored job without a container runtime: reported as failure, nothing checked out or run', async () => {
    const h = harness(AGENT);
    let probes = 0;
    const result = await runRunner({ ...h.base, detectRuntimeFn: async () => (probes++, null) });
    expect(result).toEqual({ claimed: 1, reported: 1 });
    expect(probes).toBe(1);
    expect(h.checkouts).toEqual([]);
    expect(h.host).toEqual([]);
    expect(h.isolated).toEqual([]);
    expect(h.report()).toMatchObject({
      runnerId: 'trust-runner',
      generation: 2,
      conclusion: 'failure',
      summary: { exitCode: null, refused: true, trust: 'humans', executor: 'auto', sha: 'a'.repeat(40) },
    });
    expect(h.report().summary.stderr).toMatch(/^kvarm runner refused to run this job: change #7 is agent-authored \(agent "builder"\), and no container runtime/);
    expect(h.calls.map((c) => c.path.split('/').pop())).toEqual(['claim', 'report']);
    expect(h.stderr.join('\n')).toMatch(/refused test \(job-t\)/);
  });

  it('runs an agent-authored job in a container in its own workdir, and a human one on the host without probing', async () => {
    const agent = harness(AGENT);
    await runRunner({ ...agent.base, detectRuntimeFn: async () => DOCKER });
    expect(agent.host).toEqual([]);
    expect(agent.isolated).toHaveLength(1);
    expect(agent.isolated[0]).toMatchObject({ runtime: 'docker', rootless: false, jobId: 'job-t' });
    expect(agent.isolated[0]!.cwd.startsWith(`${agent.base.workRoot}-container`)).toBe(true);
    expect(agent.report()).toMatchObject({ conclusion: 'success', summary: { executor: 'container', image: DEFAULT_IMAGE } });

    const human = harness(HUMAN);
    let probes = 0;
    await runRunner({ ...human.base, detectRuntimeFn: async () => (probes++, DOCKER) });
    expect(probes).toBe(0);
    expect(human.isolated).toEqual([]);
    expect(human.host).toHaveLength(1);
    expect(human.host[0]!.startsWith(`${human.base.workRoot}${sep}`)).toBe(true);
    expect(human.host[0]!.startsWith(`${human.base.workRoot}-container`)).toBe(false);
    expect(human.report()).toMatchObject({ conclusion: 'success', summary: { executor: 'host' } });
    expect(human.stderr).toEqual([]);
  });

  it('treats a claim without provenance as untrusted', async () => {
    const h = harness(undefined);
    await runRunner({ ...h.base, detectRuntimeFn: async () => null });
    expect(h.report().summary).toMatchObject({ refused: true });
    expect(h.report().summary.stderr).toContain('the platform sent no provenance for this job');
  });

  it('warns on every host job under --trust all', async () => {
    const h = harness(AGENT);
    await runRunner({ ...h.base, trust: 'all', detectRuntimeFn: async () => null });
    expect(h.host).toHaveLength(1);
    expect(h.stderr).toEqual(["warning: running test on the host with --trust all; its code has this user's files and network"]);
  });

  it('--executor host refuses untrusted jobs even when a runtime exists', async () => {
    const h = harness(AGENT);
    await runRunner({ ...h.base, executor: 'host', detectRuntimeFn: async () => DOCKER });
    expect(h.isolated).toEqual([]);
    expect(h.report().summary).toMatchObject({ refused: true, executor: 'host' });
    expect(h.report().summary.stderr).toContain('--executor host does not run untrusted jobs');
  });

  it('--executor container without a runtime fails before claiming any job', async () => {
    const h = harness(HUMAN);
    await expect(runRunner({ ...h.base, executor: 'container', detectRuntimeFn: async () => null })).rejects.toThrow(/--executor container needs a running docker or podman/);
    expect(h.calls).toEqual([]);
  });

  it('asks for a missing runtime again after a minute, but keeps one that answered', async () => {
    const h = harness(AGENT);
    let claims = 0;
    const apiFetch = h.base.apiFetch;
    const answers: Array<typeof DOCKER | null> = [null, DOCKER];
    let probes = 0;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await runRunner({
        ...h.base,
        once: false,
        apiFetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          // A refused claim ends the loop; a retriable failure never would.
          if (path.endsWith('/claim') && ++claims > 3) return Response.json({ error: 'stop' }, { status: 401 });
          if (path.endsWith('/report')) now += 61_000;
          return apiFetch(input, init);
        },
        detectRuntimeFn: async () => answers[Math.min(probes++, answers.length - 1)]!,
      }).catch((err) => expect(String(err)).toContain('stop'));
    } finally {
      Date.now = realNow;
    }
    expect(probes).toBe(2);
    const reports = h.calls.filter((c) => c.path.endsWith('/report')).map((c) => c.body.conclusion);
    expect(reports).toEqual(['failure', 'success', 'success']);
    expect(h.isolated).toHaveLength(2);
  });

  it('reports a failed runtime probe as a job failure instead of leaving the job claimed', async () => {
    const h = harness(AGENT);
    await runRunner({
      ...h.base,
      detectRuntimeFn: async () => {
        throw new Error('probe exploded');
      },
    });
    expect(h.report()).toMatchObject({ conclusion: 'failure', summary: { stderr: 'probe exploded' } });
  });
});

describe('kvarm runner flags', () => {
  const io = () => {
    const err: string[] = [];
    return { err, io: { env: { KVARM_BASE_URL: 'https://kvarm.test', KVARM_PAT: 'p' }, stdout: () => {}, stderr: (l: string) => err.push(l) } };
  };

  it('exits 2 on an unknown trust mode, executor, runtime or container setting', async () => {
    for (const args of [
      ['--trust', 'agents'],
      ['--executor', 'vm'],
      ['--container-runtime', 'lxc'],
      ['--image', '--privileged'],
      ['--pids-limit', 'many'],
      ['--memory', 'lots'],
    ]) {
      const { err, io: x } = io();
      expect(await main(['runner', '--repo', 'alice/demo', ...args], x)).toBe(2);
      expect(err.join('\n')).toMatch(/kvarm runner: /);
    }
    const { err, io: x } = io();
    expect(await main(['runner', '--repo', 'a%b/c'], x)).toBe(2);
    expect(err.join('\n')).toMatch(/kvarm runner: invalid repository/);
  });

  it('documents the trust modes and the container executor in its help', async () => {
    const out: string[] = [];
    expect(await main(['help', 'runner'], { env: {}, stdout: (l) => out.push(l), stderr: () => {} })).toBe(0);
    const help = out.join('\n');
    for (const needle of ['--trust humans', '--trust all', '--trust none', '--executor', DEFAULT_IMAGE, '--network none', 'not a sandbox']) expect(help).toContain(needle);
  });
});
