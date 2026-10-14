/**
 * Outbound webhooks and the integration train (services/queue.ts,
 * migration 0033): merges and ejections of a train run are recorded for
 * delivery inside the train's own writes, the train never calls an
 * endpoint, and a failing endpoint changes nothing about later runs.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintPAT, type Scope } from '../src/auth/pat';
import type { ChecksGate, CheckState } from '../src/services/checksGate';
import { defaultTrainDeps, runTrain, type TrainDeps } from '../src/services/queue';
import { deliverWebhook } from '../src/services/webhooks';
import { commit, fakeArtifacts, installFakeGitRemote, restoreFetch, writeTree } from './helpers/fakeArtifacts';
import { call as apiCall } from './helpers/http';
import { FakeWorkflow, recordingEvents, seedRepo as seedRepoBase, seedUser as seedUserBase } from './helpers/seed';

const fakeEvents = recordingEvents();
const seedUser = (login: string) => seedUserBase(env, login);
const seedRepo = async (name: string) => { const { id, repo } = await seedRepoBase(env, name, { owner: OWNER, visibility: 'private' }); return { repo, id }; };
const call = (method: string, path: string, body?: unknown) => apiCall(env, method, path, { token, body });

const baseEnv = cfEnv as unknown as Env;
const FULL: Scope[] = ['read', 'write', 'api'];
const OWNER = 'whq-owner';
const MAIN = 'refs/heads/main';
const HOOK_URL = 'https://hooks.example.com/train';

const env = {
  ...baseEnv,
  ARTIFACTS: fakeArtifacts,
  EVENTS: fakeEvents as unknown as Env['EVENTS'],
  SNAPSHOT_BUILDER: new FakeWorkflow() as unknown as Env['SNAPSHOT_BUILDER'],
} as Env;

let token = '';
const hookCalls: string[] = [];

function gateFailing(trees: Set<string>): ChecksGate {
  return {
    async requiredChecksFor(_repo, treeSha, configId) {
      const state: CheckState = trees.has(treeSha) ? 'failure' : 'success';
      return { treeSha, configId, required: [{ name: 'ci/test', state, producer: 'test' }], state };
    },
  };
}

function deps(gate: ChecksGate): TrainDeps {
  return { ...defaultTrainDeps, gate: () => gate, kick: async () => undefined, observe: () => undefined };
}

beforeAll(async () => {
  installFakeGitRemote();
  // Any request to the hook endpoint is recorded and fails; the fake git remote serves everything else.
  const git = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://hooks.example.com')) {
      hookCalls.push(url);
      return new Response('down', { status: 500 });
    }
    return git(input, init);
  }) as typeof fetch;
  const userId = await seedUser(OWNER);
  token = (await mintPAT(env, userId, 'owner', FULL)).token;
});

afterAll(() => restoreFetch());

describe('webhooks and the merge queue', () => {
  it('records merges and ejections of a train run without calling the endpoint, and a failing endpoint never blocks the next run', async () => {
    const { repo, id: repoId } = await seedRepo('train');
    const main = await commit(repo, { 'README.md': 'readme\n' });
    repo.refs.set(MAIN, main.sha);
    const numbers: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const b = await commit(repo, { 'README.md': 'readme\n', [`f${i}.txt`]: `file ${i}\n` }, [main.sha]);
      repo.refs.set(`refs/heads/b${i}`, b.sha);
      const r = await call('POST', `/api/v1/repos/${OWNER}/train/changes`, { title: `Change ${i}`, base: 'main', head: `b${i}` });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      numbers.push(r.json.number as number);
    }
    const [one, two, three] = numbers as [number, number, number];
    const hook = await call('POST', `/api/v1/repos/${OWNER}/train/webhooks`, { url: HOOK_URL, events: ['kvarm.change.merged', 'kvarm.change.ejected'] });
    expect(hook.status, JSON.stringify(hook.json)).toBe(201);
    const hookId = hook.json.webhook.id as string;

    expect((await call('POST', `/api/v1/repos/${OWNER}/train/changes/${one}/enqueue`)).status).toBe(201);
    expect((await call('POST', `/api/v1/repos/${OWNER}/train/changes/${two}/enqueue`)).status).toBe(201);
    const failing = new Set([await writeTree(repo, { 'README.md': 'readme\n', 'f1.txt': 'file 1\n' })]);
    const run = await runTrain(env, repoId, MAIN, deps(gateFailing(failing)));
    expect(run.ejected).toEqual([{ number: one, code: 'CHECKS_FAILED' }]);
    expect(run.published).toEqual([two]);
    expect(hookCalls).toEqual([]);

    const rows = async () =>
      (
        await env.DB.prepare(
          `SELECT d.id, d.event_type, d.state, e.payload FROM webhook_deliveries d JOIN events e ON e.id = d.event_id
            WHERE d.webhook_id = ? ORDER BY d.created_at, d.id`,
        )
          .bind(hookId)
          .all<{ id: string; event_type: string; state: string; payload: string }>()
      ).results ?? [];
    const recorded = await rows();
    expect(recorded.map((r) => [r.event_type, JSON.parse(r.payload).data.change]).sort()).toEqual([
      ['kvarm.change.ejected', one],
      ['kvarm.change.merged', two],
    ]);
    const merged = JSON.parse(recorded.find((r) => r.event_type === 'kvarm.change.merged')!.payload).data;
    expect(merged.mergeCommit).toBe(repo.refs.get(MAIN));

    // The endpoint fails every attempt; the train's next run is unaffected.
    for (const r of recorded) {
      expect((await deliverWebhook(env, r.id)).outcome).toBe('retry');
    }
    expect(hookCalls).toHaveLength(2);
    expect((await call('POST', `/api/v1/repos/${OWNER}/train/changes/${three}/enqueue`)).status).toBe(201);
    const later = await runTrain(env, repoId, MAIN, deps(gateFailing(failing)));
    expect(later.published).toEqual([three]);
    expect(hookCalls).toHaveLength(2);
    expect((await rows()).map((r) => r.event_type).filter((t) => t === 'kvarm.change.merged')).toHaveLength(2);
  });
});
