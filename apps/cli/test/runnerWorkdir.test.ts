import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { diffTrees } from '@kvarm/gitops';
import { checkout } from '../src/checkout.js';
import type { HttpFetch } from '../src/http.js';
import { runRunner } from '../src/runner.js';
import { slotPaths } from '../src/workdir.js';
import { git, tarFromCommit, tempDir } from './helpers';

const root = tempDir('kvarm-cli-warm-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Three commits: c1→c2 covers every sync case, c2→c3 leaves most files unchanged. */
function makeHistory() {
  const work = join(root, 'src-repo');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const put = (path: string, content: string | Buffer, mode?: number) => {
    mkdirSync(join(work, path, '..'), { recursive: true });
    writeFileSync(join(work, path), content);
    if (mode !== undefined) chmodSync(join(work, path), mode);
  };
  put('README.md', 'v1\n');
  put('modify.txt', 'before\n');
  put('delete-me.txt', 'stale\n');
  put('gone/deep/file.txt', 'whole directory removed\n');
  put('bin/run.sh', '#!/bin/sh\necho run\n', 0o644);
  put('swap', 'a file that becomes a directory\n');
  put('blob.bin', Buffer.from([0, 255, 10, 0, 77, 3]));
  put('vendor/node_modules/tracked-dep/index.js', 'tracked inside a cache-named directory\n');
  symlinkSync('README.md', join(work, 'link'));
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'one']);
  const c1 = git(work, ['rev-parse', 'HEAD']);

  put('README.md', 'v2\n');
  put('modify.txt', 'after — exact bytes ✓\n');
  rmSync(join(work, 'delete-me.txt'));
  rmSync(join(work, 'gone'), { recursive: true });
  chmodSync(join(work, 'bin/run.sh'), 0o755);
  rmSync(join(work, 'swap'));
  put('swap/inner.txt', 'now a directory\n');
  put('blob.bin', Buffer.from([1, 2, 3, 0, 254, 5, 6]));
  rmSync(join(work, 'vendor'), { recursive: true });
  put('new/added.txt', 'brand new\n');
  put('node_modules/linked/file.txt', 'tracked file under an untracked cache symlink\n');
  rmSync(join(work, 'link'));
  symlinkSync('modify.txt', join(work, 'link'));
  git(work, ['add', '-A', '-f']);
  git(work, ['commit', '-q', '-m', 'two']);
  const c2 = git(work, ['rev-parse', 'HEAD']);

  put('new/added.txt', 'changed again\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'three']);
  const c3 = git(work, ['rev-parse', 'HEAD']);
  return {
    work,
    c1,
    c2,
    c3,
    tars: { [c1]: tarFromCommit(work, c1), [c2]: tarFromCommit(work, c2), [c3]: tarFromCommit(work, c3) } as Record<string, Uint8Array>,
  };
}

const history = makeHistory();
const BASE = 'https://kvarm.test';
const API = `${BASE}/api/v1/repos/cynthia/demo`;
const SNAP = `${API}/snapshots/`;

/** Full-tarball downloads served by the fake snapshot service (the counting fake). */
const snapshotDownloads = { count: 0 };

const snapshotFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const rest = url.slice(SNAP.length);
  const sha = rest.replace(/\/download$/, '');
  const tar = history.tars[sha];
  if (!url.startsWith(SNAP) || !tar) return Response.json({ error: 'not found' }, { status: 404 });
  if (rest.endsWith('/download')) {
    snapshotDownloads.count++;
    return new Response(new Uint8Array(tar), { headers: { 'x-kvarm-snapshot-sha': sha } });
  }
  return Response.json({ sha, state: 'ready', size: tar.length });
}) as unknown as HttpFetch;

const checkoutCalls: string[] = [];
const realCheckout = (o: any) => {
  checkoutCalls.push(o.dir);
  return checkout({ ...o, fetch: snapshotFetch, cloneUrl: `file://${history.work}` });
};

