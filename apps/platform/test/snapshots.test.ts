/**
 * Snapshots (architecture §11.5): SnapshotBuilder steps over an in-memory
 * Artifacts and the local R2 bucket, and the snapshot API.
 *
 * The builder runs through a test step runner that persists every step result
 * the way Workflows does (streams re-read from stored bytes, JSON round
 * trips) and can retry a step, so replay and interruption are exercised on
 * the real step bodies.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { snapshotInstanceId } from '../src/services/events';
import { BLOBS_PER_STEP, buildSnapshot, snapshotKey, type BuildCost, type SnapshotParams, type StepRunner } from '../src/workflows/snapshotBuilder';
import worker from '../src/index';
import {
  FakeRepo,
  blobHash,
  commit,
  fakeArtifacts,
  fakeRepos,
  installFakeGitRemote,
  lsRefsCalls,
  readTar,
  restoreFetch,
  type Files,
  type TarMember,
} from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const OWNER = 'snap-owner';
const FULL: Scope[] = ['read', 'write', 'api'];

// ---------------------------------------------------------------------------
// Workflow fakes
// ---------------------------------------------------------------------------

async function persist<T>(value: T): Promise<T> {
  if (value instanceof ReadableStream) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    return new Blob([bytes]).stream() as T;
  }
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** Runs steps like Workflows: results persisted, failed steps retried from the same input. */
class Runner implements StepRunner {
  steps: string[] = [];
  attempts: string[] = [];
  gates = new Map<string, Promise<void>>();

  constructor(private readonly retries = 0) {}

  async do<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.gates.get(name);
    this.steps.push(name);
    for (let attempt = 0; ; attempt++) {
      this.attempts.push(name);
      try {
        return await persist(await fn());
      } catch (err) {
        if (attempt >= this.retries) throw err;
      }
    }
  }
}

/** SnapshotBuilder binding: unique instance ids; `drain` runs created instances. */
class FakeBuilder {
  instances = new Map<string, SnapshotParams>();
  creates: string[] = [];
  ran = new Set<string>();

  async create(opts: { id: string; params: SnapshotParams }) {
    if (this.instances.has(opts.id)) throw new Error(`instance.already_exists: ${opts.id}`);
    this.instances.set(opts.id, opts.params);
    this.creates.push(opts.id);
    return { id: opts.id };
  }

  async get(id: string) {
    if (!this.instances.has(id)) throw new Error('instance.not_found');
    return { id };
  }

  async drain(runner = () => new Runner()) {
    for (const [id, params] of this.instances) {
      if (this.ran.has(id)) continue;
      this.ran.add(id);
      await buildSnapshot(env, { ...params, instanceId: id }, runner()).catch(() => undefined);
    }
  }
}

const builder = new FakeBuilder();
const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: builder as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

// ---------------------------------------------------------------------------
// Principals, repos and requests
// ---------------------------------------------------------------------------

const tok = { owner: '', outsider: '' };

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    'INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
  )
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public'): Promise<{ id: string; repo: FakeRepo }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, visibility, Date.now())
    .run();
  return { id, repo };
}

interface Reply {
  status: number;
  json: Record<string, unknown>;
  bytes: Uint8Array;
  headers: Headers;
  cost: CostCounters;
}

async function call(path: string, opts: { token?: string; method?: string } = {}): Promise<Reply> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
  const req = new Request(`${ORIGIN}${path}`, { method: opts.method ?? 'GET', headers });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    // tar bytes or plain text
  }
  return { status: res.status, json, bytes, headers: res.headers, cost: cost! };
}

const snap = (repo: string, ref: string) => `/api/v1/repos/${OWNER}/${repo}/snapshots/${ref}`;

async function commitRow(repoId: string, sha: string) {
  return env.DB.prepare('SELECT * FROM snapshot_commits WHERE repo_id = ? AND sha = ?')
    .bind(repoId, sha)
    .first<{ state: string; tree: string; reused: number; build_cost: string | null; built_at: number | null; instance_id: string; error: string | null }>();
}

async function objectKeys(repoId: string): Promise<string[]> {
  const list = await env.SNAPSHOTS.list({ prefix: `trees/v1/${repoId}/` });
  return list.objects.map((o) => o.key);
}

async function tarball(repoId: string, tree: string): Promise<Uint8Array> {
  const obj = await env.SNAPSHOTS.get(snapshotKey(repoId, tree));
  expect(obj).not.toBeNull();
  return new Uint8Array(await obj!.arrayBuffer());
}

