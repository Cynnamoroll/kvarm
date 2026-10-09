import { env as cfEnv, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { pktLine, readPktLines, sha256Hex, ZERO_OID } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { gateReceivePack } from '../src/services/receivePackGate';

const env = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const ORG = 'agt-org';
const FULL: Scope[] = ['read', 'write', 'api'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

type Who = 'owner' | 'orgowner' | 'member' | 'outsider';
const logins: Record<Who, string> = {
  owner: 'agt-owner',
  orgowner: 'agt-orgowner',
  member: 'agt-member',
  outsider: 'agt-outsider',
};
const pat = {} as Record<Who, string>;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, init));
}

function bearer(token: string, init: RequestInit & { json?: unknown } = {}): RequestInit {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  const { json, ...rest } = init;
  return { ...rest, headers, body: json === undefined ? undefined : JSON.stringify(json) };
}

function as(who: Who, init: RequestInit & { json?: unknown } = {}): RequestInit {
  return bearer(pat[who], init);
}

async function status(path: string, init: RequestInit = {}): Promise<number> {
  const res = await call(path, init);
  await res.body?.cancel();
  return res.status;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function costOf(res: Response): Promise<CostCounters> {
  const parsed = parseCostHeader(res.headers.get(COST_HEADER));
  expect(parsed).not.toBeNull();
  if (!res.bodyUsed) await res.body?.cancel();
  return parsed!;
}

function basic(token: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`x:${token}`)}` };
}

async function gitStatus(token: string, repo: string, op: 'read' | 'write'): Promise<number> {
  const service = op === 'read' ? 'git-upload-pack' : 'git-receive-pack';
  // Authorization decides before any upstream work; an allowed request then
  // fails at the Artifacts token mint, which is unavailable hermetically.
  const res = await call(`/${repo}.git/info/refs?service=${service}`, { headers: basic(token) });
  await res.body?.cancel();
  return res.status;
}

function pushBody(cmds: string[], caps = 'report-status agent=git/2.47'): Uint8Array {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0${caps}\n` : `${c}\n`));
  parts.push(new TextEncoder().encode('0000PACK\0\0\0\x02\0\0\0\0'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function push(token: string, repo: string, body: Uint8Array): Promise<Response> {
  return call(`/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { ...basic(token), 'content-type': 'application/x-git-receive-pack-request' },
    body,
  });
}

/** report-status lines, unwrapping side-band channel 1 when present. */
async function reportStatus(res: Response): Promise<string[]> {
  const buf = new Uint8Array(await res.arrayBuffer());
  let pkts = readPktLines(buf).filter((p) => !p.flush);
  if (pkts.length > 0 && pkts.every((p) => p.data[0] === 1)) {
    const inner = pkts.map((p) => p.data.subarray(1));
    const joined = new Uint8Array(inner.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of inner) {
      joined.set(p, off);
      off += p.length;
    }
    pkts = readPktLines(joined).filter((p) => !p.flush);
  }
  return pkts.map((p) => new TextDecoder().decode(p.data).trim());
}

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(owner: string, name: string, visibility: 'public' | 'private'): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility,
       default_branch, created_at, owner_org_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'main', ?7, (SELECT id FROM orgs WHERE login = ?2))`,
  )
    .bind(
      crypto.randomUUID(),
      owner,
      name,
      `${owner}--${name}`,
      `https://artifacts.invalid/git/default/${owner}--${name}.git`,
      visibility,
      Date.now(),
    )
    .run();
}

async function createAgent(who: Who, body: Record<string, unknown>): Promise<Response> {
  return call('/api/v1/agents', as(who, { method: 'POST', json: body }));
}

async function agentId(who: Who, body: Record<string, unknown>): Promise<string> {
  const res = await createAgent(who, body);
  expect(res.status).toBe(201);
  return (await json<{ agent: { id: string } }>(res)).agent.id;
}

interface Minted {
  token: string;
  id: string;
  prefix: string;
  repo: string;
  role: string;
  refs: string[];
  expiresAt: string;
  status: string;
}

async function mint(who: Who, agent: string, body: Record<string, unknown>): Promise<Response> {
  return call(`/api/v1/agents/${agent}/tokens`, as(who, { method: 'POST', json: body }));
}

async function minted(who: Who, agent: string, body: Record<string, unknown>): Promise<Minted> {
  const res = await mint(who, agent, body);
  expect(res.status, JSON.stringify(body)).toBe(201);
  return json<Minted>(res);
}

const WS1 = 'refs/heads/agents/ws1/*';
let userAgent = '';
let orgAgent = '';
let writeTok: Minted;

beforeAll(async () => {
  for (const who of Object.keys(logins) as Who[]) {
    const id = await seedUser(logins[who]);
    pat[who] = (await mintPAT(env, id, 'full', FULL)).token;
  }
  expect(await status('/api/v1/orgs', as('orgowner', { method: 'POST', json: { login: ORG } }))).toBe(201);
  expect(
    await status(`/api/v1/orgs/${ORG}/members/${logins.member}`, as('orgowner', { method: 'PUT', json: { role: 'member' } })),
  ).toBe(200);
  await seedRepo(logins.owner, 'work', 'private');
  await seedRepo(logins.owner, 'other', 'private');
  await seedRepo(logins.owner, 'pub', 'public');
  await seedRepo(logins.orgowner, 'mine', 'private');
  await seedRepo(ORG, 'orgwork', 'private');
  await seedRepo(ORG, 'orgother', 'private');
  // Agent pushes below refs/heads/agents/<id>/ need a real, active workspace <id>.
  await env.DB.prepare(
    `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, created_at)
     SELECT 'ws1', r.id, r.artifacts_name, 'task', 'builder', 'active', 'refs/heads/agents/ws1/task', 'main', ?
       FROM repos r WHERE r.owner_login = ? AND r.name = 'work'`,
  )
    .bind(Date.now(), logins.owner)
    .run();
  userAgent = await agentId('owner', { name: 'builder', description: 'test agent' });
  orgAgent = await agentId('orgowner', { owner: ORG, name: 'ci' });
  writeTok = await minted('owner', userAgent, {
    repo: `${logins.owner}/work`,
    role: 'write',
    refs: [WS1],
    expiresIn: 600,
    name: 'ws1',
  });
});

describe('agent principals', () => {
  it('creates durable user- and org-owned agents', async () => {
    const res = await call(`/api/v1/agents/${userAgent}`, as('owner'));
    expect(await json(res)).toMatchObject({
      agent: { id: userAgent, owner: logins.owner, ownerKind: 'user', name: 'builder', status: 'active', createdBy: logins.owner },
    });
    const org = await json<{ agent: Record<string, unknown> }>(await call(`/api/v1/agents/${orgAgent}`, as('orgowner')));
    expect(org.agent).toMatchObject({ owner: ORG, ownerKind: 'org', name: 'ci' });
    const dup = await createAgent('owner', { name: 'builder' });
    expect(dup.status).toBe(409);
    expect(await json(dup)).toMatchObject({ code: 'NAME_TAKEN' });
    expect(await status('/api/v1/agents', as('owner', { method: 'POST', json: { name: 'Bad Name' } }))).toBe(400);
    expect(await status('/api/v1/agents', { method: 'POST', body: '{"name":"anon"}' })).toBe(401);
  });

  it('lets only the owning user or org owners manage agents', async () => {
    for (const who of ['member', 'outsider'] as const) {
      const res = await createAgent(who, { owner: ORG, name: `by-${who}` });
      expect(res.status, who).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'FORBIDDEN' });
    }
    expect((await createAgent('owner', { owner: logins.outsider, name: 'x' })).status).toBe(404);
    expect(await status(`/api/v1/agents/${userAgent}`, as('outsider'))).toBe(404);
    expect(await status(`/api/v1/agents/${orgAgent}`, as('member'))).toBe(404);
    expect(await status(`/api/v1/agents?owner=${ORG}`, as('member'))).toBe(403);
    const list = await json<{ agents: { name: string }[] }>(await call(`/api/v1/agents?owner=${ORG}`, as('orgowner')));
    expect(list.agents.map((a) => a.name)).toContain('ci');
    const mine = await json<{ agents: { name: string }[] }>(await call('/api/v1/agents', as('owner')));
    expect(mine.agents.map((a) => a.name)).toEqual(['builder']);
    expect(await status(`/api/v1/agents/${orgAgent}/tokens`, as('member'))).toBe(404);
    expect((await mint('member', orgAgent, { repo: `${ORG}/orgwork`, role: 'read' })).status).toBe(404);
  });
});

