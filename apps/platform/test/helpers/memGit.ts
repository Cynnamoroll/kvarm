/**
 * An in-memory git object store that is also a merge source: commits, trees
 * and blobs built with the gitops builders, so hashes match git's.
 */

import { buildBlob, buildCommit, buildTree, decode, encode, parseTree, type GitObject, type TreeEntry } from '@kvarm/gitops';
import type { MergeSources } from '../../src/services/merge';

export class MemGit implements MergeSources {
  readonly objects = new Map<string, GitObject>();
  commitReads = 0;
  private tick = 0;

  constructor(private readonly epoch = 1_790_000_000) {}

  add(...objs: GitObject[]): void {
    for (const o of objs) this.objects.set(o.hash, o);
  }

  private body(hash: string, type: string): Uint8Array | null {
    const o = this.objects.get(hash);
    return o && o.type === type ? o.raw.subarray(o.raw.indexOf(0) + 1) : null;
  }

  async readCommit(sha: string) {
    this.commitReads++;
    const raw = this.body(sha, 'commit');
    if (!raw) return null;
    const headers = decode(raw).split('\n\n')[0]!.split('\n');
    return {
      treeHash: headers.find((l) => l.startsWith('tree '))!.slice(5),
      parents: headers.filter((l) => l.startsWith('parent ')).map((l) => l.slice(7)),
    };
  }

  async readTree(hash: string): Promise<TreeEntry[] | null> {
    const raw = this.body(hash, 'tree');
    return raw ? parseTree(raw) : null;
  }

  async readBlob(hash: string): Promise<Uint8Array | null> {
    return this.body(hash, 'blob');
  }

  /** Writes a tree for a flat path map (at most one directory level) and returns its hash. */
  async tree(files: Record<string, string>): Promise<string> {
    const top: TreeEntry[] = [];
    const dirs = new Map<string, TreeEntry[]>();
    for (const [path, text] of Object.entries(files)) {
      const blob = await buildBlob(encode(text));
      this.add(blob);
      const [dir, name] = path.includes('/') ? path.split('/') : [null, path];
      if (dir) dirs.set(dir, [...(dirs.get(dir) ?? []), { mode: '100644', name: name!, hash: blob.hash }]);
      else top.push({ mode: '100644', name: name!, hash: blob.hash });
    }
    for (const [dir, entries] of dirs) {
      const t = await buildTree(entries);
      this.add(t);
      top.push({ mode: '40000', name: dir, hash: t.hash });
    }
    const root = await buildTree(top);
    this.add(root);
    return root.hash;
  }

  async commit(parents: string[], files: Record<string, string>, message = 'c'): Promise<string> {
    const ident = { name: 'Dev', email: 'dev@example.test', time: this.epoch + this.tick++ };
    const c = await buildCommit({ tree: await this.tree(files), parents, author: ident, committer: ident, message });
    this.add(c);
    return c.hash;
  }
}
