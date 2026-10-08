import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { tarEnd, tarEntry } from '@forge/gitops';
import { TarError, extractTar, parsePax } from '../src/untar.js';
import { chunked, diffTrees, gitCheckout, makeRepo, tarFromCommit, tempDir } from './helpers';

const root = tempDir('forge-cli-untar-');
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

  it('rejects parent-directory and absolute paths without writing outside the destination', async () => {
    const dest = join(root, 'x-evil', 'inner');
    await expect(extractTar(chunked(archive(file('../escape.txt', 'x'))), dest)).rejects.toBeInstanceOf(TarError);
    expect(existsSync(join(root, 'x-evil', 'escape.txt'))).toBe(false);
    await expect(extractTar(chunked(archive(file('ok/../../escape2.txt', 'x'))), dest)).rejects.toThrow(/unsafe archive path/);
    await expect(extractTar(chunked(archive(file('/tmp/forge-abs.txt', 'x'))), dest)).rejects.toThrow(/absolute|unsafe/);
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

  it('parses pax records including multi-byte values', () => {
    const enc = new TextEncoder();
    const body = ' path=dir/日本.txt\n';
    const len = enc.encode(body).length;
    const rec = `${len + String(len + 2).length}${body}`;
    expect(parsePax(enc.encode(rec)).get('path')).toBe('dir/日本.txt');
  });
});
