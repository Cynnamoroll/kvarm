/**
 * Revert change sets and signed incident webhooks (services/reverts.ts,
 * services/incidents.ts) through the Worker's routes over the in-memory
 * Artifacts fake: the revert tree and commit, the change it opens (kind
 * `revert`, draft by default, kvarm/guard and CI like any change, the merge
 * queue unchanged), refusals that write nothing, authorization, and the
 * webhook's signature, replay window, idempotency and rotation.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decode } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import type { RepoRow } from '../src/db/repos';
import worker from '../src/index';
import type { ChangeContext } from '../src/services/changes';
import { createRevert, defaultRevertDeps, revertBranch } from '../src/services/reverts';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch, writeTree, type Files } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const OWNER = 'rv-owner';
const MAIN = 'refs/heads/main';
const MASTER = 'test-only incident master key, not a secret';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const sent: unknown[] = [];
const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
  CI_PIPELINE: new FakeWorkflow() as unknown as Env['CI_PIPELINE'],
  EVENTS: {
    async send(body: unknown) {
      sent.push(body);
    },
    async sendBatch(msgs: Array<{ body: unknown }>) {
      for (const m of msgs) sent.push(m.body);
    },
  } as unknown as Env['EVENTS'],
  INCIDENT_WEBHOOK_KEY: MASTER,
} as Env;
const keyless = { ...env, INCIDENT_WEBHOOK_KEY: undefined } as Env;

const tok = { owner: '', writer: '', reader: '', outsider: '' };
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

const userIds: Record<string, string> = {};

async function seedRepo(name: string): Promise<FakeRepo> {
  const artifactsName = `${OWNER}--${name}`;
  const repo = new FakeRepo();
  fakeRepos.set(artifactsName, repo);
  const id = crypto.randomUUID();
  repoIds[name] = id;
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO repos (id, owner_login, name, artifacts_name, artifacts_remote, visibility, default_branch, created_at)
       VALUES (?, ?, ?, ?, ?, 'private', 'main', ?)`,
    ).bind(id, OWNER, name, artifactsName, `https://artifacts.invalid/git/default/${artifactsName}.git`, now),
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(id, userIds.writer, 'write', now, now),
    env.DB.prepare('INSERT INTO repo_grants (repo_id, user_id, role, granted_by, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)').bind(id, userIds.reader, 'read', now, now),
  ]);
  return repo;
}

interface Reply {
  status: number;
  text: string;
  json: Record<string, any>;
  cost: CostCounters;
}

async function send(req: Request, e: Env = env): Promise<Reply> {
  const ctx = createExecutionContext();
  const res = await worker.fetch!(req as Request<unknown, IncomingRequestCfProperties>, e, ctx);
  const text = await res.text();
  await waitOnExecutionContext(ctx);
  const cost = parseCostHeader(res.headers.get(COST_HEADER));
  expect(cost).not.toBeNull();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text) as Record<string, any>;
  } catch {
    // non-JSON body
  }
  return { status: res.status, text, json, cost: cost! };
}

function call(method: string, path: string, token?: string, body?: unknown, e: Env = env): Promise<Reply> {
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return send(new Request(`${ORIGIN}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), e);
}

const R = (repo: string) => `/api/v1/repos/${OWNER}/${repo}`;
const revert = (repo: string, body: unknown, token = tok.owner) => call('POST', `${R(repo)}/reverts`, token, body);

const CI = `${JSON.stringify({ jobs: [{ name: 'build', run: 'npm test', required: true }] })}\n`;
const BASE: Files = { 'README.md': '# App\n', 'src/app.js': 'line 1\nline 2\nline 3\nline 4\nline 5\n', '.kvarm/ci.json': CI };

/** main: base -> bad (edits src/app.js, adds bad.txt) -> later (adds later.txt). */
async function history(repo: FakeRepo) {
  const base = await commit(repo, BASE);
  const badFiles: Files = { ...BASE, 'src/app.js': 'line 1\nline TWO\nline 3\nline 4\nline 5\n', 'bad.txt': 'bad\n' };
  const bad = await commit(repo, badFiles, [base.sha]);
  const later = await commit(repo, { ...badFiles, 'later.txt': 'later\n' }, [bad.sha]);
  repo.refs.set(MAIN, later.sha);
  return { base, bad, later };
}

