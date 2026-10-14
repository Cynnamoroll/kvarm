/**
 * Merge service (architecture §4 services/merge.ts, invariant 5, §0.3):
 * mergeability over commits and trees, fast-forward and three-way merge
 * commits, the checks-gate as the only source of required checks, and
 * publication of exactly one ref through GitPusher where only a confirmed
 * `ok` counts.
 */

import { env as cfEnv } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  BlobTooLargeError,
  concat,
  decode,
  encode,
  parseTree,
  pktLine,
  ZERO_OID,
  type FetchLike,
  type GitObject,
  type PackInput,
  type RefCommand,
  type RefUpdateResult,
} from '@kvarm/gitops';
import { internalKey, writeCachedJson } from '../src/cache/internal';
import { withLazyRepo, type LazyRepo } from '../src/artifacts/repo';
import type { RepoRow } from '../src/db/repos';
import { memoGate } from '../src/services/changes';
import { checksGate, type ChecksProducer, type RequiredCheck } from '../src/services/checksGate';
import { artifactsPusher, type GitPusher } from '../src/services/gitwrite';
import {
  KVARM_COMMITTER,
  artifactsMergeSources,
  computeMergeability,
  prepareMerge,
  publishMerge,
  type MergeAttributionHook,
} from '../src/services/merge';
import { MemGit as Store } from './helpers/memGit';
import { FakeRepo, commit as fakeCommit, fakeArtifacts, fakeRepos, writeTree as fakeWriteTree } from './helpers/fakeArtifacts';

const baseEnv = cfEnv as unknown as Env;
const REPO = { id: 'repo-merge-test' };

/** A one-ref CAS remote over a Store: objects land only on a confirmed update. */
class FakePusher implements GitPusher {
  readonly refs = new Map<string, string>();
  readonly calls: Array<{ command: RefCommand; objects: readonly PackInput[] }> = [];
  /** `prepare` and `send` in the order they happened; tests may append their own events. */
  readonly events: string[] = [];

  constructor(private readonly store: Store) {}

  async listRefs() {
    return new Map(this.refs);
  }

  async prepareUpdate(command: RefCommand, objects: readonly PackInput[] = []) {
    this.events.push('prepare');
    return {
      send: async () => {
        this.events.push('send');
        return this.apply(command, objects);
      },
    };
  }

  async updateRef(command: RefCommand, objects: readonly PackInput[] = []): Promise<RefUpdateResult> {
    return (await this.prepareUpdate(command, objects)).send();
  }

  private apply(command: RefCommand, objects: readonly PackInput[]): RefUpdateResult {
    this.calls.push({ command, objects });
    if ((this.refs.get(command.ref) ?? ZERO_OID) !== command.oldOid) return { status: 'stale', reason: 'stale ref', httpStatus: 200 };
    for (const o of objects) this.store.add(o as GitObject);
    this.refs.set(command.ref, command.newOid);
    return { status: 'ok', httpStatus: 200 };
  }
}

function producer(checks: Array<Omit<RequiredCheck, 'producer'>>, seen: unknown[] = []): ChecksProducer {
  return {
    name: 'fake-ci',
    async requiredChecksFor(repo, treeSha, configId) {
      seen.push({ repo: repo.id, treeSha, configId });
      return checks;
    },
  };
}

/** main: README + src/a.txt; feature edits a.txt; main moves on with README. */
async function divergent(store: Store) {
  const base = await store.commit([], { 'README.md': 'hello\n', 'src/a.txt': 'a1\na2\na3\n' });
  const head = await store.commit([base], { 'README.md': 'hello\n', 'src/a.txt': 'a1\nA2\na3\n' }, 'feature');
  const main = await store.commit([base], { 'README.md': 'hello world\n', 'src/a.txt': 'a1\na2\na3\n' }, 'main moves');
  const mergedTree = await new Store().tree({ 'README.md': 'hello world\n', 'src/a.txt': 'a1\nA2\na3\n' });
  return { base, head, main, mergedTree };
}

