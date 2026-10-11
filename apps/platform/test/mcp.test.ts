/**
 * MCP server at POST /mcp (src/mcp/server.ts): Bearer authentication, the
 * shared operation registry as tools/list, and tool calls dispatched to the
 * same REST routes (same authority lookup, same errors, same cost), over the
 * in-memory Artifacts fake. Raw JSON-RPC so nothing but the server SDK runs
 * in workerd.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OPERATIONS } from '@forge/ops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...(cfEnv as unknown as Env),
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'mcp-owner';
const tok = { owner: '', outsider: '', gitOnly: '' };
const BASE: Files = { 'README.md': 'readme\n', 'src/a.ts': 'export const a = 1;\n', 'src/lib/b.ts': 'b\n', 'docs/guide.md': 'guide\n' };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<{ repo: FakeRepo; main: string }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  const main = await commit(repo, BASE);
  repo.refs.set('refs/heads/main', main.sha);
  return { repo, main: main.sha };
}

interface Reply {
  status: number;
  json: any;
  cost: CostCounters;
  headers: Headers;
}

async function send(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, cost: cost!, headers: res.headers };
}

const ACCEPT = { accept: 'application/json, text/event-stream' };
let nextId = 1;
const rpc = (method: string, params?: unknown) => ({ jsonrpc: '2.0', id: nextId++, method, ...(params !== undefined ? { params } : {}) });
const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1.0.0' } };

const mcp = (body: unknown, token?: string) => send('POST', '/mcp', { token, body, headers: ACCEPT });
const rest = (method: string, path: string, token: string | undefined = tok.owner, body?: unknown) =>
  send(method, `/api/v1${path}`, { token, body });

interface ToolReply {
  status: number;
  isError: boolean;
  data: any;
  cost: CostCounters;
}

async function tool(name: string, args: Record<string, unknown>, token = tok.owner): Promise<ToolReply> {
  const r = await mcp(rpc('tools/call', { name, arguments: args }), token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.error, JSON.stringify(r.json)).toBeUndefined();
  const result = r.json.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
  expect(result.content[0]?.type).toBe('text');
  let data: any;
  try {
    data = JSON.parse(result.content[0]!.text);
  } catch {
    data = result.content[0]!.text;
  }
  return { status: r.status, isError: result.isError === true, data, cost: r.cost };
}

interface Streamed {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
  cancelled: () => boolean;
}

/** A pull-driven body: chunks are produced only as the server reads them. */
function streamOf(parts: Iterable<Uint8Array>): Streamed {
  const it = parts[Symbol.iterator]();
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const n = it.next();
        if (n.done) {
          c.close();
          return;
        }
        pulled += n.value.byteLength;
        c.enqueue(n.value);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulled: () => pulled, cancelled: () => cancelled };
}

function* chunked(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let i = 0; i < bytes.byteLength; i += size) yield bytes.slice(i, i + size);
}

/** POST /mcp with a streamed body and no Content-Length. */
async function mcpStream(s: Streamed, token = tok.owner): Promise<{ status: number; json: any }> {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...ACCEPT },
    body: s.stream,
  });
  expect(req.headers.get('content-length')).toBeNull();
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

const R = (repo: string) => `/repos/${OWNER}/${repo}`;
const shas: Record<string, string> = {};

