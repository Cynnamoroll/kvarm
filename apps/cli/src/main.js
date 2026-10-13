// @ts-check
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { findCommand } from '@kvarm/ops';
import { CliError, checkout } from './checkout.js';
import { commandHelp, commandUsage, groupCommands, operationsOverview, runOperation } from './ops.js';
import { STATUS_HELP, runStatus } from './status.js';
import { runRunner } from './runner.js';
import {
  CONTAINER_RUNTIMES,
  CONTAINER_WORKDIR,
  DEFAULT_CPUS,
  DEFAULT_IMAGE,
  DEFAULT_MEMORY,
  DEFAULT_PIDS_LIMIT,
  EXECUTOR_MODES,
  TRUST_MODES,
  containerConfigError,
} from './executor.js';

const USAGE = `usage: kvarm <command> [args]

commands:
  checkout <owner/repo> <ref> <dir>   materialize <ref> into <dir> from a snapshot, or git clone
  runner --repo <owner/repo> [--once] [--drain] [--fresh] [--workdir <dir>]
         [--trust humans|all|none] [--executor auto|host|container] [container options]
                                      claim and run CI jobs on this machine
  status <owner/repo> [--json]        read-only status: active workspaces with their pins, the train, open tasks
  help [command]                      show help (for API commands: help <group> <verb>)

environment:
  KVARM_BASE_URL   platform origin, e.g. https://kvarm.example.com (required)
  KVARM_PAT        personal access or agent token (needed for private repos and snapshot demands)`;

const CHECKOUT_HELP = `usage: kvarm checkout <owner/repo> <ref> <dir>

Materializes <ref> (branch, tag or commit SHA) into <dir>, which must be
missing or empty.

With KVARM_PAT set, checkout demands the snapshot (POST .../snapshots/<ref>),
which starts a build for a ref that has none (non-default branches and
workspace refs build lazily, only on demand). If the snapshot is ready it is
downloaded and extracted and checkout prints "source: snapshot". Otherwise,
including while the demanded build is still running, it falls back to
"git clone" + "git checkout" and prints "source: clone"; a later checkout of
the same ref uses the snapshot once it is ready. Without KVARM_PAT checkout
only reads snapshot metadata and never starts a build.

Output (stdout): "source: snapshot|clone" and "sha: <commit>" (plus
"files:" and "bytes:" for a snapshot). The reason for a fallback goes to
stderr. Exit status is 0 on success, 1 on failure and 2 on usage errors.

A snapshot holds the tree only: there is no .git directory and no history.
To commit and push from a snapshot directory, attach it to the repository
first, for example:

  cd <dir>
  git init -q
  git remote add origin "$KVARM_BASE_URL/<owner>/<repo>.git"
  git fetch -q origin <sha>          # the sha printed by checkout
  git reset -q <sha>                 # index and HEAD at <sha>, files untouched
  git switch -q -c <new-branch>      # then commit and push as usual

"git status" is clean right after the reset because the snapshot tree equals
the commit tree.`;

