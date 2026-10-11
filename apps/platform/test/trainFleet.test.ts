/**
 * The integration train with fleet-shaped members (scripts/fleet-driver.mjs):
 * each workspace is created and pushed by its own agent principal, the
 * owner opens a review change set from it and enqueues it at its head.
 * Covers the train's liveness while entries wait on pins or on candidates
 * ahead, and the recorded publication window (`merge_queue.cost`) of
 * workspace-backed publications, with and without incoming pins, against
 * the publication row in library/cost.md.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { CostMeter, runWithMeter, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import type { ChecksGate, CheckState } from '../src/services/checksGate';
import { headWorkspacePins, headWorkspacePinsStatement, type HeadWorkspacePinRow } from '../src/services/dependencyGate';
import { TRAIN_LIMITS, backoffSeconds, defaultTrainDeps, runTrain, type TrainDeps, type TrainEvent } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://forge.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'fleet-owner';
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

let ownerToken = '';
const repoIds: Record<string, string> = {};
const repos: Record<string, FakeRepo> = {};
let clock = Date.now();

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@forge.invalid`, login, Date.now())
    .run();
  return id;
}

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

async function call(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, json };
}

const api = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;

async function deliverPush(name: string, ref: string, after: string): Promise<void> {
  clock += 1000;
  const body = {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${name}` },
    payload: { ref, before: '0'.repeat(40), after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(clock).toISOString() },
  };
  const batch = createMessageBatch('forge-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

interface Member {
  id: string;
  ref: string;
  head: string;
  files: Files;
  change: number;
}

/**
 * One fleet member: its own agent creates and pushes the workspace (files
 * on top of main, or on top of `onto`'s head for a stacked member); the
 * owner opens a review change set from it.
 */
async function member(name: string, files: Files, onto?: Member): Promise<Member> {
  const agent = await call('POST', '/api/v1/agents', ownerToken, { name: `fleet-${crypto.randomUUID().slice(0, 8)}` });
  expect(agent.status).toBe(201);
  const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, ownerToken, { repo: `${OWNER}/${name}`, role: 'write', refs: ['refs/heads/agents/*'] });
  expect(minted.status).toBe(201);
  const created = await call('POST', api(name, '/workspaces'), minted.json.token as string, { task: `fleet work ${Object.keys(files).join(',')}`, base: 'main' });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const { id, ref, baseSha } = created.json as { id: string; ref: string; baseSha: string };
  const all: Files = { 'README.md': 'readme\n', ...onto?.files, ...files };
  const c = await commit(repos[name]!, all, [onto?.head ?? baseSha]);
  repos[name]!.refs.set(ref, c.sha);
  await deliverPush(name, ref, c.sha);
  const ch = await call('POST', api(name, `/workspaces/${id}/change-set`), ownerToken, { title: `Fleet ${Object.keys(files).join(',')}`, mergePolicy: 'review' });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  return { id, ref, head: c.sha, files: all, change: ch.json.number as number };
}

const pin = (name: string, dependent: Member, source: Member) =>
  call('POST', api(name, `/workspaces/${dependent.id}/dependencies`), ownerToken, { onWorkspace: source.id, revision: source.head });
const enqueue = (name: string, m: Member) => call('POST', api(name, `/changes/${m.change}/enqueue`), ownerToken, { headSha: m.head, mergePolicy: 'review' });

