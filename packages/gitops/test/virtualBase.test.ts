/**
 * Virtual merge bases (architecture §3.1) over an in-memory store: the
 * result shape of merge3's virtual-ancestor mode, the budgets on bases,
 * depth and reads, and the conflicts that refuse rather than guess. Parity
 * with git is the criss-cross corpus suite (crisscross.corpus.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { buildBlob, buildCommit, buildTree, decode, parseTree, type GitObject, type TreeEntry } from '../src/index';
import { merge3, type MergeReader } from '../src/merge3';
import { mergeBase, type CommitInfo, type CommitReader } from '../src/mergebase';
import { virtualMergeBase } from '../src/virtualBase';

const enc = (s: string) => new TextEncoder().encode(s);
const body = (o: GitObject) => o.raw.subarray(o.raw.indexOf(0) + 1);

class Store implements CommitReader, MergeReader {
  readonly objects = new Map<string, GitObject>();
  private readonly commits = new Map<string, CommitInfo>();
  private tick = 0;

  async tree(files: Record<string, string>): Promise<string> {
    const top = new Map<string, TreeEntry>();
    const dirs = new Map<string, Record<string, string>>();
    for (const [path, content] of Object.entries(files)) {
      const slash = path.indexOf('/');
      if (slash === -1) {
        const blob = await buildBlob(enc(content));
        this.objects.set(blob.hash, blob);
        top.set(path, { mode: '100644', name: path, hash: blob.hash });
      } else {
        const d = path.slice(0, slash);
        dirs.set(d, { ...dirs.get(d), [path.slice(slash + 1)]: content });
      }
    }
    for (const [d, sub] of dirs) top.set(d, { mode: '40000', name: d, hash: await this.tree(sub) });
    const t = await buildTree([...top.values()]);
    this.objects.set(t.hash, t);
    return t.hash;
  }

  async commit(parents: string[], files: Record<string, string>, committedAt?: number): Promise<string> {
    const treeHash = await this.tree(files);
    const time = committedAt ?? 1_790_000_000 + this.tick;
    this.tick = Math.max(this.tick + 1, time - 1_790_000_000 + 1);
    const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time };
    const c = await buildCommit({ tree: treeHash, parents, author: ident, committer: ident, message: `c${this.tick}` });
    const parsedCommittedAt = Number(/^committer .* (\d+) [+-]\d{4}$/m.exec(decode(body(c)))?.[1] ?? 0);
    this.commits.set(c.hash, { parents, treeHash, committedAt: parsedCommittedAt });
    return c.hash;
  }

  async readCommit(sha: string): Promise<CommitInfo | null> {
    return this.commits.get(sha) ?? null;
  }

  async readTree(hash: string): Promise<TreeEntry[] | null> {
    const o = this.objects.get(hash);
    return o?.type === 'tree' ? parseTree(o.raw) : null;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    const o = this.objects.get(hash);
    return o?.type === 'blob' ? body(o) : null;
  }
}

/** Reads `path` from `tree`, looking in `created` before the store. */
async function fileAt(store: Store, created: readonly GitObject[], tree: string, path: string): Promise<string | null> {
  const own = new Map(created.map((o) => [o.hash, o]));
  let hash = tree;
  for (const part of path.split('/')) {
    const o = own.get(hash) ?? store.objects.get(hash);
    const e = o ? parseTree(body(o)).find((x) => x.name === part) : undefined;
    if (!e) return null;
    hash = e.hash;
  }
  const blob = own.get(hash) ?? store.objects.get(hash);
  return blob ? decode(body(blob)) : null;
}

const ten = (changes: Record<number, string> = {}) =>
  Array.from({ length: 10 }, (_, i) => `${changes[i + 1] ?? `line ${i + 1}`}\n`).join('');

/** O <- B1, O <- B2, M1 = [B1, B2], M2 = [B2, B1]; the bases of M1 and M2 are B1 and B2. */
async function crissCross(store: Store, b1: Record<string, string>, b2: Record<string, string>, base: Record<string, string>) {
  const o = await store.commit([], base);
  const B1 = await store.commit([o], b1);
  const B2 = await store.commit([o], b2);
  return { o, B1, B2 };
}

