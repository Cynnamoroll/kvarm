/**
 * Packfile v2 writer: `PACK`, version 2, object count, then per object a
 * type/size varint header and the zlib-deflated content, closed by the SHA-1
 * of everything before it. Objects are written whole (no deltas), which every
 * git server accepts, and in input order; a receive-pack server indexes the
 * pack itself, so order carries no meaning.
 */

import { concat, deflate, gitOid, sha1Hex, unhex, type GitObject, type GitObjectType } from './index';

export type PackInput = GitObject | { type: GitObjectType; content: Uint8Array };

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3 };

function header(count: number): Uint8Array {
  const out = new Uint8Array(12);
  // "PACK" without encode(): EMPTY_PACK is built while index.ts is still initialising.
  out.set([0x50, 0x41, 0x43, 0x4b], 0);
  const view = new DataView(out.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, count);
  return out;
}

/** The pack object header: 3-bit type and the inflated size as a little-endian base-128 varint. */
function entryHeader(type: GitObjectType, size: number): Uint8Array {
  const bytes: number[] = [];
  let byte = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(byte | 0x80);
    byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(byte);
  return new Uint8Array(bytes);
}

function contentOf(input: PackInput): Uint8Array {
  if ('content' in input) return input.content;
  // GitObject.raw is "type size\0content".
  return input.raw.subarray(input.raw.indexOf(0) + 1);
}

/** The pack for a push that only moves refs to objects the server already has. */
export const EMPTY_PACK: Uint8Array = concat(header(0), unhex('029d08823bd8a8eab510ad6ac75c823cfd3ed31e'));

/** Writes a pack holding each distinct object once. */
export async function writePack(objects: Iterable<PackInput>): Promise<Uint8Array> {
  const seen = new Set<string>();
  const entries: Uint8Array[] = [];
  for (const input of objects) {
    const content = contentOf(input);
    const oid = 'hash' in input ? input.hash : await gitOid(input.type, content);
    if (seen.has(oid)) continue;
    seen.add(oid);
    entries.push(entryHeader(input.type, content.length), await deflate(content));
  }
  if (seen.size === 0) return EMPTY_PACK.slice();
  const body = concat(header(seen.size), ...entries);
  return concat(body, unhex(await sha1Hex(body)));
}
