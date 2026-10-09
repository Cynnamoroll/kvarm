/**
 * Git-notes attribution and decision records (services/attribution.ts,
 * services/decisions.ts) through the Worker's routes over the in-memory
 * Artifacts fake: notes land on refs/notes/forge-attribution through the fake
 * receive-pack exactly like the Artifacts remote, so the notes tree is the
 * one git reads after fetching that ref.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FORGE_NOTES_REF, decode, findNote, parseTree } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'at-owner';
const HASH = 'a'.repeat(64);

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

const tok = { owner: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
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
  return repo;
}

async function grant(repo: string, login: string, role: 'read' | 'write' | 'admin'): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(repoIds[repo], userIds[login], role, userIds[OWNER], Date.now(), Date.now())
    .run();
}

interface Reply {
  status: number;
  json: Record<string, any>;
  cost: CostCounters;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json, cost: cost! };
}

const repoPath = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const setAttr = (repo: string, sha: string, body: unknown, token: string | undefined = tok.owner) =>
  call('POST', repoPath(repo, `/commits/${sha}/attribution`), token, body);
const getAttr = (repo: string, sha: string, token: string | undefined = tok.owner) => call('GET', repoPath(repo, `/commits/${sha}/attribution`), token);
const decide = (repo: string, body: unknown, token: string | undefined = tok.owner) => call('POST', repoPath(repo, '/decisions'), token, body);
const context = (repo: string, q: string, token: string | undefined = tok.owner) => call('GET', repoPath(repo, `/context?${q}`), token);

/** The note git would show for `sha` after fetching the notes ref. */
async function gitNote(repo: FakeRepo, sha: string): Promise<string | null> {
  const tip = repo.refs.get(FORGE_NOTES_REF);
  if (!tip) return null;
  const c = decode(repo.objects.get(tip)!.content);
  const tree = /^tree ([0-9a-f]{40})$/m.exec(c)![1]!;
  const reader = { readTree: async (h: string) => (repo.objects.get(h)?.type === 'tree' ? parseTree(repo.objects.get(h)!.content) : null) };
  const loc = await findNote(reader, tree, sha);
  return loc ? decode(repo.objects.get(loc.blob)!.content) : null;
}

