/**
 * Issues and their automation (services/issues.ts) through the Worker's
 * routes over the in-memory Artifacts fake: filing with fingerprint
 * deduplication, links read from change text and branch names, workspace
 * issues, closing in the merge record, and the signal statements other
 * services (CI, flakes) embed in their own batches.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFingerprint } from '@kvarm/issues';
import { mintPAT, type Scope } from '../src/auth/pat';
import { issueSignalStatements, resolveSignalStatements } from '../src/services/issues';
import { issueProbe, touchedIssuesBinds, touchedIssuesSql } from '../src/services/intents/issuePaths';
import worker from '../src/index';
import { FakeRepo, commit, fakeArtifacts, installFakeGitRemote, restoreFetch } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, seedRepoWithCommit, seedUser as seedUserBase } from './helpers/seed';

const seedUser = (login: string) => seedUserBase(env, login);
const seedRepo = async (name: string) => { const { repo, main } = await seedRepoWithCommit(env, name, { owner: OWNER, visibility: 'public', repoIds }); return { repo, main }; };
const call = (method: string, path: string, token?: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'iss-owner';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

const tok = { owner: '', reader: '' };
const repoIds: Record<string, string> = {};

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
    expect(a.json).toMatchObject({ number: 2, fingerprint: 'test:parser  handles tabs', occurrences: 1 });
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

describe('comments', () => {
  const comment = (repo: string, n: number, body: unknown, token = tok.owner) => call('POST', api(repo, `/issues/${n}/comments`), token, { body });

  it('comments on an issue, oldest first, also after it closed', async () => {
    await seedRepo('thread');
    await fileIssue('thread', { title: 'Crash' });
    const first = await comment('thread', 1, 'I see this too `here`.');
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ body: 'I see this too `here`.', author: OWNER, agent: null, id: expect.any(String) });
    await comment('thread', 1, 'Second, with <script>alert(1)</script>');
    const got = await getIssue('thread', 1);
    expect(got.json.comments.map((c: any) => c.body)).toEqual(['I see this too `here`.', 'Second, with <script>alert(1)</script>']);
    expect(got.json.commentsTruncated).toBe(false);
    expect((await call('PATCH', api('thread', '/issues/1'), tok.owner, { state: 'closed' })).status).toBe(200);
    expect((await comment('thread', 1, 'post-mortem')).status).toBe(201);
  });

  it('validates input and needs write access to comment', async () => {
    await seedRepo('thread-validate');
    await fileIssue('thread-validate', { title: 'Bug' });
    expect((await comment('thread-validate', 1, '')).status).toBe(422);
    expect((await comment('thread-validate', 1, '   ')).status).toBe(422);
    expect((await comment('thread-validate', 1, 'a'.repeat(65_537))).status).toBe(422);
    expect((await comment('thread-validate', 99, 'hi')).status).toBe(404);
    expect((await comment('thread-validate', 1, 'hi', tok.reader)).status).toBe(403);
    expect((await comment('thread-validate', 1, 'hi', '')).status).toBe(401);
  });

  it('records agent comments with the agent, and the detail keeps the newest 50', async () => {
    await seedRepo('agentthread');
    const agent = await call('POST', '/api/v1/agents', tok.owner, { name: 'commenter' });
    const minted = await call('POST', `/api/v1/agents/${agent.json.agent.id}/tokens`, tok.owner, {
      repo: `${OWNER}/agentthread`,
      role: 'write',
      refs: ['refs/heads/agents/*'],
    });
    await fileIssue('agentthread', { title: 'Off-by-one' });
    const posted = await comment('agentthread', 1, 'Reproduced in my workspace.', minted.json.token);
    expect(posted.status).toBe(201);
    expect(posted.json).toMatchObject({ body: 'Reproduced in my workspace.', agent: { id: agent.json.agent.id, name: 'commenter' } });

    // 60 more: the detail returns the newest 50, oldest first, and says it is capped.
    const issueId = (await env.DB.prepare('SELECT id FROM issues WHERE repo_id = ? AND number = 1').bind(repoIds['agentthread']).first()) as { id: string };
    const at = Date.now() + 1;
    for (let i = 0; i < 60; i++) {
      await env.DB.prepare('INSERT INTO issue_comments (id, issue_id, user_id, body, agent_meta, created_at) VALUES (?, ?, NULL, ?, NULL, ?)')
        .bind(`cap-${i}`, issueId.id, `comment ${i}`, at + i)
        .run();
    }
    const got = await getIssue('agentthread', 1);
    expect(got.json.comments).toHaveLength(50);
    expect(got.json.commentsTruncated).toBe(true);
    expect(got.json.comments.map((c: any) => c.body)).toEqual(Array.from({ length: 50 }, (_, i) => `comment ${i + 10}`));
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

describe('issue paths', () => {
  it('proposes links to open issues whose paths a new change touches; text links win', async () => {
    const r = await seedRepo('paths');
    await fileIssue('paths', { title: 'auth is slow', paths: ['src/auth/'] });
    await fileIssue('paths', { title: 'pager off by one', paths: ['src/pager.ts'] });
    await fileIssue('paths', { title: 'docs', paths: ['docs/'] });
    await fileIssue('paths', { title: 'old login bug', paths: ['src/auth/login.ts'] });
    await call('PATCH', api('paths', '/issues/4'), tok.owner, { state: 'closed' });
    expect((await getIssue('paths', 1)).json.paths).toEqual(['src/auth/']);

    const c = await commit(r.repo, { 'README.md': 'readme\n', 'src/auth/login.ts': 'x\n', 'src/pager.ts': 'y\n' }, [r.main]);
    r.repo.refs.set('refs/heads/feature', c.sha);
    const n = await openChange('paths', { title: 'Speed up auth', head: 'feature', body: 'Fixes #2' });
    expect((await changeIssues('paths', n)).json.issues.map((i: any) => [i.issue, i.source, i.state, i.willClose])).toEqual([
      [1, 'paths', 'proposed', false],
      [2, 'text', 'confirmed', true],
    ]);
    // A proposal from paths never closes on its own.
    await merge('paths', n);
    expect((await getIssue('paths', 1)).json.state).toBe('open');
    expect((await getIssue('paths', 2)).json.state).toBe('closed');
  });

  it('follows the head: a push replaces unanswered path proposals and keeps answered ones', async () => {
    const r = await seedRepo('paths-push');
    await fileIssue('paths-push', { title: 'pager', paths: ['src/pager.ts'] });
    await fileIssue('paths-push', { title: 'docs', paths: ['docs/'] });
    await fileIssue('paths-push', { title: 'auth', paths: ['src/auth/'] });
    const one = await commit(r.repo, { 'README.md': 'readme\n', 'src/pager.ts': 'p\n', 'src/auth/a.ts': 'a\n' }, [r.main]);
    r.repo.refs.set('refs/heads/feature', one.sha);
    const n = await openChange('paths-push', { title: 'Work', head: 'feature' });
    expect((await changeIssues('paths-push', n)).json.issues.map((i: any) => i.issue)).toEqual([1, 3]);
    // Someone rejects the auth proposal; that answer must survive the recompute.
    await call('POST', api('paths-push', `/changes/${n}/issues`), tok.owner, { issue: 3, state: 'rejected' });

    const two = await commit(r.repo, { 'README.md': 'readme\n', 'docs/guide.md': 'g\n', 'src/auth/a.ts': 'a\n' }, [one.sha]);
    r.repo.refs.set('refs/heads/feature', two.sha);
    await deliver(pushEvent('paths-push', 'refs/heads/feature', one.sha, two.sha));
    expect((await changeIssues('paths-push', n)).json.issues.map((i: any) => [i.issue, i.source, i.state])).toEqual([
      [2, 'paths', 'proposed'],
      [3, 'manual', 'rejected'],
    ]);
  });

  it('reindexes edited paths and matches wide edits by prefix range', async () => {
    const r = await seedRepo('paths-edit');
    await fileIssue('paths-edit', { title: 'x', paths: ['src/a.ts'] });
    await call('PATCH', api('paths-edit', '/issues/1'), tok.owner, { paths: ['lib/deep/thing.ts'] });
    const c = await commit(r.repo, { 'README.md': 'readme\n', 'lib/deep/thing.ts': 'z\n' }, [r.main]);
    r.repo.refs.set('refs/heads/feature', c.sha);
    const n = await openChange('paths-edit', { title: 'Lib work', head: 'feature' });
    expect((await changeIssues('paths-edit', n)).json.issues.map((i: any) => [i.issue, i.source])).toEqual([[1, 'paths']]);

    // A change wide enough to collapse into directory prefixes still finds issues below them.
    const wide = issueProbe(Array.from({ length: 400 }, (_, i) => `lib/deep/gen/f${i}.ts`).concat('lib/deep/thing.ts'));
    expect(wide.prefixes.length).toBeGreaterThan(0);
    const probe = { keys: [], prefixes: ['lib/'] };
    const hit = await env.DB.prepare(`SELECT number FROM issues WHERE id IN (${touchedIssuesSql(1)})`)
      .bind(...touchedIssuesBinds(repoIds['paths-edit']!, probe))
      .all<{ number: number }>();
    expect(hit.results.map((x) => x.number)).toEqual([1]);
    expect(issueProbe(['a/b/c.ts']).keys.sort()).toEqual(['a/', 'a/b/', 'a/b/c.ts']);
  });
});

describe('commits pushed to the default branch', () => {
  it('close the issues their messages close, attributed to the oldest closing commit', async () => {
    const r = await seedRepo('direct');
    for (const title of ['a', 'b', 'c', 'd']) await fileIssue('direct', { title });
    const c1 = await commit(r.repo, { 'README.md': 'one\n' }, [r.main], 'parser: tabs\n\nFixes #1. Refs #3.');
    const c2 = await commit(r.repo, { 'README.md': 'two\n' }, [c1.sha], `again\n\nCloses: #1\nResolves ${OWNER}/direct#2, other/repo#4`);
    r.repo.refs.set('refs/heads/main', c2.sha);
    await deliver(pushEvent('direct', 'refs/heads/main', r.main, c2.sha));
    expect(await effectDetail('direct', 'issue-commits')).toEqual({ state: 'done', detail: `closes #1, ${OWNER}/direct#2, other/repo#4` });
    expect((await getIssue('direct', 1)).json).toMatchObject({ state: 'closed', closedReason: 'completed', closedBy: { change: null, commit: c1.sha } });
    expect((await getIssue('direct', 2)).json).toMatchObject({ state: 'closed', closedBy: { commit: c2.sha } });
    for (const n of [3, 4]) expect((await getIssue('direct', n)).json.state).toBe('open');
  });

  it('read the side branches that merges bring in, down to the merge base and no further', async () => {
    const r = await seedRepo('direct-merge');
    for (const title of ['a', 'b', 'c', 'd', 'e']) await fileIssue('direct-merge', { title });
    // Already on main before the push: its "fixes #3" must not be read again.
    const x = await commit(r.repo, { 'README.md': 'x\n' }, [r.main], 'old work\n\nFixes #3');
    const s1 = await commit(r.repo, { 'README.md': 'x\n', 'a.txt': 'a\n' }, [x.sha], 'side one\n\nFixes #4');
    const s2 = await commit(r.repo, { 'README.md': 'x\n', 'a.txt': 'a\n', 'b.txt': 'b\n' }, [s1.sha], 'side two, closes #5');
    const m1 = await commit(r.repo, { 'README.md': 'y\n' }, [x.sha], 'main line');
    const merge = await commit(r.repo, { 'README.md': 'y\n', 'a.txt': 'a\n', 'b.txt': 'b\n' }, [m1.sha, s2.sha], 'Merge branch side');
    r.repo.refs.set('refs/heads/main', merge.sha);
    await deliver(pushEvent('direct-merge', 'refs/heads/main', x.sha, merge.sha));
    expect(await effectDetail('direct-merge', 'issue-commits')).toEqual({ state: 'done', detail: 'closes #4, #5' });
    expect((await getIssue('direct-merge', 4)).json).toMatchObject({ state: 'closed', closedBy: { commit: s1.sha } });
    expect((await getIssue('direct-merge', 5)).json).toMatchObject({ state: 'closed', closedBy: { commit: s2.sha } });
    expect((await getIssue('direct-merge', 3)).json.state).toBe('open');
  });

  it('skip other branches and branch creation, and report a scan that stopped short', async () => {
    const r = await seedRepo('direct-skip');
    await fileIssue('direct-skip', { title: 'a' });
    const side = await commit(r.repo, { 'README.md': 'x\n' }, [r.main], 'fixes #1');
    r.repo.refs.set('refs/heads/side', side.sha);
    await deliver(pushEvent('direct-skip', 'refs/heads/side', r.main, side.sha));
    expect(await effectDetail('direct-skip', 'issue-commits')).toEqual({ state: 'skipped', detail: 'not the default branch' });
    await deliver(pushEvent('direct-skip', 'refs/heads/main', '0'.repeat(40), side.sha));
    expect(await effectDetail('direct-skip', 'issue-commits')).toEqual({ state: 'skipped', detail: 'branch created' });
    expect((await getIssue('direct-skip', 1)).json.state).toBe('open');

    // A previous tip the bounded log never reaches: what was read still counts, and the detail says so.
    const unrelated = await commit(r.repo, { 'README.md': 'elsewhere\n' });
    await deliver(pushEvent('direct-skip', 'refs/heads/main', unrelated.sha, side.sha));
    expect(await effectDetail('direct-skip', 'issue-commits')).toEqual({ state: 'done', detail: 'closes #1; scanned 2 commits, older ones not read' });
    expect((await getIssue('direct-skip', 1)).json.state).toBe('closed');
  });
});

describe('fix-issue tasks', () => {
  const claim = (repo: string, id: string, body: unknown = { agent: 'fixer' }) => call('POST', api(repo, `/tasks/${id}/claim`), tok.owner, body);
  const complete = (repo: string, id: string, generation: number) => call('POST', api(repo, `/tasks/${id}/complete`), tok.owner, { agent: 'fixer', generation });

  it('dispatches one live task per open issue, with its created event', async () => {
    await seedRepo('dispatch');
    await fileIssue('dispatch', { title: 'Leak in limiter', paths: ['src/limiter/'] });
    const first = await call('POST', api('dispatch', '/issues/1/dispatch'), tok.owner);
    expect(first.status).toBe(201);
    expect(first.json).toMatchObject({ created: true, task: { kind: 'fix-issue', status: 'open', issue: { number: 1, title: 'Leak in limiter' }, change: null } });
    const again = await call('POST', api('dispatch', '/issues/1/dispatch'), tok.owner);
    expect([again.status, again.json.created, again.json.task.id]).toEqual([200, false, first.json.task.id]);
    const listed = await call('GET', api('dispatch', '/tasks?kind=fix-issue'), tok.owner);
    expect(listed.json.tasks.map((t: any) => t.id)).toEqual([first.json.task.id]);
    const events = await env.DB.prepare(`SELECT payload FROM events WHERE type = 'kvarm.task.created' AND json_extract(payload, '$.subject') = ?`)
      .bind(first.json.task.id)
      .all<{ payload: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.payload).data).toMatchObject({ kind: 'fix-issue', issue: 1, repo: `${OWNER}/dispatch`, paths: ['src/limiter/'] });
    expect((await getIssue('dispatch', 1)).json.tasks).toEqual([expect.objectContaining({ id: first.json.task.id, status: 'open', claimedBy: null })]);

    await call('PATCH', api('dispatch', '/issues/1'), tok.owner, { state: 'closed' });
    expect((await getIssue('dispatch', 1)).json.tasks[0].status).toBe('obsolete');
    const closed = await call('POST', api('dispatch', '/issues/1/dispatch'), tok.owner);
    expect([closed.status, closed.json.code]).toEqual([409, 'ISSUE_CLOSED']);
    const late = await claim('dispatch', first.json.task.id);
    expect([late.status, late.json.code]).toEqual([409, 'TASK_OBSOLETE']);
    expect((await call('POST', api('dispatch', '/issues/1/dispatch'), tok.reader)).status).toBe(403);
  });

  it('claim gives a workspace at the default branch that declares the issue paths; completion needs a change; the merge closes the issue', async () => {
    const r = await seedRepo('fixflow');
    await fileIssue('fixflow', { title: 'Leak in limiter', paths: ['src/limiter/'] });
    const task = (await call('POST', api('fixflow', '/issues/1/dispatch'), tok.owner)).json.task;
    const claimed = await claim('fixflow', task.id);
    expect(claimed.status).toBe(200);
    expect(claimed.json.task).toMatchObject({ status: 'claimed', claimedBy: 'fixer', issue: { number: 1 } });
    const ws = claimed.json.workspace;
    expect(ws).toMatchObject({ base: 'main', baseSha: r.main, headSha: r.main, agent: 'fixer' });
    expect(r.repo.refs.get(ws.ref)).toBe(r.main);
    expect((await call('GET', api('fixflow', `/workspaces/${ws.id}/intent`), tok.owner)).json).toMatchObject({ declaredPaths: ['src/limiter/'], index: { declared: 1 } });
    expect((await getIssue('fixflow', 1)).json.links).toEqual([expect.objectContaining({ workspace: ws.id, source: 'workspace', state: 'confirmed' })]);

    const early = await complete('fixflow', task.id, claimed.json.lease.generation);
    expect([early.status, early.json.code]).toEqual([409, 'NO_CHANGE_OPENED']);

    const c = await commit(r.repo, { 'README.md': 'readme\n', 'src/limiter/bucket.ts': 'fixed\n' }, [r.main]);
    r.repo.refs.set(ws.ref, c.sha);
    const opened = await call('POST', api('fixflow', `/workspaces/${ws.id}/change-set`), tok.owner, { title: 'Release the bucket' });
    expect(opened.status).toBe(201);
    const done = await complete('fixflow', task.id, claimed.json.lease.generation);
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ task: { status: 'completed', completedBy: 'fixer', resolutionSha: c.sha }, change: { number: opened.json.number } });
    expect(done.json.headBranch).toBeUndefined();

    expect((await merge('fixflow', opened.json.number)).status).toBe(200);
    expect((await getIssue('fixflow', 1)).json).toMatchObject({ state: 'closed', closedBy: { change: opened.json.number } });
    expect((await call('GET', api('fixflow', `/tasks/${task.id}`), tok.owner)).json.status).toBe('completed');
  });

  it('a claimed task whose change merges without an explicit completion completes with the merge', async () => {
    const r = await seedRepo('fixmerge');
    await fileIssue('fixmerge', { title: 'x' });
    const task = (await call('POST', api('fixmerge', '/issues/1/dispatch'), tok.owner)).json.task;
    const ws = (await claim('fixmerge', task.id)).json.workspace;
    const c = await commit(r.repo, { 'README.md': 'readme\n', 'x.txt': 'x\n' }, [r.main]);
    r.repo.refs.set(ws.ref, c.sha);
    const opened = await call('POST', api('fixmerge', `/workspaces/${ws.id}/change-set`), tok.owner, { title: 'x' });
    await merge('fixmerge', opened.json.number);
    expect((await call('GET', api('fixmerge', `/tasks/${task.id}`), tok.owner)).json).toMatchObject({ status: 'completed', completedBy: 'fixer' });
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

    await db.batch(resolveSignalStatements(db, repoId, fp, { commit: 'e'.repeat(40) }, Date.now()));
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
