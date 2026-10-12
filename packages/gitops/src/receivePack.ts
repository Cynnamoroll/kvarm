/**
 * Smart-HTTP receive-pack client: the only way the platform writes refs and
 * objects to its git store.
 *
 * HTTP 200 is not success. A ref counts as updated only when a complete
 * report-status with `unpack ok` carries `ok <ref>`. Every other outcome is
 * classified per ref:
 *
 *  - `stale`: `ng` because the server's current value differs from the
 *    command's old OID (the compare-and-swap lost); the ref did not move.
 *  - `rejected`: any other `ng`, a failed unpack, or an HTTP 4xx refusal; the
 *    ref did not move.
 *  - `unknown`: no complete report (transport failure, 5xx, truncated or
 *    fatal reply). The update may or may not have landed; read the ref back.
 *
 * A push with several commands reports each ref separately. Servers do not
 * promise atomicity (Artifacts does not advertise `atomic`), so callers that
 * need an all-or-nothing outcome push one ref at a time.
 */

import { EMPTY_PACK } from './pack';
import { isSafeRefName, isZeroOid, type RefCommand } from './refUpdates';
import { confirmedRefs, ReportStatusReader, type ReportStatus } from './reportStatus';
import { concat, FLUSH_PKT, parseRefAdvertisement, pktLine } from './index';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ReceivePackRemote {
  /** Repository URL without a trailing slash, e.g. `https://host/owner/repo.git`. */
  url: string;
  /** Complete `Authorization` header value. */
  authorization?: string;
  fetch?: FetchLike;
  /** Bound on the advertisement body (default 4 MiB). */
  maxAdvertisementBytes?: number;
  /** Bound on retained report-status bytes (default 256 KiB). */
  maxReportBytes?: number;
}

export interface ReceivePackAdvertisement {
  /** Full ref name -> object id. */
  refs: Map<string, string>;
  capabilities: string[];
}

