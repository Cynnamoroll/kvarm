/**
 * Compare, per-file diff and commit diff routes over an in-memory Artifacts
 * fake. Objects are real git objects (gitops builders), so tree/blob/commit
 * hashes match what git would compute for the same content. Ref names are
 * served through a fake protocol-v2 ls-refs endpoint, counted as subrequests.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FLUSH_PKT,
  buildBlob,
  buildCommit,
  buildTree,
  concat,
  decode,
  parseTree,
  pktLine,
  readPktLines,
  type TreeEntry,
} from '@forge/gitops';
import { getGitToken, purgeGitTokens } from '../src/artifacts/tokens';
import { mintPAT, type Scope } from '../src/auth/pat';
import { bumpRefGeneration, compareKeys, refGeneration } from '../src/cache/compare';
import { COST_HEADER, countingFetch, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { COMPARE_BUDGETS } from '../src/services/compare';
import worker from '../src/index';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// ---------------------------------------------------------------------------
// In-memory Artifacts
// ---------------------------------------------------------------------------

interface Obj {
  type: 'blob' | 'tree' | 'commit';
  content: Uint8Array;
}

class FakeRepo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  failTrees = new Set<string>();
  calls: string[] = [];
}

const repos = new Map<string, FakeRepo>();
const lsRefsCalls: string[] = [];
const originalFetch = globalThis.fetch;

function entryType(mode: string): ArtifactsTreeEntryType {
  if (mode === '40000') return 'tree';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (mode === '100755') return 'exec';
  return 'blob';
}

function parseCommit(content: Uint8Array, hash: string): ArtifactsCommitMetadata {
  const text = decode(content);
  const head = text.slice(0, text.indexOf('\n\n'));
  const tree = /^tree ([0-9a-f]{40})$/m.exec(head)![1]!;
  const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
  const who = { name: 't', email: 't@forge.invalid' };
  return { hash, treeHash: tree, message: 'm', author: who, committer: who, parents, authoredAt: 0, committedAt: 0 };
}

function handle(name: string): ArtifactsRepo {
  const r = repos.get(name);
  if (!r) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  return {
    async readTree(hash: string) {
      r.calls.push(`readTree:${hash}`);
      if (r.failTrees.has(hash)) throw new Error('Too many subrequests by single Worker invocation.');
      const o = r.objects.get(hash);
      if (!o || o.type !== 'tree') return null;
      return parseTree(o.content).map((e) => ({ ...e, type: entryType(e.mode) }));
    },
    async readBlob(hash: string) {
      r.calls.push(`readBlob:${hash}`);
      const o = r.objects.get(hash);
      return o && o.type === 'blob' ? new Blob([o.content]) : null;
    },
    async readCommit(hash: string) {
      r.calls.push(`readCommit:${hash}`);
      const o = r.objects.get(hash);
      return o && o.type === 'commit' ? parseCommit(o.content, hash) : null;
    },
    async log({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) {
      r.calls.push(`log:${ref}`);
      let sha = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : r.refs.get(`refs/heads/${ref}`);
      const out: ArtifactsCommitMetadata[] = [];
      while (sha && out.length < limit) {
        const o = r.objects.get(sha);
        if (!o || o.type !== 'commit') break;
        const c = parseCommit(o.content, sha);
        out.push(c);
        sha = c.parents[0];
      }
      return out;
    },
    async createToken(scope: 'read' | 'write' = 'write', ttl = 86_400) {
      r.calls.push('createToken');
      return { id: 't', plaintext: 'fake-token', scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    },
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

const env = {
  ...baseEnv,
  ARTIFACTS: { get: async (name: string) => handle(name) } as unknown as Artifacts,
} as Env;

/** ls-refs over the fake refs, honoring ref-prefix like git upload-pack v2. */
function lsRefsResponse(repo: FakeRepo, body: Uint8Array): Response {
  const prefixes = readPktLines(body)
    .filter((p) => !p.flush && !p.delim && !p.responseEnd)
    .map((p) => decode(p.data).trim())
    .filter((l) => l.startsWith('ref-prefix '))
    .map((l) => l.slice('ref-prefix '.length));
  const lines = [...repo.refs]
    .filter(([n]) => prefixes.some((p) => n.startsWith(p)))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([n, oid]) => pktLine(`${oid} ${n}\n`));
  return new Response(concat(...lines, FLUSH_PKT), { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
}

// ---------------------------------------------------------------------------
// Repo builder
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
type Files = Record<string, string | Uint8Array | { content: string | Uint8Array; mode: string }>;

async function writeTree(repo: FakeRepo, files: Files): Promise<string> {
  const dirs = new Map<string, Files>();
  const entries: TreeEntry[] = [];
  for (const [path, spec] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash !== -1) {
      const dir = path.slice(0, slash);
      const sub = dirs.get(dir) ?? {};
      sub[path.slice(slash + 1)] = spec;
      dirs.set(dir, sub);
      continue;
    }
    const { content, mode } =
      typeof spec === 'string' || spec instanceof Uint8Array ? { content: spec, mode: '100644' } : spec;
    const bytes = typeof content === 'string' ? enc(content) : content;
    const blob = await buildBlob(bytes);
    repo.objects.set(blob.hash, { type: 'blob', content: bytes });
    entries.push({ mode, name: path, hash: blob.hash });
  }
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, hash: await writeTree(repo, sub) });
  const tree = await buildTree(entries);
  repo.objects.set(tree.hash, { type: 'tree', content: tree.raw.subarray(tree.raw.indexOf(0) + 1) });
  return tree.hash;
}

let clock = 1_700_000_000;
async function commit(repo: FakeRepo, files: Files, parents: string[] = []): Promise<{ sha: string; tree: string }> {
  const tree = await writeTree(repo, files);
  const who = { name: 't', email: 't@forge.invalid', time: clock++ };
  const c = await buildCommit({ tree, parents, author: who, committer: who, message: `c${clock}` });
  repo.objects.set(c.hash, { type: 'commit', content: c.raw.subarray(c.raw.indexOf(0) + 1) });
  return { sha: c.hash, tree };
}

// ---------------------------------------------------------------------------
// Principals, repos and requests
// ---------------------------------------------------------------------------

const OWNER = 'cmp-owner';
const tok = { owner: '', outsider: '', admin: '' };
const repoIds: Record<string, string> = {};

async function seedUser(login: string, admin = false): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, admin ? 1 : 0, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  repos.set(artifactsName, repo);
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

interface Reply {
  status: number;
  text: string;
  json: Record<string, unknown>;
  cost: CostCounters;
  cache: string | null;
  timing: string | null;
}

