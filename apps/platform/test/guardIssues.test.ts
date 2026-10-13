/**
 * The guard as an issue producer (services/issues.ts guardScanStatements,
 * the events.ts issue-guard effect): a push that moves the default branch
 * outside the publication path is scanned with the same kvarm/guard
 * evaluation a change gets. A failing finding files one fingerprinted
 * issue, a later push that triggers it again counts one more occurrence
 * there, and the push that repairs the path closes the issue as verified.
 * The platform's own merges are recognized by their recorded merge commit
 * and skipped: kvarm/guard already gated their content.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'guard-owner';

class FakeWorkflow {
  async create(opts: { id?: string }) {
    return { id: opts.id ?? crypto.randomUUID() };
  }
  async get(id: string) {
    return { id };
  }
}

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '' };
const repoIds: Record<string, string> = {};

async function seedUser(login: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO users (id, workos_user_id, login, email, name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
    .bind(id, `test:${login}`, login, `${login}@kvarm.invalid`, login, Date.now())
    .run();
  return id;
}

async function seedRepo(name: string): Promise<{ repo: FakeRepo; main: string }> {
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
  const main = await commit(repo, { 'README.md': 'readme\n' });
  repo.refs.set('refs/heads/main', main.sha);
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
const getIssue = (repo: string, n: number) => call('GET', api(repo, `/issues/${n}`), tok.owner);
const merge = (repo: string, n: number) => call('POST', api(repo, `/changes/${n}/merge`), tok.owner);

/** A branch one commit ahead of main, adding `file`. */
async function branch(r: { repo: FakeRepo; main: string }, name: string, file: string): Promise<string> {
  const c = await commit(r.repo, { 'README.md': 'readme\n', [file]: `${file}\n` }, [r.main]);
  r.repo.refs.set(`refs/heads/${name}`, c.sha);
  return c.sha;
}

async function openChange(repo: string, body: Record<string, unknown>): Promise<number> {
  const r = await call('POST', api(repo, '/changes'), tok.owner, { base: 'main', ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.number as number;
}

function pushEvent(repo: string, ref: string, before: string, after: string) {
  return {
    type: 'cf.artifacts.repo.pushed',
    source: { type: 'artifacts', namespace: 'default', repoName: `${OWNER}--${repo}` },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
    metadata: { accountId: 'acct', eventSubscriptionId: 'sub', eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
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

async function effectDetail(repo: string, effect: string): Promise<{ state: string; detail: string | null } | null> {
  return env.DB.prepare(
    `SELECT f.state, f.detail FROM push_event_effects f JOIN push_events e ON e.id = f.event_id
      WHERE e.repo_id = ? AND f.effect = ? ORDER BY e.received_at DESC LIMIT 1`,
  )
    .bind(repoIds[repo], effect)
    .first();
}

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('the guard on the default branch', () => {
  it('files a fingerprinted issue per failing finding, counts a repeat and verifies the push that clears it', async () => {
    const r = await seedRepo('guard-direct');
    const ci = (command: string) => `${JSON.stringify({ jobs: { test: { command } } }, null, 2)}\n`;
    const bad = await commit(r.repo, { 'README.md': 'readme\n', '.kvarm/ci.json': ci('npm test; exit 0') }, [r.main], 'weaken CI');
    r.repo.refs.set('refs/heads/main', bad.sha);
    await deliver(pushEvent('guard-direct', 'refs/heads/main', r.main, bad.sha));
    expect(await effectDetail('guard-direct', 'issue-guard')).toEqual({ state: 'done', detail: 'filed 1, counted 0, verified-closed 0' });
    const filed = (await getIssue('guard-direct', 1)).json;
    expect(filed).toMatchObject({
      number: 1,
      title: 'ci-gaming/exit-zero in .kvarm/ci.json',
      state: 'open',
      source: 'guard',
      fingerprint: 'guard:ci-gaming/exit-zero:.kvarm/ci.json',
      paths: ['.kvarm/ci.json'],
      evidence: { sha: bad.sha },
      occurrences: 1,
      author: null,
    });
    expect(filed.body).toContain('a CI command was made to exit 0 unconditionally');
    expect(filed.body).toContain('Filed automatically by the kvarm/guard scan');

    // The rule fires again on the same path: one more occurrence, no second issue.
    const again = await commit(r.repo, { 'README.md': 'readme\n', '.kvarm/ci.json': ci('npm test && npm run lint; exit 0') }, [bad.sha], 'weaken more');
    r.repo.refs.set('refs/heads/main', again.sha);
    await deliver(pushEvent('guard-direct', 'refs/heads/main', bad.sha, again.sha));
    expect(await effectDetail('guard-direct', 'issue-guard')).toEqual({ state: 'done', detail: 'filed 0, counted 1, verified-closed 0' });
    expect((await getIssue('guard-direct', 1)).json).toMatchObject({ state: 'open', occurrences: 2 });

    // The push that repairs the file closes the issue as verified, attributed to itself.
    const fix = await commit(r.repo, { 'README.md': 'readme\n', '.kvarm/ci.json': ci('npm test && npm run lint') }, [again.sha], 'repair CI');
    r.repo.refs.set('refs/heads/main', fix.sha);
    await deliver(pushEvent('guard-direct', 'refs/heads/main', again.sha, fix.sha));
    expect(await effectDetail('guard-direct', 'issue-guard')).toEqual({ state: 'done', detail: 'filed 0, counted 0, verified-closed 1' });
    expect((await getIssue('guard-direct', 1)).json).toMatchObject({
      state: 'closed',
      closedReason: 'verified',
      closedBy: { change: null, commit: fix.sha },
      evidence: { sha: fix.sha },
    });
  });

  it('skips the pushes the platform published and branch creation, and reports a clean scan', async () => {
    const r = await seedRepo('guard-merge');
    await branch(r, 'feature', 'a.txt');
    const n = await openChange('guard-merge', { title: 'add a file', head: 'feature' });
    expect((await merge('guard-merge', n)).status).toBe(200);
    const tip = r.repo.refs.get('refs/heads/main')!;
    await deliver(pushEvent('guard-merge', 'refs/heads/main', r.main, tip));
    expect(await effectDetail('guard-merge', 'issue-guard')).toEqual({ state: 'done', detail: 'published change; kvarm/guard already gated it' });
    expect((await call('GET', api('guard-merge', '/issues'), tok.owner)).json.issues).toEqual([]);

    // A direct push with nothing to find says so.
    const direct = await commit(r.repo, { 'README.md': 'readme\n', 'a.txt': 'a.txt\n', 'notes.md': 'hello\n' }, [tip], 'direct work');
    r.repo.refs.set('refs/heads/main', direct.sha);
    await deliver(pushEvent('guard-merge', 'refs/heads/main', tip, direct.sha));
    expect(await effectDetail('guard-merge', 'issue-guard')).toEqual({ state: 'done', detail: 'no failing guard findings in 1 changed file(s)' });

    // Importing the branch (no previous tip) scans nothing either.
    const fresh = await commit(r.repo, { 'README.md': 'readme\n', 'a.txt': 'a.txt\n', 'notes.md': 'hello\n', 'b.txt': 'b\n' }, [direct.sha], 'import');
    r.repo.refs.set('refs/heads/main', fresh.sha);
    await deliver(pushEvent('guard-merge', 'refs/heads/main', '0'.repeat(40), fresh.sha));
    expect(await effectDetail('guard-merge', 'issue-guard')).toEqual({ state: 'skipped', detail: 'branch created' });
    expect((await call('GET', api('guard-merge', '/issues'), tok.owner)).json.issues).toEqual([]);
  });
});