describe('checksGate', () => {
  it('with no producers the required set is empty and its state is success', async () => {
    const gate = checksGate([]);
    expect(await gate.requiredChecksFor(REPO, 'a'.repeat(40), null)).toEqual({
      treeSha: 'a'.repeat(40),
      configId: null,
      required: [],
      state: 'success',
    });
  });

  it('rolls producer checks up: any failure fails, else any pending is pending', async () => {
    const seen: unknown[] = [];
    const gate = checksGate([
      producer([{ name: 'unit', state: 'success' }], seen),
      producer([
        { name: 'lint', state: 'pending' },
        { name: 'e2e', state: 'failure' },
      ]),
    ]);
    const r = await gate.requiredChecksFor(REPO, 'b'.repeat(40), 'cfg-1');
    expect(r.state).toBe('failure');
    expect(r.required.map((c) => `${c.producer}:${c.name}:${c.state}`)).toEqual(['fake-ci:unit:success', 'fake-ci:lint:pending', 'fake-ci:e2e:failure']);
    expect(seen).toEqual([{ repo: REPO.id, treeSha: 'b'.repeat(40), configId: 'cfg-1' }]);
    expect((await checksGate([producer([{ name: 'lint', state: 'pending' }])]).requiredChecksFor(REPO, 'c'.repeat(40), null)).state).toBe('pending');
  });

  it('memoizes only identical change, head and guard-base subjects', async () => {
    const seen: unknown[] = [];
    const inner = checksGate([
      {
        name: 'identity',
        async requiredChecksFor(_repo, _treeSha, _configId, subject) {
          seen.push(subject);
          return [];
        },
      },
    ]);
    const gate = memoGate(inner);
    const common = { headSha: 'a'.repeat(40), guardBaseTree: 'b'.repeat(40) };
    await gate.requiredChecksFor(REPO, 'c'.repeat(40), null, { changeId: 'change-1', ...common });
    await gate.requiredChecksFor(REPO, 'c'.repeat(40), null, { changeId: 'change-1', ...common });
    await gate.requiredChecksFor(REPO, 'c'.repeat(40), null, { changeId: 'change-2', ...common });
    await gate.requiredChecksFor(REPO, 'c'.repeat(40), null, { changeId: 'change-1', ...common, guardBaseTree: 'd'.repeat(40) });
    expect(seen).toHaveLength(3);
  });
});

