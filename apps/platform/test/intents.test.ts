/**
 * Nexus intents and forecasts (services/intents/forecast.ts) through the
 * Worker's routes, the git gate and the push queue, over the in-memory
 * Artifacts fake. Declarations are written by the intent routes and workspace
 * creation; observed paths are reconciled by the push consumer's
 * `intent-index` effect from the cumulative base→head tree diff.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_PACK, ZERO_OID, pktLine, readPktLines, sha256Hex } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { INTENT_LIMITS, collapseObserved, minimalCover, normalizeDeclaration } from '../src/services/intents/paths';
import { collectPairs, setOverlap, setOverlapStatements } from '../src/services/intents/forecast';
import { COMPARE_BUDGETS } from '../src/services/compare';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'nx-owner';

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

const tok = { owner: '', outsider: '' };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(crypto.randomUUID(), OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return repo;
}

interface Reply {
  status: number;
  text: string;
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
  return { status: res.status, text, json, cost: cost! };
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const createWs = (repo: string, body: unknown, token = tok.owner) => call('POST', `${R(repo)}/workspaces`, token, body);
const getIntent = (repo: string, id: string, token: string | undefined = tok.owner) => call('GET', `${R(repo)}/workspaces/${id}/intent`, token);
const setIntent = (repo: string, id: string, body: unknown, token = tok.owner) => call('POST', `${R(repo)}/workspaces/${id}/intent`, token, body);
const forecast = (repo: string, q: string, token: string | undefined = tok.owner) => call('GET', `${R(repo)}/forecast?${q}`, token);
const overlap = (repo: string, q = 'base=main', token: string | undefined = tok.owner) => call('GET', `${R(repo)}/workspaces/overlap?${q}`, token);
const abandon = (repo: string, id: string) => call('POST', `${R(repo)}/workspaces/${id}/abandon`, tok.owner);
const workspaceTokens = new Map<string, string>();

async function workspaceToken(repo: string): Promise<string> {
  const cached = workspaceTokens.get(repo);
  if (cached) return cached;
  const agent = await call('POST', '/api/v1/agents', tok.owner, { name: `push-${repo}` });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
    repo: `${OWNER}/${repo}`,
    role: 'write',
    refs: ['refs/heads/agents/*'],
  });
  expect(minted.status).toBe(201);
  const token = minted.json.token as string;
  workspaceTokens.set(repo, token);
  return token;
}

async function gitPush(repo: string, token: string, cmds: string[]): Promise<string[]> {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0report-status agent=git/2.47\n` : `${c}\n`));
  const needsPack = cmds.some((c) => c.split(' ')[1] !== ZERO_OID);
  const body = new Blob([...parts, new TextEncoder().encode('0000'), ...(needsPack ? [EMPTY_PACK] : [])]);
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: new Uint8Array(await body.arrayBuffer()),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const buf = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(200);
  return readPktLines(buf)
    .filter((p) => !p.flush)
    .map((p) => new TextDecoder().decode(p.data).trim());
}

function pushEvent(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown): Promise<void> {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

let clock = Date.now();

/** Pushes `files` as a commit on top of `from` to the workspace ref and delivers its push event. */
async function push(repoName: string, repo: FakeRepo, ws: Record<string, any>, from: string, files: Files): Promise<string> {
  const c = await commit(repo, files, [from]);
  const report = await gitPush(repoName, await workspaceToken(repoName), [`${from} ${c.sha} ${ws.ref}`]);
  expect(report).toEqual(['unpack ok', `ok ${ws.ref}`]);
  await deliver(pushEvent(repoName, ws.ref, from, c.sha, (clock += 1000)));
  return c.sha;
}

async function based(repo: FakeRepo, files: Files = { 'README.md': 'readme\n' }) {
  const main = await commit(repo, files);
  repo.refs.set('refs/heads/main', main.sha);
  return main;
}

