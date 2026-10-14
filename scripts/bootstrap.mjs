#!/usr/bin/env node
/**
 * Provisions the Cloudflare resources a Kvarm deployment needs, idempotently.
 * The names come from apps/platform/wrangler.jsonc: the D1 database, the R2
 * snapshot bucket, the event queue and its dead-letter queue, the Artifacts
 * namespace (which comes into existence with its first repository) and the
 * account-level Artifacts `repo.pushed` subscription on the event queue.
 * Durable Objects, Workflows, the Container classes, the rate limiters and
 * the queue consumer are created by `npm run deploy`. The Container classes
 * (CiRunnerSandbox, EnvironmentBuilder, AgentSandbox) need Cloudflare
 * Containers enabled on the account; this script does not check for it.
 *
 *   node scripts/bootstrap.mjs            dry run: list the account, print the plan, create nothing
 *   node scripts/bootstrap.mjs --apply    create what is missing, list again to verify, and
 *                                         fill KVARM_D1_DATABASE_ID in apps/platform/.env.deploy
 *   node scripts/bootstrap.mjs --local    no account: print what a fresh account gets and apply
 *                                         the D1 migrations to the local dev database
 *
 * Account modes need an authenticated wrangler (`npx wrangler login` or
 * CLOUDFLARE_API_TOKEN); CLOUDFLARE_ACCOUNT_ID is read from the environment
 * or apps/platform/.env.deploy. Wrangler runs from an empty temporary
 * directory, so no command reads or edits the committed wrangler config. A
 * listing that fails stops the run before anything is created. Exit status:
 * 0 on success (with --apply: every resource verified present), 1 on a
 * failure, 2 on a usage error.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bootstrapResources, envDeployWithDatabaseId, planBootstrap, runBootstrap } from './lib/bootstrap.mjs';
import { WRANGLER_BIN as wranglerBin, parseEnvFile, parseJsonc, resolveSettings } from './lib/wrangler-target.mjs';

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/platform');
const ENV_FILE = join(PLATFORM, '.env.deploy');
const ENV_EXAMPLE = join(PLATFORM, '.env.deploy.example');

let opts;
try {
  ({ values: opts } = parseArgs({ options: { apply: { type: 'boolean', default: false }, local: { type: 'boolean', default: false } } }));
} catch (e) {
  console.error(`bootstrap: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
}
if (opts.apply && opts.local) {
  console.error('bootstrap: --apply and --local exclude each other');
  process.exit(2);
}

const resources = bootstrapResources(parseJsonc(readFileSync(join(PLATFORM, 'wrangler.jsonc'), 'utf8')));

if (opts.local) {
  console.log('local mode: no Cloudflare account is contacted.');
  console.log('a fresh account gets:');
  const fresh = planBootstrap(resources, { d1: null, buckets: [], queues: [], subscriptions: [], artifactsNamespace: false });
  for (const s of fresh) console.log(`  ${s.resource} ${s.name}  (wrangler ${s.command.join(' ')})`);
  console.log('applying the D1 migrations to the local dev database (wrangler.dev.jsonc):');
  const r = spawnSync(process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '-c', 'wrangler.dev.jsonc'], {
    cwd: PLATFORM,
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });
  process.exit(r.status ?? 1);
}

const fileEnv = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : {};
const settings = resolveSettings(process.env, fileEnv);
const env = { ...process.env, CI: '1' };
if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;
const scratch = mkdtempSync(join(tmpdir(), 'kvarm-bootstrap-'));

/** One wrangler command from the empty scratch directory; output is captured, never inherited. */
function wrangler(args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [wranglerBin, ...args], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => done({ code: 1, stdout, stderr: String(e) }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

try {
  console.log(opts.apply ? 'apply: creating missing resources' : 'dry run: nothing is created (pass --apply to create)');
  const out = await runBootstrap({ resources, wrangler, apply: opts.apply, log: (l) => console.log(`  ${l}`) });
  const missing = out.steps.filter((s) => s.action === 'create').length;
  if (!opts.apply) {
    console.log(missing === 0 ? 'every resource exists; --apply would create nothing' : `${missing} resource(s) missing; --apply creates them`);
  } else {
    console.log(`created ${out.created.length}: ${out.created.join(', ') || 'none'}; verified: ${out.verified ? 'every resource present' : 'NOT every resource present'}`);
  }
  if (out.d1Id) {
    if (!existsSync(ENV_FILE) && opts.apply) copyFileSync(ENV_EXAMPLE, ENV_FILE);
    const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
    const next = envDeployWithDatabaseId(current, out.d1Id);
    if (next.status === 'conflict') {
      console.log(`apps/platform/.env.deploy names a different KVARM_D1_DATABASE_ID than D1 ${resources.d1}; left unchanged`);
    } else if (next.status === 'unchanged') {
      console.log(`apps/platform/.env.deploy already names D1 ${resources.d1}`);
    } else if (opts.apply) {
      writeFileSync(ENV_FILE, next.text);
      console.log(`wrote KVARM_D1_DATABASE_ID for D1 ${resources.d1} to apps/platform/.env.deploy`);
    } else {
      console.log(`--apply would write KVARM_D1_DATABASE_ID for D1 ${resources.d1} to apps/platform/.env.deploy`);
    }
  }
  if (opts.apply) {
    console.log('next: set KVARM_APP_ORIGIN in apps/platform/.env.deploy, then `npm run db:migrate:remote --workspace apps/platform` and `npm run deploy`');
    console.log('note: the deploy creates Container-backed Durable Objects, so Cloudflare Containers must be enabled on this account');
  }
  process.exitCode = opts.apply && !out.verified ? 1 : 0;
} catch (e) {
  console.error(`bootstrap: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
