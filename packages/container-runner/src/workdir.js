// @ts-check
/**
 * Persistent per-repository working directories for `kvarm runner`.
 *
 * Layout: `<workRoot>/<owner>/<repo>/slot-<n>/{work,staging,state.json}` with
 * the slot's lock beside it (`slot-<n>.lock`). One runner process owns a slot
 * for its whole lifetime; a concurrent runner for the same repository takes
 * the next free slot, so a workdir is never shared.
 *
 * The first job in a slot is a full snapshot checkout, and the exact tree it
 * produced is recorded in the state manifest: every tracked path with its
 * git blob hash and mode. A later job asks the runner's delta fetcher for
 * only the paths that changed between the recorded commit and the new head
 * and applies them to `work`: deleted paths disappear, modified and added
 * paths are written with their exact bytes and modes, and any tracked file a
 * previous job dirtied is restored even when the delta does not touch it
 * (the recorded hashes prove which files drifted). Anything else untracked
 * is removed unless it lies inside a dependency-cache directory
 * (`CACHE_DIRS`), which is kept so installs do not repeat. Any failure on
 * that path falls back to a full checkout into an emptied `work`, so a warm
 * job downloads the whole tree only as that fallback.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CliError } from './checkout.js';
import { isTreeMode, parseRepoPath } from './guards.js';

/** Untracked directories (matched by name at any depth) that survive a warm sync. */
export const CACHE_DIRS = new Set(['node_modules', '.venv', 'venv', 'target', '.cache', '.gradle', '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox']);
const MAX_SLOTS = 16;
const STATE_VERSION = 2;

/**
 * @typedef {object} Slot
 * @property {string} dir
 * @property {string} work
 * @property {string} staging
 * @property {string} state
 * @property {boolean} persistent
 * @property {() => void} release
 *
 * The tree a slot recorded after its last successful materialize: the file
 * list plus, per file, the git blob hash and normalized mode (`100644`,
 * `100755`, `120000`) that prove whether a job dirtied the workdir.
 * @typedef {object} RecordedState
 * @property {string} sha
 * @property {string[]} files
 * @property {Record<string, string>} blobs
 * @property {Record<string, string>} modes
 *
 * One changed path on the compare wire, as the platform reports it.
 * @typedef {object} DeltaChange
 * @property {string} path
 * @property {'added'|'modified'|'removed'|'renamed'|'typechange'} status
 * @property {string|null} oldHash
 * @property {string|null} newHash
 * @property {string|null} oldMode
 * @property {string|null} newMode
 * @property {string} [oldPath]
 *
 * The fetched difference between the recorded commit and the new head, with
 * a lazy byte reader for every path the new tree holds.
 * @typedef {object} DeltaManifest
 * @property {string} sha
 * @property {'snapshot'|'clone'|'delta'} source
 * @property {DeltaChange[]} changes
 * @property {(path: string) => Promise<Uint8Array>} read
 *
 * @typedef {{ source: import('./checkout.js').CheckoutResult['source'] | 'delta', sha: string, bytes?: number, files?: number, reason?: string, workdir: 'warm' | 'fresh' }} Materialized
 */

/**
 * @param {string} workRoot
 * @param {string} repo
 * @param {number} index
 */
export function slotPaths(workRoot, repo, index) {
  const { owner, name } = parseRepoPath(repo);
  const dir = join(workRoot, owner, name, `slot-${index}`);
  return { dir, lock: `${dir}.lock`, work: join(dir, 'work'), staging: join(dir, 'staging'), state: join(dir, 'state.json') };
}

/** @param {unknown} err */
const errCode = (err) => (err && typeof err === 'object' && 'code' in err ? err.code : undefined);

/** @param {string} path */
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/** @param {string} path */
function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (errCode(err) === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Creates `path` with `body` only if it does not exist. The content is
 * written first and hard-linked into place, so a reader never sees an empty
 * lock left by a crash between create and write.
 * @param {string} path
 * @param {string} body
 */
function createExclusive(path, body) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, body);
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Unreadable or foreign-host locks count as held: only a lock whose owner is
 * provably gone from this machine is ever reclaimed.
 * @param {string} content
 */
function ownerAlive(content) {
  let owner;
  try {
    owner = JSON.parse(content);
  } catch {
    return true;
  }
  if (!owner || owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return errCode(err) !== 'ESRCH';
  }
}