beforeAll(async () => {
  installFakeGitRemote();
  const ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  const outsiderId = await seedUser('mcp-outsider');
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', FULL)).token;
  tok.gitOnly = (await mintPAT(env, ownerId, 'git-only', ['read', 'write'])).token;
  for (const name of ['main-repo', 'second']) shas[name] = (await seedRepo(name)).main;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('POST /mcp authentication', () => {
  it('rejects a request without a token, with a malformed token and with an unknown token with HTTP 401', async () => {
    for (const token of [undefined, 'not-a-token', `forge_pat_${'0'.repeat(64)}`]) {
      const r = await mcp(rpc('initialize', INIT), token);
      expect(r.status, String(token)).toBe(401);
      expect(r.json).toEqual({ error: 'unauthorized', code: 'UNAUTHENTICATED' });
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
    }
  });

  it('rejects a tool call with an unknown token with HTTP 401 and no data, cold and cached', async () => {
    const unknown = `forge_pat_${'1'.repeat(64)}`;
    for (let i = 0; i < 2; i++) {
      const r = await mcp(rpc('tools/call', { name: 'get_repo', arguments: { repo: `${OWNER}/main-repo` } }), unknown);
      expect(r.status).toBe(401);
      expect(JSON.stringify(r.json)).not.toContain('main-repo');
    }
  });

  it('refuses a token without the api scope with HTTP 403', async () => {
    const init = await mcp(rpc('initialize', INIT), tok.gitOnly);
    expect(init.status).toBe(403);
    expect(init.json.code).toBe('INSUFFICIENT_SCOPE');
    const call = await mcp(rpc('tools/call', { name: 'get_repo', arguments: { repo: `${OWNER}/main-repo` } }), tok.gitOnly);
    expect(call.status).toBe(403);
    expect(JSON.stringify(call.json)).not.toContain('defaultBranch');
  });

  it('counts incoming bytes, not characters: a chunked multibyte body over 1 MiB without Content-Length is 413', async () => {
    // 600,000 two-byte characters: about 1.2 MB of UTF-8 but only 600 k UTF-16 code units.
    const json = JSON.stringify(rpc('tools/list', { pad: 'é'.repeat(600_000) }));
    const s = streamOf(chunked(new TextEncoder().encode(json), 65_536));
    const r = await mcpStream(s);
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ jsonrpc: '2.0', error: { code: -32600, message: 'request body too large' }, id: null });
  });

  it('stops reading an oversized chunked body at the cap and cancels the stream', async () => {
    const CHUNK = 64 * 1024;
    const prefix = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"');
    const filler = new Uint8Array(CHUNK).fill(0x61);
    const s = streamOf(
      (function* () {
        yield prefix;
        for (let i = 0; i < 128; i++) yield filler; // 8 MiB, never terminated
      })(),
    );
    const r = await mcpStream(s);
    expect(r.status).toBe(413);
    expect(s.pulled()).toBeLessThanOrEqual(1024 * 1024 + 2 * CHUNK);
    expect(s.cancelled()).toBe(true);
  });

  it('accepts a chunked body without Content-Length whose multibyte characters straddle chunk boundaries', async () => {
    const reason = 'naïve café: 漢字 and 🚀 survive byte-sized chunks';
    const json = JSON.stringify(
      rpc('tools/call', { name: 'record_decision', arguments: { repo: `${OWNER}/main-repo`, task: 'utf8', chosen: 'ws-1', rejected: [], reason } }),
    );
    const r = await mcpStream(streamOf(chunked(new TextEncoder().encode(json), 1)));
    expect(r.status).toBe(200);
    expect(r.json.result.isError).toBeUndefined();
    expect(JSON.parse(r.json.result.content[0].text)).toMatchObject({ task: 'utf8', reason });
  });

  it('answers 405 for GET and DELETE (stateless server, no SSE stream)', async () => {
    expect((await send('GET', '/mcp', { token: tok.owner, headers: { accept: 'text/event-stream' } })).status).toBe(405);
    expect((await send('DELETE', '/mcp', { token: tok.owner })).status).toBe(405);
  });
});