describe('computeMergeability', () => {
  it('fast-forward when the target is an ancestor of the head; checks are asked about the head tree', async () => {
    const store = new Store();
    const base = await store.commit([], { 'README.md': 'v1\n' });
    const head = await store.commit([base], { 'README.md': 'v2\n' });
    const seen: unknown[] = [];
    const m = await computeMergeability(store, checksGate([producer([], seen)]), { repo: REPO, targetSha: base, headSha: head, configId: 'cfg' });
    const headTree = (await store.readCommit(head))!.treeHash;
    expect(m).toMatchObject({
      status: 'fast-forward',
      fastForward: true,
      mergeBase: base,
      treeSha: headTree,
      conflicts: [],
      mergeable: true,
      checks: { treeSha: headTree, configId: 'cfg', required: [], state: 'success' },
    });
    expect(seen).toEqual([{ repo: REPO.id, treeSha: headTree, configId: 'cfg' }]);
  });

  it('clean three-way merge reports the merged tree it would publish', async () => {
    const store = new Store();
    const { head, main, base, mergedTree } = await divergent(store);
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({ status: 'clean', fastForward: false, mergeBase: base, treeSha: mergedTree, mergeable: true });
    expect(m.checks).toMatchObject({ treeSha: mergedTree, required: [], state: 'success' });
    expect(m.work.commitReads).toBeGreaterThan(0);
    expect(m.work.blobReads).toBe(0);
  });

  it('conflicts are listed and not mergeable; no checks are asked for a tree that does not exist', async () => {
    const store = new Store();
    const base = await store.commit([], { 'a.txt': 'one\n' });
    const head = await store.commit([base], { 'a.txt': 'two\n' });
    const main = await store.commit([base], { 'a.txt': 'three\n' });
    const seen: unknown[] = [];
    const m = await computeMergeability(store, checksGate([producer([], seen)]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({ status: 'conflicts', mergeable: false, treeSha: null, checks: null });
    expect(m.conflicts).toMatchObject([{ path: 'a.txt', kind: 'content', hunks: 1 }]);
    expect(seen).toEqual([]);
  });

  it('up-to-date, unrelated and unreadable histories are not mergeable', async () => {
    const store = new Store();
    const base = await store.commit([], { 'a.txt': '1\n' });
    const main = await store.commit([base], { 'a.txt': '2\n' });
    const other = await store.commit([], { 'b.txt': '1\n' });
    const gate = checksGate([]);
    expect(await computeMergeability(store, gate, { repo: REPO, targetSha: main, headSha: base })).toMatchObject({ status: 'up-to-date', mergeable: false });
    expect(await computeMergeability(store, gate, { repo: REPO, targetSha: main, headSha: other })).toMatchObject({ status: 'unrelated', mergeable: false });
    expect(await computeMergeability(store, gate, { repo: REPO, targetSha: main, headSha: 'f'.repeat(40) })).toMatchObject({
      status: 'unknown',
      unknownReason: 'missingCommit',
      mergeable: false,
    });
  });

  it('a failing or pending required check makes a clean merge not mergeable; the state is reported', async () => {
    const store = new Store();
    const { head, main } = await divergent(store);
    const failing = await computeMergeability(store, checksGate([producer([{ name: 'ci', state: 'failure' }])]), { repo: REPO, targetSha: main, headSha: head });
    expect(failing).toMatchObject({ status: 'clean', mergeable: false, checks: { state: 'failure' } });
    const pending = await computeMergeability(store, checksGate([producer([{ name: 'ci', state: 'pending' }])]), { repo: REPO, targetSha: main, headSha: head });
    expect(pending).toMatchObject({ status: 'clean', mergeable: false, checks: { state: 'pending' } });
  });
});

describe('artifactsMergeSources', () => {
  function sources(handle: Partial<ArtifactsRepo>, maxBlobBytes?: number) {
    const ctx = {
      env: baseEnv,
      repo: { id: crypto.randomUUID() } as RepoRow,
      artifacts: { get: async () => handle as ArtifactsRepo } as unknown as LazyRepo,
      bypass: true,
      waitUntil: () => {},
    };
    return artifactsMergeSources(ctx, maxBlobBytes);
  }

  it('normalizes tree modes to git canonical form and maps invalid objects to null', async () => {
    const s = sources({
      readTree: (async (hash: string) => {
        if (hash === 'bad') throw Object.assign(new Error('no such tree'), { code: 'NOT_FOUND' });
        return [
          { mode: '040000', name: 'src', hash: 'a'.repeat(40), type: 'tree' },
          { mode: '100755', name: 'run.sh', hash: 'b'.repeat(40), type: 'blob' },
        ];
      }) as unknown as ArtifactsRepo['readTree'],
    });
    expect(await s.readTree('t'.repeat(40))).toEqual([
      { mode: '40000', name: 'src', hash: 'a'.repeat(40) },
      { mode: '100755', name: 'run.sh', hash: 'b'.repeat(40) },
    ]);
    expect(await s.readTree('bad')).toBeNull();
    expect(await s.readTree('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toEqual([]);
  });

  it('refuses blobs over the byte budget by size, and on MEMORY_LIMIT', async () => {
    const s = sources(
      {
        readBlob: (async (hash: string) => {
          if (hash === 'huge') throw Object.assign(new Error('too big'), { code: 'MEMORY_LIMIT' });
          if (hash === 'gone') return null;
          return new Blob([hash === 'big' ? 'x'.repeat(9) : 'small']);
        }) as unknown as ArtifactsRepo['readBlob'],
      },
      8,
    );
    expect(decode((await s.readBlob('ok'))!)).toBe('small');
    expect(await s.readBlob('gone')).toBeNull();
    await expect(s.readBlob('big')).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(s.readBlob('huge')).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  it('prepares a three-way merge over the Artifacts binding with bounded reads', async () => {
    const name = `merge-owner--fake-${crypto.randomUUID().slice(0, 8)}`;
    const fake = new FakeRepo();
    fakeRepos.set(name, fake);
    const files = { 'README.md': 'hello\n', 'src/a.txt': 'a1\na2\na3\na4\na5\n', 'docs/x.md': 'x\n' };
    const base = await fakeCommit(fake, files);
    const head = await fakeCommit(fake, { ...files, 'src/a.txt': 'a1\nA2\na3\na4\na5\n' }, [base.sha]);
    const main = await fakeCommit(fake, { ...files, 'README.md': 'bye\n', 'src/a.txt': 'a1\na2\na3\na4\nA5\n' }, [base.sha]);
    const env = { ...baseEnv, ARTIFACTS: fakeArtifacts } as Env;
    const repo = { id: crypto.randomUUID(), artifacts_name: name } as RepoRow;

    const prepared = await withLazyRepo(env, name, (artifacts) =>
      prepareMerge(artifactsMergeSources({ env, repo, artifacts, bypass: true, waitUntil: () => {} }), {
        targetSha: main.sha,
        headSha: head.sha,
        message: 'm',
      }),
    );
    const expectedTree = await fakeWriteTree(new FakeRepo(), { ...files, 'README.md': 'bye\n', 'src/a.txt': 'a1\nA2\na3\na4\nA5\n' });
    expect(prepared).toMatchObject({ ok: true, value: { kind: 'merge', treeSha: expectedTree, mergeBase: base.sha } });
    // 3 commits; the 3 roots and 3 src/ trees, each read once (docs/ is never opened); 3 blobs for the one content merge.
    expect(fake.count('readCommit')).toBe(3);
    expect(fake.count('readTree')).toBe(6);
    expect(fake.count('readBlob')).toBe(3);
    expect(prepared.ok && prepared.value.work).toMatchObject({ commitReads: 3, blobReads: 3 });
    fakeRepos.delete(name);
  });
});

describe('prepareMerge + publishMerge', () => {
  const target = { repo: REPO, ref: 'refs/heads/main' };

  it('fast-forward moves the ref to the head with no objects; mergeCommit is the head sha', async () => {
    const store = new Store();
    const base = await store.commit([], { 'README.md': 'v1\n' });
    const head = await store.commit([base], { 'README.md': 'v2\n' });
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', base);
    const hooked: unknown[] = [];
    const hook: MergeAttributionHook = async (m) => void hooked.push(m);

    const prepared = await prepareMerge(store, { targetSha: base, headSha: head, message: 'Merge change 1' });
    expect(prepared).toMatchObject({ ok: true, value: { kind: 'fast-forward', mergeCommit: head, targetSha: base, headSha: head, objects: [] } });
    if (!prepared.ok) return;
    const r = await publishMerge({ pusher, gate: checksGate([]), attribution: hook }, target, prepared.value);
    expect(r).toEqual({ ok: true, value: { kind: 'fast-forward', ref: 'refs/heads/main', mergeCommit: head, treeSha: prepared.value.treeSha, previous: base } });
    expect(pusher.calls).toEqual([{ command: { ref: 'refs/heads/main', oldOid: base, newOid: head }, objects: [] }]);
    expect(pusher.refs.get('refs/heads/main')).toBe(head);
    expect(hooked).toEqual([{ repo: REPO, ref: 'refs/heads/main', kind: 'fast-forward', mergeCommit: head, targetSha: base, headSha: head }]);
  });

  it('three-way merge publishes a two-parent commit by the Kvarm committer with the objects it needs', async () => {
    const store = new Store();
    const { head, main, mergedTree } = await divergent(store);
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const author = { name: 'Alice', email: 'alice@example.test' };

    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'Merge change 2: feature', author, now: 1_790_100_000 });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value).toMatchObject({ kind: 'merge', treeSha: mergedTree, targetSha: main, headSha: head });
    const commitObj = prepared.value.objects.find((o) => o.hash === prepared.value.mergeCommit)!;
    const text = decode(commitObj.raw.subarray(commitObj.raw.indexOf(0) + 1));
    expect(text).toBe(
      `tree ${mergedTree}\nparent ${main}\nparent ${head}\n` +
        `author Alice <alice@example.test> 1790100000 +0000\n` +
        `committer ${KVARM_COMMITTER.name} <${KVARM_COMMITTER.email}> 1790100000 +0000\n\nMerge change 2: feature\n`,
    );

    const r = await publishMerge({ pusher, gate: checksGate([]) }, target, prepared.value);
    expect(r).toMatchObject({ ok: true, value: { kind: 'merge', mergeCommit: prepared.value.mergeCommit, treeSha: mergedTree, previous: main } });
    expect(pusher.calls).toHaveLength(1);
    expect(pusher.calls[0]!.command).toEqual({ ref: 'refs/heads/main', oldOid: main, newOid: prepared.value.mergeCommit });
    // The pushed objects (merge commit, merged blob, rebuilt trees) plus what the remote had close the graph.
    expect(await store.readCommit(prepared.value.mergeCommit)).toEqual({ treeHash: mergedTree, parents: [main, head] });
    const root = (await store.readTree(mergedTree))!;
    const src = (await store.readTree(root.find((e) => e.name === 'src')!.hash))!;
    expect(decode((await store.readBlob(src.find((e) => e.name === 'a.txt')!.hash))!)).toBe('a1\nA2\na3\n');
  });

  it('conflicts and up-to-date heads are refused at prepare time with a code', async () => {
    const store = new Store();
    const base = await store.commit([], { 'a.txt': 'one\n' });
    const head = await store.commit([base], { 'a.txt': 'two\n' });
    const main = await store.commit([base], { 'a.txt': 'three\n' });
    const conflict = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    expect(conflict).toMatchObject({ ok: false, status: 409, code: 'MERGE_CONFLICT', conflicts: [{ path: 'a.txt', kind: 'content' }] });
    expect(await prepareMerge(store, { targetSha: main, headSha: base, message: 'm' })).toMatchObject({ ok: false, status: 409, code: 'UP_TO_DATE' });
    expect(await prepareMerge(store, { targetSha: main, headSha: 'e'.repeat(40), message: 'm' })).toMatchObject({ ok: false, status: 503, code: 'MERGE_READ_FAILED' });
    expect(await prepareMerge(store, { targetSha: main, headSha: head, message: 'm', budgets: { maxCommitReads: 1 } })).toMatchObject({
      ok: false,
      status: 422,
      code: 'MERGE_TOO_LARGE',
    });
  });

  it('many individually permitted merged blobs over the aggregate budget are MERGE_TOO_LARGE, with nothing to publish', async () => {
    const store = new Store();
    const files = (edit: (lines: string[]) => string[]) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < 20; i++) {
        const lines = Array.from({ length: 2048 }, (_, k) => `file ${i} line ${String(k).padStart(6, '0')}`);
        out[`big/f${i}.txt`] = `${edit(lines).join('\n')}\n`;
      }
      return out;
    };
    const base = await store.commit([], files((l) => l));
    const head = await store.commit([base], files((l) => ['HEAD', ...l.slice(1)]), 'feature');
    const main = await store.commit([base], files((l) => [...l.slice(0, -1), 'MAIN']), 'main moves');

    expect(await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' })).toMatchObject({ ok: true, value: { kind: 'merge' } });
    const r = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm', budgets: { maxMergedBytes: 256 * 1024 } });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'MERGE_TOO_LARGE', error: 'merge exceeds the maxMergedBytes budget' });
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head, budgets: { maxMergedBytes: 256 * 1024 } });
    expect(m).toMatchObject({ status: 'unknown', unknownReason: 'maxMergedBytes', mergeable: false, treeSha: null });
  });

  it('failing or pending required checks on the prepared tree block publication; nothing is pushed', async () => {
    const store = new Store();
    const { head, main } = await divergent(store);
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    if (!prepared.ok) throw new Error('prepare failed');
    const seen: unknown[] = [];
    const failing = await publishMerge({ pusher, gate: checksGate([producer([{ name: 'ci', state: 'failure' }], seen)]) }, { ...target, configId: 'cfg-9' }, prepared.value);
    expect(failing).toMatchObject({ ok: false, status: 409, code: 'REQUIRED_CHECKS_FAILED', checks: { state: 'failure' } });
    expect(seen).toEqual([{ repo: REPO.id, treeSha: prepared.value.treeSha, configId: 'cfg-9' }]);
    const pending = await publishMerge({ pusher, gate: checksGate([producer([{ name: 'ci', state: 'pending' }])]) }, target, prepared.value);
    expect(pending).toMatchObject({ ok: false, status: 409, code: 'REQUIRED_CHECKS_PENDING' });
    expect(pusher.calls).toEqual([]);
    expect(pusher.refs.get('refs/heads/main')).toBe(main);
  });

  it('a target that moved since prepare is a stale outcome (re-plan), and the hook does not run', async () => {
    const store = new Store();
    const { head, main } = await divergent(store);
    const pusher = new FakePusher(store);
    const moved = await store.commit([main], { 'README.md': 'moved\n', 'src/a.txt': 'a1\na2\na3\n' });
    pusher.refs.set('refs/heads/main', moved);
    const hooked: unknown[] = [];
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    if (!prepared.ok) throw new Error('prepare failed');
    const r = await publishMerge({ pusher, gate: checksGate([]), attribution: async (m) => void hooked.push(m) }, target, prepared.value);
    expect(r).toMatchObject({ ok: false, status: 409, code: 'STALE_TARGET' });
    expect(pusher.refs.get('refs/heads/main')).toBe(moved);
    expect(hooked).toEqual([]);
  });

  it('report-status ng on HTTP 200 through the real GitPusher is a failure, not a merge', async () => {
    const store = new Store();
    const { head, main } = await divergent(store);
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    if (!prepared.ok) throw new Error('prepare failed');
    const repo = { id: crypto.randomUUID(), artifacts_name: 'merge-owner--ng', artifacts_remote: 'https://artifacts.invalid/git/default/merge-owner--ng.git' };
    await writeCachedJson(internalKey('gittoken', repo.artifacts_name, 'write'), { token: 'w', expiresAt: Date.now() + 86_400_000 }, 86_400);
    const fetch: FetchLike = async () =>
      new Response(concat(pktLine('unpack ok\n'), pktLine('ng refs/heads/main pre-receive hook declined\n'), encode('0000')), { status: 200 });
    const pusher = artifactsPusher(baseEnv, repo as Pick<RepoRow, 'id' | 'artifacts_name' | 'artifacts_remote'>, { fetch });
    const r = await publishMerge({ pusher, gate: checksGate([]) }, target, prepared.value);
    expect(r).toMatchObject({ ok: false, status: 502, code: 'PUBLISH_REJECTED', error: expect.stringContaining('pre-receive hook declined') });
  });

  it('an attribution hook failure does not undo or fail a published merge', async () => {
    const store = new Store();
    const { head, main } = await divergent(store);
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    if (!prepared.ok) throw new Error('prepare failed');
    const r = await publishMerge(
      {
        pusher,
        gate: checksGate([]),
        attribution: async () => {
          throw new Error('notes unavailable');
        },
      },
      target,
      prepared.value,
    );
    expect(r.ok).toBe(true);
    expect(pusher.refs.get('refs/heads/main')).toBe(prepared.value.mergeCommit);
  });
});