/**
 * @param {string} lock
 * @param {string} body
 */
function tryLock(lock, body) {
  if (createExclusive(lock, body)) return true;
  const current = readOrNull(lock);
  if (current === null) return createExclusive(lock, body);
  if (ownerAlive(current)) return false;
  // Reclaiming happens under a second exclusive file: without it, two
  // reclaimers that both read the dead owner could each delete the lock the
  // other just created.
  const steal = `${lock}.steal`;
  if (!createExclusive(steal, body)) return false;
  try {
    const again = readOrNull(lock);
    if (again !== null) {
      if (again !== current) return false;
      unlinkSync(lock);
    }
    return createExclusive(lock, body);
  } finally {
    rmSync(steal, { force: true });
  }
}

/** @param {string} dir */
function removeTrash(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry.includes('.trash-')) rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Locks a persistent slot for this process, or falls back to a per-process
 * temporary directory when every slot is busy or the root is unusable.
 * @param {{ workRoot: string, repo: string, tempRoot: string, stderr: (line: string) => void }} o
 * @returns {Slot}
 */
export function openWorkdir(o) {
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, host: hostname(), token });
  try {
    for (let index = 0; index < MAX_SLOTS; index++) {
      const paths = slotPaths(o.workRoot, o.repo, index);
      mkdirSync(dirname(paths.dir), { recursive: true });
      if (!tryLock(paths.lock, body)) continue;
      const release = () => {
        process.off('exit', release);
        const content = readOrNull(paths.lock);
        try {
          if (content !== null && JSON.parse(content).token === token) unlinkSync(paths.lock);
        } catch {}
      };
      process.on('exit', release);
      try {
        mkdirSync(paths.dir, { recursive: true });
        removeTrash(paths.dir);
      } catch (err) {
        release();
        throw err;
      }
      return { ...paths, persistent: true, release };
    }
    o.stderr(`workdir: all ${MAX_SLOTS} slots for ${o.repo} are in use; using a temporary directory`);
  } catch (err) {
    if (err instanceof CliError) throw err;
    o.stderr(`workdir: ${o.workRoot} is unusable (${err instanceof Error ? err.message : String(err)}); using a temporary directory`);
  }
  const dir = mkdtempSync(join(o.tempRoot, 'kvarm-ci-'));
  return {
    dir,
    work: join(dir, 'work'),
    staging: join(dir, 'staging'),
    state: join(dir, 'state.json'),
    persistent: false,
    release: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Moves `path` aside before deleting it, so a partly undeletable tree never
 * blocks the fresh checkout that follows; leftovers are retried on the next
 * slot open.
 * @param {string} path
 */
function discard(path) {
  const trash = `${path}.trash-${randomUUID()}`;
  try {
    renameSync(path, trash);
  } catch (err) {
    if (errCode(err) === 'ENOENT') return;
    throw err;
  }
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {}
}

/**
 * Relative `/`-separated paths of every non-directory entry below `dir`.
 * @param {string} dir
 * @returns {string[]}
 */
export function listTree(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const entry of readdirSync(rel ? join(dir, ...rel.split('/')) : dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk('');
  return out;
}

/** @param {unknown} path */
function assertSafePath(path) {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || path.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`state lists an unsafe path: ${JSON.stringify(path)}`);
  }
}

/**
 * @param {string} text
 * @returns {RecordedState}
 */
function parseState(text) {
  const state = JSON.parse(text);
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.files) || typeof state.sha !== 'string' || !/^[0-9a-f]{40}$/.test(state.sha)) {
    throw new Error(`state file is not a version ${STATE_VERSION} manifest`);
  }
  state.files.forEach(assertSafePath);
  if (!state.blobs || !state.modes || typeof state.blobs !== 'object' || typeof state.modes !== 'object') {
    throw new Error(`state file is not a version ${STATE_VERSION} manifest`);
  }
  for (const path of state.files) {
    if (typeof state.blobs[path] !== 'string' || typeof state.modes[path] !== 'string') {
      throw new Error(`state file is missing the recorded entry for ${JSON.stringify(path)}`);
    }
  }
  return { sha: state.sha, files: state.files, blobs: state.blobs, modes: state.modes };
}

/**
 * @param {string} path
 * @param {string} sha
 * @param {string[]} files
 * @param {Record<string, string>} blobs
 * @param {Record<string, string>} modes
 */