/** What a checkout of `files` contains: every file, symlink and (implied) directory. */
function expectedMembers(files: Files): Map<string, { type: string; mode: number; data?: string; linkname?: string }> {
  const out = new Map<string, { type: string; mode: number; data?: string; linkname?: string }>();
  for (const [path, spec] of Object.entries(files)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) out.set(parts.slice(0, i).join('/'), { type: 'dir', mode: 0o755 });
    const { content, mode } = typeof spec === 'string' || spec instanceof Uint8Array ? { content: spec, mode: '100644' } : spec;
    const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
    if (mode === '120000') out.set(path, { type: 'symlink', mode: 0o777, linkname: text });
    else out.set(path, { type: 'file', mode: mode === '100755' ? 0o755 : 0o644, data: text });
  }
  return out;
}

function checkTar(members: TarMember[], files: Files): void {
  const want = expectedMembers(files);
  expect(new Set(members.map((m) => m.path))).toEqual(new Set(want.keys()));
  expect(members.length).toBe(want.size);
  for (const m of members) {
    const w = want.get(m.path)!;
    expect({ path: m.path, type: m.type, mode: m.mode }).toEqual({ path: m.path, type: w.type, mode: w.mode });
    if (w.type === 'file') expect(new TextDecoder().decode(m.data)).toBe(w.data);
    if (w.type === 'symlink') expect(m.linkname).toBe(w.linkname);
  }
  // Pre-order: every directory precedes its contents.
  const seen = new Set<string>();
  for (const m of members) {
    const parent = m.path.includes('/') ? m.path.slice(0, m.path.lastIndexOf('/')) : null;
    if (parent) expect(seen.has(parent), `${parent} before ${m.path}`).toBe(true);
    seen.add(m.path);
  }
}

const longName = `${'d'.repeat(60)}/${'e'.repeat(60)}/${'n'.repeat(120)}.txt`;
const SMALL: Files = {
  'README.md': '# snap\n',
  'bin/run.sh': { content: '#!/bin/sh\necho run\n', mode: '100755' },
  'docs/résumé-日本.md': 'unicode\n',
  'docs/empty.txt': '',
  'link': { content: 'README.md', mode: '120000' },
  [longName]: 'deep file\n',
};

/** F files of `size` bytes in 10 directories. */
function manyFiles(count: number, size: number, salt = ''): Files {
  const files: Files = {};
  for (let i = 0; i < count; i++) {
    const head = `file ${i}${salt}\n`;
    files[`d${i % 10}/f${String(i).padStart(5, '0')}.txt`] = head + 'x'.repeat(Math.max(0, size - head.length - 1)) + '\n';
  }
  return files;
}

