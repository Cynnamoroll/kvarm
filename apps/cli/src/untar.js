// @ts-check
/**
 * Streaming extractor for the POSIX ustar/pax archives the snapshot builder
 * writes (regular files, directories, symlinks; pax `path`, `linkpath` and
 * `size` records; global pax headers ignored). It never buffers a whole
 * file, refuses absolute and `..` paths under the host's path rules, never
 * creates a directory or file through an existing symlink or over a file it
 * did not create, and creates symlinks only after every other entry so no
 * archive entry can be written through a link.
 */

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, symlinkSync, writeSync } from 'node:fs';
import * as nodePath from 'node:path';

/** @typedef {import('node:path').PlatformPath} PlatformPath */

const { dirname, relative } = nodePath;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
const REWRITE_OWN = constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);

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
 * @param {string} dest
 * @param {string} target
 * @param {PlatformPath} [p]
 */
function inside(dest, target, p = nodePath) {
  const rel = p.relative(dest, target);
  return rel === '' || (!rel.startsWith(`..${p.sep}`) && rel !== '..' && !p.isAbsolute(rel));
}

/**
 * Resolves an archive entry path to its absolute target inside `root` (or
 * `root` itself for the archive root), using the separators and absolute-path
 * rules of `p`. On Windows both `/` and `\` separate components and drive,
 * UNC and device prefixes are absolute; on POSIX a backslash is an ordinary
 * filename byte, so Git names such as `a\b.txt` stay literal.
 * @param {string} raw
 * @param {string} root absolute destination directory
 * @param {PlatformPath} [p] path implementation (defaults to the host's)
 * @returns {string}
 */
export function archiveTarget(raw, root, p = nodePath) {
  if (raw.includes('\0')) throw new TarError('archive path contains NUL');
  const windows = p.sep === '\\';
  if (p.isAbsolute(raw) || (windows && /^[A-Za-z]:/.test(raw))) throw new TarError(`archive path is absolute: ${raw}`);
  const parts = raw.split(windows ? /[\\/]/ : '/');
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  while (parts.length > 0 && parts[0] === '.') parts.shift();
  for (const part of parts) {
    if (part === '' || part === '..') throw new TarError(`unsafe archive path: ${raw}`);
    // Win32 drops trailing dots and spaces (`.. ` and `...` can act as `..`); `:` names drives and NTFS streams.
    if (windows && (part.includes(':') || (part !== '.' && /^[. ]+$/.test(part)))) {
      throw new TarError(`unsafe archive path: ${raw}`);
    }
  }
  const target = p.resolve(root, ...parts);
  if (!inside(root, target, p)) throw new TarError(`archive path escapes the destination: ${raw}`);
  return target;
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

  /** Inodes of files this extraction created; only these may be rewritten. */
  /** @type {Set<string>} */
  const madeFiles = new Set();

  /**
   * Creates `dir` one component at a time below the destination, refusing
   * any existing component that is not a real directory so nothing is ever
   * created through a symlink.
   * @param {string} dir
   */
  const ensureDir = (dir) => {
    if (madeDirs.has(dir)) return;
    if (!inside(root, dir)) throw new TarError(`directory escapes the destination: ${dir}`);
    ensureDir(dirname(dir));
    /** @type {import('node:fs').Stats | undefined} */
    let st;
    try {
      st = lstatSync(dir);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
    }
    if (st && !st.isDirectory()) throw new TarError(`archive path is not a directory: ${relative(root, dir)}`);
    if (!st) mkdirSync(dir);
    madeDirs.add(dir);
  };

  /**
   * Opens a regular file for writing without following links: a new file is
   * created exclusively; an existing path is reused only when this
   * extraction created it (duplicate or case-folded names).
   * @param {string} target
   * @param {number} mode
   */
  const openEntryFile = (target, mode) => {
    if (!inside(root, target) || target === root) throw new TarError(`file escapes the destination: ${target}`);
    let fd;
    try {
      fd = openSync(target, CREATE_NEW, mode);
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const st = lstatSync(target, { bigint: true });
      if (!st.isFile() || !madeFiles.has(`${st.dev}:${st.ino}`)) {
        throw new TarError(`archive path already exists: ${relative(root, target)}`);
      }
      fd = openSync(target, REWRITE_OWN);
    }
    const st = fstatSync(fd, { bigint: true });
    madeFiles.add(`${st.dev}:${st.ino}`);
    return fd;
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

    const target = archiveTarget(rawPath, root);

    if (type === '0' || type === '\0' || type === '7') {
      if (target === root) throw new TarError('file entry without a name');
      ensureDir(dirname(target));
      const fd = openEntryFile(target, mode || 0o644);
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
      if (target === root) throw new TarError('symlink entry without a name');
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
