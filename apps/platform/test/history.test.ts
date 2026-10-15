/**
 * Path history (services/history.ts, routes/api/history.ts): the lazily built
 * first-parent index of the default branch. Answers are checked against the
 * fake repo's own history; the index's step bounds, epochs on a rewritten
 * branch, cursor paging, racing requests and the cost of a warm read.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { bumpRefGeneration, compareKeys, refGeneration, writeJson } from '../src/cache/compare';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { HISTORY_LIMITS, historyCleanupStatements } from '../src/services/history';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'history-owner';
const tok = { owner: '', outsider: '' };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'private'): Promise<{ id: string; fake: FakeRepo }> {
  const artifactsName = `${OWNER}--${name}`;
  const fake = new FakeRepo();
  fakeRepos.set(artifactsName, fake);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return { id, fake };
}

/** Moves main like a confirmed push would: the ref, then the ref generation. */
async function setMain(repo: { id: string; fake: FakeRepo }, sha: string): Promise<void> {
  repo.fake.refs.set('refs/heads/main', sha);
  await bumpRefGeneration(repo.id);
}

/** A linear history of `n` commits; commit i changes `f${i % files}.txt`. Returns shas oldest first. */
async function linear(repo: { fake: FakeRepo }, n: number, files = 3, from: string[] = [], tag = 'v', base: Files = {}): Promise<{ shas: string[]; tree: Files }> {
  const tree: Files = { ...base };
  const shas: string[] = [];
  let parents = from;
  for (let i = 0; i < n; i++) {
    tree[`f${i % files}.txt`] = `${tag}${i}\n`;
    const c = await commit(repo.fake, { ...tree }, parents);
    shas.push(c.sha);
    parents = [c.sha];
  }
  return { shas, tree };
}

function treeOf(repo: { fake: FakeRepo }, sha: string): string {
  const o = repo.fake.objects.get(sha)!;
  return /^tree ([0-9a-f]{40})/.exec(new TextDecoder().decode(o.content as Uint8Array))![1]!;
}

async function get(path: string, token = tok.owner): Promise<{ status: number; json: Record<string, any>; cost: CostCounters }> {
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, json: JSON.parse(text) as Record<string, any>, cost: parseCostHeader(res.headers.get(COST_HEADER))! };
}

const H = (repo: string, query: string) => `/api/v1/repos/${OWNER}/${repo}/history?${query}`;

/** Requests until the index is complete (each request advances it by one bounded step). */
async function settle(repo: string, path: string): Promise<{ json: Record<string, any>; requests: number }> {
  for (let i = 1; i <= 20; i++) {
    const r = await get(H(repo, `path=${encodeURIComponent(path)}&limit=100`));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    if (r.json.index.complete) return { json: r.json, requests: i };
  }
  throw new Error('history index did not complete');
}

