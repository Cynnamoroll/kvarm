/**
 * The push-side fast path (services/pushFastPath.ts).
 *
 * A confirmed push through the git gate moves the head of the live changes on
 * the pushed branch and runs the head-moved hooks (guard verdict, CI dispatch
 * and the queued entry's head move) right in the push request's background
 * work — before the Artifacts push event exists anywhere. The event delivered
 * afterwards must complete as the audit record without duplicating any of it,
 * and a push whose compare-and-swap does not apply must change nothing.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EMPTY_PACK, pktLine, readPktLines, ZERO_OID } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { PUSH_EFFECTS } from '../src/services/events';
import { branchPushUpdates, FAST_PATH_CHANGE_LIMIT } from '../src/services/pushFastPath';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'fp-owner';
const FULL: Scope[] = ['read', 'write', 'api'];
const MAIN = 'refs/heads/main';
const ZERO = ZERO_OID;

class FakeWorkflow {
  instances = new Set<string>();
  async create(opts: { id?: string }) {
    const id = opts.id ?? crypto.randomUUID();
    if (this.instances.has(id)) throw new Error(`instance.already_exists: ${id}`);
    this.instances.add(id);
    return { id };
  }
  async get(id: string) {
    if (!this.instances.has(id)) throw new Error(`instance.not_found: ${id}`);
    return { id };
  }
}

/** Kicks and other queue sends recorded instead of delivered. */
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
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
} as Env;

let token = '';
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  await env.DB.prepare(
    `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?, 'public', 'main', ?)`,
  )
    .bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, Date.now())
    .run();
  return repo;
}

