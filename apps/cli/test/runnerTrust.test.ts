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
  containerRunArgs,
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

const HUMAN: JobProvenance = { changeNumber: 7, headRef: 'feature', commit: 'head', authorKind: 'human', authorLogin: 'alice', agent: null, agentWorkspaceRef: false };
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
    expect(trustOf('humans', undefined)).toEqual({ trusted: false, reason: 'the platform sent no provenance for this job' });
    expect(trustOf('humans', {}).trusted).toBe(false);
  });

  it('runs trusted jobs on the host, isolates untrusted ones when a runtime exists, and refuses otherwise', () => {
    const plan = (trust: 'all' | 'humans' | 'none', executor: 'auto' | 'host' | 'container', provenance: JobProvenance | undefined, runtimeAvailable: boolean) =>
      planExecution({ trust, executor, provenance, runtimeAvailable }).run;
    expect(plan('humans', 'auto', HUMAN, false)).toBe('host');
    expect(plan('humans', 'auto', AGENT, true)).toBe('container');
    expect(plan('humans', 'auto', AGENT, false)).toBeNull();
    expect(plan('humans', 'host', AGENT, true)).toBeNull();
    expect(plan('humans', 'container', HUMAN, true)).toBe('container');
    expect(plan('humans', 'container', HUMAN, false)).toBeNull();
    expect(plan('none', 'auto', HUMAN, true)).toBe('container');
    expect(plan('none', 'auto', HUMAN, false)).toBeNull();
    expect(plan('all', 'auto', AGENT, false)).toBe('host');
    expect(plan('all', 'container', AGENT, true)).toBe('container');
    expect(planExecution({ trust: 'humans', executor: 'auto', provenance: AGENT, runtimeAvailable: false }).reason).toBe(
      'change #7 is agent-authored (agent "builder"), and no container runtime (docker or podman) is available to isolate it',
    );
  });
});

