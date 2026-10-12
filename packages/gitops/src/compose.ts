/**
 * Composition of candidate attempts: pieces of several heads, each relative
 * to its own base, folded onto a start tree with `merge3`, in order.
 *
 * A piece is a head tree, optionally narrowed to selected paths (exact file
 * paths, or directory prefixes ending in `/`): only the head's leaf changes
 * under the selection are applied to the piece's base (`selectTree`), so a
 * piece can contribute some files of an attempt and leave the rest. Folding
 * is `acc = merge3(piece.base, acc, selected)`, which for two pieces at the
 * start tree is exactly `git merge-tree --write-tree <a> <b>`.
 *
 * An incompatible piece leaves the accumulated tree as it was and its
 * conflicts are reported against that piece; later pieces still fold, so
 * one call reports every incompatibility. Any conflict or spent budget means
 * no tree: a composition is never partially applied.
 */

import { buildTree, parseTree, type GitObject, type TreeEntry } from './index';
import { merge3, type MergeConflict, type Merge3Options, type Merge3Truncation, type MergeReader } from './merge3';
import { diffTrees, type TreeReader } from './treediff';

export interface ComposePiece {
  /** Caller's label for the piece, echoed on conflicts. */
  name: string;
  /** The tree the piece's changes are relative to (its merge base with the start). */
  baseTree: string;
  headTree: string;
  /** Selected paths (a trailing `/` selects a directory prefix); omitted: the whole head. */
  paths?: readonly string[];
}

export interface ComposeConflict extends MergeConflict {
  /** The piece that could not be folded onto the composition so far. */
  piece: string;
}

export interface ComposeResult {
  clean: boolean;
  /** The composed tree; null on any conflict or truncation. */
  treeHash: string | null;
  /** Objects the composed tree needs that composition created; empty unless clean. */
  objects: GitObject[];
  conflicts: ComposeConflict[];
  /** Selected paths that match no change of their piece, sorted per piece. */
  unmatched: Array<{ piece: string; path: string }>;
  truncated: boolean;
  truncatedReason?: Merge3Truncation;
  truncatedDetail?: string;
  /** The piece whose selection or merge ran out of budget. */
  truncatedPiece?: string;
  treeReads: number;
  blobReads: number;
}

export interface SelectResult {
  treeHash: string | null;
  objects: GitObject[];
  /** Selectors that matched at least one changed leaf, sorted. */
  matched: string[];
  truncated: boolean;
  truncatedReason?: Merge3Truncation;
  truncatedDetail?: string;
  treeReads: number;
}

const isTreeMode = (mode: string) => mode === '40000' || mode === '040000';

/** A reader that serves objects composition created before falling back to the store. */
class Overlay implements MergeReader {
  readonly created = new Map<string, GitObject>();

  constructor(private readonly reader: MergeReader) {}

  add(objects: readonly GitObject[]): void {
    for (const o of objects) this.created.set(o.hash, o);
  }

  readTree(hash: string): Promise<TreeEntry[] | null> {
    const o = this.created.get(hash);
    if (o && o.type === 'tree') return Promise.resolve(parseTree(o.raw));
    return this.reader.readTree(hash);
  }

  readBlob(hash: string): Promise<Uint8Array | null> {
    const o = this.created.get(hash);
    if (o && o.type === 'blob') return Promise.resolve(o.raw.subarray(o.raw.indexOf(0) + 1));
    return this.reader.readBlob(hash);
  }

  /** The created objects reachable from `tree` (store objects are never walked). */
  reachable(tree: string): GitObject[] {
    const out = new Map<string, GitObject>();
    const visit = (hash: string) => {
      const o = this.created.get(hash);
      if (!o || out.has(hash)) return;
      out.set(hash, o);
      if (o.type === 'tree') for (const e of parseTree(o.raw)) visit(e.hash);
    };
    visit(tree);
    return [...out.values()];
  }
}

function selects(selector: string, path: string): boolean {
  return selector.endsWith('/') ? path.startsWith(selector) : path === selector;
}

interface EditNode {
  self?: TreeEntry | null;
  children: Map<string, EditNode>;
}

class SelectionClash extends Error {}

/**
 * The base tree with the head's leaf changes under `paths` applied. A
 * directory/file replacement applies when both of its sides are selected
 * (the file and the directory prefix). A selection that would leave a path
 * both a file and a directory (one side of such a replacement only) is
 * refused with `treeHash` null and `truncated` false.
 */
