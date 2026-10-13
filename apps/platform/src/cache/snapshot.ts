/**
 * Snapshot tarballs by commit, reused across downloads for any repo
 * visibility. A commit's snapshot never changes once ready (its commit and
 * tree rows only leave `ready` when the repo is deleted, and a recreated repo
 * gets a new id), so a hit needs neither the snapshot row nor R2. Keys carry
 * the repo's internal id and the commit SHA, never owner/name or the request
 * URL.
 *
 * Callers must have authorized the request through authorizeRoute first:
 * this module neither checks access nor is ever reached by a denied request,
 * so nothing is stored or served for one.
 */

import { createZstdDecompress } from 'node:zlib';
import { markCache } from '../cost/meter';

const IMMUTABLE_TTL_SECONDS = 31536000;
const TREE_HEADER = 'x-kvarm-snapshot-tree';
const SIZE_HEADER = 'x-kvarm-snapshot-size';
/** Encoding of the stored bytes; absent on entries written before encodings existed (identity). */
const ENCODING_HEADER = 'x-kvarm-snapshot-encoding';
const TAR_SIZE_HEADER = 'x-kvarm-snapshot-tar-size';
/** The Cache API refuses larger objects; storing one would only waste the write. */
const MAX_CACHED_BYTES = 512 * 1024 * 1024;

export function snapshotCacheKey(repoId: string, sha: string): Request {
  const url = new URL('https://kvarm.internal/snapshot/v1/tar');
  url.searchParams.set('repo', repoId);
  url.searchParams.set('sha', sha);
  return new Request(url.toString(), { method: 'GET' });
}

export interface SnapshotBytes {
  body: ReadableStream<Uint8Array>;
  /** Stored object bytes (compressed when `encoding` is 'zstd'). */
  size: number;
  tree: string;
  encoding: 'identity' | 'zstd';
  /** Uncompressed tar size; equals `size` for identity. */
  tarSize: number;
}

/** The cached tarball of a ready commit, or null (recorded as the request's cache miss). */
export async function matchSnapshot(repoId: string, sha: string): Promise<SnapshotBytes | null> {
  let hit: Response | undefined;
  try {
    hit = await caches.default.match(snapshotCacheKey(repoId, sha));
  } catch {
    hit = undefined;
  }
  const tree = hit?.headers.get(TREE_HEADER);
  const size = Number(hit?.headers.get(SIZE_HEADER));
  if (!hit?.body || !tree || !Number.isSafeInteger(size)) {
    await hit?.body?.cancel().catch(() => undefined);
    markCache('miss');
    return null;
  }
  const encoding = hit.headers.get(ENCODING_HEADER) === 'zstd' ? 'zstd' : 'identity';
  const tarSize = Number(hit.headers.get(TAR_SIZE_HEADER));
  markCache('hit');
  return { body: hit.body, size, tree, encoding, tarSize: Number.isSafeInteger(tarSize) ? tarSize : size };
}

/**
 * Frame boundaries in a stored object (RFC 8878 frame format): magic + frame header
 * + blocks + optional content checksum; skippable frames pass through.
 * Node's zlib stops decoding after the first frame, so callers feed each
 * frame to a fresh decompressor; `eat` reports how much of a chunk the
 * current frame used and whether it ended the frame.
 */
class ZstdFramer {
  private stage: 'magic' | 'skiplen' | 'skip' | 'fhd' | 'extra' | 'blockhead' | 'blockdata' | 'checksum' = 'magic';
  private bytes: number[] = [];
  private left = 0;
  private lastBlock = false;
  private checksum = false;

  /** True while a frame is partially consumed. */
  get inFrame(): boolean {
    return this.stage !== 'magic';
  }