function scriptedGate(fallback: CheckState) {
  const s: { fallback: CheckState; gate: ChecksGate } = {
    fallback,
    gate: {
      async requiredChecksFor(_repo, treeSha, configId) {
        return { treeSha, configId, required: [{ name: 'ci/test', state: s.fallback, producer: 'test' }], state: s.fallback };
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

interface EntryRow {
  change_number: number;
  state: string;
  active: number;
  attempts: number;
  reason_code: string | null;
  merge_commit: string | null;
  cost: string | null;
}

async function entries(name: string): Promise<Map<number, EntryRow>> {
  const rows = (
    await env.DB.prepare('SELECT change_number, state, active, attempts, reason_code, merge_commit, cost FROM merge_queue WHERE repo_id = ? ORDER BY seq')
      .bind(repoIds[name])
      .all<EntryRow>()
  ).results;
  return new Map(rows.map((r) => [r.change_number, r]));
}

const backstops = () => sent.filter((m) => m.body?.reason === 'checks-backstop');

beforeAll(async () => {
  installFakeGitRemote();
  ownerToken = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
});

afterAll(() => restoreFetch());

afterEach(() => {
  sent.length = 0;
});

// ---------------------------------------------------------------------------

describe('train liveness while entries wait', () => {
  /**
   * The raw-arrival head B waits on its pin to A (never enqueued), X is
   * checking and Y conflicts only with X (composed on X, it cannot merge;
   * on main alone it would). Y waits for X to publish; B waits for A.
   */
  async function waitingTrain(name: string) {
    const { repo } = await seedRepo(name);
    const a = await member(name, { 'iface/a.txt': 'a\n' });
    const b = await member(name, { 'iface/b.txt': 'b\n' }, a);
    expect((await pin(name, b, a)).status).toBe(201);
    const x = await member(name, { 'shared.txt': 'from x\n' });
    const y = await member(name, { 'shared.txt': 'from y\n' });
    for (const m of [b, x, y]) expect((await enqueue(name, m)).status).toBe(201);
    return { repo, b, x, y };
  }

  it('charges the checks backstop to the first entry that does not wait on a pin, never to a pinned raw head', async () => {
    const name = 'backstop-head';
    const { b, x, y } = await waitingTrain(name);
    const gate = scriptedGate('pending');
    const run = await runTrain(env, repoIds[name]!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(run.state).toBe('waiting');
    expect(run.published).toEqual([]);
    expect(run.ejected).toEqual([]);
    const after = await entries(name);
    expect(after.get(x.change)).toMatchObject({ state: 'checking', attempts: 1 });
    expect(after.get(y.change)).toMatchObject({ state: 'queued', active: 1 });
    expect(after.get(b.change)).toMatchObject({ state: 'queued', active: 1, attempts: 0, reason_code: 'DEPENDENCY_PENDING' });
    expect(backstops()).toEqual([expect.objectContaining({ delaySeconds: backoffSeconds(0) })]);
  });

  it('a pinned head that has spent the attempt budget does not leave the partition dormant; the conflicting entry is ejected once its base is the target', async () => {
    const name = 'backstop-dormant';
    const { repo, b, x, y } = await waitingTrain(name);
    // B has waited through many earlier passes.
    await env.DB.prepare('UPDATE merge_queue SET attempts = ?3 WHERE repo_id = ?1 AND change_number = ?2')
      .bind(repoIds[name], b.change, TRAIN_LIMITS.maxAttempts)
      .run();

    const gate = scriptedGate('pending');
    const waiting = await runTrain(env, repoIds[name]!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(waiting.state).toBe('waiting');
    expect(backstops()).toEqual([expect.objectContaining({ delaySeconds: backoffSeconds(0) })]);

    // The backstop kick's run: X's checks passed meanwhile; X publishes, Y is composed on the published base and ejected.
    sent.length = 0;
    gate.fallback = 'success';
    const resumed = await runTrain(env, repoIds[name]!, MAIN, trainDeps({ gate: () => gate.gate }));
    expect(resumed.published).toEqual([x.change]);
    expect(resumed.ejected).toEqual([{ number: y.change, code: 'MERGE_CONFLICT' }]);
    const after = await entries(name);
    expect(after.get(x.change)).toMatchObject({ state: 'published', merge_commit: repo.refs.get(MAIN) });
    expect(after.get(y.change)).toMatchObject({ state: 'ejected', active: 0, reason_code: 'MERGE_CONFLICT' });
    expect(after.get(b.change)).toMatchObject({ state: 'queued', active: 1, reason_code: 'DEPENDENCY_PENDING' });
    expect((await call('GET', api(name, `/changes/${y.change}`), ownerToken)).json.state).toBe('conflicted');
  });

  it('a pass whose entries all wait on pins schedules a bounded backstop', async () => {
    const name = 'backstop-pinned';
    await seedRepo(name);
    const a = await member(name, { 'iface/a.txt': 'a\n' });
    const b = await member(name, { 'iface/b.txt': 'b\n' }, a);
    const c = await member(name, { 'iface/c.txt': 'c\n' }, b);
    expect((await pin(name, b, a)).status).toBe(201);
    expect((await pin(name, c, b)).status).toBe(201);
    for (const m of [c, b]) expect((await enqueue(name, m)).status).toBe(201);
    for (let i = 0; i <= TRAIN_LIMITS.maxAttempts; i++) {
      const run = await runTrain(env, repoIds[name]!, MAIN, trainDeps());
      expect(run.state).toBe('waiting');
      expect(run.published).toEqual([]);
      expect(run.ejected).toEqual([]);
    }
    expect(backstops().map((m) => m.delaySeconds)).toEqual(Array.from({ length: TRAIN_LIMITS.maxAttempts }, (_, n) => backoffSeconds(n)));
  });
});

describe('workspace-backed publication window', () => {
  const ROW = { d1: 3, rr: 12, rw: 8, art: 4, sub: 2 };
  const within = (cost: CostCounters) =>
    cost.d1 <= ROW.d1 && cost.rr <= ROW.rr && cost.rw <= ROW.rw && cost.art <= ROW.art && cost.do === 2 && cost.sub <= ROW.sub;

  it('every publication, unpinned and with incoming pins, records counters within the publication row', async () => {
    const name = 'window';
    const { repo } = await seedRepo(name);
    const a = await member(name, { 'iface/a.txt': 'a\n' });
    const b = await member(name, { 'iface/b.txt': 'b\n' }, a);
    const c = await member(name, { 'iface/c.txt': 'c\n' }, b);
    const x = await member(name, { 'x.txt': 'x\n' });
    expect((await pin(name, b, a)).status).toBe(201);
    expect((await pin(name, c, b)).status).toBe(201);
    // Out of dependency order, as the fleet enqueues the chain.
    for (const m of [c, b, x, a]) expect((await enqueue(name, m)).status).toBe(201);
    const published: number[] = [];
    for (let i = 0; i < 6 && published.length < 4; i++) {
      const meter = new CostMeter();
      published.push(...(await runWithMeter(meter, () => runTrain(meter.wrapEnv(env), repoIds[name]!, MAIN, trainDeps()))).published);
    }
    expect(published.indexOf(a.change)).toBeLessThan(published.indexOf(b.change));
    expect(published.indexOf(b.change)).toBeLessThan(published.indexOf(c.change));
    expect(published).toContain(x.change);
    expect(repo.refs.get(MAIN)).toBe((await entries(name)).get(published.at(-1)!)!.merge_commit);
    const costs = [...(await entries(name)).values()].map((e) => ({ number: e.change_number, cost: JSON.parse(e.cost!) as CostCounters }));
    expect(costs).toHaveLength(4);
    for (const { number, cost } of costs) expect(within(cost), `#${number} ${JSON.stringify(cost)}`).toBe(true);
  });

  it('a dependent with two incoming pins publishes within the same row', async () => {
    const name = 'window-two-pins';
    const { repo } = await seedRepo(name);
    const a = await member(name, { 'iface/a.txt': 'a\n' });
    const b = await member(name, { 'iface/b.txt': 'b\n' }, a);
    const c = await member(name, { 'iface/c.txt': 'c\n' }, b);
    for (const [dependent, source] of [
      [b, a],
      [c, b],
      [c, a],
    ] as const)
      expect((await pin(name, dependent, source)).status).toBe(201);
    for (const m of [c, b, a]) expect((await enqueue(name, m)).status).toBe(201);
    const published: number[] = [];
    for (let i = 0; i < 6 && published.length < 3; i++) {
      const meter = new CostMeter();
      published.push(...(await runWithMeter(meter, () => runTrain(meter.wrapEnv(env), repoIds[name]!, MAIN, trainDeps()))).published);
    }
    expect(published).toEqual([a.change, b.change, c.change]);
    expect(repo.refs.get(MAIN)).toBe((await entries(name)).get(c.change)!.merge_commit);
    const cost = JSON.parse((await entries(name)).get(c.change)!.cost!) as CostCounters;
    console.log(JSON.stringify({ twoPinPublication: cost }));
    expect(within(cost), JSON.stringify(cost)).toBe(true);
  });

  /**
   * The publication window's head workspace read, against a fixture where
   * both index ranges it probes are followed by another entry (a later ref
   * in the same repo, a later dependent's edge), as in a busy live database.
   */
  it('the head workspace and its pins are read once each, whatever entry follows the ref in its index', async () => {
    const db = env.DB;
    const repoId = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at) VALUES (?, ?, ?, ?, 'x', 'public', 'main', 0)`)
      .bind(repoId, OWNER, `pin-read-${repoId}`, `pin-read-${repoId}`)
      .run();
    const ws = (n: string) => `${repoId}-${n}`;
    const changeC = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO change_sets (id, repo_id, number, title, base_ref, head_ref, created_at) VALUES (?, ?, 1, 'c', 'main', 'agents/c', 0)`)
      .bind(changeC, repoId)
      .run();
    for (const n of ['a', 'b', 'c', 'd', 'zz'])
      await db
        .prepare(`INSERT INTO workspaces (id, repo_id, artifacts_name, status, change_set_id, created_at, ref) VALUES (?, ?, 'x', ?, ?, 0, ?)`)
        .bind(ws(n), repoId, n === 'a' ? 'merged' : 'active', n === 'c' ? changeC : null, `refs/heads/agents/${n}`)
        .run();
    const edge = (id: string, dependent: string, source: string, revision: string, satisfied: string | null) =>
      db
        .prepare(`INSERT INTO workspace_dependencies (repo_id, id, workspace_id, on_workspace, revision, created_at, updated_at, satisfied_commit) VALUES (?, ?, ?, ?, ?, 0, 0, ?)`)
        .bind(repoId, id, ws(dependent), ws(source), revision, satisfied);
    await db.batch([
      edge('e-ba', 'b', 'a', 'rev-a', 'landed-a'),
      edge('e-ca', 'c', 'a', 'rev-a', 'landed-a'),
      edge('e-cb', 'c', 'b', 'rev-b', null),
      edge('e-zzc', 'zz', 'c', 'rev-c', null),
    ]);
    const read = async (ref: string) => {
      const res = await headWorkspacePinsStatement(db, repoId, ref).all<HeadWorkspacePinRow>();
      const out = headWorkspacePins(res.results);
      return { rowsRead: res.meta.rows_read, workspace: out.workspace, pins: [...out.pins].sort((x, y) => x.id.localeCompare(y.id)) };
    };

    const two = await read('refs/heads/agents/c');
    expect(two.workspace).toEqual({ status: 'active', change_set_id: changeC });
    expect(two.pins).toEqual([
      { id: 'e-ca', revision: 'rev-a', satisfied_commit: 'landed-a' },
      { id: 'e-cb', revision: 'rev-b', satisfied_commit: null },
    ]);
    // The workspace once, each pin once, and the one entry that ends the pin range.
    expect(two.rowsRead).toBe(1 + 2 + 1);

    const one = await read('refs/heads/agents/b');
    expect(one.workspace).toEqual({ status: 'active', change_set_id: null });
    expect(one.pins).toEqual([{ id: 'e-ba', revision: 'rev-a', satisfied_commit: 'landed-a' }]);
    expect(one.rowsRead).toBe(1 + 1 + 1);

    const none = await read('refs/heads/agents/d');
    expect(none.workspace).toEqual({ status: 'active', change_set_id: null });
    expect(none.pins).toEqual([]);
    expect(none.rowsRead).toBe(1);

    const merged = await read('refs/heads/agents/a');
    expect(merged.workspace).toEqual({ status: 'merged', change_set_id: null });
    expect(merged.pins).toEqual([]);

    const missing = await read('refs/heads/agents/missing');
    expect(missing.workspace).toBeNull();
    expect(missing.pins).toEqual([]);
  });
});
