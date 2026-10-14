/**
 * REST tree and file reads (routes/api/contents.ts), the endpoints the MCP
 * get_tree and read_file tools map onto. The shared authority lookup runs
 * first; content comes from the in-memory Artifacts fake.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { blobHash, commit, fakeArtifacts } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts } as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'contents-owner';
const tok = { owner: '', outsider: '' };
const shas = { main: '', feature: '' };
const BINARY = new Uint8Array([0, 1, 2, 255, 254, 10]);

const seedUser = (login: string) => seedUserBase(env, login);
const seedRepo = async (name: string, visibility: 'public' | 'private') =>
  (await seedRepoBase(env, name, { owner: OWNER, visibility })).repo;
const get = async (path: string, token?: string) => {
  const r = await apiCall(env, 'GET', path, { token });
  return { status: r.status, json: r.json, cost: r.cost };
};

const r = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;

beforeAll(async () => {
  const ownerId = await seedUser(OWNER);
  const outsiderId = await seedUser('contents-outsider');
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', FULL)).token;
  for (const [name, vis] of [['priv', 'private'], ['pub', 'public']] as const) {
    const repo = await seedRepo(name, vis);
    const main = await commit(repo, {
      'README.md': 'hello\nworld\n',
      'bin/run.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' },
      'src/a.ts': 'export const a = 1;\n',
      'src/lib/b.ts': 'export const b = 2;\n',
      'logo.bin': BINARY,
    });
    const feature = await commit(repo, { 'README.md': 'feature\n' }, [main.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/feature/x', feature.sha);
    if (name === 'priv') {
      shas.main = main.sha;
      shas.feature = feature.sha;
    }
  }
});

describe('GET /repos/:o/:r/tree', () => {
  it('lists the root at the default branch like git ls-tree', async () => {
    const res = await get(r('priv', '/tree'), tok.owner);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.ref).toBe('main');
    expect(res.json.sha).toBe(shas.main);
    expect(res.json.path).toBe('');
    const entries = res.json.entries as Array<{ name: string; path: string; type: string; mode: string; hash: string }>;
    expect(entries.map((e) => [e.name, e.type, e.mode])).toEqual([
      ['README.md', 'blob', '100644'],
      ['bin', 'tree', '040000'],
      ['logo.bin', 'blob', '100644'],
      ['src', 'tree', '040000'],
    ]);
    expect(entries.find((e) => e.name === 'README.md')?.hash).toBe(await blobHash('hello\nworld\n'));
    expect(res.cost.d1).toBe(1);
  });

  it('lists a subdirectory at a named ref with full entry paths', async () => {
    const res = await get(r('priv', '/tree?path=src&ref=main'), tok.owner);
    expect(res.status).toBe(200);
    expect(res.json.path).toBe('src');
    expect(res.json.entries.map((e: { path: string; type: string }) => [e.path, e.type])).toEqual([
      ['src/a.ts', 'blob'],
      ['src/lib', 'tree'],
    ]);
    const bin = await get(r('priv', '/tree?path=bin/'), tok.owner);
    expect(bin.json.entries.map((e: { name: string; mode: string }) => [e.name, e.mode])).toEqual([['run.sh', '100755']]);
  });

  it('resolves a branch whose name contains a slash and a commit SHA', async () => {
    const byName = await get(r('priv', `/tree?ref=${encodeURIComponent('feature/x')}`), tok.owner);
    expect(byName.status).toBe(200);
    expect(byName.json.sha).toBe(shas.feature);
    expect(byName.json.entries.map((e: { name: string }) => e.name)).toEqual(['README.md']);
    const bySha = await get(r('priv', `/tree?ref=${shas.main}&path=src/lib`), tok.owner);
    expect(bySha.json.entries.map((e: { name: string }) => e.name)).toEqual(['b.ts']);
  });

  it('answers 404 REF_NOT_FOUND for an unknown ref and PATH_NOT_FOUND for a missing or file path', async () => {
    const ref = await get(r('priv', '/tree?ref=nope'), tok.owner);
    expect(ref.status).toBe(404);
    expect(ref.json.code).toBe('REF_NOT_FOUND');
    const missing = await get(r('priv', '/tree?path=nope'), tok.owner);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('PATH_NOT_FOUND');
    const file = await get(r('priv', '/tree?path=README.md'), tok.owner);
    expect(file.status).toBe(404);
    expect(file.json.code).toBe('PATH_NOT_FOUND');
    const bad = await get(r('priv', '/tree?path=../x'), tok.owner);
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('INVALID_PATH');
  });

  it('conceals private repos from outsiders and anonymous callers, and serves public ones to everyone', async () => {
    const outsider = await get(r('priv', '/tree'), tok.outsider);
    expect(outsider.status).toBe(404);
    expect(outsider.json).toEqual({ error: 'not found', code: 'NOT_FOUND' });
    expect(outsider.cost.art).toBe(0);
    expect((await get(r('priv', '/tree'))).status).toBe(404);
    expect((await get(r('pub', '/tree'))).status).toBe(200);
    expect((await get(r('pub', '/tree'), tok.outsider)).status).toBe(200);
  });
});

describe('GET /repos/:o/:r/contents', () => {
  it('returns a text file at a branch byte for byte as utf-8', async () => {
    const res = await get(r('priv', '/contents?path=README.md&ref=main'), tok.owner);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ ref: 'main', path: 'README.md', encoding: 'utf-8', content: 'hello\nworld\n', size: 12 });
    expect(res.cost).toMatchObject({ d1: 1, art: 2, do: 0, r2b: 0 });
  });

  it('defaults to the default branch and reads branch names with slashes', async () => {
    expect((await get(r('priv', '/contents?path=src/a.ts'), tok.owner)).json.content).toBe('export const a = 1;\n');
    const feature = await get(r('priv', `/contents?path=README.md&ref=${encodeURIComponent('feature/x')}`), tok.owner);
    expect(feature.json.content).toBe('feature\n');
  });

  it('returns binary content as base64', async () => {
    const res = await get(r('priv', '/contents?path=logo.bin'), tok.owner);
    expect(res.json.encoding).toBe('base64');
    expect(Uint8Array.from(atob(res.json.content as string), (ch) => ch.charCodeAt(0))).toEqual(BINARY);
    expect(res.json.size).toBe(BINARY.length);
  });

  it('serves a commit-SHA read from the repo-scoped content cache when warm', async () => {
    const path = r('priv', `/contents?path=src/lib/b.ts&ref=${shas.main}`);
    const cold = await get(path, tok.owner);
    expect(cold.status).toBe(200);
    expect(cold.cost.cache).toBe('miss');
    const warm = await get(path, tok.owner);
    expect(warm.json.content).toBe('export const b = 2;\n');
    expect(warm.cost).toMatchObject({ d1: 1, art: 0, cache: 'hit' });
  });

  it('answers 404 FILE_NOT_FOUND for a missing path or ref, and 400 INVALID_PATH without a path', async () => {
    const missing = await get(r('priv', '/contents?path=nope.txt'), tok.owner);
    expect(missing.status).toBe(404);
    expect(missing.json.code).toBe('FILE_NOT_FOUND');
    expect((await get(r('priv', '/contents?path=README.md&ref=nope'), tok.owner)).json.code).toBe('FILE_NOT_FOUND');
    expect((await get(r('priv', '/contents?path=src'), tok.owner)).json.code).toBe('FILE_NOT_FOUND');
    const none = await get(r('priv', '/contents'), tok.owner);
    expect(none.status).toBe(400);
    expect(none.json.code).toBe('INVALID_PATH');
  });

  it('conceals private repo content from outsiders without reading Artifacts', async () => {
    const res = await get(r('priv', '/contents?path=README.md'), tok.outsider);
    expect(res.status).toBe(404);
    expect(res.json).toEqual({ error: 'not found', code: 'NOT_FOUND' });
    expect(res.cost.art).toBe(0);
    expect((await get(r('pub', '/contents?path=README.md'))).json.content).toBe('hello\nworld\n');
  });
});
