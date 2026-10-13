import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tarEnd, tarEntry } from '@kvarm/gitops';
import { TarError, archiveTarget, extractTar, parsePax } from '../src/untar.js';
import { chunked, diffTrees, gitCheckout, makeRepo, tarFromCommit, tempDir } from './helpers';

const root = tempDir('kvarm-cli-untar-');
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = makeRepo(root);

function archive(...entries: Uint8Array[]): Uint8Array {
  const parts = [...entries, tarEnd()];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const file = (path: string, text: string, mode = 0o644) => {
  const data = new TextEncoder().encode(text);
  return tarEntry({ path, type: 'file', mode, size: data.length, mtime: 0 }, data);
};

describe('extractTar', () => {
  it('extracts a builder-format snapshot identical to git checkout (modes, symlinks, long and unicode paths)', async () => {
    const tar = tarFromCommit(repo.bare, repo.main);
    const dest = join(root, 'x-main');
    const result = await extractTar(chunked(tar), dest);
    expect(result.bytes).toBe(tar.length);
    expect(result.symlinks).toBe(2);
    const expected = join(root, 'co-main');
    gitCheckout(repo.bare, repo.main, expected);
    expect(diffTrees(dest, expected)).toEqual({ code: 0, out: '' });
    expect(statSync(join(dest, 'bin', 'tool.sh')).mode & 0o111).not.toBe(0);
    expect(statSync(join(dest, 'README.md')).mode & 0o111).toBe(0);
    expect(lstatSync(join(dest, 'readme-link')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(dest, 'bin', 'up-link'))).toBe('../README.md');
    expect(readFileSync(join(dest, 'docs', 'résumé-日本.md'), 'utf8')).toBe('unicode\n');
  });

  it('extracts git archive output (global pax header) like a checkout', async () => {
    const r = spawnSync('git', ['archive', '--format=tar', repo.feature], { cwd: repo.bare, maxBuffer: 64 << 20 });
    expect(r.status).toBe(0);
    const dest = join(root, 'x-archive');
    await extractTar(chunked(new Uint8Array(r.stdout)), dest);
    const expected = join(root, 'co-feature');
    gitCheckout(repo.bare, repo.feature, expected);
    expect(diffTrees(dest, expected)).toEqual({ code: 0, out: '' });
  });

  it('counts trailing bytes after the end marker in the byte total', async () => {
    const tar = archive(file('a.txt', 'a\n'));
    const padded = new Uint8Array(tar.length + 10 * 512);
    padded.set(tar);
    const result = await extractTar(chunked(padded), join(root, 'x-trailing'));
    expect(result).toEqual({ files: 1, dirs: 0, symlinks: 0, bytes: padded.length });
  });

  it('enforces total-byte, entry-count and extended-header budgets', async () => {
    const tar = archive(file('a.txt', 'a\n'));
    await expect(extractTar(chunked(tar), join(root, 'x-byte-budget'), { maxBytes: tar.length - 1 })).rejects.toThrow(/byte budget/);
    await expect(extractTar(chunked(tar), join(root, 'x-entry-budget'), { maxEntries: 0 })).rejects.toThrow(/entry budget/);
    const longPath = file('a'.repeat(300), 'a');
    await expect(extractTar(chunked(archive(longPath)), join(root, 'x-header-budget'), { maxHeaderBytes: 1 })).rejects.toThrow(/header budget/);
  });

  it('rejects parent-directory and absolute paths without writing outside the destination', async () => {
    const dest = join(root, 'x-evil', 'inner');
    await expect(extractTar(chunked(archive(file('../escape.txt', 'x'))), dest)).rejects.toBeInstanceOf(TarError);
    expect(existsSync(join(root, 'x-evil', 'escape.txt'))).toBe(false);
    await expect(extractTar(chunked(archive(file('ok/../../escape2.txt', 'x'))), dest)).rejects.toThrow(/unsafe archive path/);
    await expect(extractTar(chunked(archive(file('/tmp/kvarm-abs.txt', 'x'))), dest)).rejects.toThrow(/absolute|unsafe/);
  });

  it('keeps literal backslash and drive-like names as POSIX filenames inside the destination', async () => {
    const dest = join(root, 'x-backslash');
    const result = await extractTar(chunked(archive(file('dir\\name.txt', 'a'), file('..\\lit.txt', 'b'), file('C:notes', 'c'))), dest);
    expect(result.files).toBe(3);
    expect(readdirSync(dest).sort()).toEqual(['..\\lit.txt', 'C:notes', 'dir\\name.txt']);
    expect(readFileSync(join(dest, '..\\lit.txt'), 'utf8')).toBe('b');
    expect(existsSync(join(root, 'lit.txt'))).toBe(false);
  });

  it('lets a later entry rewrite a file the same extraction created', async () => {
    const dest = join(root, 'x-dup');
    await extractTar(chunked(archive(file('a.txt', 'first'), file('a.txt', 'second'))), dest);
    expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('second');
  });

  it('rejects traversal without creating or truncating a file outside the destination', async () => {
    const base = join(root, 'x-keep');
    const dest = join(base, 'inner');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(base, 'outside.txt'), 'original');
    await expect(extractTar(chunked(archive(file('../outside.txt', 'pwned'))), dest)).rejects.toBeInstanceOf(TarError);
    await expect(extractTar(chunked(archive(file('a/../../outside.txt', 'pwned'))), dest)).rejects.toBeInstanceOf(TarError);
    await expect(extractTar(chunked(archive(file('../newdir/x.txt', 'pwned'))), dest)).rejects.toBeInstanceOf(TarError);
    expect(readFileSync(join(base, 'outside.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(base, 'newdir'))).toBe(false);
    expect(readdirSync(base).sort()).toEqual(['inner', 'outside.txt']);
  });

  it('never follows a pre-existing symlink in the destination for files or directories', async () => {
    const outside = join(root, 'x-pre-outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim.txt'), 'original');
    const dest = join(root, 'x-pre');
    mkdirSync(dest);
    symlinkSync(outside, join(dest, 'dirlink'));
    symlinkSync(join(outside, 'victim.txt'), join(dest, 'filelink'));
    await expect(extractTar(chunked(archive(file('dirlink/pwned.txt', 'x'))), dest)).rejects.toBeInstanceOf(TarError);
    await expect(extractTar(chunked(archive(file('dirlink/sub/pwned.txt', 'x'))), dest)).rejects.toBeInstanceOf(TarError);
    await expect(extractTar(chunked(archive(tarEntry({ path: 'dirlink/made/', type: 'dir', mode: 0o755, mtime: 0 }))), dest)).rejects.toBeInstanceOf(TarError);
    await expect(extractTar(chunked(archive(file('filelink', 'truncated'))), dest)).rejects.toBeInstanceOf(TarError);
    expect(readdirSync(outside)).toEqual(['victim.txt']);
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('original');
  });

  it('never writes a file through an archive symlink', async () => {
    const outside = join(root, 'x-outside');
    const dest = join(root, 'x-link');
    const tar = archive(tarEntry({ path: 'link', type: 'symlink', mode: 0o777, mtime: 0, linkname: outside }), file('link/pwned.txt', 'x'));
    await expect(extractTar(chunked(tar), dest)).rejects.toThrow(/already exists/);
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
  });

  it('fails on a truncated archive and on a corrupt header checksum', async () => {
    const tar = archive(file('a.txt', 'x'.repeat(2000)));
    await expect(extractTar(chunked(tar.slice(0, 1200)), join(root, 'x-trunc'))).rejects.toThrow(/unexpected end/);
    const bad = tar.slice();
    bad[0] = 0x5a;
    await expect(extractTar(chunked(bad), join(root, 'x-bad'))).rejects.toThrow(/checksum/);
  });

  it('validates every symlink parent even when a later link sits under an earlier one', async () => {
    const outside = join(root, 'x-chain-outside');
    mkdirSync(outside);
    const dest = join(root, 'x-chain');
    const tar = archive(
      tarEntry({ path: 'link', type: 'symlink', mode: 0o777, mtime: 0, linkname: outside }),
      tarEntry({ path: 'link/inner', type: 'symlink', mode: 0o777, mtime: 0, linkname: '/etc/passwd' }),
    );
    await expect(extractTar(chunked(tar), dest)).rejects.toBeInstanceOf(TarError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('parses pax records including multi-byte values', () => {
    const enc = new TextEncoder();
    const body = ' path=dir/日本.txt\n';
    const len = enc.encode(body).length;
    const rec = `${len + String(len + 2).length}${body}`;
    expect(parsePax(enc.encode(rec)).get('path')).toBe('dir/日本.txt');
  });
});

describe('archiveTarget', () => {
  describe('with Windows path semantics', () => {
    const winRoot = 'C:\\work\\dest';
    const target = (raw: string) => archiveTarget(raw, winRoot, win32);

    it.each([
      '..\\escape.txt',
      'ok\\..\\..\\escape.txt',
      'a/..\\..\\escape.txt',
      'a\\b\\..\\..\\..\\escape.txt',
      '..\\',
      'C:\\Windows\\evil.dll',
      'C:/Windows/evil.dll',
      'C:evil.txt',
      'c:..\\evil.txt',
      'D:',
      '\\evil.txt',
      '/evil.txt',
      '\\\\server\\share\\evil.txt',
      '//server/share/evil.txt',
      '\\\\?\\C:\\evil.txt',
      '\\\\.\\C:\\evil.txt',
      'dir\\x:stream',
      'dir\\...\\evil.txt',
      'dir\\.. \\evil.txt',
      'dir\\\\double.txt',
    ])('rejects %j', (raw) => {
      expect(() => target(raw)).toThrow(TarError);
    });

    it('resolves both separators to paths inside the destination', () => {
      expect(target('dir\\file.txt')).toBe('C:\\work\\dest\\dir\\file.txt');
      expect(target('dir/sub\\file.txt')).toBe('C:\\work\\dest\\dir\\sub\\file.txt');
      expect(target('./dir/')).toBe('C:\\work\\dest\\dir');
      expect(target('.\\dir\\')).toBe('C:\\work\\dest\\dir');
      expect(target('..foo\\bar..txt')).toBe('C:\\work\\dest\\..foo\\bar..txt');
      expect(target('./')).toBe(winRoot);
    });
  });

  describe('with POSIX path semantics', () => {
    const posixRoot = '/work/dest';
    const target = (raw: string) => archiveTarget(raw, posixRoot, posix);

    it.each(['../escape.txt', 'ok/../../escape.txt', '/etc/passwd', 'a//b.txt', 'a/../b'])('rejects %j', (raw) => {
      expect(() => target(raw)).toThrow(TarError);
    });

    it('treats backslashes and drive-like prefixes as ordinary filename bytes', () => {
      expect(target('dir\\name.txt')).toBe('/work/dest/dir\\name.txt');
      expect(target('..\\lit.txt')).toBe('/work/dest/..\\lit.txt');
      expect(target('C:notes')).toBe('/work/dest/C:notes');
      expect(target('C:\\x')).toBe('/work/dest/C:\\x');
      expect(target('a/name. ')).toBe('/work/dest/a/name. ');
      expect(target('./dir/')).toBe('/work/dest/dir');
      expect(target('.')).toBe(posixRoot);
    });
  });

  it('rejects NUL bytes on both platforms', () => {
    expect(() => archiveTarget('a\0b', '/r', posix)).toThrow(/NUL/);
    expect(() => archiveTarget('a\0b', 'C:\\r', win32)).toThrow(/NUL/);
  });
});
