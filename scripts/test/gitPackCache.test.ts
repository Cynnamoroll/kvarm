import { describe, expect, it } from 'vitest';
import { concat, DELIM_PKT, FLUSH_PKT, pktLine } from '@kvarm/gitops';
import {
  classifyUploadPackRequest,
  derivePackCacheKey,
  derivePackCacheSlotHash,
  UploadPackResponseValidator,
} from '../../apps/platform/src/git/packCache';
import { lockstepTee } from '../../apps/platform/src/git/lockstepTee';
import {
  artifactsSidebandAllResponseBase64,
  artifactsWithoutSidebandAllResponseBase64,
} from '../../apps/platform/test/gitPackCacheResponse.fixture';

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

function v2Request(lines: string[], headers: string[] = ['command=fetch\n', 'object-format=sha1\n']): Uint8Array {
  return concat(
    ...headers.map(pktLine),
    DELIM_PKT,
    ...lines.map(pktLine),
    FLUSH_PKT,
  );
}

async function readBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

describe('upload-pack request cache classification', () => {
  it('normalizes volatile fields and want/have/shallow order without changing other argument order', () => {
    const first = classifyUploadPackRequest(
      v2Request(
        [`want ${OID_B}\n`, `have ${OID_B}\n`, `want ${OID_A}\n`, `shallow ${OID_B}\n`, 'filter blob:none\n', 'done\n'],
        ['command=fetch\n', 'agent=git/2.45.0\n', 'session-id=session-a\n', 'object-format=sha1\n'],
      ),
      'v2',
    );
    const second = classifyUploadPackRequest(
      v2Request(
        [`shallow ${OID_B}\n`, `want ${OID_A}\n`, `have ${OID_B}\n`, `want ${OID_B}\n`, 'filter blob:none\n', 'done\n'],
        ['command=fetch\n', 'agent=git/2.46.0\n', 'session-id=session-b\n', 'object-format=sha1\n'],
      ),
    );

    expect(first.cacheable).toBe(true);
    expect(first.normalized).toBe(second.normalized);
    expect(first.normalized).toContain('object-format=sha1');
    expect(first.normalized).not.toContain('agent=');
    expect(first.normalized).not.toContain('session-id=');
  });

  it('passes unknown request lines through as uncacheable', () => {
    const request = classifyUploadPackRequest(v2Request(['want-ref refs/heads/main\n', 'done\n', 'unknown-option value\n']));

    expect(request.cacheable).toBe(false);
    expect(request.normalized).toBeNull();
  });

  it('accepts system Git v2 packets without trailing line feeds', () => {
    const request = classifyUploadPackRequest(concat(
      pktLine('command=fetch'),
      pktLine('agent=git/2.34.1'),
      pktLine('object-format=sha1'),
      DELIM_PKT,
      pktLine(`want ${OID_A}`),
      pktLine('done'),
      FLUSH_PKT,
    ));

    expect(request.cacheable).toBe(true);
  });

  it('records sideband-all in the request classification', () => {
    const withSideband = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, 'sideband-all\n', 'done\n']));
    const withoutSideband = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, 'done\n']));

    expect(withSideband.sidebandAll).toBe(true);
    expect(withoutSideband.sidebandAll).toBe(false);
  });

  it('keeps include-tag in the normalized key and scopes keys by ref_seq', async () => {
    const body = concat(
      pktLine(`want ${OID_A}\0include-tag side-band-64k agent=git/2.45.0\n`),
      FLUSH_PKT,
      pktLine('done\n'),
    );
    const request = classifyUploadPackRequest(body, 'v0');
    const withoutTag = classifyUploadPackRequest(
      concat(pktLine(`want ${OID_A}\0side-band-64k agent=git/2.45.0\n`), FLUSH_PKT, pktLine('done\n')),
      'v0',
    );

    expect(request.cacheable).toBe(true);
    expect(request.normalized).toContain('include-tag');
    expect(await derivePackCacheKey('repo-a', 17, 'v0', request.normalized!))
      .not.toBe(await derivePackCacheKey('repo-a', 18, 'v0', request.normalized!));
    expect(await derivePackCacheKey('repo-a', 17, 'v0', request.normalized!))
      .not.toBe(await derivePackCacheKey('repo-a', 17, 'v0', withoutTag.normalized!));
  });

  it('derives R2 slots from clone shape while excluding negotiated object IDs', async () => {
    const fullA = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, `have ${OID_B}\n`, `shallow ${OID_A}\n`, 'done\n']));
    const fullB = classifyUploadPackRequest(v2Request([`want ${OID_B}\n`, `have ${OID_A}\n`, `shallow ${OID_B}\n`, 'done\n']));
    const deepen = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, 'deepen 1\n', 'done\n']));
    const filtered = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, 'filter blob:none\n', 'done\n']));
    const v0 = classifyUploadPackRequest(
      concat(pktLine(`want ${OID_A}\0side-band-64k\n`), FLUSH_PKT, pktLine('done\n')),
      'v0',
    );

    const fullSlot = await derivePackCacheSlotHash('repo-a', 'v2', fullA.normalized!);
    expect(await derivePackCacheSlotHash('repo-a', 'v2', fullB.normalized!)).toBe(fullSlot);
    expect(await derivePackCacheSlotHash('repo-a', 'v2', deepen.normalized!)).not.toBe(fullSlot);
    expect(await derivePackCacheSlotHash('repo-a', 'v2', filtered.normalized!)).not.toBe(fullSlot);
    expect(await derivePackCacheSlotHash('repo-a', 'v2', filtered.normalized!))
      .not.toBe(await derivePackCacheSlotHash('repo-a', 'v2', deepen.normalized!));
    expect(await derivePackCacheSlotHash('repo-b', 'v2', fullA.normalized!)).not.toBe(fullSlot);
    expect(await derivePackCacheSlotHash('repo-a', 'v0', v0.normalized!)).not.toBe(fullSlot);
  });

  it('excludes requests with haves from the R2 tier', () => {
    const request = classifyUploadPackRequest(v2Request([`want ${OID_A}\n`, `have ${OID_B}\n`, 'done\n']));

    expect(request.cacheable).toBe(true);
    expect(request.hasHaves).toBe(true);
    expect(request.r2Eligible).toBe(false);
  });
});

