/**
 * Compare page tests (issue #6): the server-rendered file list over an
 * in-memory Artifacts fake. The page must work without JavaScript (plain
 * <details> rows plus a noscript link), make truncated and too-large states
 * explicit, page the file list, conceal private repositories, and edge-cache
 * anonymous public views (pinned SHA ranges immutably, branch ranges by the
 * repo view generation).
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLUSH_PKT, buildBlob, buildCommit, buildTree, concat, decode, pktLine, parseTree, readPktLines, type TreeEntry } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, countingFetch, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'page-owner';
const FULL: Scope[] = ['read', 'write', 'api'];

// ---------------------------------------------------------------------------
// In-memory Artifacts (real git objects, fake protocol endpoints)
// ---------------------------------------------------------------------------

interface Obj {
  type: 'blob' | 'tree' | 'commit';
  content: Uint8Array;
}

class FakeRepo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
  calls: string[] = [];
}

const repos = new Map<string, FakeRepo>();
const originalFetch = globalThis.fetch;

function handle(name: string): ArtifactsRepo {
  const r = repos.get(name);
  if (!r) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  return {
    async readTree(hash: string) {
      r.calls.push(`readTree:${hash}`);
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
      if (!o || o.type !== 'commit') return null;
      const text = decode(o.content);
      const head = text.slice(0, text.indexOf('\n\n'));
      const tree = /^tree ([0-9a-f]{40})$/m.exec(head)![1]!;
      const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
      const who = { name: 't', email: 't@kvarm.invalid' };
      return { hash, treeHash: tree, message: 'm', author: who, committer: who, parents, authoredAt: 0, committedAt: 0 };
    },
    async log({ ref, limit = 50 }: { ref?: string; limit?: number } = {}) {
      r.calls.push(`log:${ref}`);
      let sha = ref && /^[0-9a-f]{40}$/.test(ref) ? ref : r.refs.get(`refs/heads/${ref}`);
      const out: ArtifactsCommitMetadata[] = [];
      while (sha && out.length < limit) {
        const o = r.objects.get(sha);
        if (!o || o.type !== 'commit') break;
        const text = decode(o.content);
        const head = text.slice(0, text.indexOf('\n\n'));
        const tree = /^tree ([0-9a-f]{40})$/m.exec(head)![1]!;
        const parents = [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!);
        const who = { name: 't', email: 't@kvarm.invalid' };
        out.push({ hash: sha, treeHash: tree, message: 'm', author: who, committer: who, parents, authoredAt: 0, committedAt: 0 });
        sha = parents[0];
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

function entryType(mode: string): ArtifactsTreeEntryType {
  if (mode === '40000') return 'tree';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (mode === '100755') return 'exec';
  return 'blob';
}

const enc = (s: string) => new TextEncoder().encode(s);
type Files = Record<string, string | Uint8Array>;

async function writeTree(repo: FakeRepo, files: Files): Promise<string> {
  const dirs = new Map<string, Files>();
  const entries: TreeEntry[] = [];
  for (const [path, content] of Object.entries(files)) {
    const slash = path.indexOf('/');
    if (slash !== -1) {
      const dir = path.slice(0, slash);
      const sub = dirs.get(dir) ?? {};
      sub[path.slice(slash + 1)] = content;
      dirs.set(dir, sub);
      continue;
    }
    const bytes = typeof content === 'string' ? enc(content) : content;
    const blob = await buildBlob(bytes);
    repo.objects.set(blob.hash, { type: 'blob', content: bytes });
    entries.push({ mode: '100644', name: path, hash: blob.hash });
  }
  for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, hash: await writeTree(repo, sub) });
  const tree = await buildTree(entries);
  repo.objects.set(tree.hash, { type: 'tree', content: tree.raw.subarray(tree.raw.indexOf(0) + 1) });
  return tree.hash;
}

let clock = 1_700_000_000;
async function commit(repo: FakeRepo, files: Files, parents: string[] = []): Promise<{ sha: string; tree: string }> {
  const tree = await writeTree(repo, files);
  const who = { name: 't', email: 't@kvarm.invalid', time: clock++ };
  const c = await buildCommit({ tree, parents, author: who, committer: who, message: `c${clock}` });
  repo.objects.set(c.hash, { type: 'commit', content: c.raw.subarray(c.raw.indexOf(0) + 1) });
  return { sha: c.hash, tree };
}

// ---------------------------------------------------------------------------
// Principals, repos, requests
// ---------------------------------------------------------------------------

const tok = { owner: '', outsider: '' };
interface RepoShas {
  main: string;
  feature: string;
}
const shas = {} as { pub: RepoShas; priv: RepoShas; wide: RepoShas };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: 'pub' | 'priv' | 'wide', visibility: 'public' | 'private'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  repos.set(artifactsName, repo);
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
    )
    .bind(crypto.randomUUID(), OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return repo;
}

interface Read {
  status: number;
  text: string;
  cost: CostCounters;
  cache: string | null;
  cacheControl: string | null;
  location: string | null;
  refresh: string | null;
}

async function call(path: string, token?: string, method = 'GET'): Promise<Read> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { method, headers }) as Request<unknown, IncomingRequestCfProperties>,
    env,
    ctx,
  );
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  return {
    status: res.status,
    text,
    cost: cost!,
    cache: res.headers.get('x-kvarm-cache'),
    cacheControl: res.headers.get('cache-control'),
    location: res.headers.get('location'),
    refresh: res.headers.get('refresh'),
  };
}

const page = (repo: string, rest: string) => `/${OWNER}/${repo}/${rest}`;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** The v0 advertisement listRefs reads (the compare form's branch picker). */
function infoRefsResponse(repo: FakeRepo): Response {
  const lines: Uint8Array[] = [];
  let first = true;
  for (const [name, oid] of [...repo.refs].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const line = first ? `${oid} ${name}\0symref=HEAD:refs/heads/main\n` : `${oid} ${name}\n`;
    first = false;
    lines.push(pktLine(line));
  }
  lines.push(FLUSH_PKT);
  return new Response(concat(...lines), { headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } });
}

