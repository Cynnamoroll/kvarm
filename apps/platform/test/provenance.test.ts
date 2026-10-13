/**
 * Provenance evidence levels (services/provenance.ts) and the audit export
 * (services/audit.ts) through the Worker's routes over the in-memory
 * Artifacts fake: levels are computed server-side from the credential and
 * signed execution evidence, spoofed records stay declared, and the export
 * joins attribution, gate pushes and merges per commit under a bounded cost.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KVARM_NOTES_REF, buildNotesCommit, decode, encode, parseTree, pktLine } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { canonicalPayload, keyFingerprint, legacyCanonicalPayload } from '../src/services/provenance';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'pv-owner';
const HASH = 'b'.repeat(64);

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', writer: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  for (const [login, role] of [['pv-writer', 'write'], ['pv-reader', 'read']] as const) {
    await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, userIds[login], role, userIds[OWNER], Date.now(), Date.now())
      .run();
  }
  return repo;
}

interface Reply {
  status: number;
  json: Record<string, any>;
  text: string;
  headers: Headers;
  cost: CostCounters;
}

async function call(method: string, path: string, token?: string, body?: unknown, e: Env = env): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, e, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // ndjson or plain text
  }
  return { status: res.status, json, text, headers: res.headers, cost: cost! };
}

const repoPath = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const setAttr = (repo: string, sha: string, body: unknown, token: string, e?: Env) => call('POST', repoPath(repo, `/commits/${sha}/attribution`), token, body, e);
const getAttr = (repo: string, sha: string, token = tok.owner) => call('GET', repoPath(repo, `/commits/${sha}/attribution`), token);
const audit = (repo: string, q = '', token: string | undefined = tok.owner) => call('GET', repoPath(repo, `/audit${q ? `?${q}` : ''}`), token);

async function mintAgent(repo: string, name: string, modelFamily?: string): Promise<{ id: string; token: string }> {
  const agent = await call('POST', '/api/v1/agents', tok.owner, { name, ...(modelFamily ? { modelFamily } : {}) });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, { repo: `${OWNER}/${repo}`, role: 'write', refs: ['refs/heads/*'] });
  expect(minted.status).toBe(201);
  return { id: agent.json.agent.id as string, token: minted.json.token as string };
}

async function keyPair(): Promise<{ publicKey: string; id: string; sign(payload: string): Promise<string> }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    publicKey: b64url(raw),
    id: await keyFingerprint(raw),
    async sign(payload: string) {
      return b64url(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(payload))));
    },
  };
}

function pushBody(cmds: string[]): Uint8Array {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0report-status agent=git/2.47\n` : `${c}\n`));
  parts.push(encode('0000'));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** A push through the git gate (Basic auth) that moves `ref` from `oldSha` to `newSha` in the fake remote. */
