import { describe, expect, it } from 'vitest';
import {
  buildBlob,
  buildCommit,
  buildTree,
  deflate,
  inflate,
  parseRefAdvertisement,
  pktLine,
  readPktLines,
  sha1Hex,
  treeContent,
} from '../src/index';

describe('hashing', () => {
  it('computes git-compatible blob oids', async () => {
    // Known git vectors.
    expect(await buildBlob(new TextEncoder().encode(''))).toMatchObject({
      hash: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
    });
    expect(await buildBlob(new TextEncoder().encode('hello\n'))).toMatchObject({
      hash: 'ce013625030ba8dba906f756967f9e9ca394464a',
    });
    expect(await sha1Hex('foobar')).toBe('8843d7f92416211de9ebb963ff4ce28125932878');
  });
});

describe('zlib', () => {
  it('round-trips deflate/inflate', async () => {
    const data = new TextEncoder().encode('the quick brown fox jumps over the lazy dog'.repeat(100));
    const zipped = await deflate(data);
    expect(zipped.length).toBeLessThan(data.length);
    expect(new TextDecoder().decode(await inflate(zipped))).toBe(
      'the quick brown fox jumps over the lazy dog'.repeat(100),
    );
  });
});

describe('pkt-line', () => {
  it('encodes and decodes', () => {
    const buf = pktLine('hello world\n');
    const pkts = readPktLines(buf);
    expect(pkts).toHaveLength(1);
    expect(new TextDecoder().decode(pkts[0]!.data)).toBe('hello world\n');
  });

  it('handles flush packets', () => {
    const pkts = readPktLines(new TextEncoder().encode('0000'));
    expect(pkts[0]?.flush).toBe(true);
  });

  it('decodes ref advertisements', () => {
    const lines = [
      pktLine('0000000000000000000000000000000000000000 capabilities^{}\0multi_ack thin-pack symref=HEAD:refs/heads/main'),
      pktLine('0123456789012345678901234567890123456789 refs/heads/main\n'),
      pktLine('9876543210987654321098765432109876543210 refs/heads/dev\n'),
      pktLine('0000000000000000000000000000000000000000 HEAD\n'),
      new TextEncoder().encode('0000'),
    ];
    const body = new Uint8Array(lines.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of lines) {
      body.set(c, off);
      off += c.length;
    }
    const { refs } = parseRefAdvertisement(body);
    expect(refs.find((r) => r.name === 'HEAD')?.target).toBe('refs/heads/main');
    expect(refs.find((r) => r.name === 'refs/heads/main')?.hash).toBe(
      '0123456789012345678901234567890123456789',
    );
  });
});

describe('tree and commit objects', () => {
  it('builds a git-compatible tree', async () => {
    const blob = await buildBlob(new TextEncoder().encode('hello\n'));
    // `git mktree` vector for a single 100644 file "a.txt" with that blob.
    const tree = await buildTree([{ mode: '100644', name: 'a.txt', hash: blob.hash }]);
    expect(tree.hash).toBe('2e81171448eb9f2ee3821e3d447aa6b2fe3ddba1');
    expect(treeContent([{ mode: '100644', name: 'a.txt', hash: blob.hash }]).length).toBe(
      7 + 6 + 20,
    );
  });

  it('sorts tree entries git-style (directories compare with trailing slash)', async () => {
    const entries = [
      { mode: '100644', name: 'foo.txt', hash: 'a'.repeat(40) },
      { mode: '40000', name: 'bar', hash: 'b'.repeat(40) },
      { mode: '100644', name: 'bar.txt', hash: 'c'.repeat(40) },
    ];
    const content = treeContent(entries);
    const text = new TextDecoder('latin1').decode(content);
    // "bar" (tree) sorts as "bar/" so it comes after "bar.txt".
    expect(text.indexOf('bar.txt')).toBeLessThan(text.indexOf('40000 bar'));
  });

  it('builds a git-compatible commit', async () => {
    const blob = await buildBlob(new TextEncoder().encode('hello\n'));
    const tree = await buildTree([{ mode: '100644', name: 'a.txt', hash: blob.hash }]);
    const commit = await buildCommit({
      tree: tree.hash,
      parents: [],
      author: { name: 'A U Thor', email: 'author@example.com', time: 1720000000, tz: '+0000' },
      committer: { name: 'C O Mitter', email: 'committer@example.com', time: 1720000000, tz: '+0000' },
      message: 'initial\n',
    });
    const text = new TextDecoder().decode(commit.raw);
    expect(text).toContain(`tree ${tree.hash}\n`);
    expect(text).toContain('author A U Thor <author@example.com> 1720000000 +0000\n');
    expect(text).toContain('\n\ninitial\n');
  });
});