function commitOf(repo: FakeRepo, sha: string) {
  const text = decode(repo.objects.get(sha)!.content);
  const head = text.slice(0, text.indexOf('\n\n'));
  return {
    tree: /^tree ([0-9a-f]{40})$/m.exec(head)![1]!,
    parents: [...head.matchAll(/^parent ([0-9a-f]{40})$/gm)].map((m) => m[1]!),
    message: text.slice(text.indexOf('\n\n') + 2),
  };
}

async function counts(repo: string, fake: FakeRepo) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM change_sets WHERE repo_id = ?1) AS changes,
            (SELECT COUNT(*) FROM incident_events WHERE repo_id = ?1) AS events,
            (SELECT COUNT(*) FROM check_runs WHERE repo_id = ?1) AS runs`,
  )
    .bind(repoIds[repo])
    .first<{ changes: number; events: number; runs: number }>();
  return { ...row, refs: [...fake.refs.entries()].sort(), receivePacks: fake.count('receivePack') };
}

beforeAll(async () => {
  installFakeGitRemote();
  const all: Scope[] = ['read', 'write', 'api', 'ci'];
  const ownerId = await seedUser(OWNER);
  tok.owner = (await mintPAT(env, ownerId, 'owner', all)).token;
  userIds.writer = await seedUser('rv-writer');
  tok.writer = (await mintPAT(env, userIds.writer, 'writer', all)).token;
  userIds.reader = await seedUser('rv-reader');
  tok.reader = (await mintPAT(env, userIds.reader, 'reader', all)).token;
  tok.outsider = (await mintPAT(env, await seedUser('rv-outsider'), 'outsider', all)).token;
});

afterAll(() => restoreFetch());

describe('POST reverts', () => {
  it('builds the revert on a reserved branch and opens a draft revert change with guard and CI, which queues unchanged once reviewed', async () => {
    const repo = await seedRepo('happy');
    const { bad, later } = await history(repo);
    const r = await revert('happy', { sha: bad.sha, reason: 'error rate doubled' });
    expect(r.status, r.text).toBe(201);

    const expectedTree = await writeTree(repo, { ...BASE, 'later.txt': 'later\n' });
    expect(r.json.revert).toMatchObject({ sha: bad.sha, parent: bad.sha === later.sha ? null : expect.any(String), merge: false, treeSha: expectedTree, reason: 'error rate doubled' });
    expect(r.json.revert.branch).toMatch(new RegExp(`^kvarm-revert/${bad.sha.slice(0, 7)}-[0-9a-f]{8}$`));
    const c = commitOf(repo, r.json.revert.commit);
    expect(c).toMatchObject({ tree: expectedTree, parents: [later.sha] });
    expect(c.message).toBe(`Revert "m"\n\nThis reverts commit ${bad.sha}.\n\nerror rate doubled\n`);
    expect(repo.refs.get(`refs/heads/${r.json.revert.branch}`)).toBe(r.json.revert.commit);

    const change = r.json.change;
    expect(change).toMatchObject({ kind: 'revert', mergePolicy: 'draft', state: 'open', base: 'main', head: r.json.revert.branch, headSha: r.json.revert.commit, title: 'Revert "m"' });
    expect(change.body).toContain(`This reverts commit ${bad.sha}.`);
    expect(change.checks.map((k: any) => [k.name, k.status, k.headSha])).toEqual(
      expect.arrayContaining([
        ['kvarm/guard', 'success', r.json.revert.commit],
        ['build', 'queued', r.json.revert.commit],
      ]),
    );
    const listed = await call('GET', `${R('happy')}/changes/${change.number}`, tok.owner);
    expect(listed.json).toMatchObject({ kind: 'revert', mergeability: { status: 'fast-forward' } });

    // A draft revert never enters the queue; once its policy is review it enqueues like any change.
    const draft = await call('POST', `${R('happy')}/changes/${change.number}/enqueue`, tok.owner, {});
    expect([draft.status, draft.json.code]).toEqual([409, 'DRAFT']);
    expect((await call('PATCH', `${R('happy')}/changes/${change.number}`, tok.owner, { mergePolicy: 'review' })).status).toBe(200);
    const queued = await call('POST', `${R('happy')}/changes/${change.number}/enqueue`, tok.owner, {});
    expect(queued.status, queued.text).toBe(201);
    expect(queued.json.entry).toMatchObject({ number: change.number, state: 'queued', target: 'main' });
    const q = await call('GET', `${R('happy')}/queue`, tok.owner);
    expect(q.json.entries.map((e: any) => e.number)).toEqual([change.number]);
    expect(r.cost.do).toBe(0);
  });

  it('reverts a merged change set relative to the target it landed on, the same tree as reverting its merge commit with -m 1', async () => {
    const repo = await seedRepo('merged');
    // No CI config: the explicit merge below needs every required check finished, and nothing runs CI here.
    const { '.kvarm/ci.json': _ci, ...plain } = BASE;
    const base = await commit(repo, plain);
    const feature = await commit(repo, { ...plain, 'feature.txt': 'f\n', 'src/app.js': 'line 1\nline 2\nline 3\nline 4\nline FIVE\n' }, [base.sha]);
    const moved = await commit(repo, { ...plain, 'main.txt': 'm\n' }, [base.sha]);
    repo.refs.set(MAIN, moved.sha);
    repo.refs.set('refs/heads/feature', feature.sha);
    expect((await call('POST', `${R('merged')}/changes`, tok.owner, { title: 'feature', base: 'main', head: 'feature' })).status).toBe(201);
    const m = await call('POST', `${R('merged')}/changes/1/merge`, tok.owner, {});
    expect(m.status, m.text).toBe(200);
    expect(m.json.merge.kind).toBe('merge');
    const mergeCommit = m.json.mergeCommit as string;

    const byChange = await revert('merged', { changeNumber: 1, mergePolicy: 'review' });
    expect(byChange.status, byChange.text).toBe(201);
    const restored = await writeTree(repo, { ...plain, 'main.txt': 'm\n' });
    expect(byChange.json.revert).toMatchObject({ sha: mergeCommit, parent: moved.sha, merge: true, changeNumber: 1, treeSha: restored });
    expect(byChange.json.change).toMatchObject({ kind: 'revert', mergePolicy: 'review' });
    expect(commitOf(repo, byChange.json.revert.commit).message).toContain(`This reverts commit ${mergeCommit}, reversing\nchanges made to ${moved.sha}.`);

    const bySha = await revert('merged', { sha: mergeCommit });
    expect(bySha.status, bySha.text).toBe(201);
    expect(bySha.json.revert.treeSha).toBe(restored);
    expect(bySha.json.revert.branch).not.toBe(byChange.json.revert.branch);

    expect((await revert('merged', { changeNumber: 2 })).json.code).toBe('CHANGE_NOT_MERGED');
    expect((await revert('merged', { changeNumber: 99 })).status).toBe(404);
  });

  it('answers 404 for an unknown commit and 409 with the conflicting paths when the revert does not apply, writing nothing', async () => {
    const repo = await seedRepo('refused');
    const { bad, later } = await history(repo);
    const rework = await commit(repo, { ...BASE, 'src/app.js': 'line 1\nline 2 again\nline 3\nline 4\nline 5\n', 'bad.txt': 'bad\n', 'later.txt': 'later\n' }, [later.sha]);
    repo.refs.set(MAIN, rework.sha);
    const before = await counts('refused', repo);

    const unknown = await revert('refused', { sha: 'f'.repeat(40) });
    expect([unknown.status, unknown.json.code]).toEqual([404, 'COMMIT_NOT_FOUND']);
    const conflict = await revert('refused', { sha: bad.sha });
    expect(conflict.status).toBe(409);
    expect(conflict.json).toMatchObject({ code: 'REVERT_CONFLICT', conflictCount: 1, conflicts: [{ path: 'src/app.js', kind: 'content', paths: ['src/app.js'] }] });
    expect(await counts('refused', repo)).toEqual(before);

    expect((await revert('refused', { sha: bad.sha, changeNumber: 1 })).json.code).toBe('INVALID_REVERT_TARGET');
    expect((await revert('refused', { sha: 'abc' })).json.code).toBe('INVALID_SHA');
    expect((await revert('refused', { sha: bad.sha, base: 'nope' })).json.code).toBe('REF_NOT_FOUND');
    expect((await revert('refused', { sha: bad.sha, mergePolicy: 'yolo' })).json.code).toBe('INVALID_MERGE_POLICY');
    expect(await counts('refused', repo)).toEqual(before);
  });

  it('answers 409 NOTHING_TO_REVERT for a commit whose revert changes nothing', async () => {
    const repo = await seedRepo('noop');
    const { bad } = await history(repo);
    const first = await revert('noop', { sha: bad.sha });
    expect(first.status).toBe(201);
    repo.refs.set(MAIN, first.json.revert.commit);
    const again = await revert('noop', { sha: bad.sha });
    expect([again.status, again.json.code]).toEqual([409, 'NOTHING_TO_REVERT']);
  });

  it('needs write access: anonymous and strangers see no repository (404), read grant 403, a writer may revert', async () => {
    const repo = await seedRepo('authz');
    const { bad } = await history(repo);
    const before = await counts('authz', repo);
    expect((await revert('authz', { sha: bad.sha }, '')).status).toBe(404);
    const read = await revert('authz', { sha: bad.sha }, tok.reader);
    expect(read.status).toBe(403);
    const stranger = await revert('authz', { sha: bad.sha }, tok.outsider);
    const missing = await call('POST', `${R('no-such-repo')}/reverts`, tok.outsider, { sha: bad.sha });
    expect([stranger.status, stranger.json]).toEqual([missing.status, missing.json]);
    expect(stranger.status).toBe(404);
    expect(await counts('authz', repo)).toEqual(before);
    expect((await revert('authz', { sha: bad.sha }, tok.writer)).status).toBe(201);
  });
});

describe('revert lifecycle', () => {
  it('names every commit of a fast-forwarded change set in the message of its revert', async () => {
    const repo = await seedRepo('ffrange');
    const { '.kvarm/ci.json': _ci, ...plain } = BASE;
    const base = await commit(repo, plain);
    const one = await commit(repo, { ...plain, 'one.txt': '1\n' }, [base.sha]);
    const two = await commit(repo, { ...plain, 'one.txt': '1\n', 'two.txt': '2\n' }, [one.sha]);
    repo.refs.set(MAIN, base.sha);
    repo.refs.set('refs/heads/feature', two.sha);
    expect((await call('POST', `${R('ffrange')}/changes`, tok.owner, { title: 'two commits', base: 'main', head: 'feature' })).status).toBe(201);
    const m = await call('POST', `${R('ffrange')}/changes/1/merge`, tok.owner, {});
    expect(m.json.merge?.kind).toBe('fast-forward');
    const r = await revert('ffrange', { changeNumber: 1 });
    expect(r.status, r.text).toBe(201);
    expect(r.json.revert).toMatchObject({ sha: two.sha, parent: base.sha, treeSha: base.tree });
    expect(commitOf(repo, r.json.revert.commit).message).toContain(`This reverts commits ${base.sha}..${two.sha}.`);
  });

  it('marks a revert that stops applying conflicted without dispatching a task nobody could complete', async () => {
    const repo = await seedRepo('stale-revert');
    const { bad, later } = await history(repo);
    const r = await revert('stale-revert', { sha: bad.sha, mergePolicy: 'review' });
    expect(r.status).toBe(201);
    const n = r.json.change.number as number;
    const rework = await commit(repo, { ...BASE, 'src/app.js': 'line 1\nline TWO!\nline 3\nline 4\nline 5\n', 'bad.txt': 'bad\n', 'later.txt': 'later\n' }, [later.sha]);
    repo.refs.set(MAIN, rework.sha);
    const ctx = createExecutionContext();
    const batch = createMessageBatch('kvarm-events', [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        attempts: 1,
        body: {
          type: 'cf.artifacts.repo.pushed',
          source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--stale-revert` },
          payload: { ref: MAIN, before: later.sha, after: rework.sha, commits: [], totalCommitsCount: 0, commitsTruncated: false },
          metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
        },
      },
    ]);
    await worker.queue!(batch, env, ctx);
    await getQueueResult(batch, ctx);
    await waitOnExecutionContext(ctx);
    const after = await call('GET', `${R('stale-revert')}/changes/${n}`, tok.owner);
    expect(after.json).toMatchObject({ kind: 'revert', state: 'conflicted' });
    const tasks = await env.DB.prepare('SELECT COUNT(*) AS n FROM agent_tasks WHERE repo_id = ?').bind(repoIds['stale-revert']).first<{ n: number }>();
    expect(tasks?.n).toBe(0);
    // The remedy is a fresh revert on the new tip, which conflicts too here and says so.
    expect((await revert('stale-revert', { sha: bad.sha })).json.code).toBe('REVERT_CONFLICT');
  });
});

