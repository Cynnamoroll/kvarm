// @ts-check
/**
 * `kvarm checkout <owner/repo> <ref> <dir>`: snapshot first, git clone second.
 *
 * 1. Ask for the snapshot. With a PAT this is the explicit demand
 *    (`POST …/snapshots/:ref`), which starts a lazy build for a ref that has
 *    none; without one it is a metadata read (anonymous callers cannot
 *    demand builds).
 * 2. If the snapshot is ready, download it by commit SHA (so a moving branch
 *    cannot swap the bytes), check the byte count and extract it.
 * 3. Otherwise (building, absent, failed, an API error or a bad download)
 *    clone with git and check out the ref.
 *
 * Exactly one `source: snapshot` or `source: clone` line is printed on
 * success. A snapshot directory has no `.git`: it is the tree only.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as zlib from 'node:zlib';
import { gitEnv, runGit } from './git.js';
import { nodeFetch } from './http.js';
import { extractTar } from './untar.js';

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * @typedef {object} CheckoutOptions
 * @property {string} baseUrl platform origin, e.g. https://kvarm.example.workers.dev
 * @property {string} [pat] personal access or agent token
 * @property {string} repo `owner/name`
 * @property {string} ref branch, tag or commit SHA
 * @property {string} dir destination directory (missing or empty)
 * @property {(line: string) => void} stdout
 * @property {(line: string) => void} stderr
 * @property {NodeJS.ProcessEnv} [env] environment for git children
 * @property {import('./http.js').HttpFetch} [fetch] defaults to node:http(s)
 * @property {import('./git.js').GitRunner} [git]
 * @property {string} [cloneUrl] overrides `<baseUrl>/<owner>/<name>.git`
 *
 * @typedef {object} CheckoutResult
 * @property {'snapshot' | 'clone'} source
 * @property {string} sha
 * @property {string} [reason] why the snapshot was not used
 * @property {number} [bytes] snapshot tar bytes extracted
 * @property {number} [files]
 * @property {number} [transferBytes] wire bytes downloaded (compressed size when zstd)
 * @property {'identity' | 'zstd'} [encoding] representation the platform sent
 */

/** @param {string} repo */
export function parseRepo(repo) {
  const m = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/.exec(repo);
  if (!m) throw new CliError(`invalid repository "${repo}", expected <owner>/<repo>`, 2);
  return { owner: /** @type {string} */ (m[1]), name: /** @type {string} */ (m[2]) };
}

/** zstd snapshot encoding: zlib exposes it on Node >= 22.15; older runtimes get plain tar. */
const ZSTD = typeof zlib.createZstdDecompress === 'function';
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** @param {Uint8Array} head */
function isZstdMagic(head) {
  return head.length >= 4 && ZSTD_MAGIC.every((m, i) => head[i] === m);
}

/**
 * Frame boundaries in a zstd object (RFC 8878 frame format): magic + frame header
 * + blocks + optional content checksum; skippable frames pass through.
 * Node's zlib stops decoding after the first frame of a concatenated object,
 * so each frame is fed to a fresh decompressor. `eat` reports how much of a
 * chunk the current frame used and whether it ended the frame.
 */
class ZstdFramer {
  constructor() {
    /** @type {'magic' | 'skiplen' | 'skip' | 'fhd' | 'extra' | 'blockhead' | 'blockdata' | 'checksum'} */
    this.stage = 'magic';
    /** @type {number[]} */
    this.bytes = [];
    this.left = 0;
    this.lastBlock = false;
    this.checksum = false;
  }

  get inFrame() {
    return this.stage !== 'magic';
  }

