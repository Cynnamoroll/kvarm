/**
 * What the Container CI runner puts into its container and how it invokes
 * it. Plain data and strings (no runtime imports), so Node tests run the
 * exact payload with a local `node`.
 */

import { RUNNER_MODULES } from './runnerSource';

export const RUNNER_DIR = '/opt/kvarm-runner';
export const WORK_ROOT = '/var/lib/kvarm-runner';
/** Created by the Durable Object to release a runner held at the prepared point. */
export const GO_FILE = '/tmp/kvarm-runner-go';
/** The stdout line the runner prints once the job's workspace is materialized. */
export const PREPARED_LINE = 'kvarm-runner: workspace prepared';
/** How long a prepared runner waits for the go file before failing the job. */
export const GO_TIMEOUT_MS = 180_000;

/**
 * One job, then exit: 0 when a claimed job was reported, 3 when none was
 * queued. Credentials arrive only through this process's environment, which
 * executeShell does not pass on to the repository command.
 *
 * With KVARM_GO_FILE set, the runner prints PREPARED_LINE once the job's
 * workspace is materialized and waits for that file before running the
 * command, so the Durable Object can snapshot the prepared workspace while
 * the lease heartbeat keeps the claim alive.
 */
const RUN_ENTRY = `import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runRunner } from './runner.js';

const env = process.env;
const go = env.KVARM_GO_FILE;
if (go) rmSync(go, { force: true });
// The container runs one runner at a time, so a slot lock restored from a
// snapshot is always stale; left in place it would push this run to a fresh slot.
const repoRoot = join(env.KVARM_WORK_ROOT, ...env.KVARM_REPO.split('/'));
if (existsSync(repoRoot)) {
  for (const name of readdirSync(repoRoot)) if (name.endsWith('.lock')) rmSync(join(repoRoot, name), { force: true });
}
const result = await runRunner({
  baseUrl: env.KVARM_BASE_URL,
  pat: env.KVARM_PAT,
  repo: env.KVARM_REPO,
  runnerId: env.KVARM_RUNNER_ID,
  workRoot: env.KVARM_WORK_ROOT,
  once: true,
  stdout: (line) => process.stdout.write(line + '\\n'),
  stderr: (line) => process.stderr.write(line + '\\n'),
  prepared: go
    ? async () => {
        process.stdout.write(${JSON.stringify(PREPARED_LINE)} + '\\n');
        const deadline = Date.now() + ${GO_TIMEOUT_MS};
        while (!existsSync(go)) {
          if (Date.now() > deadline) throw new Error('no go signal within ${GO_TIMEOUT_MS / 1000} s after the workspace was prepared');
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    : undefined,
});
process.exitCode = result.claimed === 0 ? 3 : result.reported === result.claimed ? 0 : 1;
`;

export function containerRunnerFiles(): Record<string, string> {
  return { ...RUNNER_MODULES, 'run.mjs': RUN_ENTRY, 'package.json': '{ "type": "module" }\n' };
}

/** `node -e` program that writes stdin `{dir, files}` below `dir`. */
export const WRITE_FILES_SCRIPT = `const fs = require('node:fs');
const path = require('node:path');
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const { dir, files } = JSON.parse(raw);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (name.includes('/') || name.startsWith('.')) throw new Error('unexpected runner file ' + name);
    fs.writeFileSync(path.join(dir, name), content);
  }
  process.stdout.write(Object.keys(files).length + ' files\\n');
});`;

export interface RunnerExecInput {
  baseUrl: string;
  token: string;
  repo: string;
  runnerId: string;
  workRoot?: string;
  goFile?: string;
}

/**
 * The runner exec's whole environment (exec() adds only PATH). The token is
 * never written to the container filesystem, which a snapshot would capture.
 */
export function runnerExecEnv(input: RunnerExecInput): Record<string, string> {
  return {
    KVARM_BASE_URL: input.baseUrl,
    KVARM_PAT: input.token,
    KVARM_REPO: input.repo,
    KVARM_RUNNER_ID: input.runnerId,
    KVARM_WORK_ROOT: input.workRoot ?? WORK_ROOT,
    HOME: '/root',
    ...(input.goFile ? { KVARM_GO_FILE: input.goFile } : {}),
  };
}
