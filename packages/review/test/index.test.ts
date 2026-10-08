import { describe, expect, it } from 'vitest';
import { clampScore } from '../src/index';

describe('clampScore', () => {
  it('rounds and clamps to 0..100', () => {
    expect(clampScore(42.4)).toBe(42);
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(250)).toBe(100);
  });

  it('scores non-finite input as 0', () => {
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