  /**
   * @param {Uint8Array} c
   * @returns {{ consumed: number, ended: boolean }}
   */
  eat(c) {
    let i = 0;
    while (i < c.length) {
      switch (this.stage) {
        case 'magic': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = /** @type {[number, number, number, number]} */ (this.bytes);
          this.bytes = [];
          if (a === 0x28 && b === 0xb5 && d === 0x2f && e === 0xfd) this.stage = 'fhd';
          else if ((a & 0xf0) === 0x50 && b === 0x2a && d === 0x4d && e === 0x18) this.stage = 'skiplen';
          else throw new Error('snapshot download is not a zstd object');
          break;
        }
        case 'skiplen': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = /** @type {[number, number, number, number]} */ (this.bytes);
          this.bytes = [];
          this.left = (a | (b << 8) | (d << 16) | (e << 24)) >>> 0;
          this.stage = 'skip';
          break;
        }
        case 'skip': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          break;
        }
        case 'fhd': {
          const fhd = /** @type {number} */ (c[i++]);
          const single = (fhd >> 5) & 1;
          const fcs = fhd >> 6;
          this.checksum = ((fhd >> 2) & 1) === 1;
          const fcsLen = fcs === 0 ? (single ? 1 : 0) : fcs === 1 ? 2 : fcs === 2 ? 4 : 8;
          this.left = (single ? 0 : 1) + /** @type {number} */ ([0, 1, 2, 4][fhd & 3]) + fcsLen;
          this.stage = this.left > 0 ? 'extra' : 'blockhead';
          break;
        }
        case 'extra': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) this.stage = 'blockhead';
          break;
        }
        case 'blockhead': {
          while (i < c.length && this.bytes.length < 3) this.bytes.push(/** @type {number} */ (c[i++]));
          if (this.bytes.length < 3) return { consumed: i, ended: false };
          const bh = /** @type {number} */ (this.bytes[0]) | (/** @type {number} */ (this.bytes[1]) << 8) | (/** @type {number} */ (this.bytes[2]) << 16);
          this.bytes = [];
          const type = (bh >> 1) & 3;
          if (type === 3) throw new Error('reserved zstd block type');
          this.lastBlock = (bh & 1) === 1;
          this.left = type === 1 ? 1 : bh >> 3;
          this.stage = 'blockdata';
          break;
        }
        case 'blockdata': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left > 0) break;
          if (!this.lastBlock) {
            this.stage = 'blockhead';
            break;
          }
          if (!this.checksum) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          this.left = 4;
          this.stage = 'checksum';
          break;
        }
        case 'checksum': {
          const k = Math.min(this.left, c.length - i);
          i += k;
          this.left -= k;
          if (this.left === 0) {
            this.stage = 'magic';
            return { consumed: i, ended: true };
          }
          break;
        }
      }
    }
    return { consumed: i, ended: false };
  }
}

/**
 * Decompresses a stored zstd object frame by frame: Node's zlib stops after
 * the first frame of a concatenated object, so the framer hands each frame's
 * pieces to a fresh decoder as they arrive. Decoded output is yielded as the
 * decoder produces it — memory stays bounded by chunk size, never a whole
 * frame (one frame is a whole build step's compressed output).
 * @param {AsyncIterable<Uint8Array>} wire
 * @returns {AsyncIterable<Uint8Array>}
 */
async function* zstdDecodeAll(wire) {
  const framer = new ZstdFramer();
  /** @type {Uint8Array[]} */
  const out = [];
  /** @type {Error | null} */
  let failed = null;
  /** @type {Promise<never>} */
  let broken;
  /** @returns {import('node:zlib').ZstdDecompress} */
  const newDecoder = () => {
    const d = zlib.createZstdDecompress();
    d.on('data', (c) => out.push(c));
    broken = new Promise((_, reject) => {
      d.once('error', (e) => {
        failed = e instanceof Error ? e : new Error(String(e));
        reject(failed);
      });
    });
    broken.catch(() => {});
    return d;
  };
  let z = newDecoder();
  // A decode failure can stall the write/end callback itself, so every wait
  // races the decoder's own 'error' event.
  /** @param {Uint8Array} piece */
  const write = async (piece) => {
    await Promise.race([
      /** @type {Promise<void>} */ (
        new Promise((resolve) => {
          if (z.write(piece)) resolve();
          else z.once('drain', resolve);
        })
      ),
      broken,
    ]);
    if (failed) throw failed;
  };
  // The flush error can surface a tick after end()'s callback; both are checked.
  const end = async () => {
    await Promise.race([/** @type {Promise<void>} */ (new Promise((resolve) => z.end(resolve))), broken]);
    await new Promise((resolve) => setImmediate(resolve));
    if (failed) throw failed;
  };
  try {
    for await (const chunk of wire) {
      let off = 0;
      while (off < chunk.length) {
        const { consumed, ended } = framer.eat(chunk.subarray(off));
        if (consumed > 0) {
          await write(chunk.subarray(off, off + consumed));
          while (out.length > 0) yield /** @type {Uint8Array} */ (out.shift());
        }
        off += consumed;
        if (ended) {
          await end();
          while (out.length > 0) yield /** @type {Uint8Array} */ (out.shift());
          z = newDecoder();
        }
      }
    }
    if (framer.inFrame) throw new Error('truncated zstd snapshot download');
    await end();
    while (out.length > 0) yield /** @type {Uint8Array} */ (out.shift());
  } finally {
    z.destroy();
  }
}

