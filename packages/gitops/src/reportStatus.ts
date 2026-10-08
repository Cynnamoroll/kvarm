/**
 * Incremental reader for a git-receive-pack response (report-status).
 *
 * The response is either the report-status pkt-lines themselves or, when the
 * client negotiated side-band(-64k), outer pkt-lines whose first byte is the
 * band: 1 carries the report-status stream, 2 progress, 3 a fatal error.
 * A report starts with "unpack ...", which never begins with a band byte,
 * so the first packet tells the two framings apart.
 *
 * HTTP 200 is not push success: only a complete report with `unpack ok`
 * confirms the `ok <ref>` lines it carries.
 */

import type { RefResult } from './refUpdates';

const dec = new TextDecoder();

export interface ReportStatus {
  sideband: boolean;
  /** `ok`, the unpack error text, or null before the unpack line arrived. */
  unpack: string | null;
  refs: RefResult[];
  /**
   * The reply ended cleanly: the report's terminating flush, and for
   * side-band the outer flush right after it with no partial packet open.
   */
  complete: boolean;
  /** A band-3 message, if the server sent one. */
  fatal: string | null;
  /** Report data exceeded the reader's byte bound; nothing is confirmed. */
  overflow: boolean;
  malformed: boolean;
}

export interface ReportStatusOptions {
  /** Maximum report-status bytes retained (progress is never retained). */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 256 * 1024;
/** Largest legal pkt-line, so a partial outer packet never buffers more. */
const MAX_PKT = 65520;

class PktSplitter {
  private buf = new Uint8Array(0);

  constructor(private readonly limit: number) {}

  /** Appends bytes; returns complete packets (null payload = flush/special). */
  push(chunk: Uint8Array, onPkt: (payload: Uint8Array | null) => boolean): 'ok' | 'stop' | 'malformed' | 'overflow' {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    let off = 0;
    while (off + 4 <= merged.length) {
      const lenHex = dec.decode(merged.subarray(off, off + 4));
      if (!/^[0-9a-f]{4}$/.test(lenHex)) return 'malformed';
      const len = parseInt(lenHex, 16);
      // Delim/response-end packets do not occur in a v0/v1 receive-pack reply.
      if (len > 0 && len < 5) return 'malformed';
      if (len === 0) {
        off += 4;
        if (!onPkt(null)) return 'stop';
        continue;
      }
      if (off + len > merged.length) break;
      const payload = merged.slice(off + 4, off + len);
      off += len;
      if (!onPkt(payload)) return 'stop';
    }
    this.buf = merged.slice(off);
    return this.buf.length > this.limit ? 'overflow' : 'ok';
  }

  /** Bytes of a packet that has started but not yet finished. */
  get pending(): number {
    return this.buf.length;
  }
}

export class ReportStatusReader {
  private readonly maxBytes: number;
  private readonly outer = new PktSplitter(MAX_PKT);
  private inner: PktSplitter;
  private mode: 'unknown' | 'plain' | 'sideband' = 'unknown';
  private reportBytes = 0;
  /** The report-status stream's own flush was seen. */
  private reportEnded = false;
  private done = false;
  private readonly state: ReportStatus = {
    sideband: false,
    unpack: null,
    refs: [],
    complete: false,
    fatal: null,
    overflow: false,
    malformed: false,
  };

  constructor(opts: ReportStatusOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.inner = new PktSplitter(this.maxBytes);
  }

  push(chunk: Uint8Array): void {
    if (this.done || chunk.length === 0) return;
    const status = this.outer.push(chunk, (payload) => this.onOuter(payload));
    if (status === 'stop') this.done = true;
    // An outer partial packet larger than a legal pkt-line is malformed framing.
    else if (status === 'malformed' || status === 'overflow') this.fail('malformed');
  }

  result(): ReportStatus {
    return { ...this.state, refs: [...this.state.refs] };
  }

  private fail(kind: 'malformed' | 'overflow'): void {
    this.state[kind] = true;
    this.done = true;
  }

  /** Returns false to stop reading. */
  private onOuter(payload: Uint8Array | null): boolean {
    if (this.mode === 'unknown') {
      if (payload === null) return false;
      const first = payload[0];
      this.mode = first === 1 || first === 2 || first === 3 ? 'sideband' : 'plain';
      this.state.sideband = this.mode === 'sideband';
    }
    if (this.mode === 'plain') return this.onReportPkt(payload);
    if (payload === null) {
      // Only the outer flush ends a side-band reply; the inner report must
      // have ended on a packet boundary before it.
      this.state.complete = this.reportEnded && this.state.unpack !== null && this.inner.pending === 0;
      return false;
    }
    const bandNo = payload[0];
    const data = payload.subarray(1);
    if (bandNo === 1) {
      if (this.reportEnded) {
        this.fail('malformed');
        return false;
      }
      this.reportBytes += data.length;
      if (this.reportBytes > this.maxBytes) {
        this.fail('overflow');
        return false;
      }
      const status = this.inner.push(data, (p) => this.onReportPkt(p));
      if (status === 'malformed') this.fail('malformed');
      if (status === 'overflow') this.fail('overflow');
      return !this.state.malformed && !this.state.overflow;
    }
    if (bandNo === 3) {
      this.state.fatal = dec.decode(data).trim().slice(0, 500);
      return true;
    }
    if (bandNo === 2) return true;
    this.fail('malformed');
    return false;
  }

  private onReportPkt(payload: Uint8Array | null): boolean {
    if (this.reportEnded) {
      this.fail('malformed');
      return false;
    }
    if (payload === null) {
      this.reportEnded = true;
      if (this.mode === 'plain') {
        this.state.complete = this.state.unpack !== null;
        return false;
      }
      return true;
    }
    if (this.mode === 'plain') {
      this.reportBytes += payload.length;
      if (this.reportBytes > this.maxBytes) {
        this.fail('overflow');
        return false;
      }
    }
    let line = dec.decode(payload);
    if (line.endsWith('\n')) line = line.slice(0, -1);
    if (this.state.unpack === null) {
      if (!line.startsWith('unpack ')) {
        this.fail('malformed');
        return false;
      }
      this.state.unpack = line.slice('unpack '.length);
      return true;
    }
    if (line.startsWith('ok ')) {
      this.state.refs.push({ ref: line.slice(3), ok: true });
    } else if (line.startsWith('ng ')) {
      const rest = line.slice(3);
      const sp = rest.indexOf(' ');
      this.state.refs.push(
        sp === -1 ? { ref: rest, ok: false } : { ref: rest.slice(0, sp), ok: false, reason: rest.slice(sp + 1) },
      );
    } else if (!line.startsWith('option ')) {
      this.fail('malformed');
      return false;
    }
    return true;
  }
}

/** Refs the server confirmed as updated; empty unless the report is complete and clean. */
export function confirmedRefs(r: ReportStatus): string[] {
  if (!r.complete || r.unpack !== 'ok' || r.fatal !== null || r.overflow || r.malformed) return [];
  return r.refs.filter((x) => x.ok).map((x) => x.ref);
}
