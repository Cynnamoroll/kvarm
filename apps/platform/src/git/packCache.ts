import { concat, decode, DELIM_PKT, FLUSH_PKT, pktLine, readPktLines, RESPONSE_END_PKT, sha256Hex } from '@kvarm/gitops';

export type PackProtocol = 'v0' | 'v2';

export interface UploadPackClassification {
  cacheable: boolean;
  normalized: string | null;
  hasHaves: boolean;
  r2Eligible: boolean;
}

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const V0_CAPABILITIES = new Set([
  'allow-reachable-sha1-in-want',
  'allow-tip-sha1-in-want',
  'atomic',
  'delete-refs',
  'deepen-not',
  'deepen-relative',
  'deepen-since',
  'filter',
  'include-tag',
  'multi_ack',
  'multi_ack_detailed',
  'no-done',
  'no-progress',
  'no-thin',
  'ofs-delta',
  'object-format',
  'push-options',
  'push-cert',
  'quiet',
  'report-status',
  'report-status-v2',
  'side-band',
  'side-band-64k',
  'shallow',
  'thin-pack',
  'wait-for-done',
]);
const V2_HEADERS = new Set(['command', 'object-format', 'server-option']);
const V2_ARGUMENTS = new Set([
  'deepen',
  'deepen-not',
  'deepen-relative',
  'deepen-since',
  'filter',
  'include-tag',
  'no-progress',
  'ofs-delta',
  'packfile-uris',
  'ref-in-want',
  'server-option',
  'sideband-all',
  'thin-pack',
  'wait-for-done',
  'want-ref',
]);

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function packetsToBytes(packets: ReturnType<typeof readPktLines>): Uint8Array {
  return concat(
    ...packets.map((packet) =>
      packet.flush ? FLUSH_PKT : packet.delim ? DELIM_PKT : packet.responseEnd ? RESPONSE_END_PKT : pktLine(packet.data),
    ),
  );
}

function readLines(bytes: Uint8Array): Array<string | null> | null {
  try {
    const packets = readPktLines(bytes);
    if (!sameBytes(packetsToBytes(packets), bytes)) return null;
    return packets.map((packet) => {
      if (packet.flush || packet.delim || packet.responseEnd) return null;
      const line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(packet.data);
      return line.endsWith('\n') ? line.slice(0, -1) : line;
    });
  } catch {
    return null;
  }
}

function sortUnique(lines: string[]): string[] {
  return [...new Set(lines)].sort();
}

function normalizeV2(bytes: Uint8Array): UploadPackClassification {
  const packets = readPktLines(bytes);
  if (!sameBytes(packetsToBytes(packets), bytes)) return uncacheable();
  const delimiterIndex = packets.findIndex((packet) => packet.delim);
  if (delimiterIndex < 0 || packets.filter((packet) => packet.delim).length !== 1) return uncacheable();
  if (!packets.at(-1)?.flush || packets.slice(0, -1).some((packet) => packet.flush || packet.responseEnd)) return uncacheable();
  const headerLines = readLines(concat(...packets.slice(0, delimiterIndex).map((packet) => pktLine(packet.data))));
  const argumentLines = readLines(concat(...packets.slice(delimiterIndex + 1, -1).map((packet) => pktLine(packet.data))));
  if (!headerLines || !argumentLines || headerLines.some((line) => line === null) || argumentLines.some((line) => line === null)) {
    return uncacheable();
  }
  const headers = headerLines as string[];
  const args = argumentLines as string[];
  let command = 0;
  const normalizedHeaders: string[] = [];
  for (const line of headers) {
    const split = line.indexOf('=');
    if (split < 1) return uncacheable();
    const name = line.slice(0, split);
    if (name === 'agent' || name === 'session-id') continue;
    if (!V2_HEADERS.has(name) || !line.slice(split + 1)) return uncacheable();
    if (name === 'command') {
      if (line !== 'command=fetch' || command++ > 0) return uncacheable();
    }
    normalizedHeaders.push(line);
  }
  if (command !== 1) return uncacheable();

  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  const otherArgs: string[] = [];
  let done = 0;
  for (const line of args) {
    const space = line.indexOf(' ');
    const name = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (name === 'want' || name === 'have' || name === 'shallow') {
      if (!OID_RE.test(value)) return uncacheable();
      (name === 'want' ? wants : name === 'have' ? haves : shallows).push(value);
    } else if (name === 'done' && !value) {
      if (done++ > 0) return uncacheable();
      otherArgs.push(line);
    } else if (
      V2_ARGUMENTS.has(name) &&
      (name === 'deepen-relative' || name === 'include-tag' || name === 'no-progress' ||
        name === 'ofs-delta' || name === 'ref-in-want' || name === 'sideband-all' ||
        name === 'thin-pack' || name === 'wait-for-done'
        ? !value
        : Boolean(value))
    ) {
      otherArgs.push(line);
    } else {
      return uncacheable();
    }
  }
  if (done !== 1 || wants.length === 0) return uncacheable();
  const normalized = JSON.stringify({
    protocol: 'v2',
    headers: normalizedHeaders,
    args: [...sortUnique(wants).map((oid) => `want ${oid}`), ...sortUnique(haves).map((oid) => `have ${oid}`), ...sortUnique(shallows).map((oid) => `shallow ${oid}`), ...otherArgs],
  });
  return { cacheable: true, normalized, hasHaves: haves.length > 0, r2Eligible: haves.length === 0 };
}

