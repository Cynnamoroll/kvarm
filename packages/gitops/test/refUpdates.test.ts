import { describe, expect, it } from 'vitest';
import {
  buildReportStatus,
  isSafeRefName,
  isValidRefPattern,
  parseReceivePackCommands,
  pktLine,
  readPktLines,
  readReceivePackPrefix,
  refMatchesAny,
  ZERO_OID,
} from '../src/index';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const enc = new TextEncoder();
const dec = new TextDecoder();

function cat(...parts: (Uint8Array | string)[]): Uint8Array {
  const bufs = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const out = new Uint8Array(bufs.reduce((n, b) => n + b.length, 0));
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function request(cmds: string[], caps = 'report-status side-band-64k agent=git/2.47', tail = 'PACK\0\0\0\x02junk'): Uint8Array {
  const lines = cmds.map((c, i) => pktLine(i === 0 ? `${c}\0${caps}\n` : `${c}\n`));
  return cat(...lines, '0000', tail);
}

/** A stream that yields the bytes in fixed-size chunks, like a slow client upload. */
function chunked(bytes: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let off = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (off >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(off, off + size));
      off += size;
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe('parseReceivePackCommands', () => {
  it('parses commands, capabilities and the end offset', () => {
    const body = request([`${A} ${B} refs/heads/main`, `${ZERO_OID} ${B} refs/heads/new`, `${A} ${ZERO_OID} refs/heads/old`]);
    const r = parseReceivePackCommands(body);
    expect(r.status).toBe('done');
    if (r.status !== 'done') return;
    expect(r.commands).toEqual([
      { oldOid: A, newOid: B, ref: 'refs/heads/main' },
      { oldOid: ZERO_OID, newOid: B, ref: 'refs/heads/new' },
      { oldOid: A, newOid: ZERO_OID, ref: 'refs/heads/old' },
    ]);
    expect(r.capabilities).toEqual(['report-status', 'side-band-64k', 'agent=git/2.47']);
    expect(dec.decode(body.subarray(r.end, r.end + 4))).toBe('PACK');
  });

  it('skips shallow lines before the command list', () => {
    const body = cat(pktLine(`shallow ${A}\n`), request([`${A} ${B} refs/heads/main`]));
    const r = parseReceivePackCommands(body);
    expect(r).toMatchObject({ status: 'done', shallow: [A], commands: [{ ref: 'refs/heads/main' }] });
  });

  it('asks for more bytes while the command list is incomplete', () => {
    const body = request([`${A} ${B} refs/heads/main`]);
    expect(parseReceivePackCommands(body.subarray(0, 3)).status).toBe('need-more');
    expect(parseReceivePackCommands(body.subarray(0, 20)).status).toBe('need-more');
  });

  it('rejects malformed, oversized and certificate requests', () => {
    expect(parseReceivePackCommands(enc.encode('zzzz'))).toMatchObject({ status: 'error', reason: 'malformed' });
    expect(parseReceivePackCommands(cat(pktLine(`${A} ${B}\0report-status\n`), '0000'))).toMatchObject({
      status: 'error',
      reason: 'malformed',
    });
    expect(parseReceivePackCommands(cat(pktLine(`${A.slice(1)}x ${B} refs/heads/x\n`), '0000'))).toMatchObject({
      status: 'error',
      reason: 'malformed',
    });
    expect(parseReceivePackCommands(cat(pktLine('push-cert\0report-status\n'), '0000'))).toMatchObject({
      status: 'error',
      reason: 'push-cert',
    });
    const many = request(Array.from({ length: 5 }, (_, i) => `${A} ${B} refs/heads/b${i}`));
    expect(parseReceivePackCommands(many, { maxCommands: 4 })).toMatchObject({ status: 'error', reason: 'too-many-commands' });
    const long = request([`${A} ${B} refs/heads/${'x'.repeat(300)}`]);
    expect(parseReceivePackCommands(long.subarray(0, 200), { maxBytes: 100 })).toMatchObject({
      status: 'error',
      reason: 'too-large',
    });
    // Mixed hash lengths are not a valid command.
    expect(parseReceivePackCommands(cat(pktLine(`${A} ${'c'.repeat(64)} refs/heads/x\n`), '0000'))).toMatchObject({
      status: 'error',
      reason: 'malformed',
    });
  });

  it('accepts an empty command list', () => {
    expect(parseReceivePackCommands(enc.encode('0000'))).toMatchObject({ status: 'done', commands: [], end: 4 });
  });
});

describe('readReceivePackPrefix', () => {
  it('reads only the command prefix and forwards the exact original bytes', async () => {
    const body = request([`${A} ${B} refs/heads/agents/w1/a`, `${A} ${B} refs/heads/agents/w1/b`], undefined, 'PACK' + 'x'.repeat(5000));
    const prefix = await readReceivePackPrefix(chunked(body, 7));
    expect(prefix.result.status).toBe('done');
    if (prefix.result.status !== 'done') return;
    expect(prefix.result.commands.map((c) => c.ref)).toEqual(['refs/heads/agents/w1/a', 'refs/heads/agents/w1/b']);
    // Only a bounded amount was read before the decision.
    expect(prefix.bytesRead).toBeLessThan(body.length);
    expect(await drain(prefix.forward())).toEqual(body);
  });

  it('stops reading at the byte bound', async () => {
    const huge = cat(pktLine(`${A} ${B} refs/heads/${'y'.repeat(60000)}\n`), '0000');
    const prefix = await readReceivePackPrefix(chunked(huge, 1024), { maxBytes: 4096 });
    expect(prefix.result).toMatchObject({ status: 'error', reason: 'too-large' });
    expect(prefix.bytesRead).toBeLessThanOrEqual(4096 + 1024);
    await prefix.cancel();
  });

  it('reports a truncated body', async () => {
    const body = request([`${A} ${B} refs/heads/main`]).subarray(0, 30);
    const prefix = await readReceivePackPrefix(chunked(body, 8));
    expect(prefix.result).toMatchObject({ status: 'error', reason: 'truncated' });
  });
});

describe('ref names and grant patterns', () => {
  it('validates ref names like git check-ref-format', () => {
    for (const ok of ['refs/heads/main', 'refs/heads/agents/ws-1/fix_a.b', 'refs/tags/v1.0', 'refs/notes/kvarm-attribution']) {
      expect(isSafeRefName(ok), ok).toBe(true);
    }
    for (const bad of [
      'HEAD',
      'refs/heads',
      'refs/heads/',
      'refs/heads/../main',
      'refs/heads//x',
      'refs/heads/x.lock',
      'refs/heads/.hidden',
      'refs/heads/a b',
      'refs/heads/a@{1}',
      'refs/heads/a~1',
      'refs/heads/a\\b',
      'refs/heads/a.',
      'refs/heads/a*',
      'refs/heads/\x01',
    ]) {
      expect(isSafeRefName(bad), bad).toBe(false);
    }
  });

  it('validates grant patterns: exact refs or a trailing /* under refs/<kind>/', () => {
    expect(isValidRefPattern('refs/heads/agents/ws-1/*')).toBe(true);
    expect(isValidRefPattern('refs/heads/feature')).toBe(true);
    expect(isValidRefPattern('refs/heads/*')).toBe(true);
    expect(isValidRefPattern('refs/*')).toBe(false);
    expect(isValidRefPattern('*')).toBe(false);
    expect(isValidRefPattern('refs/heads/a*b')).toBe(false);
    expect(isValidRefPattern('refs/heads/agents/*/x')).toBe(false);
    expect(isValidRefPattern('refs/heads/../*')).toBe(false);
  });

  it('matches exact refs and strict prefixes only', () => {
    const grant = ['refs/heads/agents/ws-1/*', 'refs/heads/scratch'];
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-1/a')).toBe(true);
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-1/a/b')).toBe(true);
    expect(refMatchesAny(grant, 'refs/heads/scratch')).toBe(true);
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-1')).toBe(false);
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-10/a')).toBe(false);
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-2/a')).toBe(false);
    expect(refMatchesAny(grant, 'refs/heads/scratch2')).toBe(false);
    expect(refMatchesAny(grant, 'refs/heads/main')).toBe(false);
    expect(refMatchesAny(grant, 'refs/heads/agents/ws-1/../../main')).toBe(false);
  });
});

describe('buildReportStatus', () => {
  const results = [
    { ref: 'refs/heads/main', ok: false, reason: 'denied' },
    { ref: 'refs/heads/agents/w/a', ok: true },
  ];

  it('emits plain report-status pkt-lines', () => {
    const lines = readPktLines(buildReportStatus(results, 'none'));
    expect(lines.map((l) => (l.flush ? '<flush>' : dec.decode(l.data)))).toEqual([
      'unpack ok\n',
      'ng refs/heads/main denied\n',
      'ok refs/heads/agents/w/a\n',
      '<flush>',
    ]);
  });

  it('wraps report-status in side-band channel 1 when negotiated', () => {
    const outer = readPktLines(buildReportStatus(results, 'side-band-64k'));
    expect(outer.at(-1)?.flush).toBe(true);
    const band = outer.filter((l) => !l.flush);
    expect(band.every((l) => l.data[0] === 1)).toBe(true);
    const inner = cat(...band.map((l) => l.data.subarray(1)));
    expect(readPktLines(inner).map((l) => (l.flush ? '<flush>' : dec.decode(l.data)))).toEqual([
      'unpack ok\n',
      'ng refs/heads/main denied\n',
      'ok refs/heads/agents/w/a\n',
      '<flush>',
    ]);
  });

  it('splits side-band payloads at the negotiated size', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ref: `refs/heads/${'z'.repeat(20)}-${i}`, ok: false, reason: 'denied' }));
    const outer = readPktLines(buildReportStatus(many, 'side-band'));
    for (const l of outer) expect(l.data.length).toBeLessThanOrEqual(999);
    expect(outer.filter((l) => !l.flush).length).toBeGreaterThan(1);
  });
});
