import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReportStatus, confirmedRefs, pktLine, ReportStatusReader, type ReportStatus } from '../src/index';

const enc = new TextEncoder();

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

/** One side-band packet on `band` carrying `payload`. */
function band(n: 1 | 2 | 3, payload: Uint8Array | string): Uint8Array {
  const bytes = typeof payload === 'string' ? enc.encode(payload) : payload;
  return pktLine(cat(new Uint8Array([n]), bytes));
}

function read(bytes: Uint8Array, chunk = bytes.length): ReportStatus {
  const r = new ReportStatusReader();
  for (let off = 0; off < bytes.length; off += chunk) r.push(bytes.subarray(off, off + chunk));
  return r.result();
}

describe('ReportStatusReader', () => {
  it('reads a plain report-status with ok and ng refs', () => {
    const body = buildReportStatus(
      [
        { ref: 'refs/heads/main', ok: true },
        { ref: 'refs/heads/old', ok: false, reason: 'non-fast-forward' },
      ],
      'none',
    );
    const r = read(body);
    expect(r.sideband).toBe(false);
    expect(r.unpack).toBe('ok');
    expect(r.complete).toBe(true);
    expect(r.refs).toEqual([
      { ref: 'refs/heads/main', ok: true },
      { ref: 'refs/heads/old', ok: false, reason: 'non-fast-forward' },
    ]);
    expect(confirmedRefs(r)).toEqual(['refs/heads/main']);
  });

  it('demultiplexes side-band-64k and ignores progress on band 2, byte by byte', () => {
    const inner = buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'none');
    const body = cat(
      band(2, 'Resolving deltas: 100% (3/3)\r'),
      band(1, inner.subarray(0, 7)),
      band(2, 'remote: done\n'),
      band(1, inner.subarray(7)),
      '0000',
    );
    for (const chunk of [1, 3, body.length]) {
      const r = read(body, chunk);
      expect(r.sideband).toBe(true);
      expect(r.unpack).toBe('ok');
      expect(r.complete).toBe(true);
      expect(confirmedRefs(r)).toEqual(['refs/heads/main']);
    }
  });

  it('matches the side-band framing buildReportStatus produces for git clients', () => {
    const body = buildReportStatus(
      [
        { ref: 'refs/heads/a', ok: true },
        { ref: 'refs/heads/b', ok: true },
      ],
      'side-band-64k',
    );
    expect(confirmedRefs(read(body, 5))).toEqual(['refs/heads/a', 'refs/heads/b']);
  });

  it('confirms nothing when unpack failed', () => {
    const body = cat(pktLine('unpack index-pack abnormal exit\n'), pktLine('ng refs/heads/main unpacker error\n'), '0000');
    const r = read(body);
    expect(r.unpack).toBe('index-pack abnormal exit');
    expect(confirmedRefs(r)).toEqual([]);
  });

  it('confirms nothing for a truncated report (no terminating flush)', () => {
    const full = buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'none');
    const r = read(full.subarray(0, full.length - 4));
    expect(r.complete).toBe(false);
    expect(confirmedRefs(r)).toEqual([]);
  });

  it('confirms nothing after a fatal error on band 3', () => {
    const inner = buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'none');
    const r = read(cat(band(3, 'fatal: out of memory\n'), band(1, inner), '0000'));
    expect(r.fatal).toBe('fatal: out of memory');
    expect(confirmedRefs(r)).toEqual([]);
  });

  it('skips report-status-v2 option lines', () => {
    const body = cat(
      pktLine('unpack ok\n'),
      pktLine('ok refs/for/main\n'),
      pktLine('option refname refs/changes/1\n'),
      pktLine('option new-oid ' + 'c'.repeat(40) + '\n'),
      '0000',
    );
    expect(confirmedRefs(read(body))).toEqual(['refs/for/main']);
  });

  it('stops collecting past its byte bound and then confirms nothing', () => {
    const r = new ReportStatusReader({ maxBytes: 64 });
    const lines = Array.from({ length: 10 }, (_, i) => pktLine(`ok refs/heads/branch-${i}\n`));
    r.push(cat(pktLine('unpack ok\n'), ...lines, '0000'));
    const out = r.result();
    expect(out.overflow).toBe(true);
    expect(confirmedRefs(out)).toEqual([]);
  });

  it('treats malformed framing as unconfirmed rather than throwing', () => {
    const r = new ReportStatusReader();
    r.push(enc.encode('zzzz not a pkt line'));
    expect(r.result().malformed).toBe(true);
    expect(confirmedRefs(r.result())).toEqual([]);
  });

  it('ignores bytes after the outer flush', () => {
    const body = cat(buildReportStatus([{ ref: 'refs/heads/main', ok: true }], 'side-band-64k'), 'garbage');
    expect(confirmedRefs(read(body))).toEqual(['refs/heads/main']);
  });
});

describe('ReportStatusReader against real git receive-pack', () => {
  function git(cwd: string, args: string[], input?: Uint8Array): Buffer {
    const r = spawnSync('git', args, { cwd, input, maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
    return r.stdout;
  }

  /** The stateless-rpc response real receive-pack sends for one ref command. */
  function receivePack(bare: string, src: string, oldOid: string, newOid: string, caps: string): Uint8Array {
    const pack = git(src, ['pack-objects', '--stdout', '--revs', '-q'], enc.encode(`${newOid}\n${oldOid === '0'.repeat(40) ? '' : `^${oldOid}\n`}`));
    const request = cat(pktLine(`${oldOid} ${newOid} refs/heads/main\0${caps}\n`), '0000', pack);
    return git(bare, ['receive-pack', '--stateless-rpc', '.'], request);
  }

  it('confirms a real create and rejects a real non-fast-forward, with and without side-band', () => {
    const root = mkdtempSync(join(tmpdir(), 'report-status-'));
    try {
      const src = join(root, 'src');
      const bare = join(root, 'bare.git');
      spawnSync('git', ['init', '-q', '-b', 'main', src]);
      spawnSync('git', ['init', '-q', '--bare', bare]);
      git(bare, ['config', 'receive.denyNonFastForwards', 'true']);
      writeFileSync(join(src, 'a.txt'), 'one\n');
      git(src, ['add', 'a.txt']);
      git(src, ['commit', '-q', '-m', 'one']);
      const first = git(src, ['rev-parse', 'HEAD']).toString().trim();
      const zero = '0'.repeat(40);

      for (const caps of ['report-status side-band-64k agent=test', 'report-status agent=test']) {
        const fresh = join(root, `bare-${caps.length}.git`);
        spawnSync('git', ['init', '-q', '--bare', fresh]);
        const r = read(receivePack(fresh, src, zero, first, caps), 7);
        expect(r.sideband).toBe(caps.includes('side-band'));
        expect(confirmedRefs(r)).toEqual(['refs/heads/main']);
      }

      receivePack(bare, src, zero, first, 'report-status');
      git(src, ['commit', '-q', '--amend', '-m', 'rewritten']);
      const rewritten = git(src, ['rev-parse', 'HEAD']).toString().trim();
      const rejected = read(receivePack(bare, src, first, rewritten, 'report-status side-band-64k'));
      expect(rejected.unpack).toBe('ok');
      expect(rejected.complete).toBe(true);
      expect(rejected.refs).toEqual([{ ref: 'refs/heads/main', ok: false, reason: 'non-fast-forward' }]);
      expect(confirmedRefs(rejected)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
