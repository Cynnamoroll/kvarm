/**
 * @forge/gitops — pure git plumbing that runs on any runtime with WebCrypto
 * and CompressionStream (Workers, Node 18+, Bun, Deno).
 *
 * Everything here is for speaking the git smart HTTP protocol and
 * constructing git objects without a git binary. Artifacts (the storage
 * layer) does the heavy protocol work; this package covers the gaps:
 * ref-update pushes (fast-forward merges), object + pack construction
 * (three-way merges), and helpers used by the diff/snapshot engines.
 */

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export * from './treediff';
export * from './refUpdates';
export * from './lsRefs';
export * from './reportStatus';
export * from './tar';
export * from './pack';
export * from './receivePack';
export * from './mergebase';
export * from './merge3';
export * from './compose';
export * from './notes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encode(s: string): Uint8Array {
  return encoder.encode(s);
}

export function decode(b: Uint8Array): string {
  return decoder.decode(b);
}

export function concat(...chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export function hex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hashing (WebCrypto)
// ---------------------------------------------------------------------------

export async function sha1Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', buf as unknown as ArrayBuffer));
  return hex(digest);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? encode(data) : data;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as unknown as ArrayBuffer));
  return hex(digest);
}

/** Git's object id: SHA-1 over "type size\0content". */
export async function gitOid(type: GitObjectType, content: Uint8Array): Promise<string> {
  return sha1Hex(concat(encode(`${type} ${content.length}\0`), content));
}

// ---------------------------------------------------------------------------
// Zlib (git's object and pack compression format)
// ---------------------------------------------------------------------------

/** zlib format (RFC 1950), what git uses for loose objects and pack entries. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  // The cast is zero-copy: Uint8Array views are valid Blob parts at runtime;
  // TS DOM libs just want the view parameterised over ArrayBuffer.
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// ---------------------------------------------------------------------------
// pkt-line (git protocol framing)
// ---------------------------------------------------------------------------

/** A pkt-line carrying data (or a flush packet when data is empty). */
export function pktLine(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === 'string' ? encode(data) : data;
  if (payload.length === 0) return encode('0000');
  const len = payload.length + 4;
  return concat(encode(len.toString(16).padStart(4, '0')), payload);
}

export const FLUSH_PKT = encode('0000');
export const DELIM_PKT = encode('0001');
export const RESPONSE_END_PKT = encode('0002');

export interface Pkt {
  /** Raw payload bytes (without the 4 length bytes). Empty for flush/delim. */
  data: Uint8Array;
  /** true when this was a flush-packet (0000). */
  flush: boolean;
  /** true when this was a delimiter (0001) — protocol v2. */
  delim: boolean;
  /** true when this was response-end (0002) — protocol v2. */
  responseEnd: boolean;
}

/** Reads a buffer of pkt-lines into a list (bounded; advertisements fit easily). */
export function readPktLines(buf: Uint8Array): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = decode(buf.subarray(off, off + 4));
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len)) throw new Error(`bad pkt-line length "${lenHex}" at ${off}`);
    off += 4;
    if (len === 0) {
      out.push({ data: new Uint8Array(0), flush: true, delim: false, responseEnd: false });
      continue;
    }
    if (len === 1) {
      out.push({ data: new Uint8Array(0), flush: false, delim: true, responseEnd: false });
      continue;
    }
    if (len === 2) {
      out.push({ data: new Uint8Array(0), flush: false, delim: false, responseEnd: true });
      continue;
    }
    if (len < 4 || off + len - 4 > buf.length) throw new Error('truncated pkt-line');
    out.push({
      data: buf.slice(off, off + len - 4),
      flush: false,
      delim: false,
      responseEnd: false,
    });
    off += len - 4;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Git object construction
// ---------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit';

export interface TreeEntry {
  /** Octal mode string: "100644", "100755", "120000", "40000" (trees), "160000" (submodules). */
  mode: string;
  name: string;
  /** 40-char SHA-1 object id. */
  hash: string;
}

export interface GitIdent {
  name: string;
  email: string;
  /** Unix seconds. */
  time: number;
  /** Timezone offset string like "+0000". */
  tz?: string;
}

export function identString(ident: GitIdent): string {
  return `${ident.name} <${ident.email}> ${ident.time} ${ident.tz ?? '+0000'}`;
}

export interface GitObject {
  type: GitObjectType;
  /** 40-char SHA-1 of the object (before compression). */
  hash: string;
  /** Full uncompressed content including the "type size\0" header. */
  raw: Uint8Array;
  /** zlib-deflated raw content (loose object store format). */
  store: Uint8Array;
}

