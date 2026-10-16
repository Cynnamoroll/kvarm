import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertArtifactsNamespace,
  benchmarkConfig,
  benchResources,
  emptyBenchBucket,
  patKeys,
  runBenchStack,
  subscribeBenchRepo,
  unsubscribeBenchRepo,
  withBenchUser,
  withPatList,
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
  repos?: Array<{ name: string; namespace?: string }>;
  subscriptions?: Array<{ id: string; name: string; source: Record<string, string>; events: string[] }>;
  preserveDeletedRepos?: boolean;
} = {}) {
  const state = {
    d1: initial.d1 ?? [],
    buckets: initial.buckets ?? [],
    queues: initial.queues ?? [],
    repos: initial.repos ?? [],
    subscriptions: initial.subscriptions ?? [],
    secrets: new Map<string, string>(),
    worker: false,
    preserveDeletedRepos: initial.preserveDeletedRepos ?? false,
  };
  const calls: string[][] = [];
  const wrangler = async (args: string[], options: { input?: string } = {}) => {
    calls.push(args);
    const command = args.join(' ');
    if (command === 'd1 list --json') return { code: 0, stdout: JSON.stringify(state.d1), stderr: '' };
    if (command === 'r2 bucket list') return { code: 0, stdout: state.buckets.map((name) => `name: ${name}\n`).join(''), stderr: '' };
    if (command === 'queues list') return { code: 0, stdout: state.queues.map((name) => `│ ${'0'.repeat(32)} │ ${name} │ x │\n`).join(''), stderr: '' };
    if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'list') {
      return { code: 0, stdout: JSON.stringify(state.subscriptions), stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'list') {
      const namespace = args[args.indexOf('--namespace') + 1];
      return {
        code: 0,
        stdout: JSON.stringify(state.repos.filter((repo) => (repo.namespace ?? RES.namespace) === namespace)),
        stderr: '',
      };
    }
    if (args[0] === 'deployments' && args[1] === 'list') {
      return { code: 0, stdout: JSON.stringify(state.worker ? [{ id: 'deployment' }] : []), stderr: '' };
    }
    if (args[0] === 'secret' && args[1] === 'put') {
      state.secrets.set(args[2]!, options.input ?? '');
      return { code: 0, stdout: '', stderr: '' };
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
      state.repos.push({ name: args[3]!, namespace: args[args.indexOf('--namespace') + 1] });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'delete') {
      const namespace = args[args.indexOf('--namespace') + 1];
      if (!state.preserveDeletedRepos) {
        state.repos = state.repos.filter((repo) => repo.name !== args[3] || (repo.namespace ?? RES.namespace) !== namespace);
      }
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
    if (args[0] === 'deploy' && !args.includes('--dry-run')) state.worker = true;
    if (args[0] === 'delete') state.worker = false;
    if (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply' || args[0] === 'deploy' || args[0] === 'delete') {
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected fake Wrangler command: ${command}` };
  };
  return { state, calls, wrangler };
}

describe('throwaway benchmark stack', () => {
  it('keeps existing PATs and mints only missing credentials on redeploy', async () => {
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }],
    });
    let patText = 'KVARM_PAT=existing-one\nOTHER=value\n';
    const minted: string[] = [];
    const mintPat = async (_databaseId: string, _tokenFile: string, key: string) => {
      minted.push(key);
      patText += `${key}=minted-${minted.length}\n`;
    };
    const options = {
      action: 'up',
      id: ID,
      pats: 3,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat,
      readPatFile: async () => patText,
      writePatFile: async (text: string) => { patText = text; },
    };

    const first = await runBenchStack(options);
    expect(first.pats).toBe(3);
    expect(minted).toEqual(['KVARM_PAT_2', 'KVARM_PAT_3']);
    expect(patText).toContain('KVARM_PAT=existing-one');
    expect(patText).toContain('KVARM_PATS=existing-one,minted-1,minted-2');
    expect(patText.match(/^KVARM_USER=bench-smoke1$/gm) ?? []).toHaveLength(1);

    await runBenchStack(options);
    expect(minted).toEqual(['KVARM_PAT_2', 'KVARM_PAT_3']);
    expect(patText.match(/^KVARM_USER=bench-smoke1$/gm) ?? []).toHaveLength(1);
    expect(patKeys(3)).toEqual(['KVARM_PAT', 'KVARM_PAT_2', 'KVARM_PAT_3']);
    expect(withPatList('KVARM_PAT=one\n', ['KVARM_PAT'])).toContain('KVARM_PATS=one');
    expect(withBenchUser('KVARM_PAT=one\n', 'm8q4')).toBe('KVARM_PAT=one\nKVARM_USER=bench-m8q4\n');
    expect(withBenchUser('KVARM_USER=custom\n', 'm8q4')).toBe('KVARM_USER=custom\n');
  });

  it('rejects an Artifacts namespace other than the exact benchmark namespace', () => {
    expect(() => assertArtifactsNamespace(RES.namespace, RES)).not.toThrow();
    expect(() => assertArtifactsNamespace(`${RES.namespace}-other`, RES)).toThrow(/outside the benchmark namespace/);
  });

  it('rejects a non-benchmark repo before inspecting or mutating anything', async () => {
    let called = false;
    await expect(subscribeBenchRepo(RES, 'kvarm-platform', async () => {
      called = true;
      return { code: 0, stdout: '[]', stderr: '' };
    })).rejects.toThrow(/valid name under/);
    expect(called).toBe(false);
  });

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
    expect(config.vars).toMatchObject({ ARTIFACTS_NAMESPACE: RES.namespace, GIT_MIRROR_MODE: 'shadow', GIT_PACK_CACHE: 'off' });
    const rateLimitIds = config.ratelimits.map((ratelimit: { namespace_id: string | number }) => String(ratelimit.namespace_id));
    expect(rateLimitIds).not.toContain('4601');
    expect(rateLimitIds).not.toContain('4602');
    expect(new Set(rateLimitIds).size).toBe(rateLimitIds.length);
    expect(config.containers).toBeUndefined();
    expect(config.durable_objects.bindings.some((binding: { name: string }) => ['CI_SANDBOX', 'ENV_BUILDER', 'AGENT_SANDBOX'].includes(binding.name))).toBe(false);
  });

  it.each(['off', 'shadow', 'on'] as const)('up deploys an existing stack with mirror mode %s', async (mirrorMode) => {
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }],
    });
    const written: Record<string, any>[] = [];
    await runBenchStack({
      action: 'up',
      id: ID,
      mirrorMode,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: async (config) => { written.push(config); },
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async () => {},
    });
    expect(written[0]?.vars.GIT_MIRROR_MODE).toBe(mirrorMode);
    expect(written[0]?.vars.GIT_PACK_CACHE).toBe('off');
    expect(fake.calls.some((args) => args[0] === 'd1' && args[1] === 'create')).toBe(false);
    expect(fake.calls.some((args) => args[0] === 'r2' && args[2] === 'create')).toBe(false);
    expect(fake.calls.some((args) => args[0] === 'queues' && args[1] === 'create')).toBe(false);
    expect(fake.calls.some((args) => args[0] === 'artifacts' && args[2] === 'create')).toBe(false);
    expect(fake.calls.some((args) => args[0] === 'deploy' && !args.includes('--dry-run'))).toBe(true);
  });

  it('rejects an invalid mirror mode before inspecting resources', async () => {
    let called = false;
    await expect(runBenchStack({
      action: 'up',
      id: ID,
      mirrorMode: 'bogus' as never,
      baseConfig: BASE,
      wrangler: async () => {
        called = true;
        return { code: 0, stdout: '[]', stderr: '' };
      },
    })).rejects.toThrow(/--mirror-mode must be off, shadow, or on/);
    expect(called).toBe(false);
  });

  it.each(['off', 'on'] as const)('up deploys an existing stack with pack cache %s', async (packCache) => {
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }],
    });
    const written: Record<string, any>[] = [];
    await runBenchStack({
      action: 'up',
      id: ID,
      packCache,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: async (config) => { written.push(config); },
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async () => {},
    });
    expect(written[0]?.vars.GIT_PACK_CACHE).toBe(packCache);
  });

  it('rejects an invalid pack-cache mode before inspecting resources', async () => {
    let called = false;
    await expect(runBenchStack({
      action: 'up',
      id: ID,
      packCache: 'bogus' as never,
      baseConfig: BASE,
      wrangler: async () => {
        called = true;
        return { code: 0, stdout: '[]', stderr: '' };
      },
    })).rejects.toThrow(/--pack-cache must be off or on/);
    expect(called).toBe(false);
  });

  it('refuses a deploy config with an invalid pack-cache mode', async () => {
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }],
    });
    await expect(runBenchStack({
      action: 'up',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: async (config) => { config.vars.GIT_PACK_CACHE = 'invalid'; },
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async () => {},
    })).rejects.toThrow(/non-isolated Wrangler config/);
    expect(fake.calls.some((args) => args[0] === 'deploy')).toBe(false);
  });

  it.each(['missing', 'bogus'] as const)('refuses a deploy config with mirror mode %s', async (invalidMode) => {
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [{ name: RES.seedRepo }],
    });
    const tamperConfig = async (config: Record<string, any>) => {
      if (invalidMode === 'missing') delete config.vars.GIT_MIRROR_MODE;
      else config.vars.GIT_MIRROR_MODE = invalidMode;
    };
    await expect(runBenchStack({
      action: 'up',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: tamperConfig,
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async () => {},
    })).rejects.toThrow(/non-isolated Wrangler config/);
    expect(fake.calls.some((args) => args[0] === 'deploy')).toBe(false);
  });

  it('up creates isolated resources, internal secrets, and a bench PAT without an account-level subscription', async () => {
    const fake = fakeWrangler();
    const written: Record<string, any>[] = [];
    const patCalls: Array<{ databaseId: string; tokenFile: string }> = [];
    const result = await runBenchStack({
      action: 'up',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      writeConfig: async (config) => { written.push(config); },
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async (databaseId, tokenFile) => { patCalls.push({ databaseId, tokenFile }); },
    });
    expect(result.databaseId).toBe(DATABASE_ID);
    expect(written[0]?.name).toBe(RES.worker);
    expect(written[0]?.vars.GIT_MIRROR_MODE).toBe('shadow');
    expect(fake.state.d1.map((row) => row.name)).toEqual([RES.d1]);
    expect(fake.state.buckets).toEqual([RES.bucket]);
    expect(fake.state.queues).toEqual([RES.queue, RES.deadLetterQueue]);
    expect(fake.state.repos).toEqual([{ name: RES.seedRepo, namespace: RES.namespace }]);
    expect(fake.calls.some((args) => args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create')).toBe(false);
    expect(fake.state.secrets.get('WORKOS_COOKIE_PASSWORD')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.state.secrets.get('WEBHOOK_SECRET_KEY')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.calls.filter((args) => args[0] === 'secret' && args[1] === 'put')).toHaveLength(2);
    expect(fake.calls.filter((args) => args[0] === 'secret' && args[1] === 'put').every((args) => args.includes('-c') && args.includes(`wrangler.bench-${ID}.json`))).toBe(true);
    expect(patCalls).toEqual([{ databaseId: DATABASE_ID, tokenFile: `/repo/apps/platform/.env.bench-${ID}` }]);
    const dryRunIndex = fake.calls.findIndex((args) => args[0] === 'deploy' && args.includes('--dry-run'));
    const migrationIndex = fake.calls.findIndex((args) => args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply');
    const deployIndex = fake.calls.findIndex((args) => args[0] === 'deploy' && !args.includes('--dry-run'));
    expect(dryRunIndex).toBeGreaterThan(-1);
    expect(dryRunIndex).toBeLessThan(migrationIndex);
    expect(migrationIndex).toBeLessThan(deployIndex);
    expect(JSON.stringify(result)).not.toContain(fake.state.secrets.get('WORKOS_COOKIE_PASSWORD'));
    const mutations = fake.calls.filter((args) => ['create', 'delete', 'deploy'].includes(String(args[1] ?? args[0])));
    for (const args of mutations) {
      if (args[0] === 'd1' && args[1] === 'create') expect(String(args[2])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'r2') expect(String(args[3])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'queues' && args[1] === 'create') expect(String(args[2])).toMatch(new RegExp(`^${RES.prefix}-`));
      if (args[0] === 'artifacts') expect(String(args[3])).toMatch(new RegExp(`^${RES.prefix}-`));
    }
  });

  it('resolves a created D1 id from the resource list when Wrangler omits it from create output', async () => {
    const fake = fakeWrangler();
    const written: Record<string, any>[] = [];
    const wrangler = async (args: string[], options?: { input?: string }) => {
      const result = await fake.wrangler(args, options);
      return args[0] === 'd1' && args[1] === 'create'
        ? { ...result, stdout: 'Created database' }
        : result;
    };
    await runBenchStack({
      action: 'up',
      id: ID,
      baseConfig: BASE,
      wrangler,
      writeConfig: async (config) => { written.push(config); },
      patFile: `/repo/apps/platform/.env.bench-${ID}`,
      mintPat: async () => {},
    });
    expect(written[0]?.d1_databases[0].database_id).toBe(DATABASE_ID);
    expect(fake.calls.filter((args) => args[0] === 'd1' && args[1] === 'list')).toHaveLength(2);
    expect(fake.calls.some((args) => args[0] === 'deploy' && !args.includes('--dry-run'))).toBe(true);
  });

  it('creates and removes a per-repo artifacts.repo subscription, then down removes every namespaced repo', async () => {
    const scratchRepo = `${RES.prefix}-storm-123`;
    const artifactScratchRepo = `owner--${scratchRepo}--a1b2c3d4e5f6`;
    const fake = fakeWrangler({
      d1: [{ name: RES.d1, uuid: DATABASE_ID }],
      buckets: [RES.bucket],
      queues: [RES.queue, RES.deadLetterQueue],
      repos: [
        { name: RES.seedRepo },
        { name: artifactScratchRepo },
        { name: 'owner--api-created--a1b2c3d4' },
        { name: 'unrelated-repo', namespace: 'another-namespace' },
      ],
    });
    const created = await subscribeBenchRepo(RES, scratchRepo, fake.wrangler);
    expect(created.created).toBe(true);
    const create = fake.calls.find((args) => args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create')!;
    expect(create).toContain('artifacts.repo');
    expect(create[create.indexOf('--source-namespace') + 1]).toBe(RES.namespace);
    expect(create[create.indexOf('--source-repo-name') + 1]).toBe(artifactScratchRepo);
    expect((await unsubscribeBenchRepo(RES, scratchRepo, fake.wrangler)).deleted).toBe(true);
    fake.state.subscriptions.push({
      id: 'leftover',
      name: `${RES.prefix}-leftover`,
      source: { type: 'artifacts.repo', namespace: RES.namespace, repo_name: artifactScratchRepo },
      events: ['pushed'],
    });
    const status = await runBenchStack({ action: 'status', id: ID, baseConfig: BASE, wrangler: fake.wrangler });
    expect(status.subscriptions).toHaveLength(1);
    expect(status.artifactsRepos.map((repo: { name: string }) => repo.name)).toContain('owner--api-created--a1b2c3d4');
    let removedConfig = false;
    let removedPat = false;
    await runBenchStack({
      action: 'down',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      accountId: 'a'.repeat(32),
      apiToken: 'test-token',
      fetchImpl: async () => new Response(JSON.stringify({ success: true, result: [], result_info: { is_truncated: false } })),
      removeConfig: async () => { removedConfig = true; },
      removePatFile: async () => { removedPat = true; },
    });
    expect(removedConfig).toBe(true);
    expect(removedPat).toBe(true);
    expect(fake.state.subscriptions).toEqual([]);
    expect(fake.state.repos).toEqual([{ name: 'unrelated-repo', namespace: 'another-namespace' }]);
    expect(fake.state.queues).toEqual([]);
    expect(fake.state.buckets).toEqual([]);
    expect(fake.state.d1).toEqual([]);
    const artifactDeletes = fake.calls.filter((args) => args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'delete');
    expect(artifactDeletes.every((args) => args[args.indexOf('--namespace') + 1] === RES.namespace)).toBe(true);
    expect(artifactDeletes.map((args) => args[3])).toContain('owner--api-created--a1b2c3d4');
    expect(fake.calls.slice(-4).some((args) => args[0] === 'deployments' && args[1] === 'list')).toBe(true);
  });

  it('fails down when final status still sees a benchmark-prefixed resource or a namespaced repo', async () => {
    const fake = fakeWrangler({
      repos: [{ name: 'owner--api-created--a1b2c3d4' }],
      preserveDeletedRepos: true,
    });
    await expect(runBenchStack({
      action: 'down',
      id: ID,
      baseConfig: BASE,
      wrangler: fake.wrangler,
      removeConfig: async () => {},
      removePatFile: async () => {},
    })).rejects.toThrow(/benchmark resources remain/);
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