export class ReceivePackError extends Error {
  override readonly name = 'ReceivePackError';
  constructor(
    message: string,
    /** HTTP status, or 0 when the request itself failed. */
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

export type RefPushStatus = 'ok' | 'stale' | 'rejected' | 'unknown';

export interface RefPushResult extends RefCommand {
  status: RefPushStatus;
  reason?: string;
}

export interface PushRequest {
  commands: RefCommand[];
  /** Objects for the new values. Defaults to the empty pack; never sent for delete-only pushes. */
  pack?: Uint8Array;
  /** Ask for side-band-64k framing (default true). */
  sideband?: boolean;
}

export interface PushResult {
  /** Every command was confirmed by the report. */
  ok: boolean;
  /** 0 when the request itself failed. */
  httpStatus: number;
  /** One entry per command, in command order. */
  refs: RefPushResult[];
  report: ReportStatus | null;
  /** Transport or protocol failure, when there is no usable report. */
  error?: string;
}

export interface RefUpdateResult {
  status: RefPushStatus;
  reason?: string;
  httpStatus: number;
  error?: string;
}

const AGENT = 'agent=kvarm-gitops';
const USER_AGENT = 'git/kvarm-gitops';
const DEFAULT_MAX_ADVERTISEMENT_BYTES = 4 * 1024 * 1024;
const OID_RE = /^[0-9a-f]{40}$/;

/**
 * `ng` reasons meaning the ref's current value is not the command's old OID:
 * Artifacts says `stale ref`; git says `incorrect old value provided`,
 * `reference already exists` (create over an existing ref) or reports a lock
 * failure.
 */
export function isStaleRefReason(reason: string): boolean {
  return /^(stale ref|incorrect old value provided|reference already exists|failed to lock|cannot lock ref)/.test(reason);
}

function fetchOf(remote: ReceivePackRemote): FetchLike {
  return remote.fetch ?? ((input, init) => fetch(input, init));
}

function baseHeaders(remote: ReceivePackRemote): Headers {
  const h = new Headers({ 'User-Agent': USER_AGENT });
  if (remote.authorization) h.set('Authorization', remote.authorization);
  return h;
}

async function readBounded(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ReceivePackError(`advertisement exceeds ${max} bytes`, res.status);
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

/** GET `info/refs?service=git-receive-pack`: the refs and capabilities a push starts from. */
export async function advertiseReceivePack(remote: ReceivePackRemote): Promise<ReceivePackAdvertisement> {
  let res: Response;
  try {
    res = await fetchOf(remote)(`${remote.url}/info/refs?service=git-receive-pack`, {
      method: 'GET',
      headers: baseHeaders(remote),
    });
  } catch (err) {
    throw new ReceivePackError(`advertisement request failed: ${String(err).slice(0, 200)}`, 0);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    throw new ReceivePackError(`advertisement failed with HTTP ${res.status}`, res.status);
  }
  if (!(res.headers.get('content-type') ?? '').startsWith('application/x-git-receive-pack-advertisement')) {
    await res.body?.cancel().catch(() => undefined);
    throw new ReceivePackError('not a smart-HTTP receive-pack advertisement', res.status);
  }
  const body = await readBounded(res, remote.maxAdvertisementBytes ?? DEFAULT_MAX_ADVERTISEMENT_BYTES);
  let parsed: ReturnType<typeof parseRefAdvertisement>;
  try {
    parsed = parseRefAdvertisement(body);
  } catch (err) {
    throw new ReceivePackError(`malformed advertisement: ${String(err).slice(0, 200)}`, res.status);
  }
  const refs = new Map<string, string>();
  for (const r of parsed.refs) if (r.name.startsWith('refs/') && OID_RE.test(r.hash)) refs.set(r.name, r.hash);
  return { refs, capabilities: parsed.capabilities };
}

function validate(commands: readonly RefCommand[]): void {
  if (commands.length === 0) throw new TypeError('receive-pack: no commands');
  const seen = new Set<string>();
  for (const c of commands) {
    if (!OID_RE.test(c.oldOid) || !OID_RE.test(c.newOid)) throw new TypeError(`receive-pack: bad object id for ${c.ref}`);
    if (!isSafeRefName(c.ref)) throw new TypeError(`receive-pack: unsafe ref name ${JSON.stringify(c.ref)}`);
    if (isZeroOid(c.oldOid) && isZeroOid(c.newOid)) throw new TypeError(`receive-pack: no-op command for ${c.ref}`);
    if (seen.has(c.ref)) throw new TypeError(`receive-pack: duplicate ref ${c.ref}`);
    seen.add(c.ref);
  }
}

function requestBody(req: PushRequest): Uint8Array {
  const caps = ['report-status', ...(req.sideband === false ? [] : ['side-band-64k']), AGENT].join(' ');
  const lines = req.commands.map((c, i) => pktLine(`${c.oldOid} ${c.newOid} ${c.ref}${i === 0 ? `\0${caps}` : ''}\n`));
  // git sends no pack when every command is a delete, and receive-pack reads none.
  const needsPack = req.commands.some((c) => !isZeroOid(c.newOid));
  return concat(...lines, FLUSH_PKT, needsPack ? (req.pack ?? EMPTY_PACK) : new Uint8Array(0));
}

function allRefs(commands: readonly RefCommand[], status: RefPushStatus, reason?: string): RefPushResult[] {
  return commands.map((c) => ({ ...c, status, ...(reason ? { reason } : {}) }));
}

async function readReport(res: Response, maxBytes: number | undefined): Promise<ReportStatus> {
  const reader = new ReportStatusReader(maxBytes === undefined ? {} : { maxBytes });
  if (res.body) {
    const source = res.body.getReader();
    for (;;) {
      const { done, value } = await source.read();
      if (done) break;
      reader.push(value);
      const r = reader.result();
      if (r.complete || r.malformed || r.overflow) {
        await source.cancel().catch(() => undefined);
        break;
      }
    }
  }
  return reader.result();
}

/** POST `git-receive-pack` with the commands and pack, classifying each ref by the report. */
export async function pushRefs(remote: ReceivePackRemote, req: PushRequest): Promise<PushResult> {
  validate(req.commands);
  const headers = baseHeaders(remote);
  headers.set('Content-Type', 'application/x-git-receive-pack-request');
  headers.set('Accept', 'application/x-git-receive-pack-result');

  let res: Response;
  try {
    const body = requestBody(req) as Uint8Array<ArrayBuffer>;
    res = await fetchOf(remote)(`${remote.url}/git-receive-pack`, { method: 'POST', headers, body });
  } catch (err) {
    const error = String(err).slice(0, 200);
    return { ok: false, httpStatus: 0, refs: allRefs(req.commands, 'unknown'), report: null, error };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    // A 4xx is a refusal before anything was applied; anything else leaves the outcome open.
    const refused = res.status >= 400 && res.status < 500;
    return {
      ok: false,
      httpStatus: res.status,
      refs: allRefs(req.commands, refused ? 'rejected' : 'unknown', refused ? `http ${res.status}` : undefined),
      report: null,
      error: `receive-pack failed with HTTP ${res.status}`,
    };
  }

  let report: ReportStatus;
  try {
    report = await readReport(res, remote.maxReportBytes);
  } catch (err) {
    const error = `receive-pack reply failed: ${String(err).slice(0, 200)}`;
    return { ok: false, httpStatus: res.status, refs: allRefs(req.commands, 'unknown'), report: null, error };
  }

  const usable = report.complete && report.fatal === null && !report.overflow && !report.malformed;
  if (!usable) {
    const error = report.fatal ? `remote fatal: ${report.fatal}` : 'incomplete report-status';
    return { ok: false, httpStatus: res.status, refs: allRefs(req.commands, 'unknown'), report, error };
  }
  if (report.unpack !== 'ok') {
    const refs = allRefs(req.commands, 'rejected', `unpack failed: ${report.unpack ?? ''}`);
    return { ok: false, httpStatus: res.status, refs, report };
  }

  const confirmed = new Set(confirmedRefs(report));
  const refs = req.commands.map((c): RefPushResult => {
    if (confirmed.has(c.ref)) return { ...c, status: 'ok' };
    const line = report.refs.find((r) => r.ref === c.ref && !r.ok);
    if (!line) return { ...c, status: 'unknown', reason: 'no status for ref' };
    const reason = line.reason ?? 'rejected';
    return { ...c, status: isStaleRefReason(reason) ? 'stale' : 'rejected', reason };
  });
  return { ok: refs.every((r) => r.status === 'ok'), httpStatus: res.status, refs, report };
}

/** One-ref compare-and-swap: moves `ref` from `oldOid` to `newOid` (zero OIDs create/delete). */
export async function updateRef(
  remote: ReceivePackRemote,
  command: RefCommand,
  pack?: Uint8Array,
  opts: { sideband?: boolean } = {},
): Promise<RefUpdateResult> {
  const r = await pushRefs(remote, { commands: [command], ...(pack ? { pack } : {}), ...opts });
  const ref = r.refs[0]!;
  return {
    status: ref.status,
    ...(ref.reason ? { reason: ref.reason } : {}),
    httpStatus: r.httpStatus,
    ...(r.error ? { error: r.error } : {}),
  };
}
