// @ts-check
/**
 * `forge status <owner/repo>`: one read-only view of a repository's live
 * coordination state, composed from registry reads only (list_workspaces,
 * list_dependencies per active workspace, get_train, list_tasks). It sends
 * no write and triggers no queue send, so repeated runs are idempotent.
 */

import { findOperation } from '@forge/ops';
import { CliError } from './checkout.js';
import { callOperation, reportFailure } from './ops.js';

/** @typedef {import('./ops.js').OpsIo} OpsIo */

/** Active workspaces whose pins are read (one bounded read each, at most 4 in flight). */
export const STATUS_LIMITS = { workspaces: 100, dependencyReads: 20, inFlight: 4 };

export const STATUS_HELP = `usage: forge status <repo> [--json]

Read-only status of a repository: its active workspaces with their pinned
dependencies (state active, stale, broken or satisfied), the integration
train (entries per target branch, positions, and the waiting reason of an
entry held back by a pin) and the open agent tasks.

arguments:
  <repo>                       Repository as owner/name
  --json                       print the status as one line of JSON (default: indented JSON)

Reads only: GET workspaces?status=active, GET workspaces/:id/dependencies
(for up to ${STATUS_LIMITS.dependencyReads} active workspaces), GET train, GET tasks?status=open.
For the full lists use "forge workspace list", "forge deps list",
"forge train status" and "forge task list".

Exit status: 0 success; 1 API or network failure (with --json the error body
{status, error, code, ...} is printed on stdout); 2 usage error.`;

/**
 * @param {string} name
 */
function op(name) {
  const found = findOperation(name);
  if (!found) throw new Error(`registry operation ${name} is missing`);
  return found;
}

/**
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapBounded(items, limit, fn) {
  /** @type {R[]} */
  const out = Array.from({ length: items.length });
  /** @type {unknown[]} */
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && errors.length === 0) {
      const i = next++;
      try {
        out[i] = await fn(/** @type {T} */ (items[i]));
      } catch (err) {
        errors.push(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (errors.length > 0) throw errors[0];
  return out;
}

/** A failed read, carried to the single failure report. */
class ReadFailed extends Error {
  /**
   * @param {import('@forge/ops').Operation} operation
   * @param {Record<string, unknown>} args
   * @param {import('./ops.js').OperationReply} reply
   */
  constructor(operation, args, reply) {
    super(`${operation.name} failed`);
    this.operation = operation;
    this.args = args;
    this.reply = reply;
  }
}

/**
 * @param {string[]} argv arguments after "status"
 * @param {OpsIo} io
 * @returns {Promise<number>}
 */
export async function runStatus(argv, io) {
  let json = false;
  /** @type {string[]} */
  const positionals = [];
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      io.stdout(STATUS_HELP);
      return 0;
    }
    if (a === '--json') json = true;
    else if (a.startsWith('-')) throw new CliError(`unknown option "${a}" for forge status`, 2);
    else positionals.push(a);
  }
  if (positionals.length !== 1) throw new CliError('expected <owner/repo>', 2);
  const repo = /** @type {string} */ (positionals[0]);

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  const read = async (name, args) => {
    const operation = op(name);
    const reply = await callOperation(operation, args, io);
    if (!reply.ok) throw new ReadFailed(operation, args, reply);
    return /** @type {Record<string, unknown>} */ (reply.data);
  };

  try {
    // Settle every read before reporting, so no request is still in flight when the command exits.
    const settled = await Promise.allSettled([
      read('list_workspaces', { repo, status: 'active', limit: STATUS_LIMITS.workspaces }),
      read('get_train', { repo, limit: 100 }),
      read('list_tasks', { repo, status: 'open', limit: 100 }),
    ]);
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
    const [workspaces, train, tasks] = /** @type {[Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]} */ (
      settled.map((s) => /** @type {PromiseFulfilledResult<Record<string, unknown>>} */ (s).value)
    );
    const list = /** @type {Array<Record<string, unknown>>} */ (Array.isArray(workspaces.workspaces) ? workspaces.workspaces : []);
    const pinned = list.slice(0, STATUS_LIMITS.dependencyReads);
    const pins = await mapBounded(pinned, STATUS_LIMITS.inFlight, (w) => read('list_dependencies', { repo, workspace: String(w.id) }));
    const status = {
      repo,
      workspaces: list.map((w, i) => (i < pinned.length ? { ...w, dependencies: pins[i]?.dependencies ?? [] } : w)),
      workspacesTruncated: Boolean(workspaces.nextCursor) || list.length > pinned.length,
      train,
      tasks,
    };
    io.stdout(json ? JSON.stringify(status) : JSON.stringify(status, null, 2));
    return 0;
  } catch (err) {
    if (err instanceof ReadFailed) return reportFailure(err.operation, err.args, err.reply, json, io, 'forge status');
    throw err;
  }
}
