/**
 * Packfile v2 writer: real `git index-pack` / `git verify-pack` accept what we
 * write and list exactly the object ids we computed.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildBlob,
  buildCommit,
  buildTree,
  EMPTY_PACK,
  encode,
  sha1Hex,
  hex,
  writePack,
  type GitObject,
} from '../src/index';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-pack-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], input?: Uint8Array): string {
  const r = spawnSync('git', args, { input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Indexes `pack` and returns verify-pack's {oid -> type} listing. */
function verify(pack: Uint8Array, name: string): Map<string, string> {
  const file = join(dir, `${name}.pack`);
  writeFileSync(file, pack);
  git(['index-pack', '-o', join(dir, `${name}.idx`), file]);
  const out = git(['verify-pack', '-v', join(dir, `${name}.idx`)]);
  const objects = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40}) (blob|tree|commit|tag)\s/.exec(line);
    if (m) objects.set(m[1]!, m[2]!);
  }
  return objects;
}

const ident = { name: 'Forge', email: 'forge@forge.invalid', time: 1_790_000_000 };

async function sampleObjects(): Promise<GitObject[]> {
  const small = await buildBlob(encode('hello\n'));
  const empty = await buildBlob(new Uint8Array(0));
  // Larger than 16 and 2048 bytes so the size varint spans several bytes.
  const big = await buildBlob(new Uint8Array(300_000).map((_, i) => (i * 7919) % 251));
  const sub = await buildTree([{ mode: '100644', name: 'big.bin', hash: big.hash }]);
  const tree = await buildTree([
    { mode: '100644', name: 'hello.txt', hash: small.hash },
    { mode: '100644', name: 'empty', hash: empty.hash },
    { mode: '40000', name: 'dir', hash: sub.hash },
  ]);
  const commit = await buildCommit({ tree: tree.hash, parents: [], author: ident, committer: ident, message: 'pack test' });
  return [commit, tree, sub, small, empty, big];
}

describe('writePack', () => {
  it('writes a pack git index-pack accepts, listing every object with its type', async () => {
    const objects = await sampleObjects();
    const pack = await writePack(objects);
    const listed = verify(pack, 'sample');
    expect(new Map(objects.map((o) => [o.hash, o.type]))).toEqual(listed);
  });

  it('starts with the v2 header and ends with the SHA-1 of everything before it', async () => {
    const objects = await sampleObjects();
    const pack = await writePack(objects);
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    expect(view.getUint32(4)).toBe(2);
    expect(view.getUint32(8)).toBe(objects.length);
    expect(hex(pack.subarray(pack.length - 20))).toBe(await sha1Hex(pack.subarray(0, pack.length - 20)));
  });

  it('accepts bare {type, content} inputs and computes the same ids as git', async () => {
    const content = encode('raw input\n');
    const pack = await writePack([{ type: 'blob', content }]);
    const listed = verify(pack, 'raw');
    const expected = git(['hash-object', '--stdin'], content).trim();
    expect([...listed.keys()]).toEqual([expected]);
  });

  it('writes each object once even when given duplicates', async () => {
    const blob = await buildBlob(encode('dup\n'));
    const pack = await writePack([blob, blob, { type: 'blob', content: encode('dup\n') }]);
    const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
    expect(view.getUint32(8)).toBe(1);
    expect([...verify(pack, 'dup').keys()]).toEqual([blob.hash]);
  });

  it('writes the empty pack for pure ref moves', async () => {
    const pack = await writePack([]);
    expect(pack).toEqual(EMPTY_PACK);
    expect(pack.length).toBe(32);
    expect(hex(pack.subarray(12))).toBe(await sha1Hex(pack.subarray(0, 12)));
    expect(verify(pack, 'empty').size).toBe(0);
  });

  it('round-trips through real git: unpack-objects stores the objects with identical content', async () => {
    const objects = await sampleObjects();
    const bare = join(dir, 'unpack.git');
    git(['init', '-q', '--bare', bare]);
    git(['-C', bare, 'unpack-objects', '-q'], await writePack(objects));
    for (const o of objects) {
      const nul = o.raw.indexOf(0);
      const r = spawnSync('git', ['-C', bare, 'cat-file', o.type, o.hash], { maxBuffer: 64 * 1024 * 1024 });
      expect(r.status).toBe(0);
      expect(new Uint8Array(r.stdout)).toEqual(o.raw.subarray(nul + 1));
    }
    expect(git(['-C', bare, 'fsck', '--strict', '--no-dangling']).trim()).toBe('');
  });
});
