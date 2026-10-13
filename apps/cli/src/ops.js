// @ts-check
/**
 * CLI adapter over the shared operation registry (@kvarm/ops): every registry
 * entry is a `kvarm <group> <verb>` command that sends the entry's REST
 * request and prints the JSON reply. The MCP server exposes the same entries
 * as tools.
 */

import { OPERATIONS, OperationInputError, buildRequest, requestTarget } from '@kvarm/ops';
import { CliError } from './checkout.js';

/** @typedef {import('@kvarm/ops').Operation} Operation */
/** @typedef {import('@kvarm/ops').Param} Param */

/**
 * @typedef {object} OpsIo
 * @property {NodeJS.ProcessEnv} env
 * @property {(line: string) => void} stdout
 * @property {(line: string) => void} stderr
 * @property {typeof fetch} [apiFetch]
 */

/** @param {string} name */
const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** @param {Param} p */
function placeholder(p) {
  if (p.enum) return `<${p.enum.join('|')}>`;
  return { string: '<string>', integer: '<integer>', boolean: '', 'string[]': '<list>', json: '<json>' }[p.type];
}

/** @param {Operation} op */
export function commandUsage(op) {
  const parts = [`kvarm ${op.command.join(' ')}`];
  for (const p of op.params) {
    if (p.positional) parts.push(p.required ? `<${p.name}>` : `[<${p.name}>]`);
  }
  for (const p of op.params) {
    if (p.positional) continue;
    const flag = `--${kebab(p.name)}${p.type === 'boolean' ? '' : ` ${placeholder(p)}`}`;
    parts.push(p.required ? flag : `[${flag}]`);
  }
  parts.push('[--json]');
  return `usage: ${parts.join(' ')}`;
}

/** @param {Operation} op */
export function commandHelp(op) {
  const rows = op.params.map((p) => {
    const left = p.positional ? `<${p.name}>` : `--${kebab(p.name)}${p.type === 'boolean' ? '' : ` ${placeholder(p)}`}`;
    const extra =
      p.type !== 'string[]' ? '' : p.literal ? ' (repeat the flag once per path; commas are part of the path)' : ' (repeat the flag or separate with commas)';
    return `  ${left.padEnd(28)} ${p.description}${p.required && !p.positional ? ' (required)' : ''}${extra}`;
  });
  rows.push(`  ${'--json'.padEnd(28)} print the reply as one line of JSON (default: indented JSON)`);
  return [
    commandUsage(op),
    '',
    op.description,
    '',
    'arguments:',
    ...rows,
    '',
    `REST: ${op.method} /api/v1${op.path}`,
    `MCP tool: ${op.name}`,
    '',
    'Exit status: 0 success; 1 API or network failure (with --json the error body',
    '{status, error, code, ...} is printed on stdout); 2 usage error.',
  ].join('\n');
}

/** One line per registry command, for `kvarm --help`. */
export function operationsOverview() {
  const width = Math.max(...OPERATIONS.map((op) => op.command.join(' ').length)) + 2;
  return OPERATIONS.map((op) => `  ${op.command.join(' ').padEnd(width)} ${op.description.split(/(?<=\.)\s/)[0]}`).join('\n');
}

/** @param {string} group */
export function groupCommands(group) {
  return OPERATIONS.filter((op) => op.command[0] === group);
}

/**
 * @param {Operation} op
 * @param {string[]} argv arguments after the two command words
 * @returns {{ help: true } | { help: false, json: boolean, args: Record<string, unknown> }}
 */
