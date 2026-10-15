import { DurableObject } from 'cloudflare:workers';
import { ZERO_OID, cachedTreeReader, indexCommits, type HistoryCommit, type IndexedCommit, type TreeReader } from '@kvarm/gitops';

const LOG_WINDOW = 1000;
const WINDOW_LIMIT = 10;
const BATCH_SIZE = 200;
const MAX_CHANGES = 2000;
const MAX_TREE_READS = 5000;
const MAX_PATH_BYTES = 4096;
const CACHE_TREES = 20_000;
const MAX_SLICE_MS = 20_000;
const WAIT_MS = 2000;
const STATUS_TO_CODE = { added: 'a', removed: 'd', modified: 'm', renamed: 'r', typechange: 't' } as const;
const CODE_TO_STATUS = { a: 'added', d: 'removed', m: 'modified', r: 'renamed', t: 'typechange' } as const;

interface StateRow {
  epoch: number;
  repo_name: string;
  ref: string;
  head_sha: string | null;
  head_seq: number;
  tail_next: string | null;
  tail_seq: number;
  gaps: number;
  known_sha: string | null;
  known_at: number;
  memo_cached: string | null;
  memo_known: string | null;
  memo_fresh: string | null;
  memo_at: number;
  last_error: string | null;
}

export interface HistoryQuery {
  repoName: string;
  ref: string;
  path: string;
  limit: number;
  cursor: { epoch: number; seq: number } | null;
  cachedHead: string | null;
}

export interface HistoryResult {
  ok: boolean;
  value?: {
    path: string;
    ref: string;
    headSha: string | null;
    commits: Array<{ sha: string; status: string; author: { name: string; email: string }; committedAt: string; summary: string }>;
    nextCursor: { epoch: number; seq: number } | null;
    index: { epoch: number; indexedHead: string | null; current: boolean; rootReached: boolean; gaps: number; complete: boolean; progressed: boolean };
  };
  status?: number;
  error?: string;
  code?: string;
}

const stateSql = `CREATE TABLE IF NOT EXISTS state (
  epoch INTEGER NOT NULL, repo_name TEXT NOT NULL, ref TEXT NOT NULL, head_sha TEXT, head_seq INTEGER NOT NULL,
  tail_next TEXT, tail_seq INTEGER NOT NULL, gaps INTEGER NOT NULL DEFAULT 0,
  known_sha TEXT, known_at INTEGER NOT NULL DEFAULT 0, memo_cached TEXT, memo_known TEXT,
  memo_fresh TEXT, memo_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL
)`;

function firstParentRun(commits: ArtifactsCommitMetadata[]): ArtifactsCommitMetadata[] {
  let end = 1;
  while (end < commits.length && commits[end - 1]!.parents[0] === commits[end]!.hash) end++;
  return commits.slice(0, end);
}