async function call(path: string, token?: string): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await worker.fetch!(new Request(`${ORIGIN}${path}`, { headers }) as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON (e.g. the generic not-found fallback)
  }
  return { status: res.status, text, json, cost: cost!, cache: res.headers.get('x-forge-cache'), timing: res.headers.get('server-timing') };
}

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}/${rest}`;

interface FileJson {
  path: string;
  status: string;
  oldPath?: string;
  oldHash: string | null;
  newHash: string | null;
  oldMode: string | null;
  newMode: string | null;
  additions?: number;
  deletions?: number;
  binary?: boolean;
  risk: { score: number; tags: string[] };
}

const files = (r: Reply) => r.json.files as FileJson[];

// ---------------------------------------------------------------------------
// Fixture: the contract's compare-fixture shape
// ---------------------------------------------------------------------------

const A_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const A_EDITED = A_LINES.map((l, i) => (i === 19 ? 'line 20 edited' : l));
const fx = {} as {
  root: { sha: string; tree: string };
  main: { sha: string; tree: string };
  feature: { sha: string; tree: string };
};

async function buildCompareFixture(repo: FakeRepo): Promise<void> {
  const mainFiles: Files = {
    'a.txt': `${A_LINES.join('\n')}\n`,
    'keep.txt': 'keep me\n',
  };
  fx.root = await commit(repo, mainFiles);
  const second: Files = {
    ...mainFiles,
    'gone.txt': 'one\ntwo\nthree\n',
    'old-name.txt': 'renamed content\n',
    'script.sh': '#!/bin/sh\necho hi\n',
    'docs/guide.md': 'guide v1\n',
  };
  fx.main = await commit(repo, second, [fx.root.sha]);
  const featureFiles: Files = {
    'a.txt': `${A_EDITED.join('\n')}\n`,
    'keep.txt': 'keep me\n',
    'new.txt': 'brand\nnew\n',
    'image.bin': new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]),
    'new-name.txt': 'renamed content\n',
    'script.sh': { content: '#!/bin/sh\necho hi\n', mode: '100755' },
    'docs/guide.md': 'guide v2\nmore\n',
  };
  fx.feature = await commit(repo, featureFiles, [fx.main.sha]);
  repo.refs.set('refs/heads/main', fx.main.sha);
  repo.refs.set('refs/heads/feature', fx.feature.sha);
}

let fixture: FakeRepo;

beforeAll(async () => {
  const ownerId = await seedUser(OWNER);
  const outsiderId = await seedUser('cmp-outsider');
  const adminId = await seedUser('cmp-admin', true);
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', FULL)).token;
  tok.admin = (await mintPAT(env, adminId, 'admin', FULL)).token;

  fixture = await seedRepo('fixture', 'public');
  await buildCompareFixture(fixture);

  globalThis.fetch = countingFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const m = /^\/git\/default\/(.+)\.git\/git-upload-pack$/.exec(url.pathname);
    const repo = m ? repos.get(m[1]!) : undefined;
    if (!repo || req.headers.get('git-protocol') !== 'version=2') return new Response('bad', { status: 400 });
    lsRefsCalls.push(m![1]!);
    return lsRefsResponse(repo, new Uint8Array(await req.arrayBuffer()));
  }) as typeof fetch);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

describe('compare by branch names', () => {
  it('returns the git-style changed-file list with refs, trees, stats and totals', async () => {
    const r = await call(api('fixture', 'compare/main...feature'));
    expect(r.status, r.text).toBe(200);
    expect(r.json.base).toEqual({ ref: 'main', sha: fx.main.sha, tree: fx.main.tree });
    expect(r.json.head).toEqual({ ref: 'feature', sha: fx.feature.sha, tree: fx.feature.tree });
    expect(r.json.truncated).toBe(false);
    expect(r.json.totalsComplete).toBe(true);
    expect(r.json.truncatedReason).toBeUndefined();
    expect(r.json.statsOmitted).toBeUndefined();
    expect(r.json.nextCursor).toBeUndefined();
    expect(r.json.rating).toMatchObject({ level: 'low' });
    expect(r.cache).toBe('miss');

    const byPath = Object.fromEntries(files(r).map((f) => [f.path, f]));
    expect(files(r).map((f) => f.path)).toEqual([
      'a.txt',
      'docs/guide.md',
      'gone.txt',
      'image.bin',
      'new-name.txt',
      'new.txt',
      'script.sh',
    ]);
    expect(byPath['keep.txt']).toBeUndefined();
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 1, deletions: 1, oldMode: '100644', newMode: '100644' });
    expect(byPath['docs/guide.md']).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(byPath['gone.txt']).toMatchObject({ status: 'removed', newHash: null, newMode: null, additions: 0, deletions: 3 });
    expect(byPath['gone.txt']!.oldPath).toBeUndefined();
    expect(byPath['new.txt']).toMatchObject({ status: 'added', oldHash: null, oldMode: null, additions: 2, deletions: 0 });
    expect(byPath['image.bin']).toMatchObject({ status: 'added', binary: true });
    expect(byPath['image.bin']!.additions).toBeUndefined();
    const rename = byPath['new-name.txt']!;
    expect(rename).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt', additions: 0, deletions: 0 });
    expect(rename.oldHash).toBe(rename.newHash);
    expect(rename.oldMode).toBe(rename.newMode);
    expect(byPath['script.sh']).toMatchObject({ status: 'typechange', oldMode: '100644', newMode: '100755', additions: 0, deletions: 0 });
    expect(byPath['script.sh']!.oldHash).toBe(byPath['script.sh']!.newHash);
    expect(byPath['a.txt']!.oldHash).toBe((await buildBlob(enc(`${A_LINES.join('\n')}\n`))).hash);
    for (const f of files(r)) {
      expect(Object.keys(f.risk).sort()).toEqual(['score', 'tags']);
      expect(Number.isInteger(f.risk.score) && f.risk.score >= 0 && f.risk.score <= 100).toBe(true);
    }
    expect(rename.risk.tags).toContain('mechanical');
    expect(byPath['script.sh']!.risk.tags).toContain('mechanical');

    expect(r.json.totals).toEqual({ files: 7, additions: 1 + 2 + 0 + 2, deletions: 1 + 1 + 3 });
    expect(Number.isInteger(r.json.treeReads)).toBe(true);
    expect(r.json.treeReads as number).toBeGreaterThanOrEqual(2);
    expect(Number.isInteger(r.json.blobReads)).toBe(true);
  });

  it('serves the repeat from the tree-pair cache with an identical body after one authority lookup', async () => {
    const first = await call(api('fixture', 'compare/main...feature'), tok.owner);
    const second = await call(api('fixture', 'compare/main...feature'), tok.owner);
    expect(second.status).toBe(200);
    expect(second.cache).toBe('hit');
    expect(second.text).toBe(first.text);
    expect(second.cost).toMatchObject({ art: 0, sub: 0, do: 0, cache: 'hit' });
    expect(second.cost.d1).toBeLessThanOrEqual(1);
    expect(second.cost.rr).toBeLessThanOrEqual(8);
  });

  it('keys the cache by tree pair: SHAs hit the branch-name entry and re-render the ref fields', async () => {
    const byName = await call(api('fixture', 'compare/main...feature'));
    const bySha = await call(api('fixture', `compare/${fx.main.sha}...${fx.feature.sha}`));
    expect(bySha.status).toBe(200);
    expect(bySha.cache).toBe('hit');
    expect(bySha.json.base).toEqual({ ref: fx.main.sha, sha: fx.main.sha, tree: fx.main.tree });
    expect(bySha.json.head).toEqual({ ref: fx.feature.sha, sha: fx.feature.sha, tree: fx.feature.tree });
    for (const k of ['files', 'totals', 'rating', 'truncated', 'treeReads', 'blobReads']) expect(bySha.json[k]).toEqual(byName.json[k]);
  });

  it('accepts ?order=path with the identical order and rejects unknown orders', async () => {
    const plain = await call(api('fixture', 'compare/main...feature'));
    const ordered = await call(api('fixture', 'compare/main...feature?order=path'));
    expect(files(ordered).map((f) => f.path)).toEqual(files(plain).map((f) => f.path));
    const paths = files(plain).map((f) => f.path);
    expect([...paths].sort()).toEqual(paths);
    expect((await call(api('fixture', 'compare/main...feature?order=size'))).status).toBe(400);
  });

  it('returns an empty list for identical refs', async () => {
    const r = await call(api('fixture', 'compare/main...main'));
    expect(r.status).toBe(200);
    expect(r.json.files).toEqual([]);
    expect(r.json.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
    expect(r.json.truncated).toBe(false);
    expect(r.json.totalsComplete).toBe(true);
  });
});

describe('pagination', () => {
  it('stitches limit/cursor pages to the full list with whole-comparison totals', async () => {
    const full = await call(api('fixture', 'compare/main...feature'));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const q = `limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await call(api('fixture', `compare/main...feature?${q}`));
      expect(page.status, page.text).toBe(200);
      expect(page.json.totals).toEqual(full.json.totals);
      const got = files(page).map((f) => f.path);
      expect(got.length).toBeLessThanOrEqual(3);
      seen.push(...got);
      cursor = page.json.nextCursor as string | undefined;
      if (cursor !== undefined) expect(typeof cursor).toBe('string');
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual(files(full).map((f) => f.path));
  });

  it('rejects malformed cursors and limits', async () => {
    expect((await call(api('fixture', 'compare/main...feature?cursor=nope'))).status).toBe(400);
    expect((await call(api('fixture', 'compare/main...feature?limit=0'))).status).toBe(400);
    expect((await call(api('fixture', 'compare/main...feature?limit=abc'))).status).toBe(400);
  });
});

