/**
 * PathHistory Durable Object integration: first-parent indexing, cold/warm
 * reads, concurrent activation, push wakeups, and access validation.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { bumpRefGeneration } from '../src/cache/compare';
import { PathHistory } from '../src/do/pathHistory';
import { call } from './helpers/http';
import { commit, fakeArtifacts, installFakeGitRemote, restoreFetch, type FakeRepo, type Files } from './helpers/fakeArtifacts';
import { seedRepo, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const OWNER = 'history-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
let token = '';
let repoIds: Record<string, string> = {};

beforeAll(async () => {
  installFakeGitRemote();
  token = (await mintPAT(env, await seedUser(env, OWNER), 'owner', FULL)).token;
});

afterAll(() => restoreFetch());

async function createRepo(name: string, visibility: 'private' | 'public' = 'private'): Promise<{ id: string; fake: FakeRepo }> {
  const seeded = await seedRepo(env, name, { owner: OWNER, visibility, repoIds });
  const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(seeded.id));
  await runInDurableObject(stub, async (object) => {
    (object as unknown as { artifacts: Artifacts }).artifacts = fakeArtifacts;
  });
  return { id: seeded.id, fake: seeded.repo };
}

async function setMain(repo: { id: string; fake: FakeRepo }, sha: string): Promise<void> {
  repo.fake.refs.set('refs/heads/main', sha);
  await bumpRefGeneration(repo.id);
}

async function linear(repo: { fake: FakeRepo }, count: number, files = 3): Promise<string[]> {
  const tree: Files = {};
  const shas: string[] = [];
  let parent: string[] = [];
  for (let i = 0; i < count; i++) {
    tree[`f${i % files}.txt`] = `${i}\n`;
    const result = await commit(repo.fake, { ...tree }, parent);
    shas.push(result.sha);
    parent = [result.sha];
  }
  return shas;
}

const historyPath = (name: string, query: string) => `/api/v1/repos/${OWNER}/${name}/history?${query}`;
const history = (name: string, query: string, authToken = token) =>
  call(env, 'GET', historyPath(name, query), { token: authToken });

async function settle(repo: { id: string }, name: string, path: string) {
  let result = await history(name, `path=${encodeURIComponent(path)}&limit=100`);
  const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
  for (let i = 0; i < 20 && result.status === 200 && !result.json.index?.rootReached; i++) {
    await runDurableObjectAlarm(stub);
    result = await history(name, `path=${encodeURIComponent(path)}&limit=100`);
  }
  return result;
}

describe('GET /repos/:owner/:repo/history', () => {
  it('indexes a short first-parent history and reads the warm page from the DO', async () => {
    const repo = await createRepo('short');
    const shas = await linear(repo, 4);
    await setMain(repo, shas[3]!);

    const cold = await history('short', 'path=f0.txt');
    expect(cold.status).toBe(200);
    expect(cold.json.commits.map((entry: { sha: string }) => entry.sha)).toEqual([shas[3], shas[0]]);
    expect(cold.json.index).toMatchObject({ current: true, rootReached: true, complete: true });
    expect(cold.cost).toMatchObject({ d1: 1, art: 3, do: 1, sub: 1 });

    const before = repo.fake.calls.length;
    const warm = await history('short', 'path=f0.txt');
    expect(warm.status).toBe(200);
    expect(warm.cost).toMatchObject({ do: 1 });
    expect(repo.fake.calls.length).toBe(before);
    expect(warm.cost).toMatchObject({ d1: 1, art: 0, do: 1, sub: 0 });
  });

  it('coalesces concurrent cold reads and deduplicates tree hashes', async () => {
    const repo = await createRepo('concurrent');
    const shas = await linear(repo, 24);
    await setMain(repo, shas.at(-1)!);
    const results = await Promise.all(Array.from({ length: 10 }, () => history('concurrent', 'path=f0.txt')));
    expect(results.every((result) => result.status === 200)).toBe(true);
    const reads = repo.fake.calls.filter((entry) => entry.startsWith('readTree:'));
    expect(reads).toHaveLength(24);
    const byHash = new Map<string, number>();
    for (const read of reads) byHash.set(read.slice('readTree:'.length), (byHash.get(read.slice('readTree:'.length)) ?? 0) + 1);
    expect(byHash.size).toBe(24);
    expect(Math.max(...byHash.values())).toBe(1);
    expect(results.filter((result) => result.json.index.progressed).length).toBeLessThanOrEqual(1);
    const logs = repo.fake.calls.filter((entry) => entry.startsWith('log:'));
    expect(logs).toHaveLength(2);
    expect(new Set(logs).size).toBe(logs.length);
  });

  it('reads a 2,500-commit chain in three retained log windows', async () => {
    const repo = await createRepo('long');
    const shas = await linear(repo, 2500, 10);
    await setMain(repo, shas.at(-1)!);
    const result = await settle(repo, 'long', 'f0.txt');
    expect(result.status).toBe(200);
    expect(result.json.index).toMatchObject({ current: true, rootReached: true, complete: true });
    const indexWindows = repo.fake.calls.filter((entry) => /^log:[0-9a-f]{40}$/.test(entry)).length;
    expect(indexWindows).toBe(3);
  }, 60_000);

  it('rebuilds a rewritten branch in a new epoch and rejects old cursors', async () => {
    const repo = await createRepo('rewrite');
    const old = await linear(repo, 12, 1);
    await setMain(repo, old.at(-1)!);
    const first = await history('rewrite', 'path=f0.txt&limit=5');
    const oldCursor = first.json.nextCursor as string;
    expect(oldCursor).toEqual(expect.any(String));
    const oldEpoch = first.json.index.epoch as number;
    const fresh = await linear(repo, 3, 1);
    await setMain(repo, fresh.at(-1)!);
    const rebuilt = await settle(repo, 'rewrite', 'f0.txt');
    expect(rebuilt.json.index.epoch).toBeGreaterThan(oldEpoch);
    expect(rebuilt.json.commits.map((entry: { sha: string }) => entry.sha)).toEqual([...fresh].reverse());
    expect((await history('rewrite', `path=f0.txt&cursor=${encodeURIComponent(oldCursor)}`)).json.code).toBe('STALE_CURSOR');
  });

  it('follows a push effect before the next read and does not query Artifacts while serving it', async () => {
    const repo = await createRepo('forward');
    const initial = await linear(repo, 3);
    await setMain(repo, initial.at(-1)!);
    await settle(repo, 'forward', 'f0.txt');
    const child = await commit(repo.fake, { 'f0.txt': 'next\n', 'f1.txt': 'next\n', 'f2.txt': 'next\n' }, [initial.at(-1)!]);
    await setMain(repo, child.sha);
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    expect(await stub.pushed({ ref: 'refs/heads/main', after: child.sha, eventAt: Date.now() + 1000 })).toBe('indexed');
    await runDurableObjectAlarm(stub);
    const state = await runInDurableObject(stub, async (_obj: PathHistory, storage) =>
      storage.storage.sql.exec<{ known_sha: string; head_sha: string }>('SELECT known_sha,head_sha FROM state').toArray()[0],
    );
    expect(state).toMatchObject({ known_sha: child.sha, head_sha: child.sha });
    const before = repo.fake.calls.length;
    const result = await stub.query({ repoName: `${OWNER}--forward`, ref: 'refs/heads/main', path: 'f0.txt', limit: 30, cursor: null, cachedHead: child.sha });
    expect(result.value?.index).toMatchObject({ indexedHead: child.sha, current: true });
    expect(repo.fake.calls.slice(before)).toEqual([]);
  });

  it('memoizes a cached-head disagreement for five reads', async () => {
    const repo = await createRepo('memo');
    const old = (await linear(repo, 1))[0]!;
    await setMain(repo, old);
    await settle(repo, 'memo', 'f0.txt');
    const fresh = (await commit(repo.fake, { 'f0.txt': 'new\n' }, [old])).sha;
    repo.fake.refs.set('refs/heads/main', fresh);
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    await stub.pushed({ ref: 'refs/heads/main', after: fresh, eventAt: Date.now() + 1000 });
    await runDurableObjectAlarm(stub);
    repo.fake.calls.length = 0;
    const query = () => stub.query({
      repoName: `${OWNER}--memo`, ref: 'refs/heads/main', path: 'f0.txt', limit: 30, cursor: { epoch: 1, seq: 0 }, cachedHead: old,
    });
    for (let i = 0; i < 5; i++) await query();
    expect(repo.fake.calls.filter((entry) => entry === 'log:main')).toEqual(['log:main']);
  });

  it('does not record missing trees and retains the indexing error', async () => {
    const repo = await createRepo('missing-tree');
    const head = (await commit(repo.fake, { 'f0.txt': 'one\n' })).sha;
    for (const [hash, object] of repo.fake.objects) if (object.type === 'tree') repo.fake.objects.delete(hash);
    await setMain(repo, head);
    const result = await history('missing-tree', 'path=f0.txt');
    expect(result.status).toBe(200);
    expect(result.json.index).toMatchObject({ complete: false, rootReached: false });
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    const state = await runInDurableObject(stub, async (_obj: PathHistory, storage) =>
      storage.storage.sql.exec<{ last_error: string; count: number }>('SELECT last_error,(SELECT COUNT(*) FROM commits) AS count FROM state').toArray()[0],
    );
    expect(state?.last_error).toBeTruthy();
    expect(state?.count).toBe(0);
  });

  it('omits paths whose UTF-8 encoding exceeds the indexing limit', async () => {
    const repo = await createRepo('long-path');
    const tooLong = 'x'.repeat(4097);
    const head = (await commit(repo.fake, { 'ok.txt': 'ok\n', [tooLong]: 'ignored\n' })).sha;
    await setMain(repo, head);
    await settle(repo, 'long-path', 'ok.txt');
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    const paths = await runInDurableObject(stub, async (_obj: PathHistory, storage) =>
      storage.storage.sql.exec<{ path: string }>('SELECT path FROM paths').toArray(),
    );
    expect(paths.map((row) => row.path)).toEqual(['ok.txt']);
  });

  it('records one gap when the indexed first-parent tail has disappeared', async () => {
    const repo = await createRepo('lost-tail');
    const missing = 'a'.repeat(40);
    const head = (await commit(repo.fake, { 'f0.txt': 'one\n' }, [missing])).sha;
    await setMain(repo, head);
    const result = await history('lost-tail', 'path=f0.txt');
    expect(result.json.index).toMatchObject({ indexedHead: head, rootReached: true, gaps: 1, complete: false });
  });

  it('does not activate or write storage when a never-queried repository is pushed', async () => {
    const repo = await createRepo('push-only');
    const sha = (await linear(repo, 1))[0]!;
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    expect(await stub.pushed({ ref: 'refs/heads/main', after: sha, eventAt: Date.now() })).toBe('not indexed');
    const rows = await runInDurableObject(stub, async (_obj: PathHistory, state) => state.storage.sql.exec('SELECT COUNT(*) AS n FROM state').toArray()[0]);
    expect(rows).toMatchObject({ n: 0 });
  });

  it('answers empty histories for an empty or deleted default branch', async () => {
    await createRepo('empty');
    const emptyResult = await history('empty', 'path=f0.txt');
    expect(emptyResult.json).toMatchObject({ headSha: null, commits: [], index: { complete: true } });
    const populated = await createRepo('deleted');
    const [head] = await linear(populated, 1);
    await setMain(populated, head!);
    await settle(populated, 'deleted', 'f0.txt');
    populated.fake.refs.delete('refs/heads/main');
    await bumpRefGeneration(populated.id);
    expect((await history('deleted', 'path=f0.txt')).json).toMatchObject({ headSha: null, commits: [], index: { complete: true } });
  });

  it('destroys the per-repository SQLite index during cleanup', async () => {
    const repo = await createRepo('cleanup');
    const [head] = await linear(repo, 2);
    await setMain(repo, head!);
    await settle(repo, 'cleanup', 'f0.txt');
    const stub = env.PATH_HISTORY.get(env.PATH_HISTORY.idFromName(repo.id));
    await stub.destroy();
    const tables = await runInDurableObject(stub, async (_obj: PathHistory, state) => state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray());
    expect(tables).toEqual([]);
  });

  it('retains private-repository concealment and request validation', async () => {
    await createRepo('private');
    const outsider = (await mintPAT(env, await seedUser(env, 'history-outsider'), 'outsider', FULL)).token;
    const denied = await history('private', 'path=f0.txt', outsider);
    expect(denied.status).toBe(404);
    expect(denied.cost).toMatchObject({ do: 0, art: 0 });
    expect((await history('private', 'path=')).json.code).toBe('INVALID_PATH');
    expect((await history('private', 'path=f0.txt&limit=0')).json.code).toBe('INVALID_LIMIT');
    expect((await history('private', 'path=f0.txt&cursor=bad')).json.code).toBe('INVALID_CURSOR');
  });
});