describe('MCP handshake and registry', () => {
  it('initializes with a PAT and reports the server name, version and tools capability', async () => {
    const r = await mcp(rpc('initialize', INIT), tok.owner);
    expect(r.status).toBe(200);
    expect(r.json.result.serverInfo).toEqual({ name: 'veyr-9', version: expect.any(String) });
    expect(r.json.result.capabilities.tools).toBeDefined();
    expect(r.json.result.protocolVersion).toBe('2025-06-18');
    expect(r.headers.get('mcp-session-id')).toBeNull();
    const note = await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, tok.owner);
    expect(note.status).toBe(202);
  });

  it('lists exactly the operation registry, each tool with a description and an object input schema', async () => {
    const r = await mcp(rpc('tools/list', {}), tok.owner);
    expect(r.status).toBe(200);
    const tools = r.json.result.tools as Array<{ name: string; description: string; inputSchema: any; annotations?: any }>;
    expect(tools.map((t) => t.name)).toEqual(OPERATIONS.map((o) => o.name));
    const original = ['list_repos', 'get_tree', 'read_file', 'compare', 'get_file_diff', 'create_workspace', 'create_change_set', 'get_change', 'merge_change', 'enqueue_change', 'list_tasks', 'claim_task', 'complete_task', 'get_attribution', 'set_attribution'];
    const dependencies = ['add_dependency', 'list_dependencies', 'repin_dependency', 'detach_dependency', 'get_train'];
    for (const n of [...original, ...dependencies]) expect(tools.map((t) => t.name), n).toContain(n);
    expect(tools.find((t) => t.name === 'detach_dependency')!.annotations).toMatchObject({ destructiveHint: true });
    expect([...tools.find((t) => t.name === 'add_dependency')!.inputSchema.required].sort()).toEqual(['onWorkspace', 'repo', 'revision', 'workspace']);
    for (const t of tools) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.inputSchema.type, t.name).toBe('object');
    }
    const readFile = tools.find((t) => t.name === 'read_file')!;
    expect(Object.keys(readFile.inputSchema.properties).sort()).toEqual(['path', 'ref', 'repo']);
    expect([...readFile.inputSchema.required].sort()).toEqual(['path', 'repo']);
    expect(readFile.annotations).toMatchObject({ readOnlyHint: true });
    expect(tools.find((t) => t.name === 'merge_change')!.annotations).toMatchObject({ readOnlyHint: false });
  });
});

