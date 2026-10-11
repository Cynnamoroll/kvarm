/**
 * What the Container CI runner puts into its container and how it invokes
 * it. Plain data and strings (no runtime imports), so Node tests run the
 * exact payload with a local `node`.
 */

import { RUNNER_MODULES } from './runnerSource';

export const RUNNER_DIR = '/opt/forge-runner';
export const WORK_ROOT = '/var/lib/forge-runner';

/**
 * One job, then exit: 0 when a claimed job was reported, 3 when none was
 * queued. Credentials arrive only through this process's environment, which
 * executeShell does not pass on to the repository command.
 */
const RUN_ENTRY = `import { runRunner } from './runner.js';

const env = process.env;
const result = await runRunner({
  baseUrl: env.FORGE_BASE_URL,
  pat: env.FORGE_PAT,
  repo: env.FORGE_REPO,
  runnerId: env.FORGE_RUNNER_ID,
  workRoot: env.FORGE_WORK_ROOT,
  once: true,
  stdout: (line) => process.stdout.write(line + '\\n'),
  stderr: (line) => process.stderr.write(line + '\\n'),
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
}

/**
 * The runner exec's whole environment (exec() adds only PATH). The token is
 * never written to the container filesystem, which a snapshot would capture.
 */
export function runnerExecEnv(input: RunnerExecInput): Record<string, string> {
  return {
    FORGE_BASE_URL: input.baseUrl,
    FORGE_PAT: input.token,
    FORGE_REPO: input.repo,
    FORGE_RUNNER_ID: input.runnerId,
    FORGE_WORK_ROOT: input.workRoot ?? WORK_ROOT,
    HOME: '/root',
  };
}
