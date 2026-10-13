/**
 * Coordination page tests (issue #7): activity (workspaces with agent model
 * families, intents, pins and overlap), candidate comparison (arenas and
 * free-form sets), and the train view. Pages read only through the services
 * (seeded rows here, real git objects in the in-memory Artifacts fake for the
 * comparison pages), conceal private repositories, and answer with bounded
 * indexed reads — the cost assertions pin each page's x-kvarm-cost budget.
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
const OWNER = 'coord-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

// ---------------------------------------------------------------------------
// In-memory Artifacts (real git objects; ls-refs over the fake protocol)
// ---------------------------------------------------------------------------

interface Obj {
  type: 'blob' | 'tree' | 'commit';
  content: Uint8Array;
}

class FakeRepo {
  objects = new Map<string, Obj>();
  refs = new Map<string, string>();
}

const repos = new Map<string, FakeRepo>();
const originalFetch = globalThis.fetch;

function entryType(mode: string): ArtifactsTreeEntryType {
  if (mode === '40000') return 'tree';
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'gitlink';
  if (mode === '100755') return 'exec';
  return 'blob';
}

function handle(name: string): ArtifactsRepo {
  const r = repos.get(name);
  if (!r) throw Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  return {
    async readTree(hash: string) {
      const o = r.objects.get(hash);
      if (!o || o.type !== 'tree') return null;
      return parseTree(o.content).map((e) => ({ ...e, type: entryType(e.mode) }));
    },
    async readBlob(hash: string) {
      const o = r.objects.get(hash);
      return o && o.type === 'blob' ? new Blob([o.content]) : null;
    },
    async readCommit(hash: string) {
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
      return { id: 't', plaintext: 'fake-token', scope, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
    },
    [Symbol.dispose]() {},
  } as unknown as ArtifactsRepo;
}

const env = {
  ...baseEnv,
  ARTIFACTS: { get: async (name: string) => handle(name) } as unknown as Artifacts,
} as Env;

const enc = (s: string) => new TextEncoder().encode(s);
type Files = Record<string, string>;

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
    const bytes = enc(content);
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

/** ls-refs over the fake refs (protocol v2): the candidate pages' ref resolution. */
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
// Seeding
// ---------------------------------------------------------------------------

const tok = { owner: '', outsider: '' };
const ids = {} as { owner: string; coord: string; secret: string; quiet: string };
const shas = {} as Record<string, string>;
const NOW = 1_730_000_000_000;

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private', withGit: boolean): Promise<string> {
  const repoId = crypto.randomUUID();
  const artifactsName = `${OWNER}--${name}`;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(repoId, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, NOW - 100_000)
    .run();
  if (withGit) {
    const repo = new FakeRepo();
    repos.set(artifactsName, repo);
  }
  return repoId;
}

interface WorkspaceSeed {
  id: string;
  task: string;
  agent?: string | null;
  agentId?: string | null;
  ref?: string | null;
  arena?: string | null;
  baseSha?: string | null;
  headSha?: string | null;
  status?: string;
  changeSet?: string | null;
  declared?: string[];
  observed?: string[] | null;
}

async function seedWorkspaceRow(repoId: string, w: WorkspaceSeed): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO workspaces (id, repo_id, artifacts_name, task, agent, agent_id, status, ref, base_ref, base_sha, head_sha,
       created_by, created_at, intent_paths, observed_paths, observed_base_sha, observed_head_sha, observed_at, arena_id)
     VALUES (?, ?, 'unused', ?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      w.id, repoId, w.task, w.agent ?? null, w.agentId ?? null, w.status ?? 'active', w.ref ?? null,
      w.baseSha ?? null, w.headSha ?? null, ids.owner, NOW - 50_000,
      w.declared ? JSON.stringify(w.declared) : null,
      w.observed ? JSON.stringify(w.observed) : null,
      w.baseSha ?? null, w.headSha ?? null, NOW - 10_000, w.arena ?? null,
    )
    .run();
}

