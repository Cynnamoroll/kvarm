export const DEFAULT_TARGET: string;

export interface Citation {
  line: number;
  section: string;
  target: string;
  text: string;
}

export interface FileCitation extends Citation {
  path: string;
}

export interface UnresolvedCitation extends FileCitation {
  reason: 'missing-document' | 'missing-section';
}

export function collectSections(markdown: string): Set<string>;
export function findCitations(text: string): Citation[];
export function checkCitations(
  files: { path: string; text: string }[],
  docs: Map<string, string>,
): { resolved: FileCitation[]; unresolved: UnresolvedCitation[] };
