/**
 * The Kvarm brand cutover is breaking: a credential stored before the cutover
 * under the retired `forge_pat_` / `forge_agt_` prefixes no longer
 * authenticates on REST, the git gate or MCP, while its `kvarm_` twin does.
 * Branded response surfaces (cost header, auth realms, MCP identity) carry
 * the Kvarm names only.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '@kvarm/gitops';
import { mintPAT } from '../src/auth/pat';
import worker from '../src/index';
import { authorizeGitRequest } from '../src/routes/git';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'cutover-owner';
const REPO = 'cutover-private';
const RETIRED = 'forge';
const tok = { kvarm: '', retired: '', agent: '', retiredAgent: '' };

async function send(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const headers = { ...init.headers, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) };
  const req = new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const basic = (token: string) => ({ Authorization: `Basic ${btoa(`x:${token}`)}` });
const rest = (token: string) => send(`/api/v1/repos/${OWNER}/${REPO}`, { headers: bearer(token) });
const gitRefs = (token: string) => send(`/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`, { headers: basic(token) });
/** The git gate's authority decision alone; the fake Artifacts remote does not serve smart HTTP. */
async function gitAuthorized(token: string): Promise<boolean> {
  const req = new Request(`${ORIGIN}/${OWNER}/${REPO}.git/info/refs?service=git-upload-pack`, { headers: basic(token) });
  return (await authorizeGitRequest(env, req, OWNER, REPO, 'info/refs')).ok;
}
const mcpInit = (token: string) =>
  send('/mcp', {
    method: 'POST',
    headers: { ...bearer(token), accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cutover', version: '1' } } },
  });

/** Stores a token row exactly as minting did before the cutover, under the retired prefix. */
async function storeRetiredPat(userId: string, hex: string): Promise<string> {
  const token = `${RETIRED}_pat_${hex}`;
  await env.DB.prepare('INSERT INTO pat (id, user_id, name, prefix, hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), userId, 'pre-cutover', token.slice(0, 18), await sha256Hex(token), JSON.stringify(['read', 'write', 'api']), Date.now())
    .run();
  return token;
}

beforeAll(async () => {
  installFakeGitRemote();
  const userId = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(userId, `test:${OWNER}`, OWNER, `${OWNER}@example.invalid`, OWNER, Date.now())
    .run();
  const artifactsName = `${OWNER}--${REPO}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, REPO, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  repo.refs.set('refs/heads/main', (await commit(repo, { 'README.md': 'cutover\n' })).sha);

  tok.kvarm = (await mintPAT(env, userId, 'kvarm', ['read', 'write', 'api'])).token;
  tok.retired = await storeRetiredPat(userId, tok.kvarm.slice('kvarm_pat_'.length).split('').reverse().join(''));

  const agent = await send('/api/v1/agents', { method: 'POST', headers: bearer(tok.kvarm), body: { name: 'cutover-agent' } });
  expect(agent.status).toBe(201);
  const agentId = ((await agent.json()) as { agent: { id: string } }).agent.id;
  const mintAgent = async () => {
    const res = await send(`/api/v1/agents/${agentId}/tokens`, { method: 'POST', headers: bearer(tok.kvarm), body: { repo: `${OWNER}/${REPO}`, role: 'read' } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; token: string };
  };
  tok.agent = (await mintAgent()).token;
  const twin = await mintAgent();
  tok.retiredAgent = `${RETIRED}_agt_${twin.token.slice('kvarm_agt_'.length)}`;
  await env.DB.prepare('UPDATE agent_tokens SET hash = ?, prefix = ? WHERE id = ?')
    .bind(await sha256Hex(tok.retiredAgent), tok.retiredAgent.slice(0, 18), twin.id)
    .run();
});

afterAll(() => restoreFetch());

describe('retired token prefixes', () => {
  it('mints only kvarm_ prefixed credentials', () => {
    expect(tok.kvarm).toMatch(/^kvarm_pat_[0-9a-f]{64}$/);
    expect(tok.agent).toMatch(/^kvarm_agt_[0-9a-f]{64}$/);
  });

  it('rejects a stored retired-prefix PAT with 401 on REST, git and MCP while the kvarm PAT works', async () => {
    for (const [label, call] of [
      ['rest', rest],
      ['git', gitRefs],
      ['mcp', mcpInit],
    ] as const) {
      const denied = await call(tok.retired);
      const body = await denied.text();
      expect(denied.status, label).toBe(401);
      expect(body, label).not.toContain(REPO);
      if (label === 'git') expect(await gitAuthorized(tok.kvarm)).toBe(true);
      else expect((await call(tok.kvarm)).status, label).toBe(200);
    }
    expect(await gitAuthorized(tok.retired)).toBe(false);
  });

  it('rejects a stored retired-prefix agent token with 401 while a kvarm agent token works', async () => {
    expect((await rest(tok.retiredAgent)).status).toBe(401);
    expect((await gitRefs(tok.retiredAgent)).status).toBe(401);
    expect((await mcpInit(tok.retiredAgent)).status).toBe(401);
    expect((await rest(tok.agent)).status).toBe(200);
  });
});

describe('0023_kvarm_rename migration', () => {
  const migration = () => {
    const m = cfEnv.TEST_MIGRATIONS.find((x) => x.name === '0023_kvarm_rename.sql');
    expect(m, 'migration file').toBeDefined();
    return m!.queries;
  };

  it('is UPDATE-only: no DDL and no DELETE', () => {
    for (const q of migration()) expect(q.replace(/--.*$/gm, '').trim()).toMatch(/^UPDATE (check_runs|ci_jobs|branch_rules)\s/);
  });

  it('renames stored retired check names and required-check values, leaving everything else intact', async () => {
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE owner_login = ? AND name = ?').bind(OWNER, REPO).first<string>('id'))!;
    const userId = (await env.DB.prepare('SELECT id FROM users WHERE login = ?').bind(OWNER).first<string>('id'))!;
    const now = Date.now();
    const run = (id: string, name: string) =>
      env.DB.prepare("INSERT INTO check_runs (id, repo_id, head_sha, name, status, summary, created_at) VALUES (?, ?, ?, ?, 'success', ?, ?)").bind(
        id,
        repoId,
        'a'.repeat(40),
        name,
        JSON.stringify({ findings: [{ rule: `secret/${RETIRED}-token` }] }),
        now,
      );
    const names = { guard: `${RETIRED}/guard`, window: `${RETIRED}/checks-window`, config: `${RETIRED}/ci-config`, user: 'build', legacyJob: `${RETIRED}/legacy` };
    const ids = Object.fromEntries(Object.keys(names).map((k) => [k, crypto.randomUUID()]));
    await env.DB.batch([
      ...Object.entries(names).map(([k, name]) => run(ids[k]!, name)),
      env.DB.prepare("INSERT INTO ci_jobs (id, repo_id, check_run_id, head_sha, tree_sha, name, command, created_at) VALUES (?, ?, ?, ?, ?, ?, 'true', ?)").bind(
        crypto.randomUUID(),
        repoId,
        ids.legacyJob,
        'a'.repeat(40),
        'b'.repeat(40),
        names.legacyJob,
        now,
      ),
      env.DB.prepare('INSERT INTO branch_rules (id, repo_id, pattern, required_checks, required_approvals, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)').bind(
        crypto.randomUUID(),
        repoId,
        'refs/heads/main',
        JSON.stringify(['lint', names.guard, 'test', names.window]),
        userId,
        now,
        userId,
        now,
      ),
      env.DB.prepare("INSERT INTO branch_rules (id, repo_id, pattern, required_checks, created_by, created_at, updated_by, updated_at) VALUES (?, ?, 'refs/heads/plain', '[\"lint\"]', ?, ?, ?, ?)").bind(
        crypto.randomUUID(),
        repoId,
        userId,
        now,
        userId,
        now,
      ),
    ]);
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM check_runs').first<number>('n');

    for (let pass = 0; pass < 2; pass++) await env.DB.batch(migration().map((q) => env.DB.prepare(q)));

    const runs = await env.DB.prepare('SELECT id, name, summary FROM check_runs WHERE repo_id = ?').bind(repoId).all<{ id: string; name: string; summary: string }>();
    const byId = new Map(runs.results.map((r) => [r.id, r]));
    expect(byId.get(ids.guard!)?.name).toBe('kvarm/guard');
    expect(byId.get(ids.window!)?.name).toBe('kvarm/checks-window');
    expect(byId.get(ids.config!)?.name).toBe('kvarm/ci-config');
    expect(byId.get(ids.user!)?.name).toBe('build');
    expect(JSON.parse(byId.get(ids.guard!)!.summary).findings[0].rule).toBe(`secret/${RETIRED}-token`);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM check_runs').first<number>('n')).toBe(before);
    expect(await env.DB.prepare('SELECT name FROM ci_jobs WHERE check_run_id = ?').bind(ids.legacyJob).first<string>('name')).toBe('kvarm/legacy');
    const rules = await env.DB.prepare('SELECT pattern, required_checks, required_approvals FROM branch_rules WHERE repo_id = ? ORDER BY pattern').bind(repoId).all();
    expect(rules.results).toEqual([
      { pattern: 'refs/heads/main', required_checks: JSON.stringify(['lint', 'kvarm/guard', 'test', 'kvarm/checks-window']), required_approvals: 1 },
      { pattern: 'refs/heads/plain', required_checks: '["lint"]', required_approvals: 0 },
    ]);
    const retired = await env.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM check_runs WHERE name LIKE '${RETIRED}/%') + (SELECT COUNT(*) FROM ci_jobs WHERE name LIKE '${RETIRED}/%') +
              (SELECT COUNT(*) FROM branch_rules WHERE EXISTS (SELECT 1 FROM json_each(required_checks) AS je WHERE je.value LIKE '${RETIRED}/%')) AS n`,
    ).first<number>('n');
    expect(retired).toBe(0);
  });
});

describe('branded response surfaces', () => {
  it('meters responses with x-kvarm-cost and never the retired header', async () => {
    const res = await send('/healthz');
    expect(res.headers.get('x-kvarm-cost')).toMatch(/^d1=\d+;/);
    expect([...res.headers.keys()].filter((k) => k.startsWith(`x-${RETIRED}-`))).toEqual([]);
  });

  it('names Kvarm in the git and MCP authentication challenges and the MCP identity', async () => {
    expect((await gitRefs(tok.retired)).headers.get('www-authenticate')).toBe('Basic realm="kvarm", charset="UTF-8"');
    expect((await mcpInit(tok.retired)).headers.get('www-authenticate')).toBe('Bearer realm="kvarm"');
    const init = await mcpInit(tok.kvarm);
    const text = await init.text();
    const json = JSON.parse(text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? 'null'));
    expect(json.result.serverInfo).toEqual({ name: 'Kvarm', version: expect.any(String) });
    expect(json.result.instructions).toMatch(/^Kvarm tools\./);
  });
});
