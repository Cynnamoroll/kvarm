import { describe, expect, it } from 'vitest';
import { remainingFor, type RemainingInput } from '../src/services/remaining';

const input = (overrides: Partial<RemainingInput> = {}): RemainingInput => ({
  change: {
    state: 'open',
    mergePolicy: 'review',
    author: { principal: 'user:author', login: 'author' },
    queueState: null,
    conflicts: [],
  },
  blockers: [],
  approvals: { count: 0, required: 0, humans: 0, humansRequired: 0, agentFamilyApprovals: 0, lowRisk: false },
  agentApprovals: 'never',
  mergeability: { status: 'clean', mergeable: true, checks: { state: 'success', required: [] } },
  dependency: null,
  resolveConflictTaskOpen: false,
  viewer: { principal: 'user:reviewer', login: 'reviewer', kind: 'human', writeAccess: true },
  ...overrides,
});

describe('remainingFor', () => {
  it('returns blockers in the prescribed order and names conflicts and failed checks', () => {
    const items = remainingFor(input({
      change: { ...input().change, mergePolicy: 'draft', state: 'conflicted', conflicts: [{ path: 'src/a.ts' }] },
      mergeability: {
        status: 'conflicts',
        mergeable: false,
        conflicts: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
        checks: {
          state: 'failure',
          required: [
            { name: 'ci/test', state: 'failure' },
            { name: 'ci/lint', state: 'pending' },
          ],
        },
      },
      dependency: { code: 'DEPENDENCY_STALE' },
      blockers: [
        { code: 'REVIEWS_REQUIRED', error: 'requires 2 approvals; 0 so far' },
        { code: 'APPROVALS_REQUIRED', error: 'requires 1 approval; 0 so far' },
        { code: 'ESCALATION_OPEN', error: 'open escalation(s) need a human' },
      ],
      approvals: { count: 0, required: 2, humans: 0, humansRequired: 1, agentFamilyApprovals: 0, lowRisk: false },
      resolveConflictTaskOpen: true,
      viewer: { principal: 'user:author', login: 'author', kind: 'human', writeAccess: true },
    }));
    expect(items.map((item) => item.code)).toEqual([
      'DRAFT',
      'CONFLICTS',
      'CHECKS_FAILED',
      'CHECKS_PENDING',
      'DEPENDENCY',
      'ESCALATION_OPEN',
      'APPROVALS_REQUIRED',
      'REVIEWS_REQUIRED',
    ]);
    expect(items[1]).toMatchObject({ paths: ['src/a.ts', 'src/b.ts'], you: true });
    expect(items[1]?.summary).toContain('task is open');
    expect(items[2]?.summary).toContain('ci/test');
    expect(items[3]?.summary).toContain('ci/lint');
    expect(items[0]?.you).toBe(true);
    expect(items[2]?.you).toBe(true);
    expect(items[5]?.who).toBe('human');
    expect(items.every((item) => item.summary.length <= 90)).toBe(true);
  });

  it('describes eligible different-family approvals and scrutiny-gated human approvals', () => {
    const blocker = [{ code: 'APPROVALS_REQUIRED' }];
    const eligible = remainingFor(input({
      blockers: blocker,
      approvals: { count: 1, required: 1, humans: 0, humansRequired: 2, agentFamilyApprovals: 1, lowRisk: true },
      agentApprovals: 'low-risk',
    }));
    expect(eligible[0]?.summary).toBe('Need 2 human approvals; 1 so far. Different-family agents may count for this low-risk head.');

    const scrutinize = remainingFor(input({
      blockers: blocker,
      approvals: { count: 1, required: 1, humans: 0, humansRequired: 2, agentFamilyApprovals: 1, lowRisk: false },
      agentApprovals: 'low-risk',
    }));
    expect(scrutinize[0]?.summary).toBe('Need 2 human approvals; 0 so far. A human must approve because this head requires scrutiny.');
  });

  it('pluralizes structured review counts without parsing blocker errors', () => {
    const items = remainingFor(input({
      blockers: [{ code: 'REVIEWS_REQUIRED' }, { code: 'APPROVALS_REQUIRED' }],
      approvals: { count: 0, required: 1, humans: 1, humansRequired: 2, agentFamilyApprovals: 0, lowRisk: false },
    }));
    expect(items.map((item) => item.summary)).toEqual([
      'Need 2 human approvals; 1 so far',
      'Need 1 approving review; 0 so far',
    ]);
    expect(remainingFor(input({
      blockers: [{ code: 'REVIEWS_REQUIRED' }, { code: 'APPROVALS_REQUIRED' }],
      approvals: { count: 1, required: 2, humans: 0, humansRequired: 1, agentFamilyApprovals: 0, lowRisk: false },
    })).map((item) => item.summary)).toEqual([
      'Need 1 human approval; 0 so far',
      'Need 2 approving reviews; 1 so far',
    ]);
  });

  it('marks review and human actions for eligible non-author viewers only', () => {
    const blockers = [
      { code: 'APPROVALS_REQUIRED' },
      { code: 'ESCALATION_OPEN' },
      { code: 'REVIEWS_REQUIRED' },
    ];
    const reviewer = remainingFor(input({ blockers }));
    expect(reviewer.map((item) => item.you)).toEqual([true, true, true]);
    const author = remainingFor(input({
      blockers,
      viewer: { principal: 'user:author', login: 'author', kind: 'human', writeAccess: true },
    }));
    expect(author.map((item) => item.you)).toEqual([false, false, false]);
    const readOnly = remainingFor(input({
      blockers,
      viewer: { principal: 'user:reviewer', login: 'reviewer', kind: 'human', writeAccess: false },
    }));
    expect(readOnly.map((item) => item.you)).toEqual([false, false, false]);
  });

  it('identifies ready, queued and unknown states without inventing readiness for terminal changes', () => {
    expect(remainingFor(input()).map((item) => item.code)).toEqual(['READY']);
    expect(remainingFor(input({ change: { ...input().change, queueState: 'queued' } })).map((item) => item.code)).toEqual(['QUEUED']);
    const unknown = remainingFor(input({
      mergeability: { status: 'unknown', mergeable: false, checks: null, unknownReason: 'tree budget exceeded' },
    }));
    expect(unknown).toEqual([expect.objectContaining({ code: 'UNKNOWN', summary: 'tree budget exceeded' })]);
    expect(remainingFor(input({
      mergeability: { status: 'unrelated', mergeable: false, checks: null },
    }))).toEqual([expect.objectContaining({ code: 'UNKNOWN', summary: 'The change and target have no shared history.' })]);
    expect(remainingFor(input({
      mergeability: { status: 'up-to-date', mergeable: false, checks: null },
    }))).toEqual([expect.objectContaining({ code: 'UNKNOWN', summary: 'The change is already contained in the target.' })]);
    expect(remainingFor(input({ change: { ...input().change, state: 'merged' }, mergeability: null }))).toEqual([]);
  });
});
