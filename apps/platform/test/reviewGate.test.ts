import { describe, expect, it } from 'vitest';
import type { BranchPolicy } from '../src/services/branchRules';
import { reviewGate, type ReviewFacts } from '../src/services/reviewGate';

const policy = (agentApprovals: 'never' | 'low-risk' = 'low-risk'): BranchPolicy => ({
  ref: 'refs/heads/main',
  protected: true,
  directPush: 'denied',
  requiredChecks: [],
  requiredApprovals: 1,
  guardCompleteness: 'advisory',
  rules: ['main'],
  agentApprovals,
});

const facts = (headTier: ReviewFacts['headTier'], overrides: Partial<ReviewFacts> = {}): ReviewFacts => ({
  required: 1,
  approvals: 1,
  humans: 0,
  agentFamilyApprovals: 1,
  headTier,
  open: [],
  protectedSeen: false,
  finalSelected: false,
  finalSeen: false,
  ...overrides,
});

describe('low-risk review gate', () => {
  it('does not count agent-family approvals when the branch-rule option is off', () => {
    const gate = reviewGate(facts('read'), policy('never'));
    expect(gate.block?.code).toBe('APPROVALS_REQUIRED');
    expect(gate.block?.error).toMatch(/agent approvals.*only.*low-risk.*option/i);
    expect(gate.missing).toContain('protected-path');
    expect(gate.block?.review.approvals).toMatchObject({ agentFamilyApprovals: 1, lowRisk: false });
  });

  it.each(['read', 'receipt'] as const)('counts a different-family agent on a %s head', (headTier) => {
    const gate = reviewGate(facts(headTier), policy());
    expect(gate.block).toBeNull();
    expect(gate.missing).not.toContain('protected-path');
  });

  it.each(['scrutinize', null] as const)('refuses agent credit for a %s tier', (headTier) => {
    const gate = reviewGate(facts(headTier), policy());
    expect(gate.block?.code).toBe('APPROVALS_REQUIRED');
    expect(gate.block?.review.approvals).toMatchObject({ agentFamilyApprovals: 1, lowRisk: false });
    expect(gate.missing).toContain('protected-path');
  });

  it('refuses same-family and null-family approvals', () => {
    for (const agentFamilyApprovals of [0]) {
      const gate = reviewGate(facts('read', { agentFamilyApprovals }), policy());
      expect(gate.block?.code).toBe('APPROVALS_REQUIRED');
      expect(gate.block?.review.approvals).toMatchObject({ agentFamilyApprovals: 0, lowRisk: true });
    }
  });

  it('keeps an already-open escalation blocking a low-risk head', () => {
    const gate = reviewGate(facts('read', { open: ['reviewer-disagreement'] }), policy());
    expect(gate.block?.code).toBe('ESCALATION_OPEN');
    expect(gate.missing).not.toContain('protected-path');
  });
});

describe('guided review gates', () => {
  const noLegacyRequirements = { ...policy('never'), protected: false, requiredApprovals: 0 };

  it('blocks findings, missing required guides, and undeclared guide contracts', () => {
    expect(reviewGate(facts(null, { required: 0, blockingFindings: 1 }), noLegacyRequirements).block?.code).toBe('FINDINGS_OPEN');
    expect(reviewGate(facts(null, { required: 0, guideRequired: true }), noLegacyRequirements).block?.code).toBe('GUIDE_REQUIRED');
    expect(reviewGate(facts(null, {
      required: 0,
      guideRequired: true,
      guidePresent: true,
      undeclared: 2,
    }), noLegacyRequirements).block?.code).toBe('CONTRACT_UNDECLARED');
  });

  it('does not require a guide or block undeclared surfaces when the repo policy is off', () => {
    const gate = reviewGate(facts(null, { required: 0, guidePresent: true, undeclared: 1 }), noLegacyRequirements);
    expect(gate.block).toBeNull();
  });
});
