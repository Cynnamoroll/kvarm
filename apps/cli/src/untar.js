// @ts-check
/**
 * Streaming extractor for the POSIX ustar/pax archives the snapshot builder
 * writes (regular files, directories, symlinks; pax `path`, `linkpath` and
 * `size` records; global pax headers ignored). It never buffers a whole
 * file, refuses absolute and `..` paths, and creates symlinks only after
 * every other entry so no archive entry can be written through a link.
 */

import { closeSync, lstatSync, mkdirSync, openSync, realpathSync, symlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const BLOCK = 512;
const decoder = new TextDecoder();

export class TarError extends Error {}

/**
 * Reads exact byte counts from an async iterable of chunks.
 */
class ByteReader {
  /** @param {AsyncIterable<Uint8Array>} source */
  constructor(source) {
    this.it = source[Symbol.asyncIterator]();
    /** @type {Uint8Array} */
    this.buf = new Uint8Array(0);
    this.off = 0;
    this.total = 0;
  }

  /** @returns {Promise<boolean>} false at the end of the stream */
  async fill() {
    const r = await this.it.next();
    if (r.done) return false;
    const chunk = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
    this.total += chunk.length;
    const rest = this.buf.length - this.off;
    if (rest === 0) {
      this.buf = chunk;
    } else {
      const merged = new Uint8Array(rest + chunk.length);
      merged.set(this.buf.subarray(this.off), 0);
      merged.set(chunk, rest);
      this.buf = merged;
    }
    this.off = 0;
    return true;
  }

  /** @param {number} n */
  async read(n) {
    while (this.buf.length - this.off < n) {
      if (!(await this.fill())) throw new TarError('unexpected end of archive');
    }
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }

  /**
   * Yields slices that add up to exactly `n` bytes.
   * @param {number} n
   */
  async *take(n) {
    while (n > 0) {
      if (this.off >= this.buf.length && !(await this.fill())) throw new TarError('unexpected end of archive');
      const k = Math.min(n, this.buf.length - this.off);
      yield this.buf.subarray(this.off, this.off + k);
      this.off += k;
      n -= k;
    }
  }

  /** Consumes the rest of the stream and returns the total byte count. */
  async drain() {
    this.off = this.buf.length;
    while (await this.fill()) this.off = this.buf.length;
    return this.total;
  }
}

/**
 * @param {Uint8Array} h
 * @param {number} off
 * @param {number} len
 */
function cstr(h, off, len) {
  const field = h.subarray(off, off + len);
  const nul = field.indexOf(0);
  return decoder.decode(nul === -1 ? field : field.subarray(0, nul));
}

/**
 * @param {Uint8Array} h
 * @param {number} off
 * @param {number} len
 */
function octal(h, off, len) {
  const text = cstr(h, off, len).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError(`bad numeric header field ${JSON.stringify(text)}`);
  return parseInt(text, 8);
}

/** @param {Uint8Array} h */
function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : /** @type {number} */ (h[i]);
  return sum === octal(h, 148, 8);
}

/**
 * Parses pax extended header records (`<len> <key>=<value>\n`).
 * @param {Uint8Array} data
 * @returns {Map<string, string>}
 */
export function parsePax(data) {
  /** @type {Map<string, string>} */
  const out = new Map();
  let off = 0;
  while (off < data.length) {
    let sp = off;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = Number(decoder.decode(data.subarray(off, sp)));
    if (!Number.isInteger(len) || len <= 0 || off + len > data.length) throw new TarError('bad pax record');
    const record = decoder.decode(data.subarray(sp + 1, off + len - 1));
    const eq = record.indexOf('=');
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    off += len;
  }
  return out;
}

/**
 * Validates an archive path and returns it relative to the destination, or
 * null for the archive root.
 * @param {string} raw
 */