async function gatePush(repo: string, token: string, ref: string, oldSha: string, newSha: string): Promise<string> {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: pushBody([`${oldSha} ${newSha} ${ref}`]),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  expect(res.status, text).toBe(200);
  return text;
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.writer = (await mintPAT(env, await seedUser('pv-writer'), 'writer', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('pv-reader'), 'reader', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('pv-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

const ZERO = '0'.repeat(40);

// ---------------------------------------------------------------------------

describe('attribution evidence levels', () => {
  it('is authenticated when an agent token writes its own agent name, with principal and token prefix only', async () => {
    const repo = await seedRepo('lvl-auth');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-auth', 'lvl-agent-a', 'claude');
    const r = await setAttr('lvl-auth', c1.sha, { agent: 'lvl-agent-a', session: 's1', promptHash: HASH, model: 'm-1' }, a.token);
    expect(r.status).toBe(201);
    expect(r.json.evidence).toEqual({
      level: 'authenticated',
      reasons: ['no-signed-evidence'],
      principal: `agent:${a.id}`,
      tokenKind: 'agent',
      tokenPrefix: a.token.slice(0, 18),
      runId: null,
      keyId: null,
    });
    expect(r.text).not.toContain(a.token);
    const g = await getAttr('lvl-auth', c1.sha);
    expect(g.json).toMatchObject({ agent: 'lvl-agent-a', session: 's1', promptHash: HASH, model: 'm-1', evidence: r.json.evidence });
    // The note itself stays the asserted record; evidence lives in D1.
    expect(g.text).not.toContain(a.token);
  });

  it('keeps spoofed records declared: agent A naming agent B, a human writing agent metadata', async () => {
    const repo = await seedRepo('lvl-spoof');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const c2 = await commit(repo, { 'b.txt': 'b\n' }, [c1.sha]);
    const c3 = await commit(repo, { 'c.txt': 'c\n' }, [c2.sha]);
    const a = await mintAgent('lvl-spoof', 'spoof-agent-a');
    const b = await mintAgent('lvl-spoof', 'spoof-agent-b');
    const aAsB = await setAttr('lvl-spoof', c1.sha, { agent: 'spoof-agent-b', session: 's', promptHash: HASH }, a.token);
    expect(aAsB.json.evidence).toMatchObject({ level: 'declared', principal: `agent:${a.id}`, tokenKind: 'agent' });
    expect(aAsB.json.evidence.reasons).toContain('agent-not-submitter');
    expect(aAsB.json.evidence.principal).not.toBe(`agent:${b.id}`);

    const human = await setAttr('lvl-spoof', c2.sha, { agent: 'spoof-agent-a', session: 's', promptHash: HASH, model: 'gpt-x' }, tok.writer);
    expect(human.json.evidence).toMatchObject({ level: 'declared', principal: `user:${userIds['pv-writer']}`, tokenKind: 'pat' });
    expect(human.json.evidence.reasons).toContain('human-submitted-agent-metadata');
    expect(human.json.evidence.tokenPrefix).toBe(tok.writer.slice(0, human.json.evidence.tokenPrefix.length));
    expect(tok.writer.length).toBeGreaterThan(human.json.evidence.tokenPrefix.length);

    // A human naming themself is authenticated; a caller cannot set the level.
    const self = await setAttr('lvl-spoof', c3.sha, { agent: 'pv-writer', session: 's', promptHash: HASH, level: 'verified', reasons: [] }, tok.writer);
    expect(self.status).toBe(201);
    expect(self.json.evidence).toMatchObject({ level: 'authenticated', principal: `user:${userIds['pv-writer']}` });
    const forged = await setAttr('lvl-spoof', c3.sha, { agent: 'pv-writer', session: 's', promptHash: HASH, evidence: { level: 'verified' } }, tok.writer);
    expect([forged.status, forged.json.code]).toEqual([422, 'INVALID_EVIDENCE']);
    expect((await getAttr('lvl-spoof', c3.sha)).json.evidence.level).toBe('authenticated');
  });

  it('is verified only for a valid signature by a trusted key over exactly the stored run, model, input and commit', async () => {
    const repo = await seedRepo('lvl-ver');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const c2 = await commit(repo, { 'b.txt': 'b\n' }, [c1.sha]);
    const a = await mintAgent('lvl-ver', 'ver-agent-a', 'claude');
    const b = await mintAgent('lvl-ver', 'ver-agent-b', 'gpt');
    const key = await keyPair();
    const stranger = await keyPair();
    // Only repo admins manage keys.
    expect((await call('POST', repoPath('lvl-ver', '/provenance-keys'), tok.writer, { name: 'svc', publicKey: key.publicKey })).status).toBe(403);
    expect((await call('POST', repoPath('lvl-ver', '/provenance-keys'), a.token, { name: 'svc', publicKey: key.publicKey })).status).toBe(403);
    const added = await call('POST', repoPath('lvl-ver', '/provenance-keys'), tok.owner, { name: 'svc', publicKey: key.publicKey });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ id: key.id, name: 'svc', scope: 'repository', revokedAt: null });
    expect((await call('POST', repoPath('lvl-ver', '/provenance-keys'), tok.owner, { name: 'bad', publicKey: 'not-a-key' })).json.code).toBe('INVALID_PUBLIC_KEY');

    const fields = { agent: 'ver-agent-a', session: 'run-7', promptHash: HASH, model: 'claude-x' };
    const signature = await key.sign(canonicalPayload({ repoId: repoIds['lvl-ver']!, principal: `agent:${a.id}`, runId: 'run-7', model: 'claude-x', promptHash: HASH, commit: c1.sha }));
    const ok = await setAttr('lvl-ver', c1.sha, { ...fields, evidence: { keyId: key.id, runId: 'run-7', signature } }, a.token);
    expect(ok.status).toBe(201);
    expect(ok.json.evidence).toMatchObject({ level: 'verified', reasons: [], runId: 'run-7', keyId: key.id, principal: `agent:${a.id}` });
    expect((await getAttr('lvl-ver', c1.sha)).json.evidence).toEqual(ok.json.evidence);

    const cases: Array<[string, Record<string, unknown>, string, 'authenticated' | 'declared']> = [];
    const flipped = signature.startsWith('A') ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    cases.push(['tampered signature', { ...fields, evidence: { keyId: key.id, runId: 'run-7', signature: flipped } }, 'bad-signature', 'authenticated']);
    cases.push(['tampered model', { ...fields, model: 'claude-y', evidence: { keyId: key.id, runId: 'run-7', signature } }, 'bad-signature', 'authenticated']);
    cases.push(['other commit', { ...fields, evidence: { keyId: key.id, runId: 'run-7', signature } }, 'bad-signature', 'authenticated']);
    cases.push(['unknown key', { ...fields, evidence: { keyId: stranger.id, runId: 'run-7', signature: await stranger.sign(canonicalPayload({ repoId: repoIds['lvl-ver']!, principal: `agent:${a.id}`, runId: 'run-7', model: 'claude-x', promptHash: HASH, commit: c2.sha })) } }, 'unknown-key', 'authenticated']);
    cases.push(['no model', { agent: 'ver-agent-a', session: 's', promptHash: HASH, evidence: { keyId: key.id, runId: 'run-7', signature } }, 'evidence-without-model', 'authenticated']);
    // A newline in a signed field would shift the payload's lines, so such a record is never verified.
    const forgedLines = await key.sign(canonicalPayload({ repoId: repoIds['lvl-ver']!, principal: `agent:${a.id}`, runId: 'run-7', model: 'claude-x\ninput:x', promptHash: HASH, commit: c2.sha }));
    cases.push(['line in model', { ...fields, model: 'claude-x\ninput:x', evidence: { keyId: key.id, runId: 'run-7', signature: forgedLines } }, 'unsignable-field', 'authenticated']);
    for (const [label, body, reason, level] of cases) {
      const target = label === 'other commit' || label === 'unknown key' || label === 'no model' || label === 'line in model' ? c2.sha : c1.sha;
      const r = await setAttr('lvl-ver', target, body, a.token);
      expect(r.status, label).toBeLessThan(300);
      expect(r.json.evidence.level, label).toBe(level);
      expect(r.json.evidence.reasons, label).toContain(reason);
      expect(r.json.evidence.runId, label).toBeNull();
    }

    // A valid signature does not lift a record its submitter cannot claim: agent B naming agent A.
    const replay = await setAttr('lvl-ver', c1.sha, { ...fields, evidence: { keyId: key.id, runId: 'run-7', signature } }, b.token);
    expect(replay.json.evidence).toMatchObject({ level: 'declared', principal: `agent:${b.id}` });
    expect(replay.json.evidence.reasons).toContain('agent-not-submitter');
    expect(replay.json.evidence.reasons).not.toContain('legacy-payload');

    // A revoked key verifies nothing new.
    expect((await call('DELETE', repoPath('lvl-ver', `/provenance-keys/${key.id}`), tok.owner)).json.revokedAt).not.toBeNull();
    const revoked = await setAttr('lvl-ver', c1.sha, { ...fields, evidence: { keyId: key.id, runId: 'run-7', signature } }, a.token);
    expect(revoked.json.evidence).toMatchObject({ level: 'authenticated', reasons: ['unknown-key'] });
  });

  it('binds a signature to the submitting agent and the repository, and never verifies the legacy payload', async () => {
    const repo = await seedRepo('lvl-bind');
    await seedRepo('lvl-bind-other');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-bind', 'bind-agent-a', 'claude');
    const b = await mintAgent('lvl-bind', 'bind-agent-b', 'gpt');
    const key = await keyPair();
    expect((await call('POST', repoPath('lvl-bind', '/provenance-keys'), tok.owner, { name: 'svc', publicKey: key.publicKey })).status).toBe(201);
    const fields = { session: 'run-9', promptHash: HASH, model: 'claude-x' };
    const bind = (repoId: string, principal: string) =>
      key.sign(canonicalPayload({ repoId, principal, runId: 'run-9', model: 'claude-x', promptHash: HASH, commit: c1.sha }));
    const sigA = await bind(repoIds['lvl-bind']!, `agent:${a.id}`);

    // The submitter's own signature over its own principal and repository verifies.
    const own = await setAttr('lvl-bind', c1.sha, { agent: 'bind-agent-a', ...fields, evidence: { keyId: key.id, runId: 'run-9', signature: sigA } }, a.token);
    expect(own.json.evidence).toMatchObject({ level: 'verified', principal: `agent:${a.id}`, runId: 'run-9', keyId: key.id });

    // Agent B replaying A's signature under its own name does not verify: the payload names A's principal.
    const replayed = await setAttr('lvl-bind', c1.sha, { agent: 'bind-agent-b', ...fields, evidence: { keyId: key.id, runId: 'run-9', signature: sigA } }, b.token);
    expect(replayed.json.evidence.level).toBe('authenticated');
    expect(replayed.json.evidence.reasons).toContain('bad-signature');
    expect(replayed.json.evidence.principal).toBe(`agent:${b.id}`);
    expect(replayed.json.evidence.runId).toBeNull();

    // The same signature, but bound to another repository, does not verify here.
    const cross = await setAttr('lvl-bind', c1.sha, { agent: 'bind-agent-a', ...fields, evidence: { keyId: key.id, runId: 'run-9', signature: await bind(repoIds['lvl-bind-other']!, `agent:${a.id}`) } }, a.token);
    expect(cross.json.evidence.level).toBe('authenticated');
    expect(cross.json.evidence.reasons).toContain('bad-signature');
    expect(cross.json.evidence.runId).toBeNull();

    // A signature over the retired payload reads as legacy, never verified.
    const legacySig = await key.sign(legacyCanonicalPayload({ runId: 'run-9', model: 'claude-x', promptHash: HASH, commit: c1.sha }));
    const legacy = await setAttr('lvl-bind', c1.sha, { agent: 'bind-agent-a', ...fields, evidence: { keyId: key.id, runId: 'run-9', signature: legacySig } }, a.token);
    expect(legacy.json.evidence.level).toBe('authenticated');
    expect(legacy.json.evidence.reasons).toContain('legacy-payload');
    expect(legacy.json.evidence.runId).toBeNull();
  });

  it('shows the submitting principal id and token prefix only to repo admins', async () => {
    const repo = await seedRepo('lvl-redact', 'public');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-redact', 'redact-agent', 'claude');
    await setAttr('lvl-redact', c1.sha, { agent: 'redact-agent', session: 's1', promptHash: HASH, model: 'm' }, a.token);

    // Anonymous visitor on a public repo: the note and its level, no principal id or token prefix.
    const anon = await call('GET', repoPath('lvl-redact', `/commits/${c1.sha}/attribution`));
    expect(anon.status).toBe(200);
    expect(anon.json).toMatchObject({ agent: 'redact-agent', evidence: { level: 'authenticated', principal: null, tokenPrefix: null } });
    expect(anon.text).not.toContain(a.token.slice(0, 18));

    // A plain reader sees the same redaction.
    const reader = await getAttr('lvl-redact', c1.sha, tok.reader);
    expect(reader.json.evidence).toMatchObject({ level: 'authenticated', principal: null, tokenPrefix: null });
    expect(reader.text).not.toContain(`agent:${a.id}`);

    // The repo admin sees them.
    const admin = await getAttr('lvl-redact', c1.sha, tok.owner);
    expect(admin.json.evidence).toMatchObject({ principal: `agent:${a.id}`, tokenPrefix: a.token.slice(0, 18) });
  });

  it('reads the evidence of the note the ref holds when concurrent writers stored theirs out of order', async () => {
    const repo = await seedRepo('lvl-race');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-race', 'race-agent-a');
    const b = await mintAgent('lvl-race', 'race-agent-b');
    await setAttr('lvl-race', c1.sha, { agent: 'race-agent-a', session: 's', promptHash: HASH }, a.token);
    const second = await setAttr('lvl-race', c1.sha, { agent: 'race-agent-a', session: 's', promptHash: HASH }, b.token);
    expect(second.json.evidence).toMatchObject({ level: 'declared', principal: `agent:${b.id}` });
    // The first writer's evidence row lands last (its D1 write raced behind the second note).
    await env.DB.prepare('UPDATE attribution_evidence SET recorded_at = recorded_at + 60000 WHERE repo_id = ?1 AND principal = ?2')
      .bind(repoIds['lvl-race'], `agent:${a.id}`)
      .run();
    expect((await getAttr('lvl-race', c1.sha)).json.evidence).toMatchObject({ level: 'declared', principal: `agent:${b.id}` });
  });

  it('caps live repository keys but lets an admin rename a live key at the cap, and lists live keys first', async () => {
    await seedRepo('lvl-cap');
    const keys = [];
    for (let i = 0; i < 33; i++) keys.push(await keyPair());
    for (const k of keys.slice(0, 32)) expect((await call('POST', repoPath('lvl-cap', '/provenance-keys'), tok.owner, { name: 'k', publicKey: k.publicKey })).status).toBe(201);
    const over = await call('POST', repoPath('lvl-cap', '/provenance-keys'), tok.owner, { name: 'k', publicKey: keys[32]!.publicKey });
    expect([over.status, over.json.code]).toEqual([409, 'TOO_MANY_KEYS']);
    const renamed = await call('POST', repoPath('lvl-cap', '/provenance-keys'), tok.owner, { name: 'renamed', publicKey: keys[0]!.publicKey });
    expect([renamed.status, renamed.json.name]).toEqual([201, 'renamed']);
    expect((await call('DELETE', repoPath('lvl-cap', `/provenance-keys/${keys[1]!.id}`), tok.owner)).status).toBe(200);
    expect((await call('POST', repoPath('lvl-cap', '/provenance-keys'), tok.owner, { name: 'k', publicKey: keys[32]!.publicKey })).status).toBe(201);
    const list = await call('GET', repoPath('lvl-cap', '/provenance-keys'), tok.owner);
    const live = (list.json.keys as Array<Record<string, any>>).filter((k) => k.revokedAt === null);
    expect(live).toHaveLength(32);
    expect(list.json.keys[list.json.keys.length - 1]).toMatchObject({ id: keys[1]!.id });
    expect(list.json.keys[list.json.keys.length - 1].revokedAt).not.toBeNull();
  });

  it('accepts instance keys from KVARM_PROVENANCE_KEYS', async () => {
    const repo = await seedRepo('lvl-inst');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-inst', 'inst-agent');
    const key = await keyPair();
    const instEnv = { ...env, KVARM_PROVENANCE_KEYS: `  ${key.publicKey}, ` } as Env;
    const signature = await key.sign(canonicalPayload({ repoId: repoIds['lvl-inst']!, principal: `agent:${a.id}`, runId: 'r', model: 'm', promptHash: HASH, commit: c1.sha }));
    const body = { agent: 'inst-agent', session: 's', promptHash: HASH, model: 'm', evidence: { keyId: key.id, runId: 'r', signature } };
    expect((await setAttr('lvl-inst', c1.sha, body, a.token)).json.evidence.reasons).toContain('unknown-key');
    const r = await setAttr('lvl-inst', c1.sha, body, a.token, instEnv);
    expect(r.json.evidence).toMatchObject({ level: 'verified', keyId: key.id });
    const keys = await call('GET', repoPath('lvl-inst', '/provenance-keys'), tok.owner, undefined, instEnv);
    expect(keys.json.keys).toEqual([{ id: key.id, name: 'instance', publicKey: key.publicKey, scope: 'instance', createdAt: null, revokedAt: null }]);
  });

  it('reads a note pushed around Kvarm as declared', async () => {
    const repo = await seedRepo('lvl-outside');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const a = await mintAgent('lvl-outside', 'outside-agent');
    await setAttr('lvl-outside', c1.sha, { agent: 'outside-agent', session: 's', promptHash: HASH }, a.token);
    expect((await getAttr('lvl-outside', c1.sha)).json.evidence.level).toBe('authenticated');
    // Someone rewrites the note by pushing the notes ref directly.
    const tip = repo.refs.get(KVARM_NOTES_REF)!;
    const tipTree = /^tree ([0-9a-f]{40})$/m.exec(decode(repo.objects.get(tip)!.content))![1]!;
    const reader = { readTree: async (h: string) => (repo.objects.get(h)?.type === 'tree' ? parseTree(repo.objects.get(h)!.content) : null) };
    const forged = await buildNotesCommit({
      reader,
      parent: { commit: tip, tree: tipTree },
      target: c1.sha,
      content: encode(`${JSON.stringify({ agent: 'outside-agent', session: 's', promptHash: HASH, model: 'forged', actor: OWNER, at: new Date().toISOString() })}\n`),
      author: { name: 'x', email: 'x@kvarm.invalid', time: 0, tz: '+0000' },
    });
    for (const o of forged.objects) repo.objects.set(o.hash, { type: o.type as 'blob' | 'tree' | 'commit', content: o.raw.subarray(o.raw.indexOf(0) + 1) });
    repo.refs.set(KVARM_NOTES_REF, forged.commit);
    const g = await getAttr('lvl-outside', c1.sha);
    expect(g.json).toMatchObject({ model: 'forged', evidence: { level: 'declared', reasons: ['note-without-evidence'], principal: null, tokenPrefix: null } });
  });
});

describe('review model families carry their evidence level', () => {
  it('labels agent model families and the cross-model preference as declared', async () => {
    const repo = await seedRepo('fam');
    const root = await commit(repo, { 'README.md': 'r\n' });
    const feature = await commit(repo, { 'README.md': 'r\n', 'f.txt': 'f\n' }, [root.sha]);
    repo.refs.set('refs/heads/main', root.sha);
    repo.refs.set('refs/heads/feature', feature.sha);
    const author = await mintAgent('fam', 'fam-author', 'claude');
    await mintAgent('fam', 'fam-reviewer', 'gpt');
    expect((await call('POST', repoPath('fam', '/changes'), author.token, { title: 'f', base: 'main', head: 'feature' })).status).toBe(201);
    const assigned = await call('POST', repoPath('fam', '/changes/1/reviewers/assign'), tok.owner, {});
    expect(assigned.status).toBe(200);
    expect(assigned.json.author).toMatchObject({ modelFamily: 'claude', modelFamilyEvidence: 'declared' });
    expect(assigned.json.assigned).toMatchObject({ modelFamily: 'gpt', modelFamilyEvidence: 'declared', differentFamily: true, differentFamilyEvidence: 'declared' });
    expect(assigned.json.preference).toMatchObject({ met: true, evidence: 'declared' });
    const human = await call('POST', repoPath('fam', '/changes/1/reviews'), tok.writer, { verdict: 'approve', headSha: feature.sha });
    expect(human.status).toBeLessThan(300);
    expect(human.json.review).toMatchObject({ modelFamily: 'human', modelFamilyEvidence: 'authenticated', differentFamily: true, differentFamilyEvidence: 'declared' });
  });
});

// ---------------------------------------------------------------------------

describe('audit export', () => {
  it('requires admin access: anonymous 401, no grant 404, read and write 403, agents 403', async () => {
    await seedRepo('aud-authz');
    await seedRepo('aud-authz-pub', 'public');
    const a = await mintAgent('aud-authz', 'authz-agent');
    expect((await call('GET', repoPath('aud-authz', '/audit'))).status).toBe(401);
    expect((await call('GET', repoPath('aud-authz-pub', '/audit'))).status).toBe(401);
    expect((await audit('aud-authz', '', tok.outsider)).status).toBe(404);
    expect((await audit('aud-nope', '', tok.outsider)).status).toBe(404);
    expect((await audit('aud-authz', '', tok.reader)).status).toBe(403);
    expect((await audit('aud-authz', '', tok.writer)).status).toBe(403);
    expect((await audit('aud-authz', '', a.token)).status).toBe(403);
    expect((await audit('aud-authz', '', tok.owner)).status).toBe(200);
    expect((await audit('aud-authz', 'format=csv')).json.code).toBe('INVALID_FORMAT');
    expect((await audit('aud-authz', 'since=yesterday')).json.code).toBe('INVALID_TIME');
    expect((await audit('aud-authz', 'cursor=bogus')).json.code).toBe('INVALID_CURSOR');
    expect((await audit('aud-authz', 'limit=0')).json.code).toBe('INVALID_LIMIT');
  });

  it('matches the attribution notes of a seeded run, joins pushes and merges, never exposes a token, and pages at bounded cost', async () => {
    const repo = await seedRepo('aud-run');
    const root = await commit(repo, { 'README.md': 'readme\n' });
    repo.refs.set('refs/heads/main', root.sha);
    const a = await mintAgent('aud-run', 'run-agent-a', 'claude');
    const b = await mintAgent('aud-run', 'run-agent-b', 'gpt');

    // Agent A pushes a branch through the git gate, attributes its commits, one of them as agent B (a spoof).
    const c1 = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'a\n' }, [root.sha]);
    const c2 = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'a2\n' }, [c1.sha]);
    await gatePush('aud-run', a.token, 'refs/heads/feature', ZERO, c2.sha);
    expect(repo.refs.get('refs/heads/feature')).toBe(c2.sha);
    expect((await setAttr('aud-run', c1.sha, { agent: 'run-agent-a', session: 'sess-1', promptHash: HASH, model: 'claude-x' }, a.token)).status).toBe(201);
    expect((await setAttr('aud-run', c2.sha, { agent: 'run-agent-b', session: 'sess-1', promptHash: HASH, model: 'gpt-y' }, a.token)).status).toBe(201);
    // Agent B pushes another branch; the owner attributes one commit to itself.
    const c3 = await commit(repo, { 'README.md': 'readme\n', 'b.txt': 'b\n' }, [root.sha]);
    await gatePush('aud-run', b.token, 'refs/heads/other', ZERO, c3.sha);
    expect((await setAttr('aud-run', c3.sha, { agent: OWNER, session: 'manual', promptHash: HASH }, tok.owner)).status).toBe(201);
    // The owner merges feature: a fast-forward of c2 onto main.
    expect((await call('POST', repoPath('aud-run', '/changes'), tok.owner, { title: 'f', base: 'main', head: 'feature' })).status).toBe(201);
    const merged = await call('POST', repoPath('aud-run', '/changes/1/merge'), tok.owner);
    expect([merged.status, merged.json.merge.kind]).toEqual([200, 'fast-forward']);
    // Then other (diverged): a two-parent merge commit Kvarm creates and attributes.
    expect((await call('POST', repoPath('aud-run', '/changes'), b.token, { title: 'o', base: 'main', head: 'other' })).status).toBe(201);
    const merged2 = await call('POST', repoPath('aud-run', '/changes/2/merge'), b.token);
    expect([merged2.status, merged2.json.merge.kind]).toEqual([200, 'merge']);
    const mergeCommit = merged2.json.mergeCommit as string;

    // Page through with a small page size; every page costs at most 3 D1 round trips including the authority lookup.
    const records: Array<Record<string, any>> = [];
    const pages: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: Reply = await audit('aud-run', `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.cost.d1).toBeLessThanOrEqual(3);
      expect(page.cost.d1).toBe(2);
      expect(page.cost.do).toBe(0);
      expect(page.cost.art).toBe(0);
      expect(page.json.records.length).toBeLessThanOrEqual(2);
      pages.push(page.text);
      records.push(...page.json.records);
      cursor = page.json.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    const shas = records.map((r) => r.commit);
    expect(new Set(shas).size).toBe(shas.length);
    expect(new Set(shas)).toEqual(new Set([c1.sha, c2.sha, c3.sha, mergeCommit]));
    const firstSeen = records.map((r) => r.firstSeenAt as string);
    expect(firstSeen).toEqual([...firstSeen].sort());

    // One full page equals the concatenated pages (stable order).
    const full = await audit('aud-run', 'limit=200');
    expect(full.json.records).toEqual(records);
    expect(full.json.truncated).toBe(false);

    const bySha = new Map(records.map((r) => [r.commit, r]));
    for (const sha of [c1.sha, c2.sha, c3.sha, mergeCommit]) {
      const note = await getAttr('aud-run', sha);
      expect(note.status, sha).toBe(200);
      const rec = bySha.get(sha)!;
      expect(rec, sha).toMatchObject({
        agent: note.json.agent,
        session: note.json.session,
        promptHash: note.json.promptHash,
        model: note.json.model ?? null,
        actor: note.json.actor,
        attributedAt: note.json.at,
        evidenceLevel: note.json.evidence.level,
        evidence: note.json.evidence,
        tokenPrefix: note.json.evidence.tokenPrefix,
      });
    }
    expect(bySha.get(c1.sha)).toMatchObject({ evidenceLevel: 'authenticated', tokenPrefix: a.token.slice(0, 18) });
    expect(bySha.get(c2.sha)).toMatchObject({ evidenceLevel: 'declared', agent: 'run-agent-b' });
    expect(bySha.get(c3.sha)).toMatchObject({ evidenceLevel: 'authenticated', attributionSource: 'api' });
    expect(bySha.get(mergeCommit)).toMatchObject({ agent: 'run-agent-b', attributionSource: 'merge', evidenceLevel: 'authenticated' });

    // Pushes: c2 by agent A, c3 by agent B, through the gate, with token prefixes; c1 was never a pushed tip.
    expect(bySha.get(c2.sha)!.pushes).toEqual([
      expect.objectContaining({ ref: 'refs/heads/feature', before: ZERO, principal: `agent:${a.id}`, agent: 'run-agent-a', actor: OWNER, tokenKind: 'agent', tokenPrefix: a.token.slice(0, 18) }),
    ]);
    expect(bySha.get(c2.sha)!.pushedAt).toBe(bySha.get(c2.sha)!.pushes[0].at);
    expect(bySha.get(c3.sha)!.pushes[0]).toMatchObject({ principal: `agent:${b.id}`, tokenPrefix: b.token.slice(0, 18) });
    expect(bySha.get(c1.sha)!.pushes).toEqual([]);
    expect(bySha.get(c1.sha)!.pushedAt).toBeNull();
    // Merges: the fast-forward of c2 by the owner's PAT, the merge commit by agent B.
    expect(bySha.get(c2.sha)!.merges).toEqual([
      expect.objectContaining({ via: 'merge', change: 1, ref: 'refs/heads/main', before: root.sha, principal: `user:${userIds[OWNER]}`, tokenKind: 'pat' }),
    ]);
    expect(bySha.get(c2.sha)!.merges[0].tokenPrefix).toBe(tok.owner.slice(0, bySha.get(c2.sha)!.merges[0].tokenPrefix.length));
    expect(bySha.get(mergeCommit)!.merges).toEqual([expect.objectContaining({ via: 'merge', change: 2, before: c2.sha, principal: `agent:${b.id}` })]);
    for (const r of records) for (const t of [r.attributedAt, r.firstSeenAt, ...r.pushes.map((p: any) => p.at)]) if (t) expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // No full token anywhere in the export, in either format.
    const ndjson = await audit('aud-run', 'format=ndjson&limit=200');
    expect(ndjson.status).toBe(200);
    expect(ndjson.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(ndjson.cost.d1).toBe(2);
    const lines = ndjson.text.trimEnd().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
    expect(lines.slice(0, -1)).toEqual(records);
    expect(lines[lines.length - 1]).toEqual({ page: { since: null, until: null, truncated: false, nextCursor: null } });
    for (const body of [...pages, full.text, ndjson.text]) {
      for (const t of [a.token, b.token, tok.owner, tok.writer]) expect(body).not.toContain(t);
      expect(body).not.toMatch(/kvarm_(pat|agt)_[0-9a-f]{40,}/);
    }
  });

  it('filters by since/until on first-seen time and keeps pagination stable while commits arrive', async () => {
    const repo = await seedRepo('aud-time');
    const owner = { agent: OWNER, session: 's', promptHash: HASH };
    const shas: string[] = [];
    let parent: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await commit(repo, { 'n.txt': `${i}\n` }, parent);
      parent = [c.sha];
      shas.push(c.sha);
    }
    // Spread first-seen times deterministically.
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    for (const [i, sha] of shas.entries()) {
      await setAttr('aud-time', sha, owner, tok.owner);
      await env.DB.prepare('UPDATE audit_commits SET first_at = ?1 WHERE repo_id = ?2 AND commit_sha = ?3').bind(base + i * 60_000, repoIds['aud-time'], sha).run();
    }
    const window = await audit('aud-time', `since=2026-03-01T00:01:00Z&until=2026-03-01T00:04:00Z`);
    expect(window.json.records.map((r: any) => r.commit)).toEqual(shas.slice(1, 4));
    expect(window.json).toMatchObject({ since: '2026-03-01T00:01:00.000Z', until: '2026-03-01T00:04:00.000Z' });
    expect((await audit('aud-time', 'since=2026-03-02T00:00:00Z&until=2026-03-01T00:00:00Z')).json.code).toBe('INVALID_TIME');

    const first = await audit('aud-time', 'limit=2');
    expect(first.json.records.map((r: any) => r.commit)).toEqual(shas.slice(0, 2));
    // A commit seen now sorts after every existing one, so the cursor still continues exactly where it stopped.
    const late = await commit(repo, { 'n.txt': 'late\n' }, parent);
    await setAttr('aud-time', late.sha, owner, tok.owner);
    const second = await audit('aud-time', `limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(second.json.records.map((r: any) => r.commit)).toEqual(shas.slice(2, 4));
    const third = await audit('aud-time', `limit=10&cursor=${encodeURIComponent(second.json.nextCursor)}`);
    expect(third.json.records.map((r: any) => r.commit)).toEqual([shas[4], late.sha]);
    expect(third.json.nextCursor).toBeNull();
  });

  it('never lets first-seen time go backwards, so a clock step back cannot hide a later commit behind a cursor', async () => {
    const repo = await seedRepo('aud-clock');
    const c1 = await commit(repo, { 'a.txt': 'a\n' });
    const c2 = await commit(repo, { 'b.txt': 'b\n' }, [c1.sha]);
    await setAttr('aud-clock', c1.sha, { agent: OWNER, session: 's', promptHash: HASH }, tok.owner);
    // The first commit was stamped by a clock an hour ahead of the one that records the next.
    const ahead = Date.now() + 3_600_000;
    await env.DB.prepare('UPDATE audit_commits SET first_at = ?1 WHERE repo_id = ?2').bind(ahead, repoIds['aud-clock']).run();
    await setAttr('aud-clock', c2.sha, { agent: OWNER, session: 's', promptHash: HASH }, tok.owner);
    const first = await audit('aud-clock', 'limit=1');
    expect(first.json.records.map((r: any) => r.commit)).toEqual([c1.sha]);
    const next = await audit('aud-clock', `limit=1&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(next.json.records.map((r: any) => r.commit)).toEqual([c2.sha]);
    expect(Date.parse(next.json.records[0].firstSeenAt)).toBeGreaterThanOrEqual(ahead);
    // A window starting at the step still contains the later commit.
    expect((await audit('aud-clock', `since=${new Date(ahead).toISOString()}`)).json.records.map((r: any) => r.commit)).toEqual([c1.sha, c2.sha]);
  });

  it('never fails a queue publication over malformed agent metadata', async () => {
    await seedRepo('aud-queue-bad');
    const repoId = repoIds['aud-queue-bad']!;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, head_sha, merge_policy, agent_meta, enqueued_at, updated_at)
       VALUES ('qb', ?1, 'refs/heads/main', 1, 'csb', 3, 'publishing', ?2, 'review', '{not json', ?3, ?3)`,
    )
      .bind(repoId, 'e'.repeat(40), now)
      .run();
    const published = await env.DB.prepare(`UPDATE merge_queue SET state = 'published', merge_commit = ?1 WHERE repo_id = ?2 AND id = 'qb'`)
      .bind('f'.repeat(40), repoId)
      .run();
    expect(published.success).toBe(true);
    expect((await env.DB.prepare("SELECT state FROM merge_queue WHERE repo_id = ?1 AND id = 'qb'").bind(repoId).first<{ state: string }>())?.state).toBe('published');
    expect((await audit('aud-queue-bad')).json.records[0].merges[0]).toMatchObject({ via: 'queue', change: 3, principal: null, agent: null, tokenPrefix: null });
  });

  it('records a merge-train publication from the queue ledger with the enqueuing agent', async () => {
    await seedRepo('aud-queue');
    const a = await mintAgent('aud-queue', 'queue-agent');
    const repoId = repoIds['aud-queue']!;
    const tokenId = (await env.DB.prepare('SELECT id FROM agent_tokens WHERE agent_id = ?').bind(a.id).first<{ id: string }>())!.id;
    const now = Date.now();
    const head = 'c'.repeat(40);
    const mergeCommit = 'd'.repeat(40);
    await env.DB.prepare(
      `INSERT INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, head_sha, merge_policy,
                                enqueued_by, enqueuer_login, agent_meta, principal, enqueued_at, updated_at)
       VALUES ('q1', ?1, 'refs/heads/main', 1, 'cs1', 7, 'publishing', ?2, 'review', ?3, ?4, ?5, ?7, ?6, ?6)`,
    )
      .bind(repoId, head, userIds[OWNER], OWNER, JSON.stringify({ agentId: a.id, agentName: 'queue-agent', tokenId }), now, `agent:${a.id}`)
      .run();
    await env.DB.prepare(`UPDATE merge_queue SET state = 'published', active = 0, merge_commit = ?1, previous_sha = ?2, updated_at = ?3 WHERE repo_id = ?4 AND id = 'q1'`)
      .bind(mergeCommit, head, now + 1, repoId)
      .run();
    const r = await audit('aud-queue');
    expect(r.json.records).toEqual([
      expect.objectContaining({
        commit: mergeCommit,
        evidenceLevel: null,
        evidence: null,
        merges: [expect.objectContaining({ via: 'queue', change: 7, ref: 'refs/heads/main', before: head, principal: `agent:${a.id}`, agent: 'queue-agent', tokenKind: 'agent', tokenPrefix: a.token.slice(0, 18) })],
      }),
    ]);
  });
});