describe('not found and concealment', () => {
  it('404s unknown refs and repos with an {error} body, and does not route a range without "..."', async () => {
    for (const path of [
      api('fixture', 'compare/main...no-such-branch'),
      api('fixture', 'compare/no-such-branch...feature'),
      api('fixture', `compare/main...${'f'.repeat(40)}`),
      `/api/v1/repos/${OWNER}/no-such-repo/compare/main...feature`,
    ]) {
      const r = await call(path);
      expect(r.status, path).toBe(404);
      expect(typeof r.json.error, path).toBe('string');
    }
    const malformed = await call(api('fixture', 'compare/main'));
    expect(malformed.status).toBe(404);
    expect(malformed.cost.d1).toBe(0);
  });

  it('conceals a private repo from anonymous and outsider callers with the unknown-repo shape', async () => {
    const secret = await seedRepo('secret', 'private');
    const c = await commit(secret, { 'x.txt': 'secret-marker\n' });
    secret.refs.set('refs/heads/main', c.sha);
    const unknown = await call(`/api/v1/repos/${OWNER}/no-such-repo/compare/main...main`);
    for (const token of [undefined, tok.outsider]) {
      const r = await call(api('secret', 'compare/main...main'), token);
      expect(r.status).toBe(404);
      expect(r.text).toBe(unknown.text);
      expect(r.cost).toMatchObject({ art: 0, sub: 0, do: 0 });
    }
    const owner = await call(api('secret', 'compare/main...main'), tok.owner);
    expect(owner.status).toBe(200);
    expect(owner.json.files).toEqual([]);
  });

  it('denies retained warm compare and file-diff bodies right after a direct D1 flip to private', async () => {
    const flip = await seedRepo('flip', 'public');
    const base = await commit(flip, { 'f.txt': 'flip-marker v1\n' });
    const head = await commit(flip, { 'f.txt': 'flip-marker v2\n' }, [base.sha]);
    flip.refs.set('refs/heads/main', base.sha);
    flip.refs.set('refs/heads/next', head.sha);
    const paths = [api('flip', 'compare/main...next'), api('flip', 'compare/main...next/file?path=f.txt')];
    for (const p of paths) {
      expect((await call(p)).status).toBe(200);
      const warm = await call(p);
      expect(warm.cache, p).toBe('hit');
      expect(warm.text).toContain('f.txt');
    }
    await env.DB.prepare('UPDATE repos SET visibility = ? WHERE id = ?').bind('private', repoIds.flip).run();
    const unknown = await call(`/api/v1/repos/${OWNER}/no-such-repo/compare/main...next`);
    for (const p of paths) {
      for (const token of [undefined, tok.outsider]) {
        const r = await call(p, token);
        expect(r.status, p).toBe(404);
        expect(r.text).toBe(unknown.text);
        expect(r.text).not.toContain('f.txt');
        expect(r.cost).toMatchObject({ art: 0, sub: 0, do: 0, cache: 'none' });
        expect(r.cost.d1).toBeLessThanOrEqual(1);
      }
      const owner = await call(p, tok.owner);
      expect(owner.status, p).toBe(200);
      expect(owner.cache).toBe('hit');
      expect(owner.cost).toMatchObject({ art: 0, sub: 0, do: 0 });
      expect(owner.cost.d1).toBeLessThanOrEqual(1);
    }
  });
});

