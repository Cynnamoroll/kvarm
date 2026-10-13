export interface AttentionFacts {
  state: string;
  escalations: string[];
  checksPending: boolean;
  checksFailing: boolean;
  blockingFindings: number;
  requestChanges: boolean;
  guideRequired: boolean;
  guidePresent: boolean;
  undeclared: number;
  approvals: number;
  required: number;
  humans: number;
  humansRequired: number;
  mergePolicy: string;
  queueState?: string | null;
}

export interface Attention {
  waitingOn: 'none' | 'human' | 'checks' | 'author' | 'reviewers' | 'queue';
  reasons: string[];
}

/** Who needs to act next, ordered by the review gate's blocking precedence. */
export function attentionFor(facts: AttentionFacts): Attention {
  if (facts.state === 'closed' || facts.state === 'merged') return { waitingOn: 'none', reasons: [] };
  if (facts.escalations.length) return { waitingOn: 'human', reasons: facts.escalations.map((reason) => `escalation:${reason}`) };
  if (facts.checksPending) return { waitingOn: 'checks', reasons: ['checks-pending'] };
  const authorReasons: string[] = [];
  if (facts.checksFailing) authorReasons.push('checks-failing');
  if (facts.blockingFindings > 0) authorReasons.push('blocking-findings');
  if (facts.requestChanges) authorReasons.push('request-changes');
  if (facts.guideRequired && !facts.guidePresent) authorReasons.push('guide-required');
  else if (facts.guideRequired && facts.undeclared > 0) authorReasons.push('contract-undeclared');
  if (authorReasons.length) return { waitingOn: 'author', reasons: authorReasons };
  const reviewerReasons: string[] = [];
  if (facts.approvals < facts.required) reviewerReasons.push('approvals-required');
  if (facts.humans < facts.humansRequired) reviewerReasons.push('human-approvals-required');
  if (reviewerReasons.length) return { waitingOn: 'reviewers', reasons: reviewerReasons };
  if (facts.queueState || facts.mergePolicy === 'queue') {
    return { waitingOn: 'queue', reasons: ['ready-for-queue'] };
  }
  if (facts.mergePolicy === 'review') return { waitingOn: 'author', reasons: ['ready-to-merge'] };
  return { waitingOn: 'queue', reasons: ['ready-for-queue'] };
}
