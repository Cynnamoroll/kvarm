/**
 * Cloudflare resource bootstrap (scripts/bootstrap.mjs): the resources come
 * from the committed wrangler.jsonc, listings are parsed fail-closed, and a
 * run creates only what is missing, so a second run creates nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bootstrapResources,
  envDeployWithDatabaseId,
  parseQueueList,
  parseR2BucketList,
  planBootstrap,
  runBootstrap,
} from '../lib/bootstrap.mjs';
import { parseJsonc } from '../lib/wrangler-target.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const config = parseJsonc(readFileSync(`${ROOT}apps/platform/wrangler.jsonc`, 'utf8')) as Record<string, unknown>;
const RES = bootstrapResources(config);

describe('bootstrapResources', () => {
  it('reads every provisioned resource name from wrangler.jsonc', () => {
    expect(RES).toEqual({
      d1: 'kvarm',
      bucket: 'kvarm-snapshots',
      queue: 'kvarm-events',
      deadLetterQueue: 'kvarm-events-dlq',
      artifactsNamespace: 'default',
      subscription: 'kvarm-artifacts-pushed',
      artifactsSeedRepo: 'kvarm-bootstrap',
    });
  });

  it('refuses a config without the bindings it provisions', () => {
    expect(() => bootstrapResources({ ...config, r2_buckets: [] })).toThrow(/SNAPSHOTS/);
    expect(() => bootstrapResources({ ...config, queues: { producers: [], consumers: [] } })).toThrow(/EVENTS/);
  });
});

describe('listing parsers', () => {
  it('reads bucket names from `wrangler r2 bucket list`', () => {
    const text = '\n ⛅️ wrangler 4.148.0\n───\nListing buckets...\nname:           kvarm-snapshots\ncreation_date:  2026-10-12T05:40:58.923Z\n\nname:           other\ncreation_date:  2026-10-12T05:40:58.923Z\n';
    expect(parseR2BucketList(text)).toEqual(['kvarm-snapshots', 'other']);
  });

  it('reads queue names from the `wrangler queues list` table', () => {
    const text = [
      '┌──────────────────────────────────┬──────────────────┬─────────────┐',
      '│ id                               │ name             │ created_on  │',
      '├──────────────────────────────────┼──────────────────┼─────────────┤',
      '│ 0123456789abcdef0123456789abcdef │ kvarm-events     │ 2026-10-12  │',
      '├──────────────────────────────────┼──────────────────┼─────────────┤',
      '│ fedcba9876543210fedcba9876543210 │ kvarm-events-dlq │ 2026-10-12  │',
      '└──────────────────────────────────┴──────────────────┴─────────────┘',
    ].join('\n');
    expect(parseQueueList(text)).toEqual(['kvarm-events', 'kvarm-events-dlq']);
  });

  it('reads an empty account as no buckets and no queues', () => {
    expect(parseR2BucketList('Listing buckets...\n')).toEqual([]);
    expect(parseQueueList('')).toEqual([]);
  });
});

describe('planBootstrap', () => {
  const empty = { d1: null, buckets: [], queues: [], subscriptions: [], artifactsNamespace: false };
  const full = {
    d1: { name: 'kvarm', uuid: '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a' },
    buckets: ['kvarm-snapshots'],
    queues: ['kvarm-events', 'kvarm-events-dlq'],
    subscriptions: [{ name: 'kvarm-artifacts-pushed', source: { type: 'artifacts' }, events: ['repo.pushed'] }],
    artifactsNamespace: true,
  };

  it('creates everything on an empty account, queues before the subscription', () => {
    const steps = planBootstrap(RES, empty);
    expect(steps.map((s) => [s.resource, s.action])).toEqual([
      ['d1', 'create'],
      ['r2', 'create'],
      ['queue', 'create'],
      ['dead-letter queue', 'create'],
      ['artifacts namespace', 'create'],
      ['event subscription', 'create'],
    ]);
    expect(steps.find((s) => s.resource === 'event subscription')!.command).toEqual([
      'queues', 'subscription', 'create', 'kvarm-events', '--source', 'artifacts', '--events', 'repo.pushed', '--name', 'kvarm-artifacts-pushed',
    ]);
    expect(steps.find((s) => s.resource === 'artifacts namespace')!.command).toEqual(['artifacts', 'repos', 'create', 'kvarm-bootstrap', '--namespace', 'default']);
  });

  it('creates nothing when every resource exists', () => {
    expect(planBootstrap(RES, full).every((s) => s.action === 'exists' && s.command === null)).toBe(true);
  });

  it('counts any artifacts repo.pushed subscription on the queue as present', () => {
    const other = { ...full, subscriptions: [{ name: 'renamed', source: { type: 'artifacts' }, events: ['repo.pushed'] }] };
    expect(planBootstrap(RES, other).find((s) => s.resource === 'event subscription')!.action).toBe('exists');
    const wrong = { ...full, subscriptions: [{ name: 'kvarm-artifacts-pushed', source: { type: 'r2' }, events: ['object-create'] }] };
    expect(planBootstrap(RES, wrong).find((s) => s.resource === 'event subscription')!.action).toBe('create');
  });
});

describe('envDeployWithDatabaseId', () => {
  const ID = '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a';

  it('fills an empty or missing KVARM_D1_DATABASE_ID and keeps the rest of the file', () => {
    expect(envDeployWithDatabaseId('# c\nKVARM_D1_DATABASE_ID=\nKVARM_APP_ORIGIN=https://x\n', ID)).toEqual({
      text: `# c\nKVARM_D1_DATABASE_ID=${ID}\nKVARM_APP_ORIGIN=https://x\n`,
      status: 'written',
    });
    expect(envDeployWithDatabaseId('', ID)).toEqual({ text: `KVARM_D1_DATABASE_ID=${ID}\n`, status: 'written' });
  });

  it('leaves a matching id alone and never overwrites a different one', () => {
    expect(envDeployWithDatabaseId(`KVARM_D1_DATABASE_ID=${ID}\n`, ID).status).toBe('unchanged');
    expect(envDeployWithDatabaseId('KVARM_D1_DATABASE_ID=11111111-2222-3333-4444-555555555555\n', ID).status).toBe('conflict');
  });
});

/** An in-memory account behind the wrangler commands the bootstrap runs. */
function fakeAccount(opts: { failOn?: string } = {}) {
  const state = { d1: [] as { name: string; uuid: string }[], buckets: [] as string[], queues: [] as string[], subs: new Map<string, unknown[]>(), namespaces: new Set<string>() };
  const calls: string[][] = [];
  const wrangler = async (args: string[]) => {
    calls.push(args);
    const cmd = args.join(' ');
    if (opts.failOn && cmd.startsWith(opts.failOn)) return { code: 1, stdout: '', stderr: 'Authentication error [code: 10000]' };
    if (cmd === 'd1 list --json') return { code: 0, stdout: JSON.stringify(state.d1), stderr: '' };
    if (cmd === 'r2 bucket list') return { code: 0, stdout: state.buckets.map((b) => `name:           ${b}\ncreation_date:  x\n`).join('\n'), stderr: '' };
    if (cmd === 'queues list') return { code: 0, stdout: state.queues.map((q) => `│ ${'0'.repeat(32)} │ ${q} │ x │`).join('\n'), stderr: '' };
    if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'list') {
      if (!state.queues.includes(args[3]!)) return { code: 1, stdout: '', stderr: 'Queue not found' };
      return { code: 0, stdout: JSON.stringify(state.subs.get(args[3]!) ?? []), stderr: '' };
    }
    if (args[0] === 'artifacts' && args[1] === 'namespaces' && args[2] === 'get') {
      return state.namespaces.has(args[3]!) ? { code: 0, stdout: '{}', stderr: '' } : { code: 1, stdout: '', stderr: 'Namespace not found [code: 10200]' };
    }
    if (args[0] === 'd1' && args[1] === 'create') state.d1.push({ name: args[2]!, uuid: '0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a' });
    else if (args[0] === 'r2' && args[1] === 'bucket' && args[2] === 'create') state.buckets.push(args[3]!);
    else if (args[0] === 'queues' && args[1] === 'create') state.queues.push(args[2]!);
    else if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create') {
      state.subs.set(args[3]!, [{ name: args[args.indexOf('--name') + 1], source: { type: 'artifacts' }, events: ['repo.pushed'] }]);
    } else if (args[0] === 'artifacts' && args[1] === 'repos' && args[2] === 'create') state.namespaces.add(args[args.indexOf('--namespace') + 1]!);
    else return { code: 1, stdout: '', stderr: `unexpected command ${cmd}` };
    return { code: 0, stdout: 'created', stderr: '' };
  };
  return { state, calls, wrangler };
}

