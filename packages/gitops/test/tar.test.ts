/**
 * Streaming ustar/pax writer, checked against real archivers: bsdtar
 * extraction, Python's tarfile parser, and a git checkout of the same tree.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TAR_BLOCK, gitModeToTar, tarEnd, tarEntry, tarHeader, tarPadding, type TarEntry } from '../src/tar';

const work = mkdtempSync(join(tmpdir(), 'tar-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const enc = (s: string) => new TextEncoder().encode(s);
const MTIME = 1_790_000_000;

function archive(entries: { entry: TarEntry; data?: Uint8Array }[]): Uint8Array {
  const parts = entries.map(({ entry, data }) => tarEntry(entry, data ?? new Uint8Array(0)));
  parts.push(tarEnd());
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// bsdtar on macOS rewrites non-ASCII names to NFD while git keeps the
// committed bytes, so the byte-exact checkout comparison extracts with Python.
function extract(bytes: Uint8Array, name: string, tool: 'tar' | 'python' = 'tar'): string {
  const file = join(work, `${name}.tar`);
  writeFileSync(file, bytes);
  const dir = join(work, name);
  mkdirSync(dir);
  if (tool === 'tar') execFileSync('tar', ['-xf', file, '-C', dir]);
  else execFileSync('python3', ['-c', 'import sys, tarfile\ntarfile.open(sys.argv[1], errorlevel=2).extractall(sys.argv[2])', file, dir]);
  return dir;
}

const longDir = `${'d'.repeat(60)}/${'e'.repeat(60)}`;
const prefixPath = `${longDir}/${'f'.repeat(90)}.txt`; // > 100 bytes, splits into prefix + name
const paxPath = `${'p'.repeat(120)}/${'q'.repeat(120)}/${'r'.repeat(40)}.txt`; // > 255 bytes
const unsplittable = `x/${'n'.repeat(130)}.txt`; // the last component alone exceeds 100 bytes
const unicodePath = 'docs/résumé-日本.md';
const longTarget = `${'t'.repeat(150)}/target.txt`;

const fixture: { entry: TarEntry; data?: Uint8Array }[] = [
  { entry: { path: 'a.txt', type: 'file', mode: 0o644, size: 6, mtime: MTIME }, data: enc('hello\n') },
  { entry: { path: 'bin', type: 'dir', mode: 0o755, mtime: MTIME } },
  { entry: { path: 'bin/run.sh', type: 'file', mode: 0o755, size: 19, mtime: MTIME }, data: enc('#!/bin/sh\necho hi\n\n') },
  { entry: { path: 'empty', type: 'file', mode: 0o644, size: 0, mtime: MTIME }, data: new Uint8Array(0) },
  { entry: { path: 'block.bin', type: 'file', mode: 0o644, size: 512, mtime: MTIME }, data: new Uint8Array(512).fill(7) },
  { entry: { path: prefixPath, type: 'file', mode: 0o644, size: 7, mtime: MTIME }, data: enc('prefix\n') },
  { entry: { path: paxPath, type: 'file', mode: 0o644, size: 4, mtime: MTIME }, data: enc('pax\n') },
  { entry: { path: unsplittable, type: 'file', mode: 0o644, size: 6, mtime: MTIME }, data: enc('split\n') },
  { entry: { path: unicodePath, type: 'file', mode: 0o644, size: 8, mtime: MTIME }, data: enc('unicode\n') },
  { entry: { path: 'link', type: 'symlink', mode: 0o777, mtime: MTIME, linkname: 'a.txt' } },
  { entry: { path: 'farlink', type: 'symlink', mode: 0o777, mtime: MTIME, linkname: longTarget } },
  { entry: { path: 'sub', type: 'dir', mode: 0o755, mtime: MTIME } },
];

describe('tar writer', () => {
  it('pads every entry to 512-byte blocks and ends with two zero blocks', () => {
    expect(tarPadding(0)).toBe(0);
    expect(tarPadding(1)).toBe(511);
    expect(tarPadding(512)).toBe(0);
    expect(tarPadding(513)).toBe(511);
    expect(tarEnd()).toEqual(new Uint8Array(1024));
    const bytes = archive(fixture);
    expect(bytes.length % TAR_BLOCK).toBe(0);
    const header = tarHeader({ path: 'a.txt', type: 'file', mode: 0o644, size: 6, mtime: MTIME });
    expect(header.length).toBe(TAR_BLOCK);
  });

  it('writes valid ustar checksums and magic', () => {
    const h = tarHeader({ path: 'a.txt', type: 'file', mode: 0o644, size: 6, mtime: MTIME });
    expect(new TextDecoder().decode(h.subarray(257, 263))).toBe('ustar\0');
    expect(new TextDecoder().decode(h.subarray(263, 265))).toBe('00');
    const stored = parseInt(new TextDecoder().decode(h.subarray(148, 154)), 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
    expect(stored).toBe(sum);
  });

  it('extracts with bsdtar: contents, modes, symlinks, long and unicode paths', () => {
    const dir = extract(archive(fixture), 'bsdtar');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(dir, 'bin/run.sh'), 'utf8')).toBe('#!/bin/sh\necho hi\n\n');
    expect(lstatSync(join(dir, 'bin/run.sh')).mode & 0o111).not.toBe(0);
    expect(lstatSync(join(dir, 'a.txt')).mode & 0o111).toBe(0);
    expect(readFileSync(join(dir, 'empty')).length).toBe(0);
    expect(readFileSync(join(dir, 'block.bin'))).toEqual(Buffer.alloc(512, 7));
    expect(readFileSync(join(dir, prefixPath), 'utf8')).toBe('prefix\n');
    expect(readFileSync(join(dir, paxPath), 'utf8')).toBe('pax\n');
    expect(readFileSync(join(dir, unsplittable), 'utf8')).toBe('split\n');
    expect(readFileSync(join(dir, unicodePath), 'utf8')).toBe('unicode\n');
    expect(readlinkSync(join(dir, 'link'))).toBe('a.txt');
    expect(readlinkSync(join(dir, 'farlink'))).toBe(longTarget);
    expect(lstatSync(join(dir, 'sub')).isDirectory()).toBe(true);
  });

  it('parses strictly with Python tarfile (pax path/linkpath honored)', () => {
    const file = join(work, 'py.tar');
    writeFileSync(file, archive(fixture));
    const out = execFileSync(
      'python3',
      [
        '-c',
        'import sys, tarfile, json\n' +
          't = tarfile.open(sys.argv[1], errorlevel=2)\n' +
          'print(json.dumps([[m.name, m.type.decode(), m.mode, m.size, m.linkname, m.mtime] for m in t.getmembers()]))',
        file,
      ],
      { encoding: 'utf8' },
    );
    const members = JSON.parse(out) as [string, string, number, number, string, number][];
    expect(members.map((m) => m[0])).toEqual(fixture.map((f) => f.entry.path));
    const byName = new Map(members.map((m) => [m[0], m]));
    expect(byName.get('bin/run.sh')!.slice(1, 4)).toEqual(['0', 0o755, 19]);
    expect(byName.get('bin')![1]).toBe('5');
    expect(byName.get('farlink')!.slice(1)).toEqual(['2', 0o777, 0, longTarget, MTIME]);
    expect(byName.get(paxPath)![3]).toBe(4);
  });

  it('records sizes beyond the ustar octal range in a pax header', () => {
    const big = 9 * 1024 ** 3;
    const h = tarHeader({ path: 'huge.bin', type: 'file', mode: 0o644, size: big, mtime: MTIME });
    // pax header block + its data block + the ustar header
    expect(h.length).toBe(3 * TAR_BLOCK);
    const text = new TextDecoder().decode(h.subarray(TAR_BLOCK, 2 * TAR_BLOCK));
    expect(text).toContain(`size=${big}\n`);
    expect(String.fromCharCode(h[156]!)).toBe('x');
  });

  it('is deterministic', () => {
    expect(archive(fixture)).toEqual(archive(fixture));
  });

  it('rejects data whose length differs from the declared size', () => {
    expect(() => tarEntry({ path: 'a', type: 'file', mode: 0o644, size: 3, mtime: MTIME }, enc('ab'))).toThrow(/size/);
  });

  it('maps git modes', () => {
    expect(gitModeToTar('100644')).toEqual({ type: 'file', mode: 0o644 });
    expect(gitModeToTar('100755')).toEqual({ type: 'file', mode: 0o755 });
    expect(gitModeToTar('120000')).toEqual({ type: 'symlink', mode: 0o777 });
    expect(gitModeToTar('40000')).toEqual({ type: 'dir', mode: 0o755 });
    // A submodule checks out as an empty directory.
    expect(gitModeToTar('160000')).toEqual({ type: 'dir', mode: 0o755 });
  });
});

describe('tar of a git tree matches git checkout', () => {
  it('extracts identically to a checkout (diff -r clean)', () => {
    const repo = join(work, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(repo, 'README.md'), '# demo\n');
    mkdirSync(join(repo, longDir), { recursive: true });
    writeFileSync(join(repo, prefixPath), 'long\n');
    mkdirSync(join(repo, paxPath, '..'), { recursive: true });
    writeFileSync(join(repo, paxPath), 'longer\n');
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, unicodePath), 'ünïcode\n');
    writeFileSync(join(repo, 'tool.sh'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, 'tool.sh'), 0o755);
    symlinkSync('README.md', join(repo, 'readme-link'));
    writeFileSync(join(repo, 'bin.dat'), Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 256)));
    git('add', '-A');
    const env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
    const commit = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=off', 'commit', '-q', '-m', 'snapshot'], { env, encoding: 'utf8' });
    if (commit.status !== 0) throw new Error(commit.stderr);

    // Walk the tree the way the builder does: entries come from ls-tree -r -t
    // (pre-order: a directory precedes its contents), content from cat-file.
    const listing = execFileSync('git', ['-C', repo, '-c', 'core.quotepath=off', 'ls-tree', '-r', '-t', '-z', 'HEAD']).toString('utf8');
    const entries: { entry: TarEntry; data?: Uint8Array }[] = [];
    for (const rec of listing.split('\0').filter(Boolean)) {
      const [meta, path] = [rec.slice(0, rec.indexOf('\t')), rec.slice(rec.indexOf('\t') + 1)];
      const [mode, , hash] = meta.split(' ') as [string, string, string];
      const mapped = gitModeToTar(mode)!;
      if (mapped.type === 'dir') {
        entries.push({ entry: { path, ...mapped, mtime: MTIME } });
        continue;
      }
      const data = new Uint8Array(execFileSync('git', ['-C', repo, 'cat-file', 'blob', hash]));
      if (mapped.type === 'symlink') {
        entries.push({ entry: { path, ...mapped, mtime: MTIME, linkname: new TextDecoder().decode(data) } });
      } else {
        entries.push({ entry: { path, ...mapped, size: data.length, mtime: MTIME }, data });
      }
    }
    const dir = extract(archive(entries), 'from-git', 'python');
    const diff = spawnSync('diff', ['-r', '-x', '.git', dir, repo], { encoding: 'utf8' });
    expect(diff.stdout + diff.stderr).toBe('');
    expect(diff.status).toBe(0);
    expect(lstatSync(join(dir, 'tool.sh')).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(dir, 'readme-link'))).toBe('README.md');
  });
});
