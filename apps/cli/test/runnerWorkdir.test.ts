import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkout } from '../src/checkout.js';
import type { HttpFetch } from '../src/http.js';
import { runRunner } from '../src/runner.js';
import { slotPaths } from '../src/workdir.js';
import { git, tarFromCommit, tempDir } from './helpers';

const root = tempDir('forge-cli-warm-');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Two commits whose difference covers every sync case. */
function makeHistory() {
  const work = join(root, 'src-repo');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  const put = (path: string, content: string, mode?: number) => {
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
  rmSync(join(work, 'vendor'), { recursive: true });
  put('new/added.txt', 'brand new\n');
  put('node_modules/linked/file.txt', 'tracked file under an untracked cache symlink\n');
  rmSync(join(work, 'link'));
  symlinkSync('modify.txt', join(work, 'link'));
  git(work, ['add', '-A', '-f']);
  git(work, ['commit', '-q', '-m', 'two']);
  const c2 = git(work, ['rev-parse', 'HEAD']);
  return { work, c1, c2, tars: { [c1]: tarFromCommit(work, c1), [c2]: tarFromCommit(work, c2) } as Record<string, Uint8Array> };
}

const history = makeHistory();
const BASE = 'https://forge.test';
const SNAP = `${BASE}/api/v1/repos/cynthia/demo/snapshots/`;

const snapshotFetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const rest = url.slice(SNAP.length);
  const sha = rest.replace(/\/download$/, '');
  const tar = history.tars[sha];
  if (!url.startsWith(SNAP) || !tar) return Response.json({ error: 'not found' }, { status: 404 });
  if (rest.endsWith('/download')) return new Response(new Uint8Array(tar), { headers: { 'x-forge-snapshot-sha': sha } });
  return Response.json({ sha, state: 'ready', size: tar.length });
}) as unknown as HttpFetch;

const checkoutCalls: string[] = [];
const realCheckout = (o: any) => {
  checkoutCalls.push(o.dir);
  return checkout({ ...o, fetch: snapshotFetch, cloneUrl: `file://${history.work}` });
};

/** A fresh snapshot checkout of `sha`, the ground truth for the warm workdir. */
async function freshCheckout(sha: string): Promise<string> {
  const dir = tempDir('forge-cli-warm-fresh-');
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

type Job = { id: string; name: string; command: string; sha: string; generation: number; timeoutSeconds: number };
const job = (id: string, sha: string): Job => ({ id, name: 'build', command: 'build', sha, generation: 1, timeoutSeconds: 30 });

function fakeApi(jobs: Job[]) {
  const reports: any[] = [];
  const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path.endsWith('/claim')) {
      const next = jobs.shift();
      return next ? Response.json({ job: next }) : new Response(null, { status: 204 });
    }
    if (path.endsWith('/report')) {
      reports.push({ path, ...body });
      return Response.json({ run: { status: body.conclusion } });
    }
    return Response.json({});
  };
  return { apiFetch, reports };
}

type Execute = (command: string, cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }>;
const ok = { code: 0, stdout: 'ok', stderr: '', timedOut: false, durationMs: 1 };

