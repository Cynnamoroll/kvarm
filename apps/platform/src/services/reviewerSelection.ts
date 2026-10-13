import { modelFamilyEvidence, weakerEvidence, type EvidenceLevel } from './provenance';
import { HUMAN_MODEL_FAMILY } from './reviewGate';
import type { AuthorView } from './reviews';

export interface ReviewerCandidate {
  principal: string;
  agent: { id: string; name: string; owner: string };
  modelFamily: string | null;
  modelFamilyEvidence: EvidenceLevel | null;
  differentFamily: boolean;
  differentFamilyEvidence: EvidenceLevel | null;
  eligible: boolean;
  ineligibleReason?: 'author' | 'already-reviewed';
}

export type ReviewerSelectionAuthor = Pick<AuthorView, 'principal' | 'modelFamily' | 'modelFamilyEvidence'>;

export interface ReviewerCandidateRow {
  id: string;
  name: string;
  owner_login: string;
  model_family: string | null;
  reviewed: number;
}

export function reviewAuthorSelection(
  agentMeta: string | null,
  authorId: string | null,
  authorFamily: string | null,
): ReviewerSelectionAuthor & { kind: 'user' | 'agent'; agent: { id: string; name: string } | null } {
  let agent: { id: string; name: string } | null = null;
  if (agentMeta) {
    try {
      const value = JSON.parse(agentMeta) as { agentId?: unknown; agentName?: unknown };
      if (typeof value.agentId === 'string' && typeof value.agentName === 'string') agent = { id: value.agentId, name: value.agentName };
    } catch {
      agent = null;
    }
  }
  const kind = agent ? 'agent' : 'user';
  const modelFamily = agent ? authorFamily : HUMAN_MODEL_FAMILY;
  return {
    principal: agent ? `agent:${agent.id}` : authorId ? `user:${authorId}` : null,
    kind,
    agent,
    modelFamily,
    modelFamilyEvidence: modelFamilyEvidence(modelFamily, kind === 'user'),
  };
}

export function reviewerCandidates(
  author: Pick<AuthorView, 'principal' | 'modelFamily' | 'modelFamilyEvidence'>,
  rows: ReviewerCandidateRow[],
): ReviewerCandidate[] {
  return rows.map((row) => {
    const principal = `agent:${row.id}`;
    const ineligible = principal === author.principal ? 'author' : row.reviewed ? 'already-reviewed' : null;
    return {
      principal,
      agent: { id: row.id, name: row.name, owner: row.owner_login },
      modelFamily: row.model_family,
      modelFamilyEvidence: modelFamilyEvidence(row.model_family, false),
      differentFamily: row.model_family !== null && author.modelFamily !== null && row.model_family !== author.modelFamily,
      differentFamilyEvidence: weakerEvidence(modelFamilyEvidence(row.model_family, false), author.modelFamilyEvidence),
      eligible: ineligible === null,
      ...(ineligible ? { ineligibleReason: ineligible } : {}),
    };
  });
}

export function selectReviewer(candidates: ReviewerCandidate[]): ReviewerCandidate | null {
  const eligible = candidates.filter((candidate) => candidate.eligible);
  return eligible.find((candidate) => candidate.differentFamily) ?? eligible[0] ?? null;
}
