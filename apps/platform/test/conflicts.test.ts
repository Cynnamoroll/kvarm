/**
 * Automatic conflict resolution and conflict dispatch (resolve.ts through
 * services/merge.ts, services/conflicts.ts and services/tasks.ts) through
 * the Worker's routes, push queue and train, over the in-memory Artifacts
 * fake. The base fixture is `lines.txt` with 20 numbered lines.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { defaultTrainDeps, runTrain } from '../src/services/queue';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'cf-owner';
const MAIN = 'refs/heads/main';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

/** Train kicks are recorded, not delivered: the tests run the train themselves. */
const fakeEvents = {
  async send() {},
  async sendBatch() {},
};

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', reader: '', outsider: '' };
const userIds: Record<string, string> = {};
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  userIds[login] = id;
  return id;
}

async function seedRepo(name: string, visibility: 'public' | 'private' = 'public'): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
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

const repoPath = (repo: string, rest: string) => `/api/v1/repos/${OWNER}/${repo}${rest}`;
const create = (repo: string, mergePolicy: string, head = 'feature') =>
  call('POST', repoPath(repo, '/changes'), tok.owner, { title: `${mergePolicy} change`, base: 'main', head, mergePolicy });
const get = (repo: string, n: number, token: string | undefined = tok.owner) => call('GET', repoPath(repo, `/changes/${n}`), token);
const mergeability = (repo: string, n: number) => call('GET', repoPath(repo, `/changes/${n}/mergeability`), tok.owner);
const merge = (repo: string, n: number) => call('POST', repoPath(repo, `/changes/${n}/merge`), tok.owner);
/** `token` null: anonymous. */
const tasks = (repo: string, q = '', token: string | null = tok.owner) => call('GET', repoPath(repo, `/tasks${q}`), token ?? undefined);

const LINES = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
const linesWith = (edits: Record<number, string>) => LINES.map((l, i) => (edits[i + 1] ?? l) + '\n').join('');
const BASE: Files = { 'lines.txt': linesWith({}), 'README.md': 'readme\n' };

/** From a branch point with BASE, main and feature apply their own file changes. */
async function fork(repo: FakeRepo, mainFiles: Files, featureFiles: Files) {
  const root = await commit(repo, BASE);
  const main = await commit(repo, { ...BASE, ...mainFiles }, [root.sha]);
  const feature = await commit(repo, { ...BASE, ...featureFiles }, [root.sha]);
  repo.refs.set(MAIN, main.sha);
  repo.refs.set('refs/heads/feature', feature.sha);
  return { root, main, feature };
}

const FIXTURES = {
  'non-overlapping': [{ 'lines.txt': linesWith({ 2: 'line 2 main' }) }, { 'lines.txt': linesWith({ 18: 'line 18 feature' }) }],
  identical: [{ 'lines.txt': linesWith({ 5: 'line 5 shared' }) }, { 'lines.txt': linesWith({ 5: 'line 5 shared' }) }],
  whitespace: [{ 'lines.txt': linesWith({ 7: '    line 7 indented' }) }, { 'lines.txt': linesWith({ 7: '\tline 7 indented' }) }],
  'add-add': [{ 'both.txt': 'same\ncontent\n' }, { 'both.txt': 'same\ncontent\n' }],
  unresolvable: [{ 'lines.txt': linesWith({ 9: 'line 9 main' }) }, { 'lines.txt': linesWith({ 9: 'line 9 feature' }) }],
} satisfies Record<string, [Files, Files]>;

function commitOf(repo: FakeRepo, sha: string): { tree: string; parents: string[] } {
  const o = repo.objects.get(sha);
  expect(o?.type).toBe('commit');
  const head = decode(o!.content).split('\n\n')[0]!;
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
  };
}

