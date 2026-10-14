/**
 * Path history of the default branch (architecture §11.10): which commits on
 * the first-parent chain changed a path, newest first, without a clone.
 *
 * The index is derived data in D1 (migration 0037), built lazily by the
 * requests that read it. Each request that finds work does one bounded step:
 * forward from the newest indexed commit to the branch head, then backward
 * toward the root with the budget that is left. A step is one compare-and-swap
 * on the state row (a fresh writer token), and the step's rows are inserted
 * in the same batch only if that swap applied, so racing requests never mix
 * partial steps. When the indexed head is no longer on the chain (a rewritten
 * or renamed default branch, or more than `logWindow` commits behind, as
 * confirmed against an uncached ref read), the index restarts in a new
 * epoch; older epochs are never served and are deleted in bounded batches.
 * Every answer says how complete the index is. A tree or `log` read that
 * fails is a 503 and records nothing; a tail `log` cannot follow ends the
 * backward walk as one gap.
 */

import { HistoryReadError, indexCommits, ZERO_OID, type HistoryCommit } from '@kvarm/gitops';
import { withLazyRepo } from '../artifacts/repo';
import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { resolveCtx } from './changes';
import { artifactsMergeSources } from './merge';
import { isInvalidObject, RefStoreUnavailable, resolveCommitish } from './refs';

export const HISTORY_LIMITS = {
  pageDefault: 30,
  pageMax: 100,
  /** First-parent commits one `log` call returns; the indexed head must be among them. */
  logWindow: 1000,
  /** Commits one request indexes (forward and backward together). */
  commitsPerStep: 50,
  treeReadsPerStep: 500,
  changesPerCommit: 2000,
  rowsPerStep: 5000,
  /** UTF-8 bytes of the changed paths one step records. */
  rowBytesPerStep: 1024 * 1024,
  /** Old-epoch rows one request deletes. */
  purgeRows: 500,
  /** JSON bytes bound to one insert statement (D1 caps a statement at 100 KB). */
  statementBytes: 64 * 1024,
  maxPathBytes: 4096,
} as const;

export interface HistoryEntry {
  sha: string;
  status: string;
  author: { name: string; email: string };
  committedAt: string;
  summary: string;
}

export interface HistoryView {
  path: string;
  ref: string;
  /** The default branch head this answer was computed against (null: no such branch). */
  headSha: string | null;
  commits: HistoryEntry[];
  nextCursor: string | null;
  index: {
    epoch: number;
    /** Newest indexed commit. */
    indexedHead: string | null;
    /** The index reaches the branch head. */
    current: boolean;
    /** The index reaches the root commit. */
    rootReached: boolean;
    /** Commits too large to index; their changes are listed nowhere. */
    gaps: number;
    /** current, rootReached and no gaps: the list is the path's complete first-parent history. */
    complete: boolean;
    /** This request advanced the index. */
    progressed: boolean;
  };
}

interface StateRow {
  epoch: number;
  ref: string;
  head_sha: string | null;
  head_seq: number;
  tail_next: string | null;
  tail_seq: number;
  gaps: number;
  writer: string;
}

interface PageRow {
  seq: number;
  status: string;
  sha: string;
  author_name: string;
  author_email: string;
  committed_at: number;
  summary: string;
}

type Fail = { ok: false; status: number; error: string; code: string };
const fail = (status: number, error: string, code: string): Fail => ({ ok: false, status, error, code });

