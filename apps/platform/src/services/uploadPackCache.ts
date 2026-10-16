import { Effect } from 'effect';
import { lockstepTee, UPLOAD_PACK_CACHE_MAX_LAG_BYTES } from '../git/lockstepTee';
import { UploadPackResponseValidator, type PackProtocol } from '../git/packCache';

const CACHE_TTL_SECONDS = 3600;
const MAX_CACHE_API_BYTES = 512 * 1024 * 1024;
const R2_PART_BYTES = 8 * 1024 * 1024;

export interface UploadPackCacheAddress {
  cacheKey: Request;
  r2Key: string;
  fullHash: string;
  refSeq: number;
  r2Eligible: boolean;
  protocol: PackProtocol;
  sidebandAll: boolean;
}

export interface UploadPackCacheHit {
  tier: 'hit' | 'r2';
  response: Response;
}

interface WaitContext {
  waitUntil(promise: Promise<unknown>): void;
}

type MultipartUpload = Awaited<ReturnType<R2Bucket['createMultipartUpload']>>;
type UploadedPart = Awaited<ReturnType<MultipartUpload['uploadPart']>>;

function bestEffort<A>(run: () => Promise<A>): Effect.Effect<A | undefined, never> {
  return Effect.tryPromise({
    try: run,
    catch: () => new Error('upload-pack cache operation failed'),
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function cacheHeaders(contentType: string): Headers {
  return new Headers({
    'content-type': contentType,
    'cache-control': `public, max-age=${CACHE_TTL_SECONDS}`,
  });
}

const lookupEffect = Effect.fnUntraced(function* (
  env: Env,
  ctx: WaitContext,
  address: UploadPackCacheAddress,
): Effect.fn.Return<UploadPackCacheHit | null, never> {
  const edge = yield* bestEffort(() => caches.default.match(address.cacheKey));
  if (edge?.status === 200 && edge.body) {
    return { tier: 'hit', response: new Response(edge.body, { status: 200, headers: edge.headers }) };
  }
  yield* Effect.promise(() => edge?.body?.cancel().catch(() => undefined) ?? Promise.resolve());
  if (!address.r2Eligible) return null;

  const object = yield* bestEffort(() => env.SNAPSHOTS.get(address.r2Key));
  if (
    !object ||
    object.customMetadata?.key !== address.fullHash ||
    object.customMetadata?.refSeq !== String(address.refSeq) ||
    !object.customMetadata.contentType
  ) {
    yield* Effect.promise(() => object?.body.cancel().catch(() => undefined) ?? Promise.resolve());
    return null;
  }

  const contentType = object.customMetadata.contentType;
  const [client, backfill] = lockstepTee(object.body, 2, [
    {},
    { maxLagBytes: UPLOAD_PACK_CACHE_MAX_LAG_BYTES },
  ]);
  yield* Effect.sync(() => {
    const response = new Response(backfill, { status: 200, headers: cacheHeaders(contentType) });
    ctx.waitUntil(caches.default.put(address.cacheKey, response).catch(() => undefined));
  });
  return {
    tier: 'r2',
    response: new Response(client, {
      status: 200,
      headers: new Headers({ 'content-type': contentType, 'cache-control': 'no-cache' }),
    }),
  };
});

export function lookupUploadPackCache(
  env: Env,
  ctx: WaitContext,
  address: UploadPackCacheAddress,
): Promise<UploadPackCacheHit | null> {
  return Effect.runPromise(lookupEffect(env, ctx, address));
}

function validateStream(
  source: ReadableStream<Uint8Array>,
  protocol: PackProtocol,
  sidebandAll: boolean,
): ReadableStream<Uint8Array> {
  const validator = new UploadPackResponseValidator(protocol, sidebandAll);
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      validator.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      if (!validator.finish()) throw new Error('incomplete upload-pack response');
    },
  }));
}

function limitCacheApiSize(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let size = 0;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > MAX_CACHE_API_BYTES) {
        controller.error(new Error('upload-pack response exceeds Cache API limit'));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}

function putCacheApi(address: UploadPackCacheAddress, contentType: string, body: ReadableStream<Uint8Array>): Promise<void> {
  return caches.default
    .put(address.cacheKey, new Response(limitCacheApiSize(body), { status: 200, headers: cacheHeaders(contentType) }))
    .then(() => undefined)
    .catch(async () => {
      await caches.default.delete(address.cacheKey).catch(() => false);
    });
}

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  size = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
  }

  take(length: number): Uint8Array {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const first = this.chunks[0]!;
      const available = first.byteLength - this.offset;
      const count = Math.min(length - written, available);
      result.set(first.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
      this.size -= count;
      if (this.offset === first.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
    }
    return result;
  }
}

async function writeR2(
  env: Env,
  address: UploadPackCacheAddress,
  contentType: string,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  let upload: MultipartUpload | null = null;
  const parts: UploadedPart[] = [];
  const queue = new ByteQueue();
  const reader = body.getReader();
  try {
    upload = await env.SNAPSHOTS.createMultipartUpload(address.r2Key, {
      httpMetadata: { contentType },
      customMetadata: { key: address.fullHash, refSeq: String(address.refSeq), contentType },
    });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      queue.push(value);
      while (queue.size >= R2_PART_BYTES) {
        parts.push(await upload.uploadPart(parts.length + 1, queue.take(R2_PART_BYTES)));
      }
    }
    if (queue.size > 0) parts.push(await upload.uploadPart(parts.length + 1, queue.take(queue.size)));
    if (parts.length === 0) throw new Error('empty upload-pack response');
    await upload.complete(parts);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await upload?.abort().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const storeEffect = Effect.fnUntraced(function* (
  env: Env,
  address: UploadPackCacheAddress,
  contentType: string,
  source: ReadableStream<Uint8Array>,
): Effect.fn.Return<void, never> {
  const validated = validateStream(source, address.protocol, address.sidebandAll);
  const [cacheBody, r2Body] = address.r2Eligible
    ? lockstepTee(validated, 2, [
        { maxLagBytes: UPLOAD_PACK_CACHE_MAX_LAG_BYTES },
        { maxLagBytes: UPLOAD_PACK_CACHE_MAX_LAG_BYTES },
      ])
    : [validated, null];
  const tasks: Effect.Effect<void, never>[] = [Effect.promise(() => putCacheApi(address, contentType, cacheBody))];
  if (r2Body) {
    tasks.push(Effect.promise(() => writeR2(env, address, contentType, r2Body).catch(() => undefined)));
  }
  yield* Effect.all(tasks, { concurrency: 'unbounded', discard: true });
});

export function storeUploadPackResponse(
  env: Env,
  address: UploadPackCacheAddress,
  contentType: string,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  return Effect.runPromise(storeEffect(env, address, contentType, body));
}