function writeState(path, sha, files, blobs, modes) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, sha, files, blobs, modes }));
  renameSync(tmp, path);
}

/** Git blob hash of `bytes`, the identity the compare wire agrees on. @param {Uint8Array} bytes */
function blobHash(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/**
 * Recorded modes are the classes a checkout materializes: `100644`,
 * `100755` and `120000` (symlink); other git file modes collapse the same
 * way a snapshot tarball does.
 * @param {string} mode
 */
function normalizedMode(mode) {
  if (mode === '120000') return '120000';
  return mode === '100755' ? '100755' : '100644';
}

/** @param {string|null} mode */
const isGitlink = (mode) => mode === '160000';

/**
 * Whether every ancestor of `parts` below `root` is a real directory (never a
 * symlink), so acting on the leaf cannot reach outside the workdir.
 * @param {string} root
 * @param {string[]} parts
 */
function realParents(root, parts) {
  let dir = root;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const st = lstatOrNull(dir);
    if (!st || !st.isDirectory()) return false;
  }
  return true;
}

/**
 * @param {string} work
 * @param {string} rel
 * @param {Set<string>} keep tracked file paths of the new tree
 * @param {Set<string>} dirs ancestor directories of the new tree
 */
function prune(work, rel, keep, dirs) {
  for (const entry of readdirSync(rel ? join(work, ...rel.split('/')) : work, { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (CACHE_DIRS.has(entry.name)) continue;
    const full = join(work, ...path.split('/'));
    if (entry.isDirectory()) {
      if (dirs.has(path)) prune(work, path, keep, dirs);
      else pruneUntracked(full);
    } else if (!keep.has(path)) {
      unlinkSync(full);
    }
  }
}

/**
 * Empties an untracked directory except for dependency caches nested at any
 * depth below it, and removes it when nothing was kept. Directory entries
 * come from `readdir` file types (lstat semantics), so a symlink is unlinked
 * and never followed.
 * @param {string} dir
 * @returns {boolean} whether a cache was kept below `dir`
 */
function pruneUntracked(dir) {
  let kept = false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (CACHE_DIRS.has(entry.name)) kept = true;
    else if (entry.isDirectory()) kept = pruneUntracked(full) || kept;
    else unlinkSync(full);
  }
  if (!kept) rmdirSync(dir);
  return kept;
}

/**
 * Creates every parent directory of `parts` below `work`, refusing
 * non-directories: a file or symlink in the way is removed first, so an
 * entry is never written through a link out of the workdir.
 * @param {string} work
 * @param {string[]} parts
 */
function prepareParents(work, parts) {
  /** @type {Set<string>} */
  const ready = new Set();
  let dir = work;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = join(dir, /** @type {string} */ (parts[i]));
    const rel = parts.slice(0, i + 1).join('/');
    if (ready.has(rel)) continue;
    const st = lstatOrNull(dir);
    if (st && !st.isDirectory()) unlinkSync(dir);
    if (!st || !st.isDirectory()) mkdirSync(dir);
    ready.add(rel);
  }
}

/**
 * Records the exact tree `work` holds after a checkout, so the next warm
 * sync can prove file-for-file whether a job dirtied it.
 * @param {string} work
 * @param {string[]} files
 */
function scanTree(work, files) {
  /** @type {Record<string, string>} */
  const blobs = {};
  /** @type {Record<string, string>} */
  const modes = {};
  for (const path of files) {
    const full = join(work, ...path.split('/'));
    const st = lstatOrNull(full);
    if (st === null) throw new Error(`recorded file vanished: ${path}`);
    if (st.isSymbolicLink()) {
      blobs[path] = blobHash(Buffer.from(readlinkSync(full), 'utf8'));
      modes[path] = '120000';
    } else if (st.isFile()) {
      blobs[path] = blobHash(readFileSync(full));
      modes[path] = st.mode & 0o111 ? '100755' : '100644';
    } else {
      throw new Error(`recorded path is not a file or symlink: ${path}`);
    }
  }
  return { blobs, modes };
}

/**
 * The entry `work` holds at `path` right now, or null when it is missing.
 * @param {string} work
 * @param {string} path
 * @returns {{ kind: 'file'|'symlink'|'other', hash?: string, executable?: boolean } | null}
 */
