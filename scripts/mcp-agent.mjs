#!/usr/bin/env node
/**
 * MCP client for the Veyr-9 platform (`POST $FORGE_BASE_URL/mcp`), built on
 * the official SDK client (`client/index.js` + `client/streamableHttp.js`).
 *
 *   node scripts/mcp-agent.mjs info
 *       connect (initialize), print server name/version and capabilities,
 *       then listTools: count, names and a description/input-schema check
 *   node scripts/mcp-agent.mjs call <tool> ['<json args>']
 *       one tools/call; prints the /mcp HTTP status, x-forge-cost, isError
 *       and the result JSON
 *   node scripts/mcp-agent.mjs e2e [--keep] [--only auth,registry,parity,visibility,cost,two-agent,arena]
 *       live checks for the MCP surface (VAL-MCP-001..010, VAL-COST-017,
 *       VAL-CROSS-012). Each scenario runs in a fresh repo owned by
 *       FORGE_USER, named `mcp-agent-<purpose>-<timestamp>`, seeded by real
 *       git pushes and deleted afterwards (unless --keep).
 *
 * Environment (tokens are read by NAME and never printed):
 *   FORGE_BASE_URL  platform origin
 *   FORGE_PAT       api-scope PAT of FORGE_USER (default cynthia)
 *   FORGE_PAT_BOT   api-scope PAT of an unrelated user (e2e visibility only)
 *   MCP_TOKEN_ENV   name of the env var holding the token for info/call
 *                   (default FORGE_PAT)
 *   set -a; . apps/platform/.dev.vars.validation; set +a
 *
 * The e2e visibility scenario also flips visibility by a direct remote D1
 * UPDATE (`wrangler d1 execute`, simulating another colo); it needs wrangler
 * on PATH (`. "$HOME/.config/vite-plus/env"`) and is skipped without it.
 * Git runs with `-c credential.helper=`, GIT_TERMINAL_PROMPT=0 and a
 * secret-free GIT_ASKPASS helper. Exit 0 only when every check held.
 *
 * The conflict-dispatch flow (enqueue_change, list_tasks, claim_task,
 * complete_task) and attribution in the audit trail need operations that are
 * not in the registry yet; the features adding them extend this driver.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { withFixtureRepo } from './lib/fixture-repo.mjs';

const BASE = process.env.FORGE_BASE_URL ?? 'https://forge-platform.cynnamoroll.workers.dev';
const OWNER = process.env.FORGE_USER ?? 'cynthia';
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
 * status and x-forge-cost of every /mcp HTTP response (one per request).
 */
