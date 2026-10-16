#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { WRANGLER_BIN } from './lib/wrangler-target.mjs';
import { parseJsonc } from './lib/wrangler-target.mjs';
import { runBenchStack } from './lib/bench-stack.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platform = join(root, 'apps/platform');
const { positionals, values } = parseArgs({
  options: {
    id: { type: 'string' },
    repo: { type: 'string' },
    'mirror-mode': { type: 'string', default: 'shadow' },
  },
  allowPositionals: true,
});
const action = positionals[0];
if (!['up', 'down', 'status', 'subscribe', 'unsubscribe'].includes(action ?? '') || !values.id) {
  console.error('usage: node scripts/bench-stack.mjs up [--mirror-mode off|shadow|on]|down|status --id <id>; subscribe|unsubscribe --id <id> --repo <repo>');
  process.exit(2);
}
if (!['off', 'shadow', 'on'].includes(values['mirror-mode'] ?? '')) {
  console.error('--mirror-mode must be off, shadow, or on');
  process.exit(2);
}
if ((action === 'subscribe' || action === 'unsubscribe') && !values.repo) {
  console.error(`${action} requires --repo <repo>`);
  process.exit(2);
}

const configFile = join(platform, `wrangler.bench-${values.id}.json`);
const patFile = join(platform, `.env.bench-${values.id}`);
let deployOutput = '';
const wrangler = async (args, { input } = {}) => {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: platform,
    env: process.env,
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
  });
  if (args[0] === 'deploy' && result.status === 0) deployOutput = result.stdout;
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

try {
  const baseConfig = parseJsonc(await readFile(join(platform, 'wrangler.jsonc'), 'utf8'));
  const result = await runBenchStack({
    action,
    id: values.id,
    repo: values.repo,
    mirrorMode: values['mirror-mode'],
    baseConfig,
    wrangler,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    fetchImpl: globalThis.fetch,
    writeConfig: async (config) => {
      await mkdir(dirname(configFile), { recursive: true });
      await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    },
    removeConfig: async () => rm(configFile, { force: true }),
    patFile,
    mintPat: async (databaseId, tokenFile) => {
      const result = spawnSync(process.execPath, [
        join(root, 'scripts/mint-pat.mjs'),
        '--login', `bench-${values.id}`,
        '--scopes', 'read,write,api,ci',
        '--name', `bench-${values.id}`,
        '--token-file', tokenFile,
        '--key', 'KVARM_PAT',
      ], {
        cwd: root,
        env: { ...process.env, KVARM_D1_DATABASE_ID: databaseId },
        encoding: 'utf8',
      });
      if (result.status !== 0) throw new Error(`mint-pat failed (exit ${result.status ?? 1})`);
    },
    removePatFile: async () => rm(patFile, { force: true }),
  });
  if (deployOutput) console.log(deployOutput.trim());
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`bench-stack: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
