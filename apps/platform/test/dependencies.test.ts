/**
 * Nexus pinned draft dependencies (services/dependencies.ts) through the
 * Worker's routes, the push queue and the integration train, over the
 * in-memory Artifacts fake. Train runs are driven directly with recorded
 * kicks, as in queue.test.ts.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@forge/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import type { ChecksGate, CheckState } from '../src/services/checksGate';
import { TRAIN_LIMITS, defaultTrainDeps, fairOrder, runTrain, type TrainDeps, type TrainEvent } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'dep-owner';
const MAIN = 'refs/heads/main';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const sent: Array<{ body: any; delaySeconds?: number }> = [];
const fakeEvents = {
  async send(body: unknown, opts?: { delaySeconds?: number }) {
    sent.push({ body, ...(opts?.delaySeconds !== undefined ? { delaySeconds: opts.delaySeconds } : {}) });
  },
  async sendBatch(msgs: Array<{ body: unknown }>) {
    for (const m of msgs) sent.push({ body: m.body });
  },
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', writer: '' };
const repoIds: Record<string, string> = {};
const userIds: Record<string, string> = {};
const repos: Record<string, FakeRepo> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

/** A public repo whose main holds README.md. */
async function seedRepo(name: string): Promise<{ repo: FakeRepo; main: string }> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  repos[name] = repo;
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set(MAIN, main.sha);
  return { repo, main: main.sha };
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

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const deps = (repo: string, ws: string) => api(repo, `/workspaces/${ws}/dependencies`);
const pin = (repo: string, ws: string, onWorkspace: string, revision: string, token = tok.owner) =>
  call('POST', deps(repo, ws), token, { onWorkspace, revision });
const listDeps = (repo: string, ws: string, token: string | undefined = tok.owner) => call('GET', deps(repo, ws), token);
const repin = (repo: string, ws: string, id: string, body: unknown) => call('POST', `${deps(repo, ws)}/${id}/repin`, tok.owner, body);
const detach = (repo: string, ws: string, id: string) => call('DELETE', `${deps(repo, ws)}/${id}`, tok.owner);
const enqueue = (repo: string, n: number, token = tok.owner) => call('POST', api(repo, `/changes/${n}/enqueue`), token);
const merge = (repo: string, n: number) => call('POST', api(repo, `/changes/${n}/merge`), tok.owner);
const getChange = (repo: string, n: number) => call('GET', api(repo, `/changes/${n}`), tok.owner);
const trainStatus = (repo: string, q = '') => call('GET', api(repo, `/train${q}`), tok.owner);

interface Ws {
  id: string;
  ref: string;
  head: string;
  change?: number;
}

