/**
 * SnapshotBuilder (architecture §11.5): a commit's working tree as a tar in R2.
 *
 * Tarballs are keyed by (repo, root tree), so commits with identical trees
 * share one object; commit metadata stays per commit. Steps:
 *
 *   resolve   commit -> tree, then claim the tree build in one D1 batch. A
 *             tree that is already built marks the commit ready (reuse); a
 *             tree another instance is building leaves the commit waiting
 *             for that builder to finish it.
 *   batch-N   continues a pre-order walk of the tree and streams up to
 *             BLOBS_PER_STEP blobs into the tar. Bytes go to R2 in equal
 *             PART_SIZE multipart parts; the unflushed tail and the walk
 *             cursor are the step's (streamed) output, so a retried or
 *             replayed step resumes from exactly the same input.
 *   finish    marks the tree and every commit waiting on it ready.
 *
 * A tree with B blob/symlink entries takes 1 + max(1, ceil(B / 500)) + 1
 * steps. Each step meters its own work and logs one `{cost: …}` line; the
 * totals are stored as the commit's `buildCost`.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { decode, encode, gitModeToTar, tarEnd, tarHeader, tarPadding, type TarEntry } from '@forge/gitops';
import { withRepo } from '../artifacts/repo';
import { CostMeter, runWithMeter } from '../cost/meter';

export const BLOBS_PER_STEP = 500;
/** R2 multipart parts must all be the same size except the last. */
export const PART_SIZE = 8 * 1024 * 1024;
const READ_CONCURRENCY = 16;
/** A build still claimed after this long is presumed dead and can be taken over. */
export const STALE_BUILD_MS = 30 * 60 * 1000;

export interface SnapshotParams {
  repoId: string;
  sha: string;
  trigger?: 'push' | 'demand';
}

export interface BuildCost {
  steps: number;
  d1: number;
  rr: number;
  rw: number;
  art: number;
  r2a: number;
  r2b: number;
  sub: number;
  treeReads: number;
  blobReads: number;
  /** Multipart parts uploaded (0 for a single put). */
  parts: number;
  /** R2 objects written: 1 for a fresh tarball, 0 when an existing one was reused. */
  objects: number;
  bytes: number;
  reused: boolean;
}

export function emptyCost(): BuildCost {
  return {
    steps: 0,
    d1: 0,
    rr: 0,
    rw: 0,
    art: 0,
    r2a: 0,
    r2b: 0,
    sub: 0,
    treeReads: 0,
    blobReads: 0,
    parts: 0,
    objects: 0,
    bytes: 0,
    reused: false,
  };
}

export function snapshotKey(repoId: string, tree: string): string {
  return `trees/v1/${repoId}/${tree}.tar`;
}

/** The subset of WorkflowStep the builder uses, so tests can drive it directly. */
export interface StepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Runs one step body under a fresh meter and adds its counters to `cost`. */
async function metered<T>(
  env: Env,
  cost: BuildCost,
  log: Record<string, unknown>,
  fn: (env: Env, meter: CostMeter) => Promise<T>,
): Promise<T> {
  const meter = new CostMeter();
  const value = await runWithMeter(meter, () => fn(meter.wrapEnv(env), meter));
  addMeter(cost, meter);
  console.log(JSON.stringify({ cost: meter.snapshot(), workflow: 'snapshot-builder', ...log }));
  return value;
}

function addMeter(cost: BuildCost, meter: CostMeter): void {
  cost.steps++;
  cost.d1 += meter.d1;
  cost.rr += meter.rr;
  cost.rw += meter.rw;
  cost.art += meter.art;
  cost.r2a += meter.r2a;
  cost.r2b += meter.r2b;
  cost.sub += meter.sub;
}

function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'INVALID_INPUT' || code === 'NOT_FOUND';
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

type Resolved =
  | { action: 'done'; reason: string; cost: BuildCost }
  | { action: 'build'; tree: string; key: string; artifactsName: string; mtime: number; cost: BuildCost };

interface ClaimRow {
  tree_state: string | null;
  builder: string | null;
  commit_state: string;
}