async function connect(token, name = 'mcp-agent') {
  const exchanges = [];
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', BASE), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const res = await fetch(url, init);
      exchanges.push({ method: init?.method ?? 'GET', status: res.status, cost: res.headers.get('x-forge-cost') });
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

function parseCost(h) {
  const out = {};
  for (const part of (h ?? '').split(';')) {
    const [k, v] = part.split('=');
    if (k) out[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

function tokenFromEnv() {
  const name = process.env.MCP_TOKEN_ENV ?? 'FORGE_PAT';
  return process.env[name] || die(`${name} is not set`);
}

// ---------------------------------------------------------------------------
// info / call
// ---------------------------------------------------------------------------

async function runInfo() {
  const conn = await connect(tokenFromEnv());
  const server = conn.client.getServerVersion();
  console.log(`connected: server ${server?.name} ${server?.version}; capabilities ${JSON.stringify(conn.client.getServerCapabilities())}`);
  console.log(`initialize -> HTTP ${conn.exchanges[0]?.status} x-forge-cost ${conn.exchanges[0]?.cost}`);
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
  console.log(`tools/call ${tool} -> HTTP ${r.status} x-forge-cost ${r.cost} isError=${r.isError}`);
  console.log(r.data !== null ? JSON.stringify(r.data, null, 2) : r.text);
  return r.isError ? 1 : 0;
}

// ---------------------------------------------------------------------------
// e2e
// ---------------------------------------------------------------------------

async function runE2e(argv) {
  const { values: opts } = parseArgs({ args: argv, options: { keep: { type: 'boolean', default: false }, only: { type: 'string' } } });
  const PAT = process.env.FORGE_PAT || die('FORGE_PAT is not set');
  const BOT = process.env.FORGE_PAT_BOT || '';
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
    return { status: res.status, text, json: body, cost: res.headers.get('x-forge-cost') };
  }

  const work = mkdtempSync(join(tmpdir(), 'mcp-agent-'));
  const askpass = join(work, 'askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv FORGE_E2E_TOKEN ;; esac\n');
  chmodSync(askpass, 0o700);

  function git(args, cwd, token = PAT) {
    const r = spawnSync('git', ['-c', 'credential.helper=', ...args], {
      cwd,
      env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', FORGE_E2E_TOKEN: token },
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
  async function pushRetry(dir, url, refspec) {
    for (let i = 0; i < 8; i++) {
      if (git(['push', '-q', url, refspec], dir).code === 0) return;
      await sleep(3000);
    }
    throw new Error(`push ${refspec} kept failing`);
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
    console.log(`connect -> server ${server?.name} ${server?.version}; capabilities ${JSON.stringify(caps)}; initialize HTTP ${owner.exchanges[0]?.status} x-forge-cost ${owner.exchanges[0]?.cost}`);
    const { tools } = await owner.client.listTools();
    check('VAL-MCP-001', 'initialize with a PAT succeeds (server info + tools capability) and listTools works', Boolean(server?.name && server?.version && caps?.tools) && tools.length > 0, `${tools.length} tools`);
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } } });
    for (const [label, headers] of [
      ['no Authorization', {}],
      ['invalid Bearer token', { Authorization: `Bearer forge_pat_${'0'.repeat(64)}` }],
    ]) {
      const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: init });
      const text = await res.text();
      console.log(`POST /mcp initialize (${label}) -> ${res.status} ${text} www-authenticate=${res.headers.get('www-authenticate')} x-forge-cost ${res.headers.get('x-forge-cost')}`);
      check('VAL-MCP-002', `${label} → HTTP 401`, res.status === 401);
    }
  }

  // Registry (VAL-MCP-003 is completed by later features; here every tool must be described and schema'd).
  if (!only || only.has('registry')) {
    console.log('\n# registry');
    const { tools } = await owner.client.listTools();
    const { OPERATIONS } = await import('@forge/ops');
    const names = tools.map((t) => t.name);
    console.log(`listTools names (${names.length}): ${names.join(', ')}`);
    check('registry', 'tools/list equals the shared operation registry', eq([...names].sort(), OPERATIONS.map((o) => o.name).sort()));
    check('registry', 'every tool has a description and an object input schema', tools.every((t) => t.description && t.inputSchema?.type === 'object'));
    const original = ['list_repos', 'get_tree', 'read_file', 'compare', 'get_file_diff', 'create_workspace', 'create_change_set', 'get_change', 'merge_change'];
    check('registry', 'original tools implemented so far are present', original.every((n) => names.includes(n)), original.filter((n) => !names.includes(n)).join(',') || 'all present');
  }

  await scenario('parity', 'public', async (repo) => {
    const env = await seeded(repo);
    const { api, dir, main } = env;

    // VAL-MCP-004
    const ml = await call(owner, 'list_repos');
    const rl = await http('/api/v1/repos');
    const mNames = (ml.data?.repos ?? []).map((r) => `${r.owner}/${r.name}`).sort();
    const rNames = (rl.json?.repos ?? []).map((r) => `${r.owner}/${r.name}`).sort();
    console.log(`list_repos -> ${mNames.length} repos (x-forge-cost ${ml.cost}); REST GET /repos -> ${rNames.length} repos (x-forge-cost ${rl.cost}); only-mcp=${JSON.stringify(mNames.filter((n) => !rNames.includes(n)))} only-rest=${JSON.stringify(rNames.filter((n) => !mNames.includes(n)))}`);
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
      console.log(`get_tree ${path ?? '/'} -> ${JSON.stringify(mine)} (x-forge-cost ${t.cost})\ngit ls-tree ${spec} -> ${JSON.stringify(truth)}`);
      check('VAL-MCP-005', `get_tree ${path ?? '<root>'} names/types/modes/hashes equal git ls-tree ${spec}`, !t.isError && eq(mine, truth) && t.data?.sha === main);
    }
    for (const path of ['src/lib/util.ts', 'docs/guide.md']) {
      const f = await call(owner, 'read_file', { repo: env.repo, path, ref: 'main' });
      const truth = mustGit(['show', `main:${path}`], dir) + '\n';
      console.log(`read_file ${path} -> encoding=${f.data?.encoding} size=${f.data?.size} (x-forge-cost ${f.cost}); git show bytes=${Buffer.byteLength(truth)}`);
      check('VAL-MCP-005', `read_file ${path} equals git show main:${path} byte for byte`, !f.isError && f.data?.encoding === 'utf-8' && f.data?.content === truth && f.data?.size === Buffer.byteLength(truth));
    }

    // VAL-MCP-006
    const head = commitOn(dir, main, { 'src/app.ts': 'export const app = 2;\nexport const extra = true;\n', 'docs/new.md': '# new\n' }, 'feature');
    await pushRetry(dir, env.url, `${head}:refs/heads/feature`);
    const mc = await call(owner, 'compare', { repo: env.repo, base: 'main', head: 'feature' });
    const rc = await http(`${api}/compare/main...feature`);
    const key = (files) => (files ?? []).map((f) => `${f.status}:${f.path}`).sort();
    console.log(`compare (mcp) files=${JSON.stringify(key(mc.data?.files))} totals=${JSON.stringify(mc.data?.totals)} rating=${JSON.stringify(mc.data?.rating ?? mc.data?.risk?.rating)} (x-forge-cost ${mc.cost})\ncompare (REST) files=${JSON.stringify(key(rc.json?.files))} totals=${JSON.stringify(rc.json?.totals)} (x-forge-cost ${rc.cost})`);
    check('VAL-MCP-006', 'compare equals REST compare (files, statuses, totals, rating; full body)', !mc.isError && rc.status === 200 && eq(key(mc.data?.files), key(rc.json?.files)) && eq(mc.data?.totals, rc.json?.totals) && eq(mc.data, rc.json));
    const md = await call(owner, 'get_file_diff', { repo: env.repo, base: 'main', head: 'feature', path: 'src/app.ts' });
    const rd = await http(`${api}/compare/main...feature/file?path=src%2Fapp.ts`);
    console.log(`get_file_diff hunks=${JSON.stringify(md.data?.hunks)} (x-forge-cost ${md.cost}); REST file diff -> ${rd.status}`);
    check('VAL-MCP-006', 'get_file_diff hunks equal the REST per-file diff', !md.isError && rd.status === 200 && Array.isArray(md.data?.hunks) && eq(md.data, rd.json));

    // VAL-MCP-007 / VAL-MCP-008
    const cw = await call(owner, 'create_workspace', { repo: env.repo, task: 'mcp parity', agent: 'mcp-agent-1' });
    const ws = cw.data ?? {};
    console.log(`create_workspace -> ${cw.text} (x-forge-cost ${cw.cost})`);
    const listed = await http(`${api}/workspaces`);
    const restWs = listed.json?.workspaces?.find((w) => w.id === ws.id);
    check('VAL-MCP-007', 'create_workspace returns id/ref/pushUrl shaped like REST and REST lists the same record', !cw.isError && ws.ref?.startsWith(`refs/heads/agents/${ws.id}/`) && ws.pushUrl === env.url && eq(restWs, ws), JSON.stringify(restWs));
    const sha = commitOn(dir, main, { 'src/feature.ts': 'export const feature = 1;\n' }, 'workspace work');
    await pushRetry(dir, env.url, `${sha}:${ws.ref}`);
    const cs = await call(owner, 'create_change_set', { repo: env.repo, workspace: ws.id, title: 'MCP change set', mergePolicy: 'review' });
    console.log(`create_change_set -> ${cs.text} (x-forge-cost ${cs.cost})`);
    const restCs = await http(`${api}/changes/${cs.data?.number}`);
    const csKeys = ['number', 'title', 'state', 'mergePolicy', 'kind', 'base', 'head', 'baseSha', 'headSha', 'author', 'createdAt'];
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
    console.log(`merge_change -> state=${mg.data?.state} mergeCommit=${mg.data?.mergeCommit} (x-forge-cost ${mg.cost})`);
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
    console.log(`compose_candidates -> commitSha=${comp.data?.commitSha} workspace.headSha=${comp.data?.workspace?.headSha} baseSha=${comp.data?.workspace?.baseSha} advertised=${advertised} (x-forge-cost ${comp.cost})`);
    check('compose', 'compose_candidates workspace.headSha is the composed commit (not the base)', !comp.isError && comp.data?.workspace?.headSha === comp.data?.commitSha && advertised === comp.data?.commitSha && comp.data?.commitSha !== main2);
    const compRead = await call(owner, 'get_composition', { repo: env.repo, id: comp.data?.id });
    check('compose', 'get_composition readback keeps the composed head', compRead.data?.workspace?.headSha === comp.data?.commitSha);
  });

  // VAL-MCP-010
  await scenario('visibility', 'public', async (repo) => {
    const env = await seeded(repo);
    const priv = await http('/api/v1/repos', { method: 'POST', json: { name: `${repo}-private`, visibility: 'private' } });
    if (!BOT) {
      check('VAL-MCP-010', 'FORGE_PAT_BOT is set', false);
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
        const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'forge', '--remote', '--json', '--command', `UPDATE repos SET visibility = '${visibility}' WHERE owner_login = '${OWNER}' AND name = '${repo}'`], { cwd: PLATFORM_DIR, encoding: 'utf8' });
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
    console.log(`warm MCP read_file /mcp x-forge-cost: ${m.cost}\nwarm REST GET contents x-forge-cost: ${r.cost}`);
    check('VAL-COST-017', 'warm MCP read_file work counters (d1, art, r2b) equal the warm REST file read', !m.isError && r.status === 200 && ['d1', 'art', 'r2b'].every((k) => Number.isInteger(mc[k]) && mc[k] === rc[k]), JSON.stringify({ mcp: mc, rest: rc }));
    const sha = mustGit(['rev-parse', 'HEAD'], env.dir);
    await call(owner, 'read_file', { ...args, ref: sha });
    const ms = await call(owner, 'read_file', { ...args, ref: sha });
    await http(`${env.api}/contents?path=src%2Flib%2Futil.ts&ref=${sha}`);
    const rs = await http(`${env.api}/contents?path=src%2Flib%2Futil.ts&ref=${sha}`);
    console.log(`warm by commit SHA: MCP ${ms.cost} | REST ${rs.cost}`);
    check('VAL-COST-017', 'warm read by commit SHA: identical counters, cache hit, art=0', ['d1', 'art', 'r2b', 'do'].every((k) => parseCost(ms.cost)[k] === parseCost(rs.cost)[k]) && parseCost(ms.cost).art === 0 && parseCost(ms.cost).cache === 'hit');
  });

  // Two agents work through MCP only (plus git push); the caller lands the winner.
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
      const mg = await call(owner, 'merge_change', { repo: env.repo, number: c1.number });
      const loser = await call(owner, 'get_change', { repo: env.repo, number: c2.number });
      const mergeability = await call(owner, 'get_mergeability', { repo: env.repo, number: c2.number });
      mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], env.dir);
      const util = mustGit(['show', 'origin/main:src/lib/util.ts'], env.dir);
      console.log(`merge_change #${c1.number} -> ${mg.data?.state} ${mg.data?.mergeCommit}; loser #${c2.number} state=${loser.data?.state}; loser mergeability=${mergeability.text.slice(0, 200)}; origin/main util.ts: ${JSON.stringify(util)}`);
      check('two-agent', 'winner lands on main via merge_change; loser stays open (no auto-close)', !mg.isError && mg.data?.state === 'merged' && util.includes('agent one') && loser.data?.state === 'open');
      const ab = await call(a2, 'abandon_workspace', { repo: env.repo, workspace: w2.id });
      check('two-agent', 'loser explicitly abandoned through MCP', !ab.isError && ab.data?.status === 'abandoned', ab.text.slice(0, 200));
    } finally {
      await a1.close();
      await a2.close();
    }
  });

  // VAL-CROSS-012
  await scenario('arena', 'public', async (repo) => {
    const env = await seeded(repo);
    const made = await call(owner, 'create_arena', { repo: env.repo, brief: 'Refactor util', candidates: 3, base: 'main' });
    const arena = made.data ?? {};
    console.log(`create_arena -> id=${arena.id} state=${arena.state} workspaces=${arena.workspaces?.map((w) => w.id).join(',')} (x-forge-cost ${made.cost})`);
    const restArena = await http(`${env.api}/arenas/${arena.id}`);
    check('VAL-CROSS-012', 'arena of 3 created through MCP equals the REST readback', !made.isError && arena.workspaces?.length === 3 && eq(restArena.json, arena));
    const bodies = [
      'export function util(x: number) {\n  return 1 + x;\n}\n',
      'export const util = (x: number): number => x + 1;\n',
      'export function util(value: number) {\n  const next = value + 1;\n  return next;\n}\n',
    ];
    const changes = {};
    for (const [i, w] of arena.workspaces.entries()) {
      const sha = commitOn(env.dir, env.main, { 'src/lib/util.ts': bodies[i], [`notes/${i}.md`]: `candidate ${i}\n` }, `refactor ${i}`);
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
    console.log(`rank_arena (mcp) ranking=${JSON.stringify(mr.data?.ranking?.map((e) => [e.rank, e.workspace]))} (x-forge-cost ${mr.cost})\nREST ranking=${JSON.stringify(rr.json?.ranking?.map((e) => [e.rank, e.workspace]))} (x-forge-cost ${rr.cost})`);
    check('VAL-CROSS-012', 'MCP rank_arena data equals REST GET arenas/:id/candidates', !mr.isError && rr.status === 200 && eq(mr.data, rr.json) && mr.data?.ranking?.length === 3);
    const winner = mr.data.ranking[0].workspace;
    const losers = arena.workspaces.map((w) => w.id).filter((id) => id !== winner);
    const sel = await call(owner, 'select_arena_winner', { repo: env.repo, id: arena.id, workspace: winner });
    const openAfterSelect = await Promise.all(Object.values(changes).map((n) => call(owner, 'get_change', { repo: env.repo, number: n })));
    check('VAL-CROSS-012', 'selection recorded; no change set merged or closed by selecting', !sel.isError && sel.data?.selection?.selectedWorkspace === winner && openAfterSelect.every((c) => c.data?.state === 'open'));
    const mg = await call(owner, 'merge_change', { repo: env.repo, number: changes[winner] });
    mustGit(['fetch', '-q', env.url, '+refs/heads/main:refs/remotes/origin/main'], env.dir);
    const log = mustGit(['log', 'origin/main', '-1', '--format=%H'], env.dir);
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
