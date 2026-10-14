/**
 * Tree listings and file reads for the REST content routes (and through them
 * the MCP get_tree/read_file tools). Callers authorize first through the
 * shared authority lookup; nothing here checks access.
 */

import type { RepoRow } from '../db/repos';
import type { ServiceResult } from '../repos/service';
import { fail } from './result';
import { withRepo } from '../artifacts/repo';
import { readFileImmutable } from '../cache/content';

/** Files above this size are refused instead of being returned whole. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface TreeEntryView {
  name: string;
  path: string;
  /** git ls-tree object type */
  type: 'blob' | 'tree' | 'commit';
  /** git ls-tree mode (six digits) */
  mode: string;
  hash: string;
}

export interface TreeView {
  ref: string;
  sha: string;
  path: string;
  entries: TreeEntryView[];
}

export interface FileView {
  ref: string;
  path: string;
  size: number;
  encoding: 'utf-8' | 'base64';
  content: string;
}



/**
 * Repo-relative path without leading/trailing slashes, or null when it has
 * empty, `.`/`..` or control-character segments.
 */
export function normalizeRepoPath(raw: string): string | null {
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  const parts = trimmed.split('/');
  // eslint-disable-next-line no-control-regex
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[\u0000-\u001f\u007f]/.test(p))) return null;
  return parts.join('/');
}

function isMissingObject(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'INVALID_INPUT' || code === 'NOT_FOUND';
}

function isMemoryLimit(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'MEMORY_LIMIT';
}

function lsTreeEntry(dir: string, e: ArtifactsTreeEntry): TreeEntryView {
  const mode = e.mode.padStart(6, '0');
  const type = mode === '040000' ? 'tree' : mode === '160000' ? 'commit' : 'blob';
  return { name: e.name, path: dir ? `${dir}/${e.name}` : e.name, type, mode, hash: e.hash };
}

export async function readTreeView(env: Env, repo: RepoRow, ref: string, rawPath: string): Promise<ServiceResult<TreeView>> {
  const path = normalizeRepoPath(rawPath);
  if (path === null) return fail(400, `invalid path "${rawPath}"`, 'INVALID_PATH');
  try {
    return await withRepo(env, repo.artifacts_name, async (h): Promise<ServiceResult<TreeView>> => {
      let commit: ArtifactsCommitMetadata | undefined;
      try {
        commit = (await h.log({ ref, limit: 1 }))?.[0];
      } catch (err) {
        if (!isMissingObject(err)) throw err;
      }
      if (!commit) return fail(404, `ref "${ref}" not found`, 'REF_NOT_FOUND');
      let hash = commit.treeHash;
      for (const part of path ? path.split('/') : []) {
        const entries = await h.readTree(hash);
        const entry = entries?.find((e) => e.name === part);
        if (!entry || entry.mode.padStart(6, '0') !== '040000') {
          return fail(404, `no directory "${path}" at ${ref}`, 'PATH_NOT_FOUND');
        }
        hash = entry.hash;
      }
      const entries = await h.readTree(hash);
      if (!entries) return fail(404, `no directory "${path}" at ${ref}`, 'PATH_NOT_FOUND');
      return { ok: true, value: { ref, sha: commit.hash, path, entries: entries.map((e) => lsTreeEntry(path, e)) } };
    });
  } catch (err) {
    console.error(JSON.stringify({ treeReadFailed: { repo: repo.id, error: String(err) } }));
    return fail(503, 'repository storage is unavailable; retry', 'STORAGE_UNAVAILABLE');
  }
}

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/** utf-8 when the bytes are valid UTF-8 without a NUL in git's binary probe window, else base64. */
function encodeContent(bytes: Uint8Array): { encoding: 'utf-8' | 'base64'; content: string } {
  if (!bytes.subarray(0, 8000).includes(0)) {
    try {
      return { encoding: 'utf-8', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
    } catch {
      // not UTF-8
    }
  }
  return { encoding: 'base64', content: toBase64(bytes) };
}

export async function readFileView(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  repo: RepoRow,
  ref: string,
  rawPath: string,
): Promise<ServiceResult<FileView>> {
  const path = normalizeRepoPath(rawPath);
  if (!path) return fail(400, 'path is required and must be a repository-relative file path', 'INVALID_PATH');
  let blob: Blob | null;
  try {
    blob = await readFileImmutable(env, ctx, repo, ref, path);
  } catch (err) {
    if (isMissingObject(err)) blob = null;
    else if (isMemoryLimit(err)) return fail(422, `"${path}" is too large to read (limit ${MAX_FILE_BYTES} bytes)`, 'FILE_TOO_LARGE');
    else {
      console.error(JSON.stringify({ fileReadFailed: { repo: repo.id, error: String(err) } }));
      return fail(503, 'repository storage is unavailable; retry', 'STORAGE_UNAVAILABLE');
    }
  }
  if (!blob) return fail(404, `no file "${path}" at ${ref}`, 'FILE_NOT_FOUND');
  if (blob.size > MAX_FILE_BYTES) {
    return fail(422, `"${path}" is ${blob.size} bytes; the limit is ${MAX_FILE_BYTES}`, 'FILE_TOO_LARGE');
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { ok: true, value: { ref, path, size: bytes.length, ...encodeContent(bytes) } };
}