function encodeCursor(epoch: number, seq: number): string {
  return btoa(`${epoch}:${seq}`).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function decodeCursor(cursor: string): { epoch: number; seq: number } | null {
  try {
    const m = /^(\d{1,9}):(-?\d{1,15})$/.exec(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    return m ? { epoch: Number(m[1]), seq: Number(m[2]) } : null;
  } catch {
    return null;
  }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function stateStatement(db: D1Database, repoId: string): D1PreparedStatement {
  return db.prepare('SELECT epoch, ref, head_sha, head_seq, tail_next, tail_seq, gaps, writer FROM path_history_state WHERE repo_id = ?').bind(repoId);
}

function pageStatement(db: D1Database, repoId: string, path: string, before: number | null, limit: number): D1PreparedStatement {
  return db
    .prepare(
      `SELECT h.seq, h.status, c.sha, c.author_name, c.author_email, c.committed_at, c.summary
         FROM path_history h
         JOIN path_history_commits c ON c.repo_id = h.repo_id AND c.epoch = h.epoch AND c.seq = h.seq
        WHERE h.repo_id = ?1 AND h.path = ?2
          AND h.epoch = (SELECT s.epoch FROM path_history_state s WHERE s.repo_id = ?1)
          AND (?3 IS NULL OR h.seq < ?3)
        ORDER BY h.seq DESC LIMIT ?4`,
    )
    .bind(repoId, path, before, limit + 1);
}

/** One first-parent commit as `log` returns it. */
type LogCommit = ArtifactsCommitMetadata;

/** The first-parent run of `log` output (it should be one already; stop at any break). */
function chainOf(log: readonly LogCommit[]): LogCommit[] {
  const out: LogCommit[] = [];
  for (const c of log) {
    if (out.length > 0 && out[out.length - 1]!.parents[0] !== c.hash) break;
    out.push(c);
  }
  return out;
}

interface Step {
  epoch: number;
  newEpoch: boolean;
  /** Commits to index, forward ones first (oldest to newest), then backward ones (newest to oldest). */
  commits: Array<HistoryCommit & { seq: number; meta: LogCommit; dir: 'forward' | 'backward' }>;
  /**
   * `log` of `tail_next` answered without that commit and its first parent:
   * the backward walk ends there, and the rest of the chain is one gap.
   */
  tailLost: boolean;
}

/** `log` from `ref`; with `missingIsEmpty`, a commit the binding reports as not existing is an empty log. */
async function logOf(h: ArtifactsRepo, ref: string, limit: number, missingIsEmpty = false): Promise<LogCommit[]> {
  try {
    return chainOf(await h.log({ ref, limit }));
  } catch (err) {
    if (missingIsEmpty && isInvalidObject(err)) return [];
    throw new RefStoreUnavailable(`log of ${ref} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Any Artifacts failure while answering is "storage unavailable": nothing has been recorded yet. */
async function storage<T>(what: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof RefStoreUnavailable) throw err;
    throw new RefStoreUnavailable(`${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Plans one step: which commits to index. */
async function planStep(h: ArtifactsRepo, state: StateRow | null, ref: string, headSha: string): Promise<Step | null> {
  const L = HISTORY_LIMITS;
  const window = await logOf(h, headSha, L.logWindow);
  if (window.length === 0 || window[0]!.hash !== headSha) throw new RefStoreUnavailable(`log of ${headSha} did not start at it`);
  const parentTree = (chain: LogCommit[], i: number): string | null | undefined => {
    const c = chain[i]!;
    if (c.parents.length === 0) return null;
    const p = chain[i + 1];
    return p && p.hash === c.parents[0] ? p.treeHash : undefined;
  };

  const idx = state && state.ref === ref && state.head_sha ? window.findIndex((c) => c.hash === state.head_sha) : -1;
  const newEpoch = idx < 0;
  const epoch = newEpoch ? (state?.epoch ?? 0) + 1 : state!.epoch;
  const commits: Step['commits'] = [];
  let headSeq = newEpoch ? 0 : state!.head_seq;
  const tailNext: string | null = newEpoch ? headSha : state!.tail_next;
  let tailSeq = newEpoch ? 1 : state!.tail_seq;

  // Forward: the commits newer than the indexed head, oldest first.
  if (!newEpoch) {
    for (let i = idx - 1; i >= 0 && commits.length < L.commitsPerStep; i--) {
      const pt = parentTree(window, i);
      if (pt === undefined) break;
      headSeq += 1;
      commits.push({ sha: window[i]!.hash, tree: window[i]!.treeHash, parentTree: pt, seq: headSeq, meta: window[i]!, dir: 'forward' });
    }
  }

  // Backward: from tail_next toward the root with what is left.
  let tailLost = false;
  if (tailNext && commits.length < L.commitsPerStep) {
    const want = L.commitsPerStep - commits.length;
    const at = window.findIndex((c) => c.hash === tailNext);
    // One more than needed, so the last one's parent tree is known.
    const run = at >= 0 && window.length - at > want ? window.slice(at) : await logOf(h, tailNext, want + 1, true);
    const before = commits.length;
    if (run.length > 0 && run[0]!.hash === tailNext) {
      for (let i = 0; i < run.length && i < want; i++) {
        const pt = parentTree(run, i);
        if (pt === undefined) break;
        tailSeq -= 1;
        commits.push({ sha: run[i]!.hash, tree: run[i]!.treeHash, parentTree: pt, seq: tailSeq, meta: run[i]!, dir: 'backward' });
      }
    }
    // A new epoch starts at the head `log` just walked, so only an older tail can be lost.
    tailLost = !newEpoch && commits.length === before;
  }
  if (commits.length === 0 && !tailLost) return null;
  return { epoch, newEpoch, commits, tailLost };
}

/** JSON arrays of `rows`, each small enough for one D1 statement. */
function jsonChunks(rows: readonly unknown[], maxBytes: number): string[] {
  const enc = new TextEncoder();
  const out: string[] = [];
  let current: string[] = [];
  let bytes = 2;
  for (const row of rows) {
    const json = JSON.stringify(row);
    const size = enc.encode(json).length + 1;
    if (current.length > 0 && bytes + size > maxBytes) {
      out.push(`[${current.join(',')}]`);
      current = [];
      bytes = 2;
    }
    current.push(json);
    bytes += size;
  }
  if (current.length > 0) out.push(`[${current.join(',')}]`);
  return out;
}

export async function pathHistory(
  env: Env,
  waitUntil: (p: Promise<unknown>) => void,
  repo: RepoRow,
  q: { path?: string; limit?: string; cursor?: string },
): Promise<ServiceResult<HistoryView>> {
  const L = HISTORY_LIMITS;
  const path = q.path ?? '';
  if (path.length === 0 || path.includes('\0') || new TextEncoder().encode(path).length > L.maxPathBytes) {
    return fail(400, `path must be a non-empty repository path of at most ${L.maxPathBytes} bytes`, 'INVALID_PATH');
  }
  let limit: number = L.pageDefault;
  if (q.limit !== undefined) {
    limit = /^\d{1,4}$/.test(q.limit) ? Number(q.limit) : 0;
    if (limit < 1 || limit > L.pageMax) return fail(400, `limit must be an integer from 1 to ${L.pageMax}`, 'INVALID_LIMIT');
  }
  const cursor = q.cursor === undefined ? null : decodeCursor(q.cursor);
  if (q.cursor !== undefined && !cursor) return fail(400, 'invalid cursor', 'INVALID_CURSOR');
  const ref = `refs/heads/${repo.default_branch}`;
  const db = env.DB;

  try {
    return await withLazyRepo(env, repo.artifacts_name, async (artifacts) => {
      const ctx = resolveCtx({ env, repo, waitUntil }, artifacts);
      let headSha = (await storage('head', () => resolveCommitish(ctx, [ref]))).get(ref)?.sha ?? null;

      const [stateRes, pageRes, ledgerRes] = await db.batch([
        stateStatement(db, repo.id),
        pageStatement(db, repo.id, path, cursor?.seq ?? null, limit),
        db.prepare('SELECT sha FROM repo_refs WHERE repo_id = ? AND ref = ?').bind(repo.id, ref),
      ]);
      let state = (stateRes?.results as StateRow[] | undefined)?.[0] ?? null;
      let page = (pageRes?.results as PageRow[] | undefined) ?? [];
      // The ref cache is per location; the push ledger is not. When the
      // ledger disagrees with a cached head (a deletion or a push this
      // location has not seen), the head is read again without the cache.
      const ledger = (ledgerRes?.results as Array<{ sha: string }> | undefined)?.[0]?.sha;
      let confirmed = false;
      if (ledger !== undefined && (ledger === ZERO_OID ? headSha !== null : ledger !== headSha)) {
        headSha = (await storage('head', () => resolveCommitish({ ...ctx, bypass: true }, [ref]))).get(ref)?.sha ?? null;
        confirmed = true;
      }
      if (cursor && state && cursor.epoch !== state.epoch) {
        return fail(409, 'the history index was rebuilt since this cursor was issued; start from the first page', 'STALE_CURSOR');
      }

      let progressed = false;
      const needsWork = headSha !== null && (!state || state.ref !== ref || state.head_sha !== headSha || state.tail_next !== null);
      // A cursor pages through the index as it stands; only first pages advance it.
      if (headSha !== null && needsWork && !cursor) {
        const h = await storage('repository', () => artifacts.get());
        let step = await planStep(h, state, ref, headSha);
        if (step?.newEpoch && !confirmed && state?.ref === ref && state.head_sha) {
          // The cached head may predate the indexed one (another colo saw a
          // newer push); confirm the head before discarding the index.
          const fresh = (await storage('head', () => resolveCommitish({ ...ctx, bypass: true }, [ref]))).get(ref)?.sha ?? null;
          if (fresh !== headSha) {
            headSha = fresh;
            step = fresh === null ? null : await planStep(h, state, ref, fresh);
          }
        }
        if (step) {
          let r;
          try {
            r = await indexCommits(artifactsMergeSources(ctx), step.commits, {
              maxTreeReads: L.treeReadsPerStep,
              maxChangesPerCommit: L.changesPerCommit,
              maxRows: L.rowsPerStep,
              maxRowBytes: L.rowBytesPerStep,
            });
          } catch (err) {
            if (err instanceof HistoryReadError) throw new RefStoreUnavailable(err.message);
            throw err;
          }
          const done = step.commits.slice(0, r.indexed.length);
          // State after the indexed prefix: forward ones move the head, backward ones the tail.
          let head = step.newEpoch ? null : { sha: state!.head_sha!, seq: state!.head_seq };
          let tail = step.newEpoch ? { next: headSha as string | null, seq: 1 } : { next: state!.tail_next, seq: state!.tail_seq };
          for (const c of done) {
            if (c.dir === 'forward') head = { sha: c.sha, seq: c.seq };
            else {
              if (step.newEpoch && head === null) head = { sha: c.sha, seq: c.seq };
              tail = { next: c.meta.parents[0] ?? null, seq: c.seq };
            }
          }
          // Only a step indexed in full reached the lost tail.
          const lost = step.tailLost && done.length === step.commits.length;
          if (lost) tail = { next: null, seq: tail.seq };
          if (head && (done.length > 0 || lost)) {
            const gaps = r.indexed.filter((x) => x.gap).length + (lost ? 1 : 0);
            const writer = crypto.randomUUID();
            const now = Date.now();
            const stmts: D1PreparedStatement[] = [];
            if (step.newEpoch) {
              stmts.push(
                db
                  .prepare(
                    `INSERT INTO path_history_state (repo_id, epoch, ref, head_sha, head_seq, tail_next, tail_seq, gaps, writer, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT (repo_id) DO UPDATE SET epoch = excluded.epoch, ref = excluded.ref, head_sha = excluded.head_sha,
                       head_seq = excluded.head_seq, tail_next = excluded.tail_next, tail_seq = excluded.tail_seq, gaps = excluded.gaps,
                       writer = excluded.writer, updated_at = excluded.updated_at
                     WHERE path_history_state.writer = ?11`,
                  )
                  .bind(repo.id, step.epoch, ref, head.sha, head.seq, tail.next, tail.seq, gaps, writer, now, state?.writer ?? null),
              );
            } else {
              stmts.push(
                db
                  .prepare(
                    `UPDATE path_history_state SET head_sha = ?2, head_seq = ?3, tail_next = ?4, tail_seq = ?5, gaps = gaps + ?6,
                       writer = ?7, updated_at = ?8
                     WHERE repo_id = ?1 AND writer = ?9`,
                  )
                  .bind(repo.id, head.sha, head.seq, tail.next, tail.seq, gaps, writer, now, state!.writer),
              );
            }
            const applied = 'EXISTS (SELECT 1 FROM path_history_state s WHERE s.repo_id = ?1 AND s.writer = ?3)';
            const commitRows = done.map((c, i) => ({
              q: c.seq,
              s: c.sha,
              n: clip(c.meta.author.name, 256),
              e: clip(c.meta.author.email, 256),
              t: c.meta.committedAt * 1000,
              m: clip(c.meta.message.split('\n', 1)[0] ?? '', 200),
              g: r.indexed[i]!.gap ? 1 : 0,
            }));
            // A path longer than a query may name can never be asked for.
            const enc = new TextEncoder();
            const pathRows = done.flatMap((c, i) =>
              r.indexed[i]!.changes.filter((x) => enc.encode(x.path).length <= L.maxPathBytes).map((x) => ({ p: x.path, q: c.seq, k: x.status })),
            );
            for (const chunk of jsonChunks(commitRows, L.statementBytes)) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR IGNORE INTO path_history_commits (repo_id, epoch, seq, sha, author_name, author_email, committed_at, summary, gap)
                     SELECT ?1, ?2, json_extract(j.value, '$.q'), json_extract(j.value, '$.s'), json_extract(j.value, '$.n'),
                            json_extract(j.value, '$.e'), json_extract(j.value, '$.t'), json_extract(j.value, '$.m'), json_extract(j.value, '$.g')
                       FROM json_each(?4) j WHERE ${applied}`,
                  )
                  .bind(repo.id, step.epoch, writer, chunk),
              );
            }
            for (const chunk of jsonChunks(pathRows, L.statementBytes)) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR IGNORE INTO path_history (repo_id, epoch, path, seq, status)
                     SELECT ?1, ?2, json_extract(j.value, '$.p'), json_extract(j.value, '$.q'), json_extract(j.value, '$.k')
                       FROM json_each(?4) j WHERE ${applied}`,
                  )
                  .bind(repo.id, step.epoch, writer, chunk),
              );
            }
            if (step.epoch > 1) {
              for (const table of ['path_history', 'path_history_commits']) {
                stmts.push(
                  db
                    .prepare(
                      `DELETE FROM ${table} WHERE rowid IN (
                         SELECT rowid FROM ${table} WHERE repo_id = ?1
                            AND epoch < (SELECT s.epoch FROM path_history_state s WHERE s.repo_id = ?1) LIMIT ?2)`,
                    )
                    .bind(repo.id, L.purgeRows),
                );
              }
            }
            const base = stmts.length;
            const results = await db.batch([...stmts, stateStatement(db, repo.id), pageStatement(db, repo.id, path, null, limit)]);
            state = (results[base]?.results as StateRow[] | undefined)?.[0] ?? null;
            page = (results[base + 1]?.results as PageRow[] | undefined) ?? [];
            progressed = state?.writer === writer;
          }
        }
      }

      // No branch, no history: an index left from before it was deleted is not served.
      if (headSha === null) page = [];
      const more = page.length > limit;
      const rows = more ? page.slice(0, limit) : page;
      const last = rows[rows.length - 1];
      const current = headSha === null ? true : state?.head_sha === headSha && state.ref === ref;
      const rootReached = headSha === null ? true : !!state && state.ref === ref && state.tail_next === null;
      const gaps = headSha === null ? 0 : (state?.gaps ?? 0);
      return {
        ok: true,
        value: {
          path,
          ref,
          headSha,
          commits: rows.map((r) => ({
            sha: r.sha,
            status: r.status,
            author: { name: r.author_name, email: r.author_email },
            committedAt: new Date(r.committed_at).toISOString(),
            summary: r.summary,
          })),
          nextCursor: more && last && state ? encodeCursor(state.epoch, last.seq) : null,
          index: {
            epoch: state?.epoch ?? 0,
            indexedHead: state?.head_sha ?? null,
            current,
            rootReached,
            gaps,
            complete: current && rootReached && gaps === 0,
            progressed,
          },
        },
      };
    });
  } catch (err) {
    if (err instanceof RefStoreUnavailable) {
      console.warn(JSON.stringify({ historyRefStore: err.message.slice(0, 200) }));
      return fail(503, 'repository storage is unavailable, retry shortly', 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/** Statements that remove a repo's history index, for the repo DELETE batch. */
export function historyCleanupStatements(db: D1Database, repoId: string): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM path_history WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM path_history_commits WHERE repo_id = ?').bind(repoId),
    db.prepare('DELETE FROM path_history_state WHERE repo_id = ?').bind(repoId),
  ];
}
