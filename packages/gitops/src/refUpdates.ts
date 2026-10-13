/**
 * Receive-pack command inspection for a smart-HTTP gate.
 *
 * A push request body is `*shallow-line command-list [push-options] [pack]`.
 * The command list is a bounded run of pkt-lines ending at a flush packet, so
 * a gate can read just that prefix, decide per ref, and then either forward
 * the exact original bytes (prefix + untouched remainder) upstream or answer
 * with its own report-status without sending anything upstream.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const ZERO_OID = '0'.repeat(40);

export interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface CommandLimits {
  /** Maximum bytes of shallow lines + command list (excluding the pack). */
  maxBytes?: number;
  maxCommands?: number;
}

export const DEFAULT_COMMAND_LIMITS: Required<CommandLimits> = { maxBytes: 64 * 1024, maxCommands: 256 };

export type CommandParseError = 'malformed' | 'too-large' | 'too-many-commands' | 'push-cert' | 'truncated';

export type CommandParse =
  | { status: 'need-more' }
  | { status: 'error'; reason: CommandParseError }
  | { status: 'done'; commands: RefCommand[]; capabilities: string[]; shallow: string[]; end: number };

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

function parseCommand(line: string): RefCommand | null {
  const parts = line.split(' ');
  if (parts.length !== 3) return null;
  const [oldOid, newOid, ref] = parts as [string, string, string];
  if (!OID_RE.test(oldOid) || !OID_RE.test(newOid) || oldOid.length !== newOid.length) return null;
  if (ref.length === 0) return null;
  return { oldOid, newOid, ref };
}

/**
 * Parses the shallow lines and command list at the start of `buf`. Returns
 * `need-more` until the terminating flush packet has arrived; `end` is the
 * offset of the first byte after it (push options or the pack).
 */
export function parseReceivePackCommands(buf: Uint8Array, limits: CommandLimits = {}): CommandParse {
  const maxBytes = limits.maxBytes ?? DEFAULT_COMMAND_LIMITS.maxBytes;
  const maxCommands = limits.maxCommands ?? DEFAULT_COMMAND_LIMITS.maxCommands;
  const commands: RefCommand[] = [];
  const shallow: string[] = [];
  let capabilities: string[] = [];
  let off = 0;
  while (true) {
    if (off + 4 > buf.length) return buf.length > maxBytes ? { status: 'error', reason: 'too-large' } : { status: 'need-more' };
    const lenHex = dec.decode(buf.subarray(off, off + 4));
    if (!/^[0-9a-f]{4}$/.test(lenHex)) return { status: 'error', reason: 'malformed' };
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      if (off + 4 > maxBytes) return { status: 'error', reason: 'too-large' };
      return { status: 'done', commands, capabilities, shallow, end: off + 4 };
    }
    if (len < 5) return { status: 'error', reason: 'malformed' };
    if (off + len > maxBytes) return { status: 'error', reason: 'too-large' };
    if (off + len > buf.length) return { status: 'need-more' };
    let line = dec.decode(buf.subarray(off + 4, off + len));
    off += len;
    if (line.endsWith('\n')) line = line.slice(0, -1);
    const first = commands.length === 0;
    if (first && line.startsWith('push-cert')) return { status: 'error', reason: 'push-cert' };
    if (first && line.startsWith('shallow ')) {
      const oid = line.slice('shallow '.length);
      if (!OID_RE.test(oid)) return { status: 'error', reason: 'malformed' };
      shallow.push(oid);
      continue;
    }
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line
          .slice(nul + 1)
          .split(' ')
          .filter((c) => c.length > 0);
        line = line.slice(0, nul);
      }
    }
    const cmd = parseCommand(line);
    if (!cmd) return { status: 'error', reason: 'malformed' };
    if (commands.length >= maxCommands) return { status: 'error', reason: 'too-many-commands' };
    commands.push(cmd);
  }
}

export interface ReceivePackPrefix {
  result: CommandParse & { status: 'done' | 'error' };
  /** Bytes consumed from the source stream before the decision. */
  bytesRead: number;
  /** The complete original body: buffered bytes followed by the unread remainder. */
  forward(): ReadableStream<Uint8Array>;
  /** Reads and discards up to `maxBytes` of the remainder, then cancels the source. */
  drain(maxBytes: number): Promise<void>;
  cancel(): Promise<void>;
}