function safePath(raw) {
  if (raw.includes('\0')) throw new TarError('archive path contains NUL');
  const path = raw.replace(/\/+$/, '').replace(/^(\.\/)+/, '');
  if (path === '' || path === '.') return null;
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path)) throw new TarError(`archive path is absolute: ${raw}`);
  const parts = path.split('/');
  for (const p of parts) {
    if (p === '..' || p === '') throw new TarError(`unsafe archive path: ${raw}`);
  }
  return parts.join(sep);
}

/**
 * @param {string} dest
 * @param {string} target
 */
function inside(dest, target) {
  const rel = relative(dest, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Extracts an archive stream into `dest` (created if missing).
 *
 * @param {AsyncIterable<Uint8Array>} source
 * @param {string} dest
 * @returns {Promise<{files: number, dirs: number, symlinks: number, bytes: number}>}
 *   entry counts and the total number of archive bytes read
 */
export async function extractTar(source, dest) {
  mkdirSync(dest, { recursive: true });
  const root = realpathSync(dest);
  const reader = new ByteReader(source);
  /** @type {Set<string>} */
  const madeDirs = new Set([root]);
  /** @type {Array<{path: string, target: string}>} */
  const links = [];
  const counts = { files: 0, dirs: 0, symlinks: 0 };
  /** @type {Map<string, string> | null} */
  let pax = null;
  /** @type {string | null} */
  let longName = null;

  /** @param {string} dir */
  const ensureDir = (dir) => {
    if (madeDirs.has(dir)) return;
    mkdirSync(dir, { recursive: true });
    madeDirs.add(dir);
  };

  for (;;) {
    const h = await reader.read(BLOCK);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw new TarError('bad header checksum');

    const type = String.fromCharCode(/** @type {number} */ (h[156]));
    let size = octal(h, 124, 12);
    if (pax?.has('size')) size = Number(pax.get('size'));
    if (!Number.isSafeInteger(size) || size < 0) throw new TarError('bad entry size');
    const padded = size + ((BLOCK - (size % BLOCK)) % BLOCK);

    if (type === 'x' || type === 'g' || type === 'L') {
      const data = await reader.read(padded);
      if (type === 'x') pax = parsePax(data.subarray(0, size));
      if (type === 'L') longName = cstr(data, 0, size);
      continue;
    }

    const name = cstr(h, 0, 100);
    const prefix = cstr(h, 257, 6) === 'ustar' ? cstr(h, 345, 155) : '';
    const rawPath = pax?.get('path') ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const linkname = pax?.get('linkpath') ?? cstr(h, 157, 100);
    const mode = octal(h, 100, 8) & 0o777;
    pax = null;
    longName = null;

    const rel = safePath(rawPath);
    const target = rel === null ? root : join(root, rel);

    if (type === '0' || type === '\0' || type === '7') {
      if (rel === null) throw new TarError('file entry without a name');
      ensureDir(dirname(target));
      const fd = openSync(target, 'w', mode || 0o644);
      try {
        for await (const slice of reader.take(size)) {
          let done = 0;
          while (done < slice.length) done += writeSync(fd, slice, done);
        }
      } finally {
        closeSync(fd);
      }
      await reader.read(padded - size);
      counts.files++;
    } else if (type === '5') {
      ensureDir(target);
      if (size > 0) await reader.read(padded);
      counts.dirs++;
    } else if (type === '2') {
      if (rel === null) throw new TarError('symlink entry without a name');
      links.push({ path: target, target: linkname });
      if (size > 0) await reader.read(padded);
    } else {
      throw new TarError(`unsupported tar entry type ${JSON.stringify(type)} for ${rawPath}`);
    }
  }

  for (const link of links) {
    const parent = dirname(link.path);
    ensureDir(parent);
    if (!inside(root, realpathSync(parent))) throw new TarError(`symlink escapes the destination: ${link.path}`);
    let exists = false;
    try {
      lstatSync(link.path);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) throw new TarError(`symlink path already exists: ${relative(root, link.path)}`);
    symlinkSync(link.target, link.path);
    counts.symlinks++;
  }

  const bytes = await reader.drain();
  return { ...counts, bytes };
}
