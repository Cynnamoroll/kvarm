// @ts-check
/**
 * Minimal fetch-like client over node:http/node:https. The global fetch
 * (undici) streamed snapshot tarballs at about half the throughput of
 * node:https and curl on the same link, so downloads use this instead.
 */

import http from 'node:http';
import https from 'node:https';

const IDLE_TIMEOUT_MS = 60_000;

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
          /** @type {Buffer[]} */
          const chunks = [];
          for await (const c of res) chunks.push(c);
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        },
      });
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`no data from ${u.host} for ${IDLE_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.end();
  });
}
