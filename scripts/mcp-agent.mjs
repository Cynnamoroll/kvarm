#!/usr/bin/env node
/**
 * MCP client for the Kvarm platform (`POST $KVARM_BASE_URL/mcp`), built on
 * the official SDK client (`client/index.js` + `client/streamableHttp.js`).
 *
 *   node scripts/mcp-agent.mjs info
 *       connect (initialize), print server name/version and capabilities,
 *       then listTools: count, names and a description/input-schema check
 *   node scripts/mcp-agent.mjs call <tool> ['<json args>']
 *       one tools/call; prints the /mcp HTTP status, x-kvarm-cost, isError
 *       and the result JSON
 *   node scripts/mcp-agent.mjs e2e [--keep] [--api-doc <registry table .md>]
 *         [--only auth,registry,parity,visibility,cost,two-agent,dependencies,arena,attribution,dispatch]
 *       live checks for the MCP surface (VAL-MCP-001..010, VAL-COST-017,
 *       VAL-CROSS-012, VAL-ATTR-001..006, VAL-DECISION-001..003, the repo
 *       lifecycle tools fork_repo/delete_repo/import_repo in parity,
 *       comma-containing decision paths across REST, MCP and the kvarm CLI
 *       in attribution, and the conflict-dispatch flow in dispatch:
 *       VAL-DISPATCH-001..007, VAL-WORKFLOW-001..003, VAL-CROSS-004/009). Each
 *       scenario runs in a fresh repo owned by
 *       KVARM_USER, named `mcp-agent-<purpose>-<timestamp>`, seeded by real
 *       git pushes and deleted afterwards (unless --keep).
 *
 * Environment (tokens are read by NAME and never printed):
 *   KVARM_BASE_URL  platform origin
 *   KVARM_PAT       api-scope PAT of KVARM_USER (default admin)
 *   KVARM_PAT_BOT   api-scope PAT of an unrelated user (e2e visibility and attribution)
 *   MCP_TOKEN_ENV   name of the env var holding the token for info/call
 *                   (default KVARM_PAT)
 *   set -a; . ./.env.local; set +a
 *
 * The e2e visibility scenario also flips visibility by a direct remote D1
 * UPDATE (`wrangler d1 execute`, simulating another colo); it needs wrangler
 * on PATH (`. "$HOME/.config/vite-plus/env"`) and is skipped without it.
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper. Exit 0 only when every check held.
 *
 * refs/heads/agents/** is reserved against human pushes, so every push to a
 * workspace ref uses a scratch agent's short-lived (900 s) write token for
 * refs/heads/agents/*, minted per scenario repo and held only in memory. Each
 * token is revoked when its scenario ends and the scratch agent when the run
 * ends, failed runs included.
 *
 * The attribution scenario mints (and afterwards revokes) a short-lived agent
 * token for KVARM_USER to drive one merge as an agent session.
 *
 * The two-agent scenario (VAL-CROSS-001) lands the winner with
 * enqueue_change and polls get_change until the integration train merged
 * it.
 *
 * The arena scenario (VAL-CROSS-012) has KVARM_USER resolve the winner's
 * final-selection escalation over REST before the explicit merge_change; the
 * three candidates refactor distant functions, so the losers stay open.
 *
 * The registry section checks VAL-MCP-003: the 15 original tool names, a
 * description and input schema on every tool and, with --api-doc, that
 * tools/list equals the --api-doc registry table in both directions.
 *
 * The dependencies scenario (VAL-CROSS-007, VAL-CLI-004) has two agents
 * declare intents, read the forecast, pin the consumer to the interface
 * workspace with add_dependency, enqueue the consumer first and the
 * interface second, and watch get_train report the consumer waiting until
 * both land in order; forecast, train, dependency reads and induced
 * failures are compared with the REST equivalents.
 *
 * The dispatch scenario builds three genuine src/app.ts conflicts (draft,
 * review and auto policies). Agents list, claim and complete the
 * resolve-conflict tasks through MCP after pushing a resolution (origin/main
 * merged into the change head) to the claimed workspace with git. The auto
 * change runs the dead-agent path: an MCP claim with a 10 s lease that lapses,
 * a reclaim and completion through the kvarm CLI, and the stale holder's
 * completion refused.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withFixtureRepo } from './lib/fixture-repo.mjs';
import { parseCost } from './lib/fleet.mjs';
import { kvarmBin } from './lib/kvarm-bin.mjs';
import { writeAskpass } from './lib/live.mjs';
import { remoteD1Args } from './lib/wrangler-target.mjs';

const BASE = process.env.KVARM_BASE_URL ?? 'http://localhost:8787';
const OWNER = process.env.KVARM_USER ?? 'admin';
const PLATFORM_DIR = fileURLToPath(new URL('../apps/platform/', import.meta.url));
const eq = isDeepStrictEqual;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg, code = 2) {
  console.error(`mcp-agent: ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// MCP client
// ---------------------------------------------------------------------------

/**
 * Connects with `token` as the Bearer credential. `exchanges` records the
 * status and x-kvarm-cost of every /mcp HTTP response (one per request).
 */
async function connect(token, name = 'mcp-agent') {
  const exchanges = [];
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      exchanges.push({ method: init?.method ?? 'GET', status: res.status, cost: res.headers.get('x-kvarm-cost') });
      return res;
    },
  });
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(transport);
  return { client, exchanges, close: () => client.close() };
}

/** One tools/call: `{isError, data, text, status, cost}` (data is the parsed JSON text). */
async function call(conn, tool, args = {}) {
  const before = conn.exchanges.length;
  const res = await conn.client.callTool({ name: tool, arguments: args });
  const ex = conn.exchanges.slice(before).find((e) => e.method === 'POST') ?? {};
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { isError: res.isError === true, data, text, status: ex.status, cost: ex.cost };
}


function tokenFromEnv() {
  const name = process.env.MCP_TOKEN_ENV ?? 'KVARM_PAT';
  return process.env[name] || die(`${name} is not set`);
}

// ---------------------------------------------------------------------------
// info / call
// ---------------------------------------------------------------------------

async function runInfo() {
  const conn = await connect(tokenFromEnv());
  const server = conn.client.getServerVersion();
  console.log(`connected: server ${server?.name} ${server?.version}; capabilities ${JSON.stringify(conn.client.getServerCapabilities())}`);
  console.log(`initialize -> HTTP ${conn.exchanges[0]?.status} x-kvarm-cost ${conn.exchanges[0]?.cost}`);
  const { tools } = await conn.client.listTools();
  console.log(`listTools: ${tools.length} tools`);
  let ok = true;
  for (const t of tools) {
    const schema = t.inputSchema?.type === 'object';
    const desc = typeof t.description === 'string' && t.description.length > 0;
    if (!schema || !desc) ok = false;
    console.log(`  ${t.name.padEnd(22)} description=${desc ? 'yes' : 'NO'} inputSchema=${schema ? 'yes' : 'NO'} params=${Object.keys(t.inputSchema?.properties ?? {}).join(',')}`);
  }
  await conn.close();
  console.log(ok ? 'every tool has a description and an input schema' : 'FAIL: a tool lacks a description or an input schema');
  return ok ? 0 : 1;
}

async function runCall(tool, rawArgs) {
  if (!tool) die('usage: mcp-agent.mjs call <tool> [json-args]');
  let args = {};
  if (rawArgs) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      die(`arguments must be a JSON object, got ${JSON.stringify(rawArgs)}`);
    }
  }
  const conn = await connect(tokenFromEnv());
  const r = await call(conn, tool, args);
  await conn.close();
  console.log(`tools/call ${tool} -> HTTP ${r.status} x-kvarm-cost ${r.cost} isError=${r.isError}`);
  console.log(r.data !== null ? JSON.stringify(r.data, null, 2) : r.text);
  return r.isError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// e2e
// ---------------------------------------------------------------------------

/**
 * A scratch agent of KVARM_USER whose write tokens (refs/heads/agents/*, one
 * per repo, 900 s) push workspace refs. Token values never leave this closure
 * except as the git askpass environment of a push.
 */
function scratchWorkspaceAgent(pat, ts) {
  let agentId = null;
  const tokens = new Map();
  async function api(path, method, json) {
    const init = { method, headers: { Authorization: `Bearer ${pat}` } };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(`${BASE}/api/v1${path}`, init);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, json: body };
  }
  return {
    async tokenFor(repo) {
      const held = tokens.get(repo);
      if (held) return held.token;
      if (!agentId) {
        const agent = await api('/agents', 'POST', { name: `mcp-agent-ws-${ts}`, description: 'mcp-agent e2e workspace pushes' });
        if (agent.status !== 201) throw new Error(`create scratch workspace agent -> ${agent.status} ${agent.json?.code ?? ''}`);
        agentId = agent.json.agent.id;
      }
      const minted = await api(`/agents/${agentId}/tokens`, 'POST', { repo, role: 'write', refs: ['refs/heads/agents/*'], expiresIn: 900 });
      if (minted.status !== 201) throw new Error(`mint scratch workspace token for ${repo} -> ${minted.status} ${minted.json?.code ?? ''}`);
      tokens.set(repo, { id: minted.json.id, token: minted.json.token });
      return minted.json.token;
    },
    /** Revokes `repo`'s token; null when none was minted, else whether the platform reports it revoked. */
    async revoke(repo) {
      const held = tokens.get(repo);
      if (!held) return null;
      tokens.delete(repo);
      const r = await api(`/agents/${agentId}/tokens/${held.id}`, 'DELETE');
      return r.status === 200 && r.json?.token?.status === 'revoked';
    },
    /** Revokes any remaining tokens and the agent; null when no agent was created. */
    async revokeAll() {
      if (!agentId) return null;
      let ok = true;
      for (const repo of tokens.keys()) ok = (await this.revoke(repo)) && ok;
      const r = await api(`/agents/${agentId}`, 'DELETE');
      return ok && r.status === 200 && r.json?.agent?.status === 'revoked';
    },
  };
}

async function runE2e(argv) {
  const scratch = scratchWorkspaceAgent(process.env.KVARM_PAT || die('KVARM_PAT is not set'), Math.floor(Date.now() / 1000));
  let code = 1;
  try {
    code = await e2eChecks(argv, scratch);
  } finally {
    const revoked = await scratch.revokeAll();
    if (revoked !== null) {
      console.log(`${revoked ? 'PASS' : 'FAIL'}  [cleanup] scratch workspace agent and its tokens revoked`);
      if (!revoked) code = 1;
    }
  }
  return code;
}