const BASE_FILES: Files = { 'README.md': 'readme\n', 'src/app.ts': 'app\n', 'docs/guide.md': 'guide\n' };

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('nx-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('path normalization (pure)', () => {
  it('normalizes, dedupes, subsumes paths under declared prefixes and sorts', () => {
    const r = normalizeDeclaration({ paths: ['src/', 'src/a.ts', 'docs//guide.md', './docs/guide.md', 'lib'], prefixes: ['tools', 'tools/'] });
    expect(r).toEqual({ ok: true, value: { paths: ['docs/guide.md', 'lib', 'src/', 'tools/'], ttlSeconds: null } });
  });

  it('rejects absolute paths, dot-dot segments, empty declarations and over-cap input', () => {
    const bad: unknown[] = [
      { paths: ['/etc/passwd'] },
      { paths: ['src/../secret'] },
      { paths: ['..'] },
      { paths: [] },
      { paths: ['', '/'] },
      { paths: 'src/' },
      { paths: [7] },
      { paths: ['a\\b'] },
      { paths: ['x'.repeat(INTENT_LIMITS.pathMaxBytes + 1)] },
      { paths: Array.from({ length: INTENT_LIMITS.declaredMax + 1 }, (_, i) => `f${i}.ts`) },
      { paths: ['ok.ts'], ttlSeconds: 1 },
    ];
    for (const b of bad) {
      const r = normalizeDeclaration(b);
      expect(r.ok, JSON.stringify(b).slice(0, 80)).toBe(false);
    }
  });

  it('bounds overlap pair enumeration by group membership and a pair-visit budget, and says so', () => {
    const ids = (n: number, p = 'w') => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(3, '0')}`);
    const one = collectPairs([{ path: 'hot.ts', members: ids(100) }], [], (h) => h);
    const m = INTENT_LIMITS.overlapGroupMembersMax;
    expect(one.visits).toBe((m * (m - 1)) / 2);
    expect(one.visits).toBeLessThan((100 * 99) / 2);
    expect(one.reasons.join(' ')).toMatch(/more than \d+ workspaces/);

    const many = collectPairs(
      Array.from({ length: 50 }, (_, g) => ({ path: `p${String(g).padStart(2, '0')}`, members: ids(m, `g${g}-`) })),
      [{ path: 'z', a: 'x', b: 'y' }],
      (h) => h,
    );
    expect(many.visits).toBe(INTENT_LIMITS.overlapPairVisitMax);
    expect(many.reasons.join(' ')).toMatch(/budget/);
    expect(many.pairs.size).toBeLessThanOrEqual(INTENT_LIMITS.overlapPairMax);

    const small = collectPairs([{ path: 'a', members: ['x', 'y', 'z'] }], [{ path: 'b/c', a: 'x', b: 'y' }], (h) => h);
    expect([small.visits, small.reasons, [...small.pairs.keys()].sort()]).toEqual([4, [], ['x:y', 'x:z', 'y:z']]);
  });

  it('collapses wide observed sets into bounded directory prefixes', () => {
    const many = Array.from({ length: 40 }, (_, i) => `gen/part${i % 4}/f${i}.ts`).concat(['README.md']);
    const c = collapseObserved(many, 10);
    expect(c.paths).toEqual(['README.md', 'gen/part0/', 'gen/part1/', 'gen/part2/', 'gen/part3/']);
    expect(c.collapsed).toBe(true);
    const small = collapseObserved(['b.ts', 'a.ts'], 10);
    expect(small).toEqual({ paths: ['a.ts', 'b.ts'], collapsed: false, truncated: false });
  });

  // The quadratic definitions the sorted sweep replaced, kept as the reference.
  const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const refCover = (entries: Iterable<string>) => {
    const sorted = [...new Set(entries)].sort(byStr);
    const prefixes = sorted.filter((p) => p.endsWith('/'));
    return sorted.filter((p) => !prefixes.some((q) => q !== p && (p === q || p.startsWith(q))));
  };
  const refCollapse = (paths: Iterable<string>, max: number) => {
    const unique = [...new Set(paths)].sort(byStr);
    if (unique.length <= max) return { paths: unique, collapsed: false, truncated: false };
    const depth = Math.max(...unique.map((p) => p.split('/').length));
    for (let d = depth - 1; d >= 1; d--) {
      const level = refCover(unique.map((p) => (p.split('/').length > d ? `${p.split('/').slice(0, d).join('/')}/` : p)));
      if (level.length <= max) return { paths: level, collapsed: true, truncated: false };
    }
    const top = refCover(unique.map((p) => (p.includes('/') ? `${p.split('/')[0]}/` : p)));
    return { paths: top.slice(0, max), collapsed: true, truncated: true };
  };

  it('cover and collapse match the reference definitions on random path sets', () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const names = ['a', 'b', 'a.b', 'a-b', 'ab', 'z', 'é'];
    for (let round = 0; round < 200; round++) {
      const entries: string[] = [];
      for (let i = 0, n = 1 + rnd(40); i < n; i++) {
        const segs = Array.from({ length: 1 + rnd(5) }, () => names[rnd(names.length)]!);
        entries.push(segs.join('/') + (rnd(3) === 0 ? '/' : ''));
      }
      expect(minimalCover(entries), JSON.stringify(entries)).toEqual(refCover(entries));
      const files = entries.map((e) => (e.endsWith('/') ? `${e}f` : e));
      for (const max of [1, 2, 3, 5, 8, 50]) expect(collapseObserved(files, max), `${max} ${JSON.stringify(files)}`).toEqual(refCollapse(files, max));
    }
  });

  it('collapses a 20,000-path deep and wide observed set in linearithmic time', () => {
    const n = 20_000;
    // Wide: every file in its own top-level directory, so even the top level does not fit.
    const wide = Array.from({ length: n }, (_, i) => `d${i}/sub/f.ts`);
    // Deep: a binary directory tree 15 levels down plus a long tail, 31 segments per path.
    const deep = Array.from({ length: n }, (_, i) => {
      const segs = Array.from({ length: 15 }, (_, j) => `s${(i >> j) & 1}`);
      return [...segs, ...Array.from({ length: 15 }, (_, j) => `t${j}`), `f${i}.ts`].join('/');
    });
    // Many prefixes at once: the cover of 20,000 sibling prefixes and their files.
    const prefixes = Array.from({ length: n }, (_, i) => `p/${i}/`).concat(Array.from({ length: n }, (_, i) => `p/${i}/x.ts`));
    const started = performance.now();
    const w = collapseObserved(wide);
    const d = collapseObserved(deep);
    const cover = minimalCover(prefixes);
    const elapsed = performance.now() - started;
    expect(w).toMatchObject({ collapsed: true, truncated: true });
    expect(w.paths).toHaveLength(INTENT_LIMITS.observedMax);
    expect(d).toMatchObject({ collapsed: true, truncated: false });
    expect(d.paths.length).toBeLessThanOrEqual(INTENT_LIMITS.observedMax);
    for (const p of deep.slice(0, 500)) expect(d.paths.some((e) => p === e || (e.endsWith('/') && p.startsWith(e)))).toBe(true);
    expect(cover).toHaveLength(n);
    // The push-consumer CPU budget for the intent-index effect's cover work (library/cost.md).
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe('declarations', () => {
  it('records intent at creation, replaces it through the intent route and rejects invalid paths without change', async () => {
    const repo = await seedRepo('declare');
    const main = await based(repo, BASE_FILES);
    const made = await createWs('declare', { task: 'docs and src', agent: 'a1', intent: { paths: ['src/', 'docs/guide.md'] } });
    expect(made.status).toBe(201);
    expect(made.json.declaredPaths).toEqual(['docs/guide.md', 'src/']);
    const id = made.json.id as string;

    const got = await getIntent('declare', id);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({
      workspace: id,
      status: 'active',
      declaredPaths: ['docs/guide.md', 'src/'],
      observedPaths: [],
      baseSha: main.sha,
      headSha: main.sha,
      observedTruncated: false,
      advisory: true,
      index: { declared: 2, observed: 0 },
    });
    expect(got.cost).toMatchObject({ d1: 2, do: 0, art: 0, sub: 0 });

    const upd = await setIntent('declare', id, { paths: ['lib/util.ts'] });
    expect(upd.status).toBe(200);
    expect(upd.json.declaredPaths).toEqual(['lib/util.ts']);
    expect(upd.cost.d1).toBeLessThanOrEqual(2);
    expect(upd.cost.do).toBe(0);
    expect((await getIntent('declare', id)).json.declaredPaths).toEqual(['lib/util.ts']);

    for (const body of [{ paths: ['/abs/path'] }, { paths: ['a/../b'] }, { paths: [] }, {}]) {
      const r = await setIntent('declare', id, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([422, 'INVALID_INTENT']);
      expect(r.json.error).toEqual(expect.any(String));
    }
    expect((await getIntent('declare', id)).json.declaredPaths).toEqual(['lib/util.ts']);

    // An invalid declaration at creation writes nothing (no ref, no row).
    const before = repo.count('receivePack:');
    const refused = await createWs('declare', { task: 'bad', agent: 'a1', intent: { paths: ['../x'] } });
    expect([refused.status, refused.json.code]).toEqual([422, 'INVALID_INTENT']);
    expect(repo.count('receivePack:')).toBe(before);
  });

  it('reads follow repo read access and writes need write; unknown workspaces are 404', async () => {
    const repo = await seedRepo('declare-auth');
    await based(repo, BASE_FILES);
    const id = (await createWs('declare-auth', { task: 't', agent: 'a' })).json.id as string;
    expect((await getIntent('declare-auth', id, tok.outsider)).status).toBe(404);
    expect((await setIntent('declare-auth', id, { paths: ['a'] }, tok.outsider)).status).toBe(404);
    expect((await forecast('declare-auth', 'paths=a', tok.outsider)).status).toBe(404);
    expect((await overlap('declare-auth', 'base=main', tok.outsider)).status).toBe(404);
    expect((await getIntent('declare-auth', 'nope')).json.code).toBe('WORKSPACE_NOT_FOUND');
    expect((await setIntent('declare-auth', 'nope', { paths: ['a'] })).json.code).toBe('WORKSPACE_NOT_FOUND');
    expect((await abandon('declare-auth', id)).status).toBe(200);
    const late = await setIntent('declare-auth', id, { paths: ['a'] });
    expect([late.status, late.json.code]).toEqual([409, 'WORKSPACE_NOT_ACTIVE']);
  });

  it('is nonexclusive: overlapping declarations coexist and every push lands', async () => {
    const repo = await seedRepo('nonexclusive');
    const main = await based(repo, BASE_FILES);
    const a = (await createWs('nonexclusive', { task: 'a', agent: 'a', intent: { paths: ['src/'] } })).json;
    const b = (await createWs('nonexclusive', { task: 'b', agent: 'b', intent: { paths: ['src/'] } })).json;
    const c = (await createWs('nonexclusive', { task: 'c', agent: 'c' })).json;
    for (const [i, ws] of [a, b, c].entries()) {
      await push('nonexclusive', repo, ws, main.sha, { ...BASE_FILES, 'src/a.ts': `v${i}\n` });
    }
    expect((await getIntent('nonexclusive', a.id)).json).toMatchObject({ declaredPaths: ['src/'], observedPaths: ['src/a.ts'] });
    expect((await getIntent('nonexclusive', b.id)).json).toMatchObject({ declaredPaths: ['src/'], observedPaths: ['src/a.ts'] });
    const cIntent = (await getIntent('nonexclusive', c.id)).json;
    expect(cIntent).toMatchObject({ declaredPaths: [], observedPaths: ['src/a.ts'] });
    expect(JSON.stringify(cIntent)).not.toMatch(/lock|claim|blocked/i);
  });
});

describe('observed index', () => {
  it('a prefix declaration is one indexed row and matches descendant observed paths', async () => {
    const repo = await seedRepo('prefix');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('prefix', { task: 'p', agent: 'a', intent: { paths: ['src/'] } })).json;
    expect((await getIntent('prefix', ws.id)).json.index).toEqual({ declared: 1, observed: 0 });
    const head = await push('prefix', repo, ws, main.sha, { ...BASE_FILES, 'src/deep/nested/file.ts': 'x\n' });
    const got = (await getIntent('prefix', ws.id)).json;
    expect(got).toMatchObject({
      declaredPaths: ['src/'],
      observedPaths: ['src/deep/nested/file.ts'],
      headSha: head,
      matches: [{ declared: 'src/', observed: ['src/deep/nested/file.ts'] }],
      outsideDeclaration: [],
      index: { declared: 1, observed: 1 },
    });
  });

  it('is cumulative base→head across pushes, not the last delta', async () => {
    const repo = await seedRepo('cumulative');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('cumulative', { task: 'c', agent: 'a' })).json;
    const c1 = await push('cumulative', repo, ws, main.sha, { ...BASE_FILES, 'a.txt': 'a\n' });
    const c2 = await push('cumulative', repo, ws, c1, { ...BASE_FILES, 'a.txt': 'a\n', 'b.txt': 'b\n' });
    const got = (await getIntent('cumulative', ws.id)).json;
    expect(got).toMatchObject({ observedPaths: ['a.txt', 'b.txt'], baseSha: main.sha, headSha: c2, workspaceHeadSha: c2, observedCurrent: true });
  });

  it('drops net-zero edits and keeps paths still changed', async () => {
    const repo = await seedRepo('netzero');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('netzero', { task: 'n', agent: 'a' })).json;
    const c1 = await push('netzero', repo, ws, main.sha, { ...BASE_FILES, 'tmp.txt': 't\n', 'keep.txt': 'k\n', 'src/app.ts': 'changed\n' });
    const c2 = await push('netzero', repo, ws, c1, { ...BASE_FILES, 'keep.txt': 'k\n' });
    const got = (await getIntent('netzero', ws.id)).json;
    expect(got.observedPaths).toEqual(['keep.txt']);
    expect(got.headSha).toBe(c2);
    // The reverted src/app.ts edit is no longer forecast as observed either.
    expect((await forecast('netzero', 'paths=src/app.ts')).json.matches).toEqual([]);
  });

  it('records pushes outside the declaration honestly as advisory evidence', async () => {
    const repo = await seedRepo('outside');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('outside', { task: 'o', agent: 'a', intent: { paths: ['docs/'] } })).json;
    const head = await push('outside', repo, ws, main.sha, { ...BASE_FILES, 'src/billing.ts': 'bill\n' });
    expect(repo.refs.get(ws.ref)).toBe(head);
    const got = (await getIntent('outside', ws.id)).json;
    expect(got).toMatchObject({
      declaredPaths: ['docs/'],
      observedPaths: ['src/billing.ts'],
      matches: [{ declared: 'docs/', observed: [] }],
      outsideDeclaration: ['src/billing.ts'],
      advisory: true,
    });
  });

  it('a late older push event never rolls the observed set back', async () => {
    const repo = await seedRepo('ordering');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('ordering', { task: 'o', agent: 'a' })).json;
    const c1 = await commit(repo, { ...BASE_FILES, 'one.txt': '1\n' }, [main.sha]);
    const c2 = await commit(repo, { ...BASE_FILES, 'one.txt': '1\n', 'two.txt': '2\n' }, [c1.sha]);
    await gitPush('ordering', await workspaceToken('ordering'), [`${main.sha} ${c2.sha} ${ws.ref}`]);
    const t1 = (clock += 1000);
    const t2 = (clock += 1000);
    await deliver(pushEvent('ordering', ws.ref, c1.sha, c2.sha, t2));
    await deliver(pushEvent('ordering', ws.ref, main.sha, c1.sha, t1));
    const got = (await getIntent('ordering', ws.id)).json;
    expect(got).toMatchObject({ observedPaths: ['one.txt', 'two.txt'], headSha: c2.sha });
  });

  it('equal-timestamp pushes completing in reverse order leave the observed set at the current ref position', async () => {
    const repo = await seedRepo('equal-ts');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('equal-ts', { task: 'eq', agent: 'a' })).json;
    const c1 = await commit(repo, { ...BASE_FILES, 'one.txt': '1\n' }, [main.sha]);
    const c2 = await commit(repo, { ...BASE_FILES, 'one.txt': '1\n', 'two.txt': '2\n' }, [c1.sha]);
    await gitPush('equal-ts', await workspaceToken('equal-ts'), [`${main.sha} ${c2.sha} ${ws.ref}`]);
    // Same event time; the ingest tiebreak (event id) makes the c1→c2 push the current one.
    const at = (clock += 1000);
    const sourceIds = ['eq-x', 'eq-y'];
    const ranked = await Promise.all(sourceIds.map(async (s) => [s, await sha256Hex(`source:default:${s}`)] as const));
    ranked.sort((a, b) => (a[1] < b[1] ? -1 : 1));
    const older = { ...pushEvent('equal-ts', ws.ref, main.sha, c1.sha, at), id: ranked[0]![0] };
    const newer = { ...pushEvent('equal-ts', ws.ref, c1.sha, c2.sha, at), id: ranked[1]![0] };

    // The older event ingests first and its reconciliation is held until the newer one has completed.
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const paused = new Promise<void>((r) => (reached = r));
    repo.hook = async (call) => {
      if (call === `readCommit:${c1.sha}`) {
        reached();
        await gate;
      }
    };
    const first = deliver(older);
    await paused;
    await deliver(newer);
    release();
    await first;
    repo.hook = null;

    const current = await env.DB.prepare('SELECT f.sha FROM repo_refs f JOIN repos r ON r.id = f.repo_id WHERE r.name = ? AND f.ref = ?')
      .bind('equal-ts', ws.ref)
      .first<{ sha: string }>();
    expect(current?.sha).toBe(c2.sha);
    const got = (await getIntent('equal-ts', ws.id)).json;
    expect(got).toMatchObject({ observedPaths: ['one.txt', 'two.txt'], headSha: c2.sha, observedCurrent: true });
    expect((await forecast('equal-ts', 'paths=two.txt')).json.matches.map((m: any) => m.workspace)).toEqual([ws.id]);
  });

  it('paths dropped from an observed index make forecast and overlap report incompleteness even with no match', async () => {
    const repo = await seedRepo('omitted');
    const main = await based(repo, BASE_FILES);
    const wide = (await createWs('omitted', { task: 'wide', agent: 'a' })).json;
    const files: Files = { ...BASE_FILES };
    for (let i = 0; i <= INTENT_LIMITS.observedMax; i++) files[`f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
    await push('omitted', repo, wide, main.sha, files);
    const last = `f${String(INTENT_LIMITS.observedMax).padStart(3, '0')}.txt`;
    expect((await getIntent('omitted', wide.id)).json.observedPaths).not.toContain(last);

    const other = (await createWs('omitted', { task: 'other', agent: 'b' })).json;
    await push('omitted', repo, other, main.sha, { ...BASE_FILES, [last]: 'other\n' });

    const f = (await forecast('omitted', `paths=${last}&exclude=${other.id}`)).json;
    expect(f.matches).toEqual([]);
    expect(f.truncated).toBe(true);
    expect(f.truncatedReason).toMatch(/incomplete/);
    expect(f.incomplete).toEqual([{ workspace: wide.id, reason: expect.stringMatching(/top-level/) }]);
    expect(f.nextCursor).toBeNull();

    const o = await overlap('omitted');
    expect(o.json.pairs).toEqual([]);
    expect(o.json.truncated).toBe(true);
    expect(o.json.truncatedReason).toMatch(/incomplete/);
    expect(o.json.incomplete).toEqual([{ workspace: wide.id, reason: expect.any(String) }]);
    expect(o.cost).toMatchObject({ d1: 2, art: 0, do: 0 });

    // A complete index elsewhere stays complete, and abandoning the incomplete workspace clears the disclosure.
    expect((await abandon('omitted', wide.id)).status).toBe(200);
    const after = (await forecast('omitted', `paths=${last}`)).json;
    expect(after).toMatchObject({ truncated: false, matches: [{ workspace: other.id }] });
    expect(after.incomplete).toBeUndefined();
    expect((await overlap('omitted')).json.truncated).toBe(false);
  });

  it('an observation recorded before observed_omitted existed still discloses its omitted paths, with no new push', async () => {
    const repo = await seedRepo('legacy-omitted');
    const main = await based(repo, BASE_FILES);
    const wide = (await createWs('legacy-omitted', { task: 'wide', agent: 'a' })).json;
    const files: Files = { ...BASE_FILES };
    for (let i = 0; i <= INTENT_LIMITS.observedMax; i++) files[`f${String(i).padStart(3, '0')}.txt`] = `${i}\n`;
    await push('legacy-omitted', repo, wide, main.sha, files);
    const last = `f${String(INTENT_LIMITS.observedMax).padStart(3, '0')}.txt`;
    const collapsed = (await createWs('legacy-omitted', { task: 'collapsed', agent: 'c' })).json;
    const genFiles: Files = { ...BASE_FILES };
    for (let i = 0; i < INTENT_LIMITS.observedMax + 10; i++) genFiles[`gen/d${i % 3}/f${i}.ts`] = `${i}\n`;
    await push('legacy-omitted', repo, collapsed, main.sha, genFiles);
    const other = (await createWs('legacy-omitted', { task: 'other', agent: 'b' })).json;
    await push('legacy-omitted', repo, other, main.sha, { ...BASE_FILES, [last]: 'other\n' });

    // The pre-repair row shape: the omission reason lives only in observed_truncated.
    await env.DB.prepare('UPDATE workspaces SET observed_omitted = NULL WHERE id IN (?, ?)').bind(wide.id, collapsed.id).run();
    const legacy = await env.DB.prepare('SELECT observed_truncated, observed_omitted FROM workspaces WHERE id = ?').bind(wide.id).first<any>();
    expect(legacy).toMatchObject({ observed_truncated: expect.stringMatching(/top-level/), observed_omitted: null });

    const f = (await forecast('legacy-omitted', `paths=${last}&exclude=${other.id}`)).json;
    expect(f.matches).toEqual([]);
    expect(f.truncated).toBe(true);
    expect(f.truncatedReason).toMatch(/incomplete/);
    // A collapse-only observation covers every changed path and stays complete.
    expect(f.incomplete).toEqual([{ workspace: wide.id, reason: expect.stringMatching(/top-level/) }]);

    const o = await overlap('legacy-omitted');
    expect(o.json.truncated).toBe(true);
    expect(o.json.incomplete).toEqual([{ workspace: wide.id, reason: expect.stringMatching(/top-level/) }]);
    expect(o.cost).toMatchObject({ d1: 2, art: 0, do: 0 });

    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE artifacts_name = ?').bind(`${OWNER}--legacy-omitted`).first<{ id: string }>())!.id;
    const members = [wide.id, collapsed.id, other.id];
    const set = setOverlap(members, await env.DB.batch(setOverlapStatements(env.DB, repoId, members)));
    expect(set.truncated).toBe(true);
    expect(set.truncatedReason).toContain(`the observed index of ${wide.id} is incomplete`);
    const complete = setOverlap([collapsed.id, other.id], await env.DB.batch(setOverlapStatements(env.DB, repoId, [collapsed.id, other.id])));
    expect(complete.truncatedReason ?? '').not.toMatch(/incomplete/);
  });

  it('a spent tree-walk budget is disclosed as an incomplete index', async () => {
    const repo = await seedRepo('walk-budget');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('walk-budget', { task: 'deep', agent: 'a' })).json;
    const budgets = COMPARE_BUDGETS as { maxTreeReads: number };
    const saved = budgets.maxTreeReads;
    budgets.maxTreeReads = 2;
    try {
      await push('walk-budget', repo, ws, main.sha, { ...BASE_FILES, 'deep/a/b/c.ts': 'c\n', 'src/app.ts': 'changed\n' });
    } finally {
      budgets.maxTreeReads = saved;
    }
    expect((await getIntent('walk-budget', ws.id)).json.observedTruncated).toBe(true);
    const f = (await forecast('walk-budget', 'paths=deep/a/b/c.ts')).json;
    expect(f.truncated).toBe(true);
    expect(f.incomplete).toEqual([{ workspace: ws.id, reason: expect.stringMatching(/diff incomplete/) }]);
  });

  it('collapses a wide edit into bounded prefixes that still forecast and overlap', async () => {
    const repo = await seedRepo('wide');
    const main = await based(repo, BASE_FILES);
    const wide = (await createWs('wide', { task: 'wide', agent: 'a' })).json;
    const files: Files = { ...BASE_FILES };
    for (let i = 0; i < INTENT_LIMITS.observedMax + 10; i++) files[`gen/d${i % 3}/f${i}.ts`] = `${i}\n`;
    await push('wide', repo, wide, main.sha, files);
    const got = (await getIntent('wide', wide.id)).json;
    expect(got.observedPaths).toEqual(['gen/d0/', 'gen/d1/', 'gen/d2/']);
    expect(got.observedTruncated).toBe(true);
    expect(got.observedTruncatedReason).toMatch(/prefix/);

    const narrow = (await createWs('wide', { task: 'narrow', agent: 'b' })).json;
    await push('wide', repo, narrow, main.sha, { ...BASE_FILES, 'gen/d1/f1.ts': 'other\n' });
    const f = (await forecast('wide', 'paths=gen/d1/f1.ts')).json;
    expect(f.matches.map((m: any) => [m.workspace, m.matchKind]).sort()).toEqual([[narrow.id, 'observed'], [wide.id, 'observed']].sort());
    // Collapsed prefixes still cover every changed file: nothing was omitted.
    expect(f.truncated).toBe(false);
    const o = (await overlap('wide')).json;
    expect(o.pairs).toHaveLength(1);
    expect(o.pairs[0].workspaces).toEqual([narrow.id, wide.id].sort());
    expect(o.pairs[0].paths).toEqual(['gen/d1/f1.ts']);
  });
});

