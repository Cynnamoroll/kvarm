// @ts-check
/**
 * User-owned CI runner: claim one immutable job, materialize its exact SHA
 * through the snapshot-first checkout, execute the repository command in a
 * shell with a timeout, and report through the fenced claim generation.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkout } from './checkout.js';
import { CliError } from './checkout.js';

const OUTPUT_LIMIT = 16 * 1024;
const IDLE_MS = 2_000;

/** @param {string} text */
function bounded(text) {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}\n[output truncated]\n`;
}

/**
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutSeconds
 * @returns {Promise<{code:number|null,stdout:string,stderr:string,timedOut:boolean,durationMs:number}>}
 */
export function executeShell(command, cwd, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const grouped = process.platform !== 'win32';
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'FORGE_PAT' && key !== 'FORGE_E2E_TOKEN' && key !== 'GIT_ASKPASS' && key !== 'GIT_TERMINAL_PROMPT' && !key.startsWith('GIT_CONFIG_'),
      ),
    );
    const child = spawn(command, { cwd, shell: true, detached: grouped, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT + 1) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT + 1) stderr += String(chunk);
    });
    let timedOut = false;
    /** @param {NodeJS.Signals} name */
    const signal = (name) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, name);
        else child.kill(name);
      } catch (err) {
        if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ESRCH')) throw err;
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), 5_000).unref();
    }, timeoutSeconds * 1000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: bounded(stdout), stderr: bounded(stderr), timedOut, durationMs: Date.now() - started });
    });
  });
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} baseUrl
 * @param {string} repo
 * @param {string} pat
 * @param {string} path
 * @param {unknown} body
 * @param {typeof fetch} apiFetch
 */
async function post(baseUrl, repo, pat, path, body, apiFetch) {
  const res = await apiFetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/repos/${repo}/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${pat}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 204) return { status: 204, body: null };
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new CliError(`${path}: ${json.error ?? `HTTP ${res.status}`}${json.code ? ` (${json.code})` : ''}`);
  return { status: res.status, body: json };
}

/**
 * @typedef {object} RunnerOptions
 * @property {string} baseUrl
 * @property {string} pat
 * @property {string} repo
 * @property {boolean} [once]
 * @property {string} [runnerId]
 * @property {typeof fetch} [apiFetch]
 * @property {typeof checkout} [checkoutFn]
 * @property {(command:string,cwd:string,timeoutSeconds:number)=>Promise<{code:number|null,stdout:string,stderr:string,timedOut:boolean,durationMs:number}>} [execute]
 * @property {(line:string)=>void} stdout
 * @property {(line:string)=>void} stderr
 * @property {string} [tempRoot]
 */

/**
 * @param {RunnerOptions} options
 * @returns {Promise<{claimed:number,reported:number}>}
 */
export async function runRunner(options) {
  const apiFetch = options.apiFetch ?? fetch;
  const checkoutFn = options.checkoutFn ?? checkout;
  const execute = options.execute ?? executeShell;
  const runnerId = options.runnerId ?? `forge-runner-${crypto.randomUUID()}`;
  const tempRoot = options.tempRoot ?? tmpdir();
  let claimed = 0;
  let reported = 0;
  for (;;) {
    const got = await post(options.baseUrl, options.repo, options.pat, 'ci/jobs/claim', { runnerId }, apiFetch);
    if (got.status === 204) {
      if (options.once) return { claimed, reported };
      await sleep(IDLE_MS);
      continue;
    }
    const job = got.body?.job;
    if (!job || typeof job.id !== 'string' || typeof job.sha !== 'string') throw new CliError('claim returned an invalid job');
    claimed++;
    options.stdout(`claimed ${job.name} (${job.id}) at ${job.sha}`);
    const root = mkdtempSync(join(tempRoot, 'forge-ci-'));
    const work = join(root, 'work');
    let heartbeat;
    let reportBody;
    try {
      const every = Math.max(10_000, Math.floor(120_000 / 3));
      heartbeat = setInterval(() => {
        void post(options.baseUrl, options.repo, options.pat, `ci/jobs/${job.id}/heartbeat`, { runnerId, generation: job.generation }, apiFetch).catch((err) =>
          options.stderr(`heartbeat: ${err instanceof Error ? err.message : String(err)}`),
        );
      }, every);
      heartbeat.unref();
      const quiet = () => {};
      const materialized = await checkoutFn({
        baseUrl: options.baseUrl,
        pat: options.pat,
        repo: options.repo,
        ref: job.sha,
        dir: work,
        stdout: quiet,
        stderr: (line) => options.stderr(`checkout: ${line}`),
      });
      if (materialized.sha !== job.sha) throw new Error(`checkout returned ${materialized.sha}, expected ${job.sha}`);
      const result = await execute(job.command, work, job.timeoutSeconds);
      const conclusion = result.code === 0 && !result.timedOut ? 'success' : 'failure';
      const summary = {
        command: job.command,
        exitCode: result.code,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        source: materialized.source,
        sha: materialized.sha,
      };
      reportBody = { runnerId, generation: job.generation, conclusion, summary };
    } catch (err) {
      const summary = {
        command: job.command,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        stdout: '',
        stderr: bounded(err instanceof Error ? err.message : String(err)),
        sha: job.sha,
      };
      reportBody = { runnerId, generation: job.generation, conclusion: 'failure', summary };
    }
    try {
      let reportError;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await post(options.baseUrl, options.repo, options.pat, `ci/jobs/${job.id}/report`, reportBody, apiFetch);
          reportError = undefined;
          break;
        } catch (err) {
          reportError = err;
          if (attempt < 2) await sleep(250 * 2 ** attempt);
        }
      }
      if (reportError) throw reportError;
      reported++;
      options.stdout(`reported ${reportBody.conclusion} for ${job.name} (${job.id})`);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      rmSync(root, { recursive: true, force: true });
    }
    if (options.once) return { claimed, reported };
  }
}
