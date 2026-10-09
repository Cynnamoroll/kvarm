/**
 * Tree-level three-way merge with git's outcomes (`git merge-tree
 * --write-tree`, the merge-ort strategy), over abstract tree and blob
 * readers so it runs on the Artifacts binding, in tests and in Node alike.
 *
 * 1. Each side is diffed against the base as leaves (files, symlinks,
 *    submodules) with exact renames paired by blob hash.
 * 2. Every base path either side touched is resolved: one-sided changes
 *    apply; both-modified files are content-merged (`mergeText`) with git's
 *    mode rule; a rename on one side carries the other side's modification
 *    to the new path. Added paths are placed, colliding adds conflict, and
 *    an add inside a directory the other side renamed away (the majority
 *    target of its exact renames) is a `rename` conflict, like git's
 *    default `merge.directoryRenames=conflict`; with no majority the
 *    directory itself is a `rename` conflict (git's directory rename split).
 * 3. The merged tree is rebuilt from the base along edited paths only;
 *    untouched subtrees keep their hashes. A path that must be both a file
 *    and a directory is a `file-directory` conflict.
 *
 * Renames are exact only: git also pairs files that are at least 50%
 * similar, so a rename-with-edits on one side is reported here as
 * modify/delete where git would merge it (never the reverse direction of a
 * clean merge git would refuse, except rename+delete, which merges to the
 * same tree git writes). Several merge bases (criss-cross) are the caller's
 * concern: pass one base tree.
 *
 * Budgeted: tree reads, blob reads, blob size, diff work and the total size
 * of the objects the merge creates are bounded, and content merges run one
 * at a time by default so source bytes in memory stay bounded too. A spent
 * budget or a missing object returns `truncated` with no tree.
 */

import { buildBlob, buildTree, type GitObject, type TreeEntry } from './index';
import { isBinaryContent3, mergeText } from './mergeText';
import { diffTrees, type TreeChange, type TreeDiffTruncation, type TreeReader } from './treediff';

export { isBinaryContent3, mergeText, type MergeTextOptions, type MergeTextResult } from './mergeText';

/** Anything that can read a blob's bytes by object id. */
export interface BlobReader {
  /** Throws `BlobTooLargeError` to refuse a blob without buffering it. */
  readBlob(hash: string): Promise<Uint8Array | null>;
}

/** A reader's refusal of an oversized blob; the merge truncates with `maxBlobBytes`. */
export class BlobTooLargeError extends Error {
  override readonly name = 'BlobTooLargeError';
}

export interface MergeReader extends TreeReader, BlobReader {}

export type MergeConflictKind = 'content' | 'add-add' | 'modify-delete' | 'rename' | 'typechange' | 'binary' | 'file-directory';

export interface MergeSide {
  path: string;
  mode: string;
  hash: string;
}

export interface MergeConflict {
  /** The path the conflict is about (for renames, the base path; for a directory rename, the added path). */
  path: string;
  kind: MergeConflictKind;
  /** Every path involved, sorted, `path` included (rename source and targets). */
  paths: string[];
  base?: MergeSide;
  ours?: MergeSide;
  theirs?: MergeSide;
  /** Conflicting hunks of a `content` conflict. */
  hunks?: number;
}

/**
 * Decides a conflicting hunk of `path` (records as byte strings, `\n`
 * included): a side's lines, or null to keep the conflict. See resolve.ts.
 */
export type HunkResolver = (path: string, ours: readonly string[], theirs: readonly string[]) => 'ours' | 'theirs' | null;

export type ResolutionRule = 'non-overlapping' | 'identical-change' | 'whitespace-only' | 'add-add-identical';

/** A path both sides changed that merged without a conflict, and the rule that merged it. */
export interface MergeResolution {
  path: string;
  rule: ResolutionRule;
  /** Hunks decided by the resolver (`whitespace-only`). */
  hunks?: number;
}