async function resolveStep(env: Env, p: Required<SnapshotParams> & { instanceId: string }): Promise<Resolved> {
  const cost = emptyCost();
  const log = { step: 'resolve', instance: p.instanceId };
  return metered(env, cost, log, async (env, meter) => {
    const repo = await env.DB.prepare('SELECT artifacts_name FROM repos WHERE id = ?')
      .bind(p.repoId)
      .first<{ artifacts_name: string }>();
    if (!repo) return { action: 'done', reason: 'repo deleted', cost };
    let commit: ArtifactsCommitMetadata | null;
    try {
      commit = await withRepo(env, repo.artifacts_name, (h) => h.readCommit(p.sha));
    } catch (err) {
      if (!isMissingObject(err)) throw err;
      commit = null;
    }
    const now = Date.now();
    if (!commit || commit.hash !== p.sha) {
      await env.DB.prepare(
        `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, requested_at, error)
         VALUES (?1, ?2, NULL, 'failed', ?3, ?4, ?5, 'commit not found')
         ON CONFLICT (repo_id, sha) DO UPDATE SET state = 'failed', error = 'commit not found'
         WHERE snapshot_commits.state = 'building'`,
      )
        .bind(p.repoId, p.sha, p.trigger, p.instanceId, now)
        .run();
      return { action: 'done', reason: 'commit not found', cost };
    }
    const tree = commit.treeHash;
    const key = snapshotKey(p.repoId, tree);
    // The cost a commit records when this step is all it needs (reuse or wait):
    // everything metered so far plus the claim batch below.
    const settled = JSON.stringify({
      ...emptyCost(),
      steps: 1,
      d1: meter.d1 + 1,
      rr: meter.rr,
      rw: meter.rw,
      art: meter.art,
      sub: meter.sub,
      reused: true,
    });
    const db = env.DB;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO snapshot_trees (repo_id, tree, state, builder, r2_key, created_at)
           VALUES (?1, ?2, 'building', ?3, ?4, ?5)
           ON CONFLICT (repo_id, tree) DO UPDATE SET
             state = 'building', builder = excluded.builder, created_at = excluded.created_at, error = NULL
           WHERE snapshot_trees.state = 'failed'
              OR (snapshot_trees.state = 'building' AND snapshot_trees.created_at < ?6)`,
        )
        .bind(p.repoId, tree, p.instanceId, key, now, now - STALE_BUILD_MS),
      db
        .prepare(
          `INSERT INTO snapshot_commits (repo_id, sha, tree, state, trigger, instance_id, requested_at, build_cost)
           VALUES (?1, ?2, ?3, 'building', ?4, ?5, ?6, ?7)
           ON CONFLICT (repo_id, sha) DO UPDATE SET
             tree = excluded.tree, state = 'building', error = NULL, build_cost = excluded.build_cost
           WHERE snapshot_commits.state != 'ready'`,
        )
        .bind(p.repoId, p.sha, tree, p.trigger, p.instanceId, now, settled),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'ready', reused = 1, built_at = ?3, error = NULL
           WHERE repo_id = ?1 AND sha = ?2 AND state = 'building'
             AND EXISTS (SELECT 1 FROM snapshot_trees t WHERE t.repo_id = ?1 AND t.tree = ?4 AND t.state = 'ready')`,
        )
        .bind(p.repoId, p.sha, now, tree),
      db
        .prepare(
          `SELECT t.state AS tree_state, t.builder, c.state AS commit_state
             FROM snapshot_commits c
             LEFT JOIN snapshot_trees t ON t.repo_id = c.repo_id AND t.tree = c.tree
            WHERE c.repo_id = ?1 AND c.sha = ?2`,
        )
        .bind(p.repoId, p.sha),
    ]);
    const row = (results[3]?.results as ClaimRow[] | undefined)?.[0];
    if (!row || row.commit_state === 'ready') return { action: 'done', reason: 'ready', cost };
    if (row.tree_state === 'building' && row.builder === p.instanceId) {
      return { action: 'build', tree, key, artifactsName: repo.artifacts_name, mtime: commit.committedAt, cost };
    }
    return { action: 'done', reason: `waiting on ${row.builder ?? 'another build'}`, cost };
  });
}

// ---------------------------------------------------------------------------
// batch-N: walk + tar + multipart
// ---------------------------------------------------------------------------

