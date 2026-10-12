/**
 * Streaming POSIX tar (ustar with pax extended headers) writer.
 *
 * Each entry is written independently — header, data, padding — so an archive
 * can be produced incrementally by appending entries and finishing with
 * `tarEnd()`. Output is deterministic: uid/gid are 0, owner names are empty
 * and the caller supplies the mtime.
 */

export const TAR_BLOCK = 512;

export type TarEntryType = 'file' | 'dir' | 'symlink';

export interface TarEntry {
  /** Path relative to the archive root, without a leading or trailing slash. */
  path: string;
  type: TarEntryType;
  /** Permission bits (e.g. 0o644). */
  mode: number;
  /** Byte length of the file content; ignored for directories and symlinks. */
  size?: number;
  /** Unix seconds. */
  mtime: number;
  /** Symlink target. */
  linkname?: string;
}

const encoder = new TextEncoder();

/** Largest value an 11-digit octal ustar numeric field can hold. */
const MAX_OCTAL_11 = 0o77777777777;

const TYPEFLAG: Record<TarEntryType, string> = { file: '0', dir: '5', symlink: '2' };

/** Zero bytes needed after `size` content bytes to reach a block boundary. */
export function tarPadding(size: number): number {
  const rem = size % TAR_BLOCK;
  return rem === 0 ? 0 : TAR_BLOCK - rem;
}

/** The end-of-archive marker: two zero blocks. */
export function tarEnd(): Uint8Array {
  return new Uint8Array(2 * TAR_BLOCK);
}

/** Maps a git tree entry mode to the tar type and permission bits a checkout produces. */
export function gitModeToTar(mode: string): { type: TarEntryType; mode: number } | null {
  switch (mode) {
    case '100644':
    case '100664':
      return { type: 'file', mode: 0o644 };
    case '100755':
      return { type: 'file', mode: 0o755 };
    case '120000':
      return { type: 'symlink', mode: 0o777 };
    case '40000':
    case '040000':
    case '160000':
      return { type: 'dir', mode: 0o755 };
    default:
      return null;
  }
}

function isAscii(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b > 0x7f || b === 0) return false;
  return true;
}

function writeString(block: Uint8Array, offset: number, length: number, bytes: Uint8Array): void {
  block.set(bytes.subarray(0, length), offset);
}

function writeOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  // length-1 octal digits followed by a NUL terminator.
  const digits = Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, '0');
  block.set(encoder.encode(digits.slice(-(length - 1))), offset);
  block[offset + length - 1] = 0;
}

/**
 * Splits an ASCII path into ustar `prefix` (≤155 bytes) and `name` (≤100
 * bytes) at a slash, or returns null when no split fits.
 */
function splitUstarPath(path: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | null {
  if (path.length <= 100) return { prefix: new Uint8Array(0), name: path };
  if (path.length > 256) return null;
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== 0x2f) continue;
    const prefixLen = i;
    const nameLen = path.length - i - 1;
    if (nameLen > 100) return null;
    if (prefixLen <= 155 && nameLen > 0) return { prefix: path.subarray(0, i), name: path.subarray(i + 1) };
  }
  return null;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = ` ${key}=${value}\n`;
  const bodyLen = encoder.encode(body).length;
  // The length prefix counts its own digits.
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return encoder.encode(`${len}${body}`);
}

function ustarBlock(fields: {
  name: Uint8Array;
  prefix: Uint8Array;
  mode: number;
  size: number;
  mtime: number;
  typeflag: string;
  linkname: Uint8Array;
}): Uint8Array {
  const h = new Uint8Array(TAR_BLOCK);
  writeString(h, 0, 100, fields.name);
  writeOctal(h, 100, 8, fields.mode);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, fields.size);
  writeOctal(h, 136, 12, fields.mtime);
  h[156] = fields.typeflag.charCodeAt(0);
  writeString(h, 157, 100, fields.linkname);
  h.set(encoder.encode('ustar\0'), 257);
  h.set(encoder.encode('00'), 263);
  writeOctal(h, 329, 8, 0);
  writeOctal(h, 337, 8, 0);
  writeString(h, 345, 155, fields.prefix);
  // Checksum: the sum of all header bytes with the checksum field read as spaces.
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  const digits = sum.toString(8).padStart(6, '0');
  h.set(encoder.encode(digits), 148);
  h[154] = 0;
  h[155] = 0x20;
  return h;
}

/**
 * Header bytes for one entry: a single ustar block, or a pax extended header
 * (block + data) followed by the ustar block when the path, link target or
 * size does not fit ustar.
 */
export function tarHeader(entry: TarEntry): Uint8Array {
  const size = entry.type === 'file' ? (entry.size ?? 0) : 0;
  const fullPath = entry.type === 'dir' ? `${entry.path.replace(/\/+$/, '')}/` : entry.path;
  const pathBytes = encoder.encode(fullPath);
  const linkBytes = encoder.encode(entry.type === 'symlink' ? (entry.linkname ?? '') : '');

  const records: Uint8Array[] = [];
  let split = isAscii(pathBytes) ? splitUstarPath(pathBytes) : null;
  if (!split) {
    records.push(paxRecord('path', fullPath));
    split = { prefix: new Uint8Array(0), name: pathBytes.subarray(0, 100) };
  }
  if (linkBytes.length > 100 || !isAscii(linkBytes)) records.push(paxRecord('linkpath', entry.linkname ?? ''));
  if (size > MAX_OCTAL_11) records.push(paxRecord('size', String(size)));

  const header = ustarBlock({
    name: split.name,
    prefix: split.prefix,
    mode: entry.mode,
    size: size > MAX_OCTAL_11 ? 0 : size,
    mtime: entry.mtime,
    typeflag: TYPEFLAG[entry.type],
    linkname: linkBytes.subarray(0, 100),
  });
  if (records.length === 0) return header;

  let paxLen = 0;
  for (const r of records) paxLen += r.length;
  const paxHeader = ustarBlock({
    name: encoder.encode('././@PaxHeader'),
    prefix: new Uint8Array(0),
    mode: 0o644,
    size: paxLen,
    mtime: entry.mtime,
    typeflag: 'x',
    linkname: new Uint8Array(0),
  });
  const out = new Uint8Array(TAR_BLOCK + paxLen + tarPadding(paxLen) + TAR_BLOCK);
  out.set(paxHeader, 0);
  let off = TAR_BLOCK;
  for (const r of records) {
    out.set(r, off);
    off += r.length;
  }
  out.set(header, out.length - TAR_BLOCK);
  return out;
}

/** Total archive bytes one entry occupies: header(s), content and padding. */
export function tarEntryLength(entry: TarEntry): number {
  const size = entry.type === 'file' ? (entry.size ?? 0) : 0;
  return tarHeader(entry).length + size + tarPadding(size);
}

/** One complete entry: header, content and padding. */
export function tarEntry(entry: TarEntry, data: Uint8Array = new Uint8Array(0)): Uint8Array {
  const size = entry.type === 'file' ? (entry.size ?? 0) : 0;
  if (data.length !== size) throw new Error(`tar entry ${entry.path}: data length ${data.length} differs from size ${size}`);
  const header = tarHeader(entry);
  const out = new Uint8Array(header.length + size + tarPadding(size));
  out.set(header, 0);
  out.set(data, header.length);
  return out;
}