export async function selectTree(
  reader: TreeReader,
  baseTree: string,
  headTree: string,
  paths: readonly string[],
  opts: Pick<Merge3Options, 'maxTreeReads' | 'maxChanges' | 'concurrency'> = {},
): Promise<SelectResult> {
  const diff = await diffTrees(reader, baseTree, headTree, {
    maxTreeReads: opts.maxTreeReads,
    maxChanges: opts.maxChanges,
    concurrency: opts.concurrency,
    detectRenames: false,
    leavesOnly: true,
  });
  let treeReads = diff.treeReads;
  const fail = (reason: Merge3Truncation, detail?: string): SelectResult => ({
    treeHash: null,
    objects: [],
    matched: [],
    truncated: true,
    truncatedReason: reason,
    ...(detail !== undefined ? { truncatedDetail: detail } : {}),
    treeReads,
  });
  if (diff.truncated) return fail(diff.truncatedReason ?? 'readError', diff.readError);

  const matched = new Set<string>();
  const root: EditNode = { children: new Map() };
  for (const c of diff.changes) {
    const hit = paths.filter((p) => selects(p, c.path));
    if (hit.length === 0) continue;
    for (const p of hit) matched.add(p);
    let node = root;
    for (const part of c.path.split('/')) {
      let next = node.children.get(part);
      if (!next) node.children.set(part, (next = { children: new Map() }));
      node = next;
    }
    node.self = c.newMode && c.newHash ? { mode: c.newMode, name: '', hash: c.newHash } : null;
  }
  const done = { matched: [...matched].sort(), truncated: false, treeReads };
  if (root.children.size === 0) return { treeHash: baseTree, objects: [], ...done };

  const objects: GitObject[] = [];
  const build = async (tree: string | null, node: EditNode): Promise<string | null> => {
    const entries = new Map<string, TreeEntry>();
    if (tree !== null) {
      if (treeReads >= (opts.maxTreeReads ?? Infinity)) throw new Stop('maxTreeReads');
      treeReads++;
      const listed = await reader.readTree(tree);
      if (!listed) throw new Stop('missingObject', tree);
      for (const e of listed) entries.set(e.name, e);
    }
    for (const [name, child] of node.children) {
      const existing = entries.get(name);
      if (child.children.size === 0) {
        if (child.self === null) entries.delete(name);
        else if (child.self) {
          if (existing && isTreeMode(existing.mode)) throw new SelectionClash(name);
          entries.set(name, { ...child.self, name });
        }
        continue;
      }
      // A node with both an entry change and changes below it is a structural
      // replacement: file→directory selects the file's deletion, directory→file
      // must remove every descendant before the file can take the path.
      const under = existing && !isTreeMode(existing.mode) && child.self === null ? undefined : existing;
      if (under && !isTreeMode(under.mode)) throw new SelectionClash(name);
      const sub = await build(under ? under.hash : null, child);
      if (child.self) {
        if (sub !== null) throw new SelectionClash(name);
        entries.set(name, { ...child.self, name });
      } else if (sub === null) entries.delete(name);
      else entries.set(name, { mode: '40000', name, hash: sub });
    }
    if (entries.size === 0) return null;
    const obj = await buildTree([...entries.values()]);
    objects.push(obj);
    return obj.hash;
  };
  try {
    const hash = await build(baseTree, root);
    if (hash === null) {
      const empty = await buildTree([]);
      return { treeHash: empty.hash, objects: [empty], ...done, treeReads };
    }
    return { treeHash: hash, objects, ...done, treeReads };
  } catch (err) {
    if (err instanceof SelectionClash) return { treeHash: null, objects: [], ...done, treeReads };
    if (err instanceof Stop) return fail(err.reason, err.detail);
    return fail('readError', err instanceof Error ? err.message : String(err));
  }
}

class Stop extends Error {
  constructor(
    readonly reason: Merge3Truncation,
    readonly detail?: string,
  ) {
    super(reason);
  }
}

/**
 * Folds `pieces` onto `startTree` in order. Budgets apply per merge step and
 * tree reads are counted across the whole composition.
 */
export async function composeTrees(
  reader: MergeReader,
  startTree: string,
  pieces: readonly ComposePiece[],
  options: Merge3Options = {},
): Promise<ComposeResult> {
  const overlay = new Overlay(reader);
  const conflicts: ComposeConflict[] = [];
  const unmatched: ComposeResult['unmatched'] = [];
  let treeReads = 0;
  let blobReads = 0;
  let acc = startTree;
  const out = (partial: Partial<ComposeResult>): ComposeResult => ({
    clean: false,
    treeHash: null,
    objects: [],
    conflicts,
    unmatched,
    truncated: false,
    treeReads,
    blobReads,
    ...partial,
  });
  const budget = () => (options.maxTreeReads === undefined ? undefined : Math.max(0, options.maxTreeReads - treeReads));

  for (const piece of pieces) {
    let theirs = piece.headTree;
    if (piece.paths !== undefined) {
      const sel = await selectTree(overlay, piece.baseTree, piece.headTree, piece.paths, { ...options, maxTreeReads: budget() });
      treeReads += sel.treeReads;
      if (sel.truncated) {
        return out({ truncated: true, truncatedReason: sel.truncatedReason, truncatedDetail: sel.truncatedDetail, truncatedPiece: piece.name });
      }
      for (const p of [...piece.paths].filter((p) => !sel.matched.includes(p)).sort()) unmatched.push({ piece: piece.name, path: p });
      if (sel.treeHash === null) {
        conflicts.push({ piece: piece.name, path: sel.matched[0] ?? '', kind: 'file-directory', paths: sel.matched });
        continue;
      }
      overlay.add(sel.objects);
      theirs = sel.treeHash;
    }
    const m = await merge3(overlay, piece.baseTree, acc, theirs, { ...options, maxTreeReads: budget() });
    treeReads += m.treeReads;
    blobReads += m.blobReads;
    if (m.truncated) {
      return out({ truncated: true, truncatedReason: m.truncatedReason, truncatedDetail: m.truncatedDetail, truncatedPiece: piece.name });
    }
    if (!m.clean || m.treeHash === null) {
      for (const c of m.conflicts) conflicts.push({ ...c, piece: piece.name });
      continue;
    }
    overlay.add(m.objects);
    acc = m.treeHash;
  }
  if (conflicts.length > 0) return out({});
  return out({ clean: true, treeHash: acc, objects: overlay.reachable(acc) });
}