describe('cost, cache and the admin bypass', () => {
  it('honors ?nocache=1 only for admins: bypass writes nothing, then miss, then hit', async () => {
    const fresh = await seedRepo('bypass', 'public');
    const b = await commit(fresh, { 'n.txt': 'one\n' });
    const h = await commit(fresh, { 'n.txt': 'one\ntwo\n' }, [b.sha]);
    fresh.refs.set('refs/heads/main', b.sha);
    fresh.refs.set('refs/heads/topic', h.sha);
    const path = api('bypass', 'compare/main...topic');

    for (const token of [undefined, tok.outsider]) {
      const r = await call(`${path}?nocache=1`, token);
      expect(r.status).toBe(200);
      expect(r.cache).not.toBe('bypass');
    }
    // The non-admin requests above were normal ones: clear what they cached.
    await caches.default.delete(compareKeys.treediff(b.tree, h.tree));

    const bypass = await call(`${path}?nocache=1`, tok.admin);
    expect(bypass.status).toBe(200);
    expect(bypass.cache).toBe('bypass');
    expect(bypass.timing).toMatch(/^auth;dur=\d+, refs;dur=\d+, diff;dur=\d+$/);
    expect(bypass.cost.cache).toBe('bypass');
    expect(await caches.default.match(compareKeys.treediff(b.tree, h.tree))).toBeUndefined();
    const miss = await call(path, tok.admin);
    expect(miss.cache).toBe('miss');
    expect(miss.cost.cache).toBe('miss');
    const hit = await call(path, tok.admin);
    expect(hit.cache).toBe('hit');
    expect(hit.text).toBe(miss.text);
  });

  it('reads no warm cache entry of any kind under ?nocache=1: commit, numstat, risk, ref, compare and file diff', async () => {
    const warm = await seedRepo('nocache-warm', 'public');
    const pkgOld = '{"dependencies":{"hono":"^4"}}\n';
    const pkgNew = '{"dependencies":{"hono":"^4","left-pad":"1"}}\n';
    const b = await commit(warm, { 'a.txt': 'one\ntwo\n', 'package.json': pkgOld });
    const h = await commit(warm, { 'a.txt': 'one\nTWO\nthree\n', 'package.json': pkgNew }, [b.sha]);
    warm.refs.set('refs/heads/main', b.sha);
    warm.refs.set('refs/heads/topic', h.sha);
    const path = api('nocache-warm', 'compare/main...topic');
    const normal = await call(path);
    expect(normal.cache).toBe('miss');
    const real = files(normal);
    const aTxt = real.find((f) => f.path === 'a.txt')!;
    expect([aTxt.additions, aTxt.deletions]).toEqual([2, 1]);

    // Poison every warm entry a bypass could read; a read would surface in the response.
    const repoId = repoIds['nocache-warm']!;
    const poisonCommit = JSON.stringify({ tree: EMPTY_TREE, parents: [] });
    const put = (k: Request, body: string) => caches.default.put(k, new Response(body, { headers: { 'cache-control': 'max-age=3600' } }));
    await put(compareKeys.commit(repoId, b.sha), poisonCommit);
    await put(compareKeys.commit(repoId, h.sha), poisonCommit);
    await put(compareKeys.numstat(aTxt.oldHash, aTxt.newHash), JSON.stringify({ additions: 999, deletions: 999 }));
    await put(compareKeys.risk(b.tree, h.tree), JSON.stringify({ files: real.map(() => ({ score: 99, tags: ['poison'] })), rating: { score: 99, level: 'high', reasons: ['poison'] } }));
    await put(compareKeys.filediff(aTxt.oldHash, aTxt.newHash), JSON.stringify({ hunks: [], approximate: false, totalAdditions: 999, totalDeletions: 999 }));
    const gen = await refGeneration(repoId);
    await put(compareKeys.ref(repoId, gen, 'main'), JSON.stringify({ sha: h.sha, tree: h.tree }));

    const mark = warm.calls.length;
    const bypass = await call(`${path}?nocache=1`, tok.admin);
    expect(bypass.status, bypass.text).toBe(200);
    expect(bypass.cache).toBe('bypass');
    expect(bypass.json.base).toEqual({ ref: 'main', sha: b.sha, tree: b.tree });
    expect(bypass.json.head).toEqual({ ref: 'topic', sha: h.sha, tree: h.tree });
    expect(bypass.json.files).toEqual(normal.json.files);
    expect(bypass.json.rating).toEqual(normal.json.rating);
    const since = warm.calls.slice(mark);
    expect(since).toContain(`log:${h.sha}`);
    // Every changed blob is read again: no numstat entry served the line counts.
    expect(since.filter((c) => c.startsWith('readBlob')).length).toBe(4);
    expect(bypass.json.blobReads).toBe(4);

    const fileBypass = await call(api('nocache-warm', 'compare/main...topic/file?path=a.txt&nocache=1'), tok.admin);
    expect(fileBypass.cache).toBe('bypass');
    expect(fileBypass.json).toMatchObject({ totalAdditions: 2, totalDeletions: 1 });

    const commitBypass = await call(api('nocache-warm', `commits/${h.sha}/diff?nocache=1`), tok.admin);
    expect(commitBypass.cache).toBe('bypass');
    expect(commitBypass.json.base).toEqual({ ref: b.sha, sha: b.sha, tree: b.tree });
    expect(commitBypass.json.files).toEqual(normal.json.files);
  });

  it('writes no cache entry of any kind under ?nocache=1', async () => {
    const clean = await seedRepo('nocache-clean', 'public');
    const b = await commit(clean, { 'a.txt': 'alpha\n', 'package.json': '{"dependencies":{}}\n' });
    const h = await commit(clean, { 'a.txt': 'alpha\nbeta\n', 'package.json': '{"dependencies":{"x":"1"}}\n' }, [b.sha]);
    clean.refs.set('refs/heads/main', b.sha);
    clean.refs.set('refs/heads/topic', h.sha);
    const repoId = repoIds['nocache-clean']!;
    const blobs = async (text: string) => (await buildBlob(enc(text))).hash;
    const aOld = await blobs('alpha\n');
    const aNew = await blobs('alpha\nbeta\n');
    const gen = await refGeneration(repoId);
    const keys = () => [
      compareKeys.treediff(b.tree, h.tree),
      compareKeys.risk(b.tree, h.tree),
      compareKeys.commit(repoId, b.sha),
      compareKeys.commit(repoId, h.sha),
      compareKeys.numstat(aOld, aNew),
      compareKeys.filediff(aOld, aNew),
      compareKeys.ref(repoId, gen, 'main'),
      compareKeys.ref(repoId, gen, 'topic'),
    ];
    for (const p of ['compare/main...topic?nocache=1', 'compare/main...topic/file?path=a.txt&nocache=1', `commits/${h.sha}/diff?nocache=1`]) {
      const r = await call(api('nocache-clean', p), tok.admin);
      expect(r.status, p).toBe(200);
      expect(r.cache, p).toBe('bypass');
    }
    for (const k of keys()) expect(await caches.default.match(k), k.url).toBeUndefined();
  });

  it('keeps a cold bypass compare within art <= treeReads + blobReads + 3 and d1 <= 2', async () => {
    await call(api('fixture', 'compare/main...feature'));
    const r = await call(api('fixture', 'compare/main...feature?nocache=1'), tok.admin);
    expect(r.status).toBe(200);
    expect(r.cache).toBe('bypass');
    const treeReads = r.json.treeReads as number;
    const blobReads = r.json.blobReads as number;
    expect(Number.isInteger(treeReads) && treeReads >= 1).toBe(true);
    expect(Number.isInteger(blobReads) && blobReads >= 0).toBe(true);
    expect(r.cost.art).toBeLessThanOrEqual(treeReads + blobReads + 3);
    expect(r.cost.d1).toBeLessThanOrEqual(2);
    expect(r.cost.do).toBe(0);
    expect(r.cost.sub).toBeLessThanOrEqual(1);
  });

  it('opens one repo handle for a fully cold compare and reads each changed tree once', async () => {
    const cold = await seedRepo('cold', 'public');
    const b = await commit(cold, { 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'top.txt': 't\n' });
    const h = await commit(cold, { 'src/a.ts': 'a2\n', 'src/b.ts': 'b\n', 'top.txt': 't\n' }, [b.sha]);
    cold.refs.set('refs/heads/main', b.sha);
    cold.refs.set('refs/heads/x', h.sha);
    const r = await call(api('cold', 'compare/main...x'));
    expect(r.status).toBe(200);
    expect(r.json.treeReads).toBe(4);
    expect(r.json.blobReads).toBe(2);
    // get + createToken + one log for head and its parent (the base) + 4 readTree + 2 readBlob
    expect(r.cost.art).toBe(9);
    expect(r.cost.art).toBeLessThanOrEqual(4 + 2 + 3);
    expect(r.cost.sub).toBe(1);
    expect(cold.calls.filter((c) => c.startsWith('readTree')).length).toBe(4);
    expect(cold.calls.filter((c) => c.startsWith('log') || c.startsWith('readCommit'))).toEqual([`log:${h.sha}`]);
  });

  it('reads an ancestor base from the head log and a diverged base on its own', async () => {
    const apart = await seedRepo('apart', 'public');
    const one = await commit(apart, { 'p.txt': '1\n' });
    const two = await commit(apart, { 'p.txt': '2\n' }, [one.sha]);
    const three = await commit(apart, { 'p.txt': '3\n' }, [two.sha]);
    apart.refs.set('refs/heads/main', one.sha);
    apart.refs.set('refs/heads/tip', three.sha);
    const r = await call(api('apart', 'compare/main...tip'));
    expect(r.status).toBe(200);
    expect((r.json.base as { tree: string }).tree).toBe(one.tree);
    expect((r.json.head as { tree: string }).tree).toBe(three.tree);
    const commitReads = (from: number) => apart.calls.slice(from).filter((c) => c.startsWith('log') || c.startsWith('readCommit'));
    expect(commitReads(0)).toEqual([`log:${three.sha}`]);

    // A base off the head's first-parent chain costs its own readCommit.
    const four = await commit(apart, { 'p.txt': '4\n' }, [one.sha]);
    const five = await commit(apart, { 'p.txt': '5\n' }, [two.sha]);
    apart.refs.set('refs/heads/other', four.sha);
    apart.refs.set('refs/heads/side', five.sha);
    const mark = apart.calls.length;
    const diverged = await call(api('apart', 'compare/other...side'));
    expect((diverged.json.base as { tree: string }).tree).toBe(four.tree);
    expect((diverged.json.head as { tree: string }).tree).toBe(five.tree);
    expect(commitReads(mark).sort()).toEqual([`log:${five.sha}`, `readCommit:${four.sha}`].sort());

    // The reverse direction (base is the child) still resolves correctly.
    const back = await call(api('apart', 'compare/tip...main'));
    expect((back.json.base as { sha: string }).sha).toBe(three.sha);
    expect((back.json.head as { sha: string }).sha).toBe(one.sha);
  });

  it('keeps a first-ever compare within +3 when the base is not the head parent and the read token is cold', async () => {
    const edge = await seedRepo('edge', 'public');
    const one = await commit(edge, { 'e.txt': '1\n', 'keep.txt': 'k\n' });
    const two = await commit(edge, { 'e.txt': '2\n', 'keep.txt': 'k\n' }, [one.sha]);
    const three = await commit(edge, { 'e.txt': '3\n', 'keep.txt': 'k\n' }, [one.sha]);
    edge.refs.set('refs/heads/main', two.sha);
    edge.refs.set('refs/heads/tip', three.sha);
    // A push through the git gate warms only the write token; the read token stays cold.
    await getGitToken(env, `${OWNER}--edge`, 'write');
    edge.calls.length = 0;
    const r = await call(api('edge', 'compare/main...tip'));
    expect(r.status).toBe(200);
    expect((r.json.base as { sha: string; tree: string })).toMatchObject({ sha: two.sha, tree: two.tree });
    expect((r.json.head as { sha: string; tree: string })).toMatchObject({ sha: three.sha, tree: three.tree });
    expect(files(r).map((f) => [f.path, f.additions, f.deletions])).toEqual([['e.txt', 1, 1]]);
    const treeReads = r.json.treeReads as number;
    const blobReads = r.json.blobReads as number;
    expect(r.cost.art).toBe(1 + edge.calls.length);
    expect(r.cost.art).toBeLessThanOrEqual(treeReads + blobReads + 3);
    expect(r.cost.d1).toBeLessThanOrEqual(2);
    expect(edge.calls).not.toContain('createToken');
  });

  it('keeps a first-ever compare within +3 with no cached token when the base is an older ancestor', async () => {
    const deep = await seedRepo('deep', 'public');
    const one = await commit(deep, { 'd.txt': '1\n', 'keep.txt': 'k\n' });
    const two = await commit(deep, { 'd.txt': '2\n', 'keep.txt': 'k\n' }, [one.sha]);
    const three = await commit(deep, { 'd.txt': '3\n', 'keep.txt': 'k\n' }, [two.sha]);
    deep.refs.set('refs/heads/main', one.sha);
    deep.refs.set('refs/heads/tip', three.sha);
    const r = await call(api('deep', 'compare/main...tip'));
    expect(r.status).toBe(200);
    expect((r.json.base as { sha: string; tree: string })).toMatchObject({ sha: one.sha, tree: one.tree });
    expect((r.json.head as { sha: string; tree: string })).toMatchObject({ sha: three.sha, tree: three.tree });
    expect(deep.calls).toContain('createToken');
    expect(deep.calls.filter((c) => c.startsWith('log') || c.startsWith('readCommit'))).toEqual([`log:${three.sha}`]);
    expect(r.cost.art).toBe(1 + deep.calls.length);
    expect(r.cost.art).toBeLessThanOrEqual((r.json.treeReads as number) + (r.json.blobReads as number) + 3);
  });

  describe('first-ever compare with neither a read nor a write token cached', () => {
    const overhead = (r: Reply) => r.cost.art - (r.json.treeReads as number) - (r.json.blobReads as number);
    const commitCalls = (repo: FakeRepo) => repo.calls.filter((c) => c.startsWith('log') || c.startsWith('readCommit'));

    async function noTokens(name: string): Promise<FakeRepo> {
      const repo = await seedRepo(name, 'public');
      await purgeGitTokens(`${OWNER}--${name}`);
      return repo;
    }

    it('costs exactly +3 for a base on the head first-parent chain', async () => {
      const chain = await noTokens('notoken-chain');
      const one = await commit(chain, { 'c.txt': '1\n' });
      const two = await commit(chain, { 'c.txt': '2\n' }, [one.sha]);
      const three = await commit(chain, { 'c.txt': '3\n' }, [two.sha]);
      chain.refs.set('refs/heads/main', one.sha);
      chain.refs.set('refs/heads/tip', three.sha);
      const r = await call(api('notoken-chain', 'compare/main...tip'));
      expect(r.status).toBe(200);
      expect(chain.calls).toContain('createToken');
      expect(commitCalls(chain)).toEqual([`log:${three.sha}`]);
      expect(r.cost.art).toBe(1 + chain.calls.length);
      expect(overhead(r)).toBe(3);
      expect(r.cost.d1).toBeLessThanOrEqual(2);

      // A bypass recomputes commits too, yet the token minted above keeps it within +3.
      await purgeGitTokens(`${OWNER}--notoken-chain`);
      const mark = chain.calls.length;
      const bypass = await call(api('notoken-chain', 'compare/main...tip?nocache=1'), tok.admin);
      expect(bypass.cache).toBe('bypass');
      expect(chain.calls.slice(mark)).toContain('createToken');
      expect(overhead(bypass)).toBeLessThanOrEqual(3);
    });

    it('costs at most +4 only for a diverged base, and +3 again once a token is cached', async () => {
      const apart = await noTokens('notoken-diverged');
      const one = await commit(apart, { 'v.txt': '1\n' });
      const two = await commit(apart, { 'v.txt': '2\n' }, [one.sha]);
      const three = await commit(apart, { 'v.txt': '3\n' }, [one.sha]);
      apart.refs.set('refs/heads/main', two.sha);
      apart.refs.set('refs/heads/side', three.sha);
      const r = await call(api('notoken-diverged', 'compare/main...side'));
      expect(r.status).toBe(200);
      expect((r.json.base as { sha: string }).sha).toBe(two.sha);
      expect(apart.calls).toContain('createToken');
      expect(commitCalls(apart).sort()).toEqual([`log:${three.sha}`, `readCommit:${two.sha}`].sort());
      expect(r.cost.art).toBe(1 + apart.calls.length);
      expect(overhead(r)).toBe(4);
      expect(r.cost.d1).toBeLessThanOrEqual(2);

      // The same off-chain resolution with the read token now cached is back within +3.
      const mark = apart.calls.length;
      const again = await call(api('notoken-diverged', 'compare/main...side?nocache=1'), tok.admin);
      expect(again.cache).toBe('bypass');
      expect(apart.calls.slice(mark)).not.toContain('createToken');
      expect(overhead(again)).toBeLessThanOrEqual(3);
    });

    it('costs at most +4 for an ancestor beyond the 50-entry head log', async () => {
      const long = await noTokens('notoken-deep');
      let prev = await commit(long, { 'l.txt': '0\n' });
      const first = prev;
      for (let i = 1; i <= 55; i++) prev = await commit(long, { 'l.txt': `${i}\n` }, [prev.sha]);
      long.refs.set('refs/heads/main', first.sha);
      long.refs.set('refs/heads/tip', prev.sha);
      const r = await call(api('notoken-deep', 'compare/main...tip'));
      expect(r.status).toBe(200);
      expect((r.json.base as { sha: string }).sha).toBe(first.sha);
      expect(commitCalls(long).sort()).toEqual([`log:${prev.sha}`, `readCommit:${first.sha}`].sort());
      expect(overhead(r)).toBe(4);
    });
  });

  it('reports treeReads and blobReads that match the fake binding and the meter', async () => {
    const counted = await seedRepo('counted', 'public');
    const b = await commit(counted, {
      'package.json': '{"dependencies":{"hono":"^4"}}\n',
      'test/a.test.ts': "it('a', () => {});\nit('b', () => {});\n",
      'src/x.ts': 'x\n',
      'same.txt': 'same\n',
    });
    const h = await commit(
      counted,
      {
        'package.json': '{"dependencies":{"hono":"^4","left-pad":"1"}}\n',
        'test/a.test.ts': "it('a', () => {});\n",
        'src/x.ts': 'y\n',
        'moved.txt': 'same\n',
      },
      [b.sha],
    );
    counted.refs.set('refs/heads/main', b.sha);
    counted.refs.set('refs/heads/topic', h.sha);
    const reads = (from: number, kind: string) => counted.calls.slice(from).filter((c) => c.startsWith(kind)).length;

    // First-ever: line stats read every changed blob; risk reuses those texts.
    const first = await call(api('counted', 'compare/main...topic'));
    expect(first.status).toBe(200);
    expect(first.json.treeReads).toBe(reads(0, 'readTree'));
    expect(first.json.blobReads).toBe(reads(0, 'readBlob'));
    expect(first.json.blobReads).toBe(7);
    // The meter's art is exactly get + every handle RPC.
    expect(first.cost.art).toBe(1 + counted.calls.length);
    // Even with a cold upstream token (createToken), base-is-parent keeps the +3 budget.
    expect(counted.calls).toContain('createToken');
    expect(first.cost.art).toBeLessThanOrEqual((first.json.treeReads as number) + (first.json.blobReads as number) + 3);

    // A bypass reads no line-count entry, so it reads every changed blob again
    // (risk still reuses those texts).
    const mark = counted.calls.length;
    const bypass = await call(api('counted', 'compare/main...topic?nocache=1'), tok.admin);
    expect(bypass.cache).toBe('bypass');
    expect(bypass.json.blobReads).toBe(reads(mark, 'readBlob'));
    expect(bypass.json.blobReads).toBe(7);
    expect(bypass.cost.art).toBe(1 + (counted.calls.length - mark));
    expect(bypass.cost.art).toBeLessThanOrEqual((bypass.json.treeReads as number) + (bypass.json.blobReads as number) + 3);
    expect(bypass.json.files).toEqual(first.json.files);
    expect(bypass.json.rating).toEqual(first.json.rating);

    // A hit reports the counts of the computation it serves and reads nothing.
    const hit = await call(api('counted', 'compare/main...topic'));
    expect(hit.cache).toBe('hit');
    expect(hit.json.blobReads).toBe(first.json.blobReads);
    expect(hit.cost.art).toBe(0);
  });

  it('serves moved refs after a ref generation bump', async () => {
    const moving = await seedRepo('moving', 'public');
    const one = await commit(moving, { 'm.txt': '1\n' });
    const two = await commit(moving, { 'm.txt': '2\n' }, [one.sha]);
    moving.refs.set('refs/heads/main', one.sha);
    moving.refs.set('refs/heads/tip', one.sha);
    const path = api('moving', 'compare/main...tip');
    expect((await call(path)).json.files).toEqual([]);
    moving.refs.set('refs/heads/tip', two.sha);
    await bumpRefGeneration(repoIds.moving!);
    const after = await call(path);
    expect((after.json.head as { sha: string }).sha).toBe(two.sha);
    expect(files(after).map((f) => f.path)).toEqual(['m.txt']);
  });
});

