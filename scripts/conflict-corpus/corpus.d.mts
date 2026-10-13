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

/** One commit of a criss-cross case: name, parent names, patch over the first parent (a root's whole file map). */
export type CommitSpec = [name: string, parents: string[], patch: Record<string, Exclude<FileSpec, { from: string }> | null>];

export interface CrissCrossCase {
  name: string;
  expect?: 'clean' | 'conflict';
  /** How many merge bases git reports for the tips; checked when the corpus is built. */
  bases?: number;
  /** In creation order; parents come first. */
  commits: CommitSpec[];
  ours: string;
  theirs: string;
}

export interface CrissCrossResult {
  name: string;
  /** Commit oids of the tips. */
  ours: string;
  theirs: string;
  /** `git merge-base --all`, sorted. */
  bases: string[];
  expected: CorpusResult['expected'];
}

export const CRISS_CROSS_CASES: CrissCrossCase[];
export function crissCrossRandomCases(seed?: number, count?: number): CrissCrossCase[];
export function allCrissCrossCases(): CrissCrossCase[];
export function buildCrissCrossCorpus(dir: string, cases: CrissCrossCase[]): CrissCrossResult[];