describe('MCP', () => {
  it('create_revert and rotate_incident_secret reach the same routes as REST', async () => {
    const repo = await seedRepo('mcp');
    const { bad } = await history(repo);
    const rpc = (name: string, args: Record<string, unknown>) =>
      send(
        new Request(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tok.owner}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        }),
      );
    const text = (r: Reply) => JSON.parse((r.json.result as { content: Array<{ text: string }> }).content[0]!.text);
    const created = await rpc('create_revert', { repo: `${OWNER}/mcp`, sha: bad.sha, reason: 'via mcp' });
    expect(created.status).toBe(200);
    expect(text(created)).toMatchObject({ revert: { sha: bad.sha, reason: 'via mcp' }, change: { kind: 'revert', mergePolicy: 'draft' } });
    const rotated = text(await rpc('rotate_incident_secret', { repo: `${OWNER}/mcp` }));
    expect(rotated.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(text(await rpc('get_incident_webhook', { repo: `${OWNER}/mcp` }))).toMatchObject({ configured: true, generation: 1 });
  });
});

// ---------------------------------------------------------------------------
// Incident webhooks
// ---------------------------------------------------------------------------

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const event = (id: string, subject: string, data?: Record<string, unknown>) =>
  JSON.stringify({ specversion: '1.0', id, source: 'https://pager.example/alerts', type: 'com.example.incident.opened', subject, ...(data ? { data } : {}) });