export function parseOperationArgs(op, argv) {
  const usage = (/** @type {string} */ msg) => new CliError(msg, 2);
  const positionals = op.params.filter((p) => p.positional);
  /** @type {Map<string, Param>} */
  const flags = new Map(op.params.filter((p) => !p.positional).map((p) => [kebab(p.name), p]));
  /** @type {Record<string, unknown>} */
  const args = {};
  let json = false;
  let next = 0;

  /**
   * @param {Param} p
   * @param {string} raw
   */
  const assign = (p, raw) => {
    switch (p.type) {
      case 'integer':
        if (!/^-?\d+$/.test(raw)) throw usage(`argument "${p.name}" must be an integer, got "${raw}"`);
        args[p.name] = Number(raw);
        return;
      case 'string[]': {
        const list = /** @type {string[]} */ (args[p.name] ?? []);
        if (p.literal) list.push(raw);
        else list.push(...raw.split(',').filter((s) => s.length > 0));
        args[p.name] = list;
        return;
      }
      case 'json':
        try {
          args[p.name] = JSON.parse(raw);
        } catch {
          throw usage(`argument "${p.name}" must be JSON, got ${JSON.stringify(raw)}`);
        }
        return;
      case 'boolean':
        // Only the two spellings mean anything; "0", "no" or any other value
        // is a usage error, not a truthy coercion that silently flips a flag.
        if (raw === 'true') args[p.name] = true;
        else if (raw === 'false') args[p.name] = false;
        else throw usage(`argument "${p.name}" must be true or false, got "${raw}"`);
        return;
      default:
        args[p.name] = raw;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      const p = flags.get(name);
      if (!p) throw usage(`unknown option "--${name}" for kvarm ${op.command.join(' ')}`);
      if (p.type === 'boolean' && eq === -1) {
        args[p.name] = true;
        continue;
      }
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw usage(`option "--${name}" needs a value`);
      assign(p, value);
      continue;
    }
    const p = positionals[next++];
    if (!p) throw usage(`unexpected argument "${a}"`);
    assign(p, a);
  }
  return { help: false, json, args };
}

/**
 * The explicit recovery commands for a refusal caused by a pinned dependency.
 *
 * @param {string} code
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} args
 * @returns {string | null}
 */
function dependencyRecovery(code, body, args) {
  const repo = typeof args.repo === 'string' ? args.repo : '<owner/repo>';
  if (code === 'REVISION_NOT_CURRENT' && typeof body.currentRevision === 'string') {
    return `the source's current revision is ${body.currentRevision}; retry with --revision ${body.currentRevision}`;
  }
  if (!['DEPENDENCY_BROKEN', 'DEPENDENCY_STALE', 'DEPENDENCY_PENDING'].includes(code) || !Array.isArray(body.dependencies)) return null;
  const dep = /** @type {Record<string, unknown> | undefined} */ (body.dependencies[0]);
  if (!dep || typeof dep.id !== 'string' || typeof dep.workspaceId !== 'string') return null;
  const at = `${repo} ${dep.workspaceId} ${dep.id}`;
  const list = `inspect with "kvarm deps list ${repo} ${dep.workspaceId}"`;
  const detach = `"kvarm deps detach ${at}"`;
  if (code === 'DEPENDENCY_PENDING') return `${list}; land workspace ${dep.onWorkspace}'s change first, or ${detach}`;
  const repin =
    code === 'DEPENDENCY_STALE' && typeof dep.sourceHead === 'string'
      ? `kvarm deps repin ${at} --revision ${dep.sourceHead}`
      : `kvarm deps repin ${at} --on-workspace <live-workspace> --revision <its-head>`;
  return `${list}, then recover explicitly: "${repin}" or ${detach}`;
}

/**
 * @param {Operation} op
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} args
 * @param {string | null} retryAfter
 */
function hint(op, status, body, args, retryAfter) {
  const code = typeof body.code === 'string' ? body.code : '';
  const cmd = `kvarm ${op.command.join(' ')}`;
  const recovery = dependencyRecovery(code, body, args);
  if (recovery) return recovery;
  if (status === 401) return 'set KVARM_PAT to a valid personal access token with the api scope (or an unexpired agent token)';
  if (status === 403 && code === 'INSUFFICIENT_SCOPE') return 'the token lacks the api scope or role this needs; use a token minted with the api scope';
  if (status === 403) return `your account or token lacks the role this needs${args.repo ? ` on ${args.repo}` : ''}; ask an admin for a grant`;
  if (status === 404 && code === 'NOT_FOUND' && args.repo) {
    return `${args.repo} does not exist or is private to you; check owner/name and that KVARM_PAT can read it`;
  }
  if (status === 404) return `check the identifiers you passed to ${cmd}`;
  if (status === 409) return 'the current state conflicts with this request; read the current state (details above) and retry';
  if (status === 400 || status === 422) return `fix the argument named in the error; run "${cmd} --help"`;
  if (status === 429) return `rate limited; retry after ${retryAfter ?? '60'} seconds`;
  if (status >= 500) return 'platform or storage error; retry shortly';
  return `run "${cmd} --help"`;
}