function join(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Reads the command prefix of a receive-pack request body, never buffering
 * more than about `maxBytes` plus one chunk.
 */
export async function readReceivePackPrefix(
  body: ReadableStream<Uint8Array> | null,
  limits: CommandLimits = {},
): Promise<ReceivePackPrefix> {
  const maxBytes = limits.maxBytes ?? DEFAULT_COMMAND_LIMITS.maxBytes;
  const reader = body?.getReader() ?? null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let result: CommandParse = { status: 'need-more' };
  while (result.status === 'need-more') {
    const next = reader ? await reader.read() : { done: true as const, value: undefined };
    if (next.done) {
      result = parseReceivePackCommands(join(chunks, total), limits);
      if (result.status === 'need-more') result = { status: 'error', reason: 'truncated' };
      break;
    }
    if (next.value.length === 0) continue;
    chunks.push(next.value);
    total += next.value.length;
    result = parseReceivePackCommands(join(chunks, total), limits);
    if (result.status === 'need-more' && total > maxBytes) result = { status: 'error', reason: 'too-large' };
  }
  const buffered = join(chunks, total);
  let forwarded = false;
  return {
    result,
    bytesRead: total,
    forward() {
      if (forwarded) throw new Error('receive-pack body already forwarded');
      forwarded = true;
      let sentPrefix = false;
      return new ReadableStream<Uint8Array>({
        async pull(ctrl) {
          if (!sentPrefix) {
            sentPrefix = true;
            if (buffered.length > 0) {
              ctrl.enqueue(buffered);
              return;
            }
          }
          const next = reader ? await reader.read() : { done: true as const, value: undefined };
          if (next.done) ctrl.close();
          else ctrl.enqueue(next.value);
        },
        async cancel(reason) {
          await reader?.cancel(reason);
        },
      });
    },
    async drain(limit: number) {
      if (!reader) return;
      let seen = 0;
      while (seen < limit) {
        const next = await reader.read();
        if (next.done) return;
        seen += next.value.length;
      }
      await reader.cancel().catch(() => undefined);
    },
    async cancel() {
      await reader?.cancel().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// Ref names and grant patterns
// ---------------------------------------------------------------------------

/**
 * A conservative subset of `git check-ref-format` for full ref names: at least
 * `refs/<kind>/<name>`, no empty, dot-leading or `.lock` components, no `..`,
 * `@{`, control characters, spaces or any of `~^:?*[\`.
 */
export function isSafeRefName(ref: string): boolean {
  if (ref.length > 255 || !ref.startsWith('refs/')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.endsWith('.')) return false;
  const parts = ref.split('/');
  if (parts.length < 3) return false;
  return parts.every((p) => p.length > 0 && !p.startsWith('.') && !p.endsWith('.lock'));
}

/** `refs/<kind>/.../<name>` exactly, or `refs/<kind>/[...]/*` for everything below a prefix. */
export function isValidRefPattern(pattern: string): boolean {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (!prefix.startsWith('refs/') || prefix.split('/').length < 2) return false;
    return isSafeRefName(`${prefix}/x`);
  }
  return isSafeRefName(pattern);
}

export function refMatchesPattern(pattern: string, ref: string): boolean {
  if (!isSafeRefName(ref)) return false;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return ref.length > prefix.length && ref.startsWith(prefix);
  }
  return ref === pattern;
}

export function refMatchesAny(patterns: readonly string[], ref: string): boolean {
  return patterns.some((p) => refMatchesPattern(p, ref));
}

// ---------------------------------------------------------------------------
// report-status responses
// ---------------------------------------------------------------------------

export type Sideband = 'none' | 'side-band' | 'side-band-64k';

export interface RefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

/** The side-band mode negotiated by the client's capability list. */
export function negotiatedSideband(capabilities: readonly string[]): Sideband {
  if (capabilities.includes('side-band-64k')) return 'side-band-64k';
  if (capabilities.includes('side-band')) return 'side-band';
  return 'none';
}

function pkt(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4);
  out.set(enc.encode((payload.length + 4).toString(16).padStart(4, '0')), 0);
  out.set(payload, 4);
  return out;
}

/**
 * A receive-pack result body in the shape git's own receive-pack produces when
 * a pre-receive check declines refs: `unpack ok`, one `ok`/`ng` line per ref
 * and a flush, wrapped in side-band channel 1 when the client negotiated it.
 *
 * The builder never trusts its caller: a ref carrying control characters or
 * an extreme length would corrupt the pkt-line stream the client parses (a
 * crafted `ng` line could smuggle an `ok` for a ref that was denied), so the
 * ref is sanitized exactly like the reason.
 */
export function buildReportStatus(results: readonly RefResult[], sideband: Sideband): Uint8Array {
  const lines = [pkt(enc.encode('unpack ok\n'))];
  for (const r of results) {
    // eslint-disable-next-line no-control-regex
    const clean = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512);
    const reason = clean(r.reason ?? 'rejected');
    lines.push(pkt(enc.encode(r.ok ? `ok ${clean(r.ref)}\n` : `ng ${clean(r.ref)} ${reason}\n`)));
  }
  lines.push(enc.encode('0000'));
  const inner = join(lines, lines.reduce((n, l) => n + l.length, 0));
  if (sideband === 'none') return inner;
  const max = sideband === 'side-band-64k' ? 65515 : 995;
  const out: Uint8Array[] = [];
  for (let off = 0; off < inner.length; off += max) {
    const slice = inner.subarray(off, off + max);
    const payload = new Uint8Array(slice.length + 1);
    payload[0] = 1;
    payload.set(slice, 1);
    out.push(pkt(payload));
  }
  out.push(enc.encode('0000'));
  return join(out, out.reduce((n, l) => n + l.length, 0));
}
