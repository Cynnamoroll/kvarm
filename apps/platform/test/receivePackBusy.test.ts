import { env as cfEnv } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildReportStatus, concat, FLUSH_PKT, pktLine, ZERO_OID } from '@kvarm/gitops';
import { mintPAT, type Scope } from '../src/auth/pat';
import {
  bufferReceivePackBody,
  readFirstPkt,
  RECEIVE_PACK_RETRY_MAX_BYTES,
} from '../src/services/receivePackBusy';
import { ORIGIN, send } from './helpers/http';
import { fakeArtifacts, installFakeGitRemote, restoreFetch, type FakeRepo } from './helpers/fakeArtifacts';
import { seedRepoWithCommit, seedUser } from './helpers/seed';

const env = { ...(cfEnv as unknown as Env), ARTIFACTS: fakeArtifacts, GIT_MIRROR_MODE: 'off' } as Env;
const OWNER = 'receive-pack-busy';
const FULL: Scope[] = ['read', 'write', 'api'];
const enc = new TextEncoder();
const busyMessage = 'artifacts_git_receive_pack_busy';
const busyReply = pktLine(concat(new Uint8Array([3]), enc.encode(`${busyMessage}\n`)));
const unrelatedError = pktLine(concat(new Uint8Array([3]), enc.encode('fatal: unrelated error\n')));
let token = '';

interface Fixture {
  id: string;
  name: string;
  repo: FakeRepo;
}

async function fixture(label: string): Promise<Fixture> {
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const seeded = await seedRepoWithCommit(env, name, { owner: OWNER, visibility: 'public' });
  return { id: seeded.id, name, repo: seeded.repo };
}

function pushBody(ref = 'refs/heads/retry', suffix = 'PACK-fake'): Uint8Array {
  return concat(
    pktLine(`${ZERO_OID} ${'c'.repeat(40)} ${ref}\0report-status agent=git/2.56\n`),
    FLUSH_PKT,
    enc.encode(suffix),
  );
}

async function push(f: Fixture, body = pushBody()) {
  return send(
    env,
    new Request(`${ORIGIN}/${OWNER}/${f.name}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`x:${token}`)}`,
        'content-type': 'application/x-git-receive-pack-request',
      },
      body,
    }),
  );
}

function response(body: Uint8Array): Response {
  return new Response(body, { headers: { 'content-type': 'application/x-git-receive-pack-result' } });
}

function chunks(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[index++];
      if (!part) controller.close();
      else controller.enqueue(part);
    },
  });
}

async function streamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function fingerprint(bytes: Uint8Array): { length: number; hash: number } {
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return { length: bytes.byteLength, hash: hash >>> 0 };
}

async function streamFingerprint(stream: ReadableStream<Uint8Array>): Promise<{ length: number; hash: number }> {
  const reader = stream.getReader();
  let length = 0;
  let hash = 2166136261;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { length, hash: hash >>> 0 };
    length += value.byteLength;
    for (const byte of value) hash = Math.imul(hash ^ byte, 16777619);
  }
}

async function refSequence(repoId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT ref_seq FROM repos WHERE id = ?').bind(repoId).first<{ ref_seq: number }>();
  return row!.ref_seq;
}

beforeAll(async () => {
  const userId = await seedUser(env, OWNER);
  token = (await mintPAT(env, userId, 'receive-pack-busy', FULL)).token;
  installFakeGitRemote();
});

afterAll(() => restoreFetch());

describe('readFirstPkt', () => {
  it('detects a band-3 Artifacts busy response', async () => {
    const result = await readFirstPkt(chunks([busyReply, FLUSH_PKT]));
    expect(result.busy).toBe(true);
    expect(await streamBytes(result.rest)).toEqual(FLUSH_PKT);
  });

  it('detects an unbanded ERR Artifacts busy response', async () => {
    const reply = pktLine(`ERR ${busyMessage}\n`);
    const result = await readFirstPkt(chunks([reply]));
    expect(result.busy).toBe(true);
    expect(result.first).toEqual(reply);
  });

  it('does not classify unrelated band-3 errors as busy', async () => {
    const result = await readFirstPkt(chunks([unrelatedError]));
    expect(result.busy).toBe(false);
    expect(result.first).toEqual(unrelatedError);
  });

  it('leaves a normal report-status packet unchanged', async () => {
    const report = pktLine('unpack ok\n');
    const result = await readFirstPkt(chunks([report, FLUSH_PKT]));
    expect(result.busy).toBe(false);
    expect(result.first).toEqual(report);
    expect(await streamBytes(result.rest)).toEqual(FLUSH_PKT);
  });

  it('handles a first packet split into one-byte chunks', async () => {
    const reply = concat(busyReply, pktLine('unpack ok\n'), FLUSH_PKT);
    const result = await readFirstPkt(chunks(Array.from(reply, (byte) => new Uint8Array([byte]))));
    expect(result.busy).toBe(true);
    expect(result.first).toEqual(busyReply);
    expect(concat(result.first, await streamBytes(result.rest))).toEqual(reply);
  });

  it('preserves a flush packet and empty streams', async () => {
    const flush = await readFirstPkt(chunks([FLUSH_PKT]));
    expect(flush.busy).toBe(false);
    expect(flush.first).toEqual(FLUSH_PKT);
    const short = await readFirstPkt(chunks([enc.encode('000')]));
    expect(short.busy).toBe(false);
    expect(short.first).toEqual(enc.encode('000'));
    const empty = await readFirstPkt(chunks([]));
    expect(empty.busy).toBe(false);
    expect(empty.first).toEqual(new Uint8Array());
    expect(await streamBytes(empty.rest)).toEqual(new Uint8Array());
  });
});