function inspectLocal(work, path) {
  const st = lstatOrNull(join(work, ...path.split('/')));
  if (st === null) return null;
  if (st.isSymbolicLink()) return { kind: 'symlink', hash: blobHash(Buffer.from(readlinkSync(join(work, ...path.split('/'))), 'utf8')) };
  if (!st.isFile()) return { kind: 'other' };
  return { kind: 'file', hash: blobHash(readFileSync(join(work, ...path.split('/')))), executable: (st.mode & 0o111) !== 0 };
}

/**
 * Makes `work` hold exactly `entry`: bytes are fetched through `read` only
 * when they differ, and a drifted mode is fixed in place, restoring content,
 * type and executable bit a job may have dirtied.
 * @param {string} work
 * @param {string} path
 * @param {{ hash: string, mode: string }} entry
 * @param {(path: string) => Promise<Uint8Array>} read
 */
async function materializeEntry(work, path, entry, read) {
  const parts = path.split('/');
  // Parents are repaired before the leaf is inspected, chmodded or removed:
  // through a symlinked parent those calls would act outside the workdir.
  prepareParents(work, parts);
  const local = inspectLocal(work, path);
  const wantSymlink = entry.mode === '120000';
  const sameKind = local !== null && local.kind === (wantSymlink ? 'symlink' : 'file');
  const sameBytes = sameKind && local !== null && local.hash === entry.hash;
  if (wantSymlink ? sameBytes : sameBytes && (entry.mode === '100755') === Boolean(local?.executable)) return;
  const dest = join(work, ...parts);
  if (sameBytes) {
    chmodSync(dest, entry.mode === '100755' ? 0o755 : 0o644);
    return;
  }
  const bytes = await read(path);
  const got = blobHash(bytes);
  if (got !== entry.hash) throw new Error(`delta content for ${JSON.stringify(path)} hashed ${got}, expected ${entry.hash}`);
  if (local !== null) rmSync(dest, { recursive: true, force: true });
  if (wantSymlink) symlinkSync(new TextDecoder().decode(bytes), dest);
  else {
    writeFileSync(dest, bytes);
    chmodSync(dest, entry.mode === '100755' ? 0o755 : 0o644);
  }
}

/**
 * Applies the fetched `manifest` to the work directory and returns the exact
 * tracked tree the new commit holds. The recorded hashes prove which files
 * a previous job dirtied; those are restored even when the delta does not
 * mention them, so the result stays byte-equal to a fresh snapshot checkout.
 * @param {string} work
 * @param {RecordedState} previous
 * @param {DeltaManifest} manifest
 * @returns {Promise<{ files: string[], blobs: Record<string, string>, modes: Record<string, string> }>}
 */
async function applyDelta(work, previous, manifest) {
  /** @type {Map<string, { hash: string, mode: string }>} */
  const keep = new Map();
  for (const path of previous.files) keep.set(path, { hash: /** @type {string} */ (previous.blobs[path]), mode: /** @type {string} */ (previous.modes[path]) });
  /** @type {Set<string>} */
  const remove = new Set();
  /** @type {Map<string, { hash: string, mode: string }>} */
  const writes = new Map();

  for (const c of manifest.changes) {
    assertSafePath(c.path);
    if (c.oldPath !== undefined) assertSafePath(c.oldPath);
    if (isTreeMode(c.oldMode) || isTreeMode(c.newMode)) throw new Error(`delta change for ${JSON.stringify(c.path)} still carries a tree side`);
    // A gitlink (submodule) never appears in a snapshot checkout: the new
    // side is not materialized and the old side never existed on disk.
    const oldBlob = c.oldHash !== null && !isGitlink(c.oldMode);
    const newBlob = c.newHash !== null && !isGitlink(c.newMode);
    if (c.oldPath !== undefined) {
      const recorded = keep.get(c.oldPath);
      if (recorded !== undefined && oldBlob && recorded.hash !== c.oldHash) throw new Error(`recorded ${JSON.stringify(c.oldPath)} does not match the delta base tree`);
      keep.delete(c.oldPath);
      if (oldBlob) remove.add(c.oldPath);
    } else if (oldBlob && keep.get(c.path)?.hash !== c.oldHash) {
      throw new Error(`recorded ${JSON.stringify(c.path)} does not match the delta base tree`);
    }
    if (newBlob) {
      const entry = { hash: /** @type {string} */ (c.newHash), mode: normalizedMode(/** @type {string} */ (c.newMode)) };
      keep.set(c.path, entry);
      writes.set(c.path, entry);
    } else if (c.oldPath === undefined) {
      keep.delete(c.path);
      if (oldBlob) remove.add(c.path);
    }
  }
  // A clone fallback checked out `.git`; a snapshot tree never has it.
  for (const path of previous.files) {
    if (path === '.git' || path.startsWith('.git/')) {
      keep.delete(path);
      remove.add(path);
    }
  }

  // Ancestor directories of the new tree decide which empty directories may go.
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const path of keep.keys()) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  for (const path of remove) {
    if (keep.has(path)) continue;
    const parts = path.split('/');
    if (!realParents(work, parts)) continue;
    rmSync(join(work, ...parts), { recursive: true, force: true });
    for (let i = parts.length - 1; i > 0; i--) {
      if (dirs.has(parts.slice(0, i).join('/'))) break;
      try {
        rmdirSync(join(work, ...parts.slice(0, i)));
      } catch {
        break;
      }
    }
  }
  prune(work, '', new Set(keep.keys()), dirs);
  for (const [path, entry] of keep) {
    if (!writes.has(path)) await materializeEntry(work, path, entry, manifest.read);
  }
  for (const [path, entry] of writes) {
    await materializeEntry(work, path, entry, manifest.read);
  }

  /** @type {Record<string, string>} */
  const blobs = {};
  /** @type {Record<string, string>} */
  const modes = {};
  const files = [...keep.keys()].sort();
  for (const path of files) {
    const entry = /** @type {{ hash: string, mode: string }} */ (keep.get(path));
    blobs[path] = entry.hash;
    modes[path] = entry.mode;
  }
  return { files, blobs, modes };
}