describe('agent tokens', () => {
  it('returns the secret once and stores only its hash', async () => {
    expect(writeTok.token).toMatch(/^forge_agt_[0-9a-f]{64}$/);
    expect(writeTok.prefix).toBe(writeTok.token.slice(0, 18));
    expect(writeTok).toMatchObject({ repo: `${logins.owner}/work`, role: 'write', refs: [WS1], status: 'active' });
    const row = await env.DB.prepare('SELECT hash FROM agent_tokens WHERE id = ?').bind(writeTok.id).first<{ hash: string }>();
    expect(row?.hash).toBe(await sha256Hex(writeTok.token));
    const list = await call(`/api/v1/agents/${userAgent}/tokens`, as('owner'));
    const text = await list.text();
    expect(text).not.toContain(writeTok.token);
    expect(text).not.toContain(row!.hash);
    const listed = (JSON.parse(text) as { tokens: Record<string, unknown>[] }).tokens.find((t) => t.id === writeTok.id);
    expect(listed).toMatchObject({ prefix: writeTok.prefix, role: 'write', refs: [WS1], status: 'active' });
    expect(listed).not.toHaveProperty('token');
    const { results } = await env.DB.prepare("SELECT payload FROM events WHERE type = 'agent.token.created'").all<{
      payload: string;
    }>();
    const audit = results.map((r) => r.payload).find((p) => p.includes(writeTok.id));
    expect(audit).toContain(writeTok.prefix);
    expect(audit).not.toContain(writeTok.token);
    expect(audit).not.toContain(row!.hash);
  });

  it('validates role, refs and expiry bounds', async () => {
    const repo = `${logins.owner}/work`;
    const cases: [Record<string, unknown>, string][] = [
      [{ repo, role: 'write' }, 'INVALID_REFS'],
      [{ repo, role: 'read', refs: [WS1] }, 'INVALID_REFS'],
      [{ repo, role: 'write', refs: ['refs/*'] }, 'INVALID_REFS'],
      [{ repo, role: 'write', refs: ['refs/heads/a*b'] }, 'INVALID_REFS'],
      [{ repo, role: 'admin' }, 'INVALID_ROLE'],
      [{ repo, role: 'read', expiresIn: 59 }, 'INVALID_EXPIRY'],
      [{ repo, role: 'read', expiresIn: 31 * 24 * 3600 }, 'INVALID_EXPIRY'],
      [{ repo: 'nope', role: 'read' }, 'INVALID_REPO'],
    ];
    for (const [body, code] of cases) {
      const res = await mint('owner', userAgent, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res)).toMatchObject({ code });
    }
  });

  it("never exceeds the minter's own access", async () => {
    const outsiderAgent = await agentId('outsider', { name: 'probe' });
    expect((await mint('outsider', outsiderAgent, { repo: `${logins.owner}/work`, role: 'read' })).status).toBe(404);

    const memberAgent = await agentId('member', { name: 'helper' });
    expect(
      await status(`/api/v1/repos/${ORG}/orgwork/grants/${logins.member}`, as('orgowner', { method: 'PUT', json: { role: 'read' } })),
    ).toBe(200);
    const write = await mint('member', memberAgent, { repo: `${ORG}/orgwork`, role: 'write', refs: ['refs/heads/x'] });
    expect(write.status).toBe(403);
    expect(await json(write)).toMatchObject({ code: 'FORBIDDEN' });
    expect((await mint('member', memberAgent, { repo: `${ORG}/orgwork`, role: 'read' })).status).toBe(201);
    expect((await mint('member', memberAgent, { repo: `${ORG}/orgother`, role: 'read' })).status).toBe(404);

    const outside = await mint('orgowner', orgAgent, { repo: `${logins.orgowner}/mine`, role: 'read' });
    expect(outside.status).toBe(422);
    expect(await json(outside)).toMatchObject({ code: 'REPO_OUTSIDE_ACCOUNT' });
    expect((await mint('orgowner', orgAgent, { repo: `${ORG}/orgwork`, role: 'read' })).status).toBe(201);
  });
});