describe('receive-pack body buffering', () => {
  it('buffers a body within the retry limit', async () => {
    const body = enc.encode('small request');
    const replayable = await bufferReceivePackBody(chunks([body]), String(body.byteLength));
    expect(replayable.body).toEqual(body);
    expect(replayable.retryBody).toEqual(body);
  });

  it('preserves an unknown-length body over the limit as a stream', async () => {
    const body = new Uint8Array(RECEIVE_PACK_RETRY_MAX_BYTES + 8).fill(0x5a);
    body.set(enc.encode('overflow'), RECEIVE_PACK_RETRY_MAX_BYTES);
    const replayable = await bufferReceivePackBody(chunks([body]), null);
    expect(replayable.retryBody).toBeNull();
    expect(replayable.body).toBeInstanceOf(ReadableStream);
    expect(await streamFingerprint(replayable.body as ReadableStream<Uint8Array>)).toEqual(fingerprint(body));
  });

  it('does not read a body whose declared length exceeds the limit', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('streamed'));
        controller.close();
      },
    });
    const replayable = await bufferReceivePackBody(body, String(RECEIVE_PACK_RETRY_MAX_BYTES + 1));
    expect(replayable.retryBody).toBeNull();
    expect(replayable.body).toBe(body);
    expect(await streamBytes(replayable.body as ReadableStream<Uint8Array>)).toEqual(enc.encode('streamed'));
  });
});

describe('receive-pack busy retry', () => {
  it('retries identical request bytes and records a confirmed push once', async () => {
    const f = await fixture('success');
    const received: Uint8Array[] = [];
    const ok = buildReportStatus([{ ref: 'refs/heads/retry', ok: true }], 'side-band-64k');
    f.repo.gitRemoteHandler = async (_url, request) => {
      received.push(new Uint8Array(await request.arrayBuffer()));
      return received.length === 1 ? response(concat(busyReply, FLUSH_PKT)) : response(ok);
    };
    const before = await refSequence(f.id);
    const log = vi.spyOn(console, 'log');

    try {
      const result = await push(f);

      expect(result.status).toBe(200);
      expect(result.bytes).toEqual(ok);
      expect(received).toHaveLength(2);
      expect(received[0]).toEqual(received[1]);
      expect(result.cost.sub).toBe(2);
      expect(await refSequence(f.id)).toBe(before + 1);
      expect(log.mock.calls.filter(([line]) => String(line).includes('"receivePackBusyRetry"'))).toEqual([
        [JSON.stringify({ receivePackBusyRetry: 1, repoId: f.id })],
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it('passes the fourth busy reply through unchanged after three retries', async () => {
    const f = await fixture('exhausted');
    let calls = 0;
    const reply = concat(busyReply, FLUSH_PKT);
    f.repo.gitRemoteHandler = async (_url, request) => {
      await request.arrayBuffer();
      calls++;
      return response(reply);
    };

    const result = await push(f);

    expect(result.status).toBe(200);
    expect(result.bytes).toEqual(reply);
    expect(calls).toBe(4);
    expect(result.cost.sub).toBe(4);
  });

  it('does not retry an over-limit request body', async () => {
    const f = await fixture('oversized');
    let calls = 0;
    let receivedLength = 0;
    const reply = concat(busyReply, FLUSH_PKT);
    f.repo.gitRemoteHandler = async (_url, request) => {
      receivedLength = (await request.arrayBuffer()).byteLength;
      calls++;
      return response(reply);
    };
    const body = concat(pushBody('refs/heads/retry', ''), new Uint8Array(RECEIVE_PACK_RETRY_MAX_BYTES + 1));

    const result = await push(f, body);

    expect(result.bytes).toEqual(reply);
    expect(calls).toBe(1);
    expect(receivedLength).toBe(body.byteLength);
    expect(result.cost.sub).toBe(1);
  });

  it('does not retry a different band-3 error', async () => {
    const f = await fixture('unrelated');
    let calls = 0;
    const reply = concat(unrelatedError, FLUSH_PKT);
    f.repo.gitRemoteHandler = async (_url, request) => {
      await request.arrayBuffer();
      calls++;
      return response(reply);
    };

    const result = await push(f);

    expect(result.bytes).toEqual(reply);
    expect(calls).toBe(1);
    expect(result.cost.sub).toBe(1);
  });
});
