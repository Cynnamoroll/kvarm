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

import { markCache } from '../cost/meter';

const IMMUTABLE_TTL_SECONDS = 31536000;
const TREE_HEADER = 'x-kvarm-snapshot-tree';
const SIZE_HEADER = 'x-kvarm-snapshot-size';
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
  size: number;
  tree: string;
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
  markCache('hit');
  return { body: hit.body, size, tree };
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
