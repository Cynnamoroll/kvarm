import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffTrees, git, gitCheckout, makeRepo, startServer, tarFromCommit, tempDir } from './helpers';

const BIN = fileURLToPath(new URL('../bin/kvarm.js', import.meta.url));
const PAT = 'kvarm_pat_cli_test_token';

const root = tempDir('kvarm-cli-bin-');
const repo = makeRepo(root);
const gitRoot = join(root, 'served');
mkdirSync(join(gitRoot, 'cynthia'), { recursive: true });
git(root, ['clone', '-q', '--bare', repo.work, join(gitRoot, 'cynthia', 'demo.git')]);
const tarMain = tarFromCommit(repo.bare, repo.main);

let server: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => {
  server = await startServer(gitRoot, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/api\/v1\/repos\/cynthia\/demo\/snapshots\/(.+)$/.exec(url.pathname);
    if (!m) return false;
    const rest = decodeURIComponent(m[1]!);
    if (rest === `${repo.main}/download`) {
      res.writeHead(200, { 'content-type': 'application/x-tar', 'content-length': String(tarMain.length), 'x-kvarm-snapshot-sha': repo.main }).end(tarMain);
    } else if (rest === 'main') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ref: 'main', sha: repo.main, state: 'ready', size: tarMain.length, files: 9 }));
    } else if (rest === 'feature') {
      res.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ ref: 'feature', sha: repo.feature, state: 'building', started: true }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"snapshot not found","code":"NOT_FOUND"}');
    }
    return true;
  });
});
afterAll(async () => {
  await new Promise((r) => server.server.close(r));
  rmSync(root, { recursive: true, force: true });
});

function kvarm(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('kvarm bin', () => {
  it('checkout of a ready snapshot prints source: snapshot and matches git checkout', async () => {
    const dir = join(root, 'out-main');
    const r = await kvarm(['checkout', 'cynthia/demo', 'main', dir], { KVARM_BASE_URL: server.url, KVARM_PAT: PAT });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('source: snapshot');
    const expected = join(root, 'expected-main');
    gitCheckout(repo.bare, repo.main, expected);
    expect(diffTrees(dir, expected)).toEqual({ code: 0, out: '' });
  });

  it('checkout while building clones over smart HTTP with the PAT as basic auth and prints source: clone', async () => {
    const before = server.requests.length;
    const dir = join(root, 'out-feature');
    const r = await kvarm(['checkout', 'cynthia/demo', 'feature', dir], { KVARM_BASE_URL: server.url, KVARM_PAT: PAT });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe(`source: clone\nsha: ${repo.feature}\n`);
    const expected = join(root, 'expected-feature');
    gitCheckout(repo.bare, repo.feature, expected);
    expect(diffTrees(dir, expected)).toEqual({ code: 0, out: '' });
    const gitRequests = server.requests.slice(before).filter((q) => q.url.startsWith('/cynthia/demo.git/'));
    expect(gitRequests.length).toBeGreaterThan(0);
    const basic = `Basic ${Buffer.from(`forge:${PAT}`).toString('base64')}`;
    expect(gitRequests.every((q) => q.auth === basic)).toBe(true);
    expect(r.stdout + r.stderr).not.toContain(PAT);
    expect(git(dir, ['config', '--list', '--local'])).not.toContain('extraheader');
  });

  it('exits 2 with usage for bad arguments and a missing KVARM_BASE_URL', async () => {
    expect((await kvarm(['checkout', 'cynthia/demo'], { KVARM_BASE_URL: server.url })).code).toBe(2);
    expect((await kvarm(['checkout', 'not-a-repo', 'main', join(root, 'x')], { KVARM_BASE_URL: server.url })).code).toBe(2);
    const missing = await kvarm(['checkout', 'cynthia/demo', 'main', join(root, 'y')], {});
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/KVARM_BASE_URL is not set/);
    expect((await kvarm(['frobnicate'], {})).code).toBe(2);
    const help = await kvarm(['help', 'checkout'], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/no \.git directory/);
  });

  it('prints Kvarm usage and ignores the retired FORGE_* environment names', async () => {
    const help = await kvarm(['--help'], {});
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^usage: kvarm <command>/);
    expect(help.stdout.replace(/https:\/\/\S+/g, '')).not.toMatch(/forge/i);
    const retired = await kvarm(['checkout', 'cynthia/demo', 'main', join(root, 'retired-env')], { FORGE_BASE_URL: server.url, FORGE_PAT: PAT });
    expect(retired.code).toBe(2);
    expect(retired.stderr).toMatch(/KVARM_BASE_URL is not set/);
  });

  it('exits 1 when neither the snapshot nor git can provide the ref', async () => {
    const r = await kvarm(['checkout', 'cynthia/demo', 'nope', join(root, 'out-nope')], { KVARM_BASE_URL: server.url, KVARM_PAT: PAT });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/git checkout nope failed/);
  });
});