async function based(repo: FakeRepo) {
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set('refs/heads/main', main.sha);
  return main;
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('at-reader'), 'reader', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('at-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('commit attribution notes', () => {
  it('stores the pinned JSON record as a git note and GET returns it exactly', async () => {
    const repo = await seedRepo('set');
    const main = await based(repo);
    const r = await setAttr('set', main.sha, { agent: 'claude-code-1', session: 'sess-abc', promptHash: HASH, model: 'm-1' });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json)).toEqual(['agent', 'session', 'promptHash', 'model', 'actor', 'at']);
    expect(r.json).toMatchObject({ agent: 'claude-code-1', session: 'sess-abc', promptHash: HASH, model: 'm-1', actor: OWNER });
    expect(new Date(r.json.at).toISOString()).toBe(r.json.at);

    // The notes ref was created with a zero old OID; the note is the JSON record.
    const tip = repo.refs.get(FORGE_NOTES_REF)!;
    expect(repo.calls).toContain(`receivePack:${FORGE_NOTES_REF}:${'0'.repeat(40)}->${tip}`);
    const note = await gitNote(repo, main.sha);
    expect(JSON.parse(note!)).toEqual(r.json);
    expect(note!.endsWith('\n')).toBe(true);

    const got = await getAttr('set', main.sha);
    expect(got.status).toBe(200);
    expect(got.json).toEqual(r.json);

    // Model is optional and omitted when absent.
    const second = await commit(repo, { 'README.md': 'two\n' }, [main.sha]);
    const r2 = await setAttr('set', second.sha, { agent: 'a2', session: 's2', promptHash: HASH });
    expect(r2.status).toBe(201);
    expect(Object.keys(r2.json)).toEqual(['agent', 'session', 'promptHash', 'actor', 'at']);
    // The second note commit sits on the first; both notes stay readable.
    const tip2 = repo.refs.get(FORGE_NOTES_REF)!;
    expect(decode(repo.objects.get(tip2)!.content)).toContain(`parent ${tip}\n`);
    expect(JSON.parse((await gitNote(repo, main.sha))!)).toEqual(r.json);
    expect((await getAttr('set', second.sha)).json).toEqual(r2.json);
  });

  it('replaces the note of an attributed commit', async () => {
    const repo = await seedRepo('replace');
    const main = await based(repo);
    expect((await setAttr('replace', main.sha, { agent: 'a1', session: 's1', promptHash: HASH })).status).toBe(201);
    const r = await setAttr('replace', main.sha, { agent: 'a2', session: 's2', promptHash: HASH });
    expect(r.status).toBe(200);
    expect((await getAttr('replace', main.sha)).json).toEqual(r.json);
    const tip = repo.refs.get(FORGE_NOTES_REF)!;
    const tree = /^tree ([0-9a-f]{40})$/m.exec(decode(repo.objects.get(tip)!.content))![1]!;
    expect(parseTree(repo.objects.get(tree)!.content).map((e) => e.name)).toEqual([main.sha]);
  });

  it('answers 404 for an unattributed commit and validates the sha and body', async () => {
    const repo = await seedRepo('missing');
    const main = await based(repo);
    // No notes ref at all.
    const none = await getAttr('missing', main.sha);
    expect([none.status, none.json.code]).toEqual([404, 'ATTRIBUTION_NOT_FOUND']);
    const other = await commit(repo, { 'x.txt': 'x\n' }, [main.sha]);
    await setAttr('missing', other.sha, { agent: 'a', session: 's', promptHash: HASH });
    // A notes ref exists, but not for this commit: never another commit's data.
    const still = await getAttr('missing', main.sha);
    expect([still.status, still.json.code]).toEqual([404, 'ATTRIBUTION_NOT_FOUND']);

    expect((await getAttr('missing', 'abc')).json.code).toBe('INVALID_SHA');
    expect((await getAttr('missing', 'abc')).status).toBe(400);
    const ghost = await setAttr('missing', 'f'.repeat(40), { agent: 'a', session: 's', promptHash: HASH });
    expect([ghost.status, ghost.json.code]).toEqual([404, 'COMMIT_NOT_FOUND']);
    const cases: Array<[unknown, number, string]> = [
      [{ session: 's', promptHash: HASH }, 422, 'INVALID_AGENT'],
      [{ agent: 'a', promptHash: HASH }, 422, 'INVALID_SESSION'],
      [{ agent: 'a', session: 's' }, 422, 'INVALID_PROMPT_HASH'],
      [{ agent: 'a', session: 's', promptHash: HASH, model: 7 }, 422, 'INVALID_MODEL'],
      [{ agent: 'x'.repeat(201), session: 's', promptHash: HASH }, 422, 'INVALID_AGENT'],
      [[1], 400, 'INVALID_BODY'],
    ];
    const before = repo.count('receivePack:');
    for (const [body, status, code] of cases) {
      const r = await setAttr('missing', main.sha, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect(repo.count('receivePack:')).toBe(before);
  });

  it('is permission-checked by the shared authority', async () => {
    const repo = await seedRepo('perm');
    const main = await based(repo);
    await setAttr('perm', main.sha, { agent: 'a', session: 's', promptHash: HASH });
    expect((await getAttr('perm', main.sha, tok.outsider)).status).toBe(404);
    expect((await getAttr('perm', main.sha, '')).status).toBe(404);
    expect((await setAttr('perm', main.sha, { agent: 'a', session: 's', promptHash: HASH }, tok.outsider)).status).toBe(404);
    await grant('perm', 'at-reader', 'read');
    expect((await getAttr('perm', main.sha, tok.reader)).status).toBe(200);
    expect((await setAttr('perm', main.sha, { agent: 'a', session: 's', promptHash: HASH }, tok.reader)).status).toBe(403);
  });

  it('retries on a moved notes ref so concurrent writers lose no note', async () => {
    const repo = await seedRepo('race');
    const main = await based(repo);
    const other = await commit(repo, { 'o.txt': 'o\n' }, [main.sha]);
    await setAttr('race', main.sha, { agent: 'first', session: 's', promptHash: HASH });
    // Another writer lands a note between this writer's read and its send.
    let raced = false;
    repo.hook = async (c) => {
      if (raced || !c.startsWith(`receivePack:${FORGE_NOTES_REF}`)) return;
      raced = true;
      repo.hook = null;
      expect((await setAttr('race', other.sha, { agent: 'second', session: 's', promptHash: HASH })).status).toBe(201);
    };
    const r = await setAttr('race', main.sha, { agent: 'third', session: 's', promptHash: HASH });
    expect(r.status).toBe(200);
    expect(raced).toBe(true);
    expect(JSON.parse((await gitNote(repo, main.sha))!).agent).toBe('third');
    expect(JSON.parse((await gitNote(repo, other.sha))!).agent).toBe('second');
  });

  it('records each attribution in the events ledger', async () => {
    const repo = await seedRepo('ledger');
    const main = await based(repo);
    await setAttr('ledger', main.sha, { agent: 'ledger-agent', session: 's', promptHash: HASH });
    const row = await env.DB.prepare(`SELECT type, payload, processed_at FROM events WHERE type = 'attribution.set' AND payload LIKE ?`)
      .bind(`%${repoIds.ledger}%`)
      .first<{ type: string; payload: string; processed_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row!.processed_at).not.toBeNull();
    const payload = JSON.parse(row!.payload);
    expect(payload).toMatchObject({ repoId: repoIds.ledger, commit: main.sha, source: 'api', notesCommit: repo.refs.get(FORGE_NOTES_REF) });
    expect(payload.attribution).toMatchObject({ agent: 'ledger-agent', actor: OWNER });
  });

  it('writes the merging actor attribution on Forge-created merge commits', async () => {
    const repo = await seedRepo('merge', 'public');
    const root = await commit(repo, { 'README.md': 'readme\n' });
    const main = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n' }, [root.sha]);
    const feature = await commit(repo, { 'README.md': 'readme\n', 'b.txt': 'B\n' }, [root.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/feature', feature.sha);
    expect((await call('POST', repoPath('merge', '/changes'), tok.owner, { title: 'm', base: 'main', head: 'feature' })).status).toBe(201);
    const merged = await call('POST', repoPath('merge', '/changes/1/merge'), tok.owner, {
      attribution: { agent: 'claude-code-1', session: 'sess-merge', promptHash: HASH, model: 'm-2' },
    });
    expect(merged.status).toBe(200);
    const sha = merged.json.mergeCommit as string;
    expect(merged.json.merge.kind).toBe('merge');
    const a = await getAttr('merge', sha);
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ agent: 'claude-code-1', session: 'sess-merge', promptHash: HASH, model: 'm-2', actor: OWNER });
    expect(JSON.parse((await gitNote(repo, sha))!)).toEqual(a.json);

    // Without request fields the merging principal names itself.
    const f2 = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n', 'b.txt': 'B\n', 'c.txt': 'C\n' }, [feature.sha]);
    repo.refs.set('refs/heads/feature2', f2.sha);
    expect((await call('POST', repoPath('merge', '/changes'), tok.owner, { title: 'm2', base: 'main', head: 'feature2' })).status).toBe(201);
    const m2 = await call('POST', repoPath('merge', '/changes/2/merge'), tok.owner);
    expect(m2.status).toBe(200);
    const a2 = await getAttr('merge', m2.json.mergeCommit);
    expect(a2.json).toMatchObject({ agent: OWNER, session: 'forge:merge/change-2', promptHash: null, actor: OWNER });

    // A bad attribution object is refused before anything merges.
    const f3 = await commit(repo, { 'README.md': 'readme\n', 'z.txt': 'Z\n' }, [root.sha]);
    repo.refs.set('refs/heads/feature3', f3.sha);
    expect((await call('POST', repoPath('merge', '/changes'), tok.owner, { title: 'm3', base: 'main', head: 'feature3' })).status).toBe(201);
    const tipBefore = repo.refs.get('refs/heads/main');
    const bad = await call('POST', repoPath('merge', '/changes/3/merge'), tok.owner, { attribution: { agent: 7 } });
    expect([bad.status, bad.json.code]).toEqual([422, 'INVALID_AGENT']);
    expect(repo.refs.get('refs/heads/main')).toBe(tipBefore);
  });

  it('names the agent identity when an agent token merges, and leaves fast-forwarded commits alone', async () => {
    const repo = await seedRepo('agentmerge', 'public');
    const root = await commit(repo, { 'README.md': 'readme\n' });
    const main = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'A\n' }, [root.sha]);
    const feature = await commit(repo, { 'README.md': 'readme\n', 'b.txt': 'B\n' }, [root.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/feature', feature.sha);
    const agent = await call('POST', '/api/v1/agents', tok.owner, { name: 'merger-bot' });
    const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
      repo: `${OWNER}/agentmerge`,
      role: 'write',
      refs: ['refs/heads/*'],
    });
    expect(minted.status).toBe(201);
    const agentTok = minted.json.token as string;
    expect((await call('POST', repoPath('agentmerge', '/changes'), agentTok, { title: 'm', base: 'main', head: 'feature' })).status).toBe(201);
    const merged = await call('POST', repoPath('agentmerge', '/changes/1/merge'), agentTok);
    expect(merged.status).toBe(200);
    const a = await getAttr('agentmerge', merged.json.mergeCommit);
    expect(a.json).toMatchObject({ agent: 'merger-bot', actor: OWNER });

    // Agent tokens may set attribution too; the actor stays the minting human.
    const set = await setAttr('agentmerge', feature.sha, { agent: 'claude-code-9', session: 's', promptHash: HASH }, agentTok);
    expect(set.status).toBe(201);
    expect(set.json).toMatchObject({ agent: 'claude-code-9', actor: OWNER });

    // Fast-forward: the head commit is not Forge's, so its note is untouched.
    const ff = await commit(repo, { 'README.md': 'ff\n' }, [merged.json.mergeCommit]);
    repo.refs.set('refs/heads/ff', ff.sha);
    expect((await call('POST', repoPath('agentmerge', '/changes'), tok.owner, { title: 'ff', base: 'main', head: 'ff' })).status).toBe(201);
    const ffm = await call('POST', repoPath('agentmerge', '/changes/2/merge'), tok.owner);
    expect([ffm.status, ffm.json.merge.kind]).toEqual([200, 'fast-forward']);
    expect((await getAttr('agentmerge', ff.sha)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('decisions and context', () => {
  const decision = {
    task: 'task-login',
    paths: ['src/auth/login.ts', 'src/auth/session.ts'],
    chosen: 'cand-b',
    rejected: ['cand-a', { id: 'cand-c', reason: 'breaks the session refresh test' }],
    reason: 'cand-b keeps the cookie path unchanged',
  };

  it('records a decision and returns it by task and by each path', async () => {
    await seedRepo('decide');
    const r = await decide('decide', decision);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ ...decision, actor: OWNER, agent: null });
    expect(r.json.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(r.json.at).toISOString()).toBe(r.json.at);

    const byTask = await context('decide', 'task=task-login');
    expect(byTask.status).toBe(200);
    expect(byTask.json).toEqual({ decisions: [r.json], truncated: false, nextCursor: null });
    for (const p of decision.paths) {
      const byPath = await context('decide', `path=${encodeURIComponent(p)}`);
      expect(byPath.json.decisions).toEqual([r.json]);
    }
    // Several paths in one query: comma-separated or repeated, one entry per decision.
    expect((await context('decide', `path=${decision.paths.join(',')}`)).json.decisions).toEqual([r.json]);
    expect((await context('decide', decision.paths.map((p) => `path=${p}`).join('&'))).json.decisions).toEqual([r.json]);

    // A paths-only decision (no task) is found by path; unknown task and path return empty lists.
    const pathsOnly = await decide('decide', { paths: ['docs/x.md'], chosen: '#12', rejected: [], reason: 'smaller diff' });
    expect(pathsOnly.status).toBe(201);
    expect(pathsOnly.json.task).toBeNull();
    expect((await context('decide', 'path=docs/x.md')).json.decisions).toEqual([pathsOnly.json]);
    expect((await context('decide', 'task=nope')).json).toEqual({ decisions: [], truncated: false, nextCursor: null });
    expect((await context('decide', 'path=nope/x')).json.decisions).toEqual([]);
  });

  it('validates decisions and context queries with actionable codes', async () => {
    await seedRepo('decide-bad');
    const cases: Array<[unknown, number, string]> = [
      [{ ...decision, chosen: '' }, 422, 'INVALID_CHOSEN'],
      [{ ...decision, reason: 5 }, 422, 'INVALID_REASON'],
      [{ ...decision, rejected: 'x' }, 422, 'INVALID_REJECTED'],
      [{ ...decision, rejected: [{ reason: 'no id' }] }, 422, 'INVALID_REJECTED'],
      [{ ...decision, paths: ['../etc'] }, 422, 'INVALID_PATH'],
      [{ chosen: 'a', rejected: [], reason: 'r', paths: [] }, 422, 'TASK_OR_PATHS_REQUIRED'],
      [{ ...decision, paths: Array.from({ length: 101 }, (_, i) => `p/${i}`) }, 422, 'TOO_MANY_PATHS'],
      [[1], 400, 'INVALID_BODY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await decide('decide-bad', body);
      expect([r.status, r.json.code], JSON.stringify(body).slice(0, 80)).toEqual([status, code]);
      expect(typeof r.json.error).toBe('string');
    }
    const q: Array<[string, string]> = [
      ['', 'CONTEXT_QUERY_REQUIRED'],
      [`path=${Array.from({ length: 21 }, (_, i) => `p${i}`).join(',')}`, 'TOO_MANY_PATHS'],
      ['task=x&limit=0', 'INVALID_LIMIT'],
      ['task=x&limit=51', 'INVALID_LIMIT'],
      ['task=x&cursor=garbage', 'INVALID_CURSOR'],
    ];
    for (const [query, code] of q) {
      const r = await context('decide-bad', query);
      expect([r.status, r.json.code], query.slice(0, 60)).toEqual([400, code]);
    }
  });

  it('pages newest first with truncated and nextCursor, never silently omitting', async () => {
    await seedRepo('page');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await decide('page', { task: 't', paths: ['a.txt'], chosen: `c${i}`, rejected: [], reason: `r${i}` });
      ids.push(r.json.id);
    }
    for (const q of ['task=t', 'path=a.txt']) {
      const seen: string[] = [];
      const ats: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const r: Reply = await context('page', `${q}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        expect(r.status).toBe(200);
        expect(r.json.decisions.length).toBeLessThanOrEqual(2);
        expect(r.json.truncated).toBe(r.json.nextCursor !== null);
        seen.push(...r.json.decisions.map((d: { id: string }) => d.id));
        ats.push(...r.json.decisions.map((d: { at: string }) => d.at));
        cursor = r.json.nextCursor;
        pages++;
      } while (cursor);
      expect(pages).toBe(3);
      // Every decision exactly once, newest first (decisions within one millisecond tie-break by id).
      expect([...seen].sort()).toEqual([...ids].sort());
      expect(ats).toEqual([...ats].sort().reverse());
    }
    // The default page is bounded too, and its D1 work is the authority lookup plus one query.
    const all = await context('page', 'task=t');
    expect(all.json.decisions).toHaveLength(5);
    expect(all.cost.d1).toBeLessThanOrEqual(2);
    expect(all.cost.do).toBe(0);
  });

  it('is permission-checked by the shared authority', async () => {
    await seedRepo('decide-perm');
    await decide('decide-perm', decision);
    for (const t of [tok.outsider, '']) {
      const r = await context('decide-perm', 'task=task-login', t);
      expect(r.status).toBe(404);
      expect(r.json.decisions).toBeUndefined();
      expect((await decide('decide-perm', decision, t)).status).toBe(404);
    }
    await grant('decide-perm', 'at-reader', 'read');
    expect((await context('decide-perm', 'task=task-login', tok.reader)).json.decisions).toHaveLength(1);
    expect((await decide('decide-perm', decision, tok.reader)).status).toBe(403);
  });

  it('records the agent identity for agent tokens and goes away with the repo', async () => {
    await seedRepo('decide-agent');
    const agent = await call('POST', '/api/v1/agents', tok.owner, { name: 'decider' });
    const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
      repo: `${OWNER}/decide-agent`,
      role: 'write',
      refs: ['refs/heads/agents/*'],
    });
    const r = await decide('decide-agent', decision, minted.json.token);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ actor: OWNER, agent: { id: agent.json.agent.id, name: 'decider' } });
    expect((await call('DELETE', repoPath('decide-agent', ''), tok.owner)).status).toBe(200);
    const left = await env.DB.batch([
      env.DB.prepare('SELECT COUNT(*) AS n FROM agent_decisions WHERE repo_id = ?').bind(repoIds['decide-agent']),
      env.DB.prepare('SELECT COUNT(*) AS n FROM agent_decision_paths WHERE repo_id = ?').bind(repoIds['decide-agent']),
    ]);
    expect(left.map((x) => (x.results[0] as { n: number }).n)).toEqual([0, 0]);
  });
});