/** Every page of a path's history through nextCursor. */
async function allPages(repo: string, path: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const r = await get(H(repo, `path=${encodeURIComponent(path)}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    out.push(...(r.json.commits as Array<{ sha: string }>).map((c) => c.sha));
    cursor = r.json.nextCursor;
    if (!cursor) return out;
  }
  throw new Error('paging did not end');
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('history-outsider'), 'outsider', FULL)).token;
});

afterAll(() => {
  restoreFetch();
});

describe('GET /repos/:o/:r/history', () => {
  it('lists the commits that changed a path, newest first, complete for a short history', async () => {
    const repo = await seedRepo('short');
    const c1 = await commit(repo.fake, { 'a.txt': '1\n', 'b.txt': '1\n' });
    const c2 = await commit(repo.fake, { 'a.txt': '2\n', 'b.txt': '1\n' }, [c1.sha]);
    const c3 = await commit(repo.fake, { 'b.txt': '2\n' }, [c2.sha], 'm\n\nbody text\n');
    await setMain(repo, c3.sha);

    const r = await get(H('short', 'path=a.txt'));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ path: 'a.txt', ref: 'refs/heads/main', headSha: c3.sha, nextCursor: null });
    expect(r.json.commits.map((c: any) => [c.sha, c.status])).toEqual([
      [c3.sha, 'removed'],
      [c2.sha, 'modified'],
      [c1.sha, 'added'],
    ]);
    expect(r.json.commits[0]).toMatchObject({ author: { name: 't', email: 't@kvarm.invalid' }, summary: 'm' });
    expect(r.json.commits[0].committedAt).toMatch(/Z$/);
    expect(r.json.index).toMatchObject({ epoch: 1, indexedHead: c3.sha, current: true, rootReached: true, gaps: 0, complete: true, progressed: true });

    // A path no commit touched has an empty, complete history.
    expect((await get(H('short', 'path=nope.txt'))).json).toMatchObject({ commits: [], index: { complete: true } });
  });

  it('serves a warm read from D1 alone: no Artifacts call, one service batch', async () => {
    const repo = await seedRepo('warm');
    const { shas } = await linear(repo, 4);
    await setMain(repo, shas[3]!);
    await settle('warm', 'f0.txt');
    const before = repo.fake.calls.length;
    const r = await get(H('warm', 'path=f0.txt'));
    expect(r.json.index.progressed).toBe(false);
    expect(r.cost).toMatchObject({ art: 0, do: 0 });
    expect(r.cost.d1).toBeLessThanOrEqual(2);
    expect(repo.fake.calls.length).toBe(before);
  });

  it('follows new commits on the branch', async () => {
    const repo = await seedRepo('forward');
    const first = await linear(repo, 3);
    await setMain(repo, first.shas[2]!);
    await settle('forward', 'f1.txt');
    const more = await linear(repo, 3, 3, [first.shas[2]!], 'w', first.tree);
    await setMain(repo, more.shas[2]!);
    const r = await get(H('forward', 'path=f1.txt'));
    expect(r.json.index).toMatchObject({ indexedHead: more.shas[2], complete: true, progressed: true });
    expect(r.json.commits.map((c: any) => c.sha)).toEqual([more.shas[1], first.shas[1]]);
  });

  it('builds a long history in bounded steps, then pages it with cursors without duplicates', async () => {
    const repo = await seedRepo('long');
    const n = HISTORY_LIMITS.commitsPerStep * 2 + 17;
    const { shas } = await linear(repo, n, 2);
    await setMain(repo, shas[n - 1]!);

    const first = await get(H('long', 'path=f0.txt&limit=100'));
    expect(first.json.index).toMatchObject({ current: true, rootReached: false, complete: false, progressed: true });
    // Only the newest step is indexed so far.
    expect(first.json.commits.length).toBe(HISTORY_LIMITS.commitsPerStep / 2);

    const { requests } = await settle('long', 'f0.txt');
    expect(requests).toBe(2);
    const expected = shas.filter((_, i) => i % 2 === 0).reverse();
    expect(await allPages('long', 'f0.txt', 7)).toEqual(expected);
  });

  it('restarts in a new epoch when the branch is rewritten; old cursors are refused', async () => {
    const repo = await seedRepo('rewrite');
    const old = await linear(repo, 12, 1, [], 'old');
    await setMain(repo, old.shas[11]!);
    await settle('rewrite', 'f0.txt');
    const page = await get(H('rewrite', 'path=f0.txt&limit=5'));
    const staleCursor = page.json.nextCursor as string;
    expect(staleCursor).toEqual(expect.any(String));

    // Force-push main to an unrelated history.
    const fresh = await linear(repo, 3, 1, [], 'new');
    await setMain(repo, fresh.shas[2]!);
    const r = await get(H('rewrite', 'path=f0.txt'));
    expect(r.json.index).toMatchObject({ epoch: 2, complete: true });
    expect(r.json.commits.map((c: any) => c.sha)).toEqual([...fresh.shas].reverse());

    const stale = await get(H('rewrite', `path=f0.txt&cursor=${encodeURIComponent(staleCursor)}`));
    expect([stale.status, stale.json.code]).toEqual([409, 'STALE_CURSOR']);

    // Old-epoch rows are never served and are purged by later steps.
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM path_history WHERE repo_id = ? AND epoch = 1').bind(repo.id).first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it('keeps one consistent index when two first requests race', async () => {
    const repo = await seedRepo('race');
    const { shas } = await linear(repo, 20, 2);
    await setMain(repo, shas[19]!);
    const [a, b] = await Promise.all([get(H('race', 'path=f1.txt')), get(H('race', 'path=f1.txt'))]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const done = await settle('race', 'f1.txt');
    expect(done.json.commits.map((c: any) => c.sha)).toEqual(shas.filter((_, i) => i % 2 === 1).reverse());
    const state = await env.DB.prepare('SELECT epoch FROM path_history_state WHERE repo_id = ?').bind(repo.id).first<{ epoch: number }>();
    const seqs = await env.DB.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT sha) AS d FROM path_history_commits WHERE repo_id = ? AND epoch = ?')
      .bind(repo.id, state!.epoch)
      .first<{ n: number; d: number }>();
    expect(seqs).toEqual({ n: 20, d: 20 });
  });

  it('answers an empty repository with an empty, complete history', async () => {
    await seedRepo('empty');
    const r = await get(H('empty', 'path=a.txt'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ headSha: null, commits: [], index: { complete: true } });
  });

  it('validates input and conceals private repositories', async () => {
    const repo = await seedRepo('valid');
    const { shas } = await linear(repo, 2);
    await setMain(repo, shas[1]!);
    expect((await get(`/api/v1/repos/${OWNER}/valid/history`)).json.code).toBe('INVALID_PATH');
    expect((await get(H('valid', 'path=a&limit=0'))).json.code).toBe('INVALID_LIMIT');
    expect((await get(H('valid', 'path=a&limit=101'))).json.code).toBe('INVALID_LIMIT');
    expect((await get(H('valid', 'path=a&cursor=%%%'))).json.code).toBe('INVALID_CURSOR');
    const hidden = await get(H('valid', 'path=f0.txt'), tok.outsider);
    expect(hidden.status).toBe(404);
    expect(hidden.cost.art).toBe(0);
  });

  it('serves no history for a deleted default branch', async () => {
    const repo = await seedRepo('deleted');
    const { shas } = await linear(repo, 3);
    await setMain(repo, shas[2]!);
    await settle('deleted', 'f0.txt');
    repo.fake.refs.delete('refs/heads/main');
    await bumpRefGeneration(repo.id);
    const r = await get(H('deleted', 'path=f0.txt'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ headSha: null, commits: [], nextCursor: null, index: { gaps: 0, complete: true } });
  });

  it('does not let a cached head mask a deletion the push ledger has recorded', async () => {
    const repo = await seedRepo('deleted-cached');
    const { shas } = await linear(repo, 3);
    await setMain(repo, shas[2]!);
    await settle('deleted-cached', 'f0.txt');
    // Deleted elsewhere: this location's ref cache still answers the old head, the ledger knows.
    const gen = await refGeneration(repo.id);
    await writeJson(compareKeys.ref(repo.id, gen, 'refs/heads/main'), JSON.stringify({ sha: shas[2], tree: treeOf(repo, shas[2]!) }));
    repo.fake.refs.delete('refs/heads/main');
    await env.DB.prepare(
      `INSERT INTO repo_refs (repo_id, ref, sha, event_id, event_at, updated_at) VALUES (?, 'refs/heads/main', ?, 'evt-delete', ?, ?)`,
    )
      .bind(repo.id, '0'.repeat(40), Date.now(), Date.now())
      .run();
    const r = await get(H('deleted-cached', 'path=f0.txt'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ headSha: null, commits: [], index: { complete: true } });
  });

  it('keeps the index when a stale cached head is older than the indexed one', async () => {
    const repo = await seedRepo('stale-head');
    const { shas, tree } = await linear(repo, 3);
    const more = await linear(repo, 2, 3, [shas[2]!], 'w', tree);
    const head = more.shas[1]!;
    await setMain(repo, head);
    await settle('stale-head', 'f0.txt');
    // This colo's ref cache still answers an older head (another colo indexed the newer one).
    const gen = await refGeneration(repo.id);
    await writeJson(compareKeys.ref(repo.id, gen, 'refs/heads/main'), JSON.stringify({ sha: shas[2], tree: treeOf(repo, shas[2]!) }));
    const r = await get(H('stale-head', 'path=f0.txt'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ headSha: head, index: { epoch: 1, indexedHead: head, complete: true } });
  });

  it('answers 503 and records nothing when a tree is missing, instead of indexing it as empty', async () => {
    const repo = await seedRepo('missing-tree');
    const { shas } = await linear(repo, 3, 3);
    await setMain(repo, shas[2]!);
    repo.fake.objects.delete(treeOf(repo, shas[1]!));
    const r = await get(H('missing-tree', 'path=f0.txt'));
    expect([r.status, r.json.code]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    const state = await env.DB.prepare('SELECT COUNT(*) AS n FROM path_history_commits WHERE repo_id = ?').bind(repo.id).first<{ n: number }>();
    expect(state!.n).toBe(0);
  });

  it('ends the backward walk as one gap when the tail commit cannot be followed, instead of stalling', async () => {
    const repo = await seedRepo('lost-tail');
    const n = HISTORY_LIMITS.commitsPerStep + 10;
    const { shas } = await linear(repo, n, 2);
    await setMain(repo, shas[n - 1]!);
    const first = await get(H('lost-tail', 'path=f0.txt'));
    expect(first.json.index).toMatchObject({ rootReached: false, progressed: true });
    // The next commit the backward walk needs is gone.
    repo.fake.objects.delete(shas[9]!);
    const second = await get(H('lost-tail', 'path=f0.txt'));
    expect(second.status).toBe(200);
    expect(second.json.index).toMatchObject({ rootReached: true, gaps: 1, complete: false, progressed: true });
    const third = await get(H('lost-tail', 'path=f0.txt'));
    expect(third.json.index).toMatchObject({ rootReached: true, gaps: 1, progressed: false });
  });

  it('ends the walk as one gap when the binding reports the tail commit missing, and answers 503 for a transient failure', async () => {
    const repo = await seedRepo('missing-tail');
    const n = HISTORY_LIMITS.commitsPerStep + 10;
    const { shas } = await linear(repo, n, 2);
    await setMain(repo, shas[n - 1]!);
    await get(H('missing-tail', 'path=f0.txt'));
    // A transient head-commit read failure is retryable and records nothing.
    const fresh = await linear(repo, 1, 2, [shas[n - 1]!], 'w');
    await setMain(repo, fresh.shas[0]!);
    repo.fake.hook = async (call) => {
      if (call === `readCommit:${fresh.shas[0]}`) throw new Error('upstream 502');
    };
    const flaky = await get(H('missing-tail', 'path=f0.txt'));
    expect([flaky.status, flaky.json.code]).toEqual([503, 'STORAGE_UNAVAILABLE']);
    repo.fake.hook = null;
    repo.fake.logNotFound.add(shas[9]!);
    const r = await get(H('missing-tail', 'path=f0.txt'));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.index).toMatchObject({ indexedHead: fresh.shas[0], rootReached: true, gaps: 1, complete: false });
  });

  it('records many long paths in byte-bounded statements and skips paths no query can name', async () => {
    const repo = await seedRepo('long-paths');
    const files: Files = {};
    for (let i = 0; i < 300; i++) files[`${'d'.repeat(250)}/f${i}.txt`] = `${i}\n`;
    files[`${'x'.repeat(HISTORY_LIMITS.maxPathBytes + 1)}`] = 'too long\n';
    const c = await commit(repo.fake, files);
    await setMain(repo, c.sha);
    const r = await settle('long-paths', `${'d'.repeat(250)}/f299.txt`);
    expect(r.json.commits.map((x: any) => x.sha)).toEqual([c.sha]);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM path_history WHERE repo_id = ?').bind(repo.id).first<{ n: number }>();
    expect(rows!.n).toBe(300);
  });

  it('is removed with the repository', async () => {
    const repo = await seedRepo('cleanup');
    const { shas } = await linear(repo, 3);
    await setMain(repo, shas[2]!);
    await settle('cleanup', 'f0.txt');
    await env.DB.batch(historyCleanupStatements(env.DB, repo.id));
    for (const table of ['path_history', 'path_history_commits', 'path_history_state']) {
      const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id = ?`).bind(repo.id).first<{ n: number }>();
      expect(row!.n, table).toBe(0);
    }
  });
});
