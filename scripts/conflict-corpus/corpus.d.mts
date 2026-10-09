export type FileSpec =
  | string
  | { content: string; mode?: '100644' | '100755' }
  | { symlink: string }
  | { gitlink: string }
  | { from: string };

export interface CorpusCase {
  name: string;
  /** What git is expected to report; checked when the corpus is built. */
  expect?: 'clean' | 'conflict';
  base: Record<string, Exclude<FileSpec, { from: string }>>;
  ours: Record<string, FileSpec | null>;
  theirs: Record<string, FileSpec | null>;
}

export interface CorpusResult {
  name: string;
  /** Tree oids in the corpus repository. */
  base: string;
  ours: string;
  theirs: string;
  expected: {
    clean: boolean;
    /** `git merge-tree --write-tree` tree (for conflicts, git's tree with markers). */
    tree: string;
    /** Sorted `kind:path[,path…]` keys (see conflictKey); empty when clean. */
    conflicts: string[];
  };
}

export const EMPTY_TREE: string;
export const HAND_CASES: CorpusCase[];
export function textCases(seed?: number, count?: number): CorpusCase[];
export function treeCases(seed?: number, count?: number): CorpusCase[];
export function allCases(): CorpusCase[];
export function conflictKey(kind: string, paths: string[]): string;
export function parseMergeTree(
  stdout: Uint8Array,
  labels: string[],
): { tree: string; conflicts: string[]; messages: { paths: string[]; type: string; message: string }[] };
export function buildCorpus(dir: string, cases: CorpusCase[]): CorpusResult[];
export function loadObjects(dir: string): Map<string, { type: string; content: Uint8Array }>;