interface Frame {
  path: string;
  hash: string;
  next: number;
}

export interface BatchState {
  stack: Frame[];
  uploadId: string | null;
  parts: R2UploadedPart[];
  /** Bytes already uploaded as parts. */
  flushed: number;
  files: number;
  done: boolean;
  /** Total tar size, set by the final batch. */
  size: number;
  cost: BuildCost;
}

interface BuildTarget {
  repoId: string;
  tree: string;
  key: string;
  artifactsName: string;
  mtime: number;
}

export interface BuildOptions {
  blobsPerStep?: number;
  partSize?: number;
}

/** Appends tar bytes and uploads every complete part. */
class PartWriter {
  private chunks: Uint8Array[] = [];
  private length = 0;

  constructor(
    private readonly bucket: R2Bucket,
    private readonly key: string,
    private readonly partSize: number,
    readonly state: BatchState,
    carry: Uint8Array,
  ) {
    if (carry.length > 0) this.push(carry);
  }

  push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0]!;
      const want = n - off;
      if (head.length <= want) {
        out.set(head, off);
        off += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, want), off);
        this.chunks[0] = head.subarray(want);
        off += want;
      }
    }
    this.length -= n;
    return out;
  }

  private upload(): R2MultipartUpload | Promise<R2MultipartUpload> {
    if (this.state.uploadId) return this.bucket.resumeMultipartUpload(this.key, this.state.uploadId);
    return this.bucket
      .createMultipartUpload(this.key, { httpMetadata: { contentType: 'application/x-tar' } })
      .then((u) => {
        this.state.uploadId = u.uploadId;
        return u;
      });
  }

  async flushFull(): Promise<void> {
    while (this.length >= this.partSize) {
      const upload = await this.upload();
      const partNumber = this.state.parts.length + 1;
      const part = await upload.uploadPart(partNumber, this.take(this.partSize));
      this.state.parts.push(part);
      this.state.flushed += this.partSize;
      this.state.cost.parts++;
    }
  }

  /** Writes the remaining bytes as a single object or the final part, then completes. */
  async finish(): Promise<number> {
    const size = this.state.flushed + this.length;
    if (!this.state.uploadId) {
      await this.bucket.put(this.key, this.take(this.length), { httpMetadata: { contentType: 'application/x-tar' } });
      return size;
    }
    const upload = await this.upload();
    try {
      if (this.length > 0) {
        const part = await upload.uploadPart(this.state.parts.length + 1, this.take(this.length));
        this.state.parts.push(part);
        this.state.cost.parts++;
      }
      await upload.complete(this.state.parts);
    } catch (err) {
      // A retry after a completed upload finds the object already in place.
      const head = await this.bucket.head(this.key);
      if (!head || head.size !== size) throw err;
    }
    return size;
  }

  rest(): Uint8Array {
    return this.take(this.length);
  }
}

interface Pending {
  entry: TarEntry;
  hash: string | null;
}

