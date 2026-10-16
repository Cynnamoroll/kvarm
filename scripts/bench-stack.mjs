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
  options: { id: { type: 'string' }, repo: { type: 'string' } },
  allowPositionals: true,
});
const action = positionals[0];
if (!['up', 'down', 'status', 'subscribe', 'unsubscribe'].includes(action ?? '') || !values.id) {
  console.error('usage: node scripts/bench-stack.mjs up|down|status --id <id>; subscribe|unsubscribe --id <id> --repo <repo>');
  process.exit(2);
}
if ((action === 'subscribe' || action === 'unsubscribe') && !values.repo) {
  console.error(`${action} requires --repo <repo>`);
  process.exit(2);
}

const configFile = join(platform, `wrangler.bench-${values.id}.json`);
let deployOutput = '';
const wrangler = async (args) => {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: platform,
    env: process.env,
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
  });
  if (deployOutput) console.log(deployOutput.trim());
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`bench-stack: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
