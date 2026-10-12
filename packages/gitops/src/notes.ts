/**
 * Git notes trees: locate and replace one commit's note without a git binary.
 *
 * A notes ref points at an ordinary commit whose tree maps annotated commit
 * ids to note blobs. Git may store a note at the root (`<40-hex>`) or below
 * fanout directories (`ab/<38-hex>`, `ab/cd/<36-hex>`, ...), so lookups walk
 * every fanout level. Writes keep whatever layout already holds the note and
 * otherwise add a root entry, which git reads alongside fanout directories.
 */

import { buildBlob, buildCommit, buildTree, type GitIdent, type GitObject, type TreeEntry } from './index';

export const KVARM_NOTES_REF = 'refs/notes/kvarm-attribution';

export class NotesTreeError extends Error {
  constructor(readonly tree: string) {
    super(`notes tree ${tree} is not readable`);
    this.name = 'NotesTreeError';
  }
}

export interface NotesTreeReader {
  readTree(hash: string): Promise<TreeEntry[] | null>;
}

export interface NoteLocation {
  blob: string;
  /** Path of the note inside the notes tree, e.g. `ab/cdef…` for a fanout note. */
  path: string;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const FANOUT_DIR = /^[0-9a-f]{2}$/;

async function readTreeOrThrow(reader: NotesTreeReader, hash: string): Promise<TreeEntry[]> {
  const entries = await reader.readTree(hash);
  if (!entries) throw new NotesTreeError(hash);
  return entries;
}

/** Entries from the root down to the note, or null when the tree has no note for `target`. */
async function locate(
  reader: NotesTreeReader,
  tree: string,
  target: string,
  consumed: number,
): Promise<{ trees: { hash: string; entries: TreeEntry[] }[]; leaf: TreeEntry } | null> {
  const entries = await readTreeOrThrow(reader, tree);
  const rest = target.slice(consumed);
  const leaf = entries.find((e) => e.mode !== '40000' && e.name === rest);
  if (leaf) return { trees: [{ hash: tree, entries }], leaf };
  if (rest.length <= 2) return null;
  const dir = entries.find((e) => e.mode === '40000' && FANOUT_DIR.test(e.name) && e.name === rest.slice(0, 2));
  if (!dir) return null;
  const below = await locate(reader, dir.hash, target, consumed + 2);
  if (!below) return null;
  return { trees: [{ hash: tree, entries }, ...below.trees], leaf: below.leaf };
}

function assertTarget(target: string): void {
  if (!FULL_SHA.test(target)) throw new TypeError(`note target must be a full commit sha: ${target}`);
}

export async function findNote(reader: NotesTreeReader, rootTree: string | null, target: string): Promise<NoteLocation | null> {
  assertTarget(target);
  if (!rootTree) return null;
  const found = await locate(reader, rootTree, target, 0);
  return found ? locationOf(found.trees.length - 1, found.leaf, target) : null;
}

function locationOf(depth: number, leaf: TreeEntry, target: string): NoteLocation {
  const dirs = Array.from({ length: depth }, (_, i) => target.slice(i * 2, i * 2 + 2));
  return { blob: leaf.hash, path: [...dirs, leaf.name].join('/') };
}

export interface NotesCommitInput {
  reader: NotesTreeReader;
  /** Current notes tip, or null when the ref does not exist yet. */
  parent: { commit: string; tree: string } | null;
  target: string;
  content: Uint8Array;
  author: GitIdent;
  message?: string;
}

export interface NotesCommitResult {
  commit: string;
  tree: string;
  /** New blob, rebuilt trees and the commit, ready to pack. */
  objects: GitObject[];
  /** The note this commit replaced, or null when it added one. */
  replaced: NoteLocation | null;
}

export async function buildNotesCommit(input: NotesCommitInput): Promise<NotesCommitResult> {
  const { reader, parent, target, content, author } = input;
  assertTarget(target);
  const blob = await buildBlob(content);
  const objects: GitObject[] = [blob];
  let rootTree: GitObject;
  let replaced: NoteLocation | null = null;

  const found = parent ? await locate(reader, parent.tree, target, 0) : null;
  if (found) {
    // Rebuild bottom-up along the fanout path that already holds the note.
    let name = found.leaf.name;
    let hash = blob.hash;
    let mode = found.leaf.mode;
    let built: GitObject | null = null;
    for (let level = found.trees.length - 1; level >= 0; level--) {
      const entries = found.trees[level]!.entries.map((e) => (e.name === name && (e.mode === '40000') === (mode === '40000') ? { ...e, hash } : e));
      built = await buildTree(entries);
      objects.push(built);
      name = target.slice((level - 1) * 2, level * 2);
      hash = built.hash;
      mode = '40000';
    }
    rootTree = built!;
    replaced = locationOf(found.trees.length - 1, found.leaf, target);
  } else {
    const entries = parent ? await readTreeOrThrow(reader, parent.tree) : [];
    rootTree = await buildTree([...entries, { mode: '100644', name: target, hash: blob.hash }]);
    objects.push(rootTree);
  }

  const commit = await buildCommit({
    tree: rootTree.hash,
    parents: parent ? [parent.commit] : [],
    author,
    committer: author,
    message: input.message ?? 'Notes added by Kvarm\n',
  });
  objects.push(commit);
  return { commit: commit.hash, tree: rootTree.hash, objects, replaced };
}
