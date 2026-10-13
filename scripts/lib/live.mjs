/**
 * Live transport shared by scripts/cost-sweep.mjs and scripts/bench.mjs:
 * bounded HTTP (5 in flight, 429/Retry-After honored, GET retries, a request
 * ceiling), bounded git (3 children, `-c credential.helper=`, a secret-free
 * GIT_ASKPASS that reads the token from the child's environment), read-only
 * remote D1 queries and a `wrangler tail` capture. Tokens are never printed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLimiter, parseCost, retryAfterMs } from './fleet.mjs';
import { remoteD1Args } from './wrangler-target.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const PLATFORM = join(ROOT, 'apps/platform');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Splits concatenated (possibly pretty-printed) JSON objects, as `wrangler tail --format json` writes them. */
export function splitJsonStream(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // a partial object at the tail's start or end
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Every JSON log line of a tail capture, with its invocation's event timestamp. */
export function tailLogLines(text) {
  const lines = [];
  for (const ev of splitJsonStream(text)) {
    for (const l of ev.logs ?? []) {
      const msg = Array.isArray(l.message) ? l.message[0] : l.message;
      if (typeof msg !== 'string' || !msg.startsWith('{')) continue;
      try {
        lines.push({ at: l.timestamp, invokedAt: ev.eventTimestamp, queue: ev.event?.queue ?? null, level: l.level, json: JSON.parse(msg) });
      } catch {
        // not a JSON line
      }
    }
  }
  return lines;
}

export function createLive({ base, pat, ceiling = 10_000, timeoutMs = 90_000, log = console.log }) {
  const work = mkdtempSync(join(tmpdir(), 'kvarm-live-'));
  const askpass = join(work, 'askpass.sh');
  writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *sername*) echo x ;; *) printenv KVARM_E2E_TOKEN ;; esac\n');
  chmodSync(askpass, 0o700);
  const httpLim = createLimiter(5);
  const gitLim = createLimiter(3);
  const state = { requests: 0, ceiling };
  const reserve = (n) => {
    if (state.requests + n > ceiling) throw new Error(`request ceiling ${ceiling} reached`);
    state.requests += n;
  };

  /**
   * One request. `token: null` sends no Authorization header; `auth` sends a raw
   * Authorization value. `ms` is the Date.now() span around fetch + body read.
   */
  async function http(path, { method = 'GET', json, body, headers = {}, token = pat, auth, binary = false, retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      reserve(1);
      const out = await httpLim.run(async () => {
        const h = { ...headers };
        if (auth !== undefined) h.Authorization = auth;
        else if (token) h.Authorization = `Bearer ${token}`;
        const init = { method, headers: h, signal: AbortSignal.timeout(timeoutMs) };
        if (json !== undefined) {
          h['content-type'] = 'application/json';
          init.body = JSON.stringify(json);
        } else if (body !== undefined) init.body = body;
        const t0 = Date.now();
        try {
          const res = await fetch(path.startsWith('http') ? path : `${base}${path}`, init);
          const buf = new Uint8Array(await res.arrayBuffer());
          const ms = Date.now() - t0;
          const text = binary ? '' : new TextDecoder().decode(buf);
          let parsed = null;
          if (!binary) {
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
          }
          const raw = res.headers.get('x-kvarm-cost') ?? '';
          return { status: res.status, json: parsed, text, bytes: binary ? buf : null, headers: res.headers, raw, cost: parseCost(raw), ms };
        } catch (err) {
          return { status: 0, error: String(err?.cause ?? err).slice(0, 200), json: null, text: '', bytes: null, headers: new Headers(), raw: '', cost: {}, ms: Date.now() - t0 };
        }
      });
      if (!retry) return out;
      if (out.status === 0 && method === 'GET' && attempt < 3) continue;
      if (out.status === 429 && attempt < 6) {
        const wait = retryAfterMs(out.headers.get('retry-after'), 5000, 65_000);
        log(`  429 on ${method} ${path}; waiting ${wait} ms`);
        await sleep(wait);
        continue;
      }
      if (out.status >= 500 && method === 'GET' && attempt < 3) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return out;
    }
  }

  async function git(args, { cwd = work, network = false, input, env = {}, token = pat, allowFail = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      if (network) reserve(4);
      const r = await gitLim.run(
        () =>
          new Promise((resolve) => {
            const child = spawn('git', ['-c', 'credential.helper=', ...args], {
              cwd,
              env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', KVARM_E2E_TOKEN: token ?? '', ...env },
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (d) => (out += d));
            child.stderr.on('data', (d) => (err += d));
            child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
            if (input !== undefined) child.stdin.end(input);
            else child.stdin.end();
          }),
      );
      if (network && r.code !== 0 && /\b429\b|rate limited/i.test(r.err) && attempt < 3) {
        log(`  git 429 on ${args[0]}; waiting 60 s`);
        await sleep(60_000);
        continue;
      }
      if (r.code !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${r.err.slice(0, 300)}`);
      return allowFail ? r : r.out;
    }
  }

  /**
   * Deletes one scratch resource and confirms it is really gone: a 2xx DELETE,
   * then a readback that must answer 404 (a lost reply can still have deleted
   * it). Retries within a small bound, so a DELETE that is still settling does
   * not report a leak. `first` is the first DELETE response, for cost samples.
   */
  async function remove(path, { attempts = 3, waitMs = 1500 } = {}) {
    let detail = 'no attempt';
    let first = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const del = await http(path, { method: 'DELETE' });
      first ??= del;
      const suffix = del.error ? ` (${del.error})` : '';
      if (del.status === 404 || (del.status >= 200 && del.status < 300)) {
        const after = await http(path);
        detail = `DELETE ${del.status}${suffix}, GET ${after.status}`;
        if (after.status === 404) return { ok: true, detail, attempts: attempt, first };
      } else {
        detail = `DELETE ${del.status}${suffix}`;
      }
      if (attempt < attempts) await sleep(waitMs * attempt);
    }
    return { ok: false, detail, attempts, first };
  }

  /** Read-only remote D1 query: runs the repository's own wrangler through node, so it needs no PATH entry. */
  function d1(sql) {
    const r = spawnSync(process.execPath, remoteD1Args(sql), { cwd: PLATFORM, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`wrangler d1 execute failed: ${(r.stderr || r.stdout).slice(0, 300)}`);
    return JSON.parse(r.stdout).map((x) => x.results ?? []);
  }

  /**
   * Captures `wrangler tail` into a file. The binary comes from PATH (`. "$HOME/.config/vite-plus/env"`);
   * unlike d1(), which runs the repository's wrangler through node, this spawn needs it there.
   */
  function startTail(file = join(work, 'tail.jsonl')) {
    const stream = createWriteStream(file);
    const child = spawn('wrangler', ['tail', 'kvarm-platform', '--format', 'json'], { cwd: PLATFORM, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(stream);
    let err = '';
    let spawnError = null;
    child.stderr.on('data', (d) => (err += d));
    // Without this listener a host with no `wrangler` on PATH dies on an unhandled
    // ENOENT; stop() reports the recorded error instead.
    child.on('error', (e) => {
      spawnError = e;
    });
    let stopped = false;
    return {
      file,
      read: () => readFileSync(file, 'utf8'),
      async stop(graceMs = 8000) {
        if (stopped) return err;
        stopped = true;
        await sleep(graceMs);
        // A spawn that never started has no process to signal or to wait for.
        if (!spawnError) {
          child.kill('SIGINT');
          await new Promise((r) => (child.exitCode !== null ? r() : child.once('close', r)));
        }
        stream.end();
        if (spawnError) throw new Error(`wrangler tail did not start: ${spawnError.message}`);
        return err;
      },
    };
  }

  return { work, askpass, state, http, git, remove, d1, startTail };
}