function normalizeV0(bytes: Uint8Array): UploadPackClassification {
  const packets = readPktLines(bytes);
  if (!sameBytes(packetsToBytes(packets), bytes) || packets.some((packet) => packet.delim || packet.responseEnd)) return uncacheable();
  const sections: string[][] = [[]];
  let capabilities: string[] = [];
  let firstWant = true;
  let done = 0;
  for (const packet of packets) {
    if (packet.flush) {
      if (sections.length > 1) return uncacheable();
      sections.push([]);
      continue;
    }
    let line: string;
    try {
      line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(packet.data);
    } catch {
      return uncacheable();
    }
    if (!line.endsWith('\n')) return uncacheable();
    line = line.slice(0, -1);
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      if (!firstWant || !line.startsWith('want ')) return uncacheable();
      const caps = line.slice(nul + 1).split(' ');
      if (caps.some((cap) => !cap)) return uncacheable();
      for (const cap of caps) {
        const eq = cap.indexOf('=');
        const name = eq < 0 ? cap : cap.slice(0, eq);
        const value = eq < 0 ? '' : cap.slice(eq + 1);
        if (name === 'agent' || name === 'session-id') continue;
        if (!V0_CAPABILITIES.has(name) || (eq >= 0 && !value)) return uncacheable();
        capabilities.push(cap);
      }
      line = line.slice(0, nul);
    }
    const space = line.indexOf(' ');
    const name = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (name === 'want' || name === 'have' || name === 'shallow') {
      if (!OID_RE.test(value)) return uncacheable();
      sections.at(-1)!.push(`${name} ${value}`);
    } else if (name === 'done' && !value) {
      if (done++ > 0) return uncacheable();
      sections.at(-1)!.push(line);
    } else if (name === 'deepen' || name === 'deepen-since' || name === 'deepen-not' || name === 'filter') {
      if (!value) return uncacheable();
      sections.at(-1)!.push(line);
    } else if (name === 'deepen-relative') {
      if (value) return uncacheable();
      sections.at(-1)!.push(line);
    } else {
      return uncacheable();
    }
    if (firstWant) firstWant = false;
  }
  if (done !== 1 || !sections.some((section) => section.some((line) => line.startsWith('want ')))) return uncacheable();
  const normalizedSections = sections.map((section) => {
    const wants = section.filter((line) => line.startsWith('want ')).map((line) => line.slice(5));
    const haves = section.filter((line) => line.startsWith('have ')).map((line) => line.slice(5));
    const shallows = section.filter((line) => line.startsWith('shallow ')).map((line) => line.slice(8));
    const other = section.filter((line) => !/^(want|have|shallow) /.test(line));
    return [
      ...sortUnique(wants).map((oid) => `want ${oid}`),
      ...sortUnique(haves).map((oid) => `have ${oid}`),
      ...sortUnique(shallows).map((oid) => `shallow ${oid}`),
      ...other,
    ];
  });
  const normalized = JSON.stringify({ protocol: 'v0', capabilities, sections: normalizedSections });
  const hasHaves = sections.some((section) => section.some((line) => line.startsWith('have ')));
  return { cacheable: true, normalized, hasHaves, r2Eligible: !hasHaves };
}