/** A fresh snapshot checkout of `sha`, the ground truth for the warm workdir. */
async function freshCheckout(sha: string): Promise<string> {
  const dir = tempDir('kvarm-cli-warm-fresh-');
  await checkout({ baseUrl: BASE, pat: 'p', repo: 'cynthia/demo', ref: sha, dir, fetch: snapshotFetch, stdout: () => {}, stderr: () => {} });
  return dir;
}

/** Every entry below `dir` with its type, executable bit and exact bytes. */
function treeState(dir: string, ignore: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel ? `${rel}/${name}` : name;
      if (ignore.some((p) => path === p || path.startsWith(`${p}/`))) continue;
      const st = lstatSync(join(dir, path));
      if (st.isSymbolicLink()) out[path] = `link:${readlinkSync(join(dir, path))}`;
      else if (st.isDirectory()) {
        out[path] = 'dir';
        walk(path);
      } else out[path] = `file:${st.mode & 0o111 ? 'x' : '-'}:${createHash('sha256').update(readFileSync(join(dir, path))).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

// --- the fake platform: snapshots plus the compare/tree/contents REST endpoints ---

/**
 * `git ls-tree` entries of one tree, or null when `path` is missing or not a
 * directory (the tree API's `PATH_NOT_FOUND` cases).
 */
const lsTree = (ref: string, path: string) => {
  const out = spawnSync('git', path ? ['ls-tree', `${ref}:${path}`] : ['ls-tree', ref], { cwd: history.work, encoding: 'utf8' });
  if (out.status !== 0) return null;
  const text = out.stdout.trim();
  return text
    ? text.split('\n').map((line) => {
        const [meta, name] = line.split('\t') as [string, string];
        const [mode, type, hash] = meta.split(' ') as [string, string, string];
        return { name, mode, hash, type };
      })
    : [];
};

/** The changed paths the real compare API serves: the wire shape of diffTrees. */
const compareAt = async (base: string, head: string) => {
  const treeOf = (ref: string) => git(history.work, ['rev-parse', `${ref}^{tree}`]);
  const diff = await diffTrees({ readTree: async (hash: string) => lsTree(hash, '') ?? [] }, treeOf(base), treeOf(head), {
    maxTreeReads: 2_000,
    maxChanges: 20_000,
    concurrency: 64,
  });
  return diff.changes.map((c) => ({
    path: c.path,
    status: c.status,
    ...(c.oldPath !== undefined ? { oldPath: c.oldPath } : {}),
    oldHash: c.oldHash,
    newHash: c.newHash,
    oldMode: c.oldMode,
    newMode: c.newMode,
  }));
};

/** File bytes at `ref` encoded exactly like the platform's contents endpoint. */
function contentsAt(ref: string, path: string) {
  const out = spawnSync('git', ['cat-file', 'blob', `${ref}:${path}`], { cwd: history.work, encoding: 'buffer', maxBuffer: 64 << 20 });
  if (out.status !== 0) return { status: 404 as const };
  const bytes = out.stdout;
  if (!bytes.subarray(0, 8000).includes(0)) {
    try {
      return {
        body: {
          ref,
          path,
          size: bytes.length,
          encoding: 'utf-8' as const,
          content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
        },
      };
    } catch {
      // not valid UTF-8
    }
  }
  return { body: { ref, path, size: bytes.length, encoding: 'base64' as const, content: bytes.toString('base64') } };
}

type Job = { id: string; name: string; command: string; sha: string; generation: number; timeoutSeconds: number };
const job = (id: string, sha: string): Job => ({ id, name: 'build', command: 'build', sha, generation: 1, timeoutSeconds: 30 });

function fakePlatform(jobs: Job[], opts: { failCompare?: number; truncateCompare?: boolean; stopWhenEmpty?: boolean } = {}) {
  const reports: any[] = [];
  /** GETs the runner made against compare/tree/contents, in order. */
  const restGets: string[] = [];
  let failCompare = opts.failCompare ?? 0;
  const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/claim')) {
      const next = jobs.shift();
      if (next) return Response.json({ job: next });
      return opts.stopWhenEmpty ? Response.json({ error: 'runner stopped' }, { status: 500 }) : new Response(null, { status: 204 });
    }
    if (path.endsWith('/report')) {
      reports.push({ path, ...body });
      return Response.json({ run: { status: body.conclusion } });
    }
    if (path.startsWith(`/api/v1/repos/cynthia/demo/compare/`)) {
      restGets.push('compare');
      if (failCompare-- > 0) return Response.json({ error: 'unavailable' }, { status: 503 });
      if (opts.truncateCompare) return Response.json({ files: [], truncated: true, truncatedReason: 'changed file budget exhausted (20000 files)' });
      const [base, head] = path.slice(`/api/v1/repos/cynthia/demo/compare/`.length).split('...') as [string, string];
      return Response.json({ files: await compareAt(base, head), truncated: false });
    }
    if (path === '/api/v1/repos/cynthia/demo/tree') {
      const ref = url.searchParams.get('ref') ?? '';
      const treePath = url.searchParams.get('path') ?? '';
      restGets.push(`tree ${ref} ${treePath}`);
      const entries = lsTree(ref, treePath);
      if (entries === null) return Response.json({ error: 'no directory', code: 'PATH_NOT_FOUND' }, { status: 404 });
      return Response.json({
        ref,
        sha: ref,
        path: treePath,
        entries: entries.map((e) => ({
          name: e.name,
          path: treePath ? `${treePath}/${e.name}` : e.name,
          type: e.mode === '40000' || e.mode === '040000' ? 'tree' : e.mode === '160000' ? 'commit' : 'blob',
          mode: e.mode.padStart(6, '0'),
          hash: e.hash,
        })),
      });
    }
    if (path === '/api/v1/repos/cynthia/demo/contents') {
      const filePath = url.searchParams.get('path') ?? '';
      const ref = url.searchParams.get('ref') ?? '';
      restGets.push(`contents ${filePath}`);
      const got = contentsAt(ref, filePath);
      return 'body' in got ? Response.json(got.body) : Response.json({ error: 'no file', code: 'FILE_NOT_FOUND' }, { status: 404 });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  };
  return { apiFetch, reports, restGets };
}

type Execute = (command: string, cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>;
const ok = { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 };

async function runOnce(
  workRoot: string,
  jobs: Job[],
  execute: Execute,
  extra: Record<string, unknown> = {},
  platform: { failCompare?: number; truncateCompare?: boolean } = {},
) {
  const api = fakePlatform(jobs, platform);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runRunner({
    baseUrl: BASE,
    pat: 'p',
    repo: 'cynthia/demo',
    once: true,
    apiFetch: api.apiFetch,
    checkoutFn: realCheckout as any,
    execute,
    stdout: (l) => stdout.push(l),
    stderr: (l) => stderr.push(l),
    tempRoot: root,
    workRoot,
    ...extra,
  });
  return { result, reports: api.reports, restGets: api.restGets, stdout, stderr };
}

/** Job 1: installs caches, leaves build output and dirties the tracked tree. */
function dirtyFirstJob(outside: string, seen: string[]): Execute {
  return async (_command, cwd) => {
    seen.push(cwd);
    mkdirSync(join(cwd, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'dep', 'index.js'), 'installed\n');
    mkdirSync(join(cwd, '.venv', 'bin'), { recursive: true });
    writeFileSync(join(cwd, '.venv', 'bin', 'python'), 'venv\n');
    mkdirSync(join(cwd, 'target', 'debug'), { recursive: true });
    writeFileSync(join(cwd, 'target', 'debug', 'out'), 'cargo\n');
    symlinkSync(outside, join(cwd, 'node_modules', 'linked'));
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'bundle.js'), 'stale build output\n');
    writeFileSync(join(cwd, 'stray.log'), 'stray\n');
    writeFileSync(join(cwd, 'README.md'), 'dirtied by the job\n');
    rmSync(join(cwd, 'modify.txt'));
    return ok;
  };
}

/** Dirties tracked files that c2→c3 does not touch: mode, deletion, type and content. */
function dirtyUnchangedJob(seen: string[]): Execute {
  return async (_command, cwd) => {
    seen.push(cwd);
    chmodSync(join(cwd, 'README.md'), 0o755);
    rmSync(join(cwd, 'bin', 'run.sh'));
    // A plain write would follow the link, so replace it to dirty the type too.
    rmSync(join(cwd, 'link'));
    writeFileSync(join(cwd, 'link'), 'not a link\n');
    writeFileSync(join(cwd, 'modify.txt'), 'dirtied unchanged\n');
    mkdirSync(join(cwd, 'node_modules', 'dep2'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'dep2', 'index.js'), 'cache\n');
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist', 'out.js'), 'stale build output\n');
    writeFileSync(join(cwd, 'stray.log'), 'stray\n');
    return ok;
  };
}

describe('kvarm runner warm workdir', () => {
  it('syncs a second job byte-equal to a fresh snapshot checkout with no full-tarball download, while untracked caches survive', async () => {
    const workRoot = join(root, 'warm');
    const outside = join(root, 'outside-warm');
    mkdirSync(outside);
    const seen: string[] = [];
    const coldDownloads = snapshotDownloads.count;
    const coldCheckouts = checkoutCalls.length;
    const first = await runOnce(workRoot, [job('j1', history.c1)], dirtyFirstJob(outside, seen));
    expect(first.reports.map((r) => r.conclusion)).toEqual(['success']);
    expect(first.stdout).toContain('workdir: fresh');
    expect(snapshotDownloads.count).toBe(coldDownloads + 1);

    const fresh2 = await freshCheckout(history.c2);
    const warmDownloads = snapshotDownloads.count;
    let observed: Record<string, string> = {};
    const second = await runOnce(workRoot, [job('j2', history.c2)], async (_command, cwd) => {
      seen.push(cwd);
      observed = treeState(cwd, ['node_modules/dep', '.venv', 'target']);
      return ok;
    });
    expect(second.result).toEqual({ claimed: 1, reported: 1 });
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2, source: 'delta' } });
    expect(second.stdout).toContain('workdir: warm');
    expect(second.stderr.filter((l) => !l.startsWith('checkout: note:'))).toEqual([]);
    expect(seen[1]).toBe(seen[0]);
    // The warm job transfers only the changed paths: no checkout, no tarball download.
    expect(checkoutCalls).toHaveLength(coldCheckouts + 1);
    expect(snapshotDownloads.count).toBe(warmDownloads);
    expect(second.restGets.filter((g) => g === 'compare')).toHaveLength(1);
    expect(second.restGets.filter((g) => g.startsWith('tree '))).toEqual([`tree ${history.c2} swap`]);
    expect(second.restGets.filter((g) => g.startsWith('contents ')).map((g) => g.slice('contents '.length)).sort()).toEqual(
      ['README.md', 'blob.bin', 'link', 'modify.txt', 'new/added.txt', 'node_modules/linked/file.txt', 'swap/inner.txt'].sort(),
    );
    // Tracked state is byte-equal to a fresh snapshot checkout of the new commit.
    expect(observed).toEqual(treeState(fresh2));
    expect(observed).not.toHaveProperty('delete-me.txt');
    expect(observed).not.toHaveProperty('gone');
    expect(observed).not.toHaveProperty('vendor');
    expect(observed).not.toHaveProperty('dist');
    expect(observed).not.toHaveProperty('stray.log');
    expect(readFileSync(join(seen[1]!, 'modify.txt'), 'utf8')).toBe('after — exact bytes ✓\n');
    expect(readFileSync(join(seen[1]!, 'blob.bin'))).toEqual(Buffer.from([1, 2, 3, 0, 254, 5, 6]));
    expect(readFileSync(join(seen[1]!, 'new', 'added.txt'), 'utf8')).toBe('brand new\n');
    // Untracked dependency caches survive so installs do not repeat.
    expect(readFileSync(join(seen[1]!, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('installed\n');
    expect(readFileSync(join(seen[1]!, '.venv', 'bin', 'python'), 'utf8')).toBe('venv\n');
    expect(readFileSync(join(seen[1]!, 'target', 'debug', 'out'), 'utf8')).toBe('cargo\n');
    expect(lstatSync(join(seen[1]!, 'node_modules', 'linked')).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('restores tracked files the previous job dirtied even when the delta does not touch them, still without a tarball download', async () => {
    const workRoot = join(root, 'dirt');
    const seen: string[] = [];
    const coldDownloads = snapshotDownloads.count;
    await runOnce(workRoot, [job('d1', history.c2)], dirtyUnchangedJob(seen));
    expect(snapshotDownloads.count).toBe(coldDownloads + 1);

    const fresh3 = await freshCheckout(history.c3);
    const warmDownloads = snapshotDownloads.count;
    let observed: Record<string, string> = {};
    const second = await runOnce(workRoot, [job('d2', history.c3)], async (_command, cwd) => {
      observed = treeState(cwd, ['node_modules/dep2']);
      return ok;
    });
    expect(second.result).toEqual({ claimed: 1, reported: 1 });
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c3, source: 'delta' } });
    expect(second.stdout).toContain('workdir: warm');
    expect(snapshotDownloads.count).toBe(warmDownloads);
    expect(second.restGets.filter((g) => g.startsWith('contents ')).map((g) => g.slice('contents '.length)).sort()).toEqual(
      ['bin/run.sh', 'link', 'modify.txt', 'new/added.txt'].sort(),
    );
    expect(observed).toEqual(treeState(fresh3));
    expect(readFileSync(join(slotPaths(workRoot, 'cynthia/demo', 0).work, 'node_modules', 'dep2', 'index.js'), 'utf8')).toBe('cache\n');
    expect(observed).not.toHaveProperty('dist');
    expect(observed).not.toHaveProperty('stray.log');
  });

  it('--fresh rematerializes the whole workdir from the snapshot, skips the delta and drops caches', async () => {
    const workRoot = join(root, 'fresh');
    const outside = join(root, 'outside-fresh');
    mkdirSync(outside);
    const seen: string[] = [];
    await runOnce(workRoot, [job('j1', history.c1)], dirtyFirstJob(outside, seen));
    const before = snapshotDownloads.count;
    let observed: Record<string, string> = {};
    const second = await runOnce(
      workRoot,
      [job('j2', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      { fresh: true },
    );
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2, source: 'snapshot' } });
    expect(second.stdout).toContain('workdir: fresh');
    expect(snapshotDownloads.count).toBe(before + 1);
    expect(second.restGets.filter((g) => g === 'compare')).toEqual([]);
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));
    expect(observed).not.toHaveProperty('node_modules/dep');
    expect(observed).not.toHaveProperty('.venv');
  });

  it('falls back to a full snapshot checkout when the delta sync fails mid-flight and the job still completes', async () => {
    const workRoot = join(root, 'fallback');
    const outside = join(root, 'outside-fallback');
    mkdirSync(outside);
    const seen: string[] = [];
    await runOnce(workRoot, [job('f1', history.c1)], dirtyFirstJob(outside, seen));
    const coldDownloads = snapshotDownloads.count;
    const work = slotPaths(workRoot, 'cynthia/demo', 0).work;
    let observed: Record<string, string> = {};
    const second = await runOnce(
      workRoot,
      [job('f2', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      {
        deltaFn: async () => ({
          sha: history.c2,
          source: 'delta',
          changes: [{ path: 'half-synced.txt', status: 'added', oldHash: null, oldMode: null, newHash: 'a'.repeat(40), newMode: '100644' }],
          read: async (p: string) => {
            writeFileSync(join(work, p), 'partial\n');
            throw new Error('injected delta failure');
          },
        }),
      },
    );
    expect(second.result).toEqual({ claimed: 1, reported: 1 });
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2 } });
    expect(second.stderr.join('\n')).toMatch(/warm sync failed: injected delta failure; falling back to a full snapshot checkout/);
    expect(second.stdout).toContain('workdir: fresh');
    expect(snapshotDownloads.count).toBe(coldDownloads + 1);
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));
    expect(observed).not.toHaveProperty('half-synced.txt');

    // The fallback rewrote the recorded state, so the next job warms again through the delta.
    const before = snapshotDownloads.count;
    let third: Record<string, string> = {};
    const after = await runOnce(workRoot, [job('f3', history.c1)], async (_command, cwd) => {
      third = treeState(cwd);
      return ok;
    });
    expect(after.stdout).toContain('workdir: warm');
    expect(snapshotDownloads.count).toBe(before);
    expect(third).toEqual(treeState(await freshCheckout(history.c1)));
  });

  it('falls back when the compare fetch fails, is truncated, or the recorded state is unusable', async () => {
    const workRoot = join(root, 'fallback-delta');
    await runOnce(workRoot, [job('x1', history.c1)], async () => ok);
    let observed: Record<string, string> = {};

    const unavailable = await runOnce(
      workRoot,
      [job('x2', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      {},
      { failCompare: 1 },
    );
    expect(unavailable.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(unavailable.stderr.join('\n')).toMatch(/warm sync failed: .*unavailable; falling back to a full snapshot checkout/);
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));

    const truncated = await runOnce(
      workRoot,
      [job('x2b', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      {},
      { truncateCompare: true },
    );
    expect(truncated.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(truncated.stderr.join('\n')).toMatch(/warm sync failed: .*truncated.*; falling back to a full snapshot checkout/);
    expect(truncated.stdout).toContain('workdir: fresh');
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));

    const slot = slotPaths(workRoot, 'cynthia/demo', 0);
    writeFileSync(slot.state, JSON.stringify({ version: 1, sha: history.c2, files: ['README.md'] }));
    const legacy = await runOnce(workRoot, [job('x3', history.c1)], async () => ok);
    expect(legacy.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(legacy.stderr.join('\n')).toMatch(/warm sync failed: .*version 2 manifest; falling back to a full snapshot checkout/);

    writeFileSync(
      slot.state,
      JSON.stringify({ version: 2, sha: history.c2, files: ['../escape'], blobs: { '../escape': 'a'.repeat(40) }, modes: { '../escape': '100644' } }),
    );
    const unsafe = await runOnce(workRoot, [job('x4', history.c1)], async (_command, cwd) => {
      observed = treeState(cwd);
      return ok;
    });
    expect(unsafe.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(unsafe.stderr.join('\n')).toMatch(/warm sync failed: .*unsafe path.*; falling back to a full snapshot checkout/);
    expect(observed).toEqual(treeState(await freshCheckout(history.c1)));
  });

  it('drops a clone fallback checkout\u2019s .git on the first warm sync without downloading a tarball', async () => {
    const workRoot = join(root, 'clone-state');
    // The first job materializes through git (the clone fallback), so the
    // recorded tree includes `.git/**`, which a snapshot checkout never has.
    const cloneCheckout = (o: any) => {
      mkdirSync(o.dir, { recursive: true });
      git(history.work, ['clone', '-q', '--no-checkout', `file://${history.work}`, o.dir]);
      git(o.dir, ['checkout', '-q', o.ref]);
      return { source: 'clone' as const, sha: o.ref };
    };
    const first = await runOnce(workRoot, [job('g0', history.c1)], async () => ok, { checkoutFn: cloneCheckout });
    expect(first.stdout).toContain('workdir: fresh');
    expect(existsSync(join(slotPaths(workRoot, 'cynthia/demo', 0).work, '.git'))).toBe(true);

    const coldDownloads = snapshotDownloads.count;
    const checkoutsBefore = checkoutCalls.length;
    let observed: Record<string, string> = {};
    const run = await runOnce(workRoot, [job('g1', history.c2)], async (_command, cwd) => {
      observed = treeState(cwd);
      return ok;
    });
    expect(run.result).toEqual({ claimed: 1, reported: 1 });
    expect(run.stdout).toContain('workdir: warm');
    expect(run.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2, source: 'delta' } });
    expect(snapshotDownloads.count).toBe(coldDownloads);
    expect(checkoutCalls).toHaveLength(checkoutsBefore);
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));
    expect(observed).not.toHaveProperty('.git');
  });

  it('never shares one workdir between concurrent runner processes', async () => {
    const workRoot = join(root, 'concurrent');
    const cwds: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arrived = 0;
    const execute: Execute = async (_command, cwd) => {
      cwds.push(cwd);
      if (++arrived === 2) release();
      await gate;
      return ok;
    };
    await Promise.all([runOnce(workRoot, [job('a', history.c1)], execute), runOnce(workRoot, [job('b', history.c2)], execute)]);
    expect(new Set(cwds).size).toBe(2);
    expect(cwds.sort()).toEqual([slotPaths(workRoot, 'cynthia/demo', 0).work, slotPaths(workRoot, 'cynthia/demo', 1).work].sort());

    // A lock held by another live owner is never taken; a dead owner's lock is reclaimed.
    const slot0 = slotPaths(workRoot, 'cynthia/demo', 0);
    writeFileSync(slot0.lock, JSON.stringify({ pid: process.pid, host: hostname(), token: 'someone-else' }));
    const busy = await runOnce(workRoot, [job('c', history.c1)], async (_command, cwd) => {
      cwds.push(cwd);
      return ok;
    });
    expect(busy.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(cwds.at(-1)).toBe(slotPaths(workRoot, 'cynthia/demo', 1).work);
    expect(JSON.parse(readFileSync(slot0.lock, 'utf8')).token).toBe('someone-else');

    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    writeFileSync(slot0.lock, JSON.stringify({ pid: Number(dead.stdout), host: hostname(), token: 'crashed' }));
    const reclaimed = await runOnce(workRoot, [job('d', history.c2)], async (_command, cwd) => {
      cwds.push(cwd);
      return ok;
    });
    expect(reclaimed.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(cwds.at(-1)).toBe(slot0.work);
    expect(existsSync(slot0.lock)).toBe(false);
  });

  it('keeps one runner process on its own workdir for consecutive jobs and releases it at exit', async () => {
    const workRoot = join(root, 'loop');
    const cwds: string[] = [];
    // The claim queue runs dry and fails so the otherwise endless loop ends.
    const api = fakePlatform([job('l1', history.c1), job('l2', history.c2)], { stopWhenEmpty: true });
    const stdout: string[] = [];
    const coldDownloads = snapshotDownloads.count;
    const run = runRunner({
      baseUrl: BASE,
      pat: 'p',
      repo: 'cynthia/demo',
      apiFetch: api.apiFetch,
      checkoutFn: realCheckout as any,
      execute: async (_command, cwd) => {
        cwds.push(cwd);
        expect(existsSync(slotPaths(workRoot, 'cynthia/demo', 0).lock)).toBe(true);
        return ok;
      },
      stdout: (l) => stdout.push(l),
      stderr: () => {},
      tempRoot: root,
      workRoot,
    });
    await expect(run).rejects.toThrow(/runner stopped/);
    expect(api.reports.map((r) => r.conclusion)).toEqual(['success', 'success']);
    expect(cwds).toEqual([slotPaths(workRoot, 'cynthia/demo', 0).work, slotPaths(workRoot, 'cynthia/demo', 0).work]);
    expect(stdout.filter((l) => l.startsWith('workdir:'))).toEqual(['workdir: fresh', 'workdir: warm']);
    expect(snapshotDownloads.count).toBe(coldDownloads + 1);
    expect(existsSync(slotPaths(workRoot, 'cynthia/demo', 0).lock)).toBe(false);
  });

  it('rejects repository names that would escape the workdir root', () => {
    expect(() => slotPaths(join(root, 'escape'), 'cynthia/..', 0)).toThrow(/invalid repository/);
    expect(() => slotPaths(join(root, 'escape'), '../demo', 0)).toThrow(/invalid repository/);
  });
});
