/**
 * Ref-level enforcement for pushes at the git gate. Reads only the bounded
 * receive-pack command prefix, checks every ref command, and either forwards
 * the exact original body upstream or answers with its own report-status
 * (every ref `ng`) without contacting Artifacts, so a denied push can never
 * move any ref, including the permitted ones in a mixed push.
 */

import {
  buildReportStatus,
  negotiatedSideband,
  readReceivePackPrefix,
  type CommandLimits,
  type RefCommand,
} from '@forge/gitops';

/**
 * Returns null when the command is allowed, otherwise the `ng` reason. It
 * also sees the whole command list, so a check that needs D1 can look every
 * command up in one query.
 */
export type RefCheck = (cmd: RefCommand, commands: readonly RefCommand[]) => string | null | Promise<string | null>;

export type GateResult =
  | { ok: true; body: ReadableStream<Uint8Array>; commands: RefCommand[] }
  | { ok: false; response: Response };

/** Remainder of a denied request that is read (and discarded) so git sees the report. */
export const DENIED_DRAIN_LIMIT = 32 * 1024 * 1024;

const SIBLING_REASON = 'push rejected: another ref in this push was denied';

function plain(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Keeps the original Content-Length framing when the client sent one. */
function framed(stream: ReadableStream<Uint8Array>, contentLength: string | null): ReadableStream<Uint8Array> {
  const len = contentLength === null ? NaN : Number(contentLength);
  if (!Number.isSafeInteger(len) || len < 0) return stream;
  const fixed = new FixedLengthStream(len);
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

export async function gateReceivePack(request: Request, check: RefCheck, limits?: CommandLimits): Promise<GateResult> {
  if (request.method !== 'POST') return { ok: false, response: plain(405, 'method not allowed') };
  const prefix = await readReceivePackPrefix(request.body, limits);
  const parsed = prefix.result;
  if (parsed.status === 'error') {
    await prefix.cancel();
    const status = parsed.reason === 'too-large' || parsed.reason === 'too-many-commands' ? 413 : 400;
    return { ok: false, response: plain(status, `push request rejected: ${parsed.reason}`) };
  }

  let verdicts: Array<{ cmd: RefCommand; reason: string | null }>;
  try {
    verdicts = await Promise.all(parsed.commands.map(async (cmd) => ({ cmd, reason: await check(cmd, parsed.commands) })));
  } catch (err) {
    await prefix.cancel();
    throw err;
  }
  if (verdicts.every((v) => v.reason === null)) {
    return { ok: true, body: framed(prefix.forward(), request.headers.get('content-length')), commands: parsed.commands };
  }

  await prefix.drain(DENIED_DRAIN_LIMIT);
  const caps = parsed.capabilities;
  if (!caps.includes('report-status') && !caps.includes('report-status-v2')) {
    const first = verdicts.find((v) => v.reason !== null);
    return { ok: false, response: plain(403, `push denied: ${first?.cmd.ref} ${first?.reason}`) };
  }
  const body = buildReportStatus(
    verdicts.map((v) => ({ ref: v.cmd.ref, ok: false, reason: v.reason ?? SIBLING_REASON })),
    negotiatedSideband(caps),
  );
  return {
    ok: false,
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' },
    }),
  };
}