const RUNNER_HELP = `usage: kvarm runner --repo <owner/repo> [--once] [--drain] [--fresh] [--workdir <dir>]
                    [--trust humans|all|none] [--executor auto|host|container]
                    [--container-runtime docker|podman] [--image <image>] [--network <name>]
                    [--cpus <n>] [--memory <size>] [--pids-limit <n>] [--container-user <uid:gid>|image]

Claims CI jobs for the repository, materializes each job's exact immutable
commit through snapshot checkout (with clone fallback), runs the configured
command, heartbeats the 120-second lease, and reports a bounded summary.
The command runs only because the user explicitly started this runner.
--once exits after one job, or immediately when none is queued; --drain keeps
claiming until the queue is empty and then exits, for batch runners that
should stop on their own.

Execution trust: repository commands are code from whoever pushed the
commit, often an agent. Before running a job the runner decides from the
claim's provenance whether it may run on this host:
  --trust humans   (default) the exact head of a change a human opened, on a
                   ref no agent token may push, runs on the host;
                   agent-authored changes, agent-writable refs,
                   platform-prepared merge commits and anything unknown are
                   untrusted
  --trust none     no job is trusted
  --trust all      every job runs on the host, with a warning per job
Untrusted jobs run in a container (--executor auto, the default) or are
refused when no container runtime answers; --executor host refuses them,
--executor container isolates every job. A refused job is reported as a
failure whose summary says why; it is never skipped or left claimed. On the
host the command sees only PATH, HOME, LANG, LC_*, TZ and TMPDIR, but keeps
this user's files and network: environment filtering is not a sandbox.

Container executor (docker, else podman, or --container-runtime): a fresh
container per job (--rm) from --image (default ${DEFAULT_IMAGE}; pin a patch
tag or digest for reproducible jobs), the job's working directory bind-
mounted at ${CONTAINER_WORKDIR} as the only writable host mount, a read-only
root with a private /tmp, all capabilities dropped, no privilege escalation,
this user's uid:gid (--container-user image keeps the image's user),
--cpus ${DEFAULT_CPUS}, --memory ${DEFAULT_MEMORY} and --pids-limit ${DEFAULT_PIDS_LIMIT} by default, and the
runtime's default network unless --network is set (--network none cuts it
off; installs then need a warm workdir). A timeout kills the container.
Container jobs use their own working directories (<workdir>-container), so
they never share files with host jobs.

Jobs run in a persistent working directory per repository, locked to this
runner process (a concurrent runner uses another one), under --workdir
(default $XDG_CACHE_HOME/kvarm/runner, else ~/.cache/kvarm/runner). The
first job checks out fully; later jobs sync the directory to the new commit:
tracked files are rewritten exactly, files the new commit lacks are deleted,
and other untracked paths are removed except dependency caches
(node_modules, .venv, venv, target, .cache, .gradle, .turbo, __pycache__,
.pytest_cache, .mypy_cache, .tox), so installs do not repeat. Any sync
error falls back to a full checkout. --fresh rematerializes every job from
an empty directory.`;

/**
 * @param {string[]} argv
 * @param {{ env: NodeJS.ProcessEnv, stdout: (line: string) => void, stderr: (line: string) => void, fetch?: import('./http.js').HttpFetch, apiFetch?: typeof fetch }} io
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io) {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    const op = rest.length >= 2 ? findCommand(rest.slice(0, 2)) : undefined;
    io.stdout(rest[0] === 'checkout' ? CHECKOUT_HELP : rest[0] === 'runner' ? RUNNER_HELP : rest[0] === 'status' ? STATUS_HELP : op ? commandHelp(op) : usage());
    return command ? 0 : 2;
  }
  let label = command;
  try {
    if (command === 'checkout') return await runCheckout(rest, io);
    if (command === 'runner') return await runCiRunner(rest, io);
    if (command === 'status') return await runStatus(rest, { env: io.env, stdout: io.stdout, stderr: io.stderr, apiFetch: io.apiFetch });
    const verbs = groupCommands(command);
    if (verbs.length === 0) {
      io.stderr(`kvarm: unknown command "${command}"\n\n${usage()}`);
      return 2;
    }
    const [verb, ...args] = rest;
    if (!verb || verb === '--help' || verb === '-h') {
      io.stderr(`kvarm ${command}: expected one of:\n${verbs.map((op) => `  ${commandUsage(op).replace(/^usage: /, '')}`).join('\n')}`);
      return 2;
    }
    const op = findCommand([command, verb]);
    if (!op) {
      io.stderr(`kvarm: unknown command "${command} ${verb}"; "kvarm ${command}" lists its commands`);
      return 2;
    }
    label = `${command} ${verb}`;
    return await runOperation(op, args, { env: io.env, stdout: io.stdout, stderr: io.stderr, apiFetch: io.apiFetch });
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`kvarm ${label}: ${err.message}`);
      if (err.exitCode === 2) io.stderr(`run "kvarm help ${label}" for usage`);
      return err.exitCode;
    }
    io.stderr(`kvarm ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function usage() {
  return `${USAGE}\n\nAPI commands (each maps to one REST endpoint and one MCP tool; "kvarm help <group> <verb>" for details):\n${operationsOverview()}`;
}

/**
 * @param {string[]} args
 * @param {Parameters<typeof main>[1]} io
 */