function pushEvent(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('forge-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

let clock = Date.now();

/** Moves a ref to a new commit (as a git push would) and delivers its push event. */
async function push(name: string, ref: string, files: Files, parents: string[]): Promise<string> {
  const repo = repos[name]!;
  const before = repo.refs.get(ref) ?? '0'.repeat(40);
  const c = await commit(repo, files, parents);
  repo.refs.set(ref, c.sha);
  clock += 1000;
  await deliver(pushEvent(name, ref, before, c.sha, clock));
  return c.sha;
}

/** A workspace with one pushed commit adding `<file>`; optionally a change set opened from it. */
async function workspace(name: string, file: string, opts: { change?: 'review' | 'auto' | false; token?: string; base?: string } = {}): Promise<Ws> {
  const created = await call('POST', api(name, '/workspaces'), opts.token ?? tok.owner, { task: `work on ${file}`, agent: 'agent', ...(opts.base ? { base: opts.base } : {}) });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const { id, ref, baseSha } = created.json as { id: string; ref: string; baseSha: string };
  const head = await push(name, ref, { 'README.md': 'readme\n', [file]: `${file}\n` }, [baseSha]);
  const ws: Ws = { id, ref, head };
  if (opts.change !== false && opts.change !== undefined) {
    const ch = await call('POST', api(name, `/workspaces/${id}/change-set`), opts.token ?? tok.owner, {
      title: `Change ${file}`,
      mergePolicy: opts.change,
      ...(opts.base ? { base: opts.base } : {}),
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    ws.change = ch.json.number as number;
  }
  return ws;
}

function commitOf(repo: FakeRepo, sha: string): { tree: string; parents: string[] } {
  const o = repo.objects.get(sha);
  expect(o?.type).toBe('commit');
  const head = decode(o!.content).split('\n\n')[0]!;
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
  };
}

function isAncestorOf(repo: FakeRepo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    stack.push(...commitOf(repo, sha).parents);
  }
  return false;
}

function firstParents(repo: FakeRepo, stop: string, ref = MAIN): string[] {
  const out: string[] = [];
  let sha = repo.refs.get(ref);
  while (sha && sha !== stop) {
    out.push(sha);
    sha = commitOf(repo, sha).parents[0];
  }
  return out;
}

function scriptedGate(fallback: CheckState = 'success') {
  const states = new Map<string, CheckState>();
  const s: { fallback: CheckState; states: Map<string, CheckState>; gate: ChecksGate } = {
    fallback,
    states,
    gate: {
      async requiredChecksFor(_repo, treeSha, configId) {
        const state: CheckState = states.get(treeSha) ?? s.fallback;
        return { treeSha, configId, required: [{ name: 'ci/test', state, producer: 'test' }], state };
      },
    } as ChecksGate,
  };
  return s;
}

function trainDeps(over: Partial<TrainDeps> = {}): TrainDeps & { events: TrainEvent[] } {
  const events: TrainEvent[] = [];
  return {
    ...defaultTrainDeps,
    kick: async (_env, repoId, ref, reason, delaySeconds) => {
      sent.push({ body: { type: 'forge.train', repoId, ref, reason }, ...(delaySeconds ? { delaySeconds } : {}) });
    },
    observe: (e) => events.push(e),
    events,
    ...over,
  };
}

async function rows(name: string): Promise<Array<{ change_number: number; state: string; active: number; reason_code: string | null; merge_commit: string | null }>> {
  return (
    (
      await env.DB.prepare('SELECT change_number, state, active, reason_code, merge_commit FROM merge_queue WHERE repo_id = ? ORDER BY seq')
        .bind(repoIds[name])
        .all<{ change_number: number; state: string; active: number; reason_code: string | null; merge_commit: string | null }>()
    ).results ?? []
  );
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.writer = (await mintPAT(env, await seedUser('dep-writer'), 'writer', FULL)).token;
});

afterAll(() => restoreFetch());

afterEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('explicit pins', () => {
  it('creates an exact-revision pin only on request and lists it with its state and depth', async () => {
    await seedRepo('pin');
    const a = await workspace('pin', 'a.txt');
    const b = await workspace('pin', 'b.txt');
    const c = await workspace('pin', 'c.txt');

    const created = await pin('pin', b.id, a.id, a.head);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(created.json).toMatchObject({ workspaceId: b.id, onWorkspace: a.id, revision: a.head, state: 'active', depth: 2, sourceHead: a.head });
    expect(created.json.id).toEqual(expect.any(String));
    expect(created.cost.d1).toBeLessThanOrEqual(3);
    expect(created.cost.rr).toBeLessThanOrEqual(16);
    expect(created.cost.do).toBe(0);

    const listed = await listDeps('pin', b.id);
    expect(listed.status).toBe(200);
    expect(listed.json.dependencies).toEqual([created.json]);
    // Nothing is inferred: C has no edge, and neither has A.
    expect((await listDeps('pin', c.id)).json.dependencies).toEqual([]);
    expect((await listDeps('pin', a.id)).json.dependencies).toEqual([]);

    const warm = await listDeps('pin', b.id);
    expect(warm.cost).toMatchObject({ art: 0, do: 0, rw: 0 });
    expect(warm.cost.d1).toBeLessThanOrEqual(3);
  });

  it('refuses a missing, malformed or non-current revision and an unknown source, creating nothing', async () => {
    await seedRepo('bad-pin');
    const a = await workspace('bad-pin', 'a.txt');
    const b = await workspace('bad-pin', 'b.txt');
    const cases: Array<[unknown, number, string]> = [
      [{ onWorkspace: a.id }, 422, 'INVALID_REVISION'],
      [{ onWorkspace: a.id, revision: 'abc' }, 422, 'INVALID_REVISION'],
      [{ onWorkspace: a.id, revision: 'f'.repeat(40) }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: a.head }, 422, 'INVALID_WORKSPACE'],
      [{ onWorkspace: 'nope0000', revision: a.head }, 404, 'SOURCE_NOT_FOUND'],
      [{ onWorkspace: b.id, revision: b.head }, 422, 'DEPENDENCY_CYCLE'],
      [[1], 400, 'INVALID_BODY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await call('POST', deps('bad-pin', b.id), tok.owner, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
      expect(r.json.error).toEqual(expect.any(String));
    }
    const notCurrent = await pin('bad-pin', b.id, a.id, 'f'.repeat(40));
    expect(notCurrent.json).toMatchObject({ currentRevision: a.head });
    expect((await call('POST', deps('bad-pin', 'nope0000'), tok.owner, { onWorkspace: a.id, revision: a.head })).json.code).toBe('WORKSPACE_NOT_FOUND');
    expect((await listDeps('bad-pin', b.id)).json.dependencies).toEqual([]);
    // Writers only; readers may list.
    expect((await pin('bad-pin', b.id, a.id, a.head, tok.writer)).status).toBe(403);
    expect((await listDeps('bad-pin', b.id, undefined)).status).toBe(200);
    expect((await pin('bad-pin', b.id, a.id, a.head)).status).toBe(201);
    const dup = await pin('bad-pin', b.id, a.id, a.head);
    expect([dup.status, dup.json.code]).toEqual([409, 'DEPENDENCY_EXISTS']);
  });

  it('caps the chain at depth 4 with an actionable error, and a detach makes room again', async () => {
    await seedRepo('depth');
    const d = [];
    for (let i = 1; i <= 6; i++) d.push(await workspace('depth', `d${i}.txt`));
    const [d1, d2, d3, d4, d5, d6] = d as [Ws, Ws, Ws, Ws, Ws, Ws];
    expect((await pin('depth', d2.id, d1.id, d1.head)).json.depth).toBe(2);
    const e32 = await pin('depth', d3.id, d2.id, d2.head);
    expect(e32.json.depth).toBe(3);
    const e43 = await pin('depth', d4.id, d3.id, d3.head);
    expect(e43.status).toBe(201);
    expect(e43.json.depth).toBe(4);
    expect((await listDeps('depth', d4.id)).json.dependencies.map((e: any) => e.depth)).toEqual([4]);

    const deep = await pin('depth', d5.id, d4.id, d4.head);
    expect(deep.status).toBe(422);
    expect(deep.json).toMatchObject({ code: 'DEPENDENCY_DEPTH_EXCEEDED', maxDepth: 4, depth: 5, path: [d5.id, d4.id, d3.id, d2.id, d1.id] });
    expect(deep.json.error).toContain('4');
    expect(deep.cost.d1).toBeLessThanOrEqual(3);
    expect((await listDeps('depth', d5.id)).json.dependencies).toEqual([]);
    // Lengthening the chain from below is refused the same way.
    const below = await pin('depth', d1.id, d6.id, d6.head);
    expect([below.status, below.json.code]).toEqual([422, 'DEPENDENCY_DEPTH_EXCEEDED']);

    const off = await detach('depth', d3.id, e32.json.id);
    expect(off.status).toBe(200);
    expect(off.json).toMatchObject({ detached: true, dependency: { id: e32.json.id } });
    expect((await listDeps('depth', d4.id)).json.dependencies.map((e: any) => e.depth)).toEqual([2]);
    const again = await pin('depth', d5.id, d4.id, d4.head);
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect(again.json.depth).toBe(3);
  });

  it('rejects two- and three-node cycles naming the offending path, leaving every list unchanged', async () => {
    await seedRepo('cycle');
    const a = await workspace('cycle', 'a.txt');
    const b = await workspace('cycle', 'b.txt');
    const c = await workspace('cycle', 'c.txt');
    expect((await pin('cycle', b.id, a.id, a.head)).status).toBe(201);
    const two = await pin('cycle', a.id, b.id, b.head);
    expect(two.status).toBe(422);
    expect(two.json).toMatchObject({ code: 'DEPENDENCY_CYCLE', path: [a.id, b.id, a.id] });
    expect(two.json.error).toContain(`${a.id} -> ${b.id} -> ${a.id}`);
    expect((await listDeps('cycle', a.id)).json.dependencies).toEqual([]);
    expect((await listDeps('cycle', b.id)).json.dependencies).toHaveLength(1);

    expect((await pin('cycle', c.id, b.id, b.head)).status).toBe(201);
    const three = await pin('cycle', a.id, c.id, c.head);
    expect(three.status).toBe(422);
    expect(three.json).toMatchObject({ code: 'DEPENDENCY_CYCLE', path: [a.id, c.id, b.id, a.id] });
    expect((await listDeps('cycle', a.id)).json.dependencies).toEqual([]);
  });

  it('refuses a cross-repo source with no side effect in either repo', async () => {
    const one = await seedRepo('cross-one');
    await seedRepo('cross-two');
    const w1 = await workspace('cross-one', 'w1.txt');
    const w2 = await workspace('cross-two', 'w2.txt');
    const refsBefore = [...one.repo.refs.entries()];
    const r = await pin('cross-two', w2.id, w1.id, w1.head);
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('SOURCE_NOT_FOUND');
    expect(r.json.error).toContain('same repository');
    expect((await listDeps('cross-two', w2.id)).json.dependencies).toEqual([]);
    expect((await listDeps('cross-one', w1.id)).json.dependencies).toEqual([]);
    expect([...one.repo.refs.entries()]).toEqual(refsBefore);
  });

  it('validates and lists with work independent of unrelated workspaces', async () => {
    await seedRepo('cost-small');
    await seedRepo('cost-big');
    const measure = async (name: string) => {
      const chain: Ws[] = [];
      for (let i = 1; i <= 4; i++) chain.push(await workspace(name, `c${i}.txt`));
      for (let i = 1; i < 4; i++) expect((await pin(name, chain[i]!.id, chain[i - 1]!.id, chain[i - 1]!.head)).status).toBe(201);
      const extra = await workspace(name, 'x.txt');
      const create = await pin(name, extra.id, chain[0]!.id, chain[0]!.head);
      const reject = await pin(name, extra.id, chain[3]!.id, chain[3]!.head);
      const cycle = await pin(name, chain[0]!.id, chain[2]!.id, chain[2]!.head);
      await listDeps(name, chain[3]!.id);
      const list = await listDeps(name, chain[3]!.id);
      return { create: create.cost, reject: reject.cost, cycle: cycle.cost, list: list.cost, codes: [create.status, reject.json.code, cycle.json.code] };
    };
    // Many unrelated workspaces, half of them pinned to each other.
    const noise: Ws[] = [];
    for (let i = 0; i < 16; i++) noise.push(await workspace('cost-big', `noise${i}.txt`));
    for (let i = 1; i < 16; i += 2) expect((await pin('cost-big', noise[i]!.id, noise[i - 1]!.id, noise[i - 1]!.head)).status).toBe(201);
    const small = await measure('cost-small');
    const big = await measure('cost-big');
    expect(small.codes).toEqual([201, 'DEPENDENCY_DEPTH_EXCEEDED', 'DEPENDENCY_CYCLE']);
    expect(big.codes).toEqual(small.codes);
    // Rows read follow the chain; an index range probe may read one boundary row past its last match.
    const bound = { create: 16, reject: 20, cycle: 22, list: 22 };
    for (const k of ['create', 'reject', 'cycle', 'list'] as const) {
      expect(big[k].d1, k).toBe(small[k].d1);
      expect(Math.abs(big[k].rr - small[k].rr), k).toBeLessThanOrEqual(3);
      expect(big[k].rr, k).toBeLessThanOrEqual(bound[k]);
      expect(small[k].rr, k).toBeLessThanOrEqual(bound[k]);
      expect(big[k].do, k).toBe(0);
      expect(big[k].d1, k).toBeLessThanOrEqual(3);
    }
    expect(small.list).toMatchObject({ art: 0, rw: 0 });
  });
});

// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('a source push marks the pin stale without repinning it, and the dependent cannot publish', async () => {
    const { repo } = await seedRepo('stale');
    const a = await workspace('stale', 'a.txt', { change: 'review' });
    const b = await workspace('stale', 'b.txt', { change: 'review' });
    const edge = (await pin('stale', b.id, a.id, a.head)).json;
    const r2 = await push('stale', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);

    const listed = (await listDeps('stale', b.id)).json.dependencies;
    expect(listed).toEqual([expect.objectContaining({ id: edge.id, state: 'stale', revision: a.head, sourceHead: r2 })]);
    const q = await enqueue('stale', b.change!);
    expect(q.status).toBe(409);
    expect(q.json.code).toBe('DEPENDENCY_STALE');
    expect(q.json.error).toContain(a.id);
    expect(q.json.dependencies).toEqual([expect.objectContaining({ id: edge.id, state: 'stale' })]);
    const m = await merge('stale', b.change!);
    expect([m.status, m.json.code]).toEqual([409, 'DEPENDENCY_STALE']);
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect(repo.refs.get(a.ref)).toBe(r2);
    expect((await getChange('stale', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head, queueState: null });
  });

  it('a pin confirmed live stays active while its push event lags, until a newer push moves the source', async () => {
    const saved = clock;
    clock = Date.now() - 600_000;
    const { repo } = await seedRepo('lag');
    const a = await workspace('lag', 'a.txt');
    const b = await workspace('lag', 'b.txt');
    // The source moves, but its push event has not been delivered yet.
    const moved = await commit(repo, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);
    repo.refs.set(a.ref, moved.sha);

    const old = await pin('lag', b.id, a.id, a.head);
    expect([old.status, old.json.code, old.json.currentRevision]).toEqual([422, 'REVISION_NOT_CURRENT', moved.sha]);
    const created = await pin('lag', b.id, a.id, moved.sha);
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'active', sourceHead: moved.sha })]);

    // The late event for the pinned push is older than the pin and agrees with it.
    await deliver(pushEvent('lag', a.ref, a.head, moved.sha, Date.now() - 1000));
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'active', sourceHead: moved.sha })]);

    clock = Math.max(saved, Date.now() + 5000);
    const r3 = await push('lag', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v3\n' }, [moved.sha]);
    expect((await listDeps('lag', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'stale', sourceHead: r3, revision: moved.sha })]);
  });

  it('repin and detach are explicit and validated; neither touches the dependent', async () => {
    const { repo } = await seedRepo('repin');
    const a = await workspace('repin', 'a.txt');
    const b = await workspace('repin', 'b.txt', { change: 'review' });
    const other = await seedRepo('repin-other');
    const foreign = await workspace('repin-other', 'f.txt');
    const edge = (await pin('repin', b.id, a.id, a.head)).json;
    const r2 = await push('repin', a.ref, { 'README.md': 'readme\n', 'a.txt': 'a v2\n' }, [a.head]);

    for (const [body, status, code] of [
      [{ revision: 'f'.repeat(40) }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: a.head }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: foreign.head }, 422, 'REVISION_NOT_CURRENT'],
      [{ revision: r2, onWorkspace: foreign.id }, 404, 'SOURCE_NOT_FOUND'],
      [{}, 422, 'INVALID_REVISION'],
    ] as const) {
      const r = await repin('repin', b.id, edge.id, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await repin('repin', b.id, edge.id, { revision: 'f'.repeat(40) })).json.currentRevision).toBe(r2);
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([expect.objectContaining({ revision: a.head, state: 'stale' })]);
    expect(other.repo.refs.get(foreign.ref)).toBe(foreign.head);

    const ok = await repin('repin', b.id, edge.id, { revision: r2 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({
      id: edge.id,
      revision: r2,
      state: 'active',
      previous: { onWorkspace: a.id, revision: a.head, state: 'stale', reason: { code: 'SOURCE_MOVED' } },
    });
    expect(ok.cost.d1).toBeLessThanOrEqual(3);
    expect(ok.cost.do).toBe(0);
    const { previous: _previous, ...repinned } = ok.json;
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([repinned]);
    expect((await repin('repin', b.id, 'nope', { revision: r2 })).json.code).toBe('DEPENDENCY_NOT_FOUND');

    const off = await detach('repin', b.id, edge.id);
    expect(off.status).toBe(200);
    expect(off.cost.d1).toBeLessThanOrEqual(3);
    expect(off.cost.do).toBe(0);
    expect((await listDeps('repin', b.id)).json.dependencies).toEqual([]);
    expect((await detach('repin', b.id, edge.id)).status).toBe(404);
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect((await getChange('repin', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head });
    // Without the pin the dependent publishes.
    expect((await merge('repin', b.change!)).status).toBe(200);
  });

  it('abandoning the source breaks the pin; the dependent is blocked but otherwise intact, and recovers explicitly', async () => {
    const { repo } = await seedRepo('broken');
    const a = await workspace('broken', 'a.txt', { change: 'review' });
    const b = await workspace('broken', 'b.txt', { change: 'review' });
    const c = await workspace('broken', 'c.txt', { change: 'review' });
    const edge = (await pin('broken', b.id, a.id, a.head)).json;
    expect((await call('POST', api('broken', `/workspaces/${a.id}/abandon`), tok.owner)).status).toBe(200);

    expect((await listDeps('broken', b.id)).json.dependencies).toEqual([expect.objectContaining({ id: edge.id, state: 'broken', revision: a.head })]);
    for (const r of [await enqueue('broken', b.change!), await merge('broken', b.change!)]) {
      expect([r.status, r.json.code]).toEqual([409, 'DEPENDENCY_BROKEN']);
      expect(r.json.error).toContain(a.id);
    }
    expect(repo.refs.get(b.ref)).toBe(b.head);
    expect((await getChange('broken', b.change!)).json).toMatchObject({ state: 'open', headSha: b.head });

    // A repin onto the abandoned source is refused; onto a live workspace at its head it recovers.
    const dead = await repin('broken', b.id, edge.id, { revision: a.head });
    expect([dead.status, dead.json.code]).toEqual([409, 'SOURCE_NOT_ACTIVE']);
    const moved = await repin('broken', b.id, edge.id, { onWorkspace: c.id, revision: c.head });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json).toMatchObject({
      id: edge.id,
      onWorkspace: c.id,
      revision: c.head,
      state: 'active',
      previous: { onWorkspace: a.id, revision: a.head, state: 'broken', reason: { code: 'SOURCE_ABANDONED' } },
    });
    // Pending until C lands; then satisfied and B merges with C in its ancestry.
    expect((await merge('broken', b.change!)).json.code).toBe('DEPENDENCY_PENDING');
    expect((await merge('broken', c.change!)).status).toBe(200);
    expect((await listDeps('broken', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'satisfied' })]);
    const done = await merge('broken', b.change!);
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(isAncestorOf(repo, c.head, repo.refs.get(MAIN)!)).toBe(true);
    expect(repo.refs.get(b.ref)).toBe(b.head);
  });

  it('a pin is satisfied only when the landed result preserves the pinned revision', async () => {
    const { repo } = await seedRepo('satisfy');
    const a = await workspace('satisfy', 'a.txt', { change: 'review' });
    const b = await workspace('satisfy', 'b.txt', { change: 'review' });
    expect((await pin('satisfy', b.id, a.id, a.head)).status).toBe(201);
    expect((await merge('satisfy', b.change!)).json.code).toBe('DEPENDENCY_PENDING');
    const landed = await merge('satisfy', a.change!);
    expect(landed.status).toBe(200);
    expect(isAncestorOf(repo, a.head, repo.refs.get(MAIN)!)).toBe(true);
    const sat = (await listDeps('satisfy', b.id)).json.dependencies;
    expect(sat).toEqual([expect.objectContaining({ state: 'satisfied', satisfiedBy: landed.json.merge.mergeCommit })]);
    expect((await merge('satisfy', b.change!)).status).toBe(200);

    // Rewritten source: the pinned revision is not in the landed commit's ancestry.
    const second = await seedRepo('unsatisfied');
    const a2 = await workspace('unsatisfied', 'a.txt', { change: 'review' });
    const b2 = await workspace('unsatisfied', 'b.txt', { change: 'review' });
    expect((await pin('unsatisfied', b2.id, a2.id, a2.head)).status).toBe(201);
    const rewritten = await push('unsatisfied', a2.ref, { 'README.md': 'readme\n', 'a.txt': 'rewritten\n' }, [second.main]);
    expect((await getChange('unsatisfied', a2.change!)).json.headSha).toBe(rewritten);
    expect((await merge('unsatisfied', a2.change!)).status).toBe(200);
    expect(isAncestorOf(second.repo, a2.head, second.repo.refs.get(MAIN)!)).toBe(false);
    const listed = (await listDeps('unsatisfied', b2.id)).json.dependencies;
    expect(listed).toEqual([expect.objectContaining({ state: 'broken', reason: expect.objectContaining({ code: 'NOT_PRESERVED' }) })]);
    const refused = await merge('unsatisfied', b2.change!);
    expect([refused.status, refused.json.code]).toEqual([409, 'DEPENDENCY_BROKEN']);
  });
});