/**
 * The warm delta sync, or null when the slot has no recorded tree. Reading
 * the state is part of the warm path, so an unreadable state throws into the
 * caller's full-checkout fallback like any other warm failure.
 * @param {Slot} slot
 * @param {{ sha: string, delta: (previous: RecordedState, sha: string) => Promise<DeltaManifest> }} o
 * @returns {Promise<Materialized | null>}
 */
async function syncWarm(slot, o) {
  const recorded = readOrNull(slot.state);
  if (recorded === null) return null;
  const previous = parseState(recorded);
  rmSync(slot.state, { force: true });
  if (!lstatOrNull(slot.work)?.isDirectory()) throw new Error('workdir is missing');
  discard(slot.staging);
  const manifest = await o.delta(previous, o.sha);
  if (manifest.sha !== o.sha) throw new Error(`delta was computed for ${manifest.sha}, expected ${o.sha}`);
  const tree = await applyDelta(slot.work, previous, manifest);
  writeState(slot.state, o.sha, tree.files, tree.blobs, tree.modes);
  return { source: manifest.source, sha: o.sha, files: tree.files.length, workdir: 'warm' };
}

/**
 * Materializes `sha` in the slot's work directory: a warm delta sync when
 * the slot holds a recorded previous tree, otherwise (or with `fresh`, or
 * after any warm failure) a full checkout into an emptied directory.
 * @param {Slot} slot
 * @param {{ sha: string, fresh?: boolean, checkout: (dir: string) => Promise<import('./checkout.js').CheckoutResult>, delta: (previous: RecordedState, sha: string) => Promise<DeltaManifest>, stderr: (line: string) => void }} o
 * @returns {Promise<Materialized>}
 */
export async function materialize(slot, o) {
  if (!o.fresh) {
    try {
      const warm = await syncWarm(slot, o);
      if (warm !== null) return warm;
    } catch (err) {
      o.stderr(`warm sync failed: ${err instanceof Error ? err.message : String(err)}; falling back to a full snapshot checkout`);
    } finally {
      try {
        discard(slot.staging);
      } catch {}
    }
  }
  // Recursive, so a state path that became a directory is cleared too; rm
  // never follows a symlink.
  rmSync(slot.state, { recursive: true, force: true });
  discard(slot.work);
  discard(slot.staging);
  const got = await o.checkout(slot.work);
  if (got.sha !== o.sha) throw new Error(`checkout returned ${got.sha}, expected ${o.sha}`);
  const files = listTree(slot.work);
  const { blobs, modes } = scanTree(slot.work, files);
  writeState(slot.state, got.sha, files, blobs, modes);
  return { ...got, workdir: 'fresh' };
}