/** ls-refs over the fake refs (protocol v2), for the compare service's ref resolution. */
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

beforeAll(async () => {
  const ownerId = await seedUser(OWNER);
  const outsiderId = await seedUser('page-outsider');
  tok.owner = (await mintPAT(env, ownerId, 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', FULL)).token;

  for (const [name, visibility] of [
    ['pub', 'public'],
    ['priv', 'private'],
  ] as const) {
    const repo = await seedRepo(name, visibility);
    const main: Files = {
      'a.txt': `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')}\n`,
      'keep.txt': 'keep me\n',
      '.kvarm/ci.json': '{"jobs":{"typecheck":{}}}\n',
    };
    const mainC = await commit(repo, main);
    const feature: Files = {
      ...main,
      'a.txt': `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}${i === 19 ? ' edited' : ''}`).join('\n')}\n`,
      '.kvarm/ci.json': '{"jobs":{"typecheck":{},"lint":{}}}\n',
      'new.txt': 'brand\nnew\n',
      'image.bin': new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]),
      'huge.txt': 'x'.repeat(4 * 1024 * 1024 + 1),
    };
    const featureC = await commit(repo, feature, [mainC.sha]);
    repo.refs.set('refs/heads/main', mainC.sha);
    repo.refs.set('refs/heads/feature', featureC.sha);
    shas[name] = { main: mainC.sha, feature: featureC.sha };
  }

  // The wide fixture: 350 changed files, over the 300-file line-stat cap.
  const wide = await seedRepo('wide', 'public');
  const wideMain = await commit(wide, { 'seed.txt': 'seed\n' });
  const wideFiles: Files = { 'seed.txt': 'seed\n' };
  for (let i = 0; i < 350; i++) wideFiles[`dir${Math.floor(i / 25)}/f${i}.txt`] = `content ${i}\n`;
  const wideFeature = await commit(wide, wideFiles, [wideMain.sha]);
  wide.refs.set('refs/heads/main', wideMain.sha);
  wide.refs.set('refs/heads/feature', wideFeature.sha);
  shas.wide = { main: wideMain.sha, feature: wideFeature.sha };

  globalThis.fetch = countingFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const m = /^\/git\/default\/(.+)\.git\/(info\/refs|git-upload-pack)$/.exec(url.pathname);
    const repo = m ? repos.get(m[1]!) : undefined;
    if (!repo) return new Response('bad', { status: 400 });
    if (m![2] === 'info/refs') return infoRefsResponse(repo);
    return lsRefsResponse(repo, new Uint8Array(await req.arrayBuffer()));
  }) as typeof fetch);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compare form', () => {
  it('renders branch selects from the ref advertisement and redirects base+head to the canonical path', async () => {
    const form = await call(page('pub', 'compare'));
    expect(form.status).toBe(200);
    expect(form.text).toContain('<select id="cmp-a"');
    expect(form.text).toContain('<option value="main"');
    expect(form.text).toContain('<option value="feature"');
    expect(form.cacheControl).toBe('no-store');

    const half = await call(page('pub', 'compare?base=main'));
    expect(half.text).toContain('Pick both a base and a head');

    const redirect = await call(page('pub', 'compare?base=main&head=feature'));
    expect(redirect.status).toBe(302);
    expect(redirect.location).toBe(page('pub', 'compare/main...feature'));
  });
});

describe('compare page', () => {
  it('server-renders the file list without JavaScript and wires the diff client', async () => {
    const r = await call(page('pub', 'compare/main...feature'));
    expect(r.status, r.text).toBe(200);
    // The list itself is plain HTML.
    expect(r.text).toContain('<details class="diff-file"');
    expect(r.text).toContain('data-path="a.txt"');
    expect(r.text).toContain('data-path="new.txt"');
    expect(r.text).toContain('<noscript>');
    // Risk-ordered by default: the CI config change (tag ci-config) first.
    const first = /<details class="diff-file"[^>]*data-path="([^"]+)"/.exec(r.text)![1]!;
    expect(first).toBe('.kvarm/ci.json');
    expect(r.text).toMatch(/<span class="chip signal"[^>]*>ci-config<\/span>/);
    expect(r.text).toMatch(/title="risk \d+"/);
    // Explicit states: binary and over-cap files are marked and never fetched.
    expect(r.text).toMatch(/data-path="image\.bin"[^>]*data-binary="1"/);
    expect(r.text).toMatch(/data-path="huge\.txt"[^>]*data-toolarge="1"/);
    expect(r.text).toContain('too large');
    // Summary and order toggle.
    expect(r.text).toContain('across 5 file(s)');
    expect(r.text).toContain('?order=path');
    // The client fetches per-file diffs from this pre-encoded endpoint.
    expect(r.text).toContain('src="/assets/diffClient.js"');
    expect(r.text).toContain(`data-file-api="/api/v1/repos/${OWNER}/pub/compare/main...feature/file"`);
  });

  it('paginates the file list and marks omitted line stats explicitly', async () => {
    const r = await call(page('wide', 'compare/main...feature'));
    expect(r.status).toBe(200);
    expect((r.text.match(/<details class="diff-file"/g) ?? []).length).toBe(200);
    expect(r.text).toContain('Line stats are omitted');
    expect(r.text).toContain('More files');
    const cursor = /href="([^"]*cursor=[^"]*)"/.exec(r.text)![1]!.replace(/&amp;/g, '&');
    const next = await call(cursor);
    expect(next.status).toBe(200);
    expect((next.text.match(/<details class="diff-file"/g) ?? []).length).toBe(150);
    expect(next.text).not.toContain('More files');
  });

  it('edge-caches anonymous public views: pinned by SHAs immutably, branches by generation', async () => {
    const first = await call(page('pub', `compare/${shas.pub.main}...${shas.pub.feature}`));
    expect(first.status).toBe(200);
    expect(['miss', 'hit']).toContain(first.cost.cache);
    // The edge entry carries the TTL; a hit returns it (the live miss says nothing).
    const warm = await call(page('pub', `compare/${shas.pub.main}...${shas.pub.feature}`));
    expect(warm.cache).toBe('hit');
    expect(warm.cost.cache).toBe('hit');
    expect(warm.cacheControl).toContain('max-age=31536000');
    expect(warm.cost.d1).toBeLessThanOrEqual(1); // authority only, the body never re-renders

    const branch = await call(page('pub', 'compare/main...feature'));
    expect(branch.status).toBe(200);
    const branchWarm = await call(page('pub', 'compare/main...feature'));
    expect(branchWarm.cache).toBe('hit');
    expect(branchWarm.cacheControl).toContain('max-age=60');
  });

  it('falls back to the form for an unknown ref and stays concealed for private repos', async () => {
    const missing = await call(page('pub', 'compare/main...nosuchref'));
    expect(missing.status).toBe(200);
    expect(missing.text).toContain('ref not found');

    for (const [who, token] of [['anonymous', undefined], ['outsider', tok.outsider]] as const) {
      const denied = await call(page('priv', 'compare/main...feature'), token);
      expect(denied.status, who).toBe(404);
      const deniedForm = await call(page('priv', 'compare'), token);
      expect(deniedForm.status, who).toBe(404);
    }
    const allowed = await call(page('priv', 'compare/main...feature'), tok.owner);
    expect(allowed.status).toBe(200);
    expect(allowed.text).toContain('data-path="a.txt"');
  });
});
