/**
 * Budgeted merge-base: on random commit DAGs (linear runs, merges, criss-cross
 * merges, unrelated roots) the bases match `git merge-base --all` exactly.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCommit, buildTree, isAncestor, mergeBase, writePack, type CommitReader, type GitObject } from '../src/index';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-mergebase-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], input?: Uint8Array): { status: number; out: string } {
  const r = spawnSync('git', args, { input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return { status: r.status, out: r.stdout.toString() };
}

/** Deterministic PRNG so failures are reproducible from the seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

interface Graph {
  commits: GitObject[];
  parents: Map<string, string[]>;
}

/** Builds commits in order; `parentsOf(i)` picks indexes of earlier commits. */
async function buildGraph(n: number, parentsOf: (i: number) => number[]): Promise<Graph> {
  const tree = await buildTree([]);
  const commits: GitObject[] = [];
  const parents = new Map<string, string[]>();
  for (let i = 0; i < n; i++) {
    const ps = [...new Set(parentsOf(i))].map((p) => commits[p]!.hash);
    const ident = { name: 'Kvarm', email: 'kvarm@kvarm.invalid', time: 1_790_000_000 + i };
    const c = await buildCommit({ tree: tree.hash, parents: ps, author: ident, committer: ident, message: `c${i}` });
    commits.push(c);
    parents.set(c.hash, ps);
  }
  return { commits, parents };
}

function reader(g: Graph, log?: string[]): CommitReader {
  return {
    async readCommit(sha) {
      log?.push(sha);
      const ps = g.parents.get(sha);
      return ps ? { parents: ps, treeHash: '4b825dc642cb6eb5a060e54bf8d69288fbee4904' } : null;
    },
  };
}

async function gitRepo(g: Graph, name: string): Promise<string> {
  const bare = join(dir, `${name}.git`);
  git(['init', '-q', '--bare', bare]);
  const tree = await buildTree([]);
  git(['-C', bare, 'unpack-objects', '-q'], await writePack([tree, ...g.commits]));
  return bare;
}

function gitBases(bare: string, a: string, b: string): string[] {
  const r = git(['-C', bare, 'merge-base', '--all', a, b]);
  return r.out.split('\n').filter(Boolean).sort();
}

describe('mergeBase', () => {
  it('matches git merge-base --all on random DAGs with merges and criss-crosses', async () => {
    const shapes = { none: 0, one: 0, several: 0 };
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rand = rng(seed);
      const n = 40;
      const g = await buildGraph(n, (i) => {
        if (i === 0) return [];
        // A few extra roots make unrelated histories possible.
        if (rand() < 0.05) return [];
        const p1 = Math.max(0, i - 1 - Math.floor(rand() * 4));
        return rand() < 0.35 ? [p1, Math.floor(rand() * i)] : [p1];
      });
      const bare = await gitRepo(g, `random-${seed}`);
      for (let k = 0; k < 25; k++) {
        const a = g.commits[Math.floor(rand() * n)]!.hash;
        const b = g.commits[Math.floor(rand() * n)]!.hash;
        const r = await mergeBase(reader(g), a, b);
        expect(r.truncated, `seed ${seed}`).toBe(false);
        expect([...r.bases].sort(), `seed ${seed} ${a}..${b}`).toEqual(gitBases(bare, a, b));
        shapes[r.bases.length === 0 ? 'none' : r.bases.length === 1 ? 'one' : 'several']++;
      }
    }
    // The corpus must actually cover unrelated tips and multiple best bases.
    expect(shapes.none).toBeGreaterThan(0);
    expect(shapes.several).toBeGreaterThan(0);
  });

  it('finds both bases of a criss-cross merge', async () => {
    // 0 <- 1, 0 <- 2, 3 = merge(1,2), 4 = merge(2,1), 5 <- 3, 6 <- 4
    const shape = [[], [0], [0], [1, 2], [2, 1], [3], [4]];
    const g = await buildGraph(shape.length, (i) => shape[i]!);
    const bare = await gitRepo(g, 'criss');
    const r = await mergeBase(reader(g), g.commits[5]!.hash, g.commits[6]!.hash);
    expect([...r.bases].sort()).toEqual(gitBases(bare, g.commits[5]!.hash, g.commits[6]!.hash));
    expect(r.bases).toHaveLength(2);
  });

  it('returns the commit itself for identical tips and the ancestor for a fast-forward', async () => {
    const g = await buildGraph(5, (i) => (i === 0 ? [] : [i - 1]));
    const [c0, , c2, , c4] = g.commits.map((c) => c.hash);
    expect((await mergeBase(reader(g), c4!, c4!)).bases).toEqual([c4]);
    expect((await mergeBase(reader(g), c2!, c4!)).bases).toEqual([c2]);
    expect((await mergeBase(reader(g), c4!, c0!)).bases).toEqual([c0]);
    expect(await isAncestor(reader(g), c2!, c4!)).toEqual({ ancestor: true, truncated: false });
    expect(await isAncestor(reader(g), c4!, c2!)).toEqual({ ancestor: false, truncated: false });
  });

  it('returns no base for unrelated histories', async () => {
    const g = await buildGraph(4, (i) => (i === 0 || i === 2 ? [] : [i - 1]));
    const r = await mergeBase(reader(g), g.commits[1]!.hash, g.commits[3]!.hash);
    expect(r).toMatchObject({ bases: [], truncated: false });
  });

  it('stops at the merge base instead of walking the whole history', async () => {
    const g = await buildGraph(500, (i) => (i === 0 ? [] : i === 499 ? [497] : [i - 1]));
    const log: string[] = [];
    const r = await mergeBase(reader(g, log), g.commits[498]!.hash, g.commits[499]!.hash);
    expect(r.bases).toEqual([g.commits[497]!.hash]);
    expect(r.commitReads).toBeLessThan(20);
    expect(new Set(log).size).toBe(log.length);
  });

  it('truncates at the commit-read budget instead of walking on', async () => {
    // Two 300-commit branches off one root.
    const g = await buildGraph(601, (i) => (i === 0 ? [] : i <= 300 ? [i - 1] : i === 301 ? [0] : [i - 1]));
    const r = await mergeBase(reader(g), g.commits[300]!.hash, g.commits[600]!.hash, { maxCommitReads: 50 });
    expect(r).toMatchObject({ truncated: true, truncatedReason: 'maxCommitReads' });
    expect(r.commitReads).toBeLessThanOrEqual(50);
    const full = await mergeBase(reader(g), g.commits[300]!.hash, g.commits[600]!.hash);
    expect(full).toMatchObject({ bases: [g.commits[0]!.hash], truncated: false });
    expect(await isAncestor(reader(g), g.commits[0]!.hash, g.commits[600]!.hash, { maxCommitReads: 10 })).toEqual({
      ancestor: false,
      truncated: true,
    });
  });

  it('reports a missing commit or a failing reader as truncated, not as unrelated', async () => {
    const g = await buildGraph(3, (i) => (i === 0 ? [] : [i - 1]));
    const missing = await mergeBase(reader(g), g.commits[2]!.hash, 'f'.repeat(40));
    expect(missing).toMatchObject({ truncated: true, truncatedReason: 'missingCommit' });
    const failing: CommitReader = {
      async readCommit() {
        throw new Error('upstream 503');
      },
    };
    const failed = await mergeBase(failing, g.commits[2]!.hash, g.commits[1]!.hash);
    expect(failed).toMatchObject({ truncated: true, truncatedReason: 'readError', readError: 'Error: upstream 503' });
  });
});
