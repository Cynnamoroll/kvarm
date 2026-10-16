import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  benchmarkConfig,
  benchResources,
  emptyBenchBucket,
  runBenchStack,
  subscribeBenchRepo,
  unsubscribeBenchRepo,
} from '../lib/bench-stack.mjs';
import { parseJsonc } from '../lib/wrangler-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BASE = parseJsonc(readFileSync(`${ROOT}apps/platform/wrangler.jsonc`, 'utf8')) as Record<string, any>;
const ID = 'smoke1';
const RES = benchResources(ID);
const DATABASE_ID = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

function fakeWrangler(initial: {
  d1?: Array<{ name: string; uuid: string }>;
  buckets?: string[];
  queues?: string[];
  repos?: Array<{ name: string }>;
  subscriptions?: Array<{ id: string; name: string; source: Record<string, string>; events: string[] }>;
} = {}) {
  const state = {
    d1: initial.d1 ?? [],
    buckets: initial.buckets ?? [],
    queues: initial.queues ?? [],
    repos: initial.repos ?? [],
    subscriptions: initial.subscriptions ?? [],
  };
  const calls: string[][] = [];
  const wrangler = async (args: string[]) => {
    calls.push(args);
    const command = args.join(' ');
    if (command === 'd1 list --json') return { code: 0, stdout: JSON.stringify(state.d1), stderr: '' };
    if (command === 'r2 bucket list') return { code: 0, stdout: state.buckets.map((name) => `name: ${name}\n`).join(''), stderr: '' };
    if (command === 'queues list') return { code: 0, stdout: state.queues.map((name) => `│ ${'0'.repeat(32)} │ ${name} │ x │\n`).join(''), stderr: '' };
    if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'list') {
      return { code: 0, stdout: JSON.stringify(state.subscriptions), stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'list') {
      return { code: 0, stdout: JSON.stringify(state.repos), stderr: '' };
    }
    if (args[0] === 'd1' && args[1] === 'create') {
      state.d1.push({ name: args[2]!, uuid: DATABASE_ID });
      return { code: 0, stdout: JSON.stringify({ database_id: DATABASE_ID }), stderr: '' };
    }
    if (args[0] === 'd1' && args[1] === 'delete') {
      state.d1 = state.d1.filter((db) => db.name !== args[2]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'create') {
      state.buckets.push(args[3]!);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'delete') {
      state.buckets = state.buckets.filter((name) => name !== args[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'queues' && args[1] === 'create') {
      state.queues.push(args[2]!);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'queues' && args[1] === 'delete') {
      state.queues = state.queues.filter((name) => name !== args[2]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'create') {
      state.repos.push({ name: args[3]! });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'delete') {
      state.repos = state.repos.filter((repo) => repo.name !== args[3]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create') {
      state.subscriptions.push({
        id: 'subscription-1',
        name: args[args.indexOf('--name') + 1]!,
        source: {
          type: args[args.indexOf('--source') + 1]!,
          namespace: args[args.indexOf('--source-namespace') + 1]!,
          repo_name: args[args.indexOf('--source-repo-name') + 1]!,
        },
        events: ['pushed'],
      });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'delete') {
      state.subscriptions = state.subscriptions.filter((s) => s.id !== args[args.indexOf('--id') + 1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply' || args[0] === 'deploy' || args[0] === 'delete') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected fake Wrangler command: ${command}` };
  };
  return { state, calls, wrangler };
}

describe('throwaway benchmark stack', () => {
  it('isolates worker resources and keeps cron triggers while omitting optional container paths', () => {
    const config = benchmarkConfig(BASE, RES, DATABASE_ID);
    expect(config.name).toBe(RES.worker);
    expect(config.d1_databases[0]).toMatchObject({ database_name: RES.d1, database_id: DATABASE_ID });
    expect(config.r2_buckets[0].bucket_name).toBe(RES.bucket);
    expect(config.queues.producers[0].queue).toBe(RES.queue);
    expect(config.queues.consumers[0]).toMatchObject({ queue: RES.queue, dead_letter_queue: RES.deadLetterQueue });
    expect(config.artifacts[0].namespace).toBe(RES.namespace);
    expect(config.workflows.every((workflow: { name: string }) => workflow.name.startsWith(`${RES.prefix}-`))).toBe(true);
    expect(config.triggers.crons).toEqual(BASE.triggers.crons);
    expect(config.containers).toBeUndefined();
    expect(config.durable_objects.bindings.some((binding: { name: string }) => ['CI_SANDBOX', 'ENV_BUILDER', 'AGENT_SANDBOX'].includes(binding.name))).toBe(false);
  });

  it('up creates isolated resources and deploys a generated config without an account-level subscription', async () => {
    const fake = fakeWrangler();
    const written: Record<string, any>[] = [];
    const result = await runBenchStack({
      action: 'up',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: async (config) => { written.push(config); },
    });
    expect(result.databaseId).toBe(DATABASE_ID);
    expect(written[0]?.name).toBe(RES.worker);
    expect(fake.state.d1.map((row) => row.name)).toEqual([RES.d1]);
    expect(fake.state.buckets).toEqual([RES.bucket]);
    expect(fake.state.queues).toEqual([RES.queue, RES.deadLetterQueue]);
    expect(fake.state.repos).toEqual([{ name: RES.seedRepo }]);
    expect(fake.calls.some((args) => args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create')).toBe(false);
    const mutations = fake.calls.filter((args) => ['create', 'delete', 'deploy'].includes(String(args[1] ?? args[0])));
    for (const args of mutations) {
      if (args[0] === 'd1' && args[1] === 'create') expect(String(args[2])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'r2') expect(String(args[3])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'queues' && args[1] === 'create') expect(String(args[2])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'artifacts') expect(String(args[3])).toMatch(new RegExp(`^${RES.prefix}-`));
    }
  });

  it('creates and removes a per-repo artifacts.repo subscription, then down removes leftovers', async () => {
    const scratchRepo = `${RES.prefix}-storm-123`;
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }, { name: scratchRepo }, { name: 'unrelated-repo' }],
    });
    const created = await subscribeBenchRepo(RES, scratchRepo, fake.wrangler);
    expect(created.created).toBe(true);
    const create = fake.calls.find((args) => args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create')!;
    expect(create).toContain('artifacts.repo');
    expect(create[create.indexOf('--source-namespace') + 1]).toBe(RES.namespace);
    expect(create[create.indexOf('--source-repo-name') + 1]).toBe(scratchRepo);
    expect((await unsubscribeBenchRepo(RES, scratchRepo, fake.wrangler)).deleted).toBe(true);
    fake.state.subscriptions.push({
      id: 'leftover',
      name: `${RES.prefix}-leftover`,
      source: { type: 'artifacts.repo', namespace: RES.namespace, repo_name: scratchRepo },
      events: ['pushed'],
    });
    const status = await runBenchStack({ action: 'status', id: ID, baseConfig: BASE, wrangler: fake.wrangler });
    expect(status.subscriptions).toHaveLength(1);
    let removedConfig = false;
    await runBenchStack({
      action: 'down',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      accountId: 'a'.repeat(32),
      apiToken: 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ success: true, result: [], result_info: { is_truncated: false } })),
      removeConfig: async () => { removedConfig = true; },
    });
    expect(removedConfig).toBe(true);
    expect(fake.state.subscriptions).toEqual([]);
    expect(fake.state.repos).toEqual([{ name: 'unrelated-repo' }]);
    expect(fake.state.queues).toEqual([]);
    expect(fake.state.buckets).toEqual([]);
    expect(fake.state.d1).toEqual([]);
  });

  it('paginates R2 listings, encodes keys, and treats delete 404s as gone', async () => {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, auth: new Headers(init?.headers).get('Authorization') ?? '' });
      if (method === 'DELETE') return new Response(null, { status: url.endsWith('/gone') ? 404 : 204 });
      const cursor = new URL(url).searchParams.get('cursor');
      const body = cursor === null
        ? { result: [{ key: 'nested/one' }], result_info: { is_truncated: true, cursor: 'two' } }
        : cursor === 'two'
          ? { result: [{ key: 'gone' }], result_info: { is_truncated: true, cursor: 'three' } }
          : { result: [{ key: 'last' }], result_info: { is_truncated: false } };
      return new Response(JSON.stringify({ success: true, ...body }));
    };
    const result = await emptyBenchBucket({
      id: ID,
      bucketName: RES.bucket,
      accountId: 'a'.repeat(32),
      apiToken: 'test-token',
      fetchImpl,
    });
    const listings = calls.filter((call) => call.method === 'GET');
    const deletes = calls.filter((call) => call.method === 'DELETE');
    expect(listings).toHaveLength(3);
    expect(listings.map(({ url }) => new URL(url).searchParams.get('cursor'))).toEqual([null, 'two', 'three']);
    expect(listings.every(({ url }) => new URL(url).searchParams.get('per_page') === '1000')).toBe(true);
    expect(deletes).toHaveLength(3);
    expect(deletes[0]?.url).toContain('nested%2Fone');
    expect(calls.every((call) => call.auth === 'Bearer test-token')).toBe(true);
    expect(result.deleted).toBe(3);
  });

  it('rejects a non-benchmark bucket without making a request', async () => {
    let requests = 0;
    await expect(emptyBenchBucket({
      id: ID,
      bucketName: 'production-snapshots',
      accountId: 'a'.repeat(32),
      apiToken: 'test-token',
      fetchImpl: async () => {
        requests++;
        return new Response('{}');
      },
    })).rejects.toThrow(/non-benchmark bucket/);
    expect(requests).toBe(0);
  });
});