describe('MCP tools match REST', () => {
  it('list_repos returns the REST repo list', async () => {
    const t = await tool('list_repos', {});
    expect(t.isError).toBe(false);
    const r = await rest('GET', '/repos');
    expect(t.data).toEqual(r.json);
    expect(t.data.repos.map((x: any) => x.name).sort()).toEqual(['main-repo', 'second']);
  });

  it('get_tree and read_file return the repository content', async () => {
    const root = await tool('get_tree', { repo: `${OWNER}/main-repo`, ref: 'main' });
    expect(root.data.entries.map((e: any) => [e.name, e.type])).toEqual([
      ['README.md', 'blob'],
      ['docs', 'tree'],
      ['src', 'tree'],
    ]);
    const sub = await tool('get_tree', { repo: `${OWNER}/main-repo`, path: 'src' });
    expect(sub.data.entries.map((e: any) => e.path)).toEqual(['src/a.ts', 'src/lib']);
    const file = await tool('read_file', { repo: `${OWNER}/main-repo`, path: 'src/a.ts', ref: 'main' });
    expect(file.data).toMatchObject({ encoding: 'utf-8', content: 'export const a = 1;\n' });
    expect(file.data).toEqual((await rest('GET', `${R('main-repo')}/contents?path=src/a.ts&ref=main`)).json);
  });

  it('read_file costs the same as the REST file read (warm)', async () => {
    const args = { repo: `${OWNER}/main-repo`, path: 'README.md', ref: 'main' };
    const restPath = `${R('main-repo')}/contents?path=README.md&ref=main`;
    await tool('read_file', args);
    await rest('GET', restPath);
    const viaMcp = await tool('read_file', args);
    const viaRest = await rest('GET', restPath);
    for (const k of ['d1', 'art', 'r2b', 'do', 'q'] as const) expect(viaMcp.cost[k], k).toBe(viaRest.cost[k]);
    expect(viaMcp.cost.d1).toBe(1);
  });

  it('compare and get_file_diff equal the REST compare endpoints', async () => {
    const { repo } = { repo: fakeRepos.get(`${OWNER}--main-repo`)! };
    const feature = await commit(repo, { ...BASE, 'src/a.ts': 'export const a = 2;\n', 'new.txt': 'n\n' }, [shas['main-repo']!]);
    repo.refs.set('refs/heads/feature/x', feature.sha);
    const cmp = await tool('compare', { repo: `${OWNER}/main-repo`, base: 'main', head: 'feature/x' });
    expect(cmp.isError).toBe(false);
    const restCmp = await rest('GET', `${R('main-repo')}/compare/main...${encodeURIComponent('feature/x')}`);
    expect(cmp.data).toEqual(restCmp.json);
    expect(cmp.data.files.map((f: any) => [f.path, f.status])).toEqual([
      ['new.txt', 'added'],
      ['src/a.ts', 'modified'],
    ]);
    const diff = await tool('get_file_diff', { repo: `${OWNER}/main-repo`, base: 'main', head: 'feature/x', path: 'src/a.ts' });
    expect(diff.data).toEqual((await rest('GET', `${R('main-repo')}/compare/main...feature/x/file?path=src%2Fa.ts`)).json);
    expect(diff.data.hunks.length).toBe(1);
  });

  it('create_workspace, create_change_set and merge_change produce the REST objects and an explicit merge', async () => {
    const ws = await tool('create_workspace', { repo: `${OWNER}/second`, task: 'mcp task', agent: 'mcp-agent' });
    expect(ws.isError, JSON.stringify(ws.data)).toBe(false);
    expect(ws.data).toMatchObject({ task: 'mcp task', agent: 'mcp-agent', status: 'active', pushUrl: `${ORIGIN}/${OWNER}/second.git` });
    expect((await rest('GET', `${R('second')}/workspaces/${ws.data.id}`)).json).toMatchObject({ id: ws.data.id, ref: ws.data.ref });

    const repo = fakeRepos.get(`${OWNER}--second`)!;
    const work = await commit(repo, { ...BASE, 'feature.txt': 'f\n' }, [shas.second!]);
    repo.refs.set(ws.data.ref, work.sha);

    const cs = await tool('create_change_set', { repo: `${OWNER}/second`, workspace: ws.data.id, title: 'via mcp', mergePolicy: 'review' });
    expect(cs.isError, JSON.stringify(cs.data)).toBe(false);
    expect(cs.data).toMatchObject({ title: 'via mcp', mergePolicy: 'review', state: 'open', workspace: ws.data.id });
    const viaRest = await rest('GET', `${R('second')}/changes/${cs.data.number}`);
    expect(viaRest.json).toMatchObject({ number: cs.data.number, state: 'open', mergePolicy: 'review', headSha: work.sha });
    const got = await tool('get_change', { repo: `${OWNER}/second`, number: cs.data.number });
    expect(got.data.number).toBe(cs.data.number);

    const merged = await tool('merge_change', { repo: `${OWNER}/second`, number: cs.data.number });
    expect(merged.isError, JSON.stringify(merged.data)).toBe(false);
    expect(merged.data.merge.kind).toBe('fast-forward');
    const after = await rest('GET', `${R('second')}/changes/${cs.data.number}`);
    expect(after.json).toMatchObject({ state: 'merged', mergeCommit: work.sha });
    expect(repo.refs.get('refs/heads/main')).toBe(work.sha);
  });

  it('set_attribution, get_attribution and get_context round-trip with REST and are permission-checked', async () => {
    const { main } = await seedRepo('attr');
    const repo = `${OWNER}/attr`;
    const set = await tool('set_attribution', { repo, sha: main, agent: 'mcp-agent', session: 's-1', promptHash: 'b'.repeat(64), model: 'm' });
    expect(set.isError, JSON.stringify(set.data)).toBe(false);
    const got = await tool('get_attribution', { repo, sha: main });
    expect(got.data).toEqual(set.data);
    expect((await rest('GET', `${R('attr')}/commits/${main}/attribution`)).json).toEqual(set.data);
    expect(set.data).toMatchObject({ agent: 'mcp-agent', actor: OWNER });

    const rec = await tool('record_decision', {
      repo,
      task: 'T-1',
      paths: ['README.md'],
      chosen: 'ws-b',
      rejected: [{ id: 'ws-a', reason: 'fails lint' }],
      reason: 'smaller',
    });
    expect(rec.isError, JSON.stringify(rec.data)).toBe(false);
    for (const args of [{ task: 'T-1' }, { path: ['README.md'] }]) {
      const ctx = await tool('get_context', { repo, ...args });
      expect(ctx.data).toEqual({ decisions: [rec.data], truncated: false, nextCursor: null });
    }
    expect((await tool('get_context', { repo, task: 'none' })).data.decisions).toEqual([]);
    const over = await tool('get_context', { repo, path: Array.from({ length: 21 }, (_, i) => `p${i}`) });
    expect([over.isError, over.data.code]).toEqual([true, 'TOO_MANY_PATHS']);

    for (const [name, args] of [
      ['get_context', { repo, task: 'T-1' }],
      ['get_attribution', { repo, sha: main }],
    ] as const) {
      const t = await tool(name, args, tok.outsider);
      expect(t.isError, name).toBe(true);
      expect(t.data, name).toEqual({ status: 404, error: 'not found', code: 'NOT_FOUND' });
    }
  });

  it('record_decision and get_context keep commas inside paths, like REST', async () => {
    await seedRepo('comma');
    const repo = `${OWNER}/comma`;
    const rec = await tool('record_decision', { repo, paths: ['src/a,b.ts'], chosen: 'ws-1', rejected: [], reason: 'comma path' });
    expect(rec.isError, JSON.stringify(rec.data)).toBe(false);
    expect(rec.data.paths).toEqual(['src/a,b.ts']);
    const half = await tool('record_decision', { repo, paths: ['src/a'], chosen: 'ws-2', rejected: [], reason: 'one half of the split' });
    const got = await tool('get_context', { repo, path: ['src/a,b.ts'] });
    expect(got.data).toEqual({ decisions: [rec.data], truncated: false, nextCursor: null });
    expect((await rest('GET', `${R('comma')}/context?path=${encodeURIComponent('src/a,b.ts')}`)).json).toEqual(got.data);
    expect((await tool('get_context', { repo, path: ['src/a'] })).data.decisions).toEqual([half.data]);
  });

  it('delete_repo, fork_repo and import_repo reach the existing repository lifecycle routes', async () => {
    await seedRepo('doomed');
    const repo = `${OWNER}/doomed`;
    const denied = await tool('delete_repo', { repo }, tok.outsider);
    expect(denied).toMatchObject({ isError: true, data: { status: 404, error: 'not found', code: 'NOT_FOUND' } });

    const fork = await tool('fork_repo', { repo, name: 'bad name!' });
    const restFork = await rest('POST', `${R('doomed')}/forks`, tok.owner, { name: 'bad name!' });
    expect(restFork.status).toBe(400);
    expect(fork).toMatchObject({ isError: true, data: { status: 400, ...restFork.json } });

    const imp = await tool('import_repo', { url: 'http://example.test/src.git', name: 'src' });
    const restImp = await rest('POST', '/import', tok.owner, { url: 'http://example.test/src.git', name: 'src' });
    expect(restImp.status).toBe(400);
    expect(imp).toMatchObject({ isError: true, data: { status: 400, ...restImp.json } });

    const del = await tool('delete_repo', { repo });
    expect(del).toMatchObject({ isError: false, data: { deleted: true } });
    expect((await rest('GET', R('doomed'))).status).toBe(404);
  });

  it('compose_candidates returns the composed commit as the new workspace head', async () => {
    const { repo, main } = await seedRepo('compose');
    const a = await tool('create_workspace', { repo: `${OWNER}/compose`, task: 'a' });
    const b = await tool('create_workspace', { repo: `${OWNER}/compose`, task: 'b' });
    repo.refs.set(a.data.ref, (await commit(repo, { ...BASE, 'a.txt': 'a\n' }, [main])).sha);
    repo.refs.set(b.data.ref, (await commit(repo, { ...BASE, 'b.txt': 'b\n' }, [main])).sha);
    const c = await tool('compose_candidates', { repo: `${OWNER}/compose`, workspaces: [a.data.id, b.data.id] });
    expect(c.isError, JSON.stringify(c.data)).toBe(false);
    expect(c.data.workspace.headSha).toBe(c.data.commitSha);
    expect(c.data.workspace.baseSha).toBe(main);
    expect((await tool('get_composition', { repo: `${OWNER}/compose`, id: c.data.id })).data).toEqual(c.data);
  });

  it('rank_arena returns the REST arena ranking', async () => {
    const { repo, main } = await seedRepo('arena');
    const arena = await tool('create_arena', { repo: `${OWNER}/arena`, brief: 'refactor', candidates: 2 });
    expect(arena.isError, JSON.stringify(arena.data)).toBe(false);
    for (const [i, w] of (arena.data.workspaces as Array<{ ref: string }>).entries()) {
      repo.refs.set(w.ref, (await commit(repo, { ...BASE, [`r${i}.txt`]: 'x\n'.repeat(i + 1) }, [main])).sha);
    }
    const ranked = await tool('rank_arena', { repo: `${OWNER}/arena`, id: arena.data.id });
    expect(ranked.isError).toBe(false);
    expect(ranked.data).toEqual((await rest('GET', `${R('arena')}/arenas/${arena.data.id}/candidates`)).json);
    expect(ranked.data.ranking).toHaveLength(2);
  });
});