async function seedChange(repoId: string, number: number, state: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, head_sha, state, author_id, created_at)
     VALUES (?, ?, ?, ?, 'main', 'agents/x/y', ?, ?, ?, ?)`,
  )
    .bind(id, repoId, number, `change ${number}`, SHA_A, state, ids.owner, NOW - 20_000)
    .run();
  return id;
}

async function seedQueue(repoId: string, e: {
  number: number;
  state: string;
  active: 0 | 1;
  reasonCode?: string;
  reason?: string;
  agent?: string;
  attempts?: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO merge_queue (id, repo_id, target_ref, seq, change_set_id, change_number, state, active, head_sha,
       merge_policy, enqueued_by, enqueuer_login, agent_meta, enqueued_at, updated_at, attempts, admission_capacity)
     VALUES (?, ?, 'refs/heads/main', ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?, 64)`,
  )
    .bind(
      crypto.randomUUID(),
      repoId,
      (NOW + e.number) * 1000,
      `cs-${e.number}`, // one immutable candidate per change; the unique active index requires distinct ids
      e.number,
      e.state,
      e.active,
      SHA_A,
      ids.owner,
      OWNER,
      e.agent ? JSON.stringify({ agentId: e.agent, agentName: e.agent }) : null,
      NOW - e.number,
      NOW - e.number,
      e.attempts ?? 0,
    )
    .run();
  if (e.reasonCode) {
    await env.DB.prepare('UPDATE merge_queue SET reason_code = ?, reason = ? WHERE repo_id = ? AND change_number = ? AND target_ref = ?')
      .bind(e.reasonCode, e.reason ?? '', repoId, e.number, 'refs/heads/main')
      .run();
  }
}