beforeAll(async () => {
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('snap-outsider'), 'outsider', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

describe('SnapshotBuilder', () => {
  it('builds a tar of the commit tree: modes, symlinks, long and unicode paths, empty files', async () => {
    const { id, repo } = await seedRepo('small');
    const c = await commit(repo, SMALL);
    const runner = new Runner();
    const out = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-small' }, runner);
    expect(out.outcome).toBe('built');
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'finish']);
    const bytes = await tarball(id, c.tree);
    checkTar(readTar(bytes), SMALL);

    const row = await commitRow(id, c.sha);
    expect(row).toMatchObject({ state: 'ready', tree: c.tree, reused: 0 });
    const cost = JSON.parse(row!.build_cost!) as BuildCost;
    // resolve: repo row + claim batch, get + readCommit; batch: get + 5 trees + 6 blob/symlink reads, one put; finish: one batch.
    expect(cost).toMatchObject({ steps: 3, d1: 3, art: 2 + 1 + 5 + 6, r2a: 1, r2b: 0, treeReads: 5, blobReads: 6, parts: 0, objects: 1, reused: false });
    expect(cost.bytes).toBe(bytes.length);
    const tree = await env.DB.prepare('SELECT size, files FROM snapshot_trees WHERE repo_id = ? AND tree = ?')
      .bind(id, c.tree)
      .first<{ size: number; files: number }>();
    expect(tree).toEqual({ size: bytes.length, files: 6 });
  });

  it(`batches about ${BLOBS_PER_STEP} blobs per step and streams multipart parts (steps <= ceil(F/500)+2)`, async () => {
    const { id, repo } = await seedRepo('many');
    const files = manyFiles(1001, 9000);
    const c = await commit(repo, files);
    const runner = new Runner();
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-many' }, runner);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'batch-2', 'batch-3', 'finish']);
    const cost = JSON.parse((await commitRow(id, c.sha))!.build_cost!) as BuildCost;
    expect(cost.steps).toBe(5);
    expect(cost.steps).toBeLessThanOrEqual(Math.ceil(1001 / 500) + 2);
    expect(cost.blobReads).toBe(1001);
    // ~9.3 MB: one full 8 MiB part plus the tail, written as one object.
    expect(cost.parts).toBe(2);
    expect(cost.objects).toBe(1);
    expect(cost.r2a).toBe(1 + 2 + 1);
    const bytes = await tarball(id, c.tree);
    expect(cost.bytes).toBe(bytes.length);
    checkTar(readTar(bytes), files);
  });

  it('retries an interrupted batch from its persisted input and still writes a correct tar', async () => {
    const { id, repo } = await seedRepo('retry');
    const files = manyFiles(1001, 9000, '-retry');
    const c = await commit(repo, files);
    // A blob in the second batch fails once, after that step already uploaded a part.
    const victim = Object.keys(files).sort()[900]!;
    repo.failBlobOnce.add(await blobHash(files[victim] as string));
    const runner = new Runner(2);
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-retry' }, runner);
    expect(runner.attempts.filter((s) => s.startsWith('batch-')).length).toBe(4);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'batch-2', 'batch-3', 'finish']);
    checkTar(readTar(await tarball(id, c.tree)), files);
    expect(await objectKeys(id)).toEqual([snapshotKey(id, c.tree)]);
  });

  it('a commit with an already-built tree reuses the tarball and keeps its own metadata', async () => {
    const { id, repo } = await seedRepo('reuse');
    const first = await commit(repo, SMALL);
    await buildSnapshot(env, { repoId: id, sha: first.sha, instanceId: 'snap-reuse-1' }, new Runner());
    const second = await commit(repo, SMALL, [first.sha]);
    expect(second.tree).toBe(first.tree);
    const before = repo.count('readBlob');
    const runner = new Runner();
    const out = await buildSnapshot(env, { repoId: id, sha: second.sha, instanceId: 'snap-reuse-2', trigger: 'demand' }, runner);
    expect(out.outcome).toBe('done');
    expect(runner.steps).toEqual(['resolve']);
    expect(repo.count('readBlob')).toBe(before);
    expect(await objectKeys(id)).toEqual([snapshotKey(id, first.tree)]);
    const a = await commitRow(id, first.sha);
    const b = await commitRow(id, second.sha);
    expect(b).toMatchObject({ state: 'ready', tree: first.tree, reused: 1 });
    expect(a!.reused).toBe(0);
    expect(JSON.parse(b!.build_cost!)).toMatchObject({ steps: 1, r2a: 0, objects: 0, blobReads: 0, reused: true });
  });

  it('replaying a finished build does nothing', async () => {
    const { id, repo } = await seedRepo('replay');
    const c = await commit(repo, SMALL);
    await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-replay' }, new Runner());
    const row = await commitRow(id, c.sha);
    const reads = repo.calls.length;
    const runner = new Runner();
    const out = await buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-replay' }, runner);
    expect(out).toMatchObject({ outcome: 'done', reason: 'ready' });
    expect(runner.steps).toEqual(['resolve']);
    expect(repo.calls.length - reads).toBe(1); // the commit read only
    expect(await commitRow(id, c.sha)).toEqual(row);
  });

  it('a commit waiting on a tree another instance is building becomes ready when that build finishes', async () => {
    const { id, repo } = await seedRepo('wait');
    const x = await commit(repo, SMALL);
    const y = await commit(repo, SMALL, [x.sha]);
    let release!: () => void;
    const slow = new Runner();
    slow.gates.set('batch-1', new Promise<void>((r) => (release = r)));
    const xBuild = buildSnapshot(env, { repoId: id, sha: x.sha, instanceId: 'snap-wait-x' }, slow);
    await new Promise((r) => setTimeout(r, 50));
    const yOut = await buildSnapshot(env, { repoId: id, sha: y.sha, instanceId: 'snap-wait-y' }, new Runner());
    expect(yOut.reason).toBe('waiting on snap-wait-x');
    expect((await commitRow(id, y.sha))!.state).toBe('building');
    release();
    await xBuild;
    expect(await commitRow(id, y.sha)).toMatchObject({ state: 'ready', reused: 1 });
    expect(await objectKeys(id)).toHaveLength(1);
  });

  it('marks the commit and tree failed when the build cannot finish', async () => {
    const { id, repo } = await seedRepo('broken');
    const c = await commit(repo, { 'a.txt': 'a\n', 'b.txt': 'gone\n' });
    for (const [hash, o] of repo.objects) if (o.type === 'blob' && new TextDecoder().decode(o.content) === 'gone\n') repo.objects.delete(hash);
    const runner = new Runner(1);
    await expect(buildSnapshot(env, { repoId: id, sha: c.sha, instanceId: 'snap-broken' }, runner)).rejects.toThrow(/not found/);
    expect(runner.steps).toEqual(['resolve', 'batch-1', 'fail']);
    expect(await commitRow(id, c.sha)).toMatchObject({ state: 'failed' });
    const tree = await env.DB.prepare('SELECT state FROM snapshot_trees WHERE repo_id = ? AND tree = ?').bind(id, c.tree).first();
    expect(tree).toEqual({ state: 'failed' });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('snapshot API', () => {
  const fx = {} as { id: string; repo: FakeRepo; main: { sha: string; tree: string }; feature: { sha: string; tree: string } };

  beforeAll(async () => {
    const seeded = await seedRepo('api');
    fx.id = seeded.id;
    fx.repo = seeded.repo;
    fx.main = await commit(fx.repo, SMALL);
    fx.feature = await commit(fx.repo, { ...SMALL, 'feature.txt': 'feature\n' }, [fx.main.sha]);
    fx.repo.refs.set('refs/heads/main', fx.main.sha);
    fx.repo.refs.set('refs/heads/agents/w1', fx.feature.sha);
  });

  it('returns 404 for unknown refs, SHAs and repos', async () => {
    expect((await call(snap('api', 'no-such-ref'), { token: tok.owner })).status).toBe(404);
    expect((await call(snap('api', 'no-such-ref/download'), { token: tok.owner })).status).toBe(404);
    expect((await call(snap('api', 'f'.repeat(40)), { token: tok.owner })).status).toBe(404);
    expect((await call(`/api/v1/repos/${OWNER}/no-such-repo/snapshots/main`, { token: tok.owner })).status).toBe(404);
  });

  it('metadata for an existing ref never starts a build (lazy until demanded)', async () => {
    const before = builder.creates.length;
    const res = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(res.status).toBe(202);
    expect(res.json).toMatchObject({ state: 'absent', sha: fx.feature.sha });
    const bySha = await call(snap('api', fx.feature.sha), { token: tok.owner });
    expect(bySha.status).toBe(202);
    expect((await call(snap('api', 'agents/w1/download'), { token: tok.owner })).status).toBe(409);
    expect(builder.creates.length).toBe(before);
    expect(await commitRow(fx.id, fx.feature.sha)).toBeNull();
  });

  it('demand needs an identified caller with read access', async () => {
    expect((await call(snap('api', 'agents/w1'), { method: 'POST' })).status).toBe(401);
    await seedRepo('hidden', 'private');
    expect((await call(snap('hidden', 'main'), { method: 'POST', token: tok.outsider })).status).toBe(404);
  });

  it('an explicit demand builds once: 202 building, then 200 ready by ref and by SHA', async () => {
    const demand = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(demand.status).toBe(202);
    expect(demand.json).toMatchObject({ state: 'building', sha: fx.feature.sha, started: true, trigger: 'demand' });
    expect(builder.creates.at(-1)).toBe(snapshotInstanceId(fx.id, fx.feature.sha));
    const building = await call(snap('api', 'agents%2Fw1'), { token: tok.owner });
    expect(building.status).toBe(202);
    expect(building.json.state).toBe('building');
    const again = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(again.json).toMatchObject({ state: 'building', started: false });
    expect(builder.creates.filter((x) => x === snapshotInstanceId(fx.id, fx.feature.sha))).toHaveLength(1);

    await builder.drain();
    const ready = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(ready.status).toBe(200);
    expect(ready.json).toMatchObject({ state: 'ready', sha: fx.feature.sha, tree: fx.feature.tree, files: 7, reused: false });
    expect(typeof ready.json.builtAt).toBe('string');
    expect(ready.json.size).toBeGreaterThan(0);
    expect((ready.json.buildCost as BuildCost).steps).toBeLessThanOrEqual(Math.ceil(7 / 500) + 2);
    const bySha = await call(snap('api', fx.feature.sha), { token: tok.owner });
    expect(bySha.status).toBe(200);
    expect(bySha.json.size).toBe(ready.json.size);
    const done = await call(snap('api', 'agents/w1'), { method: 'POST', token: tok.owner });
    expect(done.status).toBe(200);
    expect(done.json.started).toBe(false);
  });

  it('warm metadata reads no Artifacts (d1 <= 2, art = 0); download is one R2 class-B read', async () => {
    const warmup = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(warmup.status).toBe(200);
    const lsBefore = lsRefsCalls.length;
    const warm = await call(snap('api', 'agents/w1'), { token: tok.owner });
    expect(warm.status).toBe(200);
    expect(warm.cost).toMatchObject({ art: 0, sub: 0, do: 0 });
    expect(warm.cost.d1).toBeLessThanOrEqual(2);
    expect(lsRefsCalls.length).toBe(lsBefore);

    const dl = await call(snap('api', 'agents/w1/download'), { token: tok.owner });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/x-tar');
    expect(dl.cost).toMatchObject({ r2b: 1, r2a: 0, art: 0, do: 0 });
    expect(dl.cost.d1).toBeLessThanOrEqual(2);
    expect(dl.bytes.length).toBe(warm.json.size);
    expect(Number(dl.headers.get('content-length'))).toBe(warm.json.size);
    checkTar(readTar(dl.bytes), { ...SMALL, 'feature.txt': 'feature\n' });
  });

  it('a failed build reports 409 and a new demand retries it', async () => {
    const { id, repo } = await seedRepo('flaky');
    const c = await commit(repo, { 'ok.txt': 'ok\n', 'lost.txt': 'lost\n' });
    repo.refs.set('refs/heads/main', c.sha);
    const lost = [...repo.objects].find(([, o]) => o.type === 'blob' && new TextDecoder().decode(o.content) === 'lost\n')!;
    repo.objects.delete(lost[0]);
    expect((await call(snap('flaky', 'main'), { method: 'POST', token: tok.owner })).status).toBe(202);
    await builder.drain();
    const failed = await call(snap('flaky', 'main'), { token: tok.owner });
    expect(failed.status).toBe(409);
    expect(failed.json).toMatchObject({ state: 'failed', code: 'SNAPSHOT_FAILED' });

    repo.objects.set(lost[0], lost[1]);
    const retry = await call(snap('flaky', 'main'), { method: 'POST', token: tok.owner });
    expect(retry.json).toMatchObject({ state: 'building', started: true });
    expect(builder.creates.at(-1)).toBe(`${snapshotInstanceId(id, c.sha)}-r1`);
    await builder.drain();
    expect((await call(snap('flaky', 'main'), { token: tok.owner })).json.state).toBe('ready');
  });

  it('private snapshots are concealed from anonymous and unrelated callers', async () => {
    const { id, repo } = await seedRepo('secret', 'private');
    const c = await commit(repo, SMALL);
    repo.refs.set('refs/heads/main', c.sha);
    expect((await call(snap('secret', 'main'), { method: 'POST', token: tok.owner })).status).toBe(202);
    await builder.drain();
    for (const token of [undefined, tok.outsider]) {
      expect((await call(snap('secret', 'main'), { token })).status).toBe(404);
      expect((await call(snap('secret', 'main/download'), { token })).status).toBe(404);
    }
    expect((await call(snap('secret', 'main'), { token: tok.owner })).status).toBe(200);
    const meta = await call(snap('secret', 'main'), { token: tok.owner });
    const dl = await call(snap('secret', 'main/download'), { token: tok.owner });
    expect(dl.status).toBe(200);
    expect(dl.bytes.length).toBe(meta.json.size);
    expect((await commitRow(id, c.sha))!.state).toBe('ready');
  });

  it('a visibility flip denies warmed snapshot metadata and downloads immediately', async () => {
    const { id, repo } = await seedRepo('flip');
    const c = await commit(repo, SMALL);
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('flip', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    for (let i = 0; i < 2; i++) {
      expect((await call(snap('flip', 'main'))).status).toBe(200);
      expect((await call(snap('flip', 'main/download'))).status).toBe(200);
    }
    // Direct D1 flip, as another colo would see it: no purge here.
    await env.DB.prepare("UPDATE repos SET visibility = 'private' WHERE id = ?").bind(id).run();
    for (const token of [undefined, tok.outsider]) {
      const meta = await call(snap('flip', 'main'), { token });
      expect(meta.status).toBe(404);
      expect(meta.json.size).toBeUndefined();
      const dl = await call(snap('flip', 'main/download'), { token });
      expect(dl.status).toBe(404);
      expect(dl.cost.r2b).toBe(0);
    }
    expect((await call(snap('flip', 'main'), { token: tok.owner })).status).toBe(200);
    expect((await call(snap('flip', 'main/download'), { token: tok.owner })).status).toBe(200);
  });

  it('deleting a repo removes its snapshot rows and tarballs', async () => {
    const { id, repo } = await seedRepo('doomed');
    const c = await commit(repo, SMALL);
    repo.refs.set('refs/heads/main', c.sha);
    await call(snap('doomed', 'main'), { method: 'POST', token: tok.owner });
    await builder.drain();
    expect(await objectKeys(id)).toHaveLength(1);
    const deleteEnv = { ...env, ARTIFACTS: { ...fakeArtifacts, delete: async () => true } } as unknown as Env;
    const { deleteRepo } = await import('../src/repos/service');
    const row = await env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(id).first();
    const out = await deleteRepo(deleteEnv, row as never);
    expect(out.ok).toBe(true);
    expect(await objectKeys(id)).toHaveLength(0);
    expect(await commitRow(id, c.sha)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Push events -> eager default-branch snapshots
// ---------------------------------------------------------------------------

describe('push events and snapshots', () => {
  function pushBody(artifactsName: string, ref: string, before: string, after: string, at: number) {
    return {
      type: 'cf.artifacts.repo.pushed',
      source: { type: 'artifacts', namespace: 'default', repoName: artifactsName },
      payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
      metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
    };
  }

  async function deliver(body: unknown, id = crypto.randomUUID()) {
    const batch = createMessageBatch('forge-events', [{ id, timestamp: new Date(), attempts: 1, body }]);
    const ctx = createExecutionContext();
    await worker.queue!(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);
    return result;
  }

  async function readyMeta(repo: string) {
    const res = await call(snap(repo, 'main'), { token: tok.owner });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { sha, size, files, builtAt, tree } = res.json as Record<string, unknown>;
    return { sha, size, files, builtAt, tree };
  }

  it('A-B-A-B reuses existing snapshots; replaying a delivery adds no work; workspace pushes stay lazy', async () => {
    const { id, repo } = await seedRepo('cycle');
    const name = `${OWNER}--cycle`;
    const ZERO = '0'.repeat(40);
    const A = await commit(repo, { 'a.txt': 'A\n' });
    const B = await commit(repo, { 'a.txt': 'B\n', 'b.txt': 'b\n' }, [A.sha]);
    const t0 = Date.now();

    repo.refs.set('refs/heads/main', A.sha);
    await deliver(pushBody(name, 'refs/heads/main', ZERO, A.sha, t0));
    await builder.drain();
    const metaA = await readyMeta('cycle');
    expect(metaA.sha).toBe(A.sha);

    repo.refs.set('refs/heads/main', B.sha);
    const abId = crypto.randomUUID();
    const ab = pushBody(name, 'refs/heads/main', A.sha, B.sha, t0 + 1000);
    await deliver(ab, abId);
    await builder.drain();
    const metaB = await readyMeta('cycle');
    expect(metaB.sha).toBe(B.sha);

    const creates = builder.creates.length;
    const objects = await objectKeys(id);
    repo.refs.set('refs/heads/main', A.sha);
    await deliver(pushBody(name, 'refs/heads/main', B.sha, A.sha, t0 + 2000));
    await builder.drain();
    expect(await readyMeta('cycle')).toEqual(metaA);

    repo.refs.set('refs/heads/main', B.sha);
    await deliver(pushBody(name, 'refs/heads/main', A.sha, B.sha, t0 + 3000));
    await builder.drain();
    expect(await readyMeta('cycle')).toEqual(metaB);

    // Replay the exact earlier A->B delivery: a duplicate, no new work.
    await deliver(ab, abId);
    await builder.drain();
    expect(builder.creates.length).toBe(creates);
    expect(await objectKeys(id)).toEqual(objects);
    expect(objects).toHaveLength(2);

    // A workspace push records the event but builds nothing.
    const W = await commit(repo, { 'w.txt': 'w\n' }, [B.sha]);
    repo.refs.set('refs/heads/agents/x', W.sha);
    await deliver(pushBody(name, 'refs/heads/agents/x', ZERO, W.sha, t0 + 4000));
    expect(builder.creates.length).toBe(creates);
    expect((await call(snap('cycle', 'agents/x'), { token: tok.owner })).json.state).toBe('absent');
  });
});