interface Reply {
  status: number;
  json: Record<string, any>;
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
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

/** One git-receive-pack request through the git gate; returns HTTP status and report-status lines. */
async function gitPush(repo: string, cmds: string[]): Promise<{ status: number; report: string[]; cost: CostCounters }> {
  const parts = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0report-status agent=git/2.47\n` : `${c}\n`));
  const needsPack = cmds.some((c) => c.split(' ')[1] !== ZERO);
  const body = new Blob([...parts, new TextEncoder().encode('0000'), ...(needsPack ? [EMPTY_PACK] : [])]);
  const ctx = createExecutionContext();
  const req = new Request(`${ORIGIN}/${OWNER}/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`x:${token}`)}`, 'content-type': 'application/x-git-receive-pack-request' },
    body: new Uint8Array(await body.arrayBuffer()),
  });
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, env, ctx);
  const buf = new Uint8Array(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost, `${COST_HEADER}: ${res.headers.get(COST_HEADER)}`).not.toBeNull();
  if (res.status !== 200) return { status: res.status, report: [], cost: cost! };
  const report = readPktLines(buf)
    .filter((p) => !p.flush)
    .map((p) => new TextDecoder().decode(p.data).trim());
  return { status: res.status, report, cost: cost! };
}

function pushEvent(repo: string, ref: string, before: string, after: string, at: number) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date(at).toISOString() },
  };
}

async function deliver(body: unknown): Promise<void> {
  const batch = createMessageBatch('kvarm-events', [{ id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body }]);
  const ctx = createExecutionContext();
  await worker.queue!(batch, env, ctx);
  const result = await getQueueResult(batch, ctx);
  await waitOnExecutionContext(ctx);
  expect(result.explicitAcks).toHaveLength(1);
}

/** Bounded wait for a D1 predicate; workerd tests have no fake timers to advance. */
async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 160; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function guardRunsAt(repo: string, head: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM check_runs WHERE repo_id = ? AND head_sha = ? AND name = 'kvarm/guard'")
    .bind(repoIds[repo]!, head)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function ciRunsAt(repo: string, head: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM check_runs WHERE repo_id = ? AND head_sha = ? AND name = 'bench'")
    .bind(repoIds[repo]!, head)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function changeHead(repo: string, number: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT head_sha FROM change_sets WHERE repo_id = ? AND number = ?')
    .bind(repoIds[repo]!, number)
    .first<{ head_sha: string | null }>();
  return row?.head_sha ?? null;
}

const CI_CONFIG = { jobs: [{ name: 'bench', run: 'true', required: true, timeoutSeconds: 60 }] };
const ciFiles = { 'README.md': 'readme\n', '.kvarm/ci.json': `${JSON.stringify(CI_CONFIG)}\n` };

/** main with a CI config; branch `b1` adds a file; `count` open changes on it. Returns the commits. */
async function setupChange(repo: string, count = 1): Promise<{ base: string; b1: string; numbers: number[] }> {
  const r = await seedRepo(repo);
  const main = await commit(r, ciFiles);
  r.refs.set(MAIN, main.sha);
  const b1 = await commit(r, { ...ciFiles, 'f1.txt': 'one\n' }, [main.sha]);
  r.refs.set('refs/heads/b1', b1.sha);
  const numbers: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = await call('POST', api(repo, '/changes'), { title: `fp ${i}`, base: 'main', head: 'b1', mergePolicy: 'review' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    numbers.push(c.json.number as number);
  }
  return { base: main.sha, b1: b1.sha, numbers };
}

/** The next commit on b1 with the CI config still in place; the ref still sits at `parent` (the push moves it). */
async function nextHead(repo: string, parent: string, text: string): Promise<string> {
  const r = fakeRepos.get(`${OWNER}--${repo}`)!;
  const c = await commit(r, { ...ciFiles, 'f1.txt': `${text}\n` }, [parent]);
  return c.sha;
}

beforeAll(async () => {
  installFakeGitRemote();
  token = (await mintPAT(env, await seedUser(OWNER), 'fp-owner', FULL)).token;
});

afterAll(() => restoreFetch());

describe('branchPushUpdates', () => {
  const cmd = (oldOid: string, newOid: string, ref: string) => ({ oldOid, newOid, ref });
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);

  it('keeps confirmed branch updates only: no tags, creations, deletions or unconfirmed refs', () => {
    const commands = [
      cmd(A, B, 'refs/heads/b1'),
      cmd(A, B, 'refs/tags/v1'),
      cmd(ZERO, B, 'refs/heads/new-branch'),
      cmd(A, ZERO, 'refs/heads/gone'),
      cmd(A, B, 'refs/heads/other'),
    ];
    const updates = branchPushUpdates(commands, ['refs/heads/b1', 'refs/heads/gone', 'refs/tags/v1']);
    expect(updates).toEqual([{ ref: 'refs/heads/b1', before: A, after: B }]);
  });
});

describe('confirmed push fast path', () => {
  it('records the guard verdict and queues claimable CI at the pushed head before any push event exists', async () => {
    const { b1, numbers } = await setupChange('verdict');
    const n = numbers[0]!;
    // Creation recorded the guard and queued CI at the head it was opened at.
    expect(await guardRunsAt('verdict', b1)).toBe(1);
    expect(await ciRunsAt('verdict', b1)).toBe(1);

    const head2 = await nextHead('verdict', b1, 'two');
    const pushed = await gitPush('verdict', [`${b1} ${head2} refs/heads/b1`]);
    expect(pushed.status).toBe(200);
    expect(pushed.report.some((l) => l === `ok refs/heads/b1`)).toBe(true);
    // The fast path is background work of the push request: it never adds to
    // the reply's own cost header.
    expect(pushed.cost.d1).toBeLessThanOrEqual(2);

    await until(
      () => Promise.all([guardRunsAt('verdict', head2), ciRunsAt('verdict', head2)]),
      ([g, ci]) => g === 1 && ci === 1,
      'the fast-path guard verdict and CI dispatch',
    );
    expect(await changeHead('verdict', n)).toBe(head2);
    const jobs = await env.DB.prepare('SELECT name FROM ci_jobs WHERE repo_id = ? AND head_sha = ?')
      .bind(repoIds.verdict!, head2)
      .all<{ name: string }>();
    expect((jobs.results ?? []).map((j) => j.name)).toEqual(['bench']);
    // No push event has been delivered: nothing but the gate has run.
    const events = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_events WHERE repo_id = ?').bind(repoIds.verdict!).first<{ n: number }>();
    expect(events!.n).toBe(0);
  });

  it('the later Artifacts event completes as the audit record without duplicating any effect', async () => {
    const { b1 } = await setupChange('dup');
    const head2 = await nextHead('dup', b1, 'two');
    const pushed = await gitPush('dup', [`${b1} ${head2} refs/heads/b1`]);
    expect(pushed.status).toBe(200);
    await until(() => guardRunsAt('dup', head2), (g) => g === 1, 'the fast-path verdict at the new head');

    await deliver(pushEvent('dup', 'refs/heads/b1', b1, head2, Date.now()));
    expect(await guardRunsAt('dup', head2)).toBe(1);
    expect(await ciRunsAt('dup', head2)).toBe(1);
    await until(
      () => env.DB.prepare('SELECT id, completed_at FROM push_events WHERE repo_id = ?').bind(repoIds.dup!).first<{ id: string; completed_at: number | null }>(),
      (e) => e?.completed_at != null,
      'the event to complete every effect',
    );
    const events = await env.DB.prepare('SELECT id FROM push_events WHERE repo_id = ?').bind(repoIds.dup!).all<{ id: string }>();
    expect((events.results ?? []).length).toBe(1);
    const effects = await env.DB.prepare('SELECT effect, state FROM push_event_effects WHERE event_id = ?')
      .bind(events.results![0]!.id)
      .all<{ effect: string; state: string }>();
    // Per effect rather than an exact map, so a new push effect does not break this test: the
    // effects the fast path already ran are done exactly once, and every other one is skipped
    // for a push to a non-default branch.
    const rows = effects.results ?? [];
    const states = new Map(rows.map((e) => [e.effect, e.state]));
    expect(rows).toHaveLength(states.size);
    expect([...states.keys()].sort()).toEqual(PUSH_EFFECTS.map((e) => e.name).sort());
    const fastPathDone = new Set(['purge', 'change-hooks']);
    for (const [effect, state] of states) expect([effect, state]).toEqual([effect, fastPathDone.has(effect) ? 'done' : 'skipped']);
  });

  it('changes nothing when the compare-and-swap does not apply, and the event stays authoritative', async () => {
    const { b1 } = await setupChange('cas');
    const head2 = await nextHead('cas', b1, 'two');
    // The change's head no longer sits at the pushed `before` position, so the
    // fast path must not move or judge anything.
    await env.DB.prepare('UPDATE change_sets SET head_sha = ? WHERE repo_id = ? AND head_ref = ?').bind('c'.repeat(40), repoIds.cas!, 'b1').run();
    const pushed = await gitPush('cas', [`${b1} ${head2} refs/heads/b1`]);
    expect(pushed.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await guardRunsAt('cas', head2)).toBe(0);
    expect(await changeHead('cas', 1)).toBe('c'.repeat(40));

    // The Artifacts event moves the head to the ref position it recorded and
    // records the guard there: the reliable path is untouched by the miss.
    await deliver(pushEvent('cas', 'refs/heads/b1', b1, head2, Date.now()));
    expect(await changeHead('cas', 1)).toBe(head2);
    await until(() => guardRunsAt('cas', head2), (g) => g === 1, 'the event path guard verdict');
  });

  it('a queued change whose head is pushed goes stale immediately, with the train kick', async () => {
    const { b1 } = await setupChange('queued');
    const enqueued = await call('POST', api('queued', '/changes/1/enqueue'));
    expect(enqueued.status, JSON.stringify(enqueued.json)).toBe(201);
    sent.length = 0;

    const head2 = await nextHead('queued', b1, 'two');
    const pushed = await gitPush('queued', [`${b1} ${head2} refs/heads/b1`]);
    expect(pushed.status).toBe(200);

    const entry = await until(
      () => env.DB.prepare('SELECT state, reason_code, active FROM merge_queue WHERE repo_id = ?').bind(repoIds.queued!).first<{ state: string; reason_code: string | null; active: number }>(),
      (q) => q?.state === 'stale',
      'the queued entry to go stale',
    );
    expect(entry!.reason_code).toBe('HEAD_MOVED');
    expect(entry!.active).toBe(0);
    expect(sent).toContainEqual(expect.objectContaining({ body: expect.objectContaining({ type: 'kvarm.train', reason: 'head-moved' }) }));
  });

  it('a push to a branch no live change uses dispatches nothing and the push reply is unchanged', async () => {
    const r = await seedRepo('quiet');
    const main = await commit(r, { 'README.md': 'readme\n' });
    r.refs.set(MAIN, main.sha);
    const next = await commit(r, { 'README.md': 'readme 2\n' }, [main.sha]);
    const pushed = await gitPush('quiet', [`${main.sha} ${next.sha} refs/heads/main`]);
    expect(pushed.status).toBe(200);
    expect(pushed.report.some((l) => l === `ok refs/heads/main`)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const guards = await env.DB.prepare("SELECT COUNT(*) AS n FROM check_runs WHERE repo_id = ? AND name = 'kvarm/guard'")
      .bind(repoIds.quiet!)
      .first<{ n: number }>();
    expect(guards!.n).toBe(0);
  });

  it(`bounds its hook work at ${FAST_PATH_CHANGE_LIMIT} changes and leaves the rest to the event`, async () => {
    const count = FAST_PATH_CHANGE_LIMIT + 1;
    const { b1 } = await setupChange('many', count);
    const head2 = await nextHead('many', b1, 'two');
    const pushed = await gitPush('many', [`${b1} ${head2} refs/heads/b1`]);
    expect(pushed.status).toBe(200);
    await until(() => guardRunsAt('many', head2), (g) => g === FAST_PATH_CHANGE_LIMIT, 'the bounded fast-path verdicts');
    expect(await ciRunsAt('many', head2)).toBe(FAST_PATH_CHANGE_LIMIT);

    await deliver(pushEvent('many', 'refs/heads/b1', b1, head2, Date.now()));
    await until(() => guardRunsAt('many', head2), (g) => g === count, 'the event to cover the changes beyond the bound');
    expect(await ciRunsAt('many', head2)).toBe(count);
  });
});
