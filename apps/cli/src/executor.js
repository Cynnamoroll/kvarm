// @ts-check
/**
 * Where and whether the runner executes a repository command. Two
 * executors: `host` runs the command in a shell as this user (environment
 * filtered, nothing else isolated), `container` runs it in a throwaway
 * docker or podman container whose only writable host mount is the job's
 * working directory. The execution-trust policy decides, before anything
 * runs, which executor a claimed job gets or whether it is refused, from the
 * provenance the platform returns with the claim.
 */

import { spawn as nodeSpawn } from 'node:child_process';

export const OUTPUT_LIMIT = 16 * 1024;
export const TRUNCATED = '\n[output truncated]\n';

/** @typedef {'all'|'humans'|'none'} TrustMode */
/** @typedef {'auto'|'host'|'container'} ExecutorMode */
/** @typedef {'docker'|'podman'} ContainerRuntime */
/** @typedef {{code:number|null,stdout:string,stderr:string,timedOut:boolean,durationMs:number}} ExecResult */

/** @type {readonly TrustMode[]} */
export const TRUST_MODES = ['all', 'humans', 'none'];
/** @type {readonly ExecutorMode[]} */
export const EXECUTOR_MODES = ['auto', 'host', 'container'];
/** @type {readonly ContainerRuntime[]} */
export const CONTAINER_RUNTIMES = ['docker', 'podman'];

/**
 * Official Node.js LTS image, pinned to the major line. Pin a patch tag or a
 * digest (`--image node:24.x.y-bookworm@sha256:…`) for reproducible jobs; the
 * full (non-slim) variant carries git, which snapshot jobs need for `git init`.
 */
export const DEFAULT_IMAGE = 'node:24-bookworm';
export const DEFAULT_CPUS = '2';
export const DEFAULT_MEMORY = '4g';
export const DEFAULT_PIDS_LIMIT = 1024;
/** Fixed mount point of the job's working directory inside the container. */
export const CONTAINER_WORKDIR = '/workspace';
const KILL_GRACE_MS = 5_000;
const DETECT_TIMEOUT_MS = 15_000;

/** @param {string} text */
export function bounded(text) {
  const points = [...text];
  return points.length <= OUTPUT_LIMIT ? text : `${points.slice(0, OUTPUT_LIMIT).join('')}${TRUNCATED}`;
}

/**
 * The environment a repository command may see: locale, time zone and the
 * host paths a host shell needs. Inherited credentials (KVARM_*, GIT_*,
 * cloud keys) never pass. This is not a sandbox: a host command still has
 * this user's files and network.
 */