describe('merge3 virtual-ancestor mode', () => {
  it('writes a tree with git-style markers (labels, 7 + 2 * depth wide) and keeps the base of a modify/delete', async () => {
    const store = new Store();
    const base = await store.tree({ 'f.txt': ten(), 'gone.txt': 'g\n' });
    const ours = await store.tree({ 'f.txt': ten({ 5: 'ours' }), 'gone.txt': 'g edited\n' });
    const theirs = await store.tree({ 'f.txt': ten({ 5: 'theirs' }) });

    const plain = await merge3(store, base, ours, theirs);
    expect(plain).toMatchObject({ clean: false, treeHash: null, objects: [] });

    const v = await merge3(store, base, ours, theirs, { virtualDepth: 1 });
    expect(v.clean).toBe(false);
    expect(v.conflicts.map((c) => `${c.kind}:${c.path}`)).toEqual(['content:f.txt', 'modify-delete:gone.txt']);
    expect(v.treeHash).not.toBeNull();
    expect(await fileAt(store, v.objects, v.treeHash!, 'f.txt')).toBe(
      ten({ 5: '<<<<<<<<< Temporary merge branch 1\nours\n=========\ntheirs\n>>>>>>>>> Temporary merge branch 2' }),
    );
    expect(await fileAt(store, v.objects, v.treeHash!, 'gone.txt')).toBe('g\n');

    const deeper = await merge3(store, base, ours, theirs, { virtualDepth: 2 });
    expect(await fileAt(store, deeper.objects, deeper.treeHash!, 'f.txt')).toContain('<<<<<<<<<<< Temporary merge branch 1\n');
  });

  it('content-merges two different added files against an empty base', async () => {
    const store = new Store();
    const base = await store.tree({ 'r.txt': 'r\n' });
    const ours = await store.tree({ 'r.txt': 'r\n', 'n.txt': 'one\nours\n' });
    const theirs = await store.tree({ 'r.txt': 'r\n', 'n.txt': 'one\ntheirs\n' });
    const v = await merge3(store, base, ours, theirs, { virtualDepth: 1 });
    expect(v.conflicts.map((c) => `${c.kind}:${c.path}`)).toEqual(['add-add:n.txt']);
    expect(await fileAt(store, v.objects, v.treeHash!, 'n.txt')).toBe(
      'one\n<<<<<<<<< Temporary merge branch 1\nours\n=========\ntheirs\n>>>>>>>>> Temporary merge branch 2\n',
    );
  });

  it('refuses a rename conflict it cannot write the way git does (virtualConflict)', async () => {
    const store = new Store();
    const base = await store.tree({ 'a.txt': ten() });
    const ours = await store.tree({ 'x/a.txt': ten() });
    const theirs = await store.tree({ 'y/a.txt': ten() });
    expect((await merge3(store, base, ours, theirs)).conflicts.map((c) => c.kind)).toEqual(['rename']);
    expect(await merge3(store, base, ours, theirs, { virtualDepth: 1 })).toMatchObject({
      truncated: true,
      truncatedReason: 'virtualConflict',
      truncatedDetail: 'a.txt',
      treeHash: null,
    });
  });
});

