export interface CostRow {
  section: string;
  line: number;
  header: string[];
  cells: string[];
  endpoint: string;
  state: string | null;
}

export type Cost = Record<string, number | string>;

export interface Sample {
  status?: number;
  cost: Cost;
  extra?: any;
  label?: string;
}

export interface CatalogEntry {
  id: string;
  section?: string;
  row?: string;
  state?: string;
  exact?: boolean;
  exactState?: boolean;
  kind?: 'live' | 'nonlive';
  probe?: string;
  budget?: string | ((s: any) => string);
  status?: number | number[];
  minSamples?: number;
  aggregate?: (samples: any[]) => string[];
  category?: string;
  reason?: string;
}

export interface Verdict {
  id?: string;
  status: 'pass' | 'fail' | 'missing' | 'n/a';
  n?: number;
  budget?: string;
  median?: Cost;
  problems?: string[];
  category?: string;
  reason?: string;
}

export function splitRow(line: string): string[];
export function normalizeCell(text: string | null | undefined): string;
export function parseCostTables(md: string): CostRow[];
export function matchCatalog<E extends { id: string; section?: string; row?: string; state?: string; exact?: boolean; exactState?: boolean }>(
  rows: CostRow[],
  catalog: E[],
): { matched: Map<CostRow, E>; unmatched: CostRow[]; ambiguous: { row: CostRow; entries: E[] }[]; unused: E[] };
export function checkBudget(cost: Cost | null | undefined, spec: string): { ok: boolean; violations: string[] };
export function medianCounters(costs: Cost[]): Cost;
export function evaluateEntry(entry: CatalogEntry, samplesByProbe: Map<string, Sample[]>): Verdict;
export function summarizeVerdicts(
  verdicts: { status: string }[],
  coverage: { unmatched: unknown[]; ambiguous: unknown[]; unused: unknown[] },
): {
  rows: number;
  pass: number;
  fail: number;
  missing: number;
  na: number;
  unmatched: number;
  ambiguous: number;
  unused: number;
  ok: boolean;
};