async function runCheckout(args, io) {
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, strict: true, options: { help: { type: 'boolean', short: 'h' } } });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), 2);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.stdout(CHECKOUT_HELP);
    return 0;
  }
  if (positionals.length !== 3) throw new CliError('expected <owner/repo> <ref> <dir>', 2);
  const [repo, ref, dir] = /** @type {[string, string, string]} */ (positionals);
  const baseUrl = io.env.KVARM_BASE_URL;
  if (!baseUrl) throw new CliError('KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)', 2);
  if (!/^https?:\/\//.test(baseUrl)) throw new CliError(`KVARM_BASE_URL must be an http(s) URL, got "${baseUrl}"`, 2);
  await checkout({ baseUrl, pat: io.env.KVARM_PAT || undefined, repo, ref, dir, env: io.env, stdout: io.stdout, stderr: io.stderr, fetch: io.fetch });
  return 0;
}

/**
 * @param {string[]} args
 * @param {Parameters<typeof main>[1]} io
 */
async function runCiRunner(args, io) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      strict: true,
      options: {
        repo: { type: 'string' },
        once: { type: 'boolean', default: false },
        drain: { type: 'boolean', default: false },
        fresh: { type: 'boolean', default: false },
        workdir: { type: 'string' },
        trust: { type: 'string', default: 'humans' },
        executor: { type: 'string', default: 'auto' },
        'container-runtime': { type: 'string' },
        image: { type: 'string' },
        network: { type: 'string' },
        cpus: { type: 'string' },
        memory: { type: 'string' },
        'pids-limit': { type: 'string' },
        'container-user': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), 2);
  }
  if (parsed.values.help) {
    io.stdout(RUNNER_HELP);
    return 0;
  }
  const repo = parsed.values.repo;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new CliError('expected --repo <owner/repo>', 2);
  const baseUrl = io.env.KVARM_BASE_URL;
  const pat = io.env.KVARM_PAT;
  if (!baseUrl) throw new CliError('KVARM_BASE_URL is not set', 2);
  if (!pat) throw new CliError('KVARM_PAT is not set (the runner requires ci scope)', 2);
  const v = parsed.values;
  const trust = /** @type {import('./executor.js').TrustMode} */ (v.trust);
  const executor = /** @type {import('./executor.js').ExecutorMode} */ (v.executor);
  if (!TRUST_MODES.includes(trust)) throw new CliError(`--trust must be one of ${TRUST_MODES.join(', ')}`, 2);
  if (!EXECUTOR_MODES.includes(executor)) throw new CliError(`--executor must be one of ${EXECUTOR_MODES.join(', ')}`, 2);
  const runtime = /** @type {import('./executor.js').ContainerRuntime | undefined} */ (v['container-runtime']);
  if (runtime !== undefined && !CONTAINER_RUNTIMES.includes(runtime)) throw new CliError(`--container-runtime must be one of ${CONTAINER_RUNTIMES.join(', ')}`, 2);
  /** @type {Partial<import('./executor.js').ContainerConfig>} */
  const container = {};
  if (runtime !== undefined) container.runtime = runtime;
  if (v.image !== undefined) container.image = v.image;
  if (v.network !== undefined) container.network = v.network;
  if (v.cpus !== undefined) container.cpus = v.cpus;
  if (v.memory !== undefined) container.memory = v.memory;
  if (v['pids-limit'] !== undefined) container.pidsLimit = /^\d+$/.test(v['pids-limit']) ? Number(v['pids-limit']) : NaN;
  if (v['container-user'] !== undefined) container.user = v['container-user'] === 'image' ? null : v['container-user'];
  const problem = containerConfigError(container);
  if (problem) throw new CliError(problem, 2);
  await runRunner({
    baseUrl,
    pat,
    repo,
    once: parsed.values.once,
    drainUntilEmpty: parsed.values.drain,
    fresh: parsed.values.fresh,
    trust,
    executor,
    container,
    workRoot: parsed.values.workdir
      ? resolve(parsed.values.workdir)
      : join(io.env.XDG_CACHE_HOME && isAbsolute(io.env.XDG_CACHE_HOME) ? io.env.XDG_CACHE_HOME : join(io.env.HOME || homedir(), '.cache'), 'kvarm', 'runner'),
    stdout: io.stdout,
    stderr: io.stderr,
    apiFetch: io.apiFetch,
  });
  return 0;
}
