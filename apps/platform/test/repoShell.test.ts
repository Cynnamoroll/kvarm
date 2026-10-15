/**
 * The repo header marks the deployment's example repository: a description
 * that opens with "Demo" opts the repo into a demo badge.
 */

import { describe, expect, it } from 'vitest';
import { isDemoRepo } from '../src/render/repoShell.js';

describe('isDemoRepo', () => {
  it('matches a description that opens with the word demo, in any case', () => {
    expect(isDemoRepo('Demo — an example import of colinhacks/zod')).toBe(true);
    expect(isDemoRepo('demo repository for the contest')).toBe(true);
    expect(isDemoRepo('  Demo: kvarm on a real repo')).toBe(true);
  });

  it('does not match descriptions that merely mention demos or other repos', () => {
    expect(isDemoRepo('Imported from https://github.com/colinhacks/zod')).toBe(false);
    expect(isDemoRepo('This repo demos the platform')).toBe(false);
    expect(isDemoRepo('Demonstration notes')).toBe(false);
    expect(isDemoRepo('')).toBe(false);
    expect(isDemoRepo(null)).toBe(false);
  });
});
