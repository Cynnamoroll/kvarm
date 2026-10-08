// @ts-check
import { spawn } from 'node:child_process';

/**
 * Environment for git children. Credential helpers are disabled and prompts
 * are off, so git never reads or stores a credential; the PAT travels only
 * as a basic-auth header scoped to the platform URL, set through
 * GIT_CONFIG_* (never argv, never written to the clone's config).
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ baseUrl: string, pat?: string }} auth
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(env, { baseUrl, pat }) {
  /** @type {NodeJS.ProcessEnv} */
  const out = { ...env, GIT_TERMINAL_PROMPT: '0' };
  /** @type {Array<[string, string]>} */
  const entries = [['credential.helper', '']];
  if (pat) {
    const basic = Buffer.from(`forge:${pat}`).toString('base64');
    entries.push([`http.${baseUrl.replace(/\/+$/, '')}/.extraHeader`, `Authorization: Basic ${basic}`]);
  }
  let n = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  for (const [key, value] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = key;
    out[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/**
 * @typedef {{ code: number, stdout: string, stderr: string }} GitResult
 * @typedef {(args: string[], options: { cwd?: string, env: NodeJS.ProcessEnv }) => Promise<GitResult>} GitRunner
 */

/** @type {GitRunner} */
export function runGit(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