describe('upload-pack response completeness', () => {
  it('requires a complete packfile response ending in a flush packet', () => {
    const response = concat(
      pktLine('acknowledgments\n'),
      DELIM_PKT,
      pktLine('packfile\n'),
      pktLine(new Uint8Array([1, 80, 65, 67, 75])),
      FLUSH_PKT,
    );
    const validator = new UploadPackResponseValidator('v2');
    for (let offset = 0; offset < response.length; offset += 3) {
      validator.push(response.subarray(offset, Math.min(offset + 3, response.length)));
    }

    expect(validator.finish()).toBe(true);
  });

  it('validates captured Artifacts responses with and without sideband-all', () => {
    const sidebandAll = new UploadPackResponseValidator('v2', true);
    const sidebandBytes = fromBase64(artifactsSidebandAllResponseBase64);
    for (let offset = 0; offset < sidebandBytes.length; offset += 7) {
      sidebandAll.push(sidebandBytes.subarray(offset, Math.min(offset + 7, sidebandBytes.length)));
    }

    const withoutSidebandAll = new UploadPackResponseValidator('v2', false);
    withoutSidebandAll.push(fromBase64(artifactsWithoutSidebandAllResponseBase64));

    expect(sidebandAll.finish()).toBe(true);
    expect(withoutSidebandAll.finish()).toBe(true);
  });

  it('requires sideband framing and rejects error bands and band-1 ERR payloads', () => {
    const encoder = new TextEncoder();
    const sidebandPacket = (band: number, payload: string) => pktLine(concat(Uint8Array.of(band), encoder.encode(payload)));
    const invalidResponses = [
      concat(sidebandPacket(3, 'fatal error\n'), FLUSH_PKT),
      concat(sidebandPacket(1, 'ERR not found\n'), FLUSH_PKT),
      concat(pktLine('packfile\n'), sidebandPacket(1, 'PACK'), FLUSH_PKT),
      concat(sidebandPacket(1, 'packfile\n'), pktLine('PACK'), FLUSH_PKT),
    ];
    const valid = new UploadPackResponseValidator('v2', true);
    valid.push(concat(
      sidebandPacket(1, 'keepalive\n'),
      pktLine(Uint8Array.of(1)),
      sidebandPacket(2, 'progress\n'),
      sidebandPacket(1, 'packfile\n'),
      sidebandPacket(1, 'PACK'),
      FLUSH_PKT,
    ));

    expect(valid.finish()).toBe(true);
    for (const response of invalidResponses) {
      const validator = new UploadPackResponseValidator('v2', true);
      validator.push(response);
      expect(validator.finish()).toBe(false);
    }
    const withDelimiter = new UploadPackResponseValidator('v2', true);
    withDelimiter.push(concat(
      sidebandPacket(1, 'shallow-info\n'),
      sidebandPacket(1, `shallow ${OID_A}\n`),
      DELIM_PKT,
      sidebandPacket(1, 'packfile\n'),
      sidebandPacket(1, 'PACK'),
      FLUSH_PKT,
    ));
    expect(withDelimiter.finish()).toBe(true);
  });

  it('rejects ERR responses, missing final flushes, and truncated packets', () => {
    const errorResponse = new UploadPackResponseValidator('v2');
    errorResponse.push(pktLine('ERR not found\n'));
    errorResponse.push(FLUSH_PKT);
    expect(errorResponse.finish()).toBe(false);

    const noFlush = new UploadPackResponseValidator('v2');
    noFlush.push(concat(pktLine('packfile\n'), pktLine(new Uint8Array([1, 80, 65, 67, 75]))));
    expect(noFlush.finish()).toBe(false);

    const truncated = new UploadPackResponseValidator('v2');
    truncated.push(new TextEncoder().encode('000ap'));
    expect(truncated.finish()).toBe(false);
  });
});

