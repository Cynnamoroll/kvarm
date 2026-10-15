import { describe, expect, it } from 'vitest';
import { artifactsRepoName } from '../src/db/repos';

describe('artifactsRepoName', () => {
  it('uses a per-instance random suffix and keeps the allowed charset', () => {
    const first = artifactsRepoName('A-B', 'C.D_e');
    const second = artifactsRepoName('A-B', 'C.D_e');
    expect(first).toMatch(/^a-b--c\.d_e--[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(63);
  });

  it('caps the name parts without truncating the suffix and starts alphanumerically', () => {
    const generated = artifactsRepoName('___owner...', 'repo'.repeat(30));
    expect(generated).toHaveLength(63);
    expect(generated).toMatch(/^[a-z0-9][a-z0-9._-]*--[a-z0-9][a-z0-9._-]*--[0-9a-f]{8}$/);
    expect(generated).not.toContain('---');
  });

  it('sanitizes non-ASCII input and supplies a valid owner when sanitization empties it', () => {
    expect(artifactsRepoName('Ünicode Org', 'repo')).toMatch(/^nicode-org--repo--[0-9a-f]{8}$/);
    expect(artifactsRepoName('___', 'repo')).toMatch(/^repo--repo--[0-9a-f]{8}$/);
  });
});