describe('MCP tool result text', () => {
  async function rawText(method: string, path: string, body?: unknown): Promise<string> {
    const ctx = createExecutionContext();
    const headers: Record<string, string> = { Authorization: `Bearer ${tok.owner}`, ...ACCEPT };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
    const text = await res.text();
    await waitOnExecutionContext(ctx);
    return text;
  }

  async function toolText(name: string, args: Record<string, unknown>): Promise<string> {
    const envelope = JSON.parse(await rawText('POST', '/mcp', rpc('tools/call', { name, arguments: args }))) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    expect(envelope.result.isError).toBeUndefined();
    return envelope.result.content[0]!.text;
  }

  it('is the REST reply text byte for byte, and a successful JSON reply is not parsed again', async () => {
    const repo = fakeRepos.get(`${OWNER}--main-repo`)!;
    const files = { ...BASE, 'docs/naïve ✓ "q" \\ \u2028.md': 'unicode\n', 'src/a.ts': 'export const a = "é\\u0000";\n' };
    const head = await commit(repo, files, [shas['main-repo']!]);
    repo.refs.set('refs/heads/text-bytes', head.sha);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['compare', { repo: `${OWNER}/main-repo`, base: 'main', head: 'text-bytes' }, `/api/v1${R('main-repo')}/compare/main...text-bytes`],
      ['get_tree', { repo: `${OWNER}/main-repo`, path: 'docs', ref: 'text-bytes' }, `/api/v1${R('main-repo')}/tree?path=docs&ref=text-bytes`],
      ['read_file', { repo: `${OWNER}/main-repo`, path: 'src/a.ts', ref: 'text-bytes' }, `/api/v1${R('main-repo')}/contents?path=src%2Fa.ts&ref=text-bytes`],
      ['list_repos', {}, '/api/v1/repos'],
    ];
    for (const [name, args, path] of cases) {
      const restText = await rawText('GET', path);
      expect(restText.startsWith('{'), name).toBe(true);
      const parse = vi.spyOn(JSON, 'parse');
      let viaTool: string;
      try {
        viaTool = await toolText(name, args);
        expect(parse.mock.calls.filter(([text]) => text === restText).length, name).toBe(0);
      } finally {
        parse.mockRestore();
      }
      expect(viaTool, name).toBe(restText);
    }
  });
});