const creates = (calls: string[][]) => calls.filter((c) => c.includes('create'));

describe('runBootstrap', () => {
  it('a dry run lists and plans but runs no create command', async () => {
    const acct = fakeAccount();
    const out = await runBootstrap({ resources: RES, wrangler: acct.wrangler, apply: false, log: () => {} });
    expect(out.steps.filter((s) => s.action === 'create')).toHaveLength(6);
    expect(creates(acct.calls)).toEqual([]);
    expect(out.created).toEqual([]);
  });

  it('is idempotent: the first apply creates the six missing resources, the second creates nothing', async () => {
    const acct = fakeAccount();
    const first = await runBootstrap({ resources: RES, wrangler: acct.wrangler, apply: true, log: () => {} });
    expect(first.created).toEqual(['d1', 'r2', 'queue', 'dead-letter queue', 'artifacts namespace', 'event subscription']);
    expect(first.verified).toBe(true);
    expect(first.d1Id).toBe('0f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a');
    acct.calls.length = 0;
    const second = await runBootstrap({ resources: RES, wrangler: acct.wrangler, apply: true, log: () => {} });
    expect(second.created).toEqual([]);
    expect(second.steps.every((s) => s.action === 'exists')).toBe(true);
    expect(creates(acct.calls)).toEqual([]);
  });

  it('fails closed: a listing that errors stops the run before anything is created', async () => {
    const acct = fakeAccount({ failOn: 'r2 bucket list' });
    await expect(runBootstrap({ resources: RES, wrangler: acct.wrangler, apply: true, log: () => {} })).rejects.toThrow(/r2 bucket list/);
    expect(creates(acct.calls)).toEqual([]);
  });

  it('treats only a not-found answer as a missing Artifacts namespace', async () => {
    const acct = fakeAccount({ failOn: 'artifacts namespaces get' });
    await expect(runBootstrap({ resources: RES, wrangler: acct.wrangler, apply: true, log: () => {} })).rejects.toThrow(/artifacts namespaces get/);
    expect(creates(acct.calls)).toEqual([]);
  });
});
