import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitModeToTar, tarEnd, tarEntry } from '@kvarm/gitops';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', ['-c', 'credential.helper=', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString('utf8').trim();
}

function gitBytes(cwd: string, args: string[]): Buffer {
  const r = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'buffer', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout;
}

/** Writes a tree that exercises every snapshot entry kind. */
export function writeFixtureTree(dir: string, salt: string): void {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), `# fixture ${salt}\n`);
  writeFileSync(join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n');
  chmodSync(join(dir, 'bin', 'tool.sh'), 0o755);
  symlinkSync('README.md', join(dir, 'readme-link'));
  symlinkSync('../README.md', join(dir, 'bin', 'up-link'));
  const long = join(dir, 'd'.repeat(60), 'e'.repeat(60));
  mkdirSync(long, { recursive: true });
  writeFileSync(join(long, `${'n'.repeat(110)}.txt`), 'long path\n');
  mkdirSync(join(dir, 'docs', 'deep', 'er'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'résumé-日本.md'), 'unicode\n');
  writeFileSync(join(dir, 'docs', 'empty.txt'), '');
  // Literal backslashes and a drive-like prefix are ordinary POSIX filename bytes.
  writeFileSync(join(dir, 'docs', 'back\\slash.txt'), 'backslash\n');
  writeFileSync(join(dir, '..\\literal.txt'), 'dotdot backslash\n');
  writeFileSync(join(dir, 'C:notes'), 'drive-like\n');
  writeFileSync(join(dir, 'docs', 'deep', 'er', 'x.txt'), 'deep\n');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256)));
}

/**
 * Creates a work repo with `main` (fixture tree) and `feature` (one more
 * file), plus a bare clone usable as a `file://` remote.
 */
export function makeRepo(root: string): { work: string; bare: string; main: string; feature: string } {
  const work = join(root, 'work');
  mkdirSync(work);
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'core.quotepath', 'off']);
  writeFixtureTree(work, root);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'main']);
  const main = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', '-b', 'feature']);
  writeFileSync(join(work, 'feature.txt'), 'feature\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'feature']);
  const feature = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '-q', 'main']);
  const bare = join(root, 'repo.git');
  git(root, ['clone', '-q', '--bare', work, bare]);
  return { work, bare, main, feature };
}

/**
 * Builds a snapshot tarball for `sha` the way the platform's builder does:
 * git tree order, directories with a trailing slash, ustar/pax headers from
 * `@kvarm/gitops`.
 */
export function tarFromCommit(repo: string, sha: string): Uint8Array {
  const listing = gitBytes(repo, ['ls-tree', '-r', '-t', '-z', '--full-tree', sha]).toString('utf8');
  const parts: Uint8Array[] = [];
  for (const line of listing.split('\0')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    const [mode, , oid] = line.slice(0, tab).split(' ') as [string, string, string];
    const path = line.slice(tab + 1);
    const kind = gitModeToTar(mode);
    if (!kind) continue;
    if (kind.type === 'dir') {
      parts.push(tarEntry({ path, type: 'dir', mode: kind.mode, mtime: 1_700_000_000 }));
    } else if (kind.type === 'symlink') {
      const target = gitBytes(repo, ['cat-file', 'blob', oid]).toString('utf8');
      parts.push(tarEntry({ path, type: 'symlink', mode: kind.mode, mtime: 1_700_000_000, linkname: target }));
    } else {
      const data = new Uint8Array(gitBytes(repo, ['cat-file', 'blob', oid]));
      parts.push(tarEntry({ path, type: 'file', mode: kind.mode, size: data.length, mtime: 1_700_000_000 }, data));
    }
  }
  parts.push(tarEnd());
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Checks out `sha` from `bare` into a fresh directory with git (ground truth). */
export function gitCheckout(bare: string, sha: string, dest: string): void {
  git(tmpdir(), ['clone', '-q', '--no-checkout', bare, dest]);
  git(dest, ['checkout', '-q', sha]);
}

/** `diff -r -x .git a b`: exit code plus output. */
export function diffTrees(a: string, b: string): { code: number | null; out: string } {
  const r = spawnSync('diff', ['-r', '-x', '.git', a, b], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Yields `bytes` in small uneven chunks to exercise block reassembly. */
export async function* chunked(bytes: Uint8Array, sizes = [1, 7, 511, 513, 4096, 100_000]): AsyncGenerator<Uint8Array> {
  let off = 0;
  let i = 0;
  while (off < bytes.length) {
    const n = sizes[i++ % sizes.length]!;
    yield bytes.slice(off, off + n);
    off += n;
  }
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean | Promise<boolean>;

/**
 * A local HTTP server that runs `handler` first and otherwise serves the
 * bare repos under `gitRoot` through `git http-backend` at `/<owner>/<repo>.git/...`.
 */
export async function startServer(gitRoot: string, handler: Handler): Promise<{ url: string; server: Server; requests: Array<{ method: string; url: string; auth: string | undefined }> }> {
  const requests: Array<{ method: string; url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', auth: req.headers.authorization });
      try {
        if (await handler(req, res, body)) return;
        httpBackend(gitRoot, req, res, body);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  return { url: `http://127.0.0.1:${addr.port}`, server, requests };
}

function httpBackend(gitRoot: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const child = spawn('git', ['http-backend'], {
    env: {
      ...GIT_ENV,
      GIT_PROJECT_ROOT: gitRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(url.pathname),
      REQUEST_METHOD: req.method ?? 'GET',
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      CONTENT_LENGTH: String(body.length),
      GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const out: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => out.push(c));
  child.on('close', () => {
    const all = Buffer.concat(out);
    const sep = all.indexOf('\r\n\r\n');
    const head = all.subarray(0, sep).toString('latin1');
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
      else headers[k] = v;
    }
    res.writeHead(status, headers).end(all.subarray(sep + 4));
  });
  child.stdin.end(body);
}