export interface Merge3Options {
  /** Max readTree calls across the whole merge (default 10_000). */
  maxTreeReads?: number;
  /** Max changed leaves per side (default 20_000). */
  maxChanges?: number;
  /** Max readBlob calls (default 1_000). */
  maxBlobReads?: number;
  /** Max bytes of one blob read for a content merge (default 4 MiB). */
  maxBlobBytes?: number;
  /** Myers node budget per line diff (default 400_000). */
  nodeBudget?: number;
  /** Reads in flight (default 8). */
  concurrency?: number;
  /**
   * Max bytes (raw plus compressed) of all objects the merge creates and
   * returns (default 16 MiB). Each object's worst case is reserved before it
   * is built.
   */
  maxMergedBytes?: number;
  /** Content merges (source reads, line merge, blob build) in progress at once (default 1). */
  contentConcurrency?: number;
  /** Resolves conflicting hunks beyond git's rules (default none: git's result exactly). */
  resolver?: HunkResolver;
}

export type Merge3Truncation = TreeDiffTruncation | 'maxBlobReads' | 'maxBlobBytes' | 'maxMergedBytes' | 'diffBudget' | 'missingObject';

export interface Merge3Result {
  /** No conflicts and not truncated. */
  clean: boolean;
  /** The merged root tree; null when conflicted or truncated. */
  treeHash: string | null;
  /** Objects the merged tree needs that the merge created (merged blobs, rebuilt trees); empty unless clean. */
  objects: GitObject[];
  /** Sorted by path, then kind. */
  conflicts: MergeConflict[];
  /** Paths both sides changed that merged cleanly, sorted by path; empty unless clean. */
  resolved: MergeResolution[];
  truncated: boolean;
  truncatedReason?: Merge3Truncation;
  /** The missing object id or failed read message. */
  truncatedDetail?: string;
  treeReads: number;
  blobReads: number;
}

const DEFAULTS = {
  maxTreeReads: 10_000,
  maxChanges: 20_000,
  maxBlobReads: 1_000,
  maxBlobBytes: 4 * 1024 * 1024,
  nodeBudget: 400_000,
  concurrency: 8,
  maxMergedBytes: 16 * 1024 * 1024,
  contentConcurrency: 1,
  resolver: undefined as HunkResolver | undefined,
};

/** Upper bound of an object's raw plus deflated size (deflate's stored-block overhead included). */
const objectBound = (contentBytes: number) => 2 * (contentBytes + 32) + (contentBytes >> 10) + 64;

interface Entry {
  mode: string;
  hash: string;
}

type SrcOp = { op: 'modify'; entry: Entry } | { op: 'delete' } | { op: 'rename'; to: string; entry: Entry };

interface SideOps {
  /** Base path -> what this side did to it. */
  src: Map<string, SrcOp>;
  /** New path -> entry (pure adds and rename targets). */
  adds: Map<string, { entry: Entry; from?: string }>;
  /** Base entries of the paths this side touched. */
  base: Map<string, Entry>;
  renames: Array<[string, string]>;
}