describe('publishMerge before-send revalidation', () => {
  const target = { repo: REPO, ref: 'refs/heads/main' };

  async function preparedDivergent() {
    const store = new Store();
    const { head, main } = await divergent(store);
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'm' });
    if (!prepared.ok) throw new Error('prepare failed');
    return { store, main, prepared: prepared.value };
  }

  it('runs after the checks-gate answer and the prepared update, immediately before the send', async () => {
    const { store, main, prepared } = await preparedDivergent();
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const gate = checksGate([
      {
        name: 'order',
        async requiredChecksFor() {
          pusher.events.push('gate');
          return [];
        },
      },
    ]);
    const r = await publishMerge({ pusher, gate, beforeSend: async () => (pusher.events.push('beforeSend'), true) }, target, prepared);
    expect(r.ok).toBe(true);
    expect(pusher.events).toEqual(['gate', 'prepare', 'beforeSend', 'send']);
    expect(pusher.refs.get('refs/heads/main')).toBe(prepared.mergeCommit);
  });

  it('a refusal sends nothing: the ref stays and attribution does not run', async () => {
    const { store, main, prepared } = await preparedDivergent();
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const hooked: unknown[] = [];
    const r = await publishMerge(
      { pusher, gate: checksGate([]), attribution: async (m) => void hooked.push(m), beforeSend: async () => false },
      target,
      prepared,
    );
    expect(r).toMatchObject({ ok: false, status: 409, code: 'PUBLISH_CANCELLED' });
    expect(pusher.events).toEqual(['prepare']);
    expect(pusher.calls).toEqual([]);
    expect(pusher.refs.get('refs/heads/main')).toBe(main);
    expect(hooked).toEqual([]);
  });

  it('through the real GitPusher, a refusal after the token and pack are ready sends no receive-pack request', async () => {
    const { prepared } = await preparedDivergent();
    const repo = { id: crypto.randomUUID(), artifacts_name: 'merge-owner--cancel', artifacts_remote: 'https://artifacts.invalid/git/default/merge-owner--cancel.git' };
    const fakeRepo = new FakeRepo();
    fakeRepos.set(repo.artifacts_name, fakeRepo);
    const env = { ...baseEnv, ARTIFACTS: fakeArtifacts } as Env;
    const requests: string[] = [];
    const fetch: FetchLike = async (url) => {
      requests.push(String(url));
      return new Response(concat(pktLine('unpack ok\n'), pktLine('ok refs/heads/main\n'), encode('0000')), { status: 200 });
    };
    const pusher = artifactsPusher(env, repo as Pick<RepoRow, 'id' | 'artifacts_name' | 'artifacts_remote'>, { fetch });
    let tokenMinted = false;
    fakeRepo.hook = async (c) => {
      if (c === 'createToken:write') tokenMinted = true;
    };

    const refused = await publishMerge({ pusher, gate: checksGate([]), beforeSend: async () => (expect(tokenMinted).toBe(true), false) }, target, prepared);
    expect(refused).toMatchObject({ ok: false, status: 409, code: 'PUBLISH_CANCELLED' });
    expect(requests).toEqual([]);

    const sent = await publishMerge({ pusher, gate: checksGate([]), beforeSend: async () => true }, target, prepared);
    expect(sent.ok).toBe(true);
    expect(requests).toEqual([`${repo.artifacts_remote}/git-receive-pack`]);
  });
});

