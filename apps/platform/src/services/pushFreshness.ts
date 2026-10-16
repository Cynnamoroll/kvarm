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

import { confirmedRefs, ReportStatusReader, sha256Hex } from '@kvarm/gitops';
import { bumpRefGeneration, refGeneration } from '../cache/compare';
import { type RepoRow } from '../db/repos';
import type { MirrorUpdate } from '../do/repoMirror';

/** Upper bound on how long a confirmed push reply waits for the freshness writes. */
export const PUSH_FRESHNESS_TIMEOUT_MS = 3000;

/**
 * Cache-key generation for a repo's mutable-ref views. A confirmed push moves
 * it (`pushed_at`, colo ref generation), and so does an edit of the metadata
 * those views render — the About card and the header's demo badge come from the
 * description — because a metadata edit must not keep serving the pre-edit page
 * until the next push.
 */
export async function repoViewGeneration(
  repo: Pick<RepoRow, 'id' | 'pushed_at' | 'description' | 'visibility'>,
): Promise<string> {
  const meta = await sha256Hex(`${repo.visibility}\n${repo.description}`);
  return `${repo.pushed_at ?? 0}.${await refGeneration(repo.id)}.${meta.slice(0, 8)}`;
}

/**
 * Moves the view generation after a confirmed push. `deferPushedAt` leaves the
 * `pushed_at` write to the caller, which records it in its own next D1 batch
 * (`touchRepoPushedStatement`).
 */
export async function recordConfirmedPush(env: Env, repoId: string, updates: MirrorUpdate[], opts: { deferPushedAt?: boolean } = {}): Promise<void> {
  if (updates.length === 0) return;
  let row: { ref_seq: number } | null;
  try {
    const result = await env.DB.prepare(
      opts.deferPushedAt
        ? 'UPDATE repos SET ref_seq = ref_seq + 1 WHERE id = ? RETURNING ref_seq'
        : 'UPDATE repos SET pushed_at = MAX(COALESCE(pushed_at, 0) + 1, ?), ref_seq = ref_seq + 1 WHERE id = ? RETURNING ref_seq',
    ).bind(...(opts.deferPushedAt ? [repoId] : [Date.now(), repoId])).all<{ ref_seq: number }>();
    row = result.results[0] ?? null;
  } catch (error) {
    await env.REPO_MIRROR.get(env.REPO_MIRROR.idFromName(repoId)).markDirty(repoId).catch(() => undefined);
    throw error;
  }
  if (!row) return;
  await Promise.all([
    bumpRefGeneration(repoId),
    env.REPO_MIRROR.get(env.REPO_MIRROR.idFromName(repoId)).apply(row.ref_seq, updates, repoId),
  ]);
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