describe('lockstep upload-pack stream tee', () => {
  it('does not read more than one chunk ahead of a branch that is not reading', async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 64) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(1024 * 1024);
        chunk[0] = pulls++;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    const [fast, slow] = lockstepTee(source, 2);
    const fastReader = fast.getReader();
    const slowReader = slow.getReader();
    const firstFastPromise = fastReader.read();
    const firstSlowPromise = slowReader.read();
    const [firstFast, firstSlow] = await Promise.all([firstFastPromise, firstSlowPromise]);
    expect(firstFast.done).toBe(false);
    expect(firstSlow.done).toBe(false);
    expect(pulls).toBe(1);

    const nextFast = fastReader.read();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(pulls).toBe(1);

    const nextSlow = slowReader.read();
    let fastChunks = 1;
    let slowChunks = 1;
    const fastDrain = (async () => {
      let result = await nextFast;
      while (!result.done) {
        fastChunks++;
        result = await fastReader.read();
      }
    })();
    const slowDrain = (async () => {
      let result = await nextSlow;
      while (!result.done) {
        slowChunks++;
        result = await slowReader.read();
      }
    })();
    await Promise.all([fastDrain, slowDrain]);

    expect(pulls).toBe(64);
    expect(fastChunks).toBe(64);
    expect(slowChunks).toBe(64);
  });

  it('lets a surviving store branch finish after the client cancels', async () => {
    let next = 0;
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next === 4) {
          controller.close();
          return;
        }
        controller.enqueue(Uint8Array.of(++next));
      },
      cancel() {
        sourceCancelled = true;
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2);
    let finalized = false;
    const storeFinished = (async () => {
      const reader = store.getReader();
      while (!(await reader.read()).done) {}
      finalized = true;
    })();
    const clientReader = client.getReader();
    expect((await clientReader.read()).value).toEqual(Uint8Array.of(1));
    await clientReader.cancel();
    await storeFinished;

    expect(finalized).toBe(true);
    expect(sourceCancelled).toBe(false);
  });

  it('cancels the source only after every branch cancels', async () => {
    let sourceCancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Uint8Array.of(1));
      },
      cancel() {
        sourceCancelled = true;
      },
    }, { highWaterMark: 0 });
    const [first, second] = lockstepTee(source, 2);
    const firstReader = first.getReader();
    const secondReader = second.getReader();
    await Promise.all([firstReader.read(), secondReader.read()]);
    await firstReader.cancel();

    expect(sourceCancelled).toBe(false);
    await secondReader.cancel();
    expect(sourceCancelled).toBe(true);
  });

  it('keeps client bytes intact when the store branch cancels', async () => {
    const sourceBytes = [1, 2, 3, 4].map((value) => Uint8Array.of(value));
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === sourceBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(sourceBytes[index++]!);
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2);
    const storeReader = store.getReader();
    const clientReader = client.getReader();
    const [storeFirst, clientFirst] = await Promise.all([storeReader.read(), clientReader.read()]);
    expect(storeFirst.value).toEqual(sourceBytes[0]);
    expect(clientFirst.value).toEqual(sourceBytes[0]);
    await storeReader.cancel();

    const received = [clientFirst.value!];
    for (;;) {
      const next = await clientReader.read();
      if (next.done) break;
      received.push(next.value);
    }
    expect(concat(...received)).toEqual(concat(...sourceBytes));
  });

  it('keeps client bytes intact when the store branch errors', async () => {
    const sourceBytes = [1, 2, 3, 4].map((value) => Uint8Array.of(value));
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === sourceBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(sourceBytes[index++]!);
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2);
    const failingStore = store.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk[0] === 2) throw new Error('simulated R2 write failure');
        controller.enqueue(chunk);
      },
    }));
    const clientReader = client.getReader();
    const storeReader = failingStore.getReader();
    const firstClientPromise = clientReader.read();
    const firstStorePromise = storeReader.read();
    const [firstClient, firstStore] = await Promise.all([firstClientPromise, firstStorePromise]);
    expect(firstClient.done).toBe(false);
    expect(firstStore.value).toEqual(sourceBytes[0]);
    const secondClient = clientReader.read();
    await expect(storeReader.read()).rejects.toThrow('simulated R2 write failure');
    const second = await secondClient;
    expect(second.done).toBe(false);
    const received = [firstClient.value!, second.value!];
    for (;;) {
      const next = await clientReader.read();
      if (next.done) break;
      received.push(next.value);
    }

    expect(concat(...received)).toEqual(concat(...sourceBytes));
  });

  it('delivers identical bytes to every branch', async () => {
    const sourceBytes = [new Uint8Array([0, 1]), new Uint8Array([2, 3, 4]), new Uint8Array([5])];
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === sourceBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(sourceBytes[index++]!);
      },
    }, { highWaterMark: 0 });
    const [left, right] = lockstepTee(source, 2);
    const [leftBytes, rightBytes] = await Promise.all([readBytes(left), readBytes(right)]);

    expect(leftBytes).toEqual(concat(...sourceBytes));
    expect(rightBytes).toEqual(leftBytes);
  });

  it('lets the client finish while a store branch is paused below its lag limit', async () => {
    const sourceBytes = [1, 2, 3, 4].map((value) => Uint8Array.of(value));
    let index = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === sourceBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(sourceBytes[index++]!);
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2, [{}, { maxLagBytes: 8 }]);

    expect(await readBytes(client)).toEqual(concat(...sourceBytes));
    expect(await readBytes(store)).toEqual(concat(...sourceBytes));
  });

  it('drops a store branch over its lag limit without changing client bytes', async () => {
    const sourceBytes = [Uint8Array.of(1, 2), Uint8Array.of(3, 4), Uint8Array.of(5, 6)];
    let index = 0;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (index === sourceBytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(sourceBytes[index++]!);
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2, [{}, { maxLagBytes: 3 }]);
    const storeReader = store.getReader();
    let pullsAtDrop = 0;
    const storeDropped = storeReader.closed.then(
      () => false,
      () => {
        pullsAtDrop = pulls;
        return true;
      },
    );

    expect(await readBytes(client)).toEqual(concat(...sourceBytes));
    expect(await storeDropped).toBe(true);
    expect(pullsAtDrop).toBe(2);
  });

  it('bounds a stalled store queue to its lag limit plus one source chunk', async () => {
    const chunkSize = 1024 * 1024;
    const maxLagBytes = 2 * chunkSize;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 64) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(chunkSize);
        chunk[0] = pulls++;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    const [client, store] = lockstepTee(source, 2, [{}, { maxLagBytes }]);
    const storeReader = store.getReader();
    let pullsAtDrop = 0;
    const storeDropped = storeReader.closed.then(
      () => false,
      () => {
        pullsAtDrop = pulls;
        return true;
      },
    );
    const reader = client.getReader();
    let clientBytes = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      clientBytes += next.value.byteLength;
    }

    expect(await storeDropped).toBe(true);
    expect(pullsAtDrop * chunkSize).toBe(maxLagBytes + chunkSize);
    expect(pullsAtDrop * chunkSize).toBeLessThanOrEqual(maxLagBytes + chunkSize);
    expect(clientBytes).toBe(64 * chunkSize);
    expect(pulls).toBe(64);
  });
});