/**
 * Runs one registry operation. Returns the exit code.
 *
 * @param {Operation} op
 * @param {string[]} argv
 * @param {OpsIo} io
 * @returns {Promise<number>}
 */
export async function runOperation(op, argv, io) {
  const parsed = parseOperationArgs(op, argv);
  if (parsed.help) {
    io.stdout(commandHelp(op));
    return 0;
  }
  const res = await callOperation(op, parsed.args, io);
  if (res.ok) {
    io.stdout(parsed.json ? JSON.stringify(res.data) : JSON.stringify(res.data, null, 2));
    return 0;
  }
  return reportFailure(op, parsed.args, res, parsed.json, io);
}

/**
 * @typedef {object} OperationReply
 * @property {boolean} ok
 * @property {number} status
 * @property {unknown} data parsed JSON (or the raw text of a non-JSON reply)
 * @property {string} text
 * @property {string | null} retryAfter
 */

/**
 * Sends one registry operation and reads its reply. Usage problems throw
 * CliError (exit 2); an unreachable platform throws CliError (exit 1).
 *
 * @param {Operation} op
 * @param {Record<string, unknown>} args
 * @param {OpsIo} io
 * @returns {Promise<OperationReply>}
 */
export async function callOperation(op, args, io) {
  let built;
  try {
    built = buildRequest(op, args);
  } catch (err) {
    if (err instanceof OperationInputError) throw new CliError(err.message, 2);
    throw err;
  }
  const baseUrl = io.env.KVARM_BASE_URL;
  if (!baseUrl) throw new CliError('KVARM_BASE_URL is not set (e.g. https://kvarm.example.com)', 2);
  if (!/^https?:\/\//.test(baseUrl)) throw new CliError(`KVARM_BASE_URL must be an http(s) URL, got "${baseUrl}"`, 2);
  /** @type {Record<string, string>} */
  const headers = { accept: 'application/json' };
  if (io.env.KVARM_PAT) headers.authorization = `Bearer ${io.env.KVARM_PAT}`;
  if (built.body !== undefined) headers['content-type'] = 'application/json';
  const url = new URL(requestTarget(built), baseUrl);
  const doFetch = io.apiFetch ?? globalThis.fetch;
  let res;
  try {
    res = await doFetch(url, {
      method: built.method,
      headers,
      ...(built.body !== undefined ? { body: JSON.stringify(built.body) } : {}),
    });
  } catch (err) {
    const cause = /** @type {{ cause?: { code?: string, message?: string } }} */ (err).cause;
    throw new CliError(`could not reach ${url.origin}: ${cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err))}`, 1);
  }
  const text = await res.text();
  /** @type {unknown} */
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON reply
  }
  return { ok: res.ok, status: res.status, data, text, retryAfter: res.headers.get('retry-after') };
}

/**
 * Prints a failed reply (code, cause, details and a next step) and returns exit code 1.
 *
 * @param {Operation} op
 * @param {Record<string, unknown>} args
 * @param {OperationReply} res
 * @param {boolean} json
 * @param {OpsIo} io
 * @param {string} [label] the command shown in the message (default: the operation's)
 */
export function reportFailure(op, args, res, json, io, label = `kvarm ${op.command.join(' ')}`) {
  const { data, text } = res;
  /** @type {Record<string, unknown>} */
  const body = data && typeof data === 'object' && !Array.isArray(data) ? /** @type {Record<string, unknown>} */ (data) : { error: text.slice(0, 200) };
  if (json) io.stdout(JSON.stringify({ status: res.status, ...body }));
  const { error, code, ...details } = body;
  io.stderr(`${label}: ${code ? `${code} ` : ''}(HTTP ${res.status}): ${typeof error === 'string' ? error : 'request failed'}`);
  if (Object.keys(details).length > 0) io.stderr(`details: ${JSON.stringify(details)}`);
  io.stderr(`hint: ${hint(op, res.status, body, args, res.retryAfter)}`);
  return 1;
}
