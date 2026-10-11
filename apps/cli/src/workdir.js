// @ts-check
/**
 * Persistent per-repository working directories for `forge runner`.
 *
 * Layout: `<workRoot>/<owner>/<repo>/slot-<n>/{work,staging,state.json}` with
 * the slot's lock beside it (`slot-<n>.lock`). One runner process owns a slot
 * for its whole lifetime; a concurrent runner for the same repository takes
 * the next free slot, so a workdir is never shared.
 *
 * The first job in a slot is a full snapshot checkout. A later job checks the
 * new head out into `staging` and syncs it into `work`: every tracked file of
 * the new tree is moved in, files of the previous tree that the new tree
 * lacks are deleted, and any other untracked path is removed unless it lies
 * inside a dependency-cache directory (`CACHE_DIRS`), which is kept so
 * installs do not repeat. Any failure on that path falls back to a full
 * checkout into an emptied `work`.
 */

import { randomUUID } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { CliError, parseRepo } from './checkout.js';

/** Untracked directories (matched by name at any depth) that survive a warm sync. */
export const CACHE_DIRS = new Set(['node_modules', '.venv', 'venv', 'target', '.cache', '.gradle', '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache', '.tox']);
const MAX_SLOTS = 16;
const STATE_VERSION = 1;

/**
 * @typedef {object} Slot
 * @property {string} dir
 * @property {string} work
 * @property {string} staging
 * @property {string} state
 * @property {boolean} persistent
 * @property {() => void} release
 *
 * @typedef {import('./checkout.js').CheckoutResult & { workdir: 'warm' | 'fresh' }} Materialized
 * @typedef {(staging: string, work: string, previousFiles: string[]) => string[]} SyncFn
 */

/**
 * @param {string} workRoot
 * @param {string} repo
 * @param {number} index
 */
export function slotPaths(workRoot, repo, index) {
  const { owner, name } = parseRepo(repo);
  if (name === '.' || name === '..') throw new CliError(`invalid repository "${repo}", expected <owner>/<repo>`, 2);
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
  const dir = mkdtempSync(join(o.tempRoot, 'forge-ci-'));
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

/** @param {string} text */
function parseState(text) {
  const state = JSON.parse(text);
  if (!state || state.version !== STATE_VERSION || !Array.isArray(state.files)) throw new Error('state file is not a version 1 manifest');
  state.files.forEach(assertSafePath);
  return /** @type {{ files: string[] }} */ (state);
}

/**
 * @param {string} path
 * @param {string} sha
 * @param {string[]} files
 */
function writeState(path, sha, files) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, sha, files }));
  renameSync(tmp, path);
}

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
      else rmSync(full, { recursive: true, force: true });
    } else if (!keep.has(path)) {
      unlinkSync(full);
    }
  }
}

/**
 * Makes `work` hold exactly the tree checked out in `staging`, apart from
 * untracked paths inside cache directories. Consumes `staging`.
 * @type {SyncFn}
 */
export function syncWorkdir(staging, work, previousFiles) {
  const next = listTree(staging);
  const keep = new Set(next);
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const path of next) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  // Files the previous tree tracked are removed even inside cache directories.
  for (const path of previousFiles) {
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
  prune(work, '', keep, dirs);
  const ready = new Set();
  for (const path of next) {
    const parts = path.split('/');
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
    const dest = join(work, ...parts);
    if (lstatOrNull(dest)?.isDirectory()) rmSync(dest, { recursive: true, force: true });
    renameSync(join(staging, ...parts), dest);
  }
  return next;
}

/**
 * Materializes `sha` in the slot's work directory: a warm sync when the slot
 * holds a recorded previous tree, otherwise (or with `fresh`, or after any
 * warm failure) a full checkout into an emptied directory.
 * @param {Slot} slot
 * @param {{ sha: string, fresh?: boolean, checkout: (dir: string) => Promise<import('./checkout.js').CheckoutResult>, sync?: SyncFn, stderr: (line: string) => void }} o
 * @returns {Promise<Materialized>}
 */
export async function materialize(slot, o) {
  const recorded = o.fresh ? null : readOrNull(slot.state);
  if (recorded !== null) {
    try {
      const previous = parseState(recorded);
      rmSync(slot.state, { force: true });
      if (!lstatOrNull(slot.work)?.isDirectory()) throw new Error('workdir is missing');
      discard(slot.staging);
      const got = await o.checkout(slot.staging);
      if (got.sha !== o.sha) throw new Error(`checkout returned ${got.sha}, expected ${o.sha}`);
      const files = (o.sync ?? syncWorkdir)(slot.staging, slot.work, previous.files);
      writeState(slot.state, got.sha, files);
      return { ...got, workdir: 'warm' };
    } catch (err) {
      o.stderr(`warm sync failed: ${err instanceof Error ? err.message : String(err)}; falling back to a full snapshot checkout`);
    } finally {
      try {
        discard(slot.staging);
      } catch {}
    }
  }
  rmSync(slot.state, { force: true });
  discard(slot.work);
  discard(slot.staging);
  const got = await o.checkout(slot.work);
  if (got.sha !== o.sha) throw new Error(`checkout returned ${got.sha}, expected ${o.sha}`);
  writeState(slot.state, got.sha, listTree(slot.work));
  return { ...got, workdir: 'fresh' };
}
