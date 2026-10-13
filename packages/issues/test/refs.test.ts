import { describe, expect, it } from 'vitest';
import { branchIssueNumber, checkFingerprint, ISSUE_REF_LIMITS, issueRefsIn, mergeIssueRefs, normalizeFingerprint } from '../src/index';

describe('issueRefsIn', () => {
  it('reads closing keywords in every tense, with or without a colon', () => {
    const text = 'Close #1. closes #2, CLOSED #3\nfix #4 fixes: #5 Fixed #6\nresolve #7; Resolves #8 resolved #9';
    expect(issueRefsIn(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => ({ number, repo: null, kind: 'closes' })));
  });

  it('closes every issue in a list joined by commas and "and"', () => {
    expect(issueRefsIn('Fixes #10, #11 and #12, plus #13')).toEqual([
      { number: 10, repo: null, kind: 'closes' },
      { number: 11, repo: null, kind: 'closes' },
      { number: 12, repo: null, kind: 'closes' },
      { number: 13, repo: null, kind: 'refs' },
    ]);
  });

  it('reads git trailers and qualified owner/repo references', () => {
    const msg = 'parser: handle tabs\n\nLonger body mentioning #3.\n\nFixes: acme/web#41\nRefs: #7\nCloses: #8';
    expect(issueRefsIn(msg)).toEqual([
      { number: 3, repo: null, kind: 'refs' },
      { number: 41, repo: 'acme/web', kind: 'closes' },
      { number: 7, repo: null, kind: 'refs' },
      { number: 8, repo: null, kind: 'closes' },
    ]);
  });

  it('treats a negated or partial fix as a mention, not a close', () => {
    expect(issueRefsIn("This does not fix #4. It doesn't fix #5 either, and partially fixes #6.")).toEqual([
      { number: 4, repo: null, kind: 'refs' },
      { number: 5, repo: null, kind: 'refs' },
      { number: 6, repo: null, kind: 'refs' },
    ]);
  });

  it('ignores code, URL fragments and words glued to the hash', () => {
    const text = [
      'See `fixes #1` and https://example.com/page#2 or a#3 or C#4.',
      '```',
      'closes #5',
      '```',
      '~~~sh',
      'fixes #6',
      '~~~',
      'Real: fixes #7 (and #8)',
    ].join('\n');
    expect(issueRefsIn(text)).toEqual([
      { number: 7, repo: null, kind: 'closes' },
      { number: 8, repo: null, kind: 'refs' },
    ]);
  });

  it('keeps one entry per issue, the strongest kind winning', () => {
    expect(issueRefsIn('See #2 and #2. Fixes #2. Mentions acme/x#2 and fixes acme/x#2')).toEqual([
      { number: 2, repo: null, kind: 'closes' },
      { number: 2, repo: 'acme/x', kind: 'closes' },
    ]);
  });

  it('rejects zero, leading zeros, absurd numbers and malformed repos', () => {
    expect(issueRefsIn('fixes #0 #007 #99999999999 bad/re/po#3 -x/y#4 fixes #12')).toEqual([{ number: 12, repo: null, kind: 'closes' }]);
  });

  it('is bounded in references and input', () => {
    const many = Array.from({ length: ISSUE_REF_LIMITS.refsMax + 20 }, (_, i) => `#${i + 1}`).join(' ');
    expect(issueRefsIn(many)).toHaveLength(ISSUE_REF_LIMITS.refsMax);
    const late = `${'x '.repeat(ISSUE_REF_LIMITS.inputMax)} fixes #9`;
    expect(issueRefsIn(late)).toEqual([]);
    expect(issueRefsIn('')).toEqual([]);
  });
});

describe('mergeIssueRefs', () => {
  it('unions several texts, a close in any of them winning', () => {
    expect(mergeIssueRefs([issueRefsIn('Mentions #1'), issueRefsIn('fixes #1, refs #2')])).toEqual([
      { number: 1, repo: null, kind: 'closes' },
      { number: 2, repo: null, kind: 'refs' },
    ]);
  });
});

describe('branchIssueNumber', () => {
  it('finds the issue a conventional branch name carries', () => {
    const cases: Array<[string, number | null]> = [
      ['fix/123-login', 123],
      ['123-login', 123],
      ['issue-45', 45],
      ['issues/46-crash', 46],
      ['cyn/gh-47-flaky', 47],
      ['feature/#48', 48],
      ['bugfix/49', 49],
      ['refs/heads/fix/50_null_deref', 50],
    ];
    for (const [branch, n] of cases) expect(branchIssueNumber(branch), branch).toBe(n);
  });

  it('does not guess from numbers inside words or version strings', () => {
    for (const branch of ['main', 'upgrade-to-node-20', 'v2-redesign', 'feat/oauth2', 'release-1.4', 'fix/0-thing', 'agents/k3j9x2/fix-the-thing']) {
      expect(branchIssueNumber(branch), branch).toBeNull();
    }
  });
});

describe('fingerprints', () => {
  it('normalizes free-form fingerprints and rejects empty or oversized ones', () => {
    expect(normalizeFingerprint('  CI:Test  Suite\n')).toBe('ci:test suite');
    expect(normalizeFingerprint('   ')).toBeNull();
    expect(normalizeFingerprint('x'.repeat(ISSUE_REF_LIMITS.fingerprintMax + 1))).toBeNull();
    expect(normalizeFingerprint(42)).toBeNull();
  });

  it('gives each check name one stable fingerprint across failures, flakes and quarantine', () => {
    expect(checkFingerprint('test')).toBe('check:test');
    expect(checkFingerprint('  Lint ')).toBe('check:lint');
  });
});