async function batchStep(
  env: Env,
  target: BuildTarget,
  input: BatchState,
  carry: Uint8Array,
  index: number,
  opts: Required<BuildOptions>,
): Promise<{ state: BatchState; carry: Uint8Array }> {
  const state: BatchState = structuredClone(input);
  const log = { step: `batch-${index}`, tree: target.tree };
  return metered(env, state.cost, log, async (env) => {
    const writer = new PartWriter(env.SNAPSHOTS, target.key, opts.partSize, state, carry);
    await withRepo(env, target.artifactsName, async (h) => {
      const trees = new Map<string, ArtifactsTreeEntry[]>();
      const readTree = async (hash: string): Promise<ArtifactsTreeEntry[]> => {
        let entries = trees.get(hash);
        if (!entries) {
          state.cost.treeReads++;
          const read = await h.readTree(hash);
          if (!read) throw new Error(`tree ${hash} not found`);
          entries = read;
          trees.set(hash, entries);
        }
        return entries;
      };
      const stack = state.stack;
      await Promise.all(stack.map((f) => readTree(f.hash)));

      const pending: Pending[] = [];
      let blobs = 0;
      while (stack.length > 0 && blobs < opts.blobsPerStep) {
        const top = stack[stack.length - 1]!;
        const entries = trees.get(top.hash)!;
        if (top.next >= entries.length) {
          stack.pop();
          continue;
        }
        const e = entries[top.next++]!;
        const path = top.path ? `${top.path}/${e.name}` : e.name;
        const mapped = gitModeToTar(e.mode);
        if (!mapped) continue;
        const isTree = e.mode === '40000' || e.mode === '040000';
        if (!isTree) state.files++;
        if (mapped.type === 'dir') {
          pending.push({ entry: { path, ...mapped, mtime: target.mtime }, hash: null });
          if (isTree) {
            await readTree(e.hash);
            stack.push({ path, hash: e.hash, next: 0 });
          }
          continue;
        }
        pending.push({ entry: { path, ...mapped, mtime: target.mtime }, hash: e.hash });
        blobs++;
      }
      // Drop exhausted frames so the next step does not re-read their trees.
      while (stack.length > 0 && stack[stack.length - 1]!.next >= trees.get(stack[stack.length - 1]!.hash)!.length) {
        stack.pop();
      }

      for (let i = 0; i < pending.length; i += READ_CONCURRENCY) {
        const chunk = pending.slice(i, i + READ_CONCURRENCY);
        const data = await Promise.all(
          chunk.map(async (p) => {
            if (!p.hash) return null;
            state.cost.blobReads++;
            const blob = await h.readBlob(p.hash);
            if (!blob) throw new Error(`blob ${p.hash} (${p.entry.path}) not found`);
            return new Uint8Array(await blob.arrayBuffer());
          }),
        );
        chunk.forEach((p, j) => {
          const bytes = data[j];
          if (p.entry.type === 'symlink') {
            writer.push(tarHeader({ ...p.entry, linkname: decode(bytes!) }));
          } else if (p.entry.type === 'file') {
            writer.push(tarHeader({ ...p.entry, size: bytes!.length }));
            writer.push(bytes!);
            writer.push(new Uint8Array(tarPadding(bytes!.length)));
          } else {
            writer.push(tarHeader(p.entry));
          }
        });
        await writer.flushFull();
      }
      state.done = stack.length === 0;
    });
    if (!state.done) return { state, carry: writer.rest() };
    writer.push(tarEnd());
    await writer.flushFull();
    state.size = await writer.finish();
    state.cost.objects = 1;
    state.cost.bytes = state.size;
    return { state, carry: new Uint8Array(0) };
  });
}

/** A batch result as one stream: u32 JSON length, the JSON state, then the carried tar bytes. */
export function encodeBatch(state: BatchState, carry: Uint8Array): ReadableStream<Uint8Array> {
  const json = encode(JSON.stringify(state));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length);
  return new Blob([head, json, carry as Uint8Array<ArrayBuffer>]).stream();
}

export async function decodeBatch(stream: ReadableStream<Uint8Array>): Promise<{ state: BatchState; carry: Uint8Array }> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  return { state: JSON.parse(decode(bytes.subarray(4, 4 + n))) as BatchState, carry: bytes.slice(4 + n) };
}

// ---------------------------------------------------------------------------
// finish / fail
// ---------------------------------------------------------------------------