describe('criss-cross histories', () => {
  const lines = (tag: string) => Array.from({ length: 10 }, (_, i) => `${tag}${i}`);
  const text = (ls: string[]) => ls.join('\n') + '\n';
  const set = (ls: string[], at: number, v: string) => ls.map((l, i) => (i === at ? v : l));
  const A = lines('a');
  const B = lines('b');

  /**
   * root; x edits a.txt, y edits b.txt (`disjoint`), the same line of a.txt
   * (`clash`) or another line of a.txt (`same-file`); m1 = merge(x, y),
   * m2 = merge(y, x); main and head grow from them.
   */
  async function crissCross(store: Store, shape: 'disjoint' | 'clash' | 'same-file') {
    const root = await store.commit([], { 'a.txt': text(A), 'b.txt': text(B) });
    const xa = set(A, 1, 'X');
    const ya = shape === 'disjoint' ? A : set(A, shape === 'clash' ? 1 : 8, 'Y');
    const yb = shape === 'disjoint' ? set(B, 8, 'Y') : B;
    const x = await store.commit([root], { 'a.txt': text(xa), 'b.txt': text(B) }, 'x');
    const y = await store.commit([root], { 'a.txt': text(ya), 'b.txt': text(yb) }, 'y');
    const ma = shape === 'clash' ? set(A, 1, 'XY') : shape === 'same-file' ? set(set(A, 1, 'X'), 8, 'Y') : xa;
    const m1 = await store.commit([x, y], { 'a.txt': text(ma), 'b.txt': text(yb) }, 'm1');
    const m2 = await store.commit([y, x], { 'a.txt': text(ma), 'b.txt': text(yb) }, 'm2');
    const main = await store.commit([m1], { 'a.txt': text(set(ma, 4, 'MAIN')), 'b.txt': text(yb) }, 'main');
    const head = await store.commit([m2], { 'a.txt': text(ma), 'b.txt': text(set(yb, 2, 'HEAD')) }, 'head');
    return { x, y, m2, ma, yb, main, head, merged: { 'a.txt': text(set(ma, 4, 'MAIN')), 'b.txt': text(set(yb, 2, 'HEAD')) } };
  }

  it('refuses bases that need a line-level merge as MULTIPLE_MERGE_BASES', async () => {
    const store = new Store();
    const { main, head } = await crissCross(store, 'same-file');
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({ status: 'unknown', unknownReason: 'criss-cross', mergeable: false });
    expect(await prepareMerge(store, { targetSha: main, headSha: head, message: 'merge' })).toMatchObject({ ok: false, code: 'MULTIPLE_MERGE_BASES' });
  });

  it('refuses an outer merge where git could see a similarity rename as MULTIPLE_MERGE_BASES', async () => {
    const store = new Store();
    const { m2, ma, yb, main } = await crissCross(store, 'disjoint');
    // The head renames b.txt with an edit: git pairs it as a rename, the exact model as delete + add.
    const head = await store.commit([m2], { 'a.txt': text(ma), 'moved.txt': text(set(yb, 2, 'HEAD')) }, 'head');
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({ status: 'unknown', unknownReason: 'criss-cross', mergeable: false });
    expect(await prepareMerge(store, { targetSha: main, headSha: head, message: 'merge' })).toMatchObject({ ok: false, code: 'MULTIPLE_MERGE_BASES' });
  });

  it('merges over the virtual base when the two bases merge cleanly', async () => {
    const store = new Store();
    const { x, y, main, head, merged } = await crissCross(store, 'disjoint');
    const [first, second] = [x, y].sort();
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({
      status: 'clean',
      mergeable: true,
      mergeBase: first,
      treeSha: await new Store().tree(merged),
      virtualBase: { bases: [first, second] },
    });
    // The same pair always plans the same way.
    const again = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(again.treeSha).toBe(m.treeSha);
    expect(again.virtualBase).toEqual(m.virtualBase);
  });

  it('publishes a merge commit whose tree is closed over the store and the pack', async () => {
    const store = new Store();
    const { main, head } = await crissCross(store, 'disjoint');
    const prepared = await prepareMerge(store, { targetSha: main, headSha: head, message: 'merge' });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const pack = new Map(prepared.value.objects.map((o) => [o.hash, o]));
    const read = async (hash: string) => pack.get(hash) ?? null;
    const walk = async (tree: string): Promise<boolean> => {
      const own = await read(tree);
      const entries = own ? parseTree(own.raw.subarray(own.raw.indexOf(0) + 1)) : await store.readTree(tree);
      if (!entries) return false;
      for (const e of entries) {
        if (e.mode === '40000' ? !(await walk(e.hash)) : !(await read(e.hash)) && !(await store.readBlob(e.hash))) return false;
      }
      return true;
    };
    expect(await walk(prepared.value.treeSha)).toBe(true);
    const pusher = new FakePusher(store);
    pusher.refs.set('refs/heads/main', main);
    const published = await publishMerge({ pusher, gate: checksGate([]) }, { repo: REPO, ref: 'refs/heads/main' }, prepared.value);
    expect(published).toMatchObject({ ok: true, value: { kind: 'merge' } });
  });

  it('refuses bases that conflict with each other as MULTIPLE_MERGE_BASES', async () => {
    const store = new Store();
    const { main, head } = await crissCross(store, 'clash');
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head });
    expect(m).toMatchObject({ status: 'unknown', unknownReason: 'criss-cross', mergeable: false });
    expect(m.virtualBase).toBeUndefined();
    const p = await prepareMerge(store, { targetSha: main, headSha: head, message: 'merge' });
    expect(p).toMatchObject({ ok: false, status: 422, code: 'MULTIPLE_MERGE_BASES' });
  });

  it('charges the virtual base against the merge budgets', async () => {
    const store = new Store();
    const { main, head } = await crissCross(store, 'disjoint');
    const m = await computeMergeability(store, checksGate([]), { repo: REPO, targetSha: main, headSha: head, budgets: { maxTreeReads: 2 } });
    expect(m).toMatchObject({ status: 'unknown', unknownReason: 'maxTreeReads', mergeable: false });
    expect(m.work.treeReads).toBeLessThanOrEqual(2);
  });
});
