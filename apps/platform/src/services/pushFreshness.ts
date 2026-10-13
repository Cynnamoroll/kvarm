/**
 * Push freshness at the git gate (architecture §9).
 *
 * A receive-pack reply is relayed with its final chunk held back until the
 * report-status is known. Only a protocol-confirmed report (complete,
 * `unpack ok`, at least one `ok <ref>`) moves the repo's view generation: the
 * colo ref generation is bumped and `pushed_at` advances, and both are awaited
 * (bounded) before the client sees the end of the reply. HTTP 200 alone,
 * `ng`, fatal and truncated reports change nothing.
 *
 * Edge-cached views of mutable refs (tree pages, info/refs) are keyed by the
 * view generation. `pushed_at` comes from the authority lookup every request
 * already runs, so a push is visible in every colo; the colo ref generation
 * still separates pushes that land within the same millisecond and covers a
 * D1 update that missed the bound.
 */

import { confirmedRefs, ReportStatusReader } from '@kvarm/gitops';
import { bumpRefGeneration, refGeneration } from '../cache/compare';
import { touchRepoPushed, touchRepoPushedStatement, type RepoRow } from '../db/repos';

/** Upper bound on how long a confirmed push reply waits for the freshness writes. */
export const PUSH_FRESHNESS_TIMEOUT_MS = 3000;

/** Cache-key generation for a repo's mutable-ref views. */
export async function repoViewGeneration(repo: Pick<RepoRow, 'id' | 'pushed_at'>): Promise<string> {
  return `${repo.pushed_at ?? 0}.${await refGeneration(repo.id)}`;
}

/**
 * Moves the view generation after a confirmed push. `deferPushedAt` leaves the
 * `pushed_at` write to the caller, which records it in its own next D1 batch
 * (`touchRepoPushedStatement`). `audit` statements (services/audit.ts) ride
 * in the same D1 round trip as the `pushed_at` write.
 */
export async function recordConfirmedPush(
  env: Env,
  repoId: string,
  opts: { deferPushedAt?: boolean; audit?: D1PreparedStatement[] } = {},
): Promise<void> {
  const audit = opts.audit ?? [];
  const writes = opts.deferPushedAt
    ? audit.length > 0
      ? env.DB.batch(audit)
      : null
    : audit.length > 0
      ? env.DB.batch([touchRepoPushedStatement(env.DB, repoId), ...audit])
      : touchRepoPushed(env.DB, repoId);
  await Promise.all([bumpRefGeneration(repoId), writes]);
}

export interface RelayOptions {
  onConfirmed: (refs: string[]) => Promise<void>;
  waitUntil: (p: Promise<unknown>) => void;
  timeoutMs?: number;
}

/** Relays a receive-pack reply, completing it only after confirmed pushes are recorded. */
export function relayReceivePackReply(body: ReadableStream<Uint8Array>, opts: RelayOptions): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  opts.waitUntil(pump(body, writable.getWriter(), opts));
  return readable;
}

async function pump(
  body: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  opts: RelayOptions,
): Promise<void> {
  const report = new ReportStatusReader();
  const source = body.getReader();
  // The upstream reply is read to the end even if the client goes away, so a
  // push that landed is still recorded.
  let clientGone = false;
  const forward = async (chunk: Uint8Array): Promise<void> => {
    if (clientGone) return;
    try {
      await writer.write(chunk);
    } catch {
      clientGone = true;
    }
  };

  let held: Uint8Array | null = null;
  let failure: unknown = null;
  try {
    for (;;) {
      const { done, value } = await source.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      report.push(value);
      if (held) await forward(held);
      held = value;
    }
  } catch (err) {
    failure = err ?? new Error('upstream reply failed');
  }

  const refs = failure === null ? confirmedRefs(report.result()) : [];
  if (refs.length > 0) {
    const work = opts.onConfirmed(refs).catch((err: unknown) => {
      console.warn(JSON.stringify({ pushFreshnessFailed: String(err).slice(0, 200) }));
    });
    opts.waitUntil(work);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs ?? PUSH_FRESHNESS_TIMEOUT_MS);
    });
    await Promise.race([work, bound]);
    clearTimeout(timer);
  }

  if (held) await forward(held);
  if (clientGone) return;
  if (failure !== null) await writer.abort(failure).catch(() => undefined);
  else await writer.close().catch(() => undefined);
}