/** Name -> content of the blobs in a (flat) tree. */
function treeFiles(repo: FakeRepo, tree: string): Record<string, string> {
  const o = repo.objects.get(tree);
  expect(o?.type).toBe('tree');
  const out: Record<string, string> = {};
  let off = 0;
  const c = o!.content;
  while (off < c.length) {
    const sp = c.indexOf(0x20, off);
    const nul = c.indexOf(0, sp);
    const name = decode(c.subarray(sp + 1, nul));
    const hash = [...c.subarray(nul + 1, nul + 21)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const blob = repo.objects.get(hash);
    out[name] = blob?.type === 'blob' ? decode(blob.content) : `<${blob?.type ?? 'missing'}>`;
    off = nul + 21;
  }
  return out;
}

const mainFiles = (repo: FakeRepo) => treeFiles(repo, commitOf(repo, repo.refs.get(MAIN)!).tree);

function pushBody(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown) {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

async function stateRow(repo: string, n: number): Promise<{ state: string; conflicts: string | null }> {
  return (await env.DB.prepare('SELECT state, conflicts FROM change_sets WHERE repo_id = ? AND number = ?').bind(repoIds[repo], n).first<{
    state: string;
    conflicts: string | null;
  }>())!;
}

async function taskRows(repo: string): Promise<Array<{ kind: string; status: string; head_sha: string }>> {
  return (
    (await env.DB.prepare('SELECT kind, status, head_sha FROM agent_tasks WHERE repo_id = ? ORDER BY created_at').bind(repoIds[repo]).all<{
      kind: string;
      status: string;
      head_sha: string;
    }>()).results ?? []
  );
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('cf-reader'), 'reader', FULL)).token;
  tok.outsider = (await mintPAT(env, await seedUser('cf-outsider'), 'outsider', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('deterministic rules auto-resolve and the merge keeps both sides', () => {
  it('non-overlapping edits in the same file (VAL-CONFLICT-001)', async () => {
    const repo = await seedRepo('non-overlapping');
    const { main } = await fork(repo, ...FIXTURES['non-overlapping']);
    expect((await create('non-overlapping', 'review')).status).toBe(201);
    const m = await mergeability('non-overlapping', 1);
    expect(m.json).toMatchObject({ state: 'open', mergeability: { status: 'clean', mergeable: true, conflicts: [] } });
    expect(m.json.mergeability.resolved).toEqual([{ path: 'lines.txt', rule: 'non-overlapping' }]);
    const d = await get('non-overlapping', 1);
    expect(d.json).toMatchObject({ state: 'open', conflicts: [] });

    const r = await merge('non-overlapping', 1);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ state: 'merged', merge: { kind: 'merge' } });
    expect(commitOf(repo, repo.refs.get(MAIN)!).parents[0]).toBe(main.sha);
    expect(mainFiles(repo)['lines.txt']).toBe(linesWith({ 2: 'line 2 main', 18: 'line 18 feature' }));
    expect(await taskRows('non-overlapping')).toEqual([]);
  });

  it('identical change on both sides (VAL-CONFLICT-002)', async () => {
    const repo = await seedRepo('identical');
    await fork(repo, ...FIXTURES.identical);
    await create('identical', 'review');
    expect((await mergeability('identical', 1)).json.mergeability).toMatchObject({ status: 'clean', conflicts: [] });
    expect((await merge('identical', 1)).json.state).toBe('merged');
    const lines = mainFiles(repo)['lines.txt']!;
    expect(lines.split('\n')[4]).toBe('line 5 shared');
    expect(lines.match(/line 5 shared/g)).toHaveLength(1);
  });

  it('whitespace-only conflict resolves to the base branch’s variant (VAL-CONFLICT-003)', async () => {
    const repo = await seedRepo('whitespace');
    await fork(repo, ...FIXTURES.whitespace);
    await create('whitespace', 'review');
    const m = await mergeability('whitespace', 1);
    expect(m.json).toMatchObject({ state: 'open', mergeability: { status: 'clean', mergeable: true, conflicts: [] } });
    expect(m.json.mergeability.resolved).toEqual([{ path: 'lines.txt', rule: 'whitespace-only', hunks: 1 }]);
    expect((await merge('whitespace', 1)).json.state).toBe('merged');
    expect(mainFiles(repo)['lines.txt']!.split('\n')[6]).toBe('    line 7 indented');
  });

  it('add-add of an identical file (VAL-CONFLICT-004)', async () => {
    const repo = await seedRepo('add-add');
    await fork(repo, ...FIXTURES['add-add']);
    await create('add-add', 'review');
    expect((await mergeability('add-add', 1)).json.mergeability).toMatchObject({ status: 'clean', conflicts: [] });
    expect((await merge('add-add', 1)).json.state).toBe('merged');
    const files = mainFiles(repo);
    expect(files['both.txt']).toBe('same\ncontent\n');
    expect(Object.keys(files).filter((n) => n === 'both.txt')).toHaveLength(1);
  });
});

describe('resolved merges follow the change’s mergePolicy', () => {
  it('auto merges right away, draft never merges, review waits for the merge call', async () => {
    const auto = await seedRepo('policy-auto');
    const { main } = await fork(auto, ...FIXTURES.whitespace);
    const a = await create('policy-auto', 'auto');
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ state: 'merged', mergeCommit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(commitOf(auto, auto.refs.get(MAIN)!).parents[0]).toBe(main.sha);

    const draft = await seedRepo('policy-draft');
    const d = await fork(draft, ...FIXTURES['non-overlapping']);
    await create('policy-draft', 'draft');
    const dm = await get('policy-draft', 1);
    expect(dm.json).toMatchObject({ state: 'open', mergeability: { status: 'clean', mergeable: true } });
    expect((await merge('policy-draft', 1)).json.code).toBe('DRAFT');
    expect(draft.refs.get(MAIN)).toBe(d.main.sha);
    expect((await get('policy-draft', 1)).json.state).toBe('open');

    const review = await seedRepo('policy-review');
    const rv = await fork(review, ...FIXTURES['non-overlapping']);
    await create('policy-review', 'review');
    expect((await get('policy-review', 1)).json.state).toBe('open');
    expect(review.refs.get(MAIN)).toBe(rv.main.sha);
    expect((await merge('policy-review', 1)).json.state).toBe('merged');
  });
});

describe('unresolvable conflicts', () => {
  it('mark the change conflicted with path+kind, refuse the merge and dispatch one resolve-conflict task (VAL-CONFLICT-006)', async () => {
    const repo = await seedRepo('conflict');
    const { main, feature } = await fork(repo, ...FIXTURES.unresolvable);
    const created = await create('conflict', 'review');
    expect(created.status).toBe(201);
    // Detection is eager: the creation already evaluated mergeability.
    expect((await stateRow('conflict', 1)).state).toBe('conflicted');

    const d = await get('conflict', 1);
    expect(d.json).toMatchObject({ state: 'conflicted', conflicts: [{ path: 'lines.txt', kind: 'content' }] });
    expect(d.json.mergeability).toMatchObject({ status: 'conflicts', mergeable: false, conflicts: [{ path: 'lines.txt', kind: 'content' }] });
    const m = await mergeability('conflict', 1);
    expect(m.json).toMatchObject({ state: 'conflicted', mergeability: { status: 'conflicts' } });

    const refused = await merge('conflict', 1);
    expect([refused.status, refused.json.code]).toEqual([409, 'MERGE_CONFLICT']);
    expect(refused.json.error).toEqual(expect.any(String));
    expect(refused.json.conflicts).toEqual([{ path: 'lines.txt', kind: 'content' }]);
    expect(repo.refs.get(MAIN)).toBe(main.sha);

    const listed = await tasks('conflict', '?status=open');
    expect(listed.status).toBe(200);
    expect(listed.json.tasks).toHaveLength(1);
    expect(listed.json.tasks[0]).toMatchObject({
      id: expect.any(String),
      kind: 'resolve-conflict',
      status: 'open',
      change: { number: 1, state: 'conflicted' },
      headSha: feature.sha,
      baseSha: main.sha,
      conflicts: [{ path: 'lines.txt', kind: 'content' }],
      claimedBy: null,
      workspace: null,
    });
    expect(listed.json.nextCursor).toBeNull();
    expect(listed.cost.d1).toBeLessThanOrEqual(2);
    expect((await call('GET', repoPath('conflict', '/changes?state=conflicted'), tok.owner)).json.changes.map((c: any) => c.number)).toEqual([1]);

    // Re-evaluation and repeated merge attempts never duplicate the task.
    await get('conflict', 1);
    await merge('conflict', 1);
    expect(await taskRows('conflict')).toEqual([{ kind: 'resolve-conflict', status: 'open', head_sha: feature.sha }]);
    const steady = await get('conflict', 1);
    expect(steady.cost.d1).toBeLessThanOrEqual(3);
  });

  it('lockfile conflicts stay unresolved and are marked for regeneration', async () => {
    const repo = await seedRepo('lockfile');
    const root = await commit(repo, { ...BASE, 'package-lock.json': '{\n  "a": 1\n}\n' });
    const main = await commit(repo, { ...BASE, 'package-lock.json': '{\n    "a": 2\n}\n' }, [root.sha]);
    const feature = await commit(repo, { ...BASE, 'package-lock.json': '{\n\t"a": 2\n}\n' }, [root.sha]);
    repo.refs.set(MAIN, main.sha);
    repo.refs.set('refs/heads/feature', feature.sha);
    await create('lockfile', 'review');
    const d = await get('lockfile', 1);
    expect(d.json).toMatchObject({ state: 'conflicted', conflicts: [{ path: 'package-lock.json', kind: 'content', needsRegeneration: true }] });
    expect((await tasks('lockfile')).json.tasks[0].conflicts).toEqual([{ path: 'package-lock.json', kind: 'content', needsRegeneration: true }]);
  });

  it('an auto change that conflicts is marked conflicted on creation, not merged', async () => {
    const repo = await seedRepo('conflict-auto');
    const { main } = await fork(repo, ...FIXTURES.unresolvable);
    const a = await create('conflict-auto', 'auto');
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ state: 'conflicted', mergeCommit: null, conflicts: [{ path: 'lines.txt', kind: 'content' }] });
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect((await tasks('conflict-auto', '?status=open')).json.tasks).toHaveLength(1);
  });

  it('a pushed resolution reopens the change, retires the open task, and an auto change then merges', async () => {
    const repo = await seedRepo('push-resolves');
    const { main, feature } = await fork(repo, ...FIXTURES.unresolvable);
    await create('push-resolves', 'auto');
    expect((await stateRow('push-resolves', 1)).state).toBe('conflicted');

    // A push that still conflicts keeps it conflicted and refreshes the task's head.
    const still = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: 'line 9 feature v2' }) }, [feature.sha]);
    repo.refs.set('refs/heads/feature', still.sha);
    await deliver(pushBody('push-resolves', 'refs/heads/feature', feature.sha, still.sha, Date.now()));
    expect((await stateRow('push-resolves', 1)).state).toBe('conflicted');
    expect(await taskRows('push-resolves')).toEqual([{ kind: 'resolve-conflict', status: 'open', head_sha: still.sha }]);

    const fixed = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: 'line 9 main', 10: 'line 10 feature' }) }, [still.sha, main.sha]);
    repo.refs.set('refs/heads/feature', fixed.sha);
    await deliver(pushBody('push-resolves', 'refs/heads/feature', still.sha, fixed.sha, Date.now() + 1000));
    const after = await get('push-resolves', 1);
    expect(after.json).toMatchObject({ state: 'merged', conflicts: [] });
    expect(mainFiles(repo)['lines.txt']).toBe(linesWith({ 9: 'line 9 main', 10: 'line 10 feature' }));
    expect(await taskRows('push-resolves')).toEqual([{ kind: 'resolve-conflict', status: 'obsolete', head_sha: still.sha }]);
  });

  it('a review change whose base moves past the conflict reopens on the next read', async () => {
    const repo = await seedRepo('base-moves');
    const { main } = await fork(repo, ...FIXTURES.unresolvable);
    await create('base-moves', 'review');
    expect((await get('base-moves', 1)).json.state).toBe('conflicted');
    // Main takes the feature's line: the conflict is gone.
    const moved = await commit(repo, { ...BASE, ...FIXTURES.unresolvable[1] }, [main.sha]);
    repo.refs.set(MAIN, moved.sha);
    await deliver(pushBody('base-moves', MAIN, main.sha, moved.sha, Date.now()));
    const d = await get('base-moves', 1);
    expect(d.json).toMatchObject({ state: 'open', conflicts: [], mergeability: { status: expect.stringMatching(/^(clean|up-to-date|fast-forward)$/) } });
    expect((await taskRows('base-moves')).map((t) => t.status)).toEqual(['obsolete']);
  });

  it('a resolution push reopens every conflicted change on the branch, beyond one page', async () => {
    const repo = await seedRepo('many-heads');
    const { main, feature } = await fork(repo, ...FIXTURES.unresolvable);
    const count = 22;
    for (let i = 1; i <= count; i++) {
      repo.refs.set(`refs/heads/base${i}`, main.sha);
      const c = await call('POST', repoPath('many-heads', '/changes'), tok.owner, { title: `c${i}`, base: `base${i}`, head: 'feature', mergePolicy: 'review' });
      expect(c.json.state, JSON.stringify(c.json)).toBe('conflicted');
    }
    const fixed = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: 'line 9 main', 10: 'line 10 feature' }) }, [feature.sha, main.sha]);
    repo.refs.set('refs/heads/feature', fixed.sha);
    await deliver(pushBody('many-heads', 'refs/heads/feature', feature.sha, fixed.sha, Date.now()));
    for (const n of [1, 20, 21, count]) expect((await stateRow('many-heads', n)).state, `#${n}`).toBe('open');
    expect((await taskRows('many-heads')).filter((t) => t.status !== 'obsolete')).toEqual([]);
  });

  it('an auto change whose base moves past the conflict merges without a read', async () => {
    for (const via of ['push', 'read'] as const) {
      const name = `base-clears-${via}`;
      const repo = await seedRepo(name);
      const { main } = await fork(repo, ...FIXTURES.unresolvable);
      await create(name, 'auto');
      expect((await stateRow(name, 1)).state).toBe('conflicted');
      const moved = await commit(repo, { ...BASE, ...FIXTURES.unresolvable[1] }, [main.sha]);
      repo.refs.set(MAIN, moved.sha);
      // A read may see the cleared conflict before the push event is processed.
      if (via === 'read') expect((await get(name, 1)).status).toBe(200);
      await deliver(pushBody(name, MAIN, main.sha, moved.sha, Date.now()));
      expect((await stateRow(name, 1)).state, via).toBe('merged');
      expect((await taskRows(name)).map((t) => t.status)).toEqual(['obsolete']);
    }
  });

  it('a push that makes an open review change conflict marks it right away; it cannot be enqueued', async () => {
    const repo = await seedRepo('push-conflicts');
    const { main, feature } = await fork(repo, { 'lines.txt': linesWith({ 9: 'line 9 main' }) }, { 'lines.txt': linesWith({ 12: 'line 12 feature' }) });
    await create('push-conflicts', 'review');
    expect((await stateRow('push-conflicts', 1)).state).toBe('open');
    const next = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: 'line 9 feature', 12: 'line 12 feature' }) }, [feature.sha]);
    repo.refs.set('refs/heads/feature', next.sha);
    await deliver(pushBody('push-conflicts', 'refs/heads/feature', feature.sha, next.sha, Date.now()));
    expect((await stateRow('push-conflicts', 1)).state).toBe('conflicted');
    expect(await taskRows('push-conflicts')).toEqual([{ kind: 'resolve-conflict', status: 'open', head_sha: next.sha }]);
    const e = await call('POST', repoPath('push-conflicts', '/changes/1/enqueue'), tok.owner, {});
    expect([e.status, e.json.code]).toEqual([409, 'MERGE_CONFLICT']);
    // Reopening via PATCH keeps it conflicted.
    const reopened = await call('PATCH', repoPath('push-conflicts', '/changes/1'), tok.owner, { state: 'open' });
    expect(reopened.json.state).toBe('conflicted');
    expect(repo.refs.get(MAIN)).toBe(main.sha);
  });

  it('closing a conflicted change retires its task', async () => {
    const repo = await seedRepo('close');
    await fork(repo, ...FIXTURES.unresolvable);
    await create('close', 'review');
    const closed = await call('PATCH', repoPath('close', '/changes/1'), tok.owner, { state: 'closed' });
    expect(closed.json.state).toBe('closed');
    expect((await taskRows('close')).map((t) => t.status)).toEqual(['obsolete']);
    expect((await tasks('close', '?status=open')).json.tasks).toEqual([]);
  });

  it('a conflict found by the merge train marks the change and dispatches the task', async () => {
    const repo = await seedRepo('train');
    const { main } = await fork(repo, ...FIXTURES.unresolvable);
    await create('train', 'review');
    // Start from open as if detection had not run yet.
    await env.DB.prepare(`UPDATE change_sets SET state = 'open', conflicts = NULL WHERE repo_id = ?`).bind(repoIds.train).run();
    await env.DB.prepare('DELETE FROM agent_tasks WHERE repo_id = ?').bind(repoIds.train).run();
    const e = await call('POST', repoPath('train', '/changes/1/enqueue'), tok.owner, {});
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    const run = await runTrain(env, repoIds.train!, MAIN, { ...defaultTrainDeps, kick: async () => {} });
    expect(run.ejected).toEqual([{ number: 1, code: 'MERGE_CONFLICT' }]);
    expect(repo.refs.get(MAIN)).toBe(main.sha);
    expect(await stateRow('train', 1)).toMatchObject({ state: 'conflicted' });
    expect((await tasks('train', '?status=open')).json.tasks.map((t: any) => [t.kind, t.change.number])).toEqual([['resolve-conflict', 1]]);
  });
});

