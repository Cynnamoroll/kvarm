/**
 * Issues and their automation (services/issues.ts) through the Worker's
 * routes over the in-memory Artifacts fake: filing with fingerprint
 * deduplication, links read from change text and branch names, workspace
 * issues, closing in the merge record, and the signal statements other
 * services (CI, flakes) embed in their own batches.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFingerprint } from '@kvarm/issues';
import { mintPAT, type Scope } from '../src/auth/pat';
import { COST_HEADER, parseCostHeader, type CostCounters } from '../src/cost/meter';
import { issueSignalStatements, resolveSignalStatement } from '../src/services/issues';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, fakeRepos, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const ORIGIN = 'https://kvarm.test';
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'iss-owner';

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

const tok = { owner: '', reader: '' };
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
const fileIssue = (repo: string, body: unknown, token = tok.owner) => call('POST', api(repo, '/issues'), token, body);
const getIssue = (repo: string, n: number) => call('GET', api(repo, `/issues/${n}`), tok.owner);
const changeIssues = (repo: string, n: number) => call('GET', api(repo, `/changes/${n}/issues`), tok.owner);
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

beforeAll(async () => {
  installFakeGitRemote();
  tok.owner = (await mintPAT(env, await seedUser(OWNER), 'owner', FULL)).token;
  tok.reader = (await mintPAT(env, await seedUser('iss-reader'), 'reader', FULL)).token;
});

afterAll(() => restoreFetch());

// ---------------------------------------------------------------------------

describe('filing', () => {
  it('files numbered issues and counts a repeated fingerprint on the open issue', async () => {
    await seedRepo('file');
    const first = await fileIssue('file', { title: 'Login crashes', body: 'Stack trace…', paths: ['src/auth/login.ts'] });
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ number: 1, state: 'open', source: 'human', author: OWNER, occurrences: 1, created: true, paths: ['src/auth/login.ts'] });

    const report = { title: 'TypeError in parser', fingerprint: '  Test:Parser  Handles Tabs ', evidence: { sha: 'a'.repeat(40), check: 'test' } };
    const a = await fileIssue('file', report);
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ number: 2, fingerprint: 'test:parser handles tabs', occurrences: 1 });
    const b = await fileIssue('file', { ...report, title: 'Same bug, other words', evidence: { sha: 'b'.repeat(40) } });
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ number: 2, title: 'TypeError in parser', occurrences: 2, created: false, evidence: { sha: 'b'.repeat(40) } });

    const list = await call('GET', api('file', '/issues'), tok.owner);
    expect(list.json.issues.map((i: { number: number }) => i.number)).toEqual([2, 1]);
    expect(list.cost.d1).toBeLessThanOrEqual(2);
    const page = await call('GET', api('file', '/issues?limit=1'), tok.owner);
    expect(page.json.nextCursor).toBe('2');
    const next = await call('GET', api('file', `/issues?limit=1&cursor=${page.json.nextCursor}`), tok.owner);
    expect(next.json.issues.map((i: { number: number }) => i.number)).toEqual([1]);
    expect(next.json.nextCursor).toBeNull();
  });

  it('validates input and needs write access to file', async () => {
    await seedRepo('validate');
    const cases: Array<[unknown, number, string]> = [
      [{}, 422, 'INVALID_TITLE'],
      [{ title: 'x', paths: ['../etc'] }, 422, 'INVALID_PATH'],
      [{ title: 'x', fingerprint: '   ' }, 422, 'INVALID_FINGERPRINT'],
      [{ title: 'x', evidence: { sha: 'abc' } }, 422, 'INVALID_EVIDENCE'],
      [{ title: 'x', evidence: { url: 'javascript:alert(1)' } }, 422, 'INVALID_EVIDENCE'],
      [[1], 400, 'INVALID_BODY'],
    ];
    for (const [body, status, code] of cases) {
      const r = await fileIssue('validate', body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([status, code]);
    }
    expect((await fileIssue('validate', { title: 'x' }, tok.reader)).status).toBe(403);
    expect((await fileIssue('validate', { title: 'x' }, '')).status).toBe(401);
    expect((await call('GET', api('validate', '/issues?state=nope'), tok.owner)).json.code).toBe('INVALID_STATE');
  });

  it('records agent filings as source agent with the agent', async () => {
    await seedRepo('agentfile');
    const agent = await call('POST', '/api/v1/agents', tok.owner, { name: 'bug-hunter' });
    const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
      repo: `${OWNER}/agentfile`,
      role: 'write',
      refs: ['refs/heads/agents/*'],
    });
    const r = await fileIssue('agentfile', { title: 'Off-by-one in pager, found while fixing auth', paths: ['src/pager.ts'] }, minted.json.token);
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ source: 'agent', agent: { id: agent.json.agent.id, name: 'bug-hunter' } });
    const listed = await call('GET', api('agentfile', '/issues?source=agent'), tok.owner);
    expect(listed.json.issues).toHaveLength(1);
  });

  it('closes with a reason, reopens, and refuses to reopen onto an open fingerprint', async () => {
    await seedRepo('lifecycle');
    await fileIssue('lifecycle', { title: 'Flaky', fingerprint: 'fp' });
    const closed = await call('PATCH', api('lifecycle', '/issues/1'), tok.owner, { state: 'closed', closedReason: 'not_planned' });
    expect(closed.json).toMatchObject({ state: 'closed', closedReason: 'not_planned' });
    expect(closed.json.closedAt).toEqual(expect.any(String));
    // A recurrence after the close files a new issue.
    expect((await fileIssue('lifecycle', { title: 'Flaky again', fingerprint: 'fp' })).json).toMatchObject({ number: 2, created: true });
    const reopen = await call('PATCH', api('lifecycle', '/issues/1'), tok.owner, { state: 'open' });
    expect([reopen.status, reopen.json.code]).toEqual([409, 'FINGERPRINT_OPEN']);
    await call('PATCH', api('lifecycle', '/issues/2'), tok.owner, { state: 'closed', closedReason: 'duplicate' });
    const ok = await call('PATCH', api('lifecycle', '/issues/1'), tok.owner, { state: 'open', title: 'Flaky (reopened)' });
    expect(ok.json).toMatchObject({ state: 'open', title: 'Flaky (reopened)', closedReason: null, closedAt: null });
    const bad = await call('PATCH', api('lifecycle', '/issues/1'), tok.owner, { closedReason: 'completed' });
    expect(bad.json.code).toBe('INVALID_CLOSED_REASON');
    expect((await getIssue('lifecycle', 99)).status).toBe(404);
  });
});

describe('changes close their issues', () => {
  it('closes the issues a change names with closing keywords when it merges into the default branch', async () => {
    const r = await seedRepo('keywords');
    for (const title of ['one', 'two', 'three', 'four']) await fileIssue('keywords', { title });
    const head = await branch(r, 'feature', 'a.txt');
    const n = await openChange('keywords', {
      title: 'Parser fixes',
      head: 'feature',
      body: 'Fixes #1 and #2.\nRelated to #3; does not fix #4.\n```\ncloses #4\n```\nAlso fixes #99 and other/repo#3.',
    });
    const linked = await changeIssues('keywords', n);
    expect(linked.status).toBe(200);
    expect(linked.json.issues.map((i: any) => [i.issue, i.kind, i.source, i.state, i.willClose])).toEqual([
      [1, 'closes', 'text', 'confirmed', true],
      [2, 'closes', 'text', 'confirmed', true],
      [3, 'refs', 'text', 'confirmed', false],
      [4, 'refs', 'text', 'confirmed', false],
    ]);

    const merged = await merge('keywords', n);
    expect(merged.status).toBe(200);
    for (const number of [1, 2]) {
      const got = (await getIssue('keywords', number)).json;
      expect(got).toMatchObject({ state: 'closed', closedReason: 'completed', closedBy: { change: n, commit: head } });
      expect(got.links).toEqual([expect.objectContaining({ change: n, kind: 'closes', source: 'text', state: 'confirmed' })]);
    }
    for (const number of [3, 4]) expect((await getIssue('keywords', number)).json.state).toBe('open');
  });

  it('keeps links into another base inert', async () => {
    const r = await seedRepo('otherbase');
    await fileIssue('otherbase', { title: 'bug' });
    r.repo.refs.set('refs/heads/release', r.main);
    await branch(r, 'hotfix', 'h.txt');
    const n = await openChange('otherbase', { title: 'Fixes #1', head: 'hotfix', base: 'release' });
    expect((await changeIssues('otherbase', n)).json.issues[0]).toMatchObject({ issue: 1, kind: 'closes', willClose: false });
    expect((await merge('otherbase', n)).status).toBe(200);
    expect((await getIssue('otherbase', 1)).json.state).toBe('open');
  });

  it('recomputes text links when the title or body changes', async () => {
    const r = await seedRepo('edit');
    await fileIssue('edit', { title: 'a' });
    await fileIssue('edit', { title: 'b' });
    await branch(r, 'feature', 'e.txt');
    const n = await openChange('edit', { title: 'Work', head: 'feature', body: 'Closes #1' });
    expect((await changeIssues('edit', n)).json.issues.map((i: any) => i.issue)).toEqual([1]);
    await call('PATCH', api('edit', `/changes/${n}`), tok.owner, { body: 'Resolves #2' });
    expect((await changeIssues('edit', n)).json.issues.map((i: any) => [i.issue, i.willClose])).toEqual([[2, true]]);
    await merge('edit', n);
    expect((await getIssue('edit', 1)).json.state).toBe('open');
    expect((await getIssue('edit', 2)).json.state).toBe('closed');
  });

  it('proposes the issue in a branch name and closes it only once confirmed', async () => {
    const r = await seedRepo('branchname');
    await fileIssue('branchname', { title: 'a' });
    await fileIssue('branchname', { title: 'b' });
    await branch(r, 'fix/2-crash', 'f.txt');
    const n = await openChange('branchname', { title: 'Crash fix', head: 'fix/2-crash' });
    expect((await changeIssues('branchname', n)).json.issues).toEqual([
      expect.objectContaining({ issue: 2, kind: 'closes', source: 'branch', state: 'proposed', willClose: false }),
    ]);
    // A text edit keeps the proposal; a manual confirmation survives later edits.
    const confirmed = await call('POST', api('branchname', `/changes/${n}/issues`), tok.owner, { issue: 2 });
    expect(confirmed.json.issues).toEqual([expect.objectContaining({ issue: 2, source: 'manual', state: 'confirmed', actor: OWNER, willClose: true })]);
    await call('PATCH', api('branchname', `/changes/${n}`), tok.owner, { title: 'Crash fix, take two' });
    expect((await changeIssues('branchname', n)).json.issues[0]).toMatchObject({ issue: 2, source: 'manual', willClose: true });

    const bad = await call('POST', api('branchname', `/changes/${n}/issues`), tok.owner, { issue: 77 });
    expect([bad.status, bad.json.code]).toEqual([404, 'ISSUE_NOT_FOUND']);
    expect((await call('POST', api('branchname', `/changes/${n}/issues`), tok.reader, { issue: 1 })).status).toBe(403);

    await merge('branchname', n);
    expect((await getIssue('branchname', 2)).json).toMatchObject({ state: 'closed', closedBy: { change: n } });
    const late = await call('POST', api('branchname', `/changes/${n}/issues`), tok.owner, { issue: 1 });
    expect([late.status, late.json.code]).toEqual([409, 'CHANGE_MERGED']);
  });

  it('never closes an issue whose proposed link was rejected, even if the text later only mentions it', async () => {
    const r = await seedRepo('rejected');
    await fileIssue('rejected', { title: 'a' });
    await branch(r, '1-wip', 'w.txt');
    const n = await openChange('rejected', { title: 'WIP', head: '1-wip' });
    const rej = await call('POST', api('rejected', `/changes/${n}/issues`), tok.owner, { issue: 1, state: 'rejected' });
    expect(rej.json.issues[0]).toMatchObject({ issue: 1, state: 'rejected', willClose: false });
    await call('PATCH', api('rejected', `/changes/${n}`), tok.owner, { body: 'touches #1' });
    expect((await changeIssues('rejected', n)).json.issues[0]).toMatchObject({ source: 'manual', state: 'rejected' });
    await merge('rejected', n);
    expect((await getIssue('rejected', 1)).json.state).toBe('open');
  });

  it('closes the issue a workspace was created for when the change it opens merges', async () => {
    const r = await seedRepo('wsissue');
    await fileIssue('wsissue', { title: 'Rate limiter leaks' });
    const missing = await call('POST', api('wsissue', '/workspaces'), tok.owner, { task: 'x', agent: 'a', issue: 5 });
    expect([missing.status, missing.json.code]).toEqual([422, 'ISSUE_NOT_OPEN']);
    expect(r.repo.count('receivePack:')).toBe(0);

    const ws = (await call('POST', api('wsissue', '/workspaces'), tok.owner, { task: 'Fix the leak', agent: 'a', issue: 1 })).json;
    const c = await commit(r.repo, { 'README.md': 'readme\n', 'limiter.ts': 'fixed\n' }, [r.main]);
    r.repo.refs.set(ws.ref, c.sha);
    // The change text never mentions the issue: the workspace carries the link.
    const opened = await call('POST', api('wsissue', `/workspaces/${ws.id}/change-set`), tok.owner, { title: 'Release the bucket' });
    expect(opened.status).toBe(201);
    expect((await changeIssues('wsissue', opened.json.number)).json.issues).toEqual([
      expect.objectContaining({ issue: 1, change: opened.json.number, workspace: ws.id, source: 'workspace', willClose: true }),
    ]);
    expect((await merge('wsissue', opened.json.number)).status).toBe(200);
    expect((await getIssue('wsissue', 1)).json).toMatchObject({ state: 'closed', closedBy: { change: opened.json.number, commit: c.sha } });
  });
});

describe('signals', () => {
  it('files one issue per open check fingerprint and closes it as verified when the check passes again', async () => {
    await seedRepo('signals');
    const repoId = repoIds.signals!;
    const db = env.DB;
    const fp = checkFingerprint('test');
    const signal = { source: 'flake' as const, fingerprint: fp, title: 'test is flaky', evidence: { check: 'test', sha: 'c'.repeat(40) } };
    await db.batch(issueSignalStatements(db, repoId, signal, Date.now()));
    await db.batch(issueSignalStatements(db, repoId, { ...signal, source: 'ci', evidence: { check: 'test', sha: 'd'.repeat(40) } }, Date.now()));
    const open = (await call('GET', api('signals', '/issues?source=flake'), tok.owner)).json.issues;
    expect(open).toEqual([expect.objectContaining({ number: 1, fingerprint: 'check:test', occurrences: 2, evidence: { check: 'test', sha: 'd'.repeat(40) } })]);

    await db.batch([resolveSignalStatement(db, repoId, fp, { commit: 'e'.repeat(40) }, Date.now())]);
    expect((await getIssue('signals', 1)).json).toMatchObject({ state: 'closed', closedReason: 'verified', closedBy: { change: null, commit: 'e'.repeat(40) } });
    // A later failure is a recurrence: a new issue.
    await db.batch(issueSignalStatements(db, repoId, signal, Date.now()));
    expect((await getIssue('signals', 2)).json).toMatchObject({ state: 'open', source: 'flake', occurrences: 1 });
  });
});

describe('repository deletion', () => {
  it('removes issues and links with the repository', async () => {
    const r = await seedRepo('gone');
    await fileIssue('gone', { title: 'x' });
    await branch(r, 'feature', 'g.txt');
    await openChange('gone', { title: 'Fixes #1', head: 'feature' });
    const del = await call('DELETE', `/api/v1/repos/${OWNER}/gone`, tok.owner);
    expect(del.status).toBe(200);
    const left = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM issues WHERE repo_id = ?1) + (SELECT COUNT(*) FROM issue_links WHERE repo_id = ?1) AS n')
      .bind(repoIds.gone)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