async function deliver(repo: string, body: string, o: { secret?: string; timestamp?: number; signature?: string | null; env?: Env } = {}): Promise<Reply> {
  const ts = String(o.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { 'content-type': 'application/cloudevents+json', 'x-kvarm-timestamp': ts };
  const sig = o.signature !== undefined ? o.signature : o.secret ? `sha256=${await sign(o.secret, ts, body)}` : null;
  if (sig !== null) headers['x-kvarm-signature'] = sig;
  return send(new Request(`${ORIGIN}${R(repo)}/incidents`, { method: 'POST', headers, body }), o.env ?? env);
}

const rotate = (repo: string, token = tok.owner, e: Env = env) => call('POST', `${R(repo)}/incidents/webhook/rotate`, token, undefined, e);

describe('incident webhooks', () => {
  it('shows a rotated secret once, to repo admins only, and is off without the Worker key', async () => {
    const repo = await seedRepo('secret');
    await history(repo);
    const none = await call('GET', `${R('secret')}/incidents/webhook`, tok.owner);
    expect(none.json).toMatchObject({ configured: false, available: true, generation: null, fingerprint: null, signatureHeader: 'x-kvarm-signature' });
    expect((await rotate('secret', tok.writer)).status).toBe(403);
    expect((await rotate('secret', tok.outsider)).status).toBe(404);
    expect((await rotate('secret', tok.owner, keyless)).json.code).toBe('INCIDENTS_UNAVAILABLE');
    expect((await call('GET', `${R('secret')}/incidents/webhook`, tok.owner, undefined, keyless)).json.available).toBe(false);

    const first = await rotate('secret');
    expect(first.status).toBe(201);
    expect(first.json.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.json).toMatchObject({ configured: true, generation: 1, fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/) });
    const shown = await call('GET', `${R('secret')}/incidents/webhook`, tok.owner);
    expect(shown.json).toMatchObject({ configured: true, generation: 1, fingerprint: first.json.fingerprint });
    expect(shown.text).not.toContain(first.json.secret);
    const stored = await env.DB.prepare('SELECT * FROM incident_webhooks WHERE repo_id = ?').bind(repoIds.secret).first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(first.json.secret);
    const second = await rotate('secret');
    expect(second.json.generation).toBe(2);
    expect(second.json.secret).not.toBe(first.json.secret);
  });

  it('opens a revert change for a verified event and answers a repeated event id with the same change', async () => {
    const repo = await seedRepo('incident');
    const { bad } = await history(repo);
    const { secret } = (await rotate('incident')).json as { secret: string };
    const body = event('evt-1', bad.sha, { reason: 'checkout errors spiked' });
    const r = await deliver('incident', body, { secret });
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({ duplicate: false, eventId: 'evt-1', revert: { sha: bad.sha, reason: 'checkout errors spiked' }, change: { kind: 'revert', mergePolicy: 'draft', author: null } });
    expect(r.json.change.body).toContain('Opened by incident event "evt-1"');
    expect(r.json.change.checks.map((k: any) => k.name).sort()).toEqual(['build', 'kvarm/guard']);
    const number = r.json.change.number as number;
    const after = await counts('incident', repo);

    const again = await deliver('incident', body, { secret });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ duplicate: true, eventId: 'evt-1', change: { number, kind: 'revert' } });
    expect(await counts('incident', repo)).toEqual(after);

    const auto = await deliver('incident', event('evt-2', bad.sha, { mergePolicy: 'review' }), { secret });
    expect(auto.status).toBe(201);
    expect(auto.json.change.mergePolicy).toBe('review');
    expect(auto.json.change.number).not.toBe(number);
  });

  it('rejects unverifiable deliveries with 401 and writes nothing', async () => {
    const repo = await seedRepo('unsigned');
    const { bad } = await history(repo);
    const { secret } = (await rotate('unsigned')).json as { secret: string };
    const other = await seedRepo('unsigned-other');
    await history(other);
    const body = event('evt-x', bad.sha);
    const before = await counts('unsigned', repo);
    const now = Math.floor(Date.now() / 1000);

    const attempts: Array<[string, Promise<Reply>]> = [
      ['missing signature', deliver('unsigned', body, { signature: null })],
      ['wrong secret', deliver('unsigned', body, { secret: 'a'.repeat(64) })],
      ['malformed signature', deliver('unsigned', body, { signature: 'sha256=zz' })],
      ['stale timestamp', deliver('unsigned', body, { secret, timestamp: now - 301 })],
      ['future timestamp', deliver('unsigned', body, { secret, timestamp: now + 301 })],
      ['tampered body', send(await tampered('unsigned', secret, body))],
      ['no webhook configured', deliver('unsigned-other', body, { secret })],
      ['unknown repository', deliver('no-such-repo', body, { secret })],
      ['no Worker key', deliver('unsigned', body, { secret, env: keyless })],
    ];
    for (const [what, p] of attempts) {
      const r = await p;
      expect([what, r.status, r.json]).toEqual([what, 401, { error: 'the delivery signature could not be verified', code: 'INVALID_SIGNATURE' }]);
      // At most the one webhook lookup; no row written, no Artifacts call, no subrequest.
      expect([what, r.cost.d1 <= 1, r.cost.rw, r.cost.art, r.cost.sub, r.cost.do]).toEqual([what, true, 0, 0, 0, 0]);
    }
    expect(await counts('unsigned', repo)).toEqual(before);
    expect(before.events).toBe(0);

    // A verified but invalid envelope writes nothing either.
    const invalid = await deliver('unsigned', JSON.stringify({ specversion: '1.0', id: 'e', source: 's', type: 't', subject: 'HEAD' }), { secret });
    expect([invalid.status, invalid.json.code]).toEqual([422, 'INVALID_EVENT']);
    // A refused revert releases its claim, so a retry of the id recomputes.
    const unknown = await deliver('unsigned', event('evt-404', 'f'.repeat(40)), { secret });
    expect([unknown.status, unknown.json.code]).toEqual([404, 'COMMIT_NOT_FOUND']);
    expect(await counts('unsigned', repo)).toEqual(before);
  });

  it('keys idempotency by source and id, and a delivery that takes over an abandoned claim never opens a second change', async () => {
    const repo = await seedRepo('takeover');
    const { bad } = await history(repo);
    const { secret } = (await rotate('takeover')).json as { secret: string };
    const first = await deliver('takeover', event('7', bad.sha), { secret });
    expect(first.status).toBe(201);
    // Same id from another source is another event.
    const other = JSON.stringify({ specversion: '1.0', id: '7', source: 'apm', type: 't', subject: bad.sha });
    const second = await deliver('takeover', other, { secret });
    expect(second.status).toBe(201);
    expect(second.json.change.number).not.toBe(first.json.change.number);

    // The first delivery's final write was lost and its claim abandoned: a retry adopts its change.
    await env.DB.prepare(`UPDATE incident_events SET state = 'pending', change_number = NULL, change_set_id = NULL, claimed_at = 0 WHERE repo_id = ? AND event_source = ?`)
      .bind(repoIds.takeover, 'https://pager.example/alerts')
      .run();
    const before = await counts('takeover', repo);
    const adopted = await deliver('takeover', event('7', bad.sha), { secret });
    expect(adopted.status, adopted.text).toBe(200);
    expect(adopted.json).toMatchObject({ duplicate: true, change: { number: first.json.change.number } });
    expect(await counts('takeover', repo)).toMatchObject({ changes: before.changes, refs: before.refs });

    // The same source and id naming another commit is refused, never answered with the other commit's change.
    const reused = await deliver('takeover', event('7', first.json.revert.commit), { secret });
    expect([reused.status, reused.json.code]).toEqual([409, 'EVENT_ID_REUSED']);

    // A delivery that pushed its branch and died before the change existed: the retry replaces the orphan
    // branch with a revert planned on the current tip and opens its change.
    const key = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('https://pager.example/alerts\u00009')))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8);
    const branch = `kvarm-revert/${bad.sha.slice(0, 7)}-${key}`;
    const orphan = (await commit(repo, { 'stale.txt': 'orphan\n' })).sha;
    repo.refs.set(`refs/heads/${branch}`, orphan);
    const recovered = await deliver('takeover', event('9', bad.sha), { secret });
    expect(recovered.status, recovered.text).toBe(201);
    expect(recovered.json).toMatchObject({ duplicate: false, revert: { branch, sha: bad.sha }, change: { kind: 'revert', head: branch, mergePolicy: 'draft' } });
    expect(repo.refs.get(`refs/heads/${branch}`)).toBe(recovered.json.revert.commit);
    expect(recovered.json.revert.commit).not.toBe(orphan);
    expect((await deliver('takeover', event('9', bad.sha), { secret })).json).toMatchObject({ duplicate: true, change: { number: recovered.json.change.number } });
  });

  it('opens at most one change per revert branch when two requests race past the branch check', async () => {
    const repo = await seedRepo('race');
    const { bad } = await history(repo);
    const repoRow = await env.DB.prepare('SELECT * FROM repos WHERE id = ?').bind(repoIds.race).first<RepoRow>();
    const cx: ChangeContext = { env, repo: repoRow!, actor: null, branchRules: [], waitUntil: () => undefined };
    const first = await createRevert(cx, { sha: bad.sha }, defaultRevertDeps, { branchKey: 'feedbeef' });
    expect(first.ok).toBe(true);
    const branch = revertBranch(bad.sha, 'feedbeef');
    // The second request finds no branch (as if it read before the first pushed) and pushes its own.
    repo.refs.delete(`refs/heads/${branch}`);
    const second = await createRevert(cx, { sha: bad.sha }, defaultRevertDeps, { branchKey: 'feedbeef' });
    expect(second).toMatchObject({ ok: false, status: 409, code: 'REVERT_BRANCH_EXISTS' });
    const changes = await env.DB.prepare(`SELECT COUNT(*) AS n FROM change_sets WHERE repo_id = ? AND head_ref = ?`).bind(repoIds.race, branch).first<{ n: number }>();
    expect(changes?.n).toBe(1);
    // The loser leaves the branch to the change that owns it.
    expect(repo.refs.has(`refs/heads/${branch}`)).toBe(true);
  });

  it('refuses a body over 64 KiB without buffering it, whether or not its length is declared', async () => {
    const repo = await seedRepo('big');
    await history(repo);
    const before = await counts('big', repo);
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const headers = { 'content-type': 'application/cloudevents+json', 'x-kvarm-timestamp': String(Math.floor(Date.now() / 1000)), 'x-kvarm-signature': `sha256=${'0'.repeat(64)}` };
    const chunked = await send(new Request(`${ORIGIN}${R('big')}/incidents`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit));
    expect([chunked.status, chunked.json.code]).toEqual([413, 'BODY_TOO_LARGE']);
    expect(pulled).toBeLessThan(64);
    const declared = await send(new Request(`${ORIGIN}${R('big')}/incidents`, { method: 'POST', headers, body: new Uint8Array(65 * 1024) }));
    expect(declared.status).toBe(413);
    expect(await counts('big', repo)).toEqual(before);
  });

  it('rotation invalidates the previous secret at once', async () => {
    const repo = await seedRepo('rotate');
    const { bad } = await history(repo);
    const old = ((await rotate('rotate')).json as { secret: string }).secret;
    const fresh = ((await rotate('rotate')).json as { secret: string }).secret;
    const before = await counts('rotate', repo);
    expect((await deliver('rotate', event('evt-r', bad.sha), { secret: old })).status).toBe(401);
    expect(await counts('rotate', repo)).toEqual(before);
    expect((await deliver('rotate', event('evt-r', bad.sha), { secret: fresh })).status).toBe(201);
    expect((await call('DELETE', `${R('rotate')}/incidents/webhook`, tok.owner)).json).toEqual({ deleted: true });
    expect((await deliver('rotate', event('evt-r2', bad.sha), { secret: fresh })).status).toBe(401);
  });
});

/** A correctly signed delivery whose body was changed after signing. */
async function tampered(repo: string, secret: string, body: string): Promise<Request> {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await sign(secret, ts, body);
  return new Request(`${ORIGIN}${R(repo)}/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/cloudevents+json', 'x-kvarm-timestamp': ts, 'x-kvarm-signature': `sha256=${sig}` },
    body: body.replace('"1.0"', '"1.0" '),
  });
}
