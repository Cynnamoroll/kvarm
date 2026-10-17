export const RECEIVE_PACK_RETRY_MAX_BYTES = 8 * 1024 * 1024;
export const RECEIVE_PACK_BUSY_MAX_RETRIES = 3;

const BUSY_MARKER = new TextEncoder().encode('artifacts_git_receive_pack_busy');
const ERR_BUSY_PREFIX = new TextEncoder().encode('ERR artifacts_git_receive_pack_busy');
const RETRY_BACKOFF_CAPS_MS = [100, 250, 600] as const;

export interface FirstPkt {
  first: Uint8Array;
  busy: boolean;
  rest: ReadableStream<Uint8Array>;
}

function combine(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.byteLength < prefix.byteLength) return false;
  for (let i = 0; i < prefix.byteLength; i++) {
    if (bytes[i] !== prefix[i]) return false;
  }
  return true;
}

function streamWithReader(
  prefix: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < prefix.length) {
        const chunk = prefix[index++]!;
        if (chunk.byteLength > 0) controller.enqueue(chunk);
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
        } else if (value.byteLength > 0) {
          controller.enqueue(value);
        }
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel(reason) {
      if (!released) {
        await reader.cancel(reason).catch(() => undefined);
        release();
      }
    },
  });
}

export async function readFirstPkt(stream: ReadableStream<Uint8Array>): Promise<FirstPkt> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let packetLength: number | null = null;
  let handedOff = false;

  try {
    while (packetLength === null || length < packetLength) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      chunks.push(value);
      length += value.byteLength;
      if (packetLength === null && length >= 4) {
        const header = combine(chunks, length).subarray(0, 4);
        const text = String.fromCharCode(...header);
        packetLength = /^[0-9a-f]{4}$/i.test(text) ? Number.parseInt(text, 16) : 4;
        if (packetLength < 4) packetLength = 4;
      }
    }

    const first = combine(chunks, length);
    let busy = false;
    if (first.byteLength >= 4) {
      const header = String.fromCharCode(...first.subarray(0, 4));
      const size = /^[0-9a-f]{4}$/i.test(header) ? Number.parseInt(header, 16) : 0;
      if (size >= 4 && size <= first.byteLength) {
        const payload = first.subarray(4, size);
        busy =
          (payload[0] === 3 && startsWith(payload.subarray(1), BUSY_MARKER)) ||
          startsWith(payload, ERR_BUSY_PREFIX);
      }
    }

    handedOff = true;
    return { first, busy, rest: streamWithReader([], reader) };
  } finally {
    if (!handedOff) reader.releaseLock();
  }
}

export async function bufferReceivePackBody(
  body: ReadableStream<Uint8Array>,
  contentLength: string | null,
): Promise<{ body: Uint8Array | ReadableStream<Uint8Array>; retryBody: Uint8Array | null }> {
  const declaredLength = contentLength?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > RECEIVE_PACK_RETRY_MAX_BYTES) {
      return { body, retryBody: null };
    }
  }

  const reader = body.getReader();
  let buffered = new Uint8Array(0);
  let length = 0;
  let handedOff = false;
  const append = (chunk: Uint8Array) => {
    const required = length + chunk.byteLength;
    if (required > buffered.byteLength) {
      const capacity = Math.min(
        RECEIVE_PACK_RETRY_MAX_BYTES,
        Math.max(required, buffered.byteLength === 0 ? 64 * 1024 : buffered.byteLength * 2),
      );
      const expanded = new Uint8Array(capacity);
      expanded.set(buffered.subarray(0, length));
      buffered = expanded;
    }
    buffered.set(chunk, length);
    length = required;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        const bytes = buffered.slice(0, length);
        return { body: bytes, retryBody: bytes };
      }
      if (value.byteLength === 0) continue;
      const remaining = RECEIVE_PACK_RETRY_MAX_BYTES - length;
      if (value.byteLength > remaining) {
        if (remaining > 0) append(value.subarray(0, remaining));
        const prefix: Uint8Array[] = length > 0 ? [buffered.subarray(0, length)] : [];
        prefix.push(value.subarray(remaining));
        handedOff = true;
        return { body: streamWithReader(prefix, reader), retryBody: null };
      }
      append(value);
    }
  } finally {
    if (!handedOff) reader.releaseLock();
  }
}

export function restoreFirstPkt(first: Uint8Array, rest: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = rest.getReader();
  return streamWithReader(first.byteLength === 0 ? [] : [first], reader);
}

export interface ReceivePackAttemptTiming {
  start(): void;
  mark(): void;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(completed);
    };
    const aborted = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export async function fetchReceivePackWithBusyRetry(
  url: string,
  init: RequestInit,
  retryBody: Uint8Array | null,
  signal: AbortSignal,
  repoId: string,
  timing?: ReceivePackAttemptTiming,
): Promise<Response> {
  let retries = 0;
  try {
    for (;;) {
      const attemptInit = retryBody === null ? init : { ...init, body: retryBody.slice() };
      timing?.start();
      const response = await fetch(url, attemptInit);
      timing?.mark();
      if (retryBody === null || !response.ok || !response.body) return response;

      const first = await readFirstPkt(response.body);
      if (!first.busy || retries >= RECEIVE_PACK_BUSY_MAX_RETRIES) {
        return new Response(restoreFirstPkt(first.first, first.rest), response);
      }

      await first.rest.cancel().catch(() => undefined);
      const delay = Math.floor(Math.random() * RETRY_BACKOFF_CAPS_MS[retries]!);
      if (!(await waitForRetry(delay, signal))) {
        throw signal.reason ?? new Error('receive-pack retry aborted');
      }
      retries++;
    }
  } finally {
    if (retries > 0) console.log(JSON.stringify({ receivePackBusyRetry: retries, repoId }));
  }
}
