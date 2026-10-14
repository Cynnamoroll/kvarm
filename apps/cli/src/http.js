// @ts-check
/**
 * Minimal fetch-like client over node:http/node:https. The global fetch
 * (undici) streamed snapshot tarballs at about half the throughput of
 * node:https and curl on the same link, so downloads use this instead.
 */

import http from 'node:http';
import https from 'node:https';
// CliError lives in checkout.js, which imports this module for its downloads.
// The cycle is safe: neither module touches the other's bindings while it
// evaluates, only from inside functions called after both have loaded.
import { CliError } from './checkout.js';

const IDLE_TIMEOUT_MS = 60_000;
/**
 * Reply bodies are read into memory only below this bound; the platform's
 * own reply limits keep honest bodies far under it.
 */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Reads a response body as text, refusing one longer than `cap` bytes: a
 * broken or hostile platform must not be able to make the CLI buffer an
 * unbounded reply. Accepts a WHATWG Response, the HttpResponse this module
 * returns, or any async-iterable body; a body that is absent reads as ''.
 * @param {AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | { body?: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null }} res
 * @param {number} [cap]
 * @returns {Promise<string>}
 */
export async function text(res, cap = MAX_RESPONSE_BYTES) {
  const body = res !== null && typeof res === 'object' && 'body' in res && res.body != null ? res.body : res;
  if (body === null || typeof body !== 'object') return '';
  // Node's web streams are async-iterable at runtime; the DOM lib types do not say so.
  const source = /** @type {AsyncIterable<Uint8Array>} */ (body);
  if (typeof source[Symbol.asyncIterator] !== 'function') return '';
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for await (const c of source) {
    const chunk = c instanceof Uint8Array ? c : new Uint8Array(c);
    total += chunk.byteLength;
    if (total > cap) throw new CliError(`response body exceeds the ${cap}-byte read cap`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One JSON request/response through `doFetch`: the Bearer token and a JSON
 * body on the request, the reply read once through `text` (bounded) and
 * parsed when it is JSON — `json` stays `undefined` on a non-JSON reply.
 * The runner's claim/report loop and the operation layer share this so
 * auth, body encoding and Retry-After handling live in one place.
 * @param {typeof fetch} doFetch
 * @param {string | URL} url
 * @param {{ pat?: string, method?: string, headers?: Record<string, string>, body?: unknown }} [init]
 * @returns {Promise<{ ok: boolean, status: number, json: unknown, text: string, retryAfter: string | null }>}
 */
export async function requestJson(doFetch, url, init = {}) {
  /** @type {Record<string, string>} */
  const headers = { ...init.headers };
  if (init.pat) headers.authorization = `Bearer ${init.pat}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await doFetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const raw = await text(res);
  /** @type {unknown} */
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON reply
  }
  const ok = typeof res.ok === 'boolean' ? res.ok : res.status >= 200 && res.status < 300;
  return { ok, status: res.status, json, text: raw, retryAfter: res.headers.get('retry-after') };
}

/**
 * @typedef {object} HttpResponse
 * @property {number} status
 * @property {{ get(name: string): string | null }} headers
 * @property {AsyncIterable<Uint8Array> | null} body
 * @property {() => Promise<any>} json
 *
 * @typedef {(url: string, init?: { method?: string, headers?: Record<string, string> }) => Promise<HttpResponse>} HttpFetch
 */

/** @type {HttpFetch} */
export function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: {
          get(name) {
            const v = res.headers[name.toLowerCase()];
            if (v === undefined) return null;
            return Array.isArray(v) ? v.join(', ') : v;
          },
        },
        body: res,
        async json() {
          return JSON.parse(await text(res));
        },
      });
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no data from ${u.host} for ${IDLE_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.end();
  });
}