describe('virtualMergeBase', () => {
  it('one base is its own tree and no base is the empty tree, with no merge run', async () => {
    const store = new Store();
    const c = await store.commit([], { 'a.txt': 'a\n' });
    expect(await virtualMergeBase(store, [c])).toMatchObject({ treeHash: (await store.readCommit(c))!.treeHash, merges: 0, objects: [] });
    expect(await virtualMergeBase(store, [])).toMatchObject({ treeHash: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', merges: 0 });
  });

  it('merges two criss-cross bases; an inner conflict keeps markers that cancel in the outer merge', async () => {
    const store = new Store();
    const { B1, B2 } = await crissCross(store, { 'f.txt': ten({ 5: 'B1' }) }, { 'f.txt': ten({ 5: 'B2' }) }, { 'f.txt': ten() });
    const M1 = await store.commit([B1, B2], { 'f.txt': ten({ 1: 'M1', 5: 'fixed' }) });
    const M2 = await store.commit([B2, B1], { 'f.txt': ten({ 5: 'fixed', 10: 'M2' }) });
    const mb = await mergeBase(store, M1, M2);
    expect([...mb.bases].sort()).toEqual([B1, B2].sort());

    const v = await virtualMergeBase(store, mb.bases);
    expect(v).toMatchObject({ truncated: false, merges: 1, conflicts: 1 });
    expect(await fileAt(store, v.objects, v.treeHash!, 'f.txt')).toContain('<<<<<<<<< Temporary merge branch 1\n');

    const reader: MergeReader = {
      readTree: async (h) => {
        const o = v.objects.find((x) => x.hash === h);
        return o ? parseTree(body(o)) : store.readTree(h);
      },
      readBlob: async (h) => {
        const o = v.objects.find((x) => x.hash === h);
        return o ? body(o) : store.readBlob(h);
      },
    };
    const [t1, t2] = [(await store.readCommit(M1))!.treeHash, (await store.readCommit(M2))!.treeHash];
    const outer = await merge3(reader, v.treeHash!, t1, t2);
    expect(outer.clean).toBe(true);
    expect(await fileAt(store, outer.objects, outer.treeHash!, 'f.txt')).toBe(ten({ 1: 'M1', 5: 'fixed', 10: 'M2' }));
  });

  it('puts the older base first in a conflict marker even when its object id sorts later', async () => {
    const store = new Store();
    const base = await store.commit([], { 'f.txt': ten() });
    const older = await store.commit([base], { 'f.txt': ten({ 5: 'older' }) }, 1_790_000_001);
    const later = await store.commit([base], { 'f.txt': ten({ 5: 'later' }) }, 1_790_000_003);
    expect(older > later).toBe(true);

    const v = await virtualMergeBase(store, [later, older]);
    expect(v.truncated).toBe(false);
    expect(await fileAt(store, v.objects, v.treeHash!, 'f.txt')).toContain(
      '<<<<<<<<< Temporary merge branch 1\nolder\n=========',
    );
  });

  it('enforces the bases and depth budgets with the budget named', async () => {
    const store = new Store();
    const { B1, B2 } = await crissCross(store, { 'f.txt': ten({ 2: 'B1' }) }, { 'f.txt': ten({ 9: 'B2' }) }, { 'f.txt': ten() });
    expect(await virtualMergeBase(store, [B1, B2], { maxMergeBases: 1 })).toMatchObject({
      truncated: true,
      truncatedReason: 'maxMergeBases',
      truncatedDetail: '2',
      treeHash: null,
      merges: 0,
    });
    expect(await virtualMergeBase(store, [B1, B2], { maxVirtualDepth: 0 })).toMatchObject({
      truncated: true,
      truncatedReason: 'maxVirtualDepth',
      treeHash: null,
    });
    expect(await virtualMergeBase(store, [B1, B2], { maxVirtualDepth: 1 })).toMatchObject({ truncated: false, merges: 1, conflicts: 0 });
  });

  it('a nested criss-cross needs depth 2', async () => {
    const store = new Store();
    const { B1: P1, B2: P2 } = await crissCross(store, { 'f.txt': ten({ 2: 'P1' }) }, { 'f.txt': ten({ 2: 'P2' }) }, { 'f.txt': ten() });
    const Q1 = await store.commit([P1, P2], { 'f.txt': ten({ 2: 'Q', 4: 'Q1' }) });
    const Q2 = await store.commit([P2, P1], { 'f.txt': ten({ 2: 'Q', 7: 'Q2' }) });
    expect(await virtualMergeBase(store, [Q1, Q2], { maxVirtualDepth: 1 })).toMatchObject({ truncated: true, truncatedReason: 'maxVirtualDepth', truncatedDetail: '2' });
    const v = await virtualMergeBase(store, [Q1, Q2], { maxVirtualDepth: 2 });
    expect(v).toMatchObject({ truncated: false, merges: 2 });
    expect(await fileAt(store, v.objects, v.treeHash!, 'f.txt')).toBe(ten({ 2: 'Q', 4: 'Q1', 7: 'Q2' }));
  });

  it('spends one read budget across all inner merges and reports read failures', async () => {
    const store = new Store();
    const { B1, B2 } = await crissCross(store, { 'f.txt': ten({ 2: 'B1' }) }, { 'f.txt': ten({ 9: 'B2' }) }, { 'f.txt': ten() });
    expect(await virtualMergeBase(store, [B1, B2], { maxCommitReads: 2 })).toMatchObject({ truncated: true, truncatedReason: 'maxCommitReads' });
    // Distinct commits are charged once: B1, B2 and their base O fit a budget of exactly 3.
    expect(await virtualMergeBase(store, [B1, B2], { maxCommitReads: 3 })).toMatchObject({ truncated: false, commitReads: 3 });
    // The caller's budget decides instead: commits it already paid for are not charged again.
    const paid = new Set([B1, B2]);
    expect(await virtualMergeBase(store, [B1, B2], { maxCommitReads: 1, mayReadCommit: (sha) => paid.has(sha) })).toMatchObject({
      truncated: true,
      truncatedReason: 'maxCommitReads',
    });
    paid.add((await store.readCommit(B1))!.parents[0]!);
    expect(await virtualMergeBase(store, [B1, B2], { maxCommitReads: 1, mayReadCommit: (sha) => paid.has(sha) })).toMatchObject({ truncated: false });
    expect(await virtualMergeBase(store, [B1, B2], { maxTreeReads: 1 })).toMatchObject({ truncated: true, truncatedReason: 'maxTreeReads' });
    // Three root trees (O, B1, B2): the budget counts distinct fetches, not the merge's repeated reads.
    expect(await virtualMergeBase(store, [B1, B2], { maxTreeReads: 3 })).toMatchObject({ truncated: false, treeReads: 3 });
    expect(await virtualMergeBase(store, [B1, B2], { maxBlobReads: 1 })).toMatchObject({ truncated: true, truncatedReason: 'maxBlobReads' });
    expect(await virtualMergeBase(store, [B1, 'f'.repeat(40)])).toMatchObject({ truncated: true, truncatedReason: 'missingCommit', truncatedDetail: 'f'.repeat(40) });
    const failing: CommitReader & MergeReader = {
      readCommit: async (sha) => (sha === B2 ? Promise.reject(new Error('upstream 503')) : store.readCommit(sha)),
      readTree: (h) => store.readTree(h),
      readBlob: (h) => store.readBlob(h),
    };
    expect(await virtualMergeBase(failing, [B1, B2])).toMatchObject({ truncated: true, truncatedReason: 'readError' });
  });

  it('stops with virtualConflict when the bases conflict on a rename', async () => {
    const store = new Store();
    const { B1, B2 } = await crissCross(store, { 'x/a.txt': ten() }, { 'y/a.txt': ten() }, { 'a.txt': ten() });
    expect(await virtualMergeBase(store, [B1, B2])).toMatchObject({ truncated: true, truncatedReason: 'virtualConflict', truncatedDetail: 'a.txt' });
  });
});