/** @param {string} ref */
function encodeRef(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

/**
 * @param {string} dir
 * @returns {boolean} whether the directory already existed (and is empty)
 */
function prepareDir(dir) {
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isDirectory()) throw new CliError(`destination ${dir} exists and is not a directory`);
  if (readdirSync(dir).length > 0) throw new CliError(`destination ${dir} already exists and is not empty`);
  return true;
}

/**
 * Removes what this run wrote: the directory itself when it was created
 * here, otherwise only its contents (it was empty before).
 * @param {string} dir
 * @param {boolean} existed
 */
function resetDir(dir, existed) {
  if (!existed) {
    rmSync(dir, { recursive: true, force: true });
    return;
  }
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true });
}

/**
 * @param {import('./http.js').HttpResponse} res
 * @returns {Promise<any>}
 */
async function jsonBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Requests snapshot metadata, demanding a build when a token is available.
 * @param {CheckoutOptions & { fetch: import('./http.js').HttpFetch }} o
 * @param {string} path
 * @returns {Promise<{ status: number, body: any, demanded: boolean } | { error: string }>}
 */
async function requestSnapshot(o, path) {
  const headers = { accept: 'application/json', ...(o.pat ? { authorization: `Bearer ${o.pat}` } : {}) };
  try {
    const res = await o.fetch(`${o.baseUrl}${path}`, { method: o.pat ? 'POST' : 'GET', headers });
    return { status: res.status, body: await jsonBody(res), demanded: Boolean(o.pat) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * @param {CheckoutOptions & { fetch: import('./http.js').HttpFetch }} o
 * @param {string} path
 * @param {{ sha: string, size?: number, encodedSize?: number }} meta
 * @param {string} dir
 */
async function downloadSnapshot(o, path, meta, dir) {
  const headers = {
    accept: ZSTD ? 'application/zstd, application/x-tar;q=0.5' : 'application/x-tar',
    ...(o.pat ? { authorization: `Bearer ${o.pat}` } : {}),
  };
  const res = await o.fetch(`${o.baseUrl}${path}/download`, { headers });
  if (res.status !== 200 || !res.body) {
    const body = await jsonBody(res);
    throw new Error(`download returned ${res.status}${body?.code ? ` ${body.code}` : ''}`);
  }
  const servedSha = res.headers.get('x-kvarm-snapshot-sha');
  if (servedSha && servedSha !== meta.sha) {
    discard(res.body);
    throw new Error(`download served ${servedSha}, expected ${meta.sha}`);
  }
  // A zstd body is declared by the content type or sniffed from the magic of
  // the first chunk; that chunk is re-yielded after the check.
  const it = /** @type {AsyncIterable<Uint8Array>} */ (res.body)[Symbol.asyncIterator]();
  let zstd = (res.headers.get('content-type') ?? '').startsWith('application/zstd');
  /** @type {Uint8Array | null} */
  let head = null;
  const first = await it.next();
  if (!first.done) {
    head = first.value instanceof Uint8Array ? first.value : new Uint8Array(first.value);
    if (!zstd) zstd = isZstdMagic(head);
  }
  if (zstd && !ZSTD) {
    discard(res.body);
    throw new Error('snapshot download is zstd-compressed but this Node has no zstd support (need >= 22.15)');
  }
  let transferBytes = 0;
  const wire = (async function* () {
    if (head !== null) {
      transferBytes += head.length;
      yield head;
    }
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
      transferBytes += chunk.length;
      yield chunk;
    }
  })();
  const tar = zstd ? zstdDecodeAll(wire) : wire;
  const result = await extractTar(tar, dir);
  if (typeof meta.size === 'number' && result.bytes !== meta.size) {
    throw new Error(`downloaded ${result.bytes} bytes, metadata size is ${meta.size}`);
  }
  if (zstd && typeof meta.encodedSize === 'number' && transferBytes !== meta.encodedSize) {
    throw new Error(`downloaded ${transferBytes} wire bytes, metadata encodedSize is ${meta.encodedSize}`);
  }
  return { ...result, transferBytes, encoding: /** @type {'identity' | 'zstd'} */ (zstd ? 'zstd' : 'identity') };
}

/**
 * Stops a response body without reading it (web stream or Node stream).
 * @param {any} body
 */
function discard(body) {
  if (typeof body?.cancel === 'function') body.cancel().catch(() => {});
  else if (typeof body?.destroy === 'function') body.destroy();
}

/**
 * @param {CheckoutOptions & { git: import('./git.js').GitRunner }} o
 * @param {string} url
 * @param {string} dir
 */
async function cloneCheckout(o, url, dir) {
  const env = gitEnv(o.env ?? process.env, { baseUrl: o.baseUrl, pat: o.pat });
  const clone = await o.git(['clone', '-q', '--no-checkout', url, dir], { env });
  if (clone.code !== 0) throw new CliError(`git clone failed: ${clone.stderr || `exit ${clone.code}`}`);
  const target = o.ref.startsWith('refs/heads/') ? o.ref.slice('refs/heads/'.length) : o.ref;
  const co = await o.git(['checkout', '-q', target], { cwd: dir, env });
  if (co.code !== 0) throw new CliError(`git checkout ${o.ref} failed: ${co.stderr || `exit ${co.code}`}`);
  const head = await o.git(['rev-parse', 'HEAD'], { cwd: dir, env });
  if (head.code !== 0) throw new CliError(`git rev-parse HEAD failed: ${head.stderr}`);
  return head.stdout;
}

/**
 * @param {any} meta
 * @param {boolean} demanded
 */
function describeNotReady(meta, demanded) {
  const state = meta?.state ?? 'unknown';
  const sha = typeof meta?.sha === 'string' ? ` for ${meta.sha.slice(0, 12)}` : '';
  if (state === 'building') return `snapshot building${sha}${demanded ? (meta.started ? ' (build started)' : ' (build in progress)') : ''}`;
  if (state === 'absent') return `snapshot absent${sha}${demanded ? '' : ' (set KVARM_PAT to request a build)'}`;
  if (state === 'failed') return `snapshot failed${sha}`;
  return `snapshot state ${state}${sha}`;
}

/**
 * @param {CheckoutOptions} options
 * @returns {Promise<CheckoutResult>}
 */
export async function checkout(options) {
  const o = { ...options, fetch: options.fetch ?? nodeFetch, git: options.git ?? runGit, baseUrl: options.baseUrl.replace(/\/+$/, '') };
  const { owner, name } = parseRepo(o.repo);
  if (!o.ref) throw new CliError('missing <ref>', 2);
  if (!o.dir) throw new CliError('missing <dir>', 2);
  const dir = resolve(o.dir);
  const existed = prepareDir(dir);
  const path = `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${encodeRef(o.ref)}`;

  /** @type {string} */
  let reason;
  const meta = await requestSnapshot(o, path);
  if ('error' in meta) {
    reason = `snapshot API unreachable: ${meta.error}`;
  } else if (meta.status === 200 && meta.body?.state === 'ready' && typeof meta.body.sha === 'string') {
    try {
      const got = await downloadSnapshot(o, `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${meta.body.sha}`, meta.body, dir);
      o.stdout('source: snapshot');
      o.stdout(`sha: ${meta.body.sha}`);
      o.stdout(`files: ${got.files}`);
      o.stdout(`bytes: ${got.bytes}`);
      o.stdout(`transfer: ${got.transferBytes}`);
      o.stdout(`encoding: ${got.encoding}`);
      o.stderr(`note: ${o.dir} holds the tree only (no .git); see "kvarm help checkout" before committing or pushing`);
      return { source: 'snapshot', sha: meta.body.sha, bytes: got.bytes, files: got.files, transferBytes: got.transferBytes, encoding: got.encoding };
    } catch (err) {
      reason = `snapshot download failed: ${err instanceof Error ? err.message : String(err)}`;
      resetDir(dir, existed);
    }
  } else if (meta.status === 200 || meta.status === 202 || meta.status === 409) {
    reason = describeNotReady(meta.body, meta.demanded);
  } else if (meta.status === 401 || meta.status === 403) {
    reason = `snapshot API refused the token (${meta.status}${meta.body?.error ? ` ${meta.body.error}` : ''})`;
  } else {
    reason = `snapshot API returned ${meta.status}${meta.body?.error ? ` ${meta.body.error}` : ''}`;
  }

  o.stderr(`${reason}; falling back to git clone`);
  const url = o.cloneUrl ?? `${o.baseUrl}/${owner}/${name}.git`;
  let sha;
  try {
    sha = await cloneCheckout(o, url, dir);
  } catch (err) {
    resetDir(dir, existed);
    throw err;
  }
  o.stdout('source: clone');
  o.stdout(`sha: ${sha}`);
  return { source: 'clone', sha, reason };
}