export function repositoryEnvironment() {
  const portable = new Set(['PATH', 'HOME', 'LANG', 'TZ', 'TMPDIR']);
  const windows = new Set(['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']);
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (portable.has(upper) || upper.startsWith('LC_') || (process.platform === 'win32' && windows.has(upper))) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * The same filtered environment for a container, minus the variables that
 * name host paths (PATH, HOME, TMPDIR and the Windows ones), which would be
 * wrong inside the image; HOME points at the container's private /tmp.
 * @returns {Array<[string, string]>}
 */
export function containerEnvironment() {
  const hostPaths = new Set(['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']);
  /** @type {Array<[string, string]>} */
  const out = [];
  for (const [key, value] of Object.entries(repositoryEnvironment())) {
    if (value === undefined || hostPaths.has(key.toUpperCase())) continue;
    out.push([key, value]);
  }
  out.push(['HOME', '/tmp']);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * @typedef {object} JobProvenance what the claim says about whose code the job runs (services/ci.ts JobProvenance)
 * @property {number|null} [changeNumber]
 * @property {string|null} [headRef]
 * @property {'head'|'prepared'} [commit]
 * @property {'human'|'agent'|'unknown'} [authorKind]
 * @property {string|null} [authorLogin]
 * @property {{id:string,name:string}|null} [agent]
 * @property {boolean} [agentWorkspaceRef]
 */

/**
 * Whether the policy trusts a job's code enough to run it on the host.
 * `humans` trusts only the exact head of a change a human opened outside the
 * agent workspace namespace; anything it cannot establish is untrusted.
 * @param {TrustMode} trust
 * @param {JobProvenance | null | undefined} provenance
 * @returns {{trusted: boolean, reason: string}}
 */
export function trustOf(trust, provenance) {
  if (trust === 'all') return { trusted: true, reason: '--trust all trusts every job' };
  if (trust === 'none') return { trusted: false, reason: '--trust none trusts no job' };
  if (!provenance || typeof provenance !== 'object') return { trusted: false, reason: 'the platform sent no provenance for this job' };
  const change = typeof provenance.changeNumber === 'number' ? `change #${provenance.changeNumber}` : 'the job';
  if (provenance.authorKind === 'agent') {
    const who = provenance.agent?.name ? `agent "${provenance.agent.name}"` : provenance.agentWorkspaceRef ? `agent workspace ref ${provenance.headRef}` : 'an agent';
    return { trusted: false, reason: `${change} is agent-authored (${who})` };
  }
  if (provenance.agentWorkspaceRef) return { trusted: false, reason: `${change} heads an agent workspace ref` };
  if (provenance.authorKind !== 'human') return { trusted: false, reason: `the author of ${change} is unknown` };
  if (provenance.commit !== 'head') {
    return { trusted: false, reason: `the job runs a platform-prepared commit of ${change}, which can include other changes` };
  }
  return { trusted: true, reason: `${change} is human-authored${provenance.authorLogin ? ` (${provenance.authorLogin})` : ''}` };
}

/**
 * The executor for one job, or a refusal. `container` always isolates;
 * `host` runs trusted jobs and refuses the rest; `auto` runs trusted jobs on
 * the host and isolates the rest when a container runtime is available.
 * @param {{ trust: TrustMode, executor: ExecutorMode, provenance: JobProvenance | null | undefined, runtimeAvailable: boolean }} o
 * @returns {{ run: 'host'|'container'|null, trusted: boolean, reason: string }}
 */
export function planExecution(o) {
  const { trusted, reason } = trustOf(o.trust, o.provenance);
  if (o.executor === 'container') {
    return o.runtimeAvailable ? { run: 'container', trusted, reason } : { run: null, trusted, reason: `${reason}; --executor container needs docker or podman, and none is available` };
  }
  if (trusted) return { run: 'host', trusted, reason };
  if (o.executor === 'host') return { run: null, trusted, reason: `${reason}; --executor host does not run untrusted jobs` };
  return o.runtimeAvailable
    ? { run: 'container', trusted, reason }
    : { run: null, trusted, reason: `${reason}, and no container runtime (docker or podman) is available to isolate it` };
}

/**
 * @typedef {object} ContainerConfig
 * @property {ContainerRuntime} runtime
 * @property {string} [image] defaults to DEFAULT_IMAGE
 * @property {string} [network] passed as --network; unset keeps the runtime's default (network allowed)
 * @property {string} [cpus]
 * @property {string} [memory]
 * @property {number} [pidsLimit]
 * @property {string|null} [user] `uid:gid` inside the container; undefined maps this user's ids, null keeps the image's user
 */

const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const CPUS_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const MEMORY_RE = /^\d+[bkmg]?$/i;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Validates container settings; returns the first problem or null.
 * Values become separate argv entries, but one starting with "-" would
 * still be read as an option by the runtime's parser.
 * @param {Partial<ContainerConfig>} c
 */
export function containerConfigError(c) {
  if (c.runtime !== undefined && !CONTAINER_RUNTIMES.includes(c.runtime)) return `container runtime must be one of ${CONTAINER_RUNTIMES.join(', ')}`;
  if (c.image !== undefined && !IMAGE_RE.test(c.image)) return `invalid image ${JSON.stringify(c.image)}`;
  if (c.network !== undefined && !NETWORK_RE.test(c.network)) return `invalid network ${JSON.stringify(c.network)}`;
  if (c.cpus !== undefined && !(CPUS_RE.test(c.cpus) && Number(c.cpus) > 0)) return `invalid cpus ${JSON.stringify(c.cpus)}`;
  if (c.memory !== undefined && !(MEMORY_RE.test(c.memory) && parseInt(c.memory, 10) > 0)) return `invalid memory ${JSON.stringify(c.memory)}`;
  if (c.pidsLimit !== undefined && !(Number.isInteger(c.pidsLimit) && c.pidsLimit > 0)) return `invalid pids limit ${String(c.pidsLimit)}`;
  if (c.user !== undefined && c.user !== null && !USER_RE.test(c.user)) return `invalid container user ${JSON.stringify(c.user)}`;
  return null;
}

/** The container user that keeps bind-mount files owned by this user, when the platform has numeric ids. */
function hostUser() {
  return typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
}

/**
 * `<runtime> run …` arguments for one job: removed on exit, named so a
 * timeout can kill it, the working directory as the only writable host
 * mount, a read-only root with a private /tmp, no capabilities, no
 * privilege escalation, CPU/memory/pids limits and the filtered environment.
 * @param {ContainerConfig} config
 * @param {{ name: string, workdir: string, command: string, env?: Array<[string, string]> }} job
 * @returns {string[]}
 */
export function containerRunArgs(config, job) {
  const problem = containerConfigError(config);
  if (problem) throw new Error(problem);
  if (!NAME_RE.test(job.name)) throw new Error(`invalid container name ${JSON.stringify(job.name)}`);
  // --mount is comma-separated key=value; a comma in the path would split it.
  if (job.workdir.includes(',')) throw new Error(`the working directory ${JSON.stringify(job.workdir)} contains a comma, which a bind mount cannot carry`);
  const user = config.user === undefined ? hostUser() : config.user;
  const args = [
    'run',
    '--rm',
    '--name',
    job.name,
    '--init',
    '--mount',
    `type=bind,source=${job.workdir},target=${CONTAINER_WORKDIR}`,
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
    config.cpus ?? DEFAULT_CPUS,
    '--memory',
    config.memory ?? DEFAULT_MEMORY,
    '--pids-limit',
    String(config.pidsLimit ?? DEFAULT_PIDS_LIMIT),
  ];
  if (user) {
    args.push('--user', user);
    // Rootless podman maps container ids into subordinate ranges; keep-id
    // maps this user's id through so the bind mount stays writable.
    if (config.runtime === 'podman') args.push('--userns', 'keep-id');
  }
  if (config.network !== undefined) args.push('--network', config.network);
  for (const [key, value] of job.env ?? containerEnvironment()) args.push('--env', `${key}=${value}`);
  args.push('--entrypoint', '/bin/sh', config.image ?? DEFAULT_IMAGE, '-c', job.command);
  return args;
}

/** A container name unique to this job attempt. @param {string} jobId */
export function containerName(jobId) {
  const safe = jobId.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 40);
  return `kvarm-job-${safe || 'job'}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Collects bounded output of a spawned child and resolves on close.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} started
 * @param {() => boolean} timedOut
 * @param {(err: Error) => void} reject
 * @param {(result: ExecResult) => void} resolve
 * @param {() => void} done
 */
function collect(child, started, timedOut, reject, resolve, done) {
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    if (stdout.length < OUTPUT_LIMIT + 1) stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < OUTPUT_LIMIT + 1) stderr += String(chunk);
  });
  child.on('error', (err) => {
    done();
    reject(err);
  });
  child.on('close', (code) => {
    done();
    resolve({ code, stdout: bounded(stdout), stderr: bounded(stderr), timedOut: timedOut(), durationMs: Date.now() - started });
  });
}

/**
 * Runs a command in a host shell with the filtered environment, killing its
 * whole process group on timeout.
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutSeconds
 * @returns {Promise<ExecResult>}
 */
export function executeShell(command, cwd, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const grouped = process.platform !== 'win32';
    const env = repositoryEnvironment();
    const child = nodeSpawn(command, { cwd, shell: true, detached: grouped, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    /** @param {NodeJS.Signals} name */
    const signal = (name) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (err) {
        if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH')) throw err;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutSeconds * 1000);
    collect(child, started, () => timedOut, reject, resolve, () => clearTimeout(timer));
  });
}

/**
 * @typedef {(command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => import('node:child_process').ChildProcess} SpawnFn
 */

/**
 * Runs a command in a container. On timeout the container is killed by
 * name through the runtime (killing only the attached client would leave it
 * running), then the client is killed after a grace period.
 * @param {string} command
 * @param {string} cwd host working directory, bind-mounted at CONTAINER_WORKDIR
 * @param {number} timeoutSeconds
 * @param {ContainerConfig & { name: string, spawn?: SpawnFn }} o
 * @returns {Promise<ExecResult>}
 */
export function executeContainer(command, cwd, timeoutSeconds, o) {
  return new Promise((resolve, reject) => {
    const spawnFn = o.spawn ?? nodeSpawn;
    const args = containerRunArgs(o, { name: o.name, workdir: cwd, command });
    const started = Date.now();
    // The runtime client needs its own configuration (DOCKER_HOST, config
    // dirs); it forwards nothing to the container beyond the --env pairs.
    const child = spawnFn(o.runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        const killer = spawnFn(o.runtime, ['kill', o.name], { stdio: 'ignore' });
        killer.on('error', () => {});
      } catch {
        // The client kill below still ends the job.
      }
      grace = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, KILL_GRACE_MS);
      grace.unref();
    }, timeoutSeconds * 1000);
    collect(child, started, () => timedOut, reject, resolve, () => {
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
    });
  });
}

/**
 * The first container runtime whose daemon answers (`<runtime> info`), the
 * requested one only when `preferred` is set, or null.
 * @param {{ preferred?: ContainerRuntime, spawn?: SpawnFn }} [o]
 * @returns {Promise<ContainerRuntime | null>}
 */
export async function detectRuntime(o = {}) {
  const spawnFn = o.spawn ?? nodeSpawn;
  const candidates = o.preferred ? [o.preferred] : CONTAINER_RUNTIMES;
  for (const runtime of candidates) {
    const ok = await new Promise((resolve) => {
      let child;
      try {
        child = spawnFn(runtime, ['info'], { stdio: 'ignore' });
      } catch {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve(false);
      }, DETECT_TIMEOUT_MS);
      timer.unref();
      child.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0);
      });
    });
    if (ok) return runtime;
  }
  return null;
}