async function runOnce(workRoot: string, jobs: Job[], execute: Execute, extra: Record<string, unknown> = {}) {
  const api = fakeApi(jobs);
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
  return { result, reports: api.reports, stdout, stderr };
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

describe('forge runner warm workdir', () => {
  it('syncs a second job byte-equal to a fresh snapshot checkout while untracked caches survive', async () => {
    const workRoot = join(root, 'warm');
    const outside = join(root, 'outside-warm');
    mkdirSync(outside);
    const seen: string[] = [];
    const first = await runOnce(workRoot, [job('j1', history.c1)], dirtyFirstJob(outside, seen));
    expect(first.reports.map((r) => r.conclusion)).toEqual(['success']);
    expect(first.stdout).toContain('workdir: fresh');

    const fresh2 = await freshCheckout(history.c2);
    let observed: Record<string, string> = {};
    const second = await runOnce(workRoot, [job('j2', history.c2)], async (_command, cwd) => {
      seen.push(cwd);
      observed = treeState(cwd, ['node_modules/dep', '.venv', 'target']);
      return ok;
    });
    expect(second.result).toEqual({ claimed: 1, reported: 1 });
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2, source: 'snapshot' } });
    expect(second.stdout).toContain('workdir: warm');
    expect(second.stderr.filter((l) => !l.startsWith('checkout: note:'))).toEqual([]);
    expect(seen[1]).toBe(seen[0]);
    expect(observed).toEqual(treeState(fresh2));
    expect(observed).not.toHaveProperty('delete-me.txt');
    expect(observed).not.toHaveProperty('gone');
    expect(observed).not.toHaveProperty('vendor');
    expect(observed).not.toHaveProperty('dist');
    expect(observed).not.toHaveProperty('stray.log');
    expect(readFileSync(join(seen[1]!, 'modify.txt'), 'utf8')).toBe('after — exact bytes ✓\n');
    expect(readFileSync(join(seen[1]!, 'new', 'added.txt'), 'utf8')).toBe('brand new\n');
    expect(readFileSync(join(seen[1]!, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('installed\n');
    expect(readFileSync(join(seen[1]!, '.venv', 'bin', 'python'), 'utf8')).toBe('venv\n');
    expect(readFileSync(join(seen[1]!, 'target', 'debug', 'out'), 'utf8')).toBe('cargo\n');
    expect(lstatSync(join(seen[1]!, 'node_modules', 'linked')).isDirectory()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('--fresh rematerializes the whole workdir and drops caches', async () => {
    const workRoot = join(root, 'fresh');
    const outside = join(root, 'outside-fresh');
    mkdirSync(outside);
    const seen: string[] = [];
    await runOnce(workRoot, [job('j1', history.c1)], dirtyFirstJob(outside, seen));
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
    expect(second.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(second.stdout).toContain('workdir: fresh');
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));
    expect(observed).not.toHaveProperty('node_modules/dep');
    expect(observed).not.toHaveProperty('.venv');
  });

  it('falls back to a full snapshot checkout on a sync error and the job still completes', async () => {
    const workRoot = join(root, 'fallback');
    const outside = join(root, 'outside-fallback');
    mkdirSync(outside);
    const seen: string[] = [];
    await runOnce(workRoot, [job('j1', history.c1)], dirtyFirstJob(outside, seen));
    let observed: Record<string, string> = {};
    const second = await runOnce(
      workRoot,
      [job('j2', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      {
        syncFn: (_staging: string, work: string) => {
          rmSync(join(work, 'README.md'), { force: true });
          writeFileSync(join(work, 'half-synced.txt'), 'partial\n');
          throw new Error('injected sync failure');
        },
      },
    );
    expect(second.result).toEqual({ claimed: 1, reported: 1 });
    expect(second.reports[0]).toMatchObject({ conclusion: 'success', summary: { sha: history.c2 } });
    expect(second.stderr.join('\n')).toMatch(/warm sync failed: injected sync failure; falling back to a full snapshot checkout/);
    expect(second.stdout).toContain('workdir: fresh');
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));

    let third: Record<string, string> = {};
    const after = await runOnce(workRoot, [job('j3', history.c1)], async (_command, cwd) => {
      third = treeState(cwd);
      return ok;
    });
    expect(after.stdout).toContain('workdir: warm');
    expect(third).toEqual(treeState(await freshCheckout(history.c1)));
  });

  it('falls back when the warm staging checkout fails or the recorded state is unusable', async () => {
    const workRoot = join(root, 'fallback-checkout');
    await runOnce(workRoot, [job('j1', history.c1)], async () => ok);
    let calls = 0;
    let observed: Record<string, string> = {};
    const flaky = (o: any) => (++calls === 1 ? Promise.reject(new Error('staging download broke')) : realCheckout(o));
    const second = await runOnce(
      workRoot,
      [job('j2', history.c2)],
      async (_command, cwd) => {
        observed = treeState(cwd);
        return ok;
      },
      { checkoutFn: flaky },
    );
    expect(calls).toBe(2);
    expect(second.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(second.stderr.join('\n')).toMatch(/warm sync failed: staging download broke/);
    expect(observed).toEqual(treeState(await freshCheckout(history.c2)));

    const slot = slotPaths(workRoot, 'cynthia/demo', 0);
    writeFileSync(slot.state, JSON.stringify({ version: 1, sha: history.c2, files: ['../escape'] }));
    const third = await runOnce(workRoot, [job('j3', history.c1)], async (_command, cwd) => {
      observed = treeState(cwd);
      return ok;
    });
    expect(third.reports[0]).toMatchObject({ conclusion: 'success' });
    expect(third.stderr.join('\n')).toMatch(/warm sync failed: .*unsafe path/);
    expect(observed).toEqual(treeState(await freshCheckout(history.c1)));
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
    const jobs = [job('l1', history.c1), job('l2', history.c2)];
    const reports: string[] = [];
    // The third claim fails so the otherwise endless loop ends.
    const apiFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/claim')) {
        const next = jobs.shift();
        return next ? Response.json({ job: next }) : Response.json({ error: 'runner stopped' }, { status: 500 });
      }
      if (path.endsWith('/report')) reports.push(JSON.parse(String(init?.body)).conclusion);
      return Response.json({});
    };
    const stdout: string[] = [];
    const run = runRunner({
      baseUrl: BASE,
      pat: 'p',
      repo: 'cynthia/demo',
      apiFetch,
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
    expect(reports).toEqual(['success', 'success']);
    expect(cwds).toEqual([slotPaths(workRoot, 'cynthia/demo', 0).work, slotPaths(workRoot, 'cynthia/demo', 0).work]);
    expect(stdout.filter((l) => l.startsWith('workdir:'))).toEqual(['workdir: fresh', 'workdir: warm']);
    expect(existsSync(slotPaths(workRoot, 'cynthia/demo', 0).lock)).toBe(false);
  });

  it('rejects repository names that would escape the workdir root', () => {
    expect(() => slotPaths(join(root, 'escape'), 'cynthia/..', 0)).toThrow(/invalid repository/);
    expect(() => slotPaths(join(root, 'escape'), '../demo', 0)).toThrow(/invalid repository/);
  });
});