async function finishStep(
  env: Env,
  p: Required<SnapshotParams> & { instanceId: string },
  target: BuildTarget,
  state: BatchState,
): Promise<BuildCost> {
  const cost = structuredClone(state.cost);
  return metered(env, cost, { step: 'finish', tree: target.tree }, async (env) => {
    // This step's own batch is part of the recorded cost.
    const final: BuildCost = { ...cost, steps: cost.steps + 1, d1: cost.d1 + 1 };
    const now = Date.now();
    const db = env.DB;
    await db.batch([
      db
        .prepare(
          `UPDATE snapshot_trees SET state = 'ready', size = ?4, files = ?5, built_at = ?6, build_cost = ?7, error = NULL
           WHERE repo_id = ?1 AND tree = ?2 AND builder = ?3 AND state = 'building'`,
        )
        .bind(p.repoId, target.tree, p.instanceId, state.size, state.files, now, JSON.stringify(final)),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'ready', built_at = ?4, error = NULL,
             build_cost = CASE WHEN sha = ?5 THEN ?6 ELSE build_cost END,
             reused = CASE WHEN sha = ?5 THEN 0 ELSE 1 END
           WHERE repo_id = ?1 AND tree = ?2 AND state = 'building'
             AND EXISTS (SELECT 1 FROM snapshot_trees t
                          WHERE t.repo_id = ?1 AND t.tree = ?2 AND t.builder = ?3 AND t.state = 'ready')`,
        )
        .bind(p.repoId, target.tree, p.instanceId, now, p.sha, JSON.stringify(final)),
    ]);
    return final;
  });
}

async function failStep(
  env: Env,
  p: Required<SnapshotParams> & { instanceId: string },
  tree: string | null,
  error: string,
): Promise<void> {
  const cost = emptyCost();
  await metered(env, cost, { step: 'fail', instance: p.instanceId, error }, async (env) => {
    const db = env.DB;
    await db.batch([
      db
        .prepare(
          `UPDATE snapshot_trees SET state = 'failed', error = ?4
           WHERE repo_id = ?1 AND tree = ?2 AND builder = ?3 AND state = 'building'`,
        )
        .bind(p.repoId, tree, p.instanceId, error),
      db
        .prepare(
          `UPDATE snapshot_commits SET state = 'failed', error = ?4
           WHERE repo_id = ?1 AND state = 'building'
             AND (sha = ?2 OR (?3 IS NOT NULL AND tree = ?3 AND NOT EXISTS (
                   SELECT 1 FROM snapshot_trees t WHERE t.repo_id = ?1 AND t.tree = ?3 AND t.state = 'building')))`,
        )
        .bind(p.repoId, p.sha, tree, error),
    ]);
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BuildOutcome {
  outcome: 'built' | 'done';
  reason?: string;
  tree?: string;
  cost: BuildCost;
}

export async function buildSnapshot(
  env: Env,
  params: SnapshotParams & { instanceId: string },
  step: StepRunner,
  options: BuildOptions = {},
): Promise<BuildOutcome> {
  const opts: Required<BuildOptions> = {
    blobsPerStep: options.blobsPerStep ?? BLOBS_PER_STEP,
    partSize: options.partSize ?? PART_SIZE,
  };
  const p = { ...params, trigger: params.trigger ?? 'push' };
  let tree: string | null = null;
  try {
    const resolved = await step.do('resolve', () => resolveStep(env, p));
    if (resolved.action === 'done') return { outcome: 'done', reason: resolved.reason, cost: resolved.cost };
    tree = resolved.tree;
    const target: BuildTarget = {
      repoId: p.repoId,
      tree: resolved.tree,
      key: resolved.key,
      artifactsName: resolved.artifactsName,
      mtime: resolved.mtime,
    };
    let state: BatchState = {
      stack: [{ path: '', hash: resolved.tree, next: 0 }],
      uploadId: null,
      parts: [],
      flushed: 0,
      files: 0,
      done: false,
      size: 0,
      cost: resolved.cost,
    };
    let carry: Uint8Array = new Uint8Array(0);
    for (let i = 1; !state.done; i++) {
      const input = state;
      const inputCarry = carry;
      const out = await step.do(`batch-${i}`, async () => {
        const r = await batchStep(env, target, input, inputCarry, i, opts);
        return encodeBatch(r.state, r.carry);
      });
      ({ state, carry } = await decodeBatch(out));
    }
    const finalState = state;
    const cost = await step.do('finish', () => finishStep(env, p, target, finalState));
    return { outcome: 'built', tree: target.tree, cost };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 300);
    const failedTree = tree;
    await step.do('fail', () => failStep(env, p, failedTree, message));
    throw err;
  }
}

const STEP_CONFIG = {
  retries: { limit: 4, delay: '5 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

export class SnapshotBuilder extends WorkflowEntrypoint<Env, SnapshotParams> {
  async run(event: WorkflowEvent<SnapshotParams>, step: WorkflowStep) {
    const runner: StepRunner = {
      do: <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, STEP_CONFIG, fn as () => Promise<never>) as Promise<T>,
    };
    return buildSnapshot(this.env, { ...event.payload, instanceId: event.instanceId }, runner);
  }
}
