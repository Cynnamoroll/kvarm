/**
 * Protocol v2 ls-refs: the request we build is served by real
 * `git upload-pack --stateless-rpc`, and parsing its response yields the same
 * refs git itself reports (annotated tags peeled to their commit).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lsRefsRequest, parseLsRefs, pickRef, refCandidates } from '../src/index';

let dir = '';
let bare = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'fixture',
      GIT_AUTHOR_EMAIL: 'fixture@forge.invalid',
      GIT_COMMITTER_NAME: 'fixture',
      GIT_COMMITTER_EMAIL: 'fixture@forge.invalid',
    },
  }).trim();
}

function serve(prefixes: string[]): Uint8Array {
  const res = spawnSync('git', ['upload-pack', '--stateless-rpc', bare], {
    input: lsRefsRequest(prefixes),
    env: { ...process.env, GIT_PROTOCOL: 'version=2' },
  });
  expect(res.status, res.stderr?.toString()).toBe(0);
  return new Uint8Array(res.stdout);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitops-lsrefs-'));
  const work = join(dir, 'work');
  bare = join(dir, 'bare.git');
  git(dir, 'init', '-q', '-b', 'main', work);
  git(work, 'commit', '-q', '--allow-empty', '-m', 'one');
  git(work, 'checkout', '-q', '-b', 'feature');
  git(work, 'commit', '-q', '--allow-empty', '-m', 'two');
  git(work, 'checkout', '-q', '-b', 'main-old', 'main');
  git(work, 'tag', '-a', 'v1', '-m', 'annotated', 'feature');
  git(work, 'tag', 'light', 'main');
  git(work, 'branch', 'nested/name', 'feature');
  git(dir, 'clone', '-q', '--bare', work, bare);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ls-refs against git upload-pack', () => {
  it('returns exactly the refs under the requested prefixes', () => {
    const refs = parseLsRefs(serve(['refs/heads/main', 'refs/tags/main']));
    // ref-prefix is a prefix match: main-old comes back too and pickRef filters it.
    expect(refs.map((r) => r.name).sort()).toEqual(['refs/heads/main', 'refs/heads/main-old']);
    expect(refs.find((r) => r.name === 'refs/heads/main')!.oid).toBe(git(bare, 'rev-parse', 'refs/heads/main'));
  });

  it('peels annotated tags to their commit', () => {
    const refs = parseLsRefs(serve(refCandidates('v1')));
    const tag = refs.find((r) => r.name === 'refs/tags/v1')!;
    expect(tag.oid).toBe(git(bare, 'rev-parse', 'refs/tags/v1'));
    expect(tag.peeled).toBe(git(bare, 'rev-parse', 'v1^{commit}'));
    expect(pickRef(refs, 'v1')).toBe(git(bare, 'rev-parse', 'v1^{commit}'));
  });

  it('resolves names like git: exact full refs, tags before heads, nested branch names', () => {
    const names = ['main', 'feature', 'light', 'nested/name', 'refs/heads/feature', 'missing'];
    const refs = parseLsRefs(serve(names.flatMap(refCandidates)));
    expect(pickRef(refs, 'main')).toBe(git(bare, 'rev-parse', 'main'));
    expect(pickRef(refs, 'feature')).toBe(git(bare, 'rev-parse', 'feature'));
    expect(pickRef(refs, 'light')).toBe(git(bare, 'rev-parse', 'light^{commit}'));
    expect(pickRef(refs, 'nested/name')).toBe(git(bare, 'rev-parse', 'nested/name'));
    expect(pickRef(refs, 'refs/heads/feature')).toBe(git(bare, 'rev-parse', 'feature'));
    expect(pickRef(refs, 'missing')).toBeNull();
  });

  it('returns an empty list when nothing matches', () => {
    expect(parseLsRefs(serve(['refs/heads/nope']))).toEqual([]);
  });

  it('rejects a response that is not an ls-refs listing', () => {
    expect(() => parseLsRefs(new TextEncoder().encode('0008ERR\n'))).toThrow();
  });
});