describe('MCP tool errors', () => {
  it('surfaces REST failures as isError results inside a 200 JSON-RPC envelope', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['get_tree', { repo: `${OWNER}/no-such-repo` }, 'NOT_FOUND'],
      ['read_file', { repo: `${OWNER}/main-repo`, path: 'missing.txt' }, 'FILE_NOT_FOUND'],
      ['compare', { repo: `${OWNER}/main-repo`, base: 'main', head: 'no-such-ref' }, 'REF_NOT_FOUND'],
      ['create_change_set', { repo: `${OWNER}/main-repo`, workspace: 'ffffffffffffffff', title: 't' }, 'WORKSPACE_NOT_FOUND'],
    ];
    for (const [name, args, code] of cases) {
      const t = await tool(name, args);
      expect(t.isError, name).toBe(true);
      expect(t.data.code, name).toBe(code);
      expect(t.data.status, name).toBeGreaterThanOrEqual(400);
      expect(t.data.error, name).toEqual(expect.any(String));
    }
  });

  it('reports invalid arguments as isError without dispatching', async () => {
    const missing = await tool('read_file', { repo: `${OWNER}/main-repo` });
    expect(missing.isError).toBe(true);
    const badRepo = await tool('get_repo', { repo: 'no-slash' });
    expect(badRepo.isError).toBe(true);
    expect(JSON.stringify(badRepo.data)).toMatch(/owner\/name/);
  });

  it('answers an unknown tool with a JSON-RPC error or isError, never HTTP 500', async () => {
    const r = await mcp(rpc('tools/call', { name: 'get_audit', arguments: {} }), tok.owner);
    expect(r.status).toBe(200);
    expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
  });
});