export class PathHistory extends DurableObject<Env> {
  protected artifacts: Artifacts;
  private ready: Promise<void>;
  private running: Promise<void> | null = null;
  private headRead: Promise<string | null> | null = null;
  private readonly pageWaiters = new Set<() => void>();
  private destroyed = false;
  private repoName = '';
  private ref = '';
  private window: ArtifactsCommitMetadata[] = [];
  private forwardHead: string | null = null;
  private forwardFrom: string | null = null;
  private forwardQueue: ArtifactsCommitMetadata[] = [];
  private forwardParentTree: string | null = null;
  private treeReader: TreeReader | null = null;
  private repoHandle: ArtifactsRepo | null = null;
  private targetHead: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.artifacts = env.ARTIFACTS;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(stateSql);
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS commits (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL, author_name TEXT, author_email TEXT, committed_at INTEGER, summary TEXT, gap INTEGER NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS postings (path_id INTEGER NOT NULL, top INTEGER NOT NULL, bottom INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(path_id, top)) WITHOUT ROWID');
    });
  }

  private rows<T>(sql: string, ...values: unknown[]): T[] {
    return this.ctx.storage.sql.exec(sql, ...values).toArray() as unknown as T[];
  }

  private state(): StateRow | null {
    return this.rows<StateRow>('SELECT * FROM state LIMIT 1')[0] ?? null;
  }

  private pageEntries(path: string, before: number, limit: number): Array<{ seq: number; status: string }> {
    const pathId = this.rows<{ id: number }>('SELECT id FROM paths WHERE path=?', path)[0]?.id;
    if (pathId === undefined) return [];
    const rows: Array<{ top: number; bottom: number; data: string }> = [];
    if (before !== Number.MAX_SAFE_INTEGER) {
      const straddler = this.rows<{ top: number; bottom: number; data: string }>(
        'SELECT top,bottom,data FROM postings WHERE path_id=? AND top>=? ORDER BY top ASC LIMIT 1',
        pathId, before,
      )[0];
      if (straddler && straddler.bottom < before) rows.push(straddler);
    }
    rows.push(...this.rows<{ top: number; bottom: number; data: string }>(
      'SELECT top,bottom,data FROM postings WHERE path_id=? AND top<? ORDER BY top DESC LIMIT ?',
      pathId, before, limit,
    ));
    const entries: Array<{ seq: number; status: string }> = [];
    for (const posting of rows) {
      for (const encoded of posting.data.split(',')) {
        const match = /^(-?\d+)([adrmt])$/.exec(encoded);
        if (!match) continue;
        const seq = Number(match[1]);
        if (seq < before) entries.push({ seq, status: match[2]! });
        if (entries.length === limit) return entries;
      }
    }
    return entries;
  }

  private firstPageReady(input: HistoryQuery, head: string): boolean {
    const state = this.state();
    if (!state || state.ref !== input.ref || state.head_sha !== head) return false;
    return state.tail_next === null || this.pageEntries(input.path, Number.MAX_SAFE_INTEGER, input.limit + 1).length >= input.limit + 1;
  }

  private waitForFirstPage(input: HistoryQuery, head: string): Promise<void> {
    if (this.destroyed || this.firstPageReady(input, head)) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.pageWaiters.delete(check);
        resolve();
      };
      const check = () => {
        if (this.destroyed || this.firstPageReady(input, head)) finish();
      };
      this.pageWaiters.add(check);
      timer = setTimeout(finish, WAIT_MS);
      check();
    });
  }

  private notifyPageWaiters(): void {
    for (const wake of this.pageWaiters) wake();
  }

  private async arm(): Promise<void> {
    if (this.destroyed) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      if (!this.destroyed) await this.ctx.storage.setAlarm(Date.now());
    }
    if (this.destroyed) await this.ctx.storage.deleteAlarm();
  }

  async pushed(input: { ref: string; after: string; eventAt: number }): Promise<'indexed' | 'not indexed'> {
    await this.ready;
    if (this.destroyed) return 'not indexed';
    const state = this.state();
    if (!state) return 'not indexed';
    if (input.ref === state.ref && input.eventAt >= state.known_at) {
      this.repoName = state.repo_name;
      const after = input.after === ZERO_OID ? null : input.after;
      this.ctx.storage.sql.exec('UPDATE state SET known_sha = ?, known_at = ?, updated_at = ?', after, input.eventAt, Date.now());
      this.targetHead = after;
      await this.arm();
      return 'indexed';
    }
    return 'not indexed';
  }

  async destroy(): Promise<void> {
    await this.ready;
    this.destroyed = true;
    this.notifyPageWaiters();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async query(input: HistoryQuery): Promise<HistoryResult> {
    await this.ready;
    if (this.destroyed) return { ok: false, status: 503, error: 'repository storage is unavailable, retry shortly', code: 'STORAGE_UNAVAILABLE' };
    this.repoName = input.repoName;
    this.ref = input.ref;
    let state = this.state();
    let head = input.cachedHead;
    if (state && head === state.known_sha) {
      head = state.known_sha;
    } else if (state && state.memo_cached === input.cachedHead && state.memo_known === state.known_sha && Date.now() - state.memo_at < 30_000) {
      head = state.memo_fresh;
    } else {
      try {
        head = await this.freshHead(input);
      } catch {
        return { ok: false, status: 503, error: 'repository storage is unavailable, retry shortly', code: 'STORAGE_UNAVAILABLE' };
      }
    }
    if (this.destroyed) return { ok: false, status: 503, error: 'repository storage is unavailable, retry shortly', code: 'STORAGE_UNAVAILABLE' };
    this.targetHead = head;
    state = this.state();
    if (input.cursor && state && (input.cursor.epoch !== state.epoch || state.ref !== input.ref)) {
      return { ok: false, status: 409, error: 'the history index was rebuilt since this cursor was issued; start from the first page', code: 'STALE_CURSOR' };
    }
    let progressed = false;
    if (head !== null && !input.cursor) {
      if (this.firstPageReady(input, head)) {
        if (!state || state.ref !== input.ref || state.head_sha !== head || state.tail_next !== null) await this.arm();
      } else {
        const previous = state ? `${state.epoch}:${state.head_sha}:${state.head_seq}:${state.tail_next}:${state.tail_seq}` : '';
        const waiting = this.waitForFirstPage(input, head);
        await this.arm();
        void this.start().catch(() => {});
        await waiting;
        if (this.destroyed) return { ok: false, status: 503, error: 'repository storage is unavailable, retry shortly', code: 'STORAGE_UNAVAILABLE' };
        state = this.state();
        progressed = state !== null && previous !== `${state.epoch}:${state.head_sha}:${state.head_seq}:${state.tail_next}:${state.tail_seq}`;
      }
    }
    if (this.destroyed) return { ok: false, status: 503, error: 'repository storage is unavailable, retry shortly', code: 'STORAGE_UNAVAILABLE' };
    if (head === null) {
      return {
        ok: true,
        value: {
          path: input.path, ref: input.ref, headSha: null, commits: [], nextCursor: null,
          index: { epoch: state?.epoch ?? 0, indexedHead: state?.head_sha ?? null, current: true, rootReached: true, gaps: 0, complete: true, progressed },
        },
      };
    }
    state = this.state();
    if (!state) return { ok: true, value: { path: input.path, ref: input.ref, headSha: head, commits: [], nextCursor: null, index: { epoch: 0, indexedHead: null, current: false, rootReached: false, gaps: 0, complete: false, progressed } } };
    const before = input.cursor?.seq ?? Number.MAX_SAFE_INTEGER;
    const selected = this.pageEntries(input.path, before, input.limit + 1);
    const seqs = selected.map((entry) => entry.seq);
    const commits = seqs.flatMap((seq) =>
      this.rows<{ seq: number; sha: string; author_name: string; author_email: string; committed_at: number; summary: string }>(
        'SELECT seq,sha,author_name,author_email,committed_at,summary FROM commits WHERE seq=?',
        seq,
      ),
    );
    const bySeq = new Map(commits.map((row) => [row.seq, row]));
    const page = selected.slice(0, input.limit).flatMap((entry) => {
      const commit = bySeq.get(entry.seq);
      return commit ? [{ ...commit, status: entry.status }] : [];
    });
    const more = selected.length > input.limit;
    const current = state.ref === input.ref && state.head_sha === head;
    const rootReached = state.tail_next === null;
    return {
      ok: true,
      value: {
        path: input.path, ref: input.ref, headSha: head,
        commits: page.map((row) => ({ sha: row.sha, status: CODE_TO_STATUS[row.status as keyof typeof CODE_TO_STATUS] ?? row.status, author: { name: row.author_name, email: row.author_email }, committedAt: new Date(row.committed_at).toISOString(), summary: row.summary })),
        nextCursor: more && page.length ? { epoch: state.epoch, seq: page[page.length - 1]!.seq } : null,
        index: { epoch: state.epoch, indexedHead: state.head_sha, current, rootReached, gaps: state.gaps, complete: current && rootReached && state.gaps === 0, progressed },
      },
    };
  }

  private start(): Promise<void> {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private freshHead(input: HistoryQuery): Promise<string | null> {
    if (!this.headRead) {
      this.headRead = (async () => {
        const repo = await this.artifacts.get(input.repoName);
        const name = input.ref.replace(/^refs\/heads\//, '');
        try {
          const log = await repo.log({ ref: name, limit: 1 });
          const head = log[0]?.hash ?? null;
          if (this.destroyed) return null;
          this.ctx.storage.sql.exec(
            `UPDATE state SET repo_name = ?, known_sha = ?, known_at = ?, memo_cached = ?, memo_known = ?, memo_fresh = ?, memo_at = ?`,
            input.repoName,
            head,
            Date.now(),
            input.cachedHead,
            head,
            head,
            Date.now(),
          );
          return head;
        } finally {
          try {
            repo[Symbol.dispose]();
          } catch {}
        }
      })().finally(() => { this.headRead = null; });
    }
    return this.headRead;
  }

  async alarm(): Promise<void> {
    await this.ready;
    if (this.destroyed) return;
    const state = this.state();
    this.repoName = state?.repo_name ?? '';
    this.ref = state?.ref ?? '';
    this.targetHead = state?.known_sha ?? null;
    await this.start();
  }

  private async run(): Promise<void> {
    const until = Date.now() + MAX_SLICE_MS;
    while (!this.destroyed && this.targetHead && Date.now() < until) {
      const before = this.state();
      if (before && before.head_sha === this.targetHead && before.tail_next === null) break;
      try {
        await this.indexBatch();
      } catch (err) {
        if (this.destroyed) return;
        this.ctx.storage.sql.exec('UPDATE state SET last_error = ?, updated_at = ?', String(err).slice(0, 200), Date.now());
        console.warn(JSON.stringify({ pathHistory: String(err).slice(0, 200) }));
        throw err;
      }
      if (this.destroyed) return;
      this.notifyPageWaiters();
      const state = this.state();
      if (state && state.head_sha === this.targetHead && state.tail_next === null) break;
    }
    if (this.destroyed) return;
    const state = this.state();
    if (this.targetHead && (!state || state.head_sha !== this.targetHead || state.tail_next !== null)) {
      await this.ctx.storage.setAlarm(Date.now());
      if (this.destroyed) await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private async indexBatch(): Promise<void> {
    if (this.destroyed) return;
    const head = this.targetHead!;
    let state = this.state();
    if (!state || state.ref !== this.ref || (!state.head_sha && state.known_sha !== head)) {
      this.resetEpoch(state, head);
      if (this.destroyed) return;
      state = this.state();
    }
    const repo = this.repoHandle ?? (this.repoHandle = await this.artifacts.get(this.repoName));
    if (this.destroyed) return;
    if (state!.head_sha && state!.head_sha !== head) {
      const indexed = await this.indexForward(repo, state!, head);
      if (this.destroyed) return;
      if (indexed) return;
      this.resetEpoch(state, head);
      if (this.destroyed) return;
      state = this.state();
    }
    let window = this.window;
    if (window.length === 0 || window[0]?.hash !== (state!.tail_next ?? head)) {
      try {
        window = firstParentRun(await repo.log({ ref: state!.tail_next ?? head, limit: LOG_WINDOW }));
      } catch (err) {
        if (this.destroyed) return;
        if ((err as { code?: string }).code !== 'NOT_FOUND' || state!.tail_next === head) throw err;
        this.ctx.storage.sql.exec('UPDATE state SET tail_next=NULL,gaps=gaps+1');
        return;
      }
      if (this.destroyed) return;
      this.window = window;
    }
    if (window.length === 0) {
      this.ctx.storage.sql.exec('UPDATE state SET tail_next=NULL,gaps=gaps+1');
      return;
    }
    const commits = window.slice(0, BATCH_SIZE);
    let batchLength = commits.length;
    for (let i = 0; i < commits.length; i++) {
      const commit = commits[i]!;
      const next = window[i + 1];
      if (commit.parents.length > 0 && next?.hash !== commit.parents[0]) {
        batchLength = i;
        break;
      }
    }
    if (batchLength === 0) {
      const missingParent = commits[0]!;
      const seq = state!.tail_seq - 1;
      this.persist(
        [{ sha: missingParent.hash, tree: missingParent.treeHash, parentTree: null, meta: missingParent, seq }],
        [{ sha: missingParent.hash, changes: [], gap: true }],
        () => this.ctx.storage.sql.exec(
          'UPDATE state SET head_sha=COALESCE(head_sha,?),head_seq=COALESCE(head_seq,?),tail_next=NULL,tail_seq=?,gaps=gaps+1,last_error=NULL,updated_at=?',
          missingParent.hash, seq, seq, Date.now(),
        ),
      );
      this.window = [];
      return;
    }
    const inputs: Array<HistoryCommit & { meta: ArtifactsCommitMetadata; seq: number }> = commits.slice(0, batchLength).map((c, i) => {
      const parent = window[i + 1];
      return {
        sha: c.hash, tree: c.treeHash, parentTree: c.parents.length === 0 ? null : parent!.treeHash,
        meta: c, seq: state!.tail_seq - i - 1,
      };
    });
    this.treeReader ??= cachedTreeReader({ readTree: (hash) => repo.readTree(hash) }, CACHE_TREES);
    const result = await indexCommits(this.treeReader, inputs, { maxTreeReads: MAX_TREE_READS, maxChangesPerCommit: MAX_CHANGES, maxRows: 100_000, commitConcurrency: 8 });
    if (this.destroyed) return;
    const indexed = inputs.slice(0, result.indexed.length);
    this.persist(indexed, result.indexed, () => {
      const last = indexed[indexed.length - 1];
      if (last) this.ctx.storage.sql.exec('UPDATE state SET head_sha=COALESCE(head_sha,?),head_seq=COALESCE(head_seq,0),tail_next=?,tail_seq=?,gaps=gaps+?,last_error=NULL,updated_at=?', commits[0]!.hash, last.meta.parents[0] ?? null, last.seq, result.indexed.filter((x) => x.gap).length, Date.now());
    });
    if (indexed.length < batchLength) this.window = window.slice(indexed.length);
    else this.window = batchLength < commits.length ? [] : window.slice(commits.length);
  }

  private resetEpoch(state: StateRow | null, head: string): void {
    if (this.destroyed) return;
    this.ctx.storage.sql.exec('DROP TABLE postings');
    this.ctx.storage.sql.exec('DROP TABLE commits');
    this.ctx.storage.sql.exec('DROP TABLE paths');
    this.ctx.storage.sql.exec('CREATE TABLE paths (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE)');
    this.ctx.storage.sql.exec('CREATE TABLE commits (seq INTEGER PRIMARY KEY, sha TEXT NOT NULL, author_name TEXT, author_email TEXT, committed_at INTEGER, summary TEXT, gap INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('CREATE TABLE postings (path_id INTEGER NOT NULL, top INTEGER NOT NULL, bottom INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(path_id, top)) WITHOUT ROWID');
    this.ctx.storage.sql.exec('DELETE FROM state');
    this.ctx.storage.sql.exec(
      `INSERT INTO state(epoch,repo_name,ref,head_sha,head_seq,tail_next,tail_seq,gaps,known_sha,known_at,memo_cached,memo_known,memo_fresh,memo_at,last_error,updated_at)
       VALUES(?,?,?,NULL,0,?,1,0,?,?,NULL,NULL,NULL,0,NULL,?)`,
      (state?.epoch ?? 0) + 1, this.repoName, this.ref, head, head, Date.now(), Date.now(),
    );
    this.window = [];
    this.forwardHead = null;
    this.forwardFrom = null;
    this.forwardQueue = [];
    this.forwardParentTree = null;
  }

  private async indexForward(repo: ArtifactsRepo, state: StateRow, head: string): Promise<boolean> {
    if (this.forwardHead === head && this.forwardFrom === state.head_sha) return this.persistForward(repo, state);
    const chain: ArtifactsCommitMetadata[] = [];
    let ref = head;
    let foundAt = -1;
    let oldTree: string | null = null;
    for (let window = 0; window < WINDOW_LIMIT; window++) {
      const part = firstParentRun(await repo.log({ ref, limit: LOG_WINDOW }));
      if (this.destroyed) return false;
      if (part.length === 0) break;
      foundAt = part.findIndex((commit) => commit.hash === state.head_sha);
      if (foundAt >= 0) {
        oldTree = part[foundAt]!.treeHash;
        chain.push(...part.slice(0, foundAt));
        break;
      }
      chain.push(...part);
      const parent = part[part.length - 1]!.parents[0];
      if (!parent) break;
      ref = parent;
    }
    if (foundAt < 0) return false;
    this.forwardHead = head;
    this.forwardFrom = state.head_sha;
    this.forwardQueue = chain.reverse();
    this.forwardParentTree = oldTree;
    return this.persistForward(repo, state);
  }

  private async persistForward(repo: ArtifactsRepo, state: StateRow): Promise<boolean> {
    if (this.destroyed) return false;
    const chronological = this.forwardQueue.slice(0, BATCH_SIZE);
    if (chronological.length === 0) return true;
    const inputs: Array<HistoryCommit & { meta: ArtifactsCommitMetadata; seq: number }> = chronological.map((meta, i) => ({
      sha: meta.hash,
      tree: meta.treeHash,
      parentTree: i === 0 ? this.forwardParentTree : chronological[i - 1]!.treeHash,
      meta,
      seq: state.head_seq + i + 1,
    }));
    this.treeReader ??= cachedTreeReader({ readTree: (hash) => repo.readTree(hash) }, CACHE_TREES);
    const result = await indexCommits(this.treeReader, inputs, { maxTreeReads: MAX_TREE_READS, maxChangesPerCommit: MAX_CHANGES, maxRows: 100_000, commitConcurrency: 8 });
    if (this.destroyed) return false;
    const indexed = inputs.slice(0, result.indexed.length);
    this.persist(indexed, result.indexed, () => {
      const last = indexed[indexed.length - 1];
      if (last) this.ctx.storage.sql.exec(
        'UPDATE state SET head_sha=?,head_seq=?,gaps=gaps+?,last_error=NULL,updated_at=?',
        last.sha,
        last.seq,
        result.indexed.filter((item) => item.gap).length,
        Date.now(),
      );
    });
    this.forwardQueue.splice(0, indexed.length);
    const last = indexed[indexed.length - 1];
    if (last) {
      this.forwardFrom = last.sha;
      this.forwardParentTree = last.meta.treeHash;
    }
    return true;
  }

  private persist(
    inputs: Array<HistoryCommit & { meta: ArtifactsCommitMetadata; seq: number }>,
    indexed: readonly IndexedCommit[],
    updateState: () => void,
  ): void {
    if (this.destroyed) return;
    this.ctx.storage.transactionSync(() => {
      const changesByPath = new Map<string, Array<{ seq: number; status: string }>>();
      for (let i = 0; i < inputs.length; i++) {
        const commit = inputs[i]!;
        const item = indexed[i]!;
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO commits(seq,sha,author_name,author_email,committed_at,summary,gap) VALUES(?,?,?,?,?,?,?)',
          commit.seq, commit.sha, commit.meta.author.name.slice(0, 256), commit.meta.author.email.slice(0, 256),
          commit.meta.committedAt * 1000, commit.meta.message.split('\n')[0]?.slice(0, 200) ?? '', item.gap ? 1 : 0,
        );
        for (const change of item.changes) {
          if (new TextEncoder().encode(change.path).length > MAX_PATH_BYTES) continue;
          const code = STATUS_TO_CODE[change.status as keyof typeof STATUS_TO_CODE];
          if (!code) continue;
          const entries = changesByPath.get(change.path) ?? [];
          entries.push({ seq: commit.seq, status: code });
          changesByPath.set(change.path, entries);
        }
      }
      for (const [path, entries] of changesByPath) {
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO paths(path) VALUES(?)', path);
        const pathId = this.rows<{ id: number }>('SELECT id FROM paths WHERE path=?', path)[0]!.id;
        entries.sort((a, b) => b.seq - a.seq);
        this.ctx.storage.sql.exec(
          'INSERT INTO postings(path_id,top,bottom,data) VALUES(?,?,?,?)',
          pathId,
          entries[0]!.seq,
          entries[entries.length - 1]!.seq,
          entries.map((entry) => `${entry.seq}${entry.status}`).join(','),
        );
      }
      updateState();
    });
    this.notifyPageWaiters();
  }
}