function uncacheable(): UploadPackClassification {
  return { cacheable: false, normalized: null, hasHaves: false, r2Eligible: false };
}

export function classifyUploadPackRequest(bytes: Uint8Array, protocol: PackProtocol = 'v2'): UploadPackClassification {
  try {
    return protocol === 'v2' ? normalizeV2(bytes) : normalizeV0(bytes);
  } catch {
    return uncacheable();
  }
}

export async function derivePackCacheKey(repoId: string, refSeq: number, protocol: PackProtocol, normalized: string): Promise<string> {
  return sha256Hex(`${repoId}\n${refSeq}\n${protocol}\n${normalized}`);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export async function derivePackCacheSlotHash(repoId: string, protocol: PackProtocol, normalized: string): Promise<string> {
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid normalized upload-pack request');
  const request = parsed as Record<string, unknown>;
  if (request.protocol !== protocol) throw new TypeError('normalized upload-pack protocol mismatch');
  const withoutNegotiatedOids = (lines: string[]) => lines.filter((line) => !/^(?:want|have|shallow) /.test(line));

  let shape: string;
  if (protocol === 'v2' && stringArray(request.headers) && stringArray(request.args)) {
    shape = JSON.stringify({
      protocol,
      headers: request.headers,
      args: withoutNegotiatedOids(request.args),
    });
  } else if (protocol === 'v0' && stringArray(request.capabilities) && Array.isArray(request.sections) &&
    request.sections.every(stringArray)) {
    shape = JSON.stringify({
      protocol,
      capabilities: request.capabilities,
      sections: request.sections.map(withoutNegotiatedOids),
    });
  } else {
    throw new TypeError('invalid normalized upload-pack request');
  }

  return sha256Hex(`${repoId}\n${protocol}\n${shape}`);
}

export class UploadPackResponseValidator {
  private pending: Uint8Array = new Uint8Array();
  private valid = true;
  private lastFlush = false;
  private sawPackfile = false;
  private sawV0Pack = false;

  constructor(private readonly protocol: PackProtocol) {}

  push(chunk: Uint8Array): void {
    if (!this.valid || chunk.length === 0) return;
    this.pending = concat(this.pending, chunk);
    while (this.pending.length >= 4) {
      const header = decode(this.pending.subarray(0, 4));
      if (!/^[0-9a-f]{4}$/i.test(header)) {
        this.valid = false;
        return;
      }
      const length = Number.parseInt(header, 16);
      const packetLength = length < 4 ? 4 : length;
      if (length === 3) {
        this.valid = false;
        return;
      }
      if (this.pending.length < packetLength) return;
      let packets: ReturnType<typeof readPktLines>;
      try {
        packets = readPktLines(this.pending.subarray(0, packetLength));
      } catch {
        this.valid = false;
        return;
      }
      if (packets.length !== 1) {
        this.valid = false;
        return;
      }
      const packet = packets[0]!;
      this.lastFlush = packet.flush;
      if (packet.data.length > 0) {
        let line = '';
        try {
          line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(packet.data).replace(/\n$/, '');
        } catch {
          line = '';
        }
        if (line.startsWith('ERR ') || packet.data[0] === 3) {
          this.valid = false;
          return;
        }
        if (this.protocol === 'v2' && line === 'packfile') this.sawPackfile = true;
        if (
          this.protocol === 'v0' &&
          packet.data[0] === 1 &&
          packet.data.length >= 5 &&
          decode(packet.data.subarray(1, 5)) === 'PACK'
        ) {
          this.sawV0Pack = true;
        }
      }
      this.pending = this.pending.slice(packetLength);
    }
  }

  finish(): boolean {
    return this.valid && this.pending.length === 0 && this.lastFlush &&
      (this.protocol === 'v2' ? this.sawPackfile : this.sawV0Pack);
  }
}