describe('GET tasks', () => {
  it('follows repo read access and validates its query', async () => {
    const repo = await seedRepo('private-tasks', 'private');
    await fork(repo, ...FIXTURES.unresolvable);
    await create('private-tasks', 'review');
    await env.DB.prepare(
      'INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
      .bind(repoIds['private-tasks'], userIds['cf-reader'], 'read', userIds[OWNER], Date.now(), Date.now())
      .run();
    expect((await tasks('private-tasks', '', tok.reader)).json.tasks).toHaveLength(1);
    expect((await tasks('private-tasks', '', tok.outsider)).status).toBe(404);
    expect((await tasks('private-tasks', '', null)).status).toBe(404);
    expect((await tasks('private-tasks', '?status=bogus')).json.code).toBe('INVALID_STATUS');
    expect((await tasks('private-tasks', '?kind=resolve-conflict&status=all')).json.tasks).toHaveLength(1);
    expect((await tasks('private-tasks', '?kind=other')).json.tasks).toEqual([]);
    expect((await tasks('private-tasks', '?status=completed')).json.tasks).toEqual([]);
    expect((await tasks('private-tasks', '?cursor=nope')).json.code).toBe('INVALID_CURSOR');
  });

  it('pages newest first with a cursor', async () => {
    const repo = await seedRepo('paging');
    const root = await commit(repo, BASE);
    const main = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: 'main' }) }, [root.sha]);
    repo.refs.set(MAIN, main.sha);
    for (const b of ['a', 'b', 'c']) {
      const f = await commit(repo, { ...BASE, 'lines.txt': linesWith({ 9: `feature ${b}` }) }, [root.sha]);
      repo.refs.set(`refs/heads/${b}`, f.sha);
      expect((await create('paging', 'review', b)).status).toBe(201);
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await tasks('paging', '?limit=2');
    expect(first.json.tasks.map((t: any) => t.change.number)).toEqual([3, 2]);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await tasks('paging', `?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`);
    expect(second.json.tasks.map((t: any) => t.change.number)).toEqual([1]);
    expect(second.json.nextCursor).toBeNull();
  });
});