class Stop extends Error {
  constructor(
    readonly reason: Merge3Truncation,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

const isTreeMode = (mode: string) => mode === '40000' || mode === '040000';
const sameEntry = (a: Entry | undefined, b: Entry | undefined) => !!a && !!b && a.mode === b.mode && a.hash === b.hash;
/** git compares S_IFMT: regular files (either mode) vs symlinks vs submodules. */
const typeOf = (mode: string) => (mode === '120000' ? 'link' : mode === '160000' ? 'gitlink' : 'file');
const side = (path: string, e: Entry): MergeSide => ({ path, mode: e.mode, hash: e.hash });

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function sideOps(changes: TreeChange[]): SideOps {
  const ops: SideOps = { src: new Map(), adds: new Map(), base: new Map(), renames: [] };
  for (const c of changes) {
    const oldEntry = c.oldMode && c.oldHash ? { mode: c.oldMode, hash: c.oldHash } : undefined;
    const newEntry = c.newMode && c.newHash ? { mode: c.newMode, hash: c.newHash } : undefined;
    if (c.status === 'added') ops.adds.set(c.path, { entry: newEntry! });
    else if (c.status === 'removed') {
      ops.src.set(c.path, { op: 'delete' });
      ops.base.set(c.path, oldEntry!);
    } else if (c.status === 'renamed') {
      const from = c.oldPath!;
      ops.src.set(from, { op: 'rename', to: c.path, entry: newEntry! });
      ops.adds.set(c.path, { entry: newEntry!, from });
      ops.base.set(from, oldEntry!);
      ops.renames.push([from, c.path]);
    } else {
      ops.src.set(c.path, { op: 'modify', entry: newEntry! });
      ops.base.set(c.path, oldEntry!);
    }
  }
  return ops;
}

/**
 * Directory pairs a file rename suggests: its parent directories, and their
 * parents while the directory names still match (`a/b/x/f -> c/x/f`
 * suggests `a/b/x -> c/x` and `a/b -> c`).
 */
function renamedDirPairs(from: string, to: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let od = dirname(from);
  let nd = dirname(to);
  while (od !== '' && od !== nd) {
    pairs.push([od, nd]);
    if (basename(od) !== basename(nd) || nd === '') break;
    od = dirname(od);
    nd = dirname(nd);
  }
  return pairs;
}

interface ContentTask {
  place: string;
  base?: MergeSide;
  ours: MergeSide;
  theirs: MergeSide;
}

interface EditNode {
  self?: Entry | null;
  children: Map<string, EditNode>;
}

class Merge {
  private treeReads = 0;
  private blobReads = 0;
  private readonly limiter: Limiter;
  private readonly treeCache = new Map<string, Promise<TreeEntry[]>>();
  private readonly edits = new Map<string, Entry | null>();
  private readonly conflicts: MergeConflict[] = [];
  private readonly resolutions: MergeResolution[] = [];
  private readonly objects: GitObject[] = [];
  private readonly tasks: ContentTask[] = [];
  private readonly contentLimiter: Limiter;
  /** Bytes reserved or held by `objects`. */
  private retained = 0;

  constructor(
    private readonly reader: MergeReader,
    private readonly opts: typeof DEFAULTS,
  ) {
    this.limiter = new Limiter(Math.max(1, opts.concurrency));
    this.contentLimiter = new Limiter(Math.max(1, opts.contentConcurrency));
  }

  /** Reserves `bound` bytes for an object about to be built, or stops the merge. */
  private reserve(bound: number, detail: string): void {
    if (this.retained + bound > this.opts.maxMergedBytes) throw new Stop('maxMergedBytes', detail);
    this.retained += bound;
  }

  /** Keeps a built object, replacing its reservation with its actual size. */
  private keep(obj: GitObject, reserved: number): void {
    this.retained += obj.raw.length + obj.store.length - reserved;
    this.objects.push(obj);
  }

  result(partial: Partial<Merge3Result>): Merge3Result {
    return {
      clean: false,
      treeHash: null,
      objects: [],
      conflicts: [],
      resolved: [],
      truncated: false,
      treeReads: this.treeReads,
      blobReads: this.blobReads,
      ...partial,
    };
  }

  private readTree(hash: string): Promise<TreeEntry[]> {
    let p = this.treeCache.get(hash);
    if (!p) {
      p = this.limiter.run(async () => {
        if (this.treeReads >= this.opts.maxTreeReads) throw new Stop('maxTreeReads');
        this.treeReads++;
        let entries: TreeEntry[] | null;
        try {
          entries = await this.reader.readTree(hash);
        } catch (err) {
          throw new Stop('readError', err instanceof Error ? err.message : String(err));
        }
        if (!entries) throw new Stop('missingObject', hash);
        return entries;
      });
      this.treeCache.set(hash, p);
    }
    return p;
  }

  private readBlob(hash: string): Promise<Uint8Array> {
    return this.limiter.run(async () => {
      if (this.blobReads >= this.opts.maxBlobReads) throw new Stop('maxBlobReads');
      this.blobReads++;
      let bytes: Uint8Array | null;
      try {
        bytes = await this.reader.readBlob(hash);
      } catch (err) {
        if (err instanceof BlobTooLargeError) throw new Stop('maxBlobBytes', hash);
        throw new Stop('readError', err instanceof Error ? err.message : String(err));
      }
      if (!bytes) throw new Stop('missingObject', hash);
      if (bytes.length > this.opts.maxBlobBytes) throw new Stop('maxBlobBytes', hash);
      return bytes;
    });
  }

  /**
   * One side's leaf changes; a missing tree is an error, never an empty
   * directory. Reads go through the merge's tree cache and budget, so the
   * base trees both sides and the rebuild need are read once.
   */
  private async diffSide(baseTree: string, sideTree: string): Promise<SideOps> {
    let stop: Stop | undefined;
    const reader: TreeReader = {
      readTree: async (hash) => {
        try {
          return await this.readTree(hash);
        } catch (err) {
          if (err instanceof Stop) stop ??= err;
          throw err;
        }
      },
    };
    const diff = await diffTrees(reader, baseTree, sideTree, {
      leavesOnly: true,
      detectRenames: true,
      maxTreeReads: Number.MAX_SAFE_INTEGER,
      maxChanges: this.opts.maxChanges,
      concurrency: this.opts.concurrency,
    });
    if (stop) throw stop;
    if (diff.truncated) throw new Stop(diff.truncatedReason ?? 'readError', diff.readError);
    return sideOps(diff.changes);
  }

  private conflict(c: Omit<MergeConflict, 'paths'> & { paths?: string[] }): void {
    this.conflicts.push({ ...c, paths: [...new Set(c.paths ?? [c.path])].sort() });
  }

  async run(baseTree: string, oursTree: string, theirsTree: string): Promise<Merge3Result> {
    const ours = await this.diffSide(baseTree, oursTree);
    const theirs = await this.diffSide(baseTree, theirsTree);
    const consumed = { ours: new Set<string>(), theirs: new Set<string>() };

    const basePaths = [...new Set([...ours.src.keys(), ...theirs.src.keys()])].sort();
    for (const p of basePaths) {
      const o = ours.src.get(p);
      const t = theirs.src.get(p);
      const b = (ours.base.get(p) ?? theirs.base.get(p))!;
      const bs = side(p, b);
      if (!o || !t) {
        const op = (o ?? t)!;
        this.edits.set(p, op.op === 'modify' ? op.entry : null);
        continue;
      }
      if (o.op === 'delete' && t.op === 'delete') {
        this.edits.set(p, null);
      } else if (o.op === 'modify' && t.op === 'modify') {
        this.tasks.push({ place: p, base: bs, ours: side(p, o.entry), theirs: side(p, t.entry) });
      } else if (o.op === 'modify' && t.op === 'delete') {
        this.conflict({ path: p, kind: 'modify-delete', base: bs, ours: side(p, o.entry) });
        this.edits.set(p, o.entry);
      } else if (o.op === 'delete' && t.op === 'modify') {
        this.conflict({ path: p, kind: 'modify-delete', base: bs, theirs: side(p, t.entry) });
        this.edits.set(p, t.entry);
      } else if (o.op === 'rename' && t.op === 'rename') {
        this.edits.set(p, null);
        consumed.ours.add(o.to);
        consumed.theirs.add(t.to);
        if (o.to === t.to) {
          this.tasks.push({ place: o.to, base: bs, ours: side(o.to, o.entry), theirs: side(t.to, t.entry) });
        } else {
          this.conflict({ path: p, kind: 'rename', paths: [p, o.to, t.to], base: bs, ours: side(o.to, o.entry), theirs: side(t.to, t.entry) });
          this.edits.set(o.to, o.entry);
          this.edits.set(t.to, t.entry);
        }
      } else if (o.op === 'rename' || t.op === 'rename') {
        const renamedByOurs = o.op === 'rename';
        const r = (renamedByOurs ? o : t) as Extract<SrcOp, { op: 'rename' }>;
        const other = renamedByOurs ? t : o;
        this.edits.set(p, null);
        (renamedByOurs ? consumed.ours : consumed.theirs).add(r.to);
        if (other.op === 'delete') {
          this.conflict({ path: p, kind: 'rename', paths: [p, r.to], base: bs, [renamedByOurs ? 'ours' : 'theirs']: side(r.to, r.entry) });
          this.edits.set(r.to, r.entry);
          continue;
        }
        const otherEntry = (other as Extract<SrcOp, { op: 'modify' }>).entry;
        const otherAdds = renamedByOurs ? theirs.adds : ours.adds;
        const collision = otherAdds.get(r.to);
        if (collision) {
          // The other side added a file where this side renamed one to.
          (renamedByOurs ? consumed.theirs : consumed.ours).add(r.to);
          const [oe, te] = renamedByOurs ? [r.entry, collision.entry] : [collision.entry, r.entry];
          this.conflict({ path: r.to, kind: 'add-add', ours: side(r.to, oe), theirs: side(r.to, te) });
          this.edits.set(r.to, oe);
          continue;
        }
        const renamed = side(r.to, r.entry);
        const modified = side(p, otherEntry);
        this.tasks.push({ place: r.to, base: bs, ours: renamedByOurs ? renamed : modified, theirs: renamedByOurs ? modified : renamed });
      }
    }

    await this.placeAdds(ours, theirs, oursTree, theirsTree, consumed);
    await Promise.all(this.tasks.map((t) => this.contentLimiter.run(() => this.contentMerge(t))));

    const root = await this.build(baseTree, this.editTree(), '');
    const conflicts = this.conflicts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    if (conflicts.length > 0) return this.result({ conflicts });
    let treeHash = root;
    if (treeHash === null) {
      const bound = objectBound(0);
      this.reserve(bound, '');
      const empty = await buildTree([]);
      this.keep(empty, bound);
      treeHash = empty.hash;
    }
    const resolved = this.resolutions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return this.result({ clean: true, treeHash, objects: this.objects, resolved });
  }

  private async placeAdds(
    ours: SideOps,
    theirs: SideOps,
    oursTree: string,
    theirsTree: string,
    consumed: { ours: Set<string>; theirs: Set<string> },
  ): Promise<void> {
    const oursAdds = [...ours.adds].filter(([q]) => !consumed.ours.has(q));
    const theirsAdds = [...theirs.adds].filter(([q]) => !consumed.theirs.has(q));
    // A directory renamed away on one side relocates the other side's additions into it.
    const oursMoves = await this.dirRenames(ours, oursTree, theirsAdds.map(([q]) => q));
    const theirsMoves = await this.dirRenames(theirs, theirsTree, oursAdds.map(([q]) => q));

    const placed = new Map<string, { ours?: Entry; theirs?: Entry }>();
    const place = (adds: typeof oursAdds, moves: Map<string, string>, who: 'ours' | 'theirs') => {
      for (const [q, { entry }] of adds) {
        const target = moves.get(q) ?? q;
        if (target !== q) this.conflict({ path: q, kind: 'rename', paths: [q, target], [who]: side(target, entry) });
        const slot = placed.get(target) ?? {};
        slot[who] = entry;
        placed.set(target, slot);
      }
    };
    place(oursAdds, theirsMoves, 'ours');
    place(theirsAdds, oursMoves, 'theirs');

    for (const [q, { ours: oe, theirs: te }] of placed) {
      if (oe && te && !sameEntry(oe, te)) {
        const kind = typeOf(oe.mode) !== typeOf(te.mode) ? 'typechange' : 'add-add';
        this.conflict({ path: q, kind, ours: side(q, oe), theirs: side(q, te) });
      } else if (oe && te) this.resolutions.push({ path: q, rule: 'add-add-identical' });
      this.edits.set(q, (oe ?? te)!);
    }
  }

  /**
   * For each directory that `renamer` removed and whose exact renames mostly
   * went to one new directory, where the other side's additions under it
   * would move. Like merge-ort, only directories that directly contain an
   * `added` path are considered, and one whose renames tie between
   * destinations is a `rename` conflict on the directory (git's
   * "directory rename split").
   */
  private async dirRenames(renamer: SideOps, renamerTree: string, added: string[]): Promise<Map<string, string>> {
    const moves = new Map<string, string>();
    if (added.length === 0 || renamer.renames.length === 0) return moves;
    const relevant = new Set<string>();
    for (const q of added) if (dirname(q) !== '') relevant.add(dirname(q));

    const counts = new Map<string, Map<string, number>>();
    for (const [from, to] of renamer.renames) {
      for (const [od, nd] of renamedDirPairs(from, to)) {
        if (!relevant.has(od)) continue;
        const targets = counts.get(od) ?? new Map<string, number>();
        targets.set(nd, (targets.get(nd) ?? 0) + 1);
        counts.set(od, targets);
      }
    }
    const renamedTo = new Map<string, string>();
    for (const [dir, targets] of counts) {
      if (await this.dirExists(renamerTree, dir)) continue;
      const ranked = [...targets].sort((a, b) => b[1] - a[1]);
      if (ranked.length > 1 && ranked[0]![1] === ranked[1]![1]) {
        this.conflict({ path: dir, kind: 'rename' });
        continue;
      }
      renamedTo.set(dir, ranked[0]![0]);
    }
    for (const q of added) {
      for (let d = dirname(q); d !== ''; d = dirname(d)) {
        const to = renamedTo.get(d);
        if (to === undefined) continue;
        const rest = q.slice(d.length + 1);
        moves.set(q, to === '' ? rest : `${to}/${rest}`);
        break;
      }
    }
    return moves;
  }

  private async dirExists(rootTree: string, dir: string): Promise<boolean> {
    let tree = rootTree;
    for (const part of dir.split('/')) {
      const e = (await this.readTree(tree)).find((x) => x.name === part);
      if (!e || !isTreeMode(e.mode)) return false;
      tree = e.hash;
    }
    return true;
  }

  private async contentMerge(t: ContentTask): Promise<void> {
    const { place, base: b, ours: o, theirs: th } = t;
    const set = (e: Entry) => this.edits.set(place, e);
    if (sameEntry(o, th)) {
      if (!b || !sameEntry(o, b)) this.resolutions.push({ path: place, rule: 'identical-change' });
      return void set(o);
    }
    if (b && sameEntry(o, b)) return void set(th);
    if (b && sameEntry(th, b)) return void set(o);
    if (typeOf(o.mode) !== typeOf(th.mode)) {
      this.conflict({ path: place, kind: 'typechange', base: b, ours: o, theirs: th });
      return void set(o);
    }
    // git's mode rule for a content merge.
    const modeClean = o.mode === th.mode || o.mode === b?.mode || th.mode === b?.mode;
    const mode = o.mode === th.mode || o.mode === b?.mode ? th.mode : o.mode;

    let hash: string;
    if (o.hash === th.hash) hash = o.hash;
    else if (b && o.hash === b.hash) hash = th.hash;
    else if (b && th.hash === b.hash) hash = o.hash;
    else if (typeOf(o.mode) !== 'file') {
      // Symlink targets and submodule commits do not merge line by line.
      this.conflict({ path: place, kind: 'content', base: b, ours: o, theirs: th });
      return void set(o);
    } else {
      const [bb, ob, tb] = await Promise.all([
        b && typeOf(b.mode) !== 'gitlink' ? this.readBlob(b.hash) : Promise.resolve(new Uint8Array(0)),
        this.readBlob(o.hash),
        this.readBlob(th.hash),
      ]);
      if (isBinaryContent3(bb, ob, tb)) {
        this.conflict({ path: place, kind: 'binary', base: b, ours: o, theirs: th });
        return void set(o);
      }
      const resolver = this.opts.resolver;
      const merged = mergeText(bb, ob, tb, {
        nodeBudget: this.opts.nodeBudget,
        ...(resolver ? { resolveHunk: (ours: readonly string[], theirs: readonly string[]) => resolver(place, ours, theirs) } : {}),
      });
      if (!merged) throw new Stop('diffBudget', place);
      if (!merged.clean) {
        this.conflict({ path: place, kind: 'content', base: b, ours: o, theirs: th, hunks: merged.conflicts });
        return void set(o);
      }
      const bound = objectBound(merged.merged.length);
      this.reserve(bound, place);
      const blob = await buildBlob(merged.merged);
      this.keep(blob, bound);
      hash = blob.hash;
      this.resolutions.push(merged.resolved > 0 ? { path: place, rule: 'whitespace-only', hunks: merged.resolved } : { path: place, rule: 'non-overlapping' });
    }
    if (!modeClean) {
      this.conflict({ path: place, kind: 'content', base: b, ours: o, theirs: th });
      return void set(o);
    }
    set({ mode, hash });
  }

  private editTree(): EditNode {
    const root: EditNode = { children: new Map() };
    for (const [path, entry] of this.edits) {
      let node = root;
      for (const part of path.split('/')) {
        let next = node.children.get(part);
        if (!next) {
          next = { children: new Map() };
          node.children.set(part, next);
        }
        node = next;
      }
      node.self = entry;
    }
    return root;
  }

  /** Applies the edits under `node` to `treeHash` (null: no such directory); null when the result is empty. */
  private async build(treeHash: string | null, node: EditNode, prefix: string): Promise<string | null> {
    const entries = new Map<string, TreeEntry>();
    if (treeHash) for (const e of await this.readTree(treeHash)) entries.set(e.name, e);

    await Promise.all(
      [...node.children].map(async ([name, child]) => {
        const path = prefix + name;
        const existing = entries.get(name);
        if (child.children.size === 0) {
          if (child.self === null) entries.delete(name);
          else if (child.self) entries.set(name, { ...child.self, name });
          return;
        }
        const sub = await this.build(existing && isTreeMode(existing.mode) ? existing.hash : null, child, `${path}/`);
        const file = child.self !== undefined ? child.self : existing && !isTreeMode(existing.mode) ? existing : null;
        if (sub !== null && file) {
          this.conflict({ path, kind: 'file-directory' });
          entries.set(name, { mode: file.mode, hash: file.hash, name });
        } else if (sub !== null) entries.set(name, { mode: '40000', name, hash: sub });
        else if (file) entries.set(name, { mode: file.mode, hash: file.hash, name });
        else entries.delete(name);
      }),
    );
    if (entries.size === 0) return null;
    let size = 0;
    for (const e of entries.values()) size += e.name.length * 3 + 28;
    const bound = objectBound(size);
    this.reserve(bound, prefix);
    const tree = await buildTree([...entries.values()]);
    this.keep(tree, bound);
    return tree.hash;
  }
}

/** Three-way merge of `oursTree` and `theirsTree` against `baseTree`. */
export async function merge3(
  reader: MergeReader,
  baseTree: string,
  oursTree: string,
  theirsTree: string,
  options: Merge3Options = {},
): Promise<Merge3Result> {
  const opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as typeof DEFAULTS;
  const m = new Merge(reader, opts);
  if (oursTree === theirsTree || baseTree === theirsTree) return m.result({ clean: true, treeHash: oursTree });
  if (baseTree === oursTree) return m.result({ clean: true, treeHash: theirsTree });
  try {
    return await m.run(baseTree, oursTree, theirsTree);
  } catch (err) {
    if (!(err instanceof Stop)) throw err;
    return m.result({ truncated: true, truncatedReason: err.reason, ...(err.detail !== undefined ? { truncatedDetail: err.detail } : {}) });
  }
}