describe('container executor', () => {
  it('builds an isolated run: removed, named, one writable bind mount, read-only root, limits, filtered env, non-root user', () => {
    const args = containerRunArgs(
      { runtime: 'docker', image: 'node:24.1.0-bookworm', network: 'none', cpus: '1.5', memory: '2g', pidsLimit: 256, user: '1000:1000' },
      { name: 'kvarm-job-x', workdir: '/work/slot', command: 'npm test', env: [['LANG', 'C']] },
    );
    expect(args).toEqual([
      'run',
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
    expect(args.filter((a) => a === '--mount' || a === '-v' || a === '--volume')).toEqual(['--mount']);
  });

  it('defaults to the pinned image, this user, the runtime network and sane limits; podman keeps the user namespace id', () => {
    const docker = containerRunArgs({ runtime: 'docker' }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(docker).toContain(DEFAULT_IMAGE);
    expect(docker).not.toContain('--network');
    expect(docker.slice(docker.indexOf('--cpus'), docker.indexOf('--pids-limit') + 2)).toEqual(['--cpus', '2', '--memory', '4g', '--pids-limit', '1024']);
    if (typeof process.getuid === 'function') expect(docker[docker.indexOf('--user') + 1]).toBe(`${process.getuid()}:${process.getgid!()}`);
    const podman = containerRunArgs({ runtime: 'podman', user: '501:20' }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(podman.slice(podman.indexOf('--user'), podman.indexOf('--user') + 4)).toEqual(['--user', '501:20', '--userns', 'keep-id']);
    const imageUser = containerRunArgs({ runtime: 'docker', user: null }, { name: 'n', workdir: '/w', command: 'true', env: [] });
    expect(imageUser).not.toContain('--user');
  });

  it('passes the filtered environment without host paths or credentials', () => {
    const injected = { KVARM_PAT: 'kvarm_pat_secret', GIT_ASKPASS: '/secret', AWS_SECRET_ACCESS_KEY: 'x', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
    const previous = Object.fromEntries(Object.keys(injected).map((k) => [k, process.env[k]]));
    Object.assign(process.env, injected);
    try {
      const env = Object.fromEntries(containerEnvironment());
      expect(env).toEqual({ GIT_TERMINAL_PROMPT: '0', HOME: '/tmp', LANG: 'C', LC_ALL: 'C', TZ: 'UTC', ...pickLc(env) });
      const args = containerRunArgs({ runtime: 'docker' }, { name: 'n', workdir: '/w', command: 'true' });
      const flat = args.join('\n');
      expect(flat).not.toContain('kvarm_pat_secret');
      expect(flat).not.toContain('/secret');
      expect(flat).not.toMatch(/^PATH=/m);
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
    expect(containerConfigError({ cpus: '0' })).toMatch(/invalid cpus/);
    expect(containerConfigError({ memory: 'lots' })).toMatch(/invalid memory/);
    expect(containerConfigError({ pidsLimit: Number.NaN })).toMatch(/invalid pids limit/);
    expect(containerConfigError({ user: '--privileged' })).toMatch(/invalid container user/);
    expect(containerConfigError({ runtime: 'lxc' as never })).toMatch(/container runtime/);
    expect(containerConfigError({ image: 'ghcr.io/org/img:1@sha256:abc', network: 'none', cpus: '0.5', memory: '512m', pidsLimit: 64, user: '1000' })).toBeNull();
    expect(() => containerRunArgs({ runtime: 'docker' }, { name: 'n', workdir: '/a,b', command: 'true', env: [] })).toThrow(/comma/);
    expect(containerName('job/1 2')).toMatch(/^kvarm-job-job-1-2-[0-9a-f]{8}$/);
  });

  it('collects bounded output and the exit code through the runtime client', async () => {
    const { spawn, calls } = fakeSpawn((_command, _args, child) => child.finish(3, 'out\n', 'err\n'));
    const result = await executeContainer('make', '/w', 30, { runtime: 'podman', name: 'kvarm-job-a', user: null, spawn });
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('podman');
    expect(calls[0]!.args.slice(0, 3)).toEqual(['run', '--rm', '--name']);
  });

  it('kills the container by name on timeout and reports the job as timed out', async () => {
    let run: FakeChild | undefined;
    const { spawn, calls } = fakeSpawn((_command, args, child) => {
      if (args[0] === 'run') run = child;
      else if (args[0] === 'kill') {
        child.finish(0);
        run!.finish(137);
      }
    });
    const started = Date.now();
    const result = await executeContainer('sleep 600', '/w', 0.05, { runtime: 'docker', name: 'kvarm-job-t', user: null, spawn });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(137);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(calls.map((c) => [c.command, ...c.args.slice(0, 2)])).toEqual([
      ['docker', 'run', '--rm'],
      ['docker', 'kill', 'kvarm-job-t'],
    ]);
  });

  it('detects the first runtime whose daemon answers, honoring a requested one', async () => {
    const { spawn, calls } = fakeSpawn((command, _args, child) => (command === 'docker' ? child.finish(1) : child.finish(0)));
    expect(await detectRuntime({ spawn })).toBe('podman');
    expect(calls.map((c) => [c.command, ...c.args])).toEqual([
      ['docker', 'info'],
      ['podman', 'info'],
    ]);
    const missing = fakeSpawn((_command, _args, child) => setImmediate(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))));
    expect(await detectRuntime({ spawn: missing.spawn })).toBeNull();
    const only = fakeSpawn((_command, _args, child) => child.finish(0));
    expect(await detectRuntime({ preferred: 'podman', spawn: only.spawn })).toBe('podman');
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

function pickLc(env: Record<string, string>) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('LC_')));
}

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
    const isolated: Array<{ cwd: string; runtime: string; jobId: string }> = [];
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
      executeContainer: async (_command: string, cwd: string, _t: number, info: { jobId: string; runtime: 'docker' | 'podman' }) => {
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
    expect(h.stderr.join('\n')).toMatch(/refused test \(job-t\)/);
  });

  it('runs an agent-authored job in a container in its own workdir, and a human one on the host without probing', async () => {
    const agent = harness(AGENT);
    await runRunner({ ...agent.base, detectRuntimeFn: async () => 'docker' });
    expect(agent.host).toEqual([]);
    expect(agent.isolated).toHaveLength(1);
    expect(agent.isolated[0]).toMatchObject({ runtime: 'docker', jobId: 'job-t' });
    expect(agent.isolated[0]!.cwd.startsWith(`${agent.base.workRoot}-container`)).toBe(true);
    expect(agent.report()).toMatchObject({ conclusion: 'success', summary: { executor: 'container', image: DEFAULT_IMAGE } });

    const human = harness(HUMAN);
    let probes = 0;
    await runRunner({ ...human.base, detectRuntimeFn: async () => (probes++, 'docker') });
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
    await runRunner({ ...h.base, executor: 'host', detectRuntimeFn: async () => 'docker' });
    expect(h.isolated).toEqual([]);
    expect(h.report().summary).toMatchObject({ refused: true, executor: 'host' });
    expect(h.report().summary.stderr).toContain('--executor host does not run untrusted jobs');
  });

  it('--executor container without a runtime fails before claiming any job', async () => {
    const h = harness(HUMAN);
    await expect(runRunner({ ...h.base, executor: 'container', detectRuntimeFn: async () => null })).rejects.toThrow(/--executor container needs a running docker or podman/);
    expect(h.calls).toEqual([]);
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
  });

  it('documents the trust modes and the container executor in its help', async () => {
    const out: string[] = [];
    expect(await main(['help', 'runner'], { env: {}, stdout: (l) => out.push(l), stderr: () => {} })).toBe(0);
    const help = out.join('\n');
    for (const needle of ['--trust humans', '--trust all', '--trust none', '--executor', DEFAULT_IMAGE, '--network none', 'not a sandbox']) expect(help).toContain(needle);
  });
});