describe('budgets and truncation', () => {
  it('omits per-file stats above the stats file limit while totals still count every file', async () => {
    const many = await seedRepo('many', 'public');
    const n = COMPARE_BUDGETS.statsMaxFiles + 5;
    const before: Files = {};
    const after: Files = {};
    for (let i = 0; i < n; i++) {
      before[`f${String(i).padStart(4, '0')}.txt`] = `v1 ${i}\n`;
      after[`f${String(i).padStart(4, '0')}.txt`] = `v2 ${i}\n`;
    }
    const b = await commit(many, before);
    const h = await commit(many, after, [b.sha]);
    many.refs.set('refs/heads/main', b.sha);
    many.refs.set('refs/heads/wide', h.sha);
    const r = await call(api('many', 'compare/main...wide'));
    expect(r.status).toBe(200);
    expect(r.json.statsOmitted).toBe(true);
    expect(r.json.truncated).toBe(false);
    expect(r.json.totalsComplete).toBe(true);
    expect(files(r).length).toBe(n);
    expect(files(r).every((f) => f.additions === undefined && f.deletions === undefined)).toBe(true);
    expect((r.json.totals as { files: number }).files).toBe(n);
    expect(many.calls.some((c) => c.startsWith('readBlob'))).toBe(false);
    expect(r.json.blobReads).toBe(0);
    expect((r.json.rating as { reasons: string[] }).reasons.some((x) => /line stats omitted/.test(x))).toBe(true);
  });

  it('truncates a wide tree on the read budget with a reason instead of failing', async () => {
    const wide = await seedRepo('widetree', 'public');
    const dirs = Math.ceil(COMPARE_BUDGETS.maxTreeReads / 2) + 10;
    const before: Files = {};
    const after: Files = {};
    for (let i = 0; i < dirs; i++) {
      before[`d${i}/x.txt`] = `a${i}\n`;
      after[`d${i}/x.txt`] = `b${i}\n`;
    }
    const b = await commit(wide, before);
    const h = await commit(wide, after, [b.sha]);
    wide.refs.set('refs/heads/main', b.sha);
    wide.refs.set('refs/heads/wide', h.sha);
    const r = await call(api('widetree', 'compare/main...wide'));
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(typeof r.json.truncatedReason).toBe('string');
    expect((r.json.truncatedReason as string).length).toBeGreaterThan(0);
    expect(r.json.statsOmitted).toBe(true);
    expect(files(r).length).toBeLessThan(dirs);
    expect(r.json.treeReads).toBe(COMPARE_BUDGETS.maxTreeReads);
    expect(r.cost.art).toBeLessThanOrEqual(COMPARE_BUDGETS.maxTreeReads + 4);
    // Totals are a labeled lower bound over exactly the discovered subset.
    expect(r.json.totalsComplete).toBe(false);
    expect(r.json.totals).toEqual({ files: files(r).length, additions: null, deletions: null });

    // Pages stitch to exactly the unpaginated subset and repeat its totals.
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(api('widetree', `compare/main...wide?limit=400${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      expect(page.status).toBe(200);
      expect(page.json.totals).toEqual(r.json.totals);
      expect(page.json.totalsComplete).toBe(false);
      expect(page.json.truncated).toBe(true);
      seen.push(...files(page).map((f) => f.path));
      cursor = page.json.nextCursor as string | undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(seen).toEqual(files(r).map((f) => f.path));

    // A budget-truncated body is deterministic, so it is cached with its label.
    const hit = await call(api('widetree', 'compare/main...wide'));
    expect(hit.cache).toBe('hit');
    expect(hit.text).toBe(r.text);
  });

  it('reports a failed tree read as truncated and does not cache it', async () => {
    const flaky = await seedRepo('flaky', 'public');
    const b = await commit(flaky, { 'ok.txt': '1\n', 'sub/x.txt': '1\n' });
    const h = await commit(flaky, { 'ok.txt': '2\n', 'sub/x.txt': '2\n' }, [b.sha]);
    flaky.refs.set('refs/heads/main', b.sha);
    flaky.refs.set('refs/heads/next', h.sha);
    const subHead = parseTree(flaky.objects.get(h.tree)!.content).find((e) => e.name === 'sub')!.hash;
    flaky.failTrees.add(subHead);
    const r = await call(api('flaky', 'compare/main...next'));
    expect(r.status).toBe(200);
    expect(r.json.truncated).toBe(true);
    expect(r.json.truncatedReason).toMatch(/tree read failed/);
    expect(r.json.totalsComplete).toBe(false);
    expect((r.json.totals as { files: number }).files).toBe(1);
    expect(files(r).map((f) => f.path)).toEqual(['ok.txt']);
    expect(await caches.default.match(compareKeys.risk(b.tree, h.tree))).toBeUndefined();
    flaky.failTrees.clear();
    const again = await call(api('flaky', 'compare/main...next'));
    expect(again.cache).toBe('miss');
    expect(again.json.truncated).toBe(false);
    expect(again.json.totalsComplete).toBe(true);
    expect(files(again).map((f) => f.path)).toEqual(['ok.txt', 'sub/x.txt']);
  });
});

// ---------------------------------------------------------------------------
// Per-file diff
// ---------------------------------------------------------------------------

describe('per-file diff', () => {
  it('returns git-style hunks with line numbers and totals', async () => {
    const r = await call(api('fixture', `compare/main...feature/file?path=${encodeURIComponent('a.txt')}`));
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ path: 'a.txt', status: 'modified', totalAdditions: 1, totalDeletions: 1, approximate: false });
    const hunks = r.json.hunks as Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ type: string; text: string; oldNo?: number; newNo?: number }> }>;
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 17, oldLines: 7, newStart: 17, newLines: 7 });
    expect(hunks[0]!.lines.find((l) => l.type === 'del')).toMatchObject({ text: 'line 20', oldNo: 20 });
    expect(hunks[0]!.lines.find((l) => l.type === 'ins')).toMatchObject({ text: 'line 20 edited', newNo: 20 });
  });

  it('serves the repeat from the blob-pair cache after one authority lookup', async () => {
    const path = api('fixture', 'compare/main...feature/file?path=docs%2Fguide.md');
    const first = await call(path, tok.owner);
    expect(first.status).toBe(200);
    const second = await call(path, tok.owner);
    expect(second.cache).toBe('hit');
    expect(second.text).toBe(first.text);
    expect(second.cost).toMatchObject({ art: 0, sub: 0, do: 0, cache: 'hit' });
    expect(second.cost.d1).toBeLessThanOrEqual(1);
  });

  it('flags binary files without hunks or line counts', async () => {
    const r = await call(api('fixture', 'compare/main...feature/file?path=image.bin'));
    expect(r.status).toBe(200);
    expect(r.json.binary).toBe(true);
    expect(r.json.hunks).toEqual([]);
    expect(r.json.totalAdditions).toBeUndefined();
  });

  it('shows a pure rename with no hunks', async () => {
    const r = await call(api('fixture', 'compare/main...feature/file?path=new-name.txt'));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'renamed', oldPath: 'old-name.txt', hunks: [], totalAdditions: 0, totalDeletions: 0 });
  });

  it('404s paths outside the change set and requires ?path', async () => {
    const r = await call(api('fixture', 'compare/main...feature/file?path=keep.txt'));
    expect(r.status).toBe(404);
    expect(typeof r.json.error).toBe('string');
    expect((await call(api('fixture', 'compare/main...feature/file?path=missing.txt'))).status).toBe(404);
    expect((await call(api('fixture', 'compare/main...feature/file?path='))).status).toBe(400);
  });

  it('flags files above 4 MB as tooLarge with a small body', async () => {
    const huge = await seedRepo('huge', 'public');
    const big = 'x'.repeat(99) + '\n';
    const b = await commit(huge, { 'big.txt': big.repeat(50_000) + 'a\n' });
    const h = await commit(huge, { 'big.txt': big.repeat(50_000) + 'b\n' }, [b.sha]);
    huge.refs.set('refs/heads/main', b.sha);
    huge.refs.set('refs/heads/next', h.sha);
    const r = await call(api('huge', 'compare/main...next/file?path=big.txt'));
    expect(r.status).toBe(200);
    expect(r.json.tooLarge).toBe(true);
    expect(r.json.hunks).toEqual([]);
    expect(r.text.length).toBeLessThan(64 * 1024);
    const list = await call(api('huge', 'compare/main...next'));
    expect(files(list)[0]).toMatchObject({ path: 'big.txt', tooLarge: true });
    expect(files(list)[0]!.additions).toBeUndefined();
  });

  it('marks an over-budget diff approximate and bounds the output', async () => {
    const heavy = await seedRepo('heavy', 'public');
    const n = 30_000;
    const oldText = Array.from({ length: n }, (_, i) => `row ${i}`).join('\n') + '\n';
    const newText = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `row ${i}` : `changed ${i}`)).join('\n') + '\n';
    const b = await commit(heavy, { 'mix.txt': oldText });
    const h = await commit(heavy, { 'mix.txt': newText }, [b.sha]);
    heavy.refs.set('refs/heads/main', b.sha);
    heavy.refs.set('refs/heads/next', h.sha);
    const r = await call(api('heavy', 'compare/main...next/file?path=mix.txt'));
    expect(r.status).toBe(200);
    expect(r.json.totalAdditions as number).toBeGreaterThan(0);
    expect(r.json.totalDeletions as number).toBeGreaterThan(0);
    const lines = (r.json.hunks as Array<{ lines: unknown[] }>).reduce((s, h) => s + h.lines.length, 0);
    expect(lines).toBeLessThanOrEqual(COMPARE_BUDGETS.fileMaxLines);
    expect(r.text.length).toBeLessThan(10 * 1024 * 1024);
    if (r.json.approximate !== true) expect(r.json.truncated).toBe(true);
  });
});

describe('200,000-line files', () => {
  const N = 200_000;
  // 400,000 and 1,200,000 bytes: both under the 4 MiB per-side cap.
  const added = 'x\n'.repeat(N);
  const removed = Array.from({ length: N }, (_, i) => `r${i}\n`).join('');
  const sides = { root: { sha: '', tree: '' }, next: { sha: '', tree: '' } };

  beforeAll(async () => {
    const repo = await seedRepo('lines', 'public');
    sides.root = await commit(repo, { 'gone.txt': removed, 'keep.txt': 'k\n' });
    sides.next = await commit(repo, { 'grown.txt': added, 'keep.txt': 'k\n' }, [sides.root.sha]);
    repo.refs.set('refs/heads/main', sides.root.sha);
    repo.refs.set('refs/heads/next', sides.next.sha);
  });

  it('counts an added and a removed 200,000-line file in the compare list', async () => {
    const r = await call(api('lines', 'compare/main...next'));
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(files(r).map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['gone.txt', 'removed', 0, N],
      ['grown.txt', 'added', N, 0],
    ]);
    expect(r.json.totals).toEqual({ files: 2, additions: N, deletions: N });
    expect(r.json.totalsComplete).toBe(true);
    const bypass = await call(api('lines', 'compare/main...next?nocache=1'), tok.admin);
    expect(bypass.status).toBe(200);
    expect(bypass.json.files).toEqual(r.json.files);
  });

  it('lists the root commit with a 200,000-line file', async () => {
    const r = await call(api('lines', `commits/${sides.root.sha}/diff`));
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(files(r).map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['gone.txt', 'added', N, 0],
      ['keep.txt', 'added', 1, 0],
    ]);
  });

  it('returns bounded file diffs whose totals cover the whole file', async () => {
    for (const [path, adds, dels] of [
      ['grown.txt', N, 0],
      ['gone.txt', 0, N],
    ] as const) {
      const r = await call(api('lines', `compare/main...next/file?path=${path}`));
      expect(r.status, `${path}: ${r.text.slice(0, 300)}`).toBe(200);
      expect(r.json).toMatchObject({ path, totalAdditions: adds, totalDeletions: dels, truncated: true, approximate: false });
      const hunks = r.json.hunks as Array<{ lines: unknown[] }>;
      expect(hunks.reduce((s, h) => s + h.lines.length, 0)).toBe(COMPARE_BUDGETS.fileMaxLines);
      expect(r.text.length).toBeLessThan(2 * 1024 * 1024);
    }
    const bypass = await call(api('lines', `compare/${sides.root.sha}...next/file?path=gone.txt&nocache=1`), tok.admin);
    expect(bypass.status).toBe(200);
    expect(bypass.cache).toBe('bypass');
    expect(bypass.json).toMatchObject({ totalAdditions: 0, totalDeletions: N, truncated: true });
  });
});

// ---------------------------------------------------------------------------
// Commit diff
// ---------------------------------------------------------------------------

describe('commit diff', () => {
  it('equals the parent...commit compare', async () => {
    const commitDiff = await call(api('fixture', `commits/${fx.feature.sha}/diff`));
    expect(commitDiff.status, commitDiff.text).toBe(200);
    expect((commitDiff.json.base as { sha: string }).sha).toBe(fx.main.sha);
    expect((commitDiff.json.head as { sha: string }).sha).toBe(fx.feature.sha);
    const viaCompare = await call(api('fixture', `compare/${fx.main.sha}...${fx.feature.sha}`));
    expect(commitDiff.json.files).toEqual(viaCompare.json.files);
    expect(commitDiff.json.totals).toEqual(viaCompare.json.totals);
  });

  it('diffs a root commit against the empty tree', async () => {
    const r = await call(api('fixture', `commits/${fx.root.sha}/diff`));
    expect(r.status).toBe(200);
    expect(r.json.base).toEqual({ ref: null, sha: null, tree: EMPTY_TREE });
    expect(files(r).map((f) => [f.path, f.status])).toEqual([
      ['a.txt', 'added'],
      ['keep.txt', 'added'],
    ]);
  });

  it('resolves an uncached commit and its parent with one log read', async () => {
    const solo = await seedRepo('solo', 'public');
    const p = await commit(solo, { 's.txt': '1\n' });
    const c = await commit(solo, { 's.txt': '1\n2\n' }, [p.sha]);
    const r = await call(api('solo', `commits/${c.sha}/diff`));
    expect(r.status).toBe(200);
    expect(solo.calls.filter((x) => x.startsWith('log') || x.startsWith('readCommit'))).toEqual([`log:${c.sha}`]);
    expect(r.cost.sub).toBe(0);
  });

  it('404s unknown commits', async () => {
    expect((await call(api('fixture', `commits/${'e'.repeat(40)}/diff`))).status).toBe(404);
    expect((await call(api('fixture', 'commits/main/diff'))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Risk (the contract's risk-fixture shape)
// ---------------------------------------------------------------------------

describe('risk-ranked compare', () => {
  const pkg = (deps: Record<string, string>) => `${JSON.stringify({ name: 'risk', version: '1.0.0', dependencies: deps }, null, 2)}\n`;
  const base: Files = {
    '.forge/ci.json': '{"jobs":[{"name":"test","run":"npm test"}]}\n',
    'test/app.test.ts': "import { it } from 'vitest';\nit('adds', () => {});\nit('subtracts', () => {});\n",
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{"name":"risk"}}}\n',
    'package.json': pkg({ hono: '^4.6.0' }),
    'x.md': '# X\n\nnotes\n',
    'ws.txt': 'alpha beta\ngamma\n',
    'src/billing.ts': 'export function total(a: number, b: number): number {\n  return a + b;\n}\n',
    'src/generated/api.gen.ts': '// Code generated by api-gen. DO NOT EDIT.\nexport const version = 1;\n',
    'src/auth/session.ts': 'export const SESSION_TTL = 3600;\n',
    'README.md': '# Risk fixture\n\nThis repository exercises risk tags.\n',
  };
  const expected: Record<string, string> = {
    '.forge/ci.json': 'ci-config',
    'test/app.test.ts': 'test-deletion',
    'package-lock.json': 'lockfile',
    'package.json': 'new-dependency',
    'y.md': 'mechanical',
    'ws.txt': 'mechanical',
    'src/billing.ts': 'semantic',
    'src/generated/api.gen.ts': 'generated',
    'src/auth/session.ts': 'security-sensitive',
    'big.ts': 'large',
  };

  beforeAll(async () => {
    const repo = await seedRepo('risk', 'public');
    const main = await commit(repo, base);
    const { 'test/app.test.ts': _deleted, 'x.md': moved, ...kept } = base;
    const risky = await commit(
      repo,
      {
        ...kept,
        '.forge/ci.json': '{"jobs":[{"name":"test","run":"npm test || true"}]}\n',
        'package-lock.json': '{"lockfileVersion":3,"packages":{"":{"name":"risk"},"node_modules/left-pad":{"version":"1.3.0"}}}\n',
        'package.json': pkg({ hono: '^4.6.0', 'left-pad': '1.3.0' }),
        'y.md': moved!,
        'ws.txt': 'alpha  beta\n\tgamma\n',
        'src/billing.ts': 'export function total(a: number, b: number): number {\n  return a - b;\n}\n',
        'src/generated/api.gen.ts': '// Code generated by api-gen. DO NOT EDIT.\nexport const version = 2;\n',
        'src/auth/session.ts': 'export const SESSION_TTL = 60;\n',
        'big.ts': Array.from({ length: 5000 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n',
      },
      [main.sha],
    );
    const docs = await commit(repo, { ...base, 'README.md': '# Risk fixture\n\nThis repository exercises risk tags and ratings.\n' }, [main.sha]);
    repo.refs.set('refs/heads/main', main.sha);
    repo.refs.set('refs/heads/risky', risky.sha);
    repo.refs.set('refs/heads/docs-only', docs.sha);
  });

  it('gives every file an integer score in 0..100 and a tags array', async () => {
    const r = await call(api('risk', 'compare/main...risky'), tok.owner);
    expect(r.status, r.text).toBe(200);
    expect(files(r)).toHaveLength(10);
    for (const f of files(r)) {
      expect(Number.isInteger(f.risk.score), f.path).toBe(true);
      expect(f.risk.score).toBeGreaterThanOrEqual(0);
      expect(f.risk.score).toBeLessThanOrEqual(100);
      expect(Array.isArray(f.risk.tags)).toBe(true);
    }
  });

  it('tags each crafted change as the contract expects', async () => {
    const r = await call(api('risk', 'compare/main...risky'), tok.owner);
    const byPath = Object.fromEntries(files(r).map((f) => [f.path, f]));
    for (const [path, tag] of Object.entries(expected)) expect(byPath[path]?.risk.tags, path).toContain(tag);
    expect(byPath['y.md']).toMatchObject({ status: 'renamed', oldPath: 'x.md' });
    expect(byPath['src/billing.ts']!.risk.tags).not.toContain('mechanical');
  });

  it('sorts ?order=risk by score descending with a path tiebreak', async () => {
    const plain = await call(api('risk', 'compare/main...risky?order=path'), tok.owner);
    const ranked = await call(api('risk', 'compare/main...risky?order=risk'), tok.owner);
    expect(ranked.status).toBe(200);
    const want = [...files(plain)]
      .sort((a, b) => b.risk.score - a.risk.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => f.path);
    expect(files(ranked).map((f) => f.path)).toEqual(want);
    expect(files(ranked)[0]!.risk.score).toBeGreaterThan(files(ranked).at(-1)!.risk.score);
    // Paging in risk order walks the same sequence.
    const page1 = await call(api('risk', 'compare/main...risky?order=risk&limit=4'), tok.owner);
    const page2 = await call(api('risk', `compare/main...risky?order=risk&limit=100&cursor=${encodeURIComponent(page1.json.nextCursor as string)}`), tok.owner);
    expect([...files(page1), ...files(page2)].map((f) => f.path)).toEqual(want);
  });

  it('rates the risky change high with reasons, and docs-only low below it', async () => {
    const risky = await call(api('risk', 'compare/main...risky'), tok.owner);
    const rating = risky.json.rating as { score: number; level: string; reasons: string[] };
    expect(rating.level).toBe('high');
    expect(Number.isInteger(rating.score) && rating.score <= 100).toBe(true);
    expect(rating.reasons.length).toBeGreaterThan(0);
    expect(rating.reasons.join('\n')).toMatch(/\.forge\/ci\.json/);
    expect(rating.reasons.join('\n')).toMatch(/test\/app\.test\.ts/);

    const docs = await call(api('risk', 'compare/main...docs-only'), tok.owner);
    expect(docs.status).toBe(200);
    const docsRating = docs.json.rating as { score: number; level: string };
    expect(docsRating.level).toBe('low');
    expect(docsRating.score).toBeLessThan(rating.score);
    expect(files(docs).map((f) => [f.path, f.risk.tags])).toEqual([['README.md', []]]);
  });

  it('returns identical risk output for repeated cold computations', async () => {
    const extract = (r: Reply) => JSON.stringify({ files: files(r).map((f) => [f.path, f.risk]), rating: r.json.rating });
    const a = await call(api('risk', 'compare/main...risky?nocache=1'), tok.admin);
    const b = await call(api('risk', 'compare/main...risky?nocache=1'), tok.admin);
    expect(a.cache).toBe('bypass');
    expect(b.cache).toBe('bypass');
    expect(extract(b)).toBe(extract(a));
    expect(extract(await call(api('risk', 'compare/main...risky'), tok.owner))).toBe(extract(a));
  });

  it('serves risk from the tree-pair caches without re-reading content', async () => {
    const repo = repos.get(`${OWNER}--risk`)!;
    await call(api('risk', 'compare/main...risky'), tok.owner);
    const mark = repo.calls.length;
    const hit = await call(api('risk', `compare/${repo.refs.get('refs/heads/main')}...${repo.refs.get('refs/heads/risky')}`), tok.owner);
    expect(hit.cache).toBe('hit');
    expect(repo.calls.length).toBe(mark);
    expect((hit.json.rating as { level: string }).level).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// Derived-output compatibility: entries written before the pyproject extras repair
// ---------------------------------------------------------------------------

describe('pre-repair risk cache entries', () => {
  // Literal keys of the namespaces that held pre-repair risk output.
  const legacyRisk = (b: string, h: string) => new Request(`https://forge.internal/risk/v1/${b}/${h}`);
  const legacyBody = (b: string, h: string) => new Request(`https://forge.internal/treediff/v3/${b}/${h}`);
  const put = (k: Request, body: unknown) =>
    caches.default.put(k, new Response(JSON.stringify(body), { headers: { 'cache-control': 'max-age=3600, immutable' } }));

  interface Rating {
    score: number;
    level: string;
    reasons: string[];
  }

  /** Extras before an added dependency: the pre-repair parser ended the array at "requests[socks]". */
  async function extrasRepo(name: string) {
    const repo = await seedRepo(name, 'public');
    const before = `[project]\nname = "${name}"\ndependencies = [\n  "requests[socks]>=2",\n]\n`;
    const after = `[project]\nname = "${name}"\ndependencies = [\n  "requests[socks]>=2",\n  "httpx>=0.27",\n]\n`;
    const b = await commit(repo, { 'pyproject.toml': before, 'app.py': 'print(1)\n' });
    const h = await commit(repo, { 'pyproject.toml': after, 'app.py': 'print(2)\n' }, [b.sha]);
    repo.refs.set('refs/heads/main', b.sha);
    repo.refs.set('refs/heads/deps', h.sha);
    const fresh = await call(api(name, 'compare/main...deps?nocache=1'), tok.admin);
    expect(fresh.status, fresh.text).toBe(200);
    const freshRating = fresh.json.rating as Rating;
    const pyproject = files(fresh).find((f) => f.path === 'pyproject.toml')!;
    expect(pyproject.risk.tags).toContain('new-dependency');
    expect(freshRating.reasons).toContain('New dependencies added: pyproject.toml (httpx)');
    // What the pre-repair parser cached: no new-dependency tag and no rating contribution from it.
    const staleFiles = files(fresh).map((f) =>
      f.path === 'pyproject.toml' ? { score: 0, tags: f.risk.tags.filter((t) => t !== 'new-dependency') } : f.risk,
    );
    const staleRating: Rating = {
      score: Math.max(0, freshRating.score - 25),
      level: 'low',
      reasons: freshRating.reasons.filter((r) => !r.startsWith('New dependencies added')),
    };
    return { b, h, fresh, freshRating, staleFiles, staleRating, path: api(name, 'compare/main...deps') };
  }

  function expectCorrected(r: Reply, freshRating: Rating) {
    expect(r.status, r.text).toBe(200);
    const pyproject = files(r).find((f) => f.path === 'pyproject.toml')!;
    expect(pyproject.risk.tags).toContain('new-dependency');
    expect(pyproject.risk.score).toBeGreaterThanOrEqual(25);
    expect(r.json.rating).toEqual(freshRating);
    expect((r.json.rating as Rating).reasons).toContain('New dependencies added: pyproject.toml (httpx)');
  }

  it('recomputes risk instead of adopting a pre-repair risk entry after a compare-body miss', async () => {
    const s = await extrasRepo('extras-risk');
    await put(legacyRisk(s.b.tree, s.h.tree), { files: s.staleFiles, rating: s.staleRating });

    const normal = await call(s.path, tok.owner);
    expect(normal.cache).toBe('miss');
    expectCorrected(normal, s.freshRating);
    expect(files(normal)).toEqual(files(s.fresh));

    const warm = await call(s.path, tok.owner);
    expect(warm.cache).toBe('hit');
    expectCorrected(warm, s.freshRating);
    expect(warm.text).toBe(normal.text);
  });

  it('never serves a compare body that embedded pre-repair risk', async () => {
    const s = await extrasRepo('extras-body');
    const { base: _b, head: _h, ...body } = s.fresh.json;
    const staleBody = {
      ...body,
      files: files(s.fresh).map((f, i) => ({ ...f, risk: s.staleFiles[i] })),
      rating: s.staleRating,
    };
    await put(legacyRisk(s.b.tree, s.h.tree), { files: s.staleFiles, rating: s.staleRating });
    await put(legacyBody(s.b.tree, s.h.tree), staleBody);

    const normal = await call(s.path, tok.owner);
    expect(normal.cache).toBe('miss');
    expectCorrected(normal, s.freshRating);

    const warm = await call(s.path, tok.owner);
    expect(warm.cache).toBe('hit');
    expectCorrected(warm, s.freshRating);

    const commitDiff = await call(api('extras-body', `commits/${s.h.sha}/diff`), tok.owner);
    expectCorrected(commitDiff, s.freshRating);
  });
});
