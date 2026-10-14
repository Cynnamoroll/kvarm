export type RemainingWho = 'human' | 'reviewer' | 'author' | 'ci' | 'train' | 'dependency';

export interface RemainingItem {
  code: string;
  who: RemainingWho;
  summary: string;
  you: boolean;
  paths?: string[];
}

export interface RemainingInput {
  change: {
    state: 'open' | 'conflicted' | 'merged' | 'closed';
    mergePolicy: 'auto' | 'draft' | 'review';
    author: { principal?: string | null; login?: string | null; agentId?: string | null };
    queueState: string | null;
    conflicts: readonly { path: string }[];
  };
  blockers: readonly { code: string; error?: string }[];
  approvals: {
    count: number;
    required: number;
    humans: number;
    humansRequired: number;
    agentFamilyApprovals: number;
    lowRisk: boolean;
  } | null;
  agentApprovals: 'never' | 'low-risk';
  mergeability: {
    status: string;
    mergeable: boolean;
    conflicts?: readonly { path: string }[];
    checks: { state: 'success' | 'pending' | 'failure'; required: readonly { name: string; state: 'success' | 'pending' | 'failure' }[] } | null;
    unknownReason?: string;
  } | null;
  dependency: { code: string; error?: string } | null;
  resolveConflictTaskOpen: boolean;
  requestedReviewers?: readonly string[];
  viewer: { principal: string | null; login: string | null; kind: 'human' | 'agent' | null; writeAccess: boolean };
}

function shorten(text: string, max = 90): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function samePrincipal(input: RemainingInput): boolean {
  const { author } = input.change;
  if (author.principal) return author.principal === input.viewer.principal;
  if (author.agentId) return input.viewer.principal === `agent:${author.agentId}`;
  return Boolean(author.login && input.viewer.login && author.login === input.viewer.login);
}

function reviewSummary(
  code: string,
  approvals: RemainingInput['approvals'],
  agentApprovals: RemainingInput['agentApprovals'],
  requestedReviewers: readonly string[] = [],
): string {
  if (code === 'ESCALATION_OPEN') return 'A human must resolve the open escalation.';
  const requested = (code === 'APPROVALS_REQUIRED' || code === 'REVIEWS_REQUIRED') && requestedReviewers.length
    ? `Requested reviewers: ${requestedReviewers.join(', ')}.`
    : '';
  if (approvals) {
    const count = code === 'APPROVALS_REQUIRED'
      ? approvals.humans + (approvals.lowRisk ? approvals.agentFamilyApprovals : 0)
      : approvals.count;
    const required = code === 'APPROVALS_REQUIRED' ? approvals.humansRequired : approvals.required;
    const noun = code === 'APPROVALS_REQUIRED'
      ? required === 1 ? 'human approval' : 'human approvals'
      : required === 1 ? 'approving review' : 'approving reviews';
    const text = `Need ${required} ${noun}; ${count} so far`;
    if (code === 'APPROVALS_REQUIRED' && agentApprovals === 'low-risk') {
      const summary = approvals.lowRisk
        ? `${text}. Different-family agents may count for this low-risk head.`
        : `${text}. A human must approve because this head requires scrutiny.`;
      return requested ? `${summary} ${requested}` : summary;
    }
    return requested ? `${text}. ${requested}` : text;
  }
  if (code === 'APPROVALS_REQUIRED') {
    const summary = 'A human approval is required by branch policy.';
    return requested ? `${summary} ${requested}` : summary;
  }
  return 'More distinct reviewers must approve this head.';
}

function dependencySummary(code: string): string {
  if (code === 'DEPENDENCY_STALE') return 'A pinned workspace revision is stale; repin or detach it.';
  if (code === 'DEPENDENCY_BROKEN') return 'A pinned workspace is broken; repin or detach it.';
  if (code === 'DEPENDENCY_PENDING') return 'A pinned workspace must land first.';
  return 'Resolve the workspace dependency before merging.';
}