beforeAll(async () => {
  ids.owner = await seedUser(OWNER);
  const outsiderId = await seedUser('coord-outsider');
  tok.owner = (await mintPAT(env, ids.owner, 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, outsiderId, 'outsider', FULL)).token;

  ids.coord = await seedRepo('coord', 'public', true);
  ids.secret = await seedRepo('secret', 'private', false);
  ids.quiet = await seedRepo('quiet', 'public', false);

  // One agent principal with a model family; its workspace carries the family chip.
  await env.DB.prepare(
    `INSERT INTO agents (id, owner_kind, owner_id, owner_login, name, description, created_by, created_at, model_family)
     VALUES ('ag1', 'user', ?, ?, 'Atlas', 'the atlas agent', ?, ?, 'opus-4.5')`,
  )
    .bind(ids.owner, OWNER, ids.owner, NOW - 90_000)
    .run();

  // Real git trees for the candidate comparison: main plus two workspace branches.
  const artifacts = repos.get(`${OWNER}--coord`)!;
  const mainFiles: Files = { 'src/shared.txt': 'shared v1\n', 'src/a.ts': 'a\n', 'readme.md': 'r\n' };
  const main = await commit(artifacts, mainFiles);
  const branchA = await commit(artifacts, { ...mainFiles, 'src/shared.txt': 'shared v2 (atlas)\n', 'src/a.ts': 'a atlas\n', 'atlas.txt': 'atlas\n' }, [main.sha]);
  const branchB = await commit(artifacts, { ...mainFiles, 'src/shared.txt': 'shared v2 (boreas)\n', 'src/b.ts': 'b boreas\n' }, [main.sha]);
  artifacts.refs.set('refs/heads/main', main.sha);
  artifacts.refs.set('refs/heads/agents/wsatlas/fix-parser', branchA.sha);
  artifacts.refs.set('refs/heads/agents/wsboreas/fix-parser', branchB.sha);
  shas.main = main.sha;
  shas.atlas = branchA.sha;
  shas.boreas = branchB.sha;

  // Two candidates of one arena; both also carry the observed index rows the
  // duplication report reads.
  await seedWorkspaceRow(ids.coord, {
    id: 'wsatlas',
    task: 'Fix the parser',
    agent: 'Atlas',
    agentId: 'ag1',
    ref: 'refs/heads/agents/wsatlas/fix-parser',
    arena: 'ar1',
    baseSha: main.sha,
    headSha: branchA.sha,
    declared: ['src/a.ts', 'src/shared.txt'],
    observed: ['src/shared.txt', 'src/a.ts'],
  });
  await seedWorkspaceRow(ids.coord, {
    id: 'wsboreas',
    task: 'Fix the parser',
    agent: 'Boreas',
    ref: 'refs/heads/agents/wsboreas/fix-parser',
    arena: 'ar1',
    baseSha: main.sha,
    headSha: branchB.sha,
    declared: ['src/b.ts'],
    observed: ['src/shared.txt', 'src/b.ts'],
  });
  // A merged workspace to show in the "all" view; a person-created one.
  await seedWorkspaceRow(ids.coord, {
    id: 'wsold',
    task: 'Old work',
    status: 'merged',
    ref: 'refs/heads/agents/wsold/old-work',
    baseSha: SHA_B,
    headSha: SHA_B,
  });
  await seedWorkspaceRow(ids.coord, {
    id: 'wshuman',
    task: 'Human review notes',
    ref: 'refs/heads/agents/wshuman/notes',
    baseSha: main.sha,
    headSha: main.sha,
    declared: ['docs/'],
  });

  // The overlap index: one shared observed path between the two candidates.
  // (The trg_wsp_share_insert trigger maintains workspace_path_shares itself.)
  for (const ws of ['wsatlas', 'wsboreas']) {
    await env.DB.prepare('INSERT INTO workspace_paths (repo_id, kind, path, workspace_id) VALUES (?, ?, ?, ?)')
      .bind(ids.coord, 'observed', 'src/shared.txt', ws)
      .run();
  }

  // One pin: Boreas depends on Atlas at its head.
  await env.DB.prepare(
    `INSERT INTO workspace_dependencies (repo_id, id, workspace_id, on_workspace, revision, created_by, created_login, created_at, updated_at)
     VALUES (?, 'dep1', 'wsboreas', 'wsatlas', ?, ?, ?, ?, ?)`,
  )
    .bind(ids.coord, branchA.sha, ids.owner, OWNER, NOW - 5_000, NOW - 5_000)
    .run();

  // The arena, with its candidates linked through workspaces.arena_id.
  await env.DB.prepare(
    `INSERT INTO arenas (id, repo_id, brief, base_ref, base_sha, candidates, state, created_by, created_at)
     VALUES ('ar1', ?, 'Fix the parser two ways', 'main', ?, 2, 'open', ?, ?)`,
  )
    .bind(ids.coord, main.sha, ids.owner, NOW - 60_000)
    .run();

  // The train: one checking entry, one queued, one recent ejection, and one
  // open resolve-conflict task for the ejection's change.
  const change1 = await seedChange(ids.coord, 1, 'open');
  await seedQueue(ids.coord, { number: 1, state: 'checking', active: 1, agent: 'Atlas', attempts: 1 });
  await seedQueue(ids.coord, { number: 2, state: 'queued', active: 1 });
  await seedQueue(ids.coord, {
    number: 3,
    state: 'ejected',
    active: 0,
    reasonCode: 'CHECKS_FAILED',
    reason: 'kvarm/guard failed on the composed tree',
  });
  await env.DB.prepare(
    `INSERT INTO agent_tasks (id, repo_id, kind, change_set_id, workspace_id, status, head_sha, base_sha, payload, created_at, updated_at)
     VALUES (?, ?, 'resolve-conflict', ?, NULL, 'open', ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      ids.coord,
      change1,
      branchA.sha,
      main.sha,
      JSON.stringify({
        conflicts: [
          { path: 'src/shared.txt', kind: 'content' },
          { path: 'src/a.ts', kind: 'content', needsRegeneration: true },
          { path: 'src/deep/one.ts', kind: 'content' },
          { path: 'src/deep/two.ts', kind: 'content' },
          { path: 'src/deep/three.ts', kind: 'content' },
          { path: 'src/deep/four.ts', kind: 'content' },
          { path: 'src/deep/five.ts', kind: 'content' },
        ],
        truncated: true,
      }),
      NOW - 3_000,
      NOW - 3_000,
    )
    .run();

  globalThis.fetch = countingFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname !== 'artifacts.invalid') return originalFetch(input, init);
    const m = /^\/git\/default\/(.+)\.git\/git-upload-pack$/.exec(url.pathname);
    const repo = m ? repos.get(m[1]!) : undefined;
    if (!repo) return new Response('bad', { status: 400 });
    return lsRefsResponse(repo, new Uint8Array(await req.arrayBuffer()));
  }) as typeof fetch);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface Read {
  status: number;
  text: string;
  cost: CostCounters;
  cacheControl: string | null;
  refresh: string | null;
  location: string | null;
}

async function call(path: string, token?: string, init: RequestInit = {}): Promise<Read> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await worker.fetch!(
    new Request(`${ORIGIN}${path}`, { ...init, method: init.method ?? 'GET', headers }) as Request<unknown, IncomingRequestCfProperties>,
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
    cacheControl: res.headers.get('cache-control'),
    refresh: res.headers.get('refresh'),
    location: res.headers.get('location'),
  };
}

const p = (repo: string, rest: string) => `/${OWNER}/${repo}/${rest}`;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

describe('activity page', () => {
  it('renders active workspaces with model family, intents, pins, overlap and arenas', async () => {
    const r = await call(p('coord', 'activity'));
    expect(r.status, r.text).toBe(200);
    expect(r.cacheControl).toBe('no-store');
    // Agent and model family.
    expect(r.text).toContain('Atlas');
    expect(r.text).toContain('opus-4.5');
    expect(r.text).toContain('Fix the parser');
    // Intent paths, pin chain, branch and diff link.
    expect(r.text).toContain('intent');
    expect(r.text).toContain('src/a.ts');
    expect(r.text).toContain('pins');
    expect(r.text).toContain('wsatlas');
    expect(r.text).toContain('agents/wsatlas/fix-parser');
    expect(r.text).toContain(`href="/${OWNER}/coord/compare/main...agents%2Fwsatlas%2Ffix-parser"`);
    // Overlap highlighted on the row and detailed in its section.
    expect(r.text).toContain('overlap');
    expect(r.text).toContain('src/shared.txt');
    expect(r.text).toContain('shared path');
    // Arena preview.
    expect(r.text).toContain('Fix the parser two ways');
    // The merged workspace is hidden behind `all`.
    expect(r.text).not.toContain('Old work');
    const all = await call(p('coord', 'activity?status=all'));
    expect(all.text).toContain('Old work');
    // Bounded, indexed reads: the page budget.
    expect(r.cost.d1).toBeLessThanOrEqual(8);
    expect(r.cost.art).toBe(0);
  });

  it('conceals a private repository from anonymous and outsider viewers', async () => {
    for (const [who, token] of [['anonymous', undefined], ['outsider', tok.outsider]] as const) {
      const denied = await call(p('secret', 'activity'), token);
      expect(denied.status, who).toBe(404);
      const deniedTrain = await call(p('secret', 'train'), token);
      expect(deniedTrain.status, who).toBe(404);
      const deniedArena = await call(p('secret', 'arenas'), token);
      expect(deniedArena.status, who).toBe(404);
    }
    const owner = await call(p('secret', 'activity'), tok.owner);
    expect(owner.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Train
// ---------------------------------------------------------------------------

describe('train page', () => {
  it('renders entries by target, exit history with reasons, conflict tasks and refreshes', async () => {
    const r = await call(p('coord', 'train'));
    expect(r.status, r.text).toBe(200);
    expect(r.refresh).toBe('10');
    expect(r.cacheControl).toBe('no-store');
    expect(r.text).toContain('→ <code>main</code>');
    expect(r.text).toContain('checking');
    expect(r.text).toContain('queued');
    expect(r.text).toContain('attempt');
    expect(r.text).toContain('Atlas');
    // The ejection and its reason.
    expect(r.text).toContain('Recent exits');
    expect(r.text).toContain('CHECKS_FAILED');
    expect(r.text).toContain('kvarm/guard failed on the composed tree');
    // The conflict task the ejection spawned, with its paths.
    expect(r.text).toContain('resolve-conflict');
    expect(r.text).toContain('src/shared.txt');
    expect(r.text).toContain('needs regeneration');
    expect(r.text).toContain('+ more paths');
    expect(r.cost.d1).toBeLessThanOrEqual(5);
    expect(r.cost.art).toBe(0);
  });

  it('renders an empty train without work', async () => {
    const r = await call(p('quiet', 'train'));
    expect(r.status).toBe(200);
    expect(r.text).toContain('the train is empty');
    expect(r.refresh).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// Arenas and candidate comparison
// ---------------------------------------------------------------------------

describe('arena pages', () => {
  it('lists arenas', async () => {
    const r = await call(p('coord', 'arenas'));
    expect(r.status).toBe(200);
    expect(r.text).toContain('Fix the parser two ways');
    expect(r.text).toContain('2 candidates');
  });

  it('compares the arena candidates against base and each other, ranked, with checks and duplication', async () => {
    const r = await call(p('coord', 'arenas/ar1'));
    expect(r.status, r.text).toBe(200);
    // Ranked candidates side by side.
    expect(r.text).toContain('<span class="rank">#1</span>');
    expect(r.text).toContain('Atlas');
    expect(r.text).toContain('Boreas');
    expect(r.text).toContain('refs/heads/agents/wsatlas/fix-parser'.slice('refs/heads/'.length));
    expect(r.text).toContain('checks:');
    // Against base and each other.
    expect(r.text).toContain('Candidates against base');
    expect(r.text).toContain('Candidate against candidate');
    expect(r.text).toMatch(/wsatlas<\/code> <span class="muted">vs<\/span> <code>wsboreas/);
    // Duplication from the Nexus index: both rewrote src/shared.txt.
    expect(r.text).toContain('Duplication');
    expect(r.text).toContain('1 shared');
    // Full diff link per candidate.
    expect(r.text).toContain(`/${OWNER}/coord/compare/main...agents%2Fwsatlas%2Ffix-parser`);
    // Selection goes through the normal merge policy.
    expect(r.text).toContain('normal merge policy');
    // Anonymous sees no select buttons.
    expect(r.text).not.toContain('Select winner');
  });

  it('shows the select control to a write viewer and records the selection on POST', async () => {
    const owner = await call(p('coord', 'arenas/ar1'), tok.owner);
    expect(owner.status).toBe(200);
    expect(owner.text).toContain('Select winner');

    const anonymous = await call(p('coord', 'arenas/ar1/select'), undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'workspace=wsatlas',
    });
    expect(anonymous.status).toBe(404);

    const select = await call(p('coord', 'arenas/ar1/select'), tok.owner, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'workspace=wsatlas',
    });
    expect(select.status).toBe(302);
    expect(select.location).toBe(p('coord', 'arenas/ar1'));

    const after = await call(p('coord', 'arenas/ar1'));
    expect(after.text).toContain('selected');
    expect(after.text).toContain('the winner merges through its own change set under the normal policy');

    // A bad candidate is a readable error, not a crash.
    const bad = await call(p('coord', 'arenas/ar1/select'), tok.owner, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'workspace=nosuch',
    });
    expect(bad.status).toBe(200);
    expect(bad.text).toContain('nosuch is not a candidate of this arena');
  });
});

describe('free-form candidate comparison', () => {
  it('compares any 1-8 workspaces at a base from query parameters', async () => {
    const r = await call(p('coord', 'candidates?workspaces=wsatlas&workspaces=wsboreas'));
    expect(r.status, r.text).toBe(200);
    expect(r.text).toContain('2 workspace(s) at base');
    expect(r.text).toContain('<span class="rank">#1</span>');
    expect(r.text).toContain('Atlas');
    // The overlap section (advisory) of a candidates set.
    expect(r.text).toContain('Overlap with other workspaces');
  });

  it('renders the form when no workspaces are given and a readable error for a bad set', async () => {
    const form = await call(p('coord', 'candidates'));
    expect(form.status).toBe(200);
    expect(form.text).toContain('Compare workspaces');

    // An unknown id is an honest 404 that still renders the form with the reason.
    const bad = await call(p('coord', 'candidates?workspaces=nosuchws'));
    expect(bad.status).toBe(404);
    expect(bad.text).toContain('Compare workspaces');
    expect(bad.text).toContain('workspace not found: nosuchws');
  });
});
