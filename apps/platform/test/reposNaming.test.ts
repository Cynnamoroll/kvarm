import { describe, expect, it } from 'vitest';
import { artifactsRepoName } from '../src/db/repos';

describe('artifactsRepoName', () => {
  it('is injective: distinct owner/repo pairs never share an Artifacts repository', () => {
    // The flat namespace splits on the one `--` separator, so owner `a--b`
    // with repo `c` must not collide with owner `a` and repo `b--c`.
    expect(artifactsRepoName('a--b', 'c')).toBe('a-b--c');
    expect(artifactsRepoName('a', 'b--c')).toBe('a--b-c');
    expect(artifactsRepoName('a--b', 'c')).not.toBe(artifactsRepoName('a', 'b--c'));
  });

  it('is case-folded and keeps the allowed charset', () => {
    expect(artifactsRepoName('A-B', 'C.D_e')).toBe('a-b--c.d_e');
    // Non-ASCII becomes a dash; an edge dash is stripped, not kept.
    expect(artifactsRepoName('Ünicode Org', 'repo')).toBe('nicode-org--repo');
  });

  it('never lets a component smuggle a second separator', () => {
    for (const [owner, name] of [
      ['a-', '-b'],
      ['-a', 'b-'],
      ['a  b', 'c'],
      ['--a', '--b'],
      ['-', '---'],
    ] as const) {
      expect(artifactsRepoName(owner, name), `${owner}/${name}`).not.toContain('---');
    }
  });
});