async function buildObject(type: GitObjectType, content: Uint8Array): Promise<GitObject> {
  const raw = concat(encode(`${type} ${content.length}\0`), content);
  const hash = await sha1Hex(raw);
  return { type, hash, raw, store: await deflate(raw) };
}

export async function buildBlob(content: Uint8Array): Promise<GitObject> {
  return buildObject('blob', content);
}

/**
 * Git tree encoding. Entries are sorted with git's rule: byte order of the
 * name, except directory names are compared as if suffixed with '/'.
 */
export function treeContent(entries: TreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => {
    const an = a.name + (a.mode === '40000' ? '/' : '');
    const bn = b.name + (b.mode === '40000' ? '/' : '');
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    parts.push(encode(`${e.mode} ${e.name}\0`), unhex(e.hash));
  }
  return concat(...parts);
}

export async function buildTree(entries: TreeEntry[]): Promise<GitObject> {
  return buildObject('tree', treeContent(entries));
}

/**
 * Parse a git tree object back into entries. Accepts either the bare tree
 * content or a full loose object (the `tree <size>\0` header is detected and
 * skipped — a tree's own content always starts with an octal mode, never the
 * word "tree").
 */
export function parseTree(raw: Uint8Array): TreeEntry[] {
  let start = 0;
  if (raw[0] === 0x74 && raw[1] === 0x72 && raw[2] === 0x65 && raw[3] === 0x65 && raw[4] === 0x20) {
    // starts with "tree " → skip the object header
    start = raw.indexOf(0) + 1;
  }
  const entries: TreeEntry[] = [];
  let i = start;
  while (i < raw.length) {
    const space = raw.indexOf(0x20, i);
    if (space === -1) break;
    const nul = raw.indexOf(0, space + 1);
    if (nul === -1 || nul + 21 > raw.length) break;
    entries.push({
      mode: decode(raw.slice(i, space)),
      name: decode(raw.slice(space + 1, nul)),
      hash: hex(raw.slice(nul + 1, nul + 21)),
    });
    i = nul + 21;
  }
  return entries;
}

export interface CommitSpec {
  tree: string;
  parents: string[];
  author: GitIdent;
  committer: GitIdent;
  message: string;
}

export function commitContent(spec: CommitSpec): Uint8Array {
  const lines: string[] = [`tree ${spec.tree}`];
  for (const p of spec.parents) lines.push(`parent ${p}`);
  lines.push(`author ${identString(spec.author)}`);
  lines.push(`committer ${identString(spec.committer)}`);
  let body = lines.join('\n') + '\n\n';
  if (!spec.message.endsWith('\n')) body += spec.message + '\n';
  else body += spec.message;
  return encode(body);
}

export async function buildCommit(spec: CommitSpec): Promise<GitObject> {
  return buildObject('commit', commitContent(spec));
}

// ---------------------------------------------------------------------------
// Ref advertisement parsing (info/refs responses)
// ---------------------------------------------------------------------------

export interface GitRef {
  name: string;
  hash: string;
  /** Symref target (e.g. HEAD -> refs/heads/main). */
  target?: string;
}

/** Parses a v0 upload-pack advertisement body (pkt-lines). */
export function parseRefAdvertisement(body: Uint8Array): {
  capabilities: string[];
  refs: GitRef[];
} {
  const pkts = readPktLines(body);
  const refs: GitRef[] = [];
  const capabilities: string[] = [];
  let first = true;
  for (const pkt of pkts) {
    if (pkt.flush) continue;
    const line = decode(pkt.data).replace(/\n$/, '');
    if (line.startsWith('#')) continue;
    const nullIdx = line.indexOf('\0');
    const [hash = '', ...rest] = (nullIdx === -1 ? line : line.slice(0, nullIdx)).split(' ');
    const name = rest.join(' ');
    if (nullIdx !== -1 && first) {
      capabilities.push(...line.slice(nullIdx + 1).split(' ').filter(Boolean));
    }
    first = false;
    if (name === 'HEAD' || name.startsWith('refs/')) {
      refs.push({ name, hash });
    }
  }
  // symrefs come as capabilities: symref=HEAD:refs/heads/main
  for (const cap of capabilities) {
    if (cap.startsWith('symref=HEAD:')) {
      const head = refs.find((r) => r.name === 'HEAD');
      if (head) head.target = cap.slice('symref=HEAD:'.length);
    }
  }
  return { capabilities, refs };
}