describe('forecast', () => {
  it('matches declared and observed workspaces with evidence, class and freshness', async () => {
    const repo = await seedRepo('fc');
    const main = await based(repo, BASE_FILES);
    const a = (await createWs('fc', { task: 'a', agent: 'a', intent: { paths: ['src/'] } })).json;
    const b = (await createWs('fc', { task: 'b', agent: 'b' })).json;
    const bHead = await push('fc', repo, b, main.sha, { ...BASE_FILES, 'src/b.ts': 'b\n' });
    const r = await forecast('fc', 'paths=src/b.ts&base=main');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ advisory: true, truncated: false, nextCursor: null, query: { paths: ['src/b.ts'], base: 'main' } });
    expect(r.json.advisoryNote).toEqual(expect.any(String));
    const byId = new Map<string, any>(r.json.matches.map((m: any) => [m.workspace, m]));
    expect(byId.size).toBe(2);
    expect(byId.get(a.id)).toMatchObject({
      matchKind: 'declared',
      evidence: [{ kind: 'declared', path: 'src/', query: 'src/b.ts' }],
      revision: main.sha,
      observedHeadSha: main.sha,
    });
    expect(byId.get(a.id).declaredAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(byId.get(b.id)).toMatchObject({
      matchKind: 'observed',
      evidence: [{ kind: 'observed', path: 'src/b.ts', query: 'src/b.ts' }],
      revision: bHead,
      observedHeadSha: bHead,
    });
    expect(byId.get(b.id).observedAt).toMatch(/Z$/);
    expect(r.cost).toMatchObject({ d1: 2, do: 0, art: 0, sub: 0 });

    // A prefix query finds descendants; another base finds nothing.
    expect((await forecast('fc', 'paths=src/')).json.matches.map((m: any) => m.workspace).sort()).toEqual([a.id, b.id].sort());
    expect((await forecast('fc', 'paths=src/b.ts&base=other')).json.matches).toEqual([]);
    expect((await forecast('fc', `paths=src/b.ts&exclude=${b.id}`)).json.matches.map((m: any) => m.workspace)).toEqual([a.id]);
  });

  it('is bounded: explicit truncation, a complete duplicate-free cursor and an actionable cap error', async () => {
    const repo = await seedRepo('fc-page');
    const main = await based(repo, BASE_FILES);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const ws = (await createWs('fc-page', { task: `w${i}`, agent: `a${i}`, ...(i % 2 ? { intent: { paths: ['shared/'] } } : {}) })).json;
      ids.push(ws.id);
      if (i % 2 === 0) await push('fc-page', repo, ws, main.sha, { ...BASE_FILES, 'shared/x.ts': `${i}\n` });
    }
    const full = await forecast('fc-page', 'paths=shared/x.ts&limit=100');
    expect(full.json).toMatchObject({ truncated: false, nextCursor: null });
    expect(full.json.matches.map((m: any) => m.workspace).sort()).toEqual([...ids].sort());

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = `paths=shared/x.ts&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = (await forecast('fc-page', q)).json;
      expect(page.matches.length).toBeLessThanOrEqual(2);
      if (page.nextCursor) expect(page).toMatchObject({ truncated: true, truncatedReason: expect.any(String) });
      else expect(page.truncated).toBe(false);
      seen.push(...page.matches.map((m: any) => m.workspace));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(4);
    expect(seen).toEqual(full.json.matches.map((m: any) => m.workspace));
    expect(new Set(seen).size).toBe(seen.length);

    const over = Array.from({ length: INTENT_LIMITS.forecastPathsMax + 1 }, (_, i) => `p${i}.ts`).join(',');
    const capped = await forecast('fc-page', `paths=${over}`);
    expect([capped.status, capped.json.code]).toEqual([422, 'TOO_MANY_PATHS']);
    expect(capped.json.error).toContain(String(INTENT_LIMITS.forecastPathsMax));
    expect((await forecast('fc-page', '')).json.code).toBe('INVALID_PATHS');
    expect((await forecast('fc-page', 'paths=../x')).json.code).toBe('INVALID_PATHS');
    expect((await forecast('fc-page', 'paths=a&limit=0')).json.code).toBe('INVALID_LIMIT');
    expect((await forecast('fc-page', 'paths=a&cursor=Z!')).json.code).toBe('INVALID_CURSOR');
  });

  it('an empty forecast is explicit and advisory; forecasts are read-only and byte-identical', async () => {
    const repo = await seedRepo('fc-empty');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('fc-empty', { task: 'e', agent: 'a', intent: { paths: ['src/'] } })).json;
    await push('fc-empty', repo, ws, main.sha, { ...BASE_FILES, 'src/a.ts': 'a\n' });
    const empty = await forecast('fc-empty', 'paths=path/that/no/workspace/touches&base=main');
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({ matches: [], truncated: false, advisory: true });

    const snapshot = async () =>
      JSON.stringify([
        (await env.DB.prepare('SELECT * FROM workspace_paths ORDER BY repo_id, kind, path, workspace_id').all()).results,
        (await env.DB.prepare('SELECT * FROM workspaces ORDER BY id').all()).results,
        [...repo.refs.entries()].sort(),
      ]);
    const before = await snapshot();
    const one = await forecast('fc-empty', 'paths=src/a.ts,docs/guide.md&base=main');
    const two = await forecast('fc-empty', 'paths=src/a.ts,docs/guide.md&base=main');
    expect(one.text).toBe(two.text);
    expect(one.json.matches).toHaveLength(1);
    expect(one.cost.rw).toBe(0);
    expect(await snapshot()).toBe(before);
  });

  it('abandon and expiry remove the signal, not the workspace record or code', async () => {
    const repo = await seedRepo('fc-expire');
    const main = await based(repo, BASE_FILES);
    const b = (await createWs('fc-expire', { task: 'b', agent: 'b', intent: { paths: ['lib/'] } })).json;
    const bHead = await push('fc-expire', repo, b, main.sha, { ...BASE_FILES, 'lib/x.ts': 'x\n' });
    repo.refs.set('refs/heads/keep-b', bHead);
    const idle = (await createWs('fc-expire', { task: 'idle', agent: 'i', intent: { paths: ['lib/'] } })).json;
    const ttl = (await createWs('fc-expire', { task: 'ttl', agent: 't', intent: { paths: ['lib/'], ttlSeconds: 3600 } })).json;
    expect((await getIntent('fc-expire', ttl.id)).json.declaredExpiresAt).toMatch(/Z$/);
    const before = (await forecast('fc-expire', 'paths=lib/x.ts')).json.matches.map((m: any) => m.workspace).sort();
    expect(before).toEqual([b.id, idle.id, ttl.id].sort());

    expect((await abandon('fc-expire', b.id)).status).toBe(200);
    await env.DB.prepare('UPDATE workspaces SET intent_expires_at = ? WHERE id = ?').bind(Date.now() - 1000, ttl.id).run();
    const after = (await forecast('fc-expire', 'paths=lib/x.ts')).json.matches.map((m: any) => m.workspace);
    expect(after).toEqual([idle.id]);
    const bIntent = (await getIntent('fc-expire', b.id)).json;
    expect(bIntent).toMatchObject({ status: 'abandoned', declaredPaths: ['lib/'], observedPaths: ['lib/x.ts'], index: { declared: 0, observed: 0 } });
    expect((await getIntent('fc-expire', ttl.id)).json).toMatchObject({ declaredPaths: ['lib/'], declaredExpired: true, index: { declared: 0 } });
    expect((await call('GET', `${R('fc-expire')}/workspaces/${b.id}`, tok.owner)).json.status).toBe('abandoned');
    expect(repo.refs.has(b.ref)).toBe(false);
    expect(repo.refs.get('refs/heads/keep-b')).toBe(bHead);
    expect(repo.refs.get(idle.ref)).toBe(main.sha);
    expect((await overlap('fc-expire')).json.pairs).toEqual([]);
  });

  it('merged workspaces leave the active index', async () => {
    const repo = await seedRepo('fc-merged');
    const main = await based(repo, BASE_FILES);
    const ws = (await createWs('fc-merged', { task: 'm', agent: 'm', intent: { paths: ['m/'] } })).json;
    await push('fc-merged', repo, ws, main.sha, { ...BASE_FILES, 'm/x.ts': 'x\n' });
    const opened = await call('POST', `${R('fc-merged')}/workspaces/${ws.id}/change-set`, tok.owner, { title: 'm' });
    expect(opened.status).toBe(201);
    expect((await forecast('fc-merged', 'paths=m/x.ts')).json.matches).toHaveLength(1);
    const merged = await call('POST', `${R('fc-merged')}/changes/${opened.json.number}/merge`, tok.owner);
    expect(merged.status).toBe(200);
    expect((await forecast('fc-merged', 'paths=m/x.ts')).json.matches).toEqual([]);
    expect((await getIntent('fc-merged', ws.id)).json).toMatchObject({ status: 'merged', index: { declared: 0, observed: 0 } });
  });
});

describe('active-workspace overlap', () => {
  it('pairs overlapping workspaces with their shared paths, against the requested base, without abandoned ones', async () => {
    const repo = await seedRepo('overlap');
    const main = await based(repo, BASE_FILES);
    const a = (await createWs('overlap', { task: 'a', agent: 'a' })).json;
    const b = (await createWs('overlap', { task: 'b', agent: 'b' })).json;
    const c = (await createWs('overlap', { task: 'c', agent: 'c' })).json;
    const d = (await createWs('overlap', { task: 'd', agent: 'd', intent: { paths: ['src/app.ts'] } })).json;
    const aHead = await push('overlap', repo, a, main.sha, { ...BASE_FILES, 'src/app.ts': 'A\n', 'a-only.ts': 'a\n' });
    const bHead = await push('overlap', repo, b, main.sha, { ...BASE_FILES, 'src/app.ts': 'B\n' });
    await push('overlap', repo, c, main.sha, { ...BASE_FILES, 'docs/guide.md': 'C\n' });

    const r = await overlap('overlap');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ base: 'main', advisory: true, truncated: false, nextCursor: null });
    expect(r.json.pairs).toHaveLength(1);
    const pair = r.json.pairs[0];
    expect(pair.workspaces).toEqual([a.id, b.id].sort());
    expect(pair.paths).toEqual(['src/app.ts']);
    expect(pair.matchKind).toBe('observed');
    const heads = Object.fromEntries(pair.heads.map((h: any) => [h.workspace, h.observedHeadSha]));
    expect(heads).toEqual({ [a.id]: aHead, [b.id]: bHead });
    for (const p of r.json.pairs) for (const w of [c.id, d.id]) expect(p.workspaces).not.toContain(w);
    expect(r.cost).toMatchObject({ d1: 2, do: 0, art: 0, sub: 0 });
    const again = await overlap('overlap');
    expect(again.text).toBe(r.text);
    expect(again.cost.art).toBe(0);

    expect((await overlap('overlap', 'base=dev')).json.pairs).toEqual([]);
    expect((await overlap('overlap', 'base=..bad')).json.code).toBe('INVALID_REF');

    expect((await abandon('overlap', a.id)).status).toBe(200);
    expect((await overlap('overlap')).json.pairs).toEqual([]);
  });

  it('bounds pairs with explicit truncation and a cursor', async () => {
    const repo = await seedRepo('overlap-page');
    const main = await based(repo, BASE_FILES);
    for (let i = 0; i < 4; i++) {
      const ws = (await createWs('overlap-page', { task: `w${i}`, agent: 'a' })).json;
      await push('overlap-page', repo, ws, main.sha, { ...BASE_FILES, 'hot.ts': `${i}\n` });
    }
    const full = (await overlap('overlap-page', 'base=main&limit=100')).json;
    expect(full.pairs).toHaveLength(6);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: any = (await overlap('overlap-page', `base=main&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json;
      if (page.nextCursor) expect(page).toMatchObject({ truncated: true, truncatedReason: expect.any(String) });
      seen.push(...page.pairs.map((p: any) => p.workspaces.join(':')));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 5);
    expect(pages).toBe(2);
    expect(seen).toEqual(full.pairs.map((p: any) => p.workspaces.join(':')));
    expect((await overlap('overlap-page', 'base=main&limit=0')).json.code).toBe('INVALID_LIMIT');
  });

  it('bounds the pair work of one widely shared path and discloses it', async () => {
    await seedRepo('overlap-hot');
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE name = ?').bind('overlap-hot').first<{ id: string }>())!.id;
    const n = INTENT_LIMITS.overlapGroupMembersMax + 20;
    const now = Date.now();
    const ids = Array.from({ length: n }, (_, i) => `hot${String(i).padStart(3, '0')}`);
    await env.DB.batch(
      ids.flatMap((id) => [
        env.DB.prepare(
          `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, base_sha, created_at, updated_at,
             observed_paths, observed_head_sha, observed_at)
           VALUES (?1, ?2, 'x', ?1, 'a', 'active', 'refs/heads/agents/' || ?1 || '/t', 'main', ?3, ?4, ?4, '["hot.ts"]', ?3, ?4)`,
        ).bind(id, repoId, '1'.repeat(40), now),
        env.DB.prepare(`INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, 'observed', 'hot.ts', ?)`).bind(repoId, id),
      ]),
    );
    const r = await overlap('overlap-hot', 'base=main&limit=100');
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.truncatedReason).toMatch(/more than \d+ workspaces/);
    // Only pairs among the first members (by id) were enumerated.
    const m = INTENT_LIMITS.overlapGroupMembersMax;
    const kept = new Set(ids.slice(0, m));
    for (const p of r.json.pairs) for (const w of p.workspaces) expect(kept.has(w)).toBe(true);
    expect(r.cost).toMatchObject({ d1: 2, art: 0, do: 0 });
  });
});

