/**
 * Pure pieces of scripts/bootstrap.mjs: which Cloudflare resources a
 * deployment needs (read from the committed wrangler.jsonc), how wrangler's
 * listings are parsed, the create plan, and the run itself with an injected
 * `wrangler(args) -> {code, stdout, stderr}` so tests drive a fake account.
 *
 * Durable Objects, Workflows, the Container class, the rate limiters and the
 * queue consumer are created by `npm run deploy`, not here.
 */

export const SUBSCRIPTION_NAME = 'kvarm-artifacts-pushed';
export const ARTIFACTS_SEED_REPO = 'kvarm-bootstrap';

/** The resource names a deployment of this wrangler config needs. */
export function bootstrapResources(config) {
  const d1 = config.d1_databases?.find((d) => d.binding === 'DB');
  if (!d1?.database_name) throw new Error('wrangler.jsonc has no D1 binding DB');
  const bucket = config.r2_buckets?.find((b) => b.binding === 'SNAPSHOTS');
  if (!bucket?.bucket_name) throw new Error('wrangler.jsonc has no R2 binding SNAPSHOTS');
  const producer = config.queues?.producers?.find((p) => p.binding === 'EVENTS');
  if (!producer?.queue) throw new Error('wrangler.jsonc has no queue producer EVENTS');
  const consumer = config.queues?.consumers?.find((c) => c.queue === producer.queue);
  if (!consumer?.dead_letter_queue) throw new Error(`wrangler.jsonc has no consumer with a dead_letter_queue for ${producer.queue}`);
  const artifacts = config.artifacts?.find((a) => a.binding === 'ARTIFACTS');
  if (!artifacts?.namespace) throw new Error('wrangler.jsonc has no Artifacts binding ARTIFACTS');
  return {
    d1: d1.database_name,
    bucket: bucket.bucket_name,
    queue: producer.queue,
    deadLetterQueue: consumer.dead_letter_queue,
    artifactsNamespace: artifacts.namespace,
    subscription: SUBSCRIPTION_NAME,
    artifactsSeedRepo: ARTIFACTS_SEED_REPO,
  };
}

/** Bucket names from `wrangler r2 bucket list` (one `name:` line per bucket). */
export function parseR2BucketList(text) {
  return [...text.matchAll(/^name:\s+(\S+)\s*$/gm)].map((m) => m[1]);
}

/** Queue names from the `wrangler queues list` table (second column of each row with a 32-hex id). */
export function parseQueueList(text) {
  return [...text.matchAll(/^│\s*[0-9a-f]{32}\s*│\s*([^│\s]+)\s*│/gm)].map((m) => m[1]);
}

const isPushSubscription = (s) => s?.source?.type === 'artifacts' && Array.isArray(s.events) && s.events.includes('repo.pushed');

/**
 * One step per resource, in creation order (the subscription needs its
 * queue). `state` is what the account holds: `{d1: {name, uuid} | null,
 * buckets[], queues[], subscriptions[], artifactsNamespace: boolean}`.
 */
export function planBootstrap(res, state) {
  const step = (resource, name, exists, command) => ({ resource, name, action: exists ? 'exists' : 'create', command: exists ? null : command });
  return [
    step('d1', res.d1, Boolean(state.d1), ['d1', 'create', res.d1]),
    step('r2', res.bucket, state.buckets.includes(res.bucket), ['r2', 'bucket', 'create', res.bucket]),
    step('queue', res.queue, state.queues.includes(res.queue), ['queues', 'create', res.queue]),
    step('dead-letter queue', res.deadLetterQueue, state.queues.includes(res.deadLetterQueue), ['queues', 'create', res.deadLetterQueue]),
    step('artifacts namespace', res.artifactsNamespace, state.artifactsNamespace, ['artifacts', 'repos', 'create', res.artifactsSeedRepo, '--namespace', res.artifactsNamespace]),
    step('event subscription', res.subscription, state.subscriptions.some(isPushSubscription), [
      'queues', 'subscription', 'create', res.queue, '--source', 'artifacts', '--events', 'repo.pushed', '--name', res.subscription,
    ]),
  ];
}

/**
 * apps/platform/.env.deploy with KVARM_D1_DATABASE_ID set to `id` when it is
 * empty or absent. A different existing id is a conflict and is never
 * overwritten.
 */
export function envDeployWithDatabaseId(text, id) {
  const line = /^KVARM_D1_DATABASE_ID=(.*)$/m.exec(text);
  const current = line?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  if (current === id) return { text, status: 'unchanged' };
  if (current !== '') return { text, status: 'conflict' };
  if (line) return { text: text.replace(/^KVARM_D1_DATABASE_ID=.*$/m, `KVARM_D1_DATABASE_ID=${id}`), status: 'written' };
  const sep = text === '' || text.endsWith('\n') ? '' : '\n';
  return { text: `${text}${sep}KVARM_D1_DATABASE_ID=${id}\n`, status: 'written' };
}

const fmt = (args) => `wrangler ${args.join(' ')}`;

async function must(wrangler, args) {
  const r = await wrangler(args);
  if (r.code !== 0) throw new Error(`${fmt(args)} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout;
}

/** Reads the account. Any listing error throws: a failed listing never reads as "missing". */
export async function inspectAccount(res, wrangler) {
  const databases = JSON.parse(await must(wrangler, ['d1', 'list', '--json']));
  const d1 = databases.find((d) => d.name === res.d1) ?? null;
  const buckets = parseR2BucketList(await must(wrangler, ['r2', 'bucket', 'list']));
  const queues = parseQueueList(await must(wrangler, ['queues', 'list']));
  const subscriptions = queues.includes(res.queue) ? JSON.parse(await must(wrangler, ['queues', 'subscription', 'list', res.queue, '--json'])) : [];
  const ns = await wrangler(['artifacts', 'namespaces', 'get', res.artifactsNamespace, '--json']);
  let artifactsNamespace = ns.code === 0;
  if (!artifactsNamespace && !/not found|code: 10200/i.test(`${ns.stderr}${ns.stdout}`)) {
    throw new Error(`${fmt(['artifacts', 'namespaces', 'get', res.artifactsNamespace, '--json'])} failed (exit ${ns.code}): ${(ns.stderr || ns.stdout).trim().slice(0, 400)}`);
  }
  return { d1: d1 ? { name: d1.name, uuid: d1.uuid } : null, buckets, queues, subscriptions, artifactsNamespace };
}

/**
 * Inspect, plan and (with `apply`) create what is missing, then inspect
 * again. Returns the plan, the created resources, the D1 id and whether the
 * re-inspection found every resource.
 */
export async function runBootstrap({ resources, wrangler, apply, log = console.log }) {
  const state = await inspectAccount(resources, wrangler);
  const steps = planBootstrap(resources, state);
  for (const s of steps) log(`${s.action === 'exists' ? 'exists ' : apply ? 'create ' : 'would create'} ${s.resource} ${s.name}${s.command ? `  (${fmt(s.command)})` : ''}`);
  const created = [];
  if (apply) {
    for (const s of steps) {
      if (s.action !== 'create') continue;
      await must(wrangler, s.command);
      created.push(s.resource);
    }
  }
  let final = state;
  if (created.length > 0) final = await inspectAccount(resources, wrangler);
  const verified = planBootstrap(resources, final).every((s) => s.action === 'exists');
  return { steps, created, d1Id: final.d1?.uuid ?? null, verified };
}
