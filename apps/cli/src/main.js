// @ts-check
import { parseArgs } from 'node:util';
import { findCommand } from '@forge/ops';
import { CliError, checkout } from './checkout.js';
import { commandHelp, commandUsage, groupCommands, operationsOverview, runOperation } from './ops.js';
import { STATUS_HELP, runStatus } from './status.js';
import { runRunner } from './runner.js';

const USAGE = `usage: forge <command> [args]

commands:
  checkout <owner/repo> <ref> <dir>   materialize <ref> into <dir> from a snapshot, or git clone
  runner --repo <owner/repo> [--once] claim and run CI jobs on this machine
  status <owner/repo> [--json]        read-only status: active workspaces with their pins, the train, open tasks
  help [command]                      show help (for API commands: help <group> <verb>)

environment:
  FORGE_BASE_URL   platform origin, e.g. https://forge-platform.cynnamoroll.workers.dev (required)
  FORGE_PAT        personal access or agent token (needed for private repos and snapshot demands)`;

const CHECKOUT_HELP = `usage: forge checkout <owner/repo> <ref> <dir>

Materializes <ref> (branch, tag or commit SHA) into <dir>, which must be
missing or empty.

With FORGE_PAT set, checkout demands the snapshot (POST .../snapshots/<ref>),
which starts a build for a ref that has none (non-default branches and
workspace refs build lazily, only on demand). If the snapshot is ready it is
downloaded and extracted and checkout prints "source: snapshot". Otherwise,
including while the demanded build is still running, it falls back to
"git clone" + "git checkout" and prints "source: clone"; a later checkout of
the same ref uses the snapshot once it is ready. Without FORGE_PAT checkout
only reads snapshot metadata and never starts a build.

Output (stdout): "source: snapshot|clone" and "sha: <commit>" (plus
"files:" and "bytes:" for a snapshot). The reason for a fallback goes to
stderr. Exit status is 0 on success, 1 on failure and 2 on usage errors.

A snapshot holds the tree only: there is no .git directory and no history.
To commit and push from a snapshot directory, attach it to the repository
first, for example:

  cd <dir>
  git init -q
  git remote add origin "$FORGE_BASE_URL/<owner>/<repo>.git"
  git fetch -q origin <sha>          # the sha printed by checkout
  git reset -q <sha>                 # index and HEAD at <sha>, files untouched
  git switch -q -c <new-branch>      # then commit and push as usual

"git status" is clean right after the reset because the snapshot tree equals
the commit tree.`;

const RUNNER_HELP = `usage: forge runner --repo <owner/repo> [--once]

Claims CI jobs for the repository, materializes each job's exact immutable
commit through snapshot checkout (with clone fallback), runs the configured
command in a shell, heartbeats the 120-second lease, and reports a bounded
summary. The command runs only because the user explicitly started this
runner. --once exits after one job, or immediately when none is queued.`;

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
      io.stderr(`forge: unknown command "${command}"\n\n${usage()}`);
      return 2;
    }
    const [verb, ...args] = rest;
    if (!verb || verb === '--help' || verb === '-h') {
      io.stderr(`forge ${command}: expected one of:\n${verbs.map((op) => `  ${commandUsage(op).replace(/^usage: /, '')}`).join('\n')}`);
      return 2;
    }
    const op = findCommand([command, verb]);
    if (!op) {
      io.stderr(`forge: unknown command "${command} ${verb}"; "forge ${command}" lists its commands`);
      return 2;
    }
    label = `${command} ${verb}`;
    return await runOperation(op, args, { env: io.env, stdout: io.stdout, stderr: io.stderr, apiFetch: io.apiFetch });
  } catch (err) {
    if (err instanceof CliError) {
      io.stderr(`forge ${label}: ${err.message}`);
      if (err.exitCode === 2) io.stderr(`run "forge help ${label}" for usage`);
      return err.exitCode;
    }
    io.stderr(`forge ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function usage() {
  return `${USAGE}\n\nAPI commands (each maps to one REST endpoint and one MCP tool; "forge help <group> <verb>" for details):\n${operationsOverview()}`;
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
  const baseUrl = io.env.FORGE_BASE_URL;
  if (!baseUrl) throw new CliError('FORGE_BASE_URL is not set (e.g. https://forge-platform.cynnamoroll.workers.dev)', 2);
  if (!/^https?:\/\//.test(baseUrl)) throw new CliError(`FORGE_BASE_URL must be an http(s) URL, got "${baseUrl}"`, 2);
  await checkout({ baseUrl, pat: io.env.FORGE_PAT || undefined, repo, ref, dir, env: io.env, stdout: io.stdout, stderr: io.stderr, fetch: io.fetch });
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
  const baseUrl = io.env.FORGE_BASE_URL;
  const pat = io.env.FORGE_PAT;
  if (!baseUrl) throw new CliError('FORGE_BASE_URL is not set', 2);
  if (!pat) throw new CliError('FORGE_PAT is not set (the runner requires ci scope)', 2);
  await runRunner({
    baseUrl,
    pat,
    repo,
    once: parsed.values.once,
    stdout: io.stdout,
    stderr: io.stderr,
    apiFetch: io.apiFetch,
  });
  return 0;
}