  eat(c: Uint8Array): { consumed: number; ended: boolean } {
    let i = 0;
    while (i < c.length) {
      switch (this.stage) {
        case 'magic': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(c[i++]!);
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = this.bytes as [number, number, number, number];
          this.bytes = [];
          if (a === 0x28 && b === 0xb5 && d === 0x2f && e === 0xfd) this.stage = 'fhd';
          else if ((a & 0xf0) === 0x50 && b === 0x2a && d === 0x4d && e === 0x18) this.stage = 'skiplen';
          else throw new Error('stored snapshot is not a zstd object');
          break;
        }
        case 'skiplen': {
          while (i < c.length && this.bytes.length < 4) this.bytes.push(c[i++]!);
          if (this.bytes.length < 4) return { consumed: i, ended: false };
          const [a, b, d, e] = this.bytes as [number, number, number, number];
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
          const fhd = c[i++]!;
          const single = (fhd >> 5) & 1;
          const fcs = fhd >> 6;
          this.checksum = ((fhd >> 2) & 1) === 1;
          const fcsLen = fcs === 0 ? (single ? 1 : 0) : fcs === 1 ? 2 : fcs === 2 ? 4 : 8;
          this.left = (single ? 0 : 1) + [0, 1, 2, 4][did(fhd)]! + fcsLen;
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
          while (i < c.length && this.bytes.length < 3) this.bytes.push(c[i++]!);
          if (this.bytes.length < 3) return { consumed: i, ended: false };
          const bh = this.bytes[0]! | (this.bytes[1]! << 8) | (this.bytes[2]! << 16);
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

const did = (fhd: number) => fhd & 3;

/**
 * Decompresses a stored zstd object: one decompressor per frame, each fed
 * only the frame's own bytes. A decode error or a truncated object rejects
 * the output stream — a short body is never closed cleanly.
 */
export function zstdDecompressAll(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const out = new TransformStream<Uint8Array, Uint8Array>();
  const done = (async () => {
    const reader = stream.getReader();
    const writer = out.writable.getWriter();
    const framer = new ZstdFramer();
    // workerd's zlib emits decoded output through 'data' events; each frame
    // gets a fresh decoder whose queue is drained after every awaited write.
    const queue: Uint8Array[] = [];
    let failed: Error | null = null;
    const newDecoder = () => {
      const d = createZstdDecompress();
      d.on('data', (chunk) => queue.push(chunk));
      d.on('error', (err) => {
        failed = err ?? new Error('zstd decode failed');
      });
      return d;
    };
    let z = newDecoder();
    const write = (piece: Uint8Array) =>
      new Promise<void>((resolve, reject) => z.write(piece, () => (failed ? reject(failed) : resolve())));
    const end = () => new Promise<void>((resolve) => z.end(() => resolve()));
    const drain = async () => {
      while (queue.length > 0) await writer.write(queue.shift()!);
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        let off = 0;
        while (off < value.length) {
          const { consumed, ended } = framer.eat(value.subarray(off));
          if (consumed > 0) {
            await write(value.subarray(off, off + consumed));
            await drain();
          }
          off += consumed;
          if (ended) {
            await end();
            await drain();
            z = newDecoder();
          }
        }
      }
      await end();
      await drain();
      if (framer.inFrame) throw new Error('truncated zstd object');
      await writer.close();
    } catch (err) {
      await Promise.allSettled([reader.cancel(), writer.abort(err)]);
    }
  })();
  done.catch(() => undefined);
  return out.readable;
}

/**
 * Decompresses a stored zstd object into a `tarSize`-byte tar stream;
 * FixedLengthStream enforces the announced length.
 */
export function zstdToTar(stream: ReadableStream<Uint8Array>, tarSize: number): ReadableStream<Uint8Array> {
  const out = new FixedLengthStream(tarSize);
  const done = zstdDecompressAll(stream)
    .pipeTo(out.writable)
    .catch(() => undefined);
  done.catch(() => undefined);
  return out.readable;
}

/**
 * Streams the R2 tarball to the caller and, in step, into the cache entry.
 * Both copies advance at the pace of the slower reader, so at most a chunk is
 * held in memory; a reader that fails or goes away is dropped and the other
 * copy continues.
 */
export function streamAndStore(
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repoId: string,
  sha: string,
  tree: string,
  object: R2ObjectBody,
  opts: { encoding: 'identity' | 'zstd'; tarSize: number } = { encoding: 'identity', tarSize: object.size },
): ReadableStream<Uint8Array> {
  const client = new FixedLengthStream(object.size);
  if (object.size > MAX_CACHED_BYTES) {
    ctx.waitUntil(object.body.pipeTo(client.writable).catch(() => undefined));
    return client.readable;
  }
  const store = new FixedLengthStream(object.size);
  const stored = new Response(store.readable, {
    headers: {
      'content-type': 'application/x-tar',
      // Stored under the internal host, which no client request can address;
      // the max-age only tells the Cache API how long to keep the entry.
      'cache-control': `max-age=${IMMUTABLE_TTL_SECONDS}, immutable`,
      [TREE_HEADER]: tree,
      [SIZE_HEADER]: String(object.size),
      [ENCODING_HEADER]: opts.encoding,
      [TAR_SIZE_HEADER]: String(opts.tarSize),
    },
  });
  const storeSink = sink(store.writable);
  const put = caches.default.put(snapshotCacheKey(repoId, sha), stored).catch(() => storeSink.drop());
  ctx.waitUntil(Promise.all([put, pumpInStep(object.body, [sink(client.writable), storeSink])]));
  return client.readable;
}

interface Sink {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Rejects once the sink is dropped, so a write nobody will read cannot stall the pump. */
  dropped: Promise<never>;
  drop(): void;
}

function sink(stream: WritableStream<Uint8Array>): Sink {
  let drop: () => void = () => undefined;
  const dropped = new Promise<never>((_, reject) => {
    drop = () => reject(new Error('sink dropped'));
  });
  dropped.catch(() => undefined);
  return { writer: stream.getWriter(), dropped, drop };
}

async function pumpInStep(source: ReadableStream<Uint8Array>, sinks: Sink[]): Promise<void> {
  const reader = source.getReader();
  let live = sinks;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const results = await Promise.allSettled(live.map((s) => Promise.race([s.writer.write(value), s.dropped])));
      const failed = live.filter((_, i) => results[i]!.status === 'rejected');
      for (const s of failed) s.writer.abort().catch(() => undefined);
      live = live.filter((_, i) => results[i]!.status === 'fulfilled');
      if (live.length === 0) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    await Promise.allSettled(live.map((s) => s.writer.close()));
  } catch (err) {
    await Promise.allSettled(live.map((s) => s.writer.abort(err)));
  }
}