describe('MCP visibility', () => {
  it('conceals a private repo from another principal exactly like REST', async () => {
    expect((await rest('GET', R('main-repo'), tok.outsider)).status).toBe(404);
    for (const [name, args] of [
      ['get_repo', { repo: `${OWNER}/main-repo` }],
      ['get_tree', { repo: `${OWNER}/main-repo` }],
      ['read_file', { repo: `${OWNER}/main-repo`, path: 'README.md' }],
      ['compare', { repo: `${OWNER}/main-repo`, base: 'main', head: 'main' }],
    ] as const) {
      const t = await tool(name, args, tok.outsider);
      expect(t.isError, name).toBe(true);
      expect(t.data, name).toEqual({ status: 404, error: 'not found', code: 'NOT_FOUND' });
      expect(t.cost.art, name).toBe(0);
    }
  });

  it('denies the next outsider call after a direct D1 flip to private, with cached bodies still warm', async () => {
    await seedRepo('flip', 'public');
    const calls = [
      ['get_repo', { repo: `${OWNER}/flip` }],
      ['get_tree', { repo: `${OWNER}/flip` }],
      ['read_file', { repo: `${OWNER}/flip`, path: 'README.md' }],
    ] as const;
    for (const [name, args] of calls) {
      const warm = await tool(name, args, tok.outsider);
      expect(warm.isError, name).toBe(false);
    }
    await env.DB.prepare("UPDATE repos SET visibility = 'private' WHERE owner_login = ? AND name = 'flip'").bind(OWNER).run();
    const restDenied = await rest('GET', R('flip'), tok.outsider);
    expect(restDenied.status).toBe(404);
    for (const [name, args] of calls) {
      const t = await tool(name, args, tok.outsider);
      expect(t.isError, name).toBe(true);
      expect(t.data, name).toEqual({ status: 404, ...restDenied.json });
      const owner = await tool(name, args, tok.owner);
      expect(owner.isError, name).toBe(false);
    }
  });
});
