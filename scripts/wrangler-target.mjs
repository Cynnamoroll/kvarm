#!/usr/bin/env node
/**
 * Runs wrangler against your own Cloudflare deployment target.
 *
 * apps/platform/wrangler.jsonc is committed with neutral defaults and pins no
 * deployment. This script reads the target settings from the environment or
 * from apps/platform/.env.deploy (gitignored; copy .env.deploy.example),
 * writes apps/platform/wrangler.target.json (gitignored) and runs
 * `wrangler <args> -c wrangler.target.json` from apps/platform.
 *
 *   KVARM_D1_DATABASE_ID    required: the id printed by `wrangler d1 create`
 *   KVARM_APP_ORIGIN        required for deploys: the worker's public origin
 *   KVARM_D1_DATABASE_NAME  optional, defaults to the name in wrangler.jsonc
 *   CLOUDFLARE_ACCOUNT_ID   optional, read by wrangler itself
 *
 * Usage (also `npm run wrangler:target --workspace apps/platform -- <args>`):
 *   node scripts/wrangler-target.mjs deploy
 *   node scripts/wrangler-target.mjs d1 migrations apply DB --remote
 *   node scripts/wrangler-target.mjs d1 execute DB --remote --command "SELECT 1"
 *
 * Only wrangler's own output reaches stdout, so `--json` output stays parseable.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile, parseJsonc, resolveSettings, targetConfig } from './lib/wrangler-target.mjs';

const PLATFORM = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/platform');
const ENV_FILE = join(PLATFORM, '.env.deploy');
const TARGET = 'wrangler.target.json';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/wrangler-target.mjs <wrangler args...>');
  process.exit(2);
}
if (args.some((a) => a === '-c' || a === '--config' || a.startsWith('--config='))) {
  console.error('wrangler-target: do not pass -c/--config; the target config is generated');
  process.exit(2);
}

const fileEnv = existsSync(ENV_FILE) ? parseEnvFile(readFileSync(ENV_FILE, 'utf8')) : {};
const settings = resolveSettings(process.env, fileEnv);
const requireOrigin = args[0] === 'deploy' || (args[0] === 'versions' && (args[1] === 'upload' || args[1] === 'deploy'));

let config;
try {
  config = targetConfig(parseJsonc(readFileSync(join(PLATFORM, 'wrangler.jsonc'), 'utf8')), settings, { requireOrigin });
} catch (e) {
  console.error(`wrangler-target: ${e instanceof Error ? e.message : e}`);
  console.error(`Set it in the environment or in ${ENV_FILE} (see apps/platform/.env.deploy.example).`);
  process.exit(2);
}
writeFileSync(join(PLATFORM, TARGET), `${JSON.stringify(config, null, 2)}\n`);

const env = { ...process.env };
if (settings.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = settings.CLOUDFLARE_ACCOUNT_ID;
const r = spawnSync('npx', ['wrangler', ...args, '-c', TARGET], { cwd: PLATFORM, env, stdio: 'inherit' });
if (r.error) {
  console.error(`wrangler-target: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