describe('agent token scope', () => {
  it('reaches only its own repository', async () => {
    const t = writeTok.token;
    const own = await call(`/api/v1/repos/${logins.owner}/work`, bearer(t));
    expect(own.status).toBe(200);
    expect(await json(own)).toMatchObject({ repo: { name: 'work' } });
    const other = await call(`/api/v1/repos/${logins.owner}/other`, bearer(t));
    expect(other.status).toBe(404);
    expect(await json(other)).toEqual({ error: 'not found', code: 'NOT_FOUND' });
    expect(await status(`/api/v1/repos/${logins.owner}/pub`, bearer(t))).toBe(200);
    expect(await gitStatus(t, `${logins.owner}/work`, 'read')).not.toBe(404);
    expect(await gitStatus(t, `${logins.owner}/work`, 'write')).not.toBe(404);
    expect(await gitStatus(t, `${logins.owner}/other`, 'read')).toBe(404);
    expect(await gitStatus(t, `${logins.owner}/other`, 'write')).toBe(404);
    expect(await gitStatus(t, `${ORG}/orgwork`, 'read')).toBe(404);
    // Pages never accept agent credentials.
    expect(await status(`/${logins.owner}/work`, bearer(t))).toBe(404);
  });

  it('read tokens cannot push', async () => {
    const read = await minted('owner', userAgent, { repo: `${logins.owner}/work`, role: 'read' });
    expect(await gitStatus(read.token, `${logins.owner}/work`, 'write')).toBe(403);
    const res = await push(read.token, `${logins.owner}/work`, pushBody([`${A} ${B} refs/heads/agents/ws1/a`]));
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it('cannot manage credentials, grants, membership or accounts', async () => {
    const t = writeTok.token;
    const repo = `${logins.owner}/work`;
    const agentOnly: [string, RequestInit & { json?: unknown }][] = [
      ['/api/v1/agents', { method: 'POST', json: { name: 'child' } }],
      ['/api/v1/agents', {}],
      [`/api/v1/agents/${userAgent}`, {}],
      [`/api/v1/agents/${userAgent}/tokens`, { method: 'POST', json: { repo, role: 'read' } }],
      [`/api/v1/agents/${userAgent}/tokens`, {}],
      [`/api/v1/agents/${userAgent}/tokens/${writeTok.id}`, { method: 'DELETE' }],
      [`/api/v1/agents/${userAgent}`, { method: 'DELETE' }],
      ['/api/v1/user', {}],
      ['/api/v1/user/tokens', { method: 'POST', json: { scopes: ['read'] } }],
      [`/api/v1/user/tokens/x`, { method: 'DELETE' }],
      ['/api/v1/repos', { method: 'POST', json: { name: 'escape' } }],
      ['/api/v1/orgs', { method: 'POST', json: { login: 'agt-escape' } }],
      [`/api/v1/orgs/${ORG}/members/${logins.outsider}`, { method: 'PUT', json: { role: 'owner' } }],
      [`/api/v1/repos/${repo}/forks`, { method: 'POST', json: { name: 'escape' } }],
    ];
    for (const [path, init] of agentOnly) {
      const res = await call(path, bearer(t, init));
      expect(res.status, `${init.method ?? 'GET'} ${path}`).toBe(403);
      expect(await json(res)).toMatchObject({ code: 'AGENT_FORBIDDEN' });
    }
    const scoped: [string, RequestInit & { json?: unknown }][] = [
      [`/api/v1/repos/${repo}/grants/${logins.outsider}`, { method: 'PUT', json: { role: 'admin' } }],
      [`/api/v1/repos/${repo}/grants`, {}],
      [`/api/v1/repos/${repo}`, { method: 'PATCH', json: { visibility: 'public' } }],
      [`/api/v1/repos/${repo}`, { method: 'DELETE' }],
    ];
    for (const [path, init] of scoped) {
      expect(await status(path, bearer(t, init)), `${init.method ?? 'GET'} ${path}`).toBe(403);
    }
    // The org agent's token is equally unable to touch membership.
    const orgTok = await minted('orgowner', orgAgent, { repo: `${ORG}/orgwork`, role: 'write', refs: ['refs/heads/ci/*'] });
    expect(
      await status(`/api/v1/orgs/${ORG}/members/${logins.outsider}`, bearer(orgTok.token, { method: 'PUT', json: { role: 'member' } })),
    ).toBe(403);
    const grants = await json<{ grants: { login: string }[] }>(await call(`/api/v1/repos/${repo}/grants`, as('owner')));
    expect(grants.grants).toEqual([]);
    const members = await json<{ members: { login: string }[] }>(await call(`/api/v1/orgs/${ORG}/members`, as('orgowner')));
    expect(members.members.map((m) => m.login)).not.toContain(logins.outsider);
    const repoNow = await json<{ repo: { visibility: string } }>(await call(`/api/v1/repos/${repo}`, as('owner')));
    expect(repoNow.repo.visibility).toBe('private');
    const tokens = await json<{ tokens: unknown[] }>(await call(`/api/v1/agents/${userAgent}/tokens`, as('owner')));
    expect(tokens.tokens.length).toBe(2);
  });
});

describe('receive-pack gate for agent tokens', () => {
  const repo = `${logins.owner}/work`;

  it('denies base, sibling, create, delete and multi-ref escapes with report-status', async () => {
    const cases: [string[], string[]][] = [
      [[`${A} ${B} refs/heads/main`], ['ng refs/heads/main ref outside agent token grant']],
      [[`${A} ${B} refs/heads/agents/ws2/a`], ['ng refs/heads/agents/ws2/a ref outside agent token grant']],
      [[`${ZERO_OID} ${B} refs/heads/new-branch`], ['ng refs/heads/new-branch ref outside agent token grant']],
      [[`${A} ${ZERO_OID} refs/heads/main`], ['ng refs/heads/main ref outside agent token grant']],
      [[`${A} ${B} refs/tags/v1`], ['ng refs/tags/v1 ref outside agent token grant']],
      [[`${A} ${B} refs/heads/agents/ws1`], ['ng refs/heads/agents/ws1 ref outside agent token grant']],
      [
        [`${A} ${B} refs/heads/agents/ws1/a`, `${A} ${B} refs/heads/main`],
        [
          'ng refs/heads/agents/ws1/a push rejected: another ref in this push was denied',
          'ng refs/heads/main ref outside agent token grant',
        ],
      ],
    ];
    for (const [cmds, expected] of cases) {
      const res = await push(writeTok.token, repo, pushBody(cmds));
      expect(res.status, cmds.join()).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/x-git-receive-pack-result');
      expect(await reportStatus(res)).toEqual(['unpack ok', ...expected]);
    }
  });

  it('wraps denials in side-band when the client negotiated it', async () => {
    const res = await push(
      writeTok.token,
      repo,
      pushBody([`${A} ${B} refs/heads/main`], 'report-status side-band-64k quiet agent=git/2.47'),
    );
    expect(await reportStatus(res)).toEqual(['unpack ok', 'ng refs/heads/main ref outside agent token grant']);
  });

  it('passes granted ref updates (create, update, delete) through to storage', async () => {
    for (const cmd of [
      `${ZERO_OID} ${B} refs/heads/agents/ws1/new`,
      `${A} ${B} refs/heads/agents/ws1/a`,
      `${A} ${ZERO_OID} refs/heads/agents/ws1/old`,
    ]) {
      const res = await push(writeTok.token, repo, pushBody([cmd]));
      // Past the gate the upstream token mint fails hermetically (no Artifacts).
      expect(res.status, cmd).toBe(503);
      await res.body?.cancel();
    }
  });

  it('leaves human pushes ungated', async () => {
    const res = await push(pat.owner, repo, pushBody([`${A} ${B} refs/heads/main`]));
    expect(res.status).toBe(503);
    await res.body?.cancel();
  });

  it('rejects malformed, oversized and non-POST requests', async () => {
    const bad = await push(writeTok.token, repo, new TextEncoder().encode('zzzz'));
    expect(bad.status).toBe(400);
    await bad.body?.cancel();
    const huge = pushBody(Array.from({ length: 300 }, (_, i) => `${A} ${B} refs/heads/agents/ws1/b${i}`));
    const big = await push(writeTok.token, repo, huge);
    expect(big.status).toBe(413);
    await big.body?.cancel();
    expect(
      await status(`/${repo}.git/git-receive-pack`, { method: 'GET', headers: basic(writeTok.token) }),
    ).toBe(405);
    expect(
      await status(`/${repo}.git/info/refs?service=git-receive-pack`, {
        method: 'POST',
        headers: basic(writeTok.token),
        body: 'x',
      }),
    ).toBe(405);
  });

  it('forwards the exact original body when every ref is allowed', async () => {
    const body = pushBody([`${A} ${B} refs/heads/agents/ws1/a`]);
    const gated = await gateReceivePack(
      new Request(`${ORIGIN}/x`, { method: 'POST', body, headers: { 'content-length': String(body.length) } }),
      () => null,
    );
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect(new Uint8Array(await new Response(gated.body).arrayBuffer())).toEqual(body);
    expect(gated.commands).toEqual([{ oldOid: A, newOid: B, ref: 'refs/heads/agents/ws1/a' }]);
  });
});

describe('expiry and revocation', () => {
  const repo = `${logins.owner}/work`;

  it('rejects an expired token on REST and git', async () => {
    const t = await minted('owner', userAgent, { repo, role: 'write', refs: [WS1], expiresIn: 60 });
    expect(await status(`/api/v1/repos/${repo}`, bearer(t.token))).toBe(200);
    await env.DB.prepare('UPDATE agent_tokens SET expires_at = ? WHERE id = ?').bind(Date.now() - 1, t.id).run();
    const res = await call(`/api/v1/repos/${repo}`, bearer(t.token));
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'unauthorized' });
    expect(await gitStatus(t.token, repo, 'read')).toBe(401);
    const denied = await push(t.token, repo, pushBody([`${A} ${B} refs/heads/agents/ws1/a`]));
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
    const list = await json<{ tokens: { id: string; status: string }[] }>(
      await call(`/api/v1/agents/${userAgent}/tokens`, as('owner')),
    );
    expect(list.tokens.find((x) => x.id === t.id)?.status).toBe('expired');
  });

  it('denies a warmed token on the next request after revocation', async () => {
    const t = await minted('owner', userAgent, { repo, role: 'write', refs: [WS1], expiresIn: 600 });
    expect(await status(`/api/v1/repos/${repo}`, bearer(t.token))).toBe(200);
    const warm = await call(`/api/v1/repos/${repo}`, bearer(t.token));
    expect(warm.status).toBe(200);
    const cost = await costOf(warm);
    expect(cost).toMatchObject({ d1: 1, do: 0, art: 0 });
    expect(cost.rr).toBeLessThanOrEqual(8);
    expect(await gitStatus(t.token, repo, 'read')).toBe(503);

    const revoke = await call(`/api/v1/agents/${userAgent}/tokens/${t.id}`, as('owner', { method: 'DELETE' }));
    expect(await json(revoke)).toMatchObject({ revoked: true, token: { id: t.id, status: 'revoked' } });
    const denied = await call(`/api/v1/repos/${repo}`, bearer(t.token));
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain('work');
    expect(await gitStatus(t.token, repo, 'read')).toBe(401);
    const pushed = await push(t.token, repo, pushBody([`${A} ${B} refs/heads/agents/ws1/a`]));
    expect(pushed.status).toBe(401);
    await pushed.body?.cancel();
    const again = await call(`/api/v1/agents/${userAgent}/tokens/${t.id}`, as('owner', { method: 'DELETE' }));
    expect(await json(again)).toMatchObject({ revoked: false });
  });

  it('revoking an agent kills all of its tokens and blocks new ones', async () => {
    const id = await agentId('owner', { name: 'doomed' });
    const t = await minted('owner', id, { repo, role: 'read' });
    expect(await status(`/api/v1/repos/${repo}`, bearer(t.token))).toBe(200);
    const res = await call(`/api/v1/agents/${id}`, as('owner', { method: 'DELETE' }));
    expect(await json(res)).toMatchObject({ agent: { id, status: 'revoked' } });
    expect(await status(`/api/v1/repos/${repo}`, bearer(t.token))).toBe(401);
    expect(await gitStatus(t.token, repo, 'read')).toBe(401);
    const again = await mint('owner', id, { repo, role: 'read' });
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ code: 'AGENT_REVOKED' });
    const kept = await json<{ agent: { status: string } }>(await call(`/api/v1/agents/${id}`, as('owner')));
    expect(kept.agent.status).toBe('revoked');
  });

  it("follows the minter's grant: revoking it denies the token", async () => {
    const id = await agentId('member', { name: 'grant-bound' });
    const t = await minted('member', id, { repo: `${ORG}/orgwork`, role: 'read' });
    expect(await status(`/api/v1/repos/${ORG}/orgwork`, bearer(t.token))).toBe(200);
    expect(await status(`/api/v1/repos/${ORG}/orgwork/grants/${logins.member}`, as('orgowner', { method: 'DELETE' }))).toBe(200);
    expect(await status(`/api/v1/repos/${ORG}/orgwork`, bearer(t.token))).toBe(404);
    expect(await gitStatus(t.token, `${ORG}/orgwork`, 'read')).toBe(404);
  });

  it('keeps human PATs working alongside agent tokens', async () => {
    const me = await json<{ user: { login: string } }>(await call('/api/v1/user', as('owner')));
    expect(me.user.login).toBe(logins.owner);
    expect(await gitStatus(pat.owner, repo, 'write')).toBe(503);
  });
});