// ---------------------------------------------------------------------------

describe('integration train', () => {
  it('publishes the predecessor first, unrelated work proceeds, and the dependent lands after it', async () => {
    const { repo, main } = await seedRepo('train-order');
    const a = await workspace('train-order', 'a.txt', { change: 'review' });
    const b = await workspace('train-order', 'b.txt', { change: 'review' });
    const c = await workspace('train-order', 'c.txt', { change: 'review' });
    const edge = (await pin('train-order', b.id, a.id, a.head)).json;
    for (const n of [b.change!, a.change!, c.change!]) expect((await enqueue('train-order', n)).status).toBe(201);

    // While A's checks run, B waits with a machine-readable reason and is not ejected.
    const gate = scriptedGate('pending');
    const waiting = await runTrain(env, repoIds['train-order']!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(waiting.published).toEqual([]);
    expect(waiting.ejected).toEqual([]);
    const status = await trainStatus('train-order');
    expect(status.status).toBe(200);
    expect(status.cost).toMatchObject({ rw: 0, q: 0, art: 0, do: 0 });
    expect(status.cost.d1).toBeLessThanOrEqual(3);
    const bEntry = status.json.entries.find((e: any) => e.number === b.change);
    expect(bEntry).toMatchObject({
      state: 'queued',
      waiting: { code: 'DEPENDENCY_PENDING' },
      dependencies: [expect.objectContaining({ id: edge.id, onWorkspace: a.id, state: 'active' })],
    });
    expect(status.json.dependencies).toEqual([expect.objectContaining({ id: edge.id, workspaceId: b.id })]);
    expect(status.json.entries.find((e: any) => e.number === a.change).waiting).toBeNull();
    expect((await trainStatus('train-order')).json).toEqual(status.json);

    gate.fallback = 'success';
    const run = await runTrain(env, repoIds['train-order']!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(run.published.indexOf(a.change!)).toBeGreaterThanOrEqual(0);
    expect(run.published.indexOf(a.change!)).toBeLessThan(run.published.indexOf(b.change!));
    expect(run.published).toContain(c.change);
    const chain = firstParents(repo, main).reverse();
    expect(chain).toHaveLength(3);
    const commits = (await rows('train-order')).map((r) => r.merge_commit);
    expect(new Set(commits).size).toBe(3);
    const at = (n: number) => chain.indexOf((rowsByNumber.get(n) ?? '') as string);
    const rowsByNumber = new Map((await rows('train-order')).map((r) => [r.change_number, r.merge_commit]));
    expect(at(a.change!)).toBeLessThan(at(b.change!));
    expect(isAncestorOf(repo, a.head, rowsByNumber.get(b.change!)!)).toBe(true);
    expect((await listDeps('train-order', b.id)).json.dependencies).toEqual([expect.objectContaining({ state: 'satisfied' })]);
    expect((await rows('train-order')).map((r) => r.state)).toEqual(['published', 'published', 'published']);
  });

  it('a broken pin keeps the queued dependent waiting (never ejected); detaching lets it publish', async () => {
    const { repo, main } = await seedRepo('train-broken');
    const a = await workspace('train-broken', 'a.txt', { change: 'review' });
    const b = await workspace('train-broken', 'b.txt', { change: 'review' });
    const edge = (await pin('train-broken', b.id, a.id, a.head)).json;
    expect((await enqueue('train-broken', b.change!)).status).toBe(201);
    expect((await call('POST', api('train-broken', `/workspaces/${a.id}/abandon`), tok.owner)).status).toBe(200);
    const run = await runTrain(env, repoIds['train-broken']!, MAIN, trainDeps());
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([]);
    expect((await rows('train-broken')).map((r) => [r.state, r.active, r.reason_code])).toEqual([['queued', 1, 'DEPENDENCY_BROKEN']]);
    expect(repo.refs.get(MAIN)).toBe(main);

    sent.length = 0;
    expect((await detach('train-broken', b.id, edge.id)).status).toBe(200);
    expect(sent.map((m) => m.body)).toEqual([expect.objectContaining({ type: 'forge.train', ref: MAIN })]);
    const after = await runTrain(env, repoIds['train-broken']!, MAIN, trainDeps());
    expect(after.published).toEqual([b.change]);
    expect(repo.refs.get(b.ref)).toBe(b.head);
  });

  it('an explicit merge of the source kicks the queued dependent, which then publishes', async () => {
    await seedRepo('train-kick');
    const a = await workspace('train-kick', 'a.txt', { change: 'review' });
    const b = await workspace('train-kick', 'b.txt', { change: 'review' });
    expect((await pin('train-kick', b.id, a.id, a.head)).status).toBe(201);
    expect((await enqueue('train-kick', b.change!)).status).toBe(201);
    expect((await runTrain(env, repoIds['train-kick']!, MAIN, trainDeps())).published).toEqual([]);
    sent.length = 0;
    expect((await merge('train-kick', a.change!)).status).toBe(200);
    expect(sent.map((m) => m.body)).toContainEqual(expect.objectContaining({ type: 'forge.train', ref: MAIN, reason: 'dependency-landed' }));
    expect((await runTrain(env, repoIds['train-kick']!, MAIN, trainDeps())).published).toEqual([b.change]);
  });

  it('an older entry of one principal is prepared in the first window despite a stream from another', async () => {
    await seedRepo('fair');
    await env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(repoIds.fair, userIds['dep-writer'], 'write', userIds[OWNER], Date.now(), Date.now())
      .run();
    const stream: number[] = [];
    for (let i = 0; i < TRAIN_LIMITS.window + 2; i++) {
      const w = await workspace('fair', `s${i}.txt`, { change: 'review' });
      stream.push(w.change!);
    }
    const lone = await workspace('fair', 'lone.txt', { change: 'review', token: tok.writer });
    for (const n of stream) expect((await enqueue('fair', n)).status).toBe(201);
    expect((await enqueue('fair', lone.change!, tok.writer)).status).toBe(201);

    const gate = scriptedGate('pending');
    const deps = trainDeps({ gate: () => gate.gate });
    const first = await runTrain(env, repoIds.fair!, MAIN, deps);
    expect(first.maxPrepared).toBe(TRAIN_LIMITS.window);
    const window = deps.events.find((e): e is Extract<TrainEvent, { type: 'window' }> => e.type === 'window')!;
    const prepared = window.states.filter((s) => s.state !== 'queued').map((s) => s.number);
    expect(prepared).toHaveLength(TRAIN_LIMITS.window);
    expect(prepared).toContain(lone.change);
    // The other principal's oldest entry stays ahead; its later ones make room.
    expect(prepared[0]).toBe(stream[0]);

    gate.fallback = 'success';
    const run = await runTrain(env, repoIds.fair!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(run.published.indexOf(lone.change!)).toBeLessThan(TRAIN_LIMITS.window);
    expect(run.published).toHaveLength(stream.length + 1);
  });

  it('orders the read-ahead fairly across principals while composed entries keep their place', () => {
    const e = (id: string, seq: number, principal: string, state = 'queued') => ({ id, seq, principal, state });
    const rows = [e('a1', 1, 'A', 'checking'), e('a2', 2, 'A', 'checking'), e('a3', 3, 'A'), e('a4', 4, 'A'), e('b1', 5, 'B'), e('a5', 6, 'A'), e('b2', 7, 'B')];
    expect(fairOrder(rows).map((r) => r.id)).toEqual(['a1', 'a2', 'b1', 'b2', 'a3', 'a4', 'a5']);
    // All queued: one entry per principal per round, arrival order within a round and within a principal.
    const queued = rows.map((r) => ({ ...r, state: 'queued' }));
    expect(fairOrder(queued).map((r) => r.id)).toEqual(['a1', 'b1', 'a2', 'b2', 'a3', 'a4', 'a5']);
  });

  it('independent target partitions continue separately while a dependent waits', async () => {
    const { repo, main } = await seedRepo('partitions');
    repo.refs.set('refs/heads/dev', main);
    const a = await workspace('partitions', 'a.txt', { change: 'review' });
    const b = await workspace('partitions', 'b.txt', { change: 'review' });
    const d = await workspace('partitions', 'd.txt', { change: 'review', base: 'dev' });
    expect((await pin('partitions', b.id, a.id, a.head)).status).toBe(201);
    expect((await enqueue('partitions', b.change!)).status).toBe(201);
    expect((await enqueue('partitions', d.change!)).status).toBe(201);
    expect((await runTrain(env, repoIds.partitions!, MAIN, trainDeps())).published).toEqual([]);
    expect((await runTrain(env, repoIds.partitions!, 'refs/heads/dev', trainDeps())).published).toEqual([d.change]);
    expect(repo.refs.get(MAIN)).toBe(main);
  });
});