describe('Nexus reads at fleet scale', () => {
  /**
   * The fleet shape (scripts/lib/fleet.mjs): every member adds its own
   * marker file, twelve also edit shared/config.txt, and a pinned chain of
   * three stacks iface/ files. Seeded straight into D1, as the push consumer
   * would have indexed it.
   */
  async function seedFleet(name: string, n: number): Promise<string[]> {
    await seedRepo(name);
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE name = ?').bind(name).first<{ id: string }>())!.id;
    const now = Date.now();
    const ids = Array.from({ length: n }, (_, i) => `${name.replace(/[^0-9a-z]/g, '')}w${String(i).padStart(3, '0')}`);
    const shared = new Set(Array.from({ length: 12 }, (_, k) => 4 + Math.floor((k * (n - 4)) / 12)));
    const pathsOf = (i: number) => {
      const p = [`fleet/w${String(i).padStart(3, '0')}.txt`];
      if (shared.has(i)) p.push('shared/config.txt');
      if (i >= 1 && i <= 3) p.push(...['iface/a.txt', 'iface/b.txt', 'iface/c.txt'].slice(0, i));
      return p.sort();
    };
    await env.DB.batch(
      ids.flatMap((id, i) => [
        env.DB.prepare(
          `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, base_sha, created_at, updated_at,
             observed_paths, observed_head_sha, observed_at, observed_prefixes)
           VALUES (?1, ?2, 'x', ?1, 'a', 'active', 'refs/heads/agents/' || ?1 || '/t', 'main', ?3, ?4, ?4, ?5, ?3, ?4, 0)`,
        ).bind(id, repoId, '1'.repeat(40), now, JSON.stringify(pathsOf(i))),
        ...pathsOf(i).map((p) =>
          env.DB.prepare(`INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, 'observed', ?, ?)`).bind(repoId, p, id),
        ),
      ]),
    );
    return ids;
  }

  it('overlap and forecast read only the shared paths and the page, not every indexed row', async () => {
    await seedFleet('fleet-16', 16);
    await seedFleet('fleet-100', 100);
    const results: Record<string, CostCounters> = {};
    for (const name of ['fleet-16', 'fleet-100']) {
      const o = await overlap(name, 'base=main&limit=50');
      expect(o.status).toBe(200);
      // 12 shared-file members (66 pairs) and the chain (3 pairs).
      expect(o.json.pairs).toHaveLength(50);
      expect(o.json.nextCursor).not.toBeNull();
      const o2 = await overlap(name, `base=main&limit=50&cursor=${encodeURIComponent(o.json.nextCursor)}`);
      expect(o.json.pairs.length + o2.json.pairs.length).toBe(69);
      const f = await forecast(name, 'paths=shared/config.txt&limit=100');
      expect(f.status).toBe(200);
      expect(f.json.matches).toHaveLength(12);
      expect(f.json.truncated).toBe(false);
      results[`${name} overlap`] = o.cost;
      results[`${name} overlap page 2`] = o2.cost;
      results[`${name} forecast`] = f.cost;
    }
    console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, c]) => [k, `d1=${c.d1};rr=${c.rr};rw=${c.rw}`]))));
    for (const c of Object.values(results)) expect(c).toMatchObject({ d1: 2, art: 0, do: 0, sub: 0 });
    // Rows read follow the shared paths and the page, not the fleet size (library/cost.md overlap/forecast rows).
    expect(results['fleet-100 overlap']!.rr).toBeLessThanOrEqual(80);
    expect(results['fleet-100 overlap page 2']!.rr).toBeLessThanOrEqual(80);
    expect(results['fleet-100 forecast']!.rr).toBeLessThanOrEqual(40);
    expect(results['fleet-100 overlap']!.rr - results['fleet-16 overlap']!.rr).toBeLessThanOrEqual(5);
    expect(results['fleet-100 forecast']!.rr - results['fleet-16 forecast']!.rr).toBeLessThanOrEqual(5);
  });

  it('a popular path costs one page of rows per forecast page, and the pages stay complete', async () => {
    const ids = await seedFleet('fleet-hot', 16);
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE name = ?').bind('fleet-hot').first<{ id: string }>())!.id;
    await env.DB.batch(ids.map((id) => env.DB.prepare(`INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, 'observed', 'hot.ts', ?)`).bind(repoId, id)));
    const extra = Array.from({ length: 140 }, (_, i) => `fleethotx${String(i).padStart(3, '0')}`);
    const now = Date.now();
    await env.DB.batch(
      extra.flatMap((id) => [
        env.DB.prepare(
          `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, base_sha, created_at, updated_at, observed_paths, observed_head_sha, observed_at)
           VALUES (?1, ?2, 'x', ?1, 'a', 'active', 'refs/heads/agents/' || ?1 || '/t', 'main', ?3, ?4, ?4, '["hot.ts"]', ?3, ?4)`,
        ).bind(id, repoId, '1'.repeat(40), now),
        env.DB.prepare(`INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, 'observed', 'hot.ts', ?)`).bind(repoId, id),
      ]),
    );
    const all = [...ids, ...extra].sort();
    const seen: string[] = [];
    const costs: number[] = [];
    let cursor: string | null = null;
    do {
      const r: Reply = await forecast('fleet-hot', `paths=hot.ts&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.json.matches.map((m: any) => m.workspace));
      for (const m of r.json.matches) expect(m.evidence).toEqual([{ kind: 'observed', path: 'hot.ts', query: 'hot.ts' }]);
      costs.push(r.cost.rr);
      cursor = r.json.nextCursor;
    } while (cursor && costs.length < 20);
    expect(seen).toEqual(all);
    // 156 matching workspaces, 20 per page: each page reads its 21 hits and their workspaces, never all 156.
    for (const rr of costs) expect(rr).toBeLessThanOrEqual(2 * 21 + 10);
  });

  it('a query prefix reads a bounded number of entries and says when it stopped', async () => {
    await seedRepo('fc-range');
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE name = ?').bind('fc-range').first<{ id: string }>())!.id;
    const now = Date.now();
    const ids = ['rangea', 'rangeb', 'rangec'];
    const max = INTENT_LIMITS.forecastRangeHitMax;
    await env.DB.batch(
      ids.map((id) =>
        env.DB.prepare(
          `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, status, ref, base_ref, base_sha, created_at, updated_at, observed_paths, observed_head_sha, observed_at)
           VALUES (?1, ?2, 'x', ?1, 'a', 'active', 'refs/heads/agents/' || ?1 || '/t', 'main', ?3, ?4, ?4, '[]', ?3, ?4)`,
        ).bind(id, repoId, '1'.repeat(40), now),
      ),
    );
    // rangea holds max entries below gen/, so rangeb's single entry sorts past the bound; rangec matches the exact key.
    const rows = Array.from({ length: max }, (_, i) => ['rangea', `gen/a${String(i).padStart(5, '0')}.ts`]).concat([
      ['rangeb', 'gen/z.ts'],
      ['rangec', 'gen/'],
    ]);
    for (let i = 0; i < rows.length; i += 500) {
      await env.DB.batch(
        rows.slice(i, i + 500).map(([id, p]) => env.DB.prepare(`INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, 'observed', ?, ?)`).bind(repoId, p, id)),
      );
    }
    const r = await forecast('fc-range', 'paths=gen/&limit=100');
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.truncatedReason).toContain(`more than ${max} index entries match below gen/`);
    expect(r.json.matches.map((m: any) => m.workspace)).toEqual(['rangea', 'rangec']);
    expect(r.cost.rr).toBeLessThanOrEqual(2 * (max + 1) + 20);
    const narrow = await forecast('fc-range', 'paths=gen/z.ts&limit=100');
    expect(narrow.json).toMatchObject({ truncated: false });
    expect(narrow.json.matches.map((m: any) => m.workspace)).toEqual(['rangeb', 'rangec']);
  });

  it('share counts follow the observed index through pushes, abandon and repo delete', async () => {
    const repo = await seedRepo('shares');
    const main = await based(repo, BASE_FILES);
    const ws: Record<string, any>[] = [];
    for (let i = 0; i < 3; i++) ws.push((await createWs('shares', { task: `s${i}`, agent: 'a' })).json);
    const heads: string[] = [];
    heads[0] = await push('shares', repo, ws[0]!, main.sha, { ...BASE_FILES, 'src/app.ts': '0\n', 'one.ts': '0\n' });
    heads[1] = await push('shares', repo, ws[1]!, main.sha, { ...BASE_FILES, 'src/app.ts': '1\n', 'one.ts': '1\n' });
    heads[2] = await push('shares', repo, ws[2]!, main.sha, { ...BASE_FILES, 'src/app.ts': '2\n' });
    const repoId = (await env.DB.prepare('SELECT id FROM repos WHERE name = ?').bind('shares').first<{ id: string }>())!.id;
    const counts = async () =>
      (await env.DB.prepare('SELECT base_ref, path, members FROM workspace_path_shares WHERE repo_id = ? ORDER BY base_ref, path').bind(repoId).all()).results;
    const derived = async () =>
      (
        await env.DB.prepare(
          `SELECT w.base_ref, p.path, COUNT(*) AS members FROM workspace_paths p JOIN workspaces w ON w.id = p.workspace_id
            WHERE p.repo_id = ? AND p.kind = 'observed' GROUP BY w.base_ref, p.path ORDER BY w.base_ref, p.path`,
        )
          .bind(repoId)
          .all()
      ).results;
    expect(await counts()).toEqual([
      { base_ref: 'main', path: 'one.ts', members: 2 },
      { base_ref: 'main', path: 'src/app.ts', members: 3 },
    ]);
    // ws[1] reverts one.ts: only the row that left the set is deleted.
    await push('shares', repo, ws[1]!, heads[1]!, { ...BASE_FILES, 'src/app.ts': '1\n' });
    expect(await counts()).toEqual([
      { base_ref: 'main', path: 'one.ts', members: 1 },
      { base_ref: 'main', path: 'src/app.ts', members: 3 },
    ]);
    expect(await counts()).toEqual(await derived());
    expect((await overlap('shares')).json.pairs.map((p: any) => p.paths)).toEqual([['src/app.ts'], ['src/app.ts'], ['src/app.ts']]);
    expect((await abandon('shares', ws[0]!.id)).status).toBe(200);
    expect(await counts()).toEqual([{ base_ref: 'main', path: 'src/app.ts', members: 2 }]);
    expect((await overlap('shares')).json.pairs).toHaveLength(1);
    expect((await call('DELETE', R('shares'), tok.owner)).status).toBe(200);
    expect(await counts()).toEqual([]);
  });
});