export function remainingFor(input: RemainingInput): RemainingItem[] {
  const { change, mergeability, viewer } = input;
  if (change.state === 'closed' || change.state === 'merged') return [];

  const author = samePrincipal(input);
  const items: RemainingItem[] = [];

  if (change.mergePolicy === 'draft') {
    items.push({ code: 'DRAFT', who: 'author', summary: 'This change is a draft; switch it to review or auto.', you: author });
  }

  const conflicts = [...new Set([...(mergeability?.conflicts ?? []), ...change.conflicts].map((item) => item.path))].sort();
  if (change.state === 'conflicted' || mergeability?.status === 'conflicts' || conflicts.length > 0) {
    const task = input.resolveConflictTaskOpen ? 'A resolve-conflict task is open.' : 'No resolve-conflict task is open.';
    items.push({
      code: 'CONFLICTS',
      who: 'author',
      summary: shorten(`Resolve conflicts in ${conflicts.length || 'the listed'} path(s). ${task}`),
      you: author,
      ...(conflicts.length ? { paths: conflicts } : {}),
    });
  }

  const failed = mergeability?.checks?.required.filter((check) => check.state === 'failure').map((check) => check.name) ?? [];
  if (mergeability?.checks && (mergeability.checks.state === 'failure' || failed.length > 0)) {
    items.push({
      code: 'CHECKS_FAILED',
      who: 'author',
      summary: shorten(failed.length ? `Failed checks: ${failed.join(', ')}.` : 'A required check failed.'),
      you: author,
    });
  }

  const pending = mergeability?.checks?.required.filter((check) => check.state === 'pending').map((check) => check.name) ?? [];
  if (mergeability?.checks && (mergeability.checks.state === 'pending' || pending.length > 0)) {
    items.push({
      code: 'CHECKS_PENDING',
      who: 'ci',
      summary: shorten(pending.length ? `Waiting on checks: ${pending.join(', ')}.` : 'Waiting for required checks to finish.'),
      you: false,
    });
  }

  if (input.dependency) {
    items.push({ code: 'DEPENDENCY', who: 'dependency', summary: dependencySummary(input.dependency.code), you: false });
  }

  for (const blocker of input.blockers.filter((item) => item.code === 'ESCALATION_OPEN')) {
    items.push({
      code: 'ESCALATION_OPEN',
      who: 'human',
      summary: reviewSummary(blocker.code, input.approvals, input.agentApprovals, input.requestedReviewers),
      you: viewer.kind === 'human' && viewer.writeAccess && !author,
    });
  }
  for (const blocker of input.blockers.filter((item) => item.code === 'APPROVALS_REQUIRED')) {
    items.push({
      code: 'APPROVALS_REQUIRED',
      who: 'human',
      summary: reviewSummary(blocker.code, input.approvals, input.agentApprovals, input.requestedReviewers),
      you: viewer.kind === 'human' && viewer.writeAccess && !author,
    });
  }
  for (const blocker of input.blockers.filter((item) => item.code === 'REVIEWS_REQUIRED')) {
    items.push({
      code: 'REVIEWS_REQUIRED',
      who: 'reviewer',
      summary: reviewSummary(blocker.code, input.approvals, input.agentApprovals, input.requestedReviewers),
      you: viewer.writeAccess && Boolean(viewer.principal) && !author,
    });
  }

  const knownConflict = change.state === 'conflicted' || mergeability?.status === 'conflicts' || conflicts.length > 0;
  const terminalReason =
    mergeability?.status === 'unrelated'
      ? 'The change and target have no shared history.'
      : mergeability?.status === 'up-to-date'
        ? 'The change is already contained in the target.'
        : undefined;
  const unknown =
    mergeability?.status === 'unknown' ||
    (mergeability === null && change.state === 'open') ||
    (mergeability !== null && mergeability.checks === null && !knownConflict) ||
    terminalReason !== undefined;
  if (unknown) {
    items.push({
      code: 'UNKNOWN',
      who: 'ci',
      summary: shorten(terminalReason ?? mergeability?.unknownReason ?? 'Mergeability could not be evaluated.'),
      you: false,
    });
  }

  if (items.length === 0 && change.state === 'open' && mergeability?.mergeable) {
    if (change.queueState !== null) {
      items.push({ code: 'QUEUED', who: 'train', summary: 'All gates passed; this change is waiting in the train.', you: false });
    } else {
      items.push({
        code: 'READY',
        who: 'human',
        summary: 'All gates pass. A repository writer can merge this change.',
        you: viewer.kind === 'human' && viewer.writeAccess,
      });
    }
  }

  return items;
}