async function e2eChecks(argv, scratch) {
  const { values: opts } = parseArgs({ args: argv, options: { keep: { type: 'boolean', default: false }, only: { type: 'string' }, 'api-doc': { type: 'string' } } });
  const PAT = process.env.KVARM_PAT || die('KVARM_PAT is not set');
  const BOT = process.env.KVARM_PAT_BOT || '';
  const TS = Math.floor(Date.now() / 1000);
  const PREFIX = 'mcp-agent';
  const only = opts.only ? new Set(opts.only.split(',')) : null;
  const results = [];

  function check(id, label, ok, detail = '') {
    results.push({ id, ok: Boolean(ok) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${id}] ${label}${detail ? `  -> ${detail}` : ''}`);
    return ok;
  }

  async function http(path, { method = 'GET', json, token = PAT } = {}) {
    const init = { method, headers: token ? { Authorization: `Bearer ${token}` } : {} };
    if (json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(json);
    }
    const res = await fetch(`${BASE}${path}`, init);
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, text, json: body, cost: res.headers.get('x-kvarm-cost') };
  }

  const work = mkdtempSync(join(tmpdir(), 'mcp-agent-'));
  const askpass = writeAskpass(work);

  function git(args, cwd, token = PAT) {
    const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
      cwd,
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: token },
      encoding: 'utf8',
    });
    return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  }
  function mustGit(args, cwd) {
    const r = git(args, cwd);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
    return r.out;
  }
  function writeFiles(dir, files) {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  function commitOn(dir, from, files, msg) {
    mustGit(['checkout', '-q', '--detach', from], dir);
    writeFiles(dir, files);
    mustGit(['add', '-A'], dir);
    mustGit(['commit', '-q', '-m', msg], dir);
    return mustGit(['rev-parse', 'HEAD'], dir);
  }
  /** Pushes as KVARM_USER, or with the scratch workspace token when the destination is a workspace ref. */
  async function pushRetry(dir, url, refspec, token) {
    const dst = refspec.slice(refspec.lastIndexOf(':') + 1);
    const repo = new URL(url).pathname.replace(/^\//, '').replace(/\.git$/, '');
    const as = token ?? (dst.startsWith('refs/heads/agents/') ? await scratch.tokenFor(repo) : PAT);
    for (let i = 0; i < 8; i++) {
      if (git(['push', '-q', url, refspec], dir, as).code === 0) return;
      await sleep(3000);
    }
    throw new Error(`push ${refspec} kept failing`);
  }
  /** One `kvarm ... --json` CLI run as KVARM_USER (KVARM_PAT from the environment). */
  function kvarm(args) {
    const r = spawnSync(kvarmBin(), [...args, '--json'], { env: { ...process.env, KVARM_BASE_URL: BASE }, encoding: 'utf8' });
    let data = null;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      data = null;
    }
    return { code: r.status, data, err: (r.stderr ?? '').trim() };
  }

  const SEED = {
    'README.md': '# mcp agent fixture\n',
    'src/app.ts': 'export const app = 1;\n',
    'src/lib/util.ts': 'export function util(x: number) {\n  return x + 1;\n}\n',
    'docs/guide.md': '# guide\n\nline one\nline two\n',
    'bin/run.sh': '#!/bin/sh\necho run\n',
  };

  async function seeded(repo) {
    const dir = join(work, repo);
    mkdirSync(dir);
    mustGit(['init', '-q', '-b', 'main'], dir);
    writeFiles(dir, SEED);
    chmodSync(join(dir, 'bin/run.sh'), 0o755);
    mustGit(['add', '-A'], dir);
    mustGit(['commit', '-q', '-m', 'base'], dir);
    const url = `${BASE}/${OWNER}/${repo}.git`;
    await pushRetry(dir, url, 'main:refs/heads/main');
    return { dir, url, main: mustGit(['rev-parse', 'HEAD'], dir), api: `/api/v1/repos/${OWNER}/${repo}`, repo: `${OWNER}/${repo}` };
  }

  async function scenario(purpose, visibility, body) {
    if (only && !only.has(purpose)) return;
    const repo = `${PREFIX}-${purpose}-${TS}`;
    console.log(`\n# ${purpose}: ${OWNER}/${repo}`);
    const r = await withFixtureRepo(
      { owner: OWNER, repo, prefix: PREFIX, http: (p, o) => http(p, o), keep: opts.keep, visibility, log: console.log },
      async () => {
        try {
          await body(repo);
        } catch (err) {
          check(purpose, `scenario ${purpose} ran to completion`, false, String(err?.stack ?? err).slice(0, 400));
        } finally {
          const revoked = await scratch.revoke(`${OWNER}/${repo}`);
          if (revoked !== null) check(purpose, 'scratch workspace token revoked', revoked);
        }
      },
    );
    if (!r.ok) check(purpose, 'fixture repo', false, r.reason);
    if (!opts.keep && r.created) {
      const gone = await http(`/api/v1/repos/${OWNER}/${repo}`);
      check(purpose, 'scratch repo deleted (owner readback 404)', gone.status === 404, String(gone.status));
    }
  }

  const owner = await connect(PAT, 'mcp-agent-owner');
  const server = owner.client.getServerVersion();

  // VAL-MCP-001/002
  if (!only || only.has('auth')) {
    console.log('\n# auth');
    const caps = owner.client.getServerCapabilities();
    console.log(`connect -> server ${server?.name} ${server?.version}; capabilities ${JSON.stringify(caps)}; initialize HTTP ${owner.exchanges[0]?.status} x-kvarm-cost ${owner.exchanges[0]?.cost}`);
    const { tools } = await owner.client.listTools();
    check('VAL-MCP-001', 'initialize with a PAT succeeds (server info + tools capability) and listTools works', Boolean(server?.name && server?.version && caps?.tools) && tools.length > 0, `${tools.length} tools`);
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } } });
    for (const [label, headers] of [
      ['no Authorization', {}],
      ['invalid Bearer token', { Authorization: `Bearer kvarm_pat_${'0'.repeat(64)}` }],
    ]) {
      const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: init });
      const text = await res.text();
      console.log(`POST /mcp initialize (${label}) -> ${res.status} ${text} www-authenticate=${res.headers.get('www-authenticate')} x-kvarm-cost ${res.headers.get('x-kvarm-cost')}`);
      check('VAL-MCP-002', `${label} → HTTP 401`, res.status === 401);
    }
  }

  // Registry (VAL-MCP-003 is completed by later features; here every tool must be described and schema'd).
  if (!only || only.has('registry')) {
    console.log('\n# registry');
    const { tools } = await owner.client.listTools();
    const { OPERATIONS } = await import('@kvarm/ops');
    const names = tools.map((t) => t.name);
    console.log(`listTools names (${names.length}): ${names.join(', ')}`);
    check('registry', 'tools/list equals the shared operation registry', eq([...names].sort(), OPERATIONS.map((o) => o.name).sort()));
    check('registry', 'every tool has a description and an object input schema', tools.every((t) => t.description && t.inputSchema?.type === 'object'));
    const original = ['list_repos', 'get_tree', 'read_file', 'compare', 'get_file_diff', 'create_workspace', 'create_change_set', 'get_change', 'merge_change', 'enqueue_change', 'get_attribution', 'set_attribution', 'get_context', 'list_tasks', 'claim_task', 'complete_task'];
    check('registry', 'original tools implemented so far are present', original.every((n) => names.includes(n)), original.filter((n) => !names.includes(n)).join(',') || 'all present');
    const lifecycle = OPERATIONS.filter((o) => o.family === 'repos').map((o) => o.name);
    check('registry', 'every existing repos-family route is a tool (incl. delete, fork, import)', lifecycle.every((n) => names.includes(n)), lifecycle.filter((n) => !names.includes(n)).join(',') || 'all present');
    const del = tools.find((t) => t.name === 'delete_repo');
    check('registry', 'delete_repo is annotated destructive', del?.annotations?.destructiveHint === true);
    // VAL-MCP-003: the 15 original names, and tools/list = the --api-doc registry table both ways.
    const fifteen = original.filter((n) => n !== 'get_context');
    check('VAL-MCP-003', 'all 15 original tool names are listed', fifteen.every((n) => names.includes(n)), fifteen.filter((n) => !names.includes(n)).join(',') || 'all 15 present');
    const schemaless = tools.filter((t) => !(typeof t.description === 'string' && t.description.trim() && t.inputSchema?.type === 'object' && t.inputSchema.properties)).map((t) => t.name);
    check('VAL-MCP-003', 'every tool carries a description and an input schema', schemaless.length === 0, schemaless.join(',') || `${tools.length} tools checked`);
    if (opts['api-doc']) {
      const documented = [...readFileSync(opts['api-doc'], 'utf8').matchAll(/^\| [a-z-]+ \| `([a-z_]+)` \| `kvarm [a-z-]+ [a-z-]+` \|/gm)].map((m) => m[1]);
      const missing = documented.filter((n) => !names.includes(n));
      const undocumented = names.filter((n) => !documented.includes(n));
      console.log(`registry of record ${opts['api-doc']}: ${documented.length} entries; documented but not listed: ${missing.join(',') || 'none'}; listed but undocumented: ${undocumented.join(',') || 'none'}`);
      check('VAL-MCP-003', 'tools/list equals the --api-doc registry table in both directions', missing.length === 0 && undocumented.length === 0 && documented.length === names.length && fifteen.every((n) => documented.includes(n)));
      check('VAL-MCP-003', 'the 15 original names are 15', fifteen.length === 15, String(fifteen.length));
    } else {
      console.log('(--api-doc not given: skipping the registry table comparison)');
    }
  }

  await scenario('parity', 'public', async (repo) => {
    const env = await seeded(repo);
    const { api, dir, main } = env;

    // VAL-MCP-004
    const ml = await call(owner, 'list_repos');
    const rl = await http('/api/v1/repos');
    const mNames = (ml.data?.repos ?? []).map((r) => `${r.owner}/${r.name}`).sort();
    const rNames = (rl.json?.repos ?? []).map((r) => `${r.owner}/${r.name}`).sort();
    console.log(`list_repos -> ${mNames.length} repos (x-kvarm-cost ${ml.cost}); REST GET /repos -> ${rNames.length} repos (x-kvarm-cost ${rl.cost}); only-mcp=${JSON.stringify(mNames.filter((n) => !rNames.includes(n)))} only-rest=${JSON.stringify(rNames.filter((n) => !mNames.includes(n)))}`);
    check('VAL-MCP-004', 'list_repos owner/name set equals REST GET /repos', !ml.isError && rl.status === 200 && eq(mNames, rNames) && mNames.includes(env.repo));

    // VAL-MCP-005
    const lsTree = (spec) =>
      mustGit(['ls-tree', spec], dir)
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [meta, name] = l.split('\t');
          const [mode, type, hash] = meta.split(' ');
          return { name: name.split('/').pop(), type, mode, hash };
        });
    for (const [path, spec] of [
      [undefined, 'main'],
      ['src', 'main:src'],
    ]) {
      const t = await call(owner, 'get_tree', { repo: env.repo, ref: 'main', ...(path ? { path } : {}) });
      const mine = (t.data?.entries ?? []).map((e) => ({ name: e.name, type: e.type, mode: e.mode, hash: e.hash }));
      const truth = lsTree(spec);
      console.log(`get_tree ${path ?? '/'} -> ${JSON.stringify(mine)} (x-kvarm-cost ${t.cost})\ngit ls-tree ${spec} -> ${JSON.stringify(truth)}`);
      check('VAL-MCP-005', `get_tree ${path ?? '<root>'} names/types/modes/hashes equal git ls-tree ${spec}`, !t.isError && eq(mine, truth) && t.data?.sha === main);
    }
    for (const path of ['src/lib/util.ts', 'docs/guide.md']) {
      const f = await call(owner, 'read_file', { repo: env.repo, path, ref: 'main' });
      const truth = mustGit(['show', `main:${path}`], dir) + '\n';
      console.log(`read_file ${path} -> encoding=${f.data?.encoding} size=${f.data?.size} (x-kvarm-cost ${f.cost}); git show bytes=${Buffer.byteLength(truth)}`);
      check('VAL-MCP-005', `read_file ${path} equals git show main:${path} byte for byte`, !f.isError && f.data?.encoding === 'utf-8' && f.data?.content === truth && f.data?.size === Buffer.byteLength(truth));
    }

    // VAL-MCP-006
    const head = commitOn(dir, main, { 'src/app.ts': 'export const app = 2;\nexport const extra = true;\n', 'docs/new.md': '# new\n' }, 'feature');
    await pushRetry(dir, env.url, `${head}:refs/heads/feature`);
    const mc = await call(owner, 'compare', { repo: env.repo, base: 'main', head: 'feature' });
    const rc = await http(`${api}/compare/main...feature`);
    const key = (files) => (files ?? []).map((f) => `${f.status}:${f.path}`).sort();
    console.log(`compare (mcp) files=${JSON.stringify(key(mc.data?.files))} totals=${JSON.stringify(mc.data?.totals)} rating=${JSON.stringify(mc.data?.rating ?? mc.data?.risk?.rating)} (x-kvarm-cost ${mc.cost})\ncompare (REST) files=${JSON.stringify(key(rc.json?.files))} totals=${JSON.stringify(rc.json?.totals)} (x-kvarm-cost ${rc.cost})`);
    check('VAL-MCP-006', 'compare equals REST compare (files, statuses, totals, rating; full body)', !mc.isError && rc.status === 200 && eq(key(mc.data?.files), key(rc.json?.files)) && eq(mc.data?.totals, rc.json?.totals) && eq(mc.data, rc.json));
    const md = await call(owner, 'get_file_diff', { repo: env.repo, base: 'main', head: 'feature', path: 'src/app.ts' });
    const rd = await http(`${api}/compare/main...feature/file?path=src%2Fapp.ts`);
    console.log(`get_file_diff hunks=${JSON.stringify(md.data?.hunks)} (x-kvarm-cost ${md.cost}); REST file diff -> ${rd.status}`);
    check('VAL-MCP-006', 'get_file_diff hunks equal the REST per-file diff', !md.isError && rd.status === 200 && Array.isArray(md.data?.hunks) && eq(md.data, rd.json));

    // VAL-MCP-007 / VAL-MCP-008
    const cw = await call(owner, 'create_workspace', { repo: env.repo, task: 'mcp parity', agent: 'mcp-agent-1' });
    const ws = cw.data ?? {};
    console.log(`create_workspace -> ${cw.text} (x-kvarm-cost ${cw.cost})`);
    const listed = await http(`${api}/workspaces`);
    const restWs = listed.json?.workspaces?.find((w) => w.id === ws.id);
    check('VAL-MCP-007', 'create_workspace returns id/ref/pushUrl shaped like REST and REST lists the same record', !cw.isError && ws.ref?.startsWith(`refs/heads/agents/${ws.id}/`) && ws.pushUrl === env.url && eq(restWs, ws), JSON.stringify(restWs));
    const sha = commitOn(dir, main, { 'src/feature.ts': 'export const feature = 1;\n' }, 'workspace work');
    await pushRetry(dir, env.url, `${sha}:${ws.ref}`);
    const cs = await call(owner, 'create_change_set', { repo: env.repo, workspace: ws.id, title: 'MCP change set', mergePolicy: 'review' });
    console.log(`create_change_set -> ${cs.text} (x-kvarm-cost ${cs.cost})`);
    const restCs = await http(`${api}/changes/${cs.data?.number}`);
    const csKeys = ['number', 'title', 'state', 'mergePolicy', 'kind', 'base', 'head', 'baseSha', 'headSha', 'author', 'createdAt', 'workspace'];
    const differing = Object.keys({ ...cs.data, ...restCs.json }).filter((k) => !eq(cs.data?.[k], restCs.json?.[k]));
    check(
      'VAL-MCP-007',
      'create_change_set object matches REST GET changes/:n (state open, mergePolicy review, head = pushed sha)',
      !cs.isError && cs.data?.state === 'open' && cs.data?.mergePolicy === 'review' && cs.data?.headSha === sha && csKeys.every((k) => eq(cs.data?.[k], restCs.json?.[k])),
      `fields that differ between the create reply and the later GET: ${JSON.stringify(Object.fromEntries(differing.map((k) => [k, { create: cs.data?.[k], get: restCs.json?.[k] }])))}`,
    );
    const gc = await call(owner, 'get_change', { repo: env.repo, number: cs.data?.number });
    check('VAL-MCP-007', 'get_change equals REST GET changes/:n', !gc.isError && eq(gc.data, restCs.json));
    const mg = await call(owner, 'merge_change', { repo: env.repo, number: cs.data?.number });
    console.log(`merge_change -> state=${mg.data?.state} mergeCommit=${mg.data?.mergeCommit} (x-kvarm-cost ${mg.cost})`);
    const after = await http(`${api}/changes/${cs.data?.number}`);
    mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], dir);
    const log = mustGit(['log', 'origin/main', '-1', '--format=%H %P'], dir);
    console.log(`REST GET changes/${cs.data?.number} -> state=${after.json?.state} mergeCommit=${after.json?.mergeCommit}; git log origin/main -1: ${log}`);
    const [tip, ...parents] = log.split(' ');
    const landed = tip === after.json?.mergeCommit && (tip === sha ? parents[0] === main : parents.includes(main) && parents.includes(sha));
    check('VAL-MCP-008', 'merge_change merges: REST state merged with mergeCommit at origin/main (fast-forward to the head, or a merge of main + head)', !mg.isError && mg.data?.state === 'merged' && after.json?.state === 'merged' && landed);
    const wsAfter = await call(owner, 'get_workspace', { repo: env.repo, workspace: ws.id });
    check('VAL-MCP-008', 'the merged workspace reads back merged', wsAfter.data?.status === 'merged', wsAfter.data?.status);

    // VAL-MCP-009
    const errorCases = [
      ['get_tree on a nonexistent repo', 'get_tree', { repo: `${OWNER}/no-such-repo-${TS}` }],
      ['read_file with a missing path', 'read_file', { repo: env.repo, path: 'missing/file.txt' }],
      ['compare with an unknown ref', 'compare', { repo: env.repo, base: 'main', head: 'no-such-ref' }],
      ['create_change_set with a bad workspace id', 'create_change_set', { repo: env.repo, workspace: 'zzzzzzzz', title: 'x' }],
      ['read_file without the required path', 'read_file', { repo: env.repo }],
    ];
    for (const [label, tool, args] of errorCases) {
      const t0 = Date.now();
      const r = await call(owner, tool, args);
      console.log(`${tool} (${label}) -> HTTP ${r.status} isError=${r.isError} ${r.text} in ${Date.now() - t0} ms`);
      // Schema violations are reported by the SDK as plain text; REST and argument errors as {status, error, code} JSON.
      check('VAL-MCP-009', `${label} → isError with a message over HTTP 2xx`, r.isError && r.status >= 200 && r.status < 300 && (typeof r.data?.error === 'string' || r.text.length > 0));
    }

    // Compose returns the composed commit as the workspace head.
    const A = await call(owner, 'create_workspace', { repo: env.repo, task: 'compose A', agent: 'mcp-compose-a' });
    const B = await call(owner, 'create_workspace', { repo: env.repo, task: 'compose B', agent: 'mcp-compose-b' });
    mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], dir);
    const main2 = mustGit(['rev-parse', 'origin/main'], dir);
    await pushRetry(dir, env.url, `${commitOn(dir, main2, { 'a.txt': 'a\n' }, 'A')}:${A.data.ref}`);
    await pushRetry(dir, env.url, `${commitOn(dir, main2, { 'b.txt': 'b\n' }, 'B')}:${B.data.ref}`);
    const comp = await call(owner, 'compose_candidates', { repo: env.repo, workspaces: [A.data.id, B.data.id] });
    const refs = git(['ls-remote', env.url], dir).out;
    const composedRef = comp.data?.workspace?.ref;
    const advertised = refs.split('\n').find((l) => l.endsWith(`\t${composedRef}`))?.split('\t')[0];
    console.log(`compose_candidates -> commitSha=${comp.data?.commitSha} workspace.headSha=${comp.data?.workspace?.headSha} baseSha=${comp.data?.workspace?.baseSha} advertised=${advertised} (x-kvarm-cost ${comp.cost})`);
    check('compose', 'compose_candidates workspace.headSha is the composed commit (not the base)', !comp.isError && comp.data?.workspace?.headSha === comp.data?.commitSha && advertised === comp.data?.commitSha && comp.data?.commitSha !== main2);
    const compRead = await call(owner, 'get_composition', { repo: env.repo, id: comp.data?.id });
    check('compose', 'get_composition readback keeps the composed head', compRead.data?.workspace?.headSha === comp.data?.commitSha);

    // Repository lifecycle tools over the existing routes: fork, read back, delete; import refuses like REST.
    const forkName = `${repo}-fork`;
    try {
      const fk = await call(owner, 'fork_repo', { repo: env.repo, name: forkName });
      const fkRest = await http(`/api/v1/repos/${OWNER}/${forkName}`);
      const parentTree = await call(owner, 'get_tree', { repo: env.repo, ref: 'main' });
      let fkTree = null;
      for (let i = 0; i < 5 && !(fkTree && !fkTree.isError); i++) {
        if (i > 0) await sleep(2000);
        fkTree = await call(owner, 'get_tree', { repo: `${OWNER}/${forkName}`, ref: 'main' });
      }
      console.log(`fork_repo -> ${fk.text} (x-kvarm-cost ${fk.cost}); REST GET fork -> ${fkRest.status} visibility=${fkRest.json?.repo?.visibility}; fork main=${fkTree?.data?.sha} parent main=${parentTree.data?.sha}`);
      check('lifecycle', 'fork_repo creates a private fork with the parent main that REST reads back', !fk.isError && fk.data?.repo?.name === forkName && fkRest.status === 200 && fkRest.json?.repo?.visibility === 'private' && fkTree?.data?.sha === parentTree.data?.sha);
      if (BOT) {
        const bot = await connect(BOT, 'mcp-agent-bot');
        try {
          const bd = await call(bot, 'delete_repo', { repo: `${OWNER}/${forkName}` });
          const still = await http(`/api/v1/repos/${OWNER}/${forkName}`);
          console.log(`kvarm-bot delete_repo -> isError=${bd.isError} ${bd.text}; owner REST GET -> ${still.status}`);
          check('lifecycle', 'delete_repo by an outsider is refused and the repository stays', bd.isError && [403, 404].includes(bd.data?.status) && still.status === 200);
        } finally {
          await bot.close();
        }
      }
      const del = await call(owner, 'delete_repo', { repo: `${OWNER}/${forkName}` });
      const gone = await http(`/api/v1/repos/${OWNER}/${forkName}`);
      console.log(`delete_repo -> ${del.text} (x-kvarm-cost ${del.cost}); REST GET -> ${gone.status}`);
      check('lifecycle', 'delete_repo deletes the fork (REST readback 404)', !del.isError && del.data?.deleted === true && gone.status === 404);
    } finally {
      await http(`/api/v1/repos/${OWNER}/${forkName}`, { method: 'DELETE' });
    }
    const badImport = { url: 'http://example.invalid/src.git', name: `${repo}-import` };
    const imp = await call(owner, 'import_repo', badImport);
    const impRest = await http('/api/v1/import', { method: 'POST', json: badImport });
    console.log(`import_repo (non-HTTPS remote) -> ${imp.text}; REST POST /import -> ${impRest.status} ${impRest.text}`);
    check('lifecycle', 'import_repo answers exactly like REST POST /import (non-HTTPS remote refused)', imp.isError && impRest.status === 400 && eq(imp.data, { status: 400, ...impRest.json }));
  });

  // VAL-MCP-010
  await scenario('visibility', 'public', async (repo) => {
    const env = await seeded(repo);
    const priv = await http('/api/v1/repos', { method: 'POST', json: { name: `${repo}-private`, visibility: 'private' } });
    if (!BOT) {
      check('VAL-MCP-010', 'KVARM_PAT_BOT is set', false);
      return;
    }
    const bot = await connect(BOT, 'mcp-agent-bot');
    try {
      const privRepo = `${OWNER}/${repo}-private`;
      const restPriv = await http(`/api/v1/repos/${privRepo}`, { token: BOT });
      const tPriv = await call(bot, 'get_tree', { repo: privRepo });
      const cPriv = await call(bot, 'compare', { repo: privRepo, base: 'main', head: 'main' });
      console.log(`private repo (${priv.status}): REST bot -> ${restPriv.status} ${restPriv.text}; get_tree bot -> ${tPriv.text}; compare bot -> ${cPriv.text}`);
      check('VAL-MCP-010', '(a) private repo: REST 404 for the bot; get_tree and compare isError not-found with no data', restPriv.status === 404 && tPriv.isError && cPriv.isError && tPriv.data?.status === 404 && cPriv.data?.status === 404 && !tPriv.data?.entries && !cPriv.data?.files);
      const missing = await call(owner, 'get_tree', { repo: `${OWNER}/no-such-repo-${TS}` });
      const present = await call(owner, 'get_tree', { repo: env.repo });
      check('VAL-MCP-010', '(b) owner: nonexistent repo isError; existing repo returns entries', missing.isError && !present.isError && present.data?.entries?.length > 0);

      const reads = [
        ['get_repo', { repo: env.repo }],
        ['get_tree', { repo: env.repo, ref: 'main' }],
        ['read_file', { repo: env.repo, path: 'README.md', ref: 'main' }],
        ['read_file', { repo: env.repo, path: 'README.md', ref: env.main }],
      ];
      const sweep = async (conn) => Promise.all(reads.map(([tool, args]) => call(conn, tool, args)));
      const restRead = (token) => http(`${env.api}/contents?path=README.md&ref=main`, { token });

      // Owner-PATCH flip: warmed public reads, then the documented visibility update.
      await sweep(bot);
      const warm = await sweep(bot);
      console.log(`warm (public, bot): ${warm.map((r, i) => `${reads[i][0]} isError=${r.isError} cost=${r.cost}`).join(' | ')}`);
      check('VAL-MCP-010', '(c) warm: bot reads the public repo through MCP', warm.every((r) => !r.isError));
      const flip = await http(env.api, { method: 'PATCH', json: { visibility: 'private' } });
      const denied = await sweep(bot);
      const restDenied = await restRead(BOT);
      const ownerOk = await sweep(owner);
      console.log(`PATCH visibility private -> ${flip.status}; bot MCP: ${denied.map((r, i) => `${reads[i][0]} ${r.text} cost=${r.cost}`).join(' | ')}; REST bot -> ${restDenied.status}; owner MCP isError=${ownerOk.map((r) => r.isError).join(',')}`);
      check(
        'VAL-MCP-010',
        '(c) owner flip to private: bot MCP reads isError 404 immediately with no warmed data, matching REST 404; owner still reads',
        flip.status === 200 && denied.every((r) => r.isError && r.data?.status === 404 && !r.text.includes('mcp agent fixture') && !r.data?.entries) && restDenied.status === 404 && ownerOk.every((r) => !r.isError),
      );

      // Direct D1 flip (another colo): the cached-public repo row survives here, so only the authoritative lookup can deny.
      const wrangler = spawnSync('npx', ['wrangler', '--version'], { cwd: PLATFORM_DIR, encoding: 'utf8' });
      if (wrangler.status !== 0) {
        console.log('# direct D1 flip skipped: wrangler not on PATH');
        return;
      }
      const d1 = (visibility) => {
        const r = spawnSync(process.execPath, remoteD1Args(`UPDATE repos SET visibility = '${visibility}' WHERE owner_login = '${OWNER}' AND name = '${repo}'`), { cwd: PLATFORM_DIR, encoding: 'utf8' });
        let changes = null;
        try {
          changes = JSON.parse(r.stdout)[0]?.meta?.changes ?? null;
        } catch {
          changes = null;
        }
        return { code: r.status, changes };
      };
      const back = await http(env.api, { method: 'PATCH', json: { visibility: 'public' } });
      await sweep(bot);
      const rewarm = await sweep(bot);
      await restRead(BOT);
      check('VAL-MCP-010', '(c) re-publicized and re-warmed for the direct D1 flip', back.status === 200 && rewarm.every((r) => !r.isError));
      const t0 = Date.now();
      const flipped = d1('private');
      const denied2 = await sweep(bot);
      const restDenied2 = await restRead(BOT);
      const ownerOk2 = await sweep(owner);
      console.log(`direct D1 UPDATE private -> exit ${flipped.code} changes=${flipped.changes} (${Date.now() - t0} ms incl. wrangler); bot MCP: ${denied2.map((r, i) => `${reads[i][0]} status=${r.data?.status} cost=${r.cost}`).join(' | ')}; REST bot -> ${restDenied2.status} cost=${restDenied2.cost}; owner isError=${ownerOk2.map((r) => r.isError).join(',')}`);
      check(
        'VAL-MCP-010',
        '(c) direct D1 flip with the cached-public row retained: bot MCP denied (404, no data) like REST; owner authorized',
        flipped.code === 0 && flipped.changes === 1 && denied2.every((r) => r.isError && r.data?.status === 404 && !r.text.includes('mcp agent fixture')) && restDenied2.status === 404 && ownerOk2.every((r) => !r.isError),
      );
    } finally {
      await bot.close();
      if (priv.status === 201) await http(`/api/v1/repos/${OWNER}/${repo}-private`, { method: 'DELETE' });
    }
  });

  // VAL-COST-017
  await scenario('cost', 'private', async (repo) => {
    const env = await seeded(repo);
    const args = { repo: env.repo, path: 'src/lib/util.ts', ref: 'main' };
    await call(owner, 'read_file', args);
    const m = await call(owner, 'read_file', args);
    const rest = `${env.api}/contents?path=src%2Flib%2Futil.ts&ref=main`;
    await http(rest);
    const r = await http(rest);
    const mc = parseCost(m.cost);
    const rc = parseCost(r.cost);
    console.log(`warm MCP read_file /mcp x-kvarm-cost: ${m.cost}\nwarm REST GET contents x-kvarm-cost: ${r.cost}`);
    check('VAL-COST-017', 'warm MCP read_file work counters (d1, art, r2b) equal the warm REST file read', !m.isError && r.status === 200 && ['d1', 'art', 'r2b'].every((k) => Number.isInteger(mc[k]) && mc[k] === rc[k]), JSON.stringify({ mcp: mc, rest: rc }));
    const sha = mustGit(['rev-parse', 'HEAD'], env.dir);
    await call(owner, 'read_file', { ...args, ref: sha });
    const ms = await call(owner, 'read_file', { ...args, ref: sha });
    await http(`${env.api}/contents?path=src%2Flib%2Futil.ts&ref=${sha}`);
    const rs = await http(`${env.api}/contents?path=src%2Flib%2Futil.ts&ref=${sha}`);
    console.log(`warm by commit SHA: MCP ${ms.cost} | REST ${rs.cost}`);
    check('VAL-COST-017', 'warm read by commit SHA: identical counters, cache hit, art=0', ['d1', 'art', 'r2b', 'do'].every((k) => parseCost(ms.cost)[k] === parseCost(rs.cost)[k]) && parseCost(ms.cost).art === 0 && parseCost(ms.cost).cache === 'hit');
  });

  // VAL-CROSS-001: two agents work through MCP only (plus git push); the caller lands the winner through the queue.
  await scenario('two-agent', 'public', async (repo) => {
    const env = await seeded(repo);
    const a1 = await connect(PAT, 'agent-one');
    const a2 = await connect(PAT, 'agent-two');
    try {
      const w1 = (await call(a1, 'create_workspace', { repo: env.repo, task: 'speed up util', agent: 'agent-one', intent: { paths: ['src/lib/util.ts'] } })).data;
      const w2 = (await call(a2, 'create_workspace', { repo: env.repo, task: 'speed up util', agent: 'agent-two', intent: { paths: ['src/lib/util.ts'] } })).data;
      const ov = await call(a2, 'get_overlap', { repo: env.repo });
      console.log(`workspaces ${w1.id} ${w2.id}; get_overlap -> ${ov.text.slice(0, 300)}`);
      const s1 = commitOn(env.dir, env.main, { 'src/lib/util.ts': 'export function util(x: number) {\n  return x + 1; // agent one\n}\n' }, 'agent one');
      const s2 = commitOn(env.dir, env.main, { 'src/lib/util.ts': 'export const util = (x: number) => x + 1; // agent two\n' }, 'agent two');
      await pushRetry(env.dir, env.url, `${s1}:${w1.ref}`);
      await pushRetry(env.dir, env.url, `${s2}:${w2.ref}`);
      const c1 = (await call(a1, 'create_change_set', { repo: env.repo, workspace: w1.id, title: 'agent one', mergePolicy: 'review' })).data;
      const c2 = (await call(a2, 'create_change_set', { repo: env.repo, workspace: w2.id, title: 'agent two', mergePolicy: 'review' })).data;
      const cands = await call(owner, 'list_candidates', { repo: env.repo, workspaces: [w1.id, w2.id] });
      console.log(`change sets #${c1?.number} #${c2?.number}; list_candidates -> ${cands.isError ? cands.text : JSON.stringify(cands.data?.candidates?.map((c) => ({ workspace: c.workspace, totals: c.vsBase?.totals })))}`);
      check('two-agent', 'both agents created workspaces and change sets through MCP; candidates compared', w1?.id && w2?.id && c1?.state === 'open' && c2?.state === 'open' && !cands.isError);
      // Agent one records its session on its own commit (a fast-forward publishes that commit as is).
      const at = await call(a1, 'set_attribution', { repo: env.repo, sha: s1, agent: 'agent-one', session: `two-agent-${TS}`, promptHash: 'a'.repeat(64) });
      const ranked = await http(`${env.api}/candidates?base=main&workspaces=${w1.id},${w2.id}`);
      console.log(`set_attribution ${s1} -> isError=${at.isError} ${at.isError ? at.text.slice(0, 200) : ''}; GET candidates -> ${ranked.status} ${JSON.stringify(ranked.json?.candidates?.map((c) => ({ workspace: c.workspace, rank: c.rank, score: c.score })) ?? ranked.text.slice(0, 200))}`);
      // The caller lands the winner through the queue: with review policy the enqueue approves the current head.
      const eq1 = await call(owner, 'enqueue_change', { repo: env.repo, number: c1.number, headSha: s1, attribution: { agent: 'agent-one', session: `two-agent-${TS}` } });
      const q1 = await call(owner, 'get_queue', { repo: env.repo });
      console.log(`enqueue_change #${c1.number} -> isError=${eq1.isError} ${eq1.text.slice(0, 300)} (x-kvarm-cost ${eq1.cost})\nget_queue -> ${q1.text.slice(0, 300)} (x-kvarm-cost ${q1.cost})`);
      const listed = (q1.data?.entries ?? []).some((e) => e.number === c1.number);
      const early = !listed && (await call(owner, 'get_change', { repo: env.repo, number: c1.number })).data?.state === 'merged';
      check('VAL-CROSS-001', 'enqueue_change through MCP queues the winner; get_queue lists it (or the train already merged it)', !eq1.isError && eq1.data?.entry?.number === c1.number && (listed || early));
      let landed = null;
      const t0 = Date.now();
      while (Date.now() - t0 < 120_000) {
        const g = await call(owner, 'get_change', { repo: env.repo, number: c1.number });
        if (g.data?.state === 'merged') {
          landed = g.data;
          break;
        }
        await sleep(3000);
      }
      const loser = await call(owner, 'get_change', { repo: env.repo, number: c2.number });
      mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], env.dir);
      const tip = mustGit(['rev-parse', 'origin/main'], env.dir);
      const util = mustGit(['show', 'origin/main:src/lib/util.ts'], env.dir);
      console.log(`poll get_change #${c1.number} -> ${landed ? `merged ${landed.mergeCommit} after ${Math.round((Date.now() - t0) / 1000)} s` : 'not merged within 120 s'}; origin/main ${tip}; loser #${c2.number} state=${loser.data?.state}; origin/main util.ts: ${JSON.stringify(util)}`);
      check('VAL-CROSS-001', 'winner merged by the train with no merge call; merge commit is origin/main; loser stays open', Boolean(landed) && landed.mergeCommit === tip && util.includes('agent one') && loser.data?.state === 'open');
      const attr = await call(owner, 'get_attribution', { repo: env.repo, sha: tip });
      console.log(`get_attribution ${tip} -> ${attr.text}`);
      check('VAL-CROSS-001', 'get_attribution on the landed commit names the winning agent', !attr.isError && attr.data?.agent === 'agent-one', attr.text.slice(0, 200));
      const ab = await call(a2, 'abandon_workspace', { repo: env.repo, workspace: w2.id });
      check('two-agent', 'loser explicitly abandoned through MCP', !ab.isError && ab.data?.status === 'abandoned', ab.text.slice(0, 200));
    } finally {
      await a1.close();
      await a2.close();
    }
  });

  // VAL-CROSS-007 and VAL-CLI-004: intent → forecast → pin → dependency-ordered publication, MCP against REST.
  await scenario('dependencies', 'public', async (repo) => {
    const env = await seeded(repo);
    const iface = await connect(PAT, 'agent-interface');
    const consumer = await connect(PAT, 'agent-consumer');
    const restErr = (r) => ({ status: r.status, code: r.json?.code });
    const mcpErr = (r) => ({ status: r.data?.status, code: r.data?.code });
    try {
      const wa = (await call(iface, 'create_workspace', { repo: env.repo, task: 'greeter interface', agent: 'agent-interface', intent: { paths: ['src/greet.ts'] } })).data;
      const wb = (await call(consumer, 'create_workspace', { repo: env.repo, task: 'greeter consumer', agent: 'agent-consumer', intent: { paths: ['src/app.ts', 'src/greet.ts'] } })).data;
      const ra = commitOn(env.dir, env.main, { 'src/greet.ts': 'export interface Greeter {\n  greet(name: string): string;\n}\n' }, 'greeter interface');
      await pushRetry(env.dir, env.url, `${ra}:${wa.ref}`);
      // The consumer builds on the interface commit.
      const rb = commitOn(env.dir, ra, { 'src/app.ts': "import type { Greeter } from './greet';\nexport const app = (g: Greeter) => g.greet('kvarm');\n" }, 'greeter consumer');
      await pushRetry(env.dir, env.url, `${rb}:${wb.ref}`);

      // The forecast shows A's declared and observed match on src/greet.ts once its push is reconciled.
      let fc = null;
      let mine = null;
      for (let i = 0; i < 30; i++) {
        fc = await call(consumer, 'forecast', { repo: env.repo, paths: ['src/greet.ts'], exclude: wb.id });
        mine = fc.data?.matches?.find((m) => m.workspace === wa.id);
        if (mine?.matchKinds?.includes('declared') && mine.matchKinds.includes('observed')) break;
        await sleep(2000);
      }
      const fcRest = await http(`${env.api}/forecast?paths=src/greet.ts&exclude=${wb.id}`);
      console.log(`forecast (MCP) -> A ${wa.id} matchKinds=${JSON.stringify(mine?.matchKinds)} revision=${mine?.observedHeadSha} (x-kvarm-cost ${fc?.cost}); REST forecast -> ${fcRest.status} (x-kvarm-cost ${fcRest.cost})`);
      check('VAL-CROSS-007', "the forecast shows A's declared and observed match on the interface path", !fc.isError && mine?.matchKinds?.includes('declared') && mine.matchKinds.includes('observed') && mine.observedHeadSha === ra);
      check('VAL-CLI-004', 'forecast: MCP state = REST state', fcRest.status === 200 && eq(fc.data?.matches, fcRest.json?.matches));

      // Induced failures: the same {status, code} on both surfaces.
      const ghost = '0123456789abcdef';
      const failures = [
        ['pin at a stale revision', await call(consumer, 'add_dependency', { repo: env.repo, workspace: wb.id, onWorkspace: wa.id, revision: env.main }), await http(`${env.api}/workspaces/${wb.id}/dependencies`, { method: 'POST', json: { onWorkspace: wa.id, revision: env.main } })],
        ['pin on a nonexistent source', await call(consumer, 'add_dependency', { repo: env.repo, workspace: wb.id, onWorkspace: ghost, revision: ra }), await http(`${env.api}/workspaces/${wb.id}/dependencies`, { method: 'POST', json: { onWorkspace: ghost, revision: ra } })],
        ['list pins of a nonexistent workspace', await call(consumer, 'list_dependencies', { repo: env.repo, workspace: ghost }), await http(`${env.api}/workspaces/${ghost}/dependencies`)],
        ['claim a nonexistent task', await call(consumer, 'claim_task', { repo: env.repo, task: ghost }), await http(`${env.api}/tasks/${ghost}/claim`, { method: 'POST', json: {} })],
        ['dequeue a nonexistent change', await call(consumer, 'dequeue_change', { repo: env.repo, number: 9999 }), await http(`${env.api}/changes/9999/enqueue`, { method: 'DELETE' })],
      ];
      for (const [label, m, r] of failures) console.log(`${label}: MCP isError=${m.isError} ${m.text.slice(0, 200)} | REST ${r.status} ${r.text.slice(0, 200)}`);
      check('VAL-CLI-004', 'induced failures: MCP isError with the same {status, code} and message as REST', failures.every(([, m, r]) => m.isError && r.status >= 400 && r.json?.code && eq(mcpErr(m), restErr(r)) && m.data?.error === r.json?.error));
      check('VAL-CLI-004', 'the stale-revision failure names the current revision on both surfaces', failures[0][1].data?.code === 'REVISION_NOT_CURRENT' && failures[0][1].data?.currentRevision === ra && failures[0][2].json?.currentRevision === ra);

      const edge = await call(consumer, 'add_dependency', { repo: env.repo, workspace: wb.id, onWorkspace: wa.id, revision: ra });
      const edgeRest = await http(`${env.api}/workspaces/${wb.id}/dependencies`);
      console.log(`add_dependency B→A@${ra} -> ${edge.text} (x-kvarm-cost ${edge.cost})`);
      check('VAL-CROSS-007', 'B pins A at its current revision R through MCP; REST lists exactly that edge', !edge.isError && edge.data?.state === 'active' && edge.data?.revision === ra && eq(edgeRest.json?.dependencies, [edge.data]));

      const ca = (await call(iface, 'create_change_set', { repo: env.repo, workspace: wa.id, title: 'greeter interface', mergePolicy: 'review' })).data;
      const cb = (await call(consumer, 'create_change_set', { repo: env.repo, workspace: wb.id, title: 'greeter consumer', mergePolicy: 'review' })).data;
      const qb = await call(consumer, 'enqueue_change', { repo: env.repo, number: cb.number, headSha: rb });
      await sleep(5000);
      const tm = await call(owner, 'get_train', { repo: env.repo });
      const tr = await http(`${env.api}/train`);
      const waiting = tm.data?.entries?.find((e) => e.number === cb.number);
      console.log(`enqueue_change B #${cb?.number} -> isError=${qb.isError} ${qb.data?.entry?.state}; get_train -> B state=${waiting?.state} waiting=${JSON.stringify(waiting?.waiting)} (x-kvarm-cost ${tm.cost}); REST GET train -> ${tr.status} (x-kvarm-cost ${tr.cost})`);
      check('VAL-CROSS-007', 'B enqueued first waits in the train with a machine-readable reason naming its pin', !qb.isError && waiting?.state === 'queued' && waiting.waiting?.code === 'DEPENDENCY_PENDING' && eq(waiting.waiting.dependencies, [edge.data?.id]));
      // A train pass between the two reads may bump these.
      const volatile = (t) => (t?.entries ?? []).map(({ updatedAt: _u, attempts: _a, generation: _g, ...e }) => e);
      check('VAL-CLI-004', 'queue/status: get_train (MCP) = GET train (REST)', tr.status === 200 && eq(volatile(tm.data), volatile(tr.json)));
      const qa = await call(iface, 'enqueue_change', { repo: env.repo, number: ca.number, headSha: ra });
      check('VAL-CROSS-007', 'A enqueued after B', !qa.isError, qa.text.slice(0, 200));

      const merged = {};
      const t0 = Date.now();
      while (Date.now() - t0 < 180_000 && !(merged.a && merged.b)) {
        for (const [k, n] of [['a', ca.number], ['b', cb.number]]) {
          if (merged[k]) continue;
          const g = await call(owner, 'get_change', { repo: env.repo, number: n });
          if (g.data?.state === 'merged') merged[k] = g.data;
        }
        await sleep(3000);
      }
      mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], env.dir);
      const log = mustGit(['log', '--first-parent', '--format=%H %s', 'origin/main'], env.dir).split('\n');
      const pos = (sha) => log.findIndex((l) => l.startsWith(sha ?? '-'));
      const stat = mustGit(['diff', '--stat', env.main, 'origin/main'], env.dir);
      const satM = await call(owner, 'list_dependencies', { repo: env.repo, workspace: wb.id });
      const satR = await http(`${env.api}/workspaces/${wb.id}/dependencies`);
      console.log(`poll get_change -> A ${merged.a?.mergeCommit ?? 'not merged'} B ${merged.b?.mergeCommit ?? 'not merged'} after ${Math.round((Date.now() - t0) / 1000)} s\ngit log --first-parent origin/main:\n  ${log.join('\n  ')}\ngit diff --stat ${env.main.slice(0, 10)} origin/main:\n${stat}\nlist_dependencies B -> ${satM.text}`);
      check('VAL-CROSS-007', 'A then B published through the queue with distinct merge commits; A before B on first-parent main', merged.a && merged.b && merged.a.mergeCommit !== merged.b.mergeCommit && pos(merged.a.mergeCommit) > pos(merged.b.mergeCommit) && pos(merged.b.mergeCommit) === 0);
      check('VAL-CROSS-007', "B's pin satisfied; the final tree has both the interface and the consumer", satM.data?.dependencies?.[0]?.state === 'satisfied' && /src\/greet\.ts/.test(stat) && /src\/app\.ts/.test(stat) && git(['merge-base', '--is-ancestor', ra, merged.b?.mergeCommit ?? 'x'], env.dir).code === 0);
      check('VAL-CLI-004', 'dependencies: list_dependencies (MCP) = GET dependencies (REST)', satR.status === 200 && eq(satM.data, satR.json));
    } finally {
      await iface.close();
      await consumer.close();
    }
  });

  // VAL-CROSS-012
  await scenario('arena', 'public', async (repo) => {
    const env = await seeded(repo);
    // Each candidate refactors a different, distant function, so the losers still merge cleanly (and stay open) after the winner lands.
    const fns = [
      ['util', 'return x + 1;'],
      ['double', 'return x * 2;'],
      ['triple', 'return x * 3;'],
    ];
    const utilWith = (i, body) => fns.map(([n, b], j) => (j === i ? body : `export function ${n}(x: number) {\n  ${b}\n}\n`)).join('\n// --\n// --\n// --\n\n');
    const base = commitOn(env.dir, env.main, { 'src/lib/util.ts': utilWith(-1) }, 'util helpers');
    await pushRetry(env.dir, env.url, `${base}:refs/heads/main`);
    const made = await call(owner, 'create_arena', { repo: env.repo, brief: 'Refactor util', candidates: 3, base: 'main' });
    const arena = made.data ?? {};
    console.log(`create_arena -> id=${arena.id} state=${arena.state} workspaces=${arena.workspaces?.map((w) => w.id).join(',')} (x-kvarm-cost ${made.cost})`);
    const restArena = await http(`${env.api}/arenas/${arena.id}`);
    check('VAL-CROSS-012', 'arena of 3 created through MCP equals the REST readback', !made.isError && arena.workspaces?.length === 3 && eq(restArena.json, arena));
    const bodies = [
      'export function util(x: number) {\n  return 1 + x;\n}\n',
      'export const double = (x: number): number => x * 2;\n',
      'export function triple(value: number) {\n  const next = value * 3;\n  return next;\n}\n',
    ];
    const changes = {};
    for (const [i, w] of arena.workspaces.entries()) {
      const sha = commitOn(env.dir, base, { 'src/lib/util.ts': utilWith(i, bodies[i]), [`notes/${i}.md`]: `candidate ${i}\n` }, `refactor ${i}`);
      await pushRetry(env.dir, env.url, `${sha}:${w.ref}`);
      changes[w.id] = (await call(owner, 'create_change_set', { repo: env.repo, workspace: w.id, title: `candidate ${i}`, mergePolicy: 'review' })).data?.number;
    }
    // Wait until every workspace head is observed so both surfaces rank the pushed heads.
    for (let i = 0; i < 30; i++) {
      const ws = await Promise.all(arena.workspaces.map((w) => http(`${env.api}/workspaces/${w.id}/intent`)));
      if (ws.every((r, j) => r.json?.headSha && r.json.headSha !== env.main && arena.workspaces[j])) break;
      await sleep(2000);
    }
    const mr = await call(owner, 'rank_arena', { repo: env.repo, id: arena.id });
    const rr = await http(`${env.api}/arenas/${arena.id}/candidates`);
    console.log(`rank_arena (mcp) ranking=${JSON.stringify(mr.data?.ranking?.map((e) => [e.rank, e.workspace]))} (x-kvarm-cost ${mr.cost})\nREST ranking=${JSON.stringify(rr.json?.ranking?.map((e) => [e.rank, e.workspace]))} (x-kvarm-cost ${rr.cost})`);
    check('VAL-CROSS-012', 'MCP rank_arena data equals REST GET arenas/:id/candidates', !mr.isError && rr.status === 200 && eq(mr.data, rr.json) && mr.data?.ranking?.length === 3);
    const winner = mr.data.ranking[0].workspace;
    const losers = arena.workspaces.map((w) => w.id).filter((id) => id !== winner);
    const sel = await call(owner, 'select_arena_winner', { repo: env.repo, id: arena.id, workspace: winner });
    const openAfterSelect = await Promise.all(Object.values(changes).map((n) => call(owner, 'get_change', { repo: env.repo, number: n })));
    check('VAL-CROSS-012', 'selection recorded; no change set merged or closed by selecting', !sel.isError && sel.data?.selection?.selectedWorkspace === winner && openAfterSelect.every((c) => c.data?.state === 'open'));
    // The selection opens a final-selection escalation on the winner's change set; the normal review path has a human confirm it.
    const esc = ((await http(`${env.api}/changes/${changes[winner]}/reviews`)).json?.escalations ?? []).find((e) => e.reason === 'final-selection' && e.state === 'open');
    const confirm = await http(`${env.api}/changes/${changes[winner]}/escalations/${esc?.id}/resolve`, { method: 'POST', json: { resolution: 'resolve', note: 'selection confirmed' } });
    console.log(`final-selection escalation ${esc?.id} -> human resolve ${confirm.status} state=${confirm.json?.escalation?.state}`);
    const mg = await call(owner, 'merge_change', { repo: env.repo, number: changes[winner] });
    mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], env.dir);
    const log = mustGit(['log', 'origin/main', '-1', '--format=%H'], env.dir);
    console.log(`merge_change #${changes[winner]} -> isError=${mg.isError} state=${mg.data?.state}${mg.isError ? ` ${mg.text.slice(0, 300)}` : ''}; origin/main ${log}`);
    check('VAL-CROSS-012', 'winner merged through explicit merge_change under review policy; merge commit on main', !mg.isError && mg.data?.state === 'merged' && log === mg.data?.mergeCommit);
    const loserState = await Promise.all(losers.map((id) => call(owner, 'get_change', { repo: env.repo, number: changes[id] })));
    check('VAL-CROSS-012', 'losers stay open after the winner merged', loserState.every((c) => c.data?.state === 'open'), loserState.map((c) => c.data?.state).join(','));
    const ab = await call(owner, 'abandon_workspace', { repo: env.repo, workspace: losers[1] });
    const fin = await call(owner, 'get_arena', { repo: env.repo, id: arena.id });
    const restFin = await http(`${env.api}/arenas/${arena.id}`);
    const st = Object.fromEntries((fin.data?.workspaces ?? []).map((w) => [w.id, w.status]));
    console.log(`abandon ${losers[1]} -> ${ab.data?.status}; get_arena statuses=${JSON.stringify(st)} state=${fin.data?.state}`);
    check('VAL-CROSS-012', 'one loser abandoned; arena shows winner merged, other loser active; MCP equals REST', !ab.isError && st[winner] === 'merged' && st[losers[0]] === 'active' && st[losers[1]] === 'abandoned' && eq(fin.data, restFin.json));
  });

  // VAL-ATTR-001..006, VAL-DECISION-001..003
  await scenario('attribution', 'private', async (repo) => {
    const env = await seeded(repo);
    const { api, dir, main } = env;
    const HASH = 'c'.repeat(64);
    const notesRef = 'refs/notes/kvarm-attribution';
    const showNote = (cwd, sha) => {
      const fetched = git(['fetch', '-q', env.url, `+${notesRef}:${notesRef}`], cwd);
      const shown = git(['notes', '--ref=kvarm-attribution', 'show', sha], cwd);
      let parsed = null;
      try {
        parsed = JSON.parse(shown.out);
      } catch {
        parsed = null;
      }
      return { fetched: fetched.code, code: shown.code, out: shown.out, json: parsed };
    };
    const isIso = (s) => typeof s === 'string' && new Date(s).toISOString() === s;

    // VAL-ATTR-001 / 002
    const body = { agent: 'claude-code-1', session: 'sess-abc', promptHash: HASH, model: 'claude-sonnet-4' };
    const set = await http(`${api}/commits/${main}/attribution`, { method: 'POST', json: body });
    console.log(`POST commits/${main}/attribution -> ${set.status} ${set.text} (x-kvarm-cost ${set.cost})`);
    const note = showNote(dir, main);
    console.log(`git fetch ${notesRef} -> exit ${note.fetched}; git notes --ref=kvarm-attribution show ${main} -> exit ${note.code}: ${note.out}`);
    check('VAL-ATTR-001', 'POST stores a JSON note with agent/session/promptHash/model/actor/at on the notes ref', [200, 201].includes(set.status) && note.json !== null && eq(note.json, { ...body, actor: OWNER, at: note.json.at }) && isIso(note.json.at));
    const got = await http(`${api}/commits/${main}/attribution`);
    console.log(`GET commits/${main}/attribution -> ${got.status} ${got.text} (x-kvarm-cost ${got.cost})`);
    check('VAL-ATTR-002', 'GET returns the stored record exactly', got.status === 200 && eq(got.json, set.json) && eq(got.json, note.json));

    // VAL-ATTR-003
    const other = commitOn(dir, main, { 'other.txt': 'other\n' }, 'unattributed');
    await pushRetry(dir, env.url, `${other}:refs/heads/other`);
    const none = await http(`${api}/commits/${other}/attribution`);
    console.log(`GET commits/${other}/attribution (never attributed) -> ${none.status} ${none.text}`);
    check('VAL-ATTR-003', 'an unattributed commit answers 404 with no other commit data', none.status === 404 && !none.text.includes('claude-code-1'));

    // VAL-ATTR-006
    const mset = await call(owner, 'set_attribution', { repo: env.repo, sha: other, agent: 'mcp-agent-1', session: 'sess-mcp', promptHash: HASH });
    const mget = await call(owner, 'get_attribution', { repo: env.repo, sha: other });
    const rget = await http(`${api}/commits/${other}/attribution`);
    console.log(`set_attribution -> ${mset.text} (x-kvarm-cost ${mset.cost})\nget_attribution -> ${mget.text}\nREST GET -> ${rget.status} ${rget.text}`);
    check('VAL-ATTR-006', 'MCP set_attribution is read back identically by MCP get_attribution and REST', !mset.isError && !mget.isError && eq(mget.data, mset.data) && eq(rget.json, mset.data) && mset.data?.agent === 'mcp-agent-1');

    // VAL-ATTR-004: a two-parent merge driven through MCP by the owner, then one by an agent token.
    // `wsToken` is the agent token that created the workspace: an agent's own workspace is not pushable by the scratch token.
    const mergeWith = async (conn, label, files, attribution, wsToken) => {
      const ws = (await call(conn, 'create_workspace', { repo: env.repo, task: `attr ${label}`, agent: 'mcp-agent-1' })).data;
      mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], dir);
      const base = mustGit(['rev-parse', 'origin/main'], dir);
      await pushRetry(dir, env.url, `${commitOn(dir, base, files, `ws ${label}`)}:${ws.ref}`, wsToken);
      await pushRetry(dir, env.url, `${commitOn(dir, base, { [`main-${label}.txt`]: `${label}\n` }, `main ${label}`)}:refs/heads/main`);
      const cs = (await call(conn, 'create_change_set', { repo: env.repo, workspace: ws.id, title: `attr ${label}`, mergePolicy: 'review' })).data;
      const mg = await call(conn, 'merge_change', { repo: env.repo, number: cs?.number, ...(attribution ? { attribution } : {}) });
      const change = await http(`${api}/changes/${cs?.number}`);
      const sha = change.json?.mergeCommit;
      const a = await http(`${api}/commits/${sha}/attribution`);
      const n = showNote(dir, sha);
      console.log(`merge_change #${cs?.number} (${label}) -> kind=${mg.data?.merge?.kind} (x-kvarm-cost ${mg.cost}); GET changes/${cs?.number} mergeCommit=${sha}\nGET attribution -> ${a.status} ${a.text}\ngit notes show ${sha} -> ${n.out}`);
      return { mg, a, n };
    };
    const byOwner = await mergeWith(owner, 'owner', { 'src/owner.ts': 'export const owner = 1;\n' }, { agent: 'mcp-agent-1', session: 'sess-merge', promptHash: HASH });
    check('VAL-ATTR-004', 'a Kvarm merge commit carries the merging actor and the request agent fields (REST and git notes agree)', byOwner.mg.data?.merge?.kind === 'merge' && byOwner.a.status === 200 && byOwner.a.json?.actor === OWNER && byOwner.a.json?.agent === 'mcp-agent-1' && eq(byOwner.a.json, byOwner.n.json));
    const agentName = `mcp-attr-${TS}`;
    const agent = await http('/api/v1/agents', { method: 'POST', json: { name: agentName } });
    const minted = await http(`/api/v1/agents/${agent.json?.agent?.id}/tokens`, { method: 'POST', json: { repo: env.repo, role: 'write', refs: ['refs/heads/*'], expiresIn: 3600 } });
    if (minted.status === 201) {
      const agentConn = await connect(minted.json.token, 'mcp-agent-token');
      try {
        const byAgent = await mergeWith(agentConn, 'agent', { 'src/agent.ts': 'export const agent = 1;\n' }, null, minted.json.token);
        check('VAL-ATTR-004', 'a merge driven by an agent-token MCP session names the agent identity', byAgent.mg.data?.merge?.kind === 'merge' && byAgent.a.json?.agent === agentName && byAgent.a.json?.actor === OWNER && eq(byAgent.a.json, byAgent.n.json));
      } finally {
        await agentConn.close();
      }
    } else {
      check('VAL-ATTR-004', 'agent token minted for the agent-session merge', false, `${agent.status} ${minted.status} ${minted.text}`);
    }
    if (agent.json?.agent?.id) await http(`/api/v1/agents/${agent.json.agent.id}`, { method: 'DELETE' });

    // VAL-ATTR-005
    const fresh = join(work, `${repo}-fresh`);
    const cloned = git(['clone', '-q', env.url, fresh], work);
    const plain = git(['notes', '--ref=kvarm-attribution', 'show', main], fresh);
    const freshNote = showNote(fresh, main);
    console.log(`git clone -> exit ${cloned.code}; notes before fetching the ref -> exit ${plain.code}; after git fetch origin ${notesRef} -> ${freshNote.out}`);
    check('VAL-ATTR-005', 'a fresh clone fetches the notes ref and shows the VAL-ATTR-002 record', cloned.code === 0 && freshNote.fetched === 0 && eq(freshNote.json, got.json));

    // VAL-DECISION-001
    const d1 = { task: `task-${TS}`, paths: ['src/app.ts', 'src/lib/util.ts'], chosen: 'ws-b', rejected: ['ws-a', { id: 'ws-c', reason: 'breaks util tests' }], reason: 'ws-b keeps the public API' };
    const rd1 = await http(`${api}/decisions`, { method: 'POST', json: d1 });
    console.log(`POST decisions (task + paths) -> ${rd1.status} ${rd1.text} (x-kvarm-cost ${rd1.cost})`);
    const byTask = await http(`${api}/context?task=${encodeURIComponent(d1.task)}`);
    const byPaths = await Promise.all(d1.paths.map((p) => http(`${api}/context?path=${encodeURIComponent(p)}`)));
    console.log(`GET context?task -> ${byTask.status} ${byTask.text} (x-kvarm-cost ${byTask.cost})`);
    for (const [i, r] of byPaths.entries()) console.log(`GET context?path=${d1.paths[i]} -> ${r.status} ids=${JSON.stringify(r.json?.decisions?.map((d) => d.id))} (x-kvarm-cost ${r.cost})`);
    const roundTrip = (d) => d && eq({ task: d.task, paths: d.paths, chosen: d.chosen, rejected: d.rejected, reason: d.reason }, d1) && d.actor === OWNER && isIso(d.at);
    check('VAL-DECISION-001', 'POST decisions 201; read back by task and by each path with chosen/rejected/reason/actor/at round-tripping', rd1.status === 201 && roundTrip(rd1.json) && eq(byTask.json?.decisions, [rd1.json]) && byPaths.every((r) => eq(r.json?.decisions, [rd1.json])));
    const d2 = { paths: ['docs/guide.md'], chosen: '#7', rejected: ['#6'], reason: 'paths-only decision' };
    const rd2 = await http(`${api}/decisions`, { method: 'POST', json: d2 });
    const byDoc = await http(`${api}/context?path=docs%2Fguide.md`);
    check('VAL-DECISION-001', 'a paths-only decision is retrievable by its path', rd2.status === 201 && rd2.json?.task === null && eq(byDoc.json?.decisions, [rd2.json]));

    // Literal comma-containing Git paths round-trip through REST, MCP and the kvarm CLI (never split).
    const d3 = { paths: ['src/a,b.ts'], chosen: 'ws-comma', rejected: [], reason: 'literal comma path' };
    const rd3 = await http(`${api}/decisions`, { method: 'POST', json: d3 });
    const restComma = await http(`${api}/context?path=${encodeURIComponent('src/a,b.ts')}`);
    const restHalves = await http(`${api}/context?path=src%2Fa&path=b.ts`);
    const mcpComma = await call(owner, 'get_context', { repo: env.repo, path: ['src/a,b.ts'] });
    const cliComma = kvarm(['decision', 'context', env.repo, '--path', 'src/a,b.ts']);
    console.log(`POST decisions paths=["src/a,b.ts"] -> ${rd3.status} (x-kvarm-cost ${rd3.cost}); REST context?path=src%2Fa%2Cb.ts -> ids=${JSON.stringify(restComma.json?.decisions?.map((d) => d.id))} (x-kvarm-cost ${restComma.cost}); path=src/a&path=b.ts -> ${JSON.stringify(restHalves.json?.decisions)}; MCP -> ids=${JSON.stringify(mcpComma.data?.decisions?.map((d) => d.id))}; CLI exit ${cliComma.code} ids=${JSON.stringify(cliComma.data?.decisions?.map((d) => d.id))} ${cliComma.err}`);
    check('VAL-DECISION-001', 'a comma-containing path recorded by REST is read back intact by REST, MCP and the CLI (and not by its comma halves)', rd3.status === 201 && eq(rd3.json?.paths, d3.paths) && eq(restComma.json?.decisions, [rd3.json]) && eq(mcpComma.data?.decisions, [rd3.json]) && cliComma.code === 0 && eq(cliComma.data?.decisions, [rd3.json]) && eq(restHalves.json?.decisions, []));
    const cliRec = kvarm(['decision', 'record', env.repo, '--paths', 'docs/x,y.md', '--paths', 'docs/z.md', '--chosen', 'ws-cli', '--rejected', '[]', '--reason', 'recorded by kvarm']);
    const mcpBack = await call(owner, 'record_decision', { repo: env.repo, paths: ['docs/q,r.md'], chosen: 'ws-mcp', rejected: [], reason: 'recorded by MCP' });
    const restCli = await http(`${api}/context?path=${encodeURIComponent('docs/x,y.md')}&path=docs%2Fz.md`);
    const cliMcp = kvarm(['decision', 'context', env.repo, '--path', 'docs/q,r.md']);
    console.log(`kvarm decision record --paths docs/x,y.md --paths docs/z.md -> exit ${cliRec.code} paths=${JSON.stringify(cliRec.data?.paths)}; REST context -> ids=${JSON.stringify(restCli.json?.decisions?.map((d) => d.id))}; record_decision docs/q,r.md -> ${mcpBack.data?.id}; kvarm decision context --path docs/q,r.md -> ids=${JSON.stringify(cliMcp.data?.decisions?.map((d) => d.id))}`);
    check('VAL-DECISION-001', 'comma paths recorded by the CLI and by MCP are read back by REST and the CLI', cliRec.code === 0 && eq(cliRec.data?.paths, ['docs/x,y.md', 'docs/z.md']) && eq(restCli.json?.decisions, [cliRec.data]) && !mcpBack.isError && cliMcp.code === 0 && eq(cliMcp.data?.decisions, [mcpBack.data]));

    // VAL-DECISION-002
    const ct = await call(owner, 'get_context', { repo: env.repo, task: d1.task });
    const cp = await call(owner, 'get_context', { repo: env.repo, path: ['src/lib/util.ts'] });
    console.log(`get_context(task) -> ${ct.text} (x-kvarm-cost ${ct.cost})\nget_context(path) -> ${cp.text.slice(0, 400)} (x-kvarm-cost ${cp.cost})`);
    const reasons = (d) => d?.chosen === 'ws-b' && eq(d?.rejected, d1.rejected) && d?.reason === d1.reason;
    check('VAL-DECISION-002', 'get_context(task) and get_context(path) return the decision with chosen, rejected and rejection reasons', !ct.isError && !cp.isError && reasons(ct.data?.decisions?.[0]) && reasons(cp.data?.decisions?.[0]));
    const emptyTask = await call(owner, 'get_context', { repo: env.repo, task: `no-such-task-${TS}` });
    const emptyPath = await call(owner, 'get_context', { repo: env.repo, path: ['no/such/path.ts'] });
    console.log(`get_context(empty task) -> ${emptyTask.text}; get_context(empty path) -> ${emptyPath.text}`);
    check('VAL-DECISION-002', 'a task/path without decisions returns an empty decision list, not an error', !emptyTask.isError && !emptyPath.isError && eq(emptyTask.data?.decisions, []) && eq(emptyPath.data?.decisions, []));
    const pageTask = `paged-${TS}`;
    for (let i = 0; i < 3; i++) await http(`${api}/decisions`, { method: 'POST', json: { task: pageTask, chosen: `c${i}`, rejected: [`r${i}`], reason: `reason ${i}` } });
    const p1 = await call(owner, 'get_context', { repo: env.repo, task: pageTask, limit: 2 });
    const p2 = await call(owner, 'get_context', { repo: env.repo, task: pageTask, limit: 2, cursor: p1.data?.nextCursor ?? '' });
    console.log(`get_context(limit 2) -> ${p1.data?.decisions?.length} decisions truncated=${p1.data?.truncated} nextCursor=${p1.data?.nextCursor}; next page -> ${p2.data?.decisions?.length} truncated=${p2.data?.truncated}`);
    const pagedIds = [...(p1.data?.decisions ?? []), ...(p2.data?.decisions ?? [])].map((d) => d.id);
    check('VAL-DECISION-002', 'over the cap: truncated:true + nextCursor, and the next page completes the set', p1.data?.truncated === true && typeof p1.data?.nextCursor === 'string' && p2.data?.truncated === false && new Set(pagedIds).size === 3);

    // VAL-DECISION-003
    if (BOT) {
      const bot = await connect(BOT, 'mcp-agent-bot');
      try {
        const bt = await call(bot, 'get_context', { repo: env.repo, task: d1.task });
        const ba = await call(bot, 'get_attribution', { repo: env.repo, sha: main });
        const br = await http(`${api}/context?task=${encodeURIComponent(d1.task)}`, { token: BOT });
        console.log(`kvarm-bot get_context -> isError=${bt.isError} ${bt.text}; get_attribution -> isError=${ba.isError} ${ba.text}; REST GET context -> ${br.status} ${br.text}`);
        check('VAL-DECISION-003', 'kvarm-bot get_context/get_attribution → isError without data; REST denies; owner succeeds', bt.isError && ba.isError && !bt.text.includes('ws-b') && [401, 403, 404].includes(br.status) && !br.text.includes('ws-b') && !ct.isError);
      } finally {
        await bot.close();
      }
    } else {
      check('VAL-DECISION-003', 'KVARM_PAT_BOT is set', false);
    }
    const tooMany = Array.from({ length: 21 }, (_, i) => `p${i}.ts`);
    const om = await call(owner, 'get_context', { repo: env.repo, path: tooMany });
    const orr = await http(`${api}/context?${tooMany.map((p) => `path=${encodeURIComponent(p)}`).join('&')}`);
    console.log(`get_context(21 paths) -> isError=${om.isError} ${om.text}; REST -> ${orr.status} ${orr.text}`);
    check('VAL-DECISION-003', 'more paths than the cap → actionable 4xx {error, code}', om.isError && om.data?.code === 'TOO_MANY_PATHS' && orr.status === 400 && orr.json?.code === 'TOO_MANY_PATHS' && typeof orr.json?.error === 'string');
    const cost = parseCost(byTask.cost);
    check('VAL-DECISION-003', 'GET context work stays within the cost.md row (d1 <= 2, do = 0, art = 0)', cost.d1 <= 2 && cost.do === 0 && cost.art === 0, byTask.cost);
  });

  // VAL-DISPATCH-001..007, VAL-WORKFLOW-001..003, VAL-CROSS-004, VAL-CROSS-009
  await scenario('dispatch', 'public', async (repo) => {
    const env = await seeded(repo);
    const { api, dir, url } = env;
    const lsRemote = (ref) => git(['ls-remote', url, ref], dir).out.split(/\s+/)[0] || null;
    const restTask = async (id) => (await http(`${api}/tasks/${id}`)).json;
    const restChange = async (n) => (await http(`${api}/changes/${n}`)).json;
    const taskWorkspaces = async (id) => {
      const all = await http(`${api}/workspaces?status=all&limit=100`);
      return (all.json?.workspaces ?? []).filter((w) => (w.task ?? '').includes(`(task ${id})`));
    };
    /** The agent's resolution: origin/main merged into the change head, src/app.ts carrying both sides. */
    const resolve = (head, content, msg, extra = {}) => {
      mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
      mustGit(['checkout', '-q', '--detach', head], dir);
      const merged = git(['merge', '--no-edit', '-q', 'origin/main'], dir);
      writeFiles(dir, { ...extra, 'src/app.ts': content });
      mustGit(['add', '-A'], dir);
      mustGit(['commit', '-q', '-m', msg], dir);
      return { sha: mustGit(['rev-parse', 'HEAD'], dir), mergeExit: merged.code, base: mustGit(['rev-parse', 'origin/main'], dir) };
    };
    const MAIN_LINE = 'export const app = 100; // main\n';
    const heads = {};
    for (const [policy, line] of [
      ['draft', 'export const app = 2; // draft\n'],
      ['review', 'export const app = 3; // review\n'],
      ['auto', 'export const app = 4; // auto\n'],
    ]) {
      heads[policy] = commitOn(dir, env.main, { 'src/app.ts': line }, `app ${policy}`);
      await pushRetry(dir, url, `${heads[policy]}:refs/heads/fix-${policy}`);
    }
    const mainTip = commitOn(dir, env.main, { 'src/app.ts': MAIN_LINE }, 'main edits app');
    await pushRetry(dir, url, `${mainTip}:refs/heads/main`);
    const changes = {};
    for (const policy of ['draft', 'review', 'auto']) {
      const c = await call(owner, 'create_change', { repo: env.repo, title: `app ${policy}`, base: 'main', head: `fix-${policy}`, mergePolicy: policy });
      changes[policy] = c.data;
      console.log(`create_change fix-${policy} (${policy}) -> #${c.data?.number} state=${c.data?.state} conflicts=${JSON.stringify(c.data?.conflicts)} (x-kvarm-cost ${c.cost})`);
    }

    // VAL-DISPATCH-001
    const attempt = await call(owner, 'merge_change', { repo: env.repo, number: changes.review.number });
    const restAttempt = await http(`${api}/changes/${changes.auto.number}/merge`, { method: 'POST' });
    const openRest = await http(`${api}/tasks?status=open&kind=resolve-conflict`);
    const openMcp = await call(owner, 'list_tasks', { repo: env.repo, status: 'open', kind: 'resolve-conflict' });
    const taskOf = {};
    for (const p of ['draft', 'review', 'auto']) taskOf[p] = (openRest.json?.tasks ?? []).find((t) => t.change?.number === changes[p].number);
    console.log(`merge_change #${changes.review.number} -> isError=${attempt.isError} ${attempt.text.slice(0, 200)}\nREST POST merge #${changes.auto.number} -> ${restAttempt.status} ${restAttempt.text.slice(0, 200)}\nGET tasks?status=open -> ${openRest.status} ${JSON.stringify(openRest.json?.tasks?.map((t) => ({ id: t.id, kind: t.kind, change: t.change, conflicts: t.conflicts })))} (x-kvarm-cost ${openRest.cost})\nlist_tasks -> ids ${JSON.stringify(openMcp.data?.tasks?.map((t) => t.id))} (x-kvarm-cost ${openMcp.cost}); ls-remote main=${lsRemote('refs/heads/main')}`);
    check(
      'VAL-DISPATCH-001',
      'a same-line src/app.ts conflict: merge refused 409 MERGE_CONFLICT, main unchanged, changes conflicted, one open resolve-conflict task per change on REST and MCP',
      attempt.isError && attempt.data?.code === 'MERGE_CONFLICT' && restAttempt.status === 409 && lsRemote('refs/heads/main') === mainTip &&
        ['draft', 'review', 'auto'].every((p) => changes[p]?.state === 'conflicted' && taskOf[p]?.kind === 'resolve-conflict' && taskOf[p]?.conflicts?.some((c) => c.path === 'src/app.ts')) &&
        !openMcp.isError && eq(openMcp.data, openRest.json),
    );

    // Draft: VAL-DISPATCH-002, -007, -003, -005 and the completion precondition of VAL-WORKFLOW-003.
    const dTask = taskOf.draft.id;
    const claim = await call(owner, 'claim_task', { repo: env.repo, task: dTask, agent: 'claude-code-1' });
    const ws = claim.data?.workspace;
    const wsTip = ws?.ref ? lsRemote(ws.ref) : null;
    const afterClaim = await restTask(dTask);
    console.log(`claim_task ${dTask} (claude-code-1) -> isError=${claim.isError} workspace=${JSON.stringify({ id: ws?.id, ref: ws?.ref, headSha: ws?.headSha })} lease=${JSON.stringify(claim.data?.lease)} (x-kvarm-cost ${claim.cost})\ngit ls-remote ${ws?.ref} -> ${wsTip}; change head ${heads.draft}\nGET tasks/${dTask} -> status=${afterClaim?.status} claimedBy=${afterClaim?.claimedBy} workspace=${afterClaim?.workspace}`);
    check('VAL-DISPATCH-002', 'claim_task returns a workspace whose ref sits at the conflicting change head; task claimed by claude-code-1', !claim.isError && ws?.id && wsTip === heads.draft && afterClaim?.status === 'claimed' && afterClaim?.claimedBy === 'claude-code-1' && afterClaim?.workspace === ws.id);
    const other = await connect(PAT, 'mcp-agent-claude-code-2');
    let second;
    try {
      second = await call(other, 'claim_task', { repo: env.repo, task: dTask, agent: 'claude-code-2' });
    } finally {
      await other.close();
    }
    const afterSecond = await restTask(dTask);
    console.log(`fresh client claim_task ${dTask} (claude-code-2) -> isError=${second.isError} ${second.text.slice(0, 300)}\nGET tasks/${dTask} -> claimedBy=${afterSecond?.claimedBy} workspace=${afterSecond?.workspace} generation=${afterSecond?.generation}`);
    check('VAL-DISPATCH-007', 'a second claim by another agent is refused 409 CLAIMED naming claude-code-1; claimant and workspace unchanged', second.isError && second.data?.code === 'CLAIMED' && second.text.includes('claude-code-1') && afterSecond?.claimedBy === 'claude-code-1' && afterSecond?.workspace === ws.id && afterSecond?.generation === claim.data?.lease?.generation);
    const early = await call(owner, 'complete_task', { repo: env.repo, task: dTask, agent: 'claude-code-1', generation: claim.data.lease.generation });
    console.log(`complete_task before any push -> isError=${early.isError} ${early.text.slice(0, 300)}`);
    check('VAL-WORKFLOW-003', 'completion before the resolution push is refused 409 RESOLUTION_NOT_PUSHED naming the precondition', early.isError && early.data?.code === 'RESOLUTION_NOT_PUSHED' && /push/.test(early.data?.error ?? ''));
    const dRes = resolve(heads.draft, 'export const app = 100 + 2; // main + draft\n', 'resolve draft conflict');
    await pushRetry(dir, url, `${dRes.sha}:${ws.ref}`);
    const dDone = await call(owner, 'complete_task', { repo: env.repo, task: dTask, agent: 'claude-code-1', generation: claim.data.lease.generation, sha: dRes.sha });
    const dChange = await restChange(changes.draft.number);
    console.log(`git merge origin/main (exit ${dRes.mergeExit}, conflict) + push ${dRes.sha} -> ${ws.ref}\ncomplete_task -> isError=${dDone.isError} task.status=${dDone.data?.task?.status} change=${JSON.stringify({ head: dDone.data?.change?.headSha, state: dDone.data?.change?.state, policy: dDone.data?.change?.mergePolicy })} headBranch=${JSON.stringify(dDone.data?.headBranch)} (x-kvarm-cost ${dDone.cost})\nGET changes/${changes.draft.number} -> head=${dChange?.headSha} state=${dChange?.state}; ls-remote fix-draft=${lsRemote('refs/heads/fix-draft')}`);
    check('VAL-DISPATCH-003', 'complete_task completes the task and moves the change head (and its branch) to the pushed resolution; state leaves conflicted', !dDone.isError && dDone.data?.task?.status === 'completed' && dChange?.headSha === dRes.sha && dChange?.state === 'open' && lsRemote('refs/heads/fix-draft') === dRes.sha);
    await sleep(20_000);
    const dLater = await restChange(changes.draft.number);
    const mainAfterDraft = lsRemote('refs/heads/main');
    console.log(`after a 20 s settle: GET changes/${changes.draft.number} -> state=${dLater?.state} policy=${dLater?.mergePolicy} mergeCommit=${dLater?.mergeCommit}; ls-remote main=${mainAfterDraft}`);
    check('VAL-DISPATCH-005', 'the resolved draft change stays an unmerged draft; main unchanged', dLater?.state === 'open' && dLater?.mergePolicy === 'draft' && !dLater?.mergeCommit && mainAfterDraft === mainTip);
    const again = await call(owner, 'complete_task', { repo: env.repo, task: dTask, agent: 'claude-code-1', generation: claim.data.lease.generation, sha: dRes.sha });
    const dFinal = await restChange(changes.draft.number);
    console.log(`second complete_task -> isError=${again.isError} ${again.text.slice(0, 200)}; head=${dFinal?.headSha}; workspaces for the task=${(await taskWorkspaces(dTask)).length}`);
    check('VAL-WORKFLOW-003', 'a second completion is refused 409 TASK_COMPLETED and changes nothing', again.isError && again.data?.code === 'TASK_COMPLETED' && dFinal?.headSha === dRes.sha && (await taskWorkspaces(dTask)).length === 1);

    // Review: VAL-DISPATCH-006
    const rTask = taskOf.review.id;
    const rClaim = await call(owner, 'claim_task', { repo: env.repo, task: rTask, agent: 'claude-code-1' });
    const rRes = resolve(heads.review, 'export const app = 100 + 3; // main + review\n', 'resolve review conflict');
    await pushRetry(dir, url, `${rRes.sha}:${rClaim.data?.workspace?.ref}`);
    const rDone = await call(owner, 'complete_task', { repo: env.repo, task: rTask, agent: 'claude-code-1', generation: rClaim.data?.lease?.generation, sha: rRes.sha });
    await sleep(10_000);
    const rOpen = await restChange(changes.review.number);
    const mainBeforeMerge = lsRemote('refs/heads/main');
    console.log(`review: claim -> ${rClaim.data?.workspace?.ref}; complete_task -> isError=${rDone.isError} state=${rDone.data?.change?.state}; after 10 s GET changes/${changes.review.number} -> state=${rOpen?.state} head=${rOpen?.headSha}; main=${mainBeforeMerge}`);
    const rMerge = await http(`${api}/changes/${changes.review.number}/merge`, { method: 'POST' });
    const rMerged = await restChange(changes.review.number);
    mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
    console.log(`POST changes/${changes.review.number}/merge -> ${rMerge.status} kind=${rMerge.json?.merge?.kind} (x-kvarm-cost ${rMerge.cost}); GET -> state=${rMerged?.state} mergeCommit=${rMerged?.mergeCommit}; origin/main=${mustGit(['rev-parse', 'origin/main'], dir)}`);
    check('VAL-DISPATCH-006', 'the resolved review change stays open until the explicit merge, then merges', !rDone.isError && rOpen?.state === 'open' && rOpen?.headSha === rRes.sha && mainBeforeMerge === mainTip && rMerge.status === 200 && rMerged?.state === 'merged' && mustGit(['rev-parse', 'origin/main'], dir) === rMerged?.mergeCommit);

    // Auto: the dead-agent path (VAL-WORKFLOW-001/002, VAL-CROSS-009) ending in VAL-DISPATCH-004 / VAL-CROSS-004.
    const listed = await call(owner, 'list_tasks', { repo: env.repo, status: 'open' });
    const aTask = (listed.data?.tasks ?? []).find((t) => t.change?.number === changes.auto.number);
    console.log(`list_tasks(open) -> ${JSON.stringify(listed.data?.tasks?.map((t) => ({ id: t.id, change: t.change?.number, status: t.status })))}`);
    const a1 = await call(owner, 'claim_task', { repo: env.repo, task: aTask?.id, agent: 'agent-one', ttlSeconds: 10 });
    const gen1 = a1.data?.lease?.generation;
    const live = kvarm(['task', 'claim', env.repo, aTask?.id, '--agent', 'agent-two']);
    const during = await restTask(aTask?.id);
    console.log(`MCP claim_task (agent-one, ttl 10 s) -> isError=${a1.isError} lease=${JSON.stringify(a1.data?.lease)} workspace=${a1.data?.workspace?.id}\nkvarm task claim (agent-two) while live -> exit ${live.code} ${JSON.stringify(live.data)?.slice(0, 300)}\nGET tasks/${aTask?.id} -> claimedBy=${during?.claimedBy} lease=${JSON.stringify(during?.lease)}`);
    check('VAL-WORKFLOW-001', 'the claim carries an expiring lease {until, generation}; a claim while it is live is refused 409 naming agent-one', !a1.isError && typeof a1.data?.lease?.until === 'string' && Number.isInteger(gen1) && live.code !== 0 && live.data?.status === 409 && live.data?.code === 'CLAIMED' && JSON.stringify(live.data).includes('agent-one') && during?.claimedBy === 'agent-one' && during?.lease?.generation === gen1);
    await sleep(Math.max(0, Date.parse(a1.data?.lease?.until ?? '') - Date.now()) + 2000);
    const lapsed = await restTask(aTask?.id);
    const reclaim = kvarm(['task', 'claim', env.repo, aTask?.id, '--agent', 'agent-two']);
    const gen2 = reclaim.data?.lease?.generation;
    console.log(`after expiry GET tasks/${aTask?.id} -> status=${lapsed?.status} lease=${JSON.stringify(lapsed?.lease)}\nkvarm task claim (agent-two) -> exit ${reclaim.code} claimedBy=${reclaim.data?.task?.claimedBy} lease=${JSON.stringify(reclaim.data?.lease)} workspace=${reclaim.data?.workspace?.id} ${reclaim.err}`);
    check('VAL-WORKFLOW-001', 'after expiry the task is open again and the CLI reclaim gets generation n+1 with agent-two as claimant and the same workspace', lapsed?.status === 'open' && reclaim.code === 0 && gen2 === gen1 + 1 && reclaim.data?.task?.claimedBy === 'agent-two' && reclaim.data?.workspace?.id === a1.data?.workspace?.id);
    const aRes = resolve(heads.auto, 'export const app = 100 + 3 + 4; // main + review + auto\n', 'resolve auto conflict', {
      '.kvarm/ci.json': `${JSON.stringify({ jobs: [{ name: 'resolution-ci', run: 'test -f src/app.ts', required: true }] })}\n`,
    });
    const notPushed = kvarm(['task', 'complete', env.repo, aTask?.id, '--generation', String(gen2), '--agent', 'agent-two']);
    console.log(`kvarm task complete before the push -> exit ${notPushed.code} ${JSON.stringify(notPushed.data)?.slice(0, 250)}`);
    await pushRetry(dir, url, `${aRes.sha}:${reclaim.data?.workspace?.ref}`);
    const before = await restChange(changes.auto.number);
    const stale = await call(owner, 'complete_task', { repo: env.repo, task: aTask?.id, agent: 'agent-one', generation: gen1, sha: aRes.sha });
    const afterStale = await restTask(aTask?.id);
    const changeAfterStale = await restChange(changes.auto.number);
    console.log(`agent-one stale complete_task (generation ${gen1}) -> isError=${stale.isError} ${stale.text.slice(0, 250)}\nGET tasks/${aTask?.id} -> status=${afterStale?.status} claimedBy=${afterStale?.claimedBy} workspace=${afterStale?.workspace}; GET changes/${changes.auto.number} head=${changeAfterStale?.headSha} state=${changeAfterStale?.state}`);
    check('VAL-WORKFLOW-002', 'the stale generation completion is refused 409 STALE_GENERATION; task and change unchanged', stale.isError && stale.data?.code === 'STALE_GENERATION' && afterStale?.status === 'claimed' && afterStale?.claimedBy === 'agent-two' && afterStale?.workspace === a1.data?.workspace?.id && changeAfterStale?.headSha === before?.headSha && changeAfterStale?.headSha === heads.auto && changeAfterStale?.state === 'conflicted');
    const done = kvarm(['task', 'complete', env.repo, aTask?.id, '--generation', String(gen2), '--agent', 'agent-two', '--sha', aRes.sha]);
    const runner = spawnSync(kvarmBin(), ['runner', '--repo', env.repo, '--once'], {
      env: { ...process.env, KVARM_BASE_URL: BASE },
      encoding: 'utf8',
      timeout: 120_000,
    });
    console.log(`git push ${aRes.sha} -> ${reclaim.data?.workspace?.ref}; kvarm task complete (generation ${gen2}) -> exit ${done.code} task=${done.data?.task?.status} change=${JSON.stringify({ state: done.data?.change?.state, head: done.data?.change?.headSha })}; kvarm runner -> exit ${runner.status} ${(runner.stdout ?? '').trim()} ${done.err}`);
    let merged = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120_000) {
      const g = await call(owner, 'get_change', { repo: env.repo, number: changes.auto.number });
      if (g.data?.state === 'merged') {
        merged = g.data;
        break;
      }
      await sleep(3000);
    }
    mustGit(['fetch', '-q', url, '+refs/heads/main:refs/remotes/origin/main'], dir);
    const tip = mustGit(['rev-parse', 'origin/main'], dir);
    const appOnMain = mustGit(['show', 'origin/main:src/app.ts'], dir);
    const attr = await call(owner, 'get_attribution', { repo: env.repo, sha: tip });
    const finalTask = await restTask(aTask?.id);
    const wsCount = (await taskWorkspaces(aTask?.id)).length;
    const runs = await http(`${api}/changes/${changes.auto.number}/checks`);
    const currentRuns = (runs.json?.checks ?? runs.json?.runs ?? []).filter((r) => r.headSha === merged?.headSha);
    const currentCiRuns = currentRuns.filter((r) => r.name === 'resolution-ci');
    const twice = await call(owner, 'complete_task', { repo: env.repo, task: aTask?.id, agent: 'agent-two', generation: gen2, sha: aRes.sha });
    console.log(`get_change #${changes.auto.number} -> ${merged ? `merged ${merged.mergeCommit} after ${Math.round((Date.now() - t0) / 1000)} s` : 'not merged within 120 s'}\ngit log origin/main -1 -> ${tip}\ngit show origin/main:src/app.ts -> ${JSON.stringify(appOnMain)}\nget_attribution ${tip} -> ${attr.text}\nGET tasks/${aTask?.id} -> status=${finalTask?.status} generation=${finalTask?.generation} completedBy=${finalTask?.completedBy} resolution=${finalTask?.resolutionSha}\nworkspaces for the task=${wsCount}; current-head check runs=${currentRuns.length}; check runs on the change=${JSON.stringify(runs.json)?.slice(0, 200)}\ncomplete_task again -> isError=${twice.isError} ${twice.text.slice(0, 160)}`);
    check('VAL-WORKFLOW-003', 'a completion before the resolution push is refused 409 (CLI)', notPushed.code !== 0 && notPushed.data?.status === 409 && notPushed.data?.code === 'RESOLUTION_NOT_PUSHED');
    check('VAL-DISPATCH-004', 'the resolved auto change runs required CI and merges through the train with no further action; resolved src/app.ts on main', done.code === 0 && runner.status === 0 && Boolean(merged) && merged.mergeCommit === tip && appOnMain === 'export const app = 100 + 3 + 4; // main + review + auto');
    check('VAL-CROSS-004', 'list → claim → push → complete → merged; the landed commit carries the resolving agent attribution; task completed', Boolean(merged) && !attr.isError && attr.data?.agent === 'agent-two' && finalTask?.status === 'completed');
    check('VAL-CROSS-009', 'MCP claim → lapse → CLI reclaim → resolution merged once; stale work had no effect; generation recorded; one workspace and one CI check', Boolean(merged) && tip === aRes.sha && finalTask?.generation === gen2 && finalTask?.resolutionSha === aRes.sha && wsCount === 1 && currentCiRuns.length === 1 && twice.isError && twice.data?.code === 'TASK_COMPLETED');
  });

  await owner.close();
  rmSync(work, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  return failed.length === 0 ? 0 : 1;
}

const [cmd, ...rest] = process.argv.slice(2);
let code;
if (cmd === 'info') code = await runInfo();
else if (cmd === 'call') code = await runCall(rest[0], rest[1]);
else if (cmd === 'e2e') code = await runE2e(rest);
else die('usage: mcp-agent.mjs info | call <tool> [json-args] | e2e [--keep] [--only ...]');
process.exit(code);
