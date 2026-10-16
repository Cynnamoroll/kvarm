import { createHash, randomBytes } from 'node:crypto';
import { parseQueueList, parseR2BucketList } from './bootstrap.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export function benchResources(id) {
  if (!/^[a-z0-9]{4,12}$/.test(id)) throw new Error('--id must be 4–12 lowercase letters or digits');
  const prefix = `kvarm-bench-${id}`;
  return {
    prefix,
    worker: `${prefix}-platform`,
    d1: `${prefix}-db`,
    bucket: `${prefix}-snapshots`,
    queue: `${prefix}-events`,
    deadLetterQueue: `${prefix}-events-dlq`,
    namespace: `${prefix}-artifacts`,
    seedRepo: `${prefix}-seed`,
  };
}

export async function emptyBenchBucket({ id, bucketName, accountId, apiToken, fetchImpl = fetch }) {
  const resources = benchResources(id);
  if (bucketName !== resources.bucket) throw new Error(`refusing to list or empty non-benchmark bucket: ${bucketName}`);
  if (!ACCOUNT_ID.test(accountId ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hex account ID');
  if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required to empty the benchmark R2 bucket');

  let cursor;
  let deleted = 0;
  const cursors = new Set();
  while (true) {
    const url = new URL(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects`);
    url.searchParams.set('per_page', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiToken}` } });
    if (!response.ok) throw new Error(`R2 object listing failed: HTTP ${response.status}`);
    const page = await response.json();
    if (page.success !== true || !Array.isArray(page.result)) throw new Error('R2 object listing returned an invalid response');

    let next = 0;
    const failures = [];
    await Promise.all(Array.from({ length: Math.min(8, page.result.length) }, async () => {
      while (next < page.result.length) {
        const item = page.result[next++];
        if (typeof item?.key !== 'string') {
          failures.push(new Error('R2 object listing returned an object without a key'));
          continue;
        }
        try {
          const deletedResponse = await fetchImpl(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${encodeURIComponent(item.key)}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${apiToken}` } },
          );
          if (!deletedResponse.ok && deletedResponse.status !== 404) {
            throw new Error(`HTTP ${deletedResponse.status}`);
          }
          deleted++;
        } catch (error) {
          failures.push(new Error(`R2 object deletion failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }));
    if (failures.length) throw new AggregateError(failures, `failed to delete ${failures.length} R2 object(s)`);

    const info = page.result_info ?? {};
    if (info.is_truncated !== true) break;
    if (typeof info.cursor !== 'string' || !info.cursor || cursors.has(info.cursor)) {
      throw new Error('R2 object listing returned a missing or repeated pagination cursor');
    }
    cursors.add(info.cursor);
    cursor = info.cursor;
  }
  return { deleted };
}

const MIRROR_MODES = new Set(['off', 'shadow', 'on']);

export function benchmarkConfig(base, resources, databaseId = '00000000-0000-0000-0000-000000000000', mirrorMode = 'shadow') {
  if (!MIRROR_MODES.has(mirrorMode)) throw new Error('--mirror-mode must be off, shadow, or on');
  const config = structuredClone(base);
  config.name = resources.worker;
  config.workers_dev = true;
  config.d1_databases = config.d1_databases.map((db) => db.binding === 'DB'
    ? { ...db, database_name: resources.d1, database_id: databaseId }
    : db);
  config.r2_buckets = config.r2_buckets.map((bucket) => bucket.binding === 'SNAPSHOTS'
    ? { ...bucket, bucket_name: resources.bucket }
    : bucket);
  config.queues.producers = config.queues.producers.map((producer) => producer.binding === 'EVENTS'
    ? { ...producer, queue: resources.queue }
    : producer);
  config.queues.consumers = config.queues.consumers.map((consumer) => ({
    ...consumer,
    queue: consumer.queue === base.queues.producers.find((p) => p.binding === 'EVENTS')?.queue ? resources.queue : consumer.queue,
    dead_letter_queue: consumer.dead_letter_queue === base.queues.consumers.find((c) => c.queue === base.queues.producers.find((p) => p.binding === 'EVENTS')?.queue)?.dead_letter_queue
      ? resources.deadLetterQueue
      : consumer.dead_letter_queue,
  }));
  config.artifacts = config.artifacts.map((artifacts) => artifacts.binding === 'ARTIFACTS'
    ? { ...artifacts, namespace: resources.namespace }
    : artifacts);
  config.vars = { ...config.vars, ARTIFACTS_NAMESPACE: resources.namespace, GIT_MIRROR_MODE: mirrorMode };
  config.ratelimits = config.ratelimits.map((ratelimit) => {
    const suffix = createHash('sha256').update(`${resources.prefix}:${ratelimit.name}`).digest('hex').slice(0, 12);
    return { ...ratelimit, namespace_id: String(1_000_000_000_000n + BigInt(`0x${suffix}`)) };
  });
  config.workflows = config.workflows.map((workflow) => ({ ...workflow, name: `${resources.prefix}-${workflow.name}` }));

  const containerBindings = new Set(['CI_SANDBOX', 'ENV_BUILDER', 'AGENT_SANDBOX']);
  config.durable_objects.bindings = config.durable_objects.bindings.filter((binding) => !containerBindings.has(binding.name));
  delete config.containers;
  return config;
}

export function assertArtifactsNamespace(namespace, resources) {
  if (namespace !== resources.namespace) throw new Error('refusing Artifacts mutation outside the benchmark namespace');
}

// Git write limits are keyed per credential, so a benchmark fleet needs one PAT per writer.
export function patKeys(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 50) throw new Error('--pats must be an integer between 1 and 50');
  return Array.from({ length: count }, (_, index) => (index === 0 ? 'KVARM_PAT' : `KVARM_PAT_${index + 1}`));
}

export function withPatList(text, keys) {
  const values = keys
    .map((key) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1]?.trim())
    .filter((value) => Boolean(value));
  if (!values.length) return text;
  const line = `KVARM_PATS=${values.join(',')}`;
  const existing = /^KVARM_PATS=.*$/m;
  if (existing.test(text)) return text.replace(existing, line);
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

export function withBenchUser(text, id) {
  if (/^KVARM_USER=.*$/m.test(text)) return text;
  const line = `KVARM_USER=bench-${id}`;
  return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

const namedArg = (args, name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const expectedConfig = (resources) => `wrangler.bench-${resources.prefix.slice('kvarm-bench-'.length)}.json`;
const ensureName = (name, resources) => {
  if (typeof name !== 'string' || !name.startsWith(`${resources.prefix}-`)) {
    throw new Error(`refusing Wrangler mutation for non-benchmark name: ${String(name)}`);
  }
};

function ensureArtifactRepoName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,62}$/.test(name)) {
    throw new Error(`refusing invalid Artifacts repository name: ${String(name)}`);
  }
}

function assertIsolatedConfig(config, resources) {
  if (config?.name !== resources.worker ||
      config.d1_databases?.some((x) => x.database_name !== resources.d1) ||
      config.d1_databases?.find((x) => x.binding === 'DB')?.database_name !== resources.d1 ||
      config.r2_buckets?.some((x) => x.bucket_name !== resources.bucket) ||
      config.r2_buckets?.find((x) => x.binding === 'SNAPSHOTS')?.bucket_name !== resources.bucket ||
      config.queues?.producers?.some((x) => !x.queue?.startsWith(`${resources.prefix}-`)) ||
      config.queues?.producers?.find((x) => x.binding === 'EVENTS')?.queue !== resources.queue ||
      config.queues?.consumers?.some((x) => x.queue === resources.queue && x.dead_letter_queue === resources.deadLetterQueue) !== true ||
      config.queues?.consumers?.some((x) => !x.queue?.startsWith(`${resources.prefix}-`) || !x.dead_letter_queue?.startsWith(`${resources.prefix}-`)) ||
      config.artifacts?.some((x) => x.namespace !== resources.namespace) ||
      config.artifacts?.find((x) => x.binding === 'ARTIFACTS')?.namespace !== resources.namespace ||
      !Array.isArray(config.workflows) ||
      config.workflows.some((x) => !x.name?.startsWith(`${resources.prefix}-`)) ||
      config.vars?.ARTIFACTS_NAMESPACE !== resources.namespace ||
      !MIRROR_MODES.has(config.vars?.GIT_MIRROR_MODE) ||
      config.containers !== undefined ||
      config.durable_objects?.bindings?.some((binding) => ['CI_SANDBOX', 'ENV_BUILDER', 'AGENT_SANDBOX'].includes(binding.name))) {
    throw new Error('refusing deployment or migration with a non-isolated Wrangler config');
  }
  const rateLimitIds = config.ratelimits?.map((ratelimit) => ratelimit.namespace_id) ?? [];
  if (rateLimitIds.length === 0 ||
      new Set(rateLimitIds).size !== rateLimitIds.length ||
      rateLimitIds.some((id) => !/^\d+$/.test(String(id)) || ['4601', '4602'].includes(String(id)))) {
    throw new Error('refusing benchmark config with non-isolated rate-limit namespaces');
  }
}

function assertMutation(args, resources, config) {
  if (args[0] === 'd1' && ['create', 'delete'].includes(args[1])) ensureName(args[2], resources);
  if (args[0] === 'r2' && args[1] === 'bucket' && ['create', 'delete'].includes(args[2])) ensureName(args[3], resources);
  if (args[0] === 'queues' && ['create', 'delete'].includes(args[1])) ensureName(args[2], resources);
  if (args[0] === 'artifacts' && args[1] === 'repos' && ['create', 'delete'].includes(args[2])) {
    if (args[2] === 'create') ensureName(args[3], resources);
    assertArtifactsNamespace(namedArg(args, '--namespace'), resources);
  }
  if (args[0] === 'queues' && args[1] === 'subscription' && args[2] === 'create') {
    ensureName(args[3], resources);
    ensureName(namedArg(args, '--name'), resources);
    if (namedArg(args, '--source-namespace') !== resources.namespace) throw new Error('refusing subscription outside the benchmark namespace');
    ensureArtifactRepoName(namedArg(args, '--source-repo-name'));
  }
  if (args[0] === 'secret' && args[1] === 'put') {
    if (!['WORKOS_COOKIE_PASSWORD', 'WEBHOOK_SECRET_KEY'].includes(args[2]) || namedArg(args, '-c') !== expectedConfig(resources)) {
      throw new Error('refusing to set a secret outside the isolated benchmark config');
    }
  }
  const migrationsApply = args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply';
  const configMutation = args[0] === 'deploy' || args[0] === 'delete' ||
    (args[0] === 'secret' && args[1] === 'put') || migrationsApply;
  if (migrationsApply && (args[3] !== 'DB' || !args.includes('--remote'))) {
    throw new Error('refusing D1 migrations outside the remote benchmark DB binding');
  }
  if (configMutation) {
    if (namedArg(args, '-c') !== expectedConfig(resources)) {
      throw new Error('refusing deployment or migration without the exact benchmark Wrangler config');
    }
    assertIsolatedConfig(config, resources);
  }
}

async function call(wrangler, args, resources, config, { optional = false, input } = {}) {
  assertMutation(args, resources, config);
  const result = await wrangler(args, input === undefined ? {} : { input });
  if (result.code !== 0 && !optional) {
    const detail = args[0] === 'secret' && args[1] === 'put' ? '' : `: ${(result.stderr || result.stdout).trim().slice(0, 400)}`;
    throw new Error(`wrangler ${args.join(' ')} failed (exit ${result.code})${detail}`);
  }
  return result;
}

function parseJson(text, fallback = []) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function d1Rows(text) {
  const rows = parseJson(text, []);
  return Array.isArray(rows) ? rows : [];
}

function repoRows(text) {
  const result = parseJson(text, []);
  return Array.isArray(result) ? result : result.repos ?? [];
}

async function inspect(resources, wrangler) {
  const [d1Output, bucketOutput, queueOutput] = await Promise.all([
    call(wrangler, ['d1', 'list', '--json'], resources),
    call(wrangler, ['r2', 'bucket', 'list'], resources),
    call(wrangler, ['queues', 'list'], resources),
  ]);
  const workerOutput = await call(wrangler, ['deployments', 'list', '--name', resources.worker, '--json'], resources, null, { optional: true });
  let worker = false;
  if (workerOutput.code === 0) {
    const deployments = parseJson(workerOutput.stdout, null);
    if (!Array.isArray(deployments)) throw new Error('Wrangler returned an invalid benchmark deployment list');
    worker = deployments.length > 0;
  } else if (!/not found|does not exist|404/i.test(`${workerOutput.stderr} ${workerOutput.stdout}`)) {
    throw new Error(`could not inspect benchmark Worker: ${(workerOutput.stderr || workerOutput.stdout).trim().slice(0, 400)}`);
  }
  const d1 = d1Rows(d1Output.stdout).find((row) => row.name === resources.d1) ?? null;
  const buckets = parseR2BucketList(bucketOutput.stdout);
  const queues = parseQueueList(queueOutput.stdout);
  let subscriptions = [];
  if (queues.includes(resources.queue)) {
    const result = await call(wrangler, ['queues', 'subscription', 'list', resources.queue, '--json'], resources);
    subscriptions = parseJson(result.stdout, []);
  }
  let repos = [];
  const reposOutput = await call(wrangler, ['artifacts', 'repos', 'list', '--namespace', resources.namespace, '--json'], resources, null, { optional: true });
  if (reposOutput.code === 0) repos = repoRows(reposOutput.stdout);
  else if (!/not found|does not exist|404/i.test(`${reposOutput.stderr} ${reposOutput.stdout}`)) {
    throw new Error(`could not inspect benchmark Artifacts namespace: ${(reposOutput.stderr || reposOutput.stdout).trim().slice(0, 400)}`);
  }
  return { d1, buckets, queues, subscriptions, repos, worker };
}

function subscriptionName(resources, repo) {
  const repoPrefix = `${resources.prefix}-`;
  if (typeof repo !== 'string' || !repo.startsWith(repoPrefix) || repo.length === repoPrefix.length ||
      !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(repo)) {
    throw new Error(`scratch repo name must be a valid name under ${resources.prefix}-`);
  }
  const suffix = createHash('sha256').update(repo).digest('hex').slice(0, 12);
  return `${resources.prefix}-${suffix}`;
}

function resolveArtifactRepoName(repo, repos) {
  const exact = repos.filter((item) => item.name === repo);
  if (exact.length === 1) {
    ensureArtifactRepoName(exact[0].name);
    return exact[0].name;
  }
  if (exact.length > 1) throw new Error(`ambiguous benchmark Artifacts repository ${repo}`);
  const part = repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
  if (!part) throw new Error(`invalid Artifacts repository name for ${repo}`);
  const matches = repos.filter((item) => item.name?.split('--')[1] === part);
  if (matches.length !== 1) throw new Error(`could not resolve a unique Artifacts repository for ${repo} in ${repos.length ? 'the benchmark namespace' : 'an empty benchmark namespace'}`);
  ensureArtifactRepoName(matches[0].name);
  return matches[0].name;
}

function assertMatchingSubscription(subscription, resources, repoName, name) {
  if (subscription.name !== name ||
      subscription.source?.type !== 'artifacts.repo' ||
      subscription.source.namespace !== resources.namespace ||
      subscription.source.repo_name !== repoName ||
      !subscription.events?.includes('pushed')) {
    throw new Error(`refusing to use mismatched benchmark subscription ${name}`);
  }
}

export async function subscribeBenchRepo(resources, repo, wrangler) {
  const name = subscriptionName(resources, repo);
  const state = await inspect(resources, wrangler);
  if (!state.queues.includes(resources.queue)) throw new Error(`benchmark queue ${resources.queue} does not exist; run bench-stack up first`);
  const repoName = resolveArtifactRepoName(repo, state.repos);
  const existing = state.subscriptions.find((item) => item.name === name);
  if (existing) {
    assertMatchingSubscription(existing, resources, repoName, name);
    return { created: false, name };
  }
  await call(wrangler, [
    'queues', 'subscription', 'create', resources.queue,
    '--source', 'artifacts.repo',
    '--source-namespace', resources.namespace,
    '--source-repo-name', repoName,
    '--events', 'pushed',
    '--name', name,
  ], resources);
  return { created: true, name };
}

export async function unsubscribeBenchRepo(resources, repo, wrangler) {
  const name = subscriptionName(resources, repo);
  const state = await inspect(resources, wrangler);
  const repoName = resolveArtifactRepoName(repo, state.repos);
  const existing = state.subscriptions.find((item) => item.name === name);
  if (!existing) return { deleted: false, name };
  assertMatchingSubscription(existing, resources, repoName, name);
  await call(wrangler, ['queues', 'subscription', 'delete', resources.queue, '--id', existing.id, '--force'], resources);
  return { deleted: true, name };
}

export async function runBenchStack({
  action, id, repo, mirrorMode = 'shadow', baseConfig, wrangler, accountId, apiToken, fetchImpl = fetch,
  writeConfig = async () => {}, removeConfig = async () => {}, patFile, mintPat, removePatFile = async () => {},
  pats = 1, readPatFile = async () => '', writePatFile = async () => {},
}) {
  if (action === 'up' && !MIRROR_MODES.has(mirrorMode)) {
    throw new Error('--mirror-mode must be off, shadow, or on');
  }
  const resources = benchResources(id);
  const configArg = expectedConfig(resources);
  if (action === 'subscribe') return subscribeBenchRepo(resources, repo, wrangler);
  if (action === 'unsubscribe') return unsubscribeBenchRepo(resources, repo, wrangler);
  const state = await inspect(resources, wrangler);
  if (action === 'status') {
    return {
      resources,
      d1: state.d1,
      worker: state.worker,
      bucket: state.buckets.includes(resources.bucket),
      queues: Object.fromEntries([resources.queue, resources.deadLetterQueue].map((name) => [name, state.queues.includes(name)])),
      subscriptions: state.subscriptions.filter((s) => s.name?.startsWith(`${resources.prefix}-`)),
      artifactsRepos: state.repos,
    };
  }
  if (action === 'up') {
    if (state.d1?.uuid && !UUID.test(state.d1.uuid)) throw new Error('Wrangler returned an invalid benchmark D1 id');
    let databaseId = state.d1?.uuid;
    if (!databaseId) {
      const result = await call(wrangler, ['d1', 'create', resources.d1], resources);
      const output = parseJson(result.stdout, {});
      databaseId = output.database_id ?? /database_id\s*=\s*["']?([0-9a-f-]{36})/i.exec(result.stdout)?.[1];
      if (!UUID.test(databaseId ?? '')) {
        const listing = await call(wrangler, ['d1', 'list', '--json'], resources);
        databaseId = d1Rows(listing.stdout).find((db) => db.name === resources.d1)?.uuid;
      }
      if (!databaseId || !UUID.test(databaseId)) throw new Error('could not parse the D1 database id from Wrangler output');
    }
    if (!state.buckets.includes(resources.bucket)) await call(wrangler, ['r2', 'bucket', 'create', resources.bucket], resources);
    if (!state.queues.includes(resources.queue)) await call(wrangler, ['queues', 'create', resources.queue], resources);
    if (!state.queues.includes(resources.deadLetterQueue)) await call(wrangler, ['queues', 'create', resources.deadLetterQueue], resources);
    if (!state.repos.some((r) => r.name === resources.seedRepo)) {
      await call(wrangler, ['artifacts', 'repos', 'create', resources.seedRepo, '--namespace', resources.namespace], resources);
    }
    const config = benchmarkConfig(baseConfig, resources, databaseId, mirrorMode);
    await writeConfig(config);
    await call(wrangler, ['deploy', '--dry-run', '-c', configArg], resources, config);
    await call(wrangler, ['d1', 'migrations', 'apply', 'DB', '--remote', '-c', configArg], resources, config);
    await call(wrangler, ['deploy', '-c', configArg], resources, config);
    const secrets = [
      ['WORKOS_COOKIE_PASSWORD', randomBytes(32).toString('base64url')],
      ['WEBHOOK_SECRET_KEY', randomBytes(32).toString('base64url')],
    ];
    for (const [key, value] of secrets) {
      await call(wrangler, ['secret', 'put', key, '-c', configArg], resources, config, { input: value });
    }
    if (!patFile || !mintPat) throw new Error('bench PAT minting is required for up');
    const keys = patKeys(pats);
    let patText = await readPatFile();
    for (const key of keys) {
      if (new RegExp(`^${key}=`, 'm').test(patText)) continue;
      await mintPat(databaseId, patFile, key);
      patText = await readPatFile();
    }
    await writePatFile(withBenchUser(withPatList(patText, keys), id));
    return { resources, config, databaseId, patFile, pats: keys.length };
  }
  if (action === 'down') {
    const config = benchmarkConfig(baseConfig, resources, state.d1?.uuid ?? '00000000-0000-0000-0000-000000000000');
    if (state.buckets.includes(resources.bucket)) {
      await emptyBenchBucket({ id, bucketName: resources.bucket, accountId, apiToken, fetchImpl });
    }
    if (state.queues.includes(resources.queue)) {
      for (const subscription of state.subscriptions.filter((s) => s.name?.startsWith(`${resources.prefix}-`))) {
        ensureName(subscription.name, resources);
        if (subscription.source?.type !== 'artifacts.repo' || subscription.source.namespace !== resources.namespace) {
          throw new Error(`refusing to remove non-benchmark subscription ${subscription.name}`);
        }
        await call(wrangler, ['queues', 'subscription', 'delete', resources.queue, '--id', subscription.id, '--force'], resources);
      }
    }
    if (state.d1) await call(wrangler, ['delete', '-c', configArg], resources, config);
    for (const artifact of state.repos) {
      await call(wrangler, ['artifacts', 'repos', 'delete', artifact.name, '--namespace', resources.namespace, '--force'], resources);
    }
    for (const name of [resources.queue, resources.deadLetterQueue]) {
      if (state.queues.includes(name)) await call(wrangler, ['queues', 'delete', name], resources);
    }
    if (state.buckets.includes(resources.bucket)) await call(wrangler, ['r2', 'bucket', 'delete', resources.bucket], resources);
    if (state.d1) await call(wrangler, ['d1', 'delete', resources.d1, '--skip-confirmation'], resources);
    const status = await runBenchStack({ action: 'status', id, baseConfig, wrangler });
    const remaining =
      status.worker ||
      status.d1 ||
      status.bucket ||
      Object.values(status.queues).some(Boolean) ||
      status.subscriptions.length > 0 ||
      status.artifactsRepos.length > 0;
    if (remaining) throw new Error(`benchmark resources remain after down: ${JSON.stringify(status)}`);
    await removeConfig();
    await removePatFile();
    return { resources, deleted: true, status };
  }
  throw new Error(`unknown bench-stack action: ${action}`);
}
