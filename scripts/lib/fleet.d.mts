export interface CampaignLimits {
  gitChildren: number;
  httpInFlight: number;
  ceiling: number;
  gitWritesPerMin: number;
  gitHttpPerOp: number;
}

export const CAMPAIGN_LIMITS: Readonly<CampaignLimits>;
export const CONFIG_PATH: string;
export const CONFIG_LINES: number;

export interface FleetMember {
  index: number;
  key: string;
  role: 'sentinel' | 'chain' | 'independent' | 'nonoverlap' | 'identical' | 'conflict';
  marker: string;
  chain?: 'A' | 'B' | 'C';
  line?: number;
  lineMarker?: string;
  lineText?: string;
}

export interface FleetPlan {
  workspaces: number;
  ts: number;
  members: FleetMember[];
  sentinel: string;
  chain: { A: string; B: string; C: string };
  overlapKeys: string[];
  expectedPairs: Set<string>;
  pairKey(a: string, b: string): string;
  burst: string[];
  enqueueOrder: string[];
  identicalMarker: string;
  config: string;
}

export function configText(lines?: number): string;
export function editLine(text: string, lineNo: number, content: string): string;
export function planFleet(opts: { workspaces?: number; ts: number }): FleetPlan;
export function memberFiles(plan: FleetPlan, member: FleetMember, parentConfig?: string): Record<string, string>;

export interface ProjectionItem {
  stage: string;
  label: string;
  http: number;
  git: number;
  requests: number;
}

export interface Projection {
  items: ProjectionItem[];
  total: number;
  gitOps: number;
  opts: Record<string, number>;
  gitWritesPerMinute: number;
  background: { label: string; count: number }[];
}

export function projectCampaign(plan: FleetPlan, opts?: Record<string, number>): Projection;
export function checkProjection(projection: Projection, limits: CampaignLimits): { fits: boolean; problems: string[] };

export class CeilingExceeded extends Error {}
export class CampaignAbort extends Error {}

export interface InvariantResult {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}
export function createInvariants(o: { log: (line: string) => void; stage: () => string }): {
  results: InvariantResult[];
  check(id: string, label: string, ok: unknown, detail?: string): boolean;
  gate(id: string, label: string, ok: unknown, detail?: string): void;
};
export function forecastMemberSet(o: {
  status: number;
  matches: { workspace: string }[] | undefined;
  idToKey: Map<string, string>;
  overlapKeys: string[];
}): { ok: boolean; size: number };

export class RequestLedger {
  constructor(ceiling: number);
  ceiling: number;
  total: number;
  byKind: Record<string, number>;
  byLabel: Record<string, number>;
  reserve(kind: string, n?: number, label?: string): void;
}

export interface Limiter {
  peak: number;
  readonly active: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLimiter(max: number): Limiter;
export function retryAfterMs(header: string | null | undefined, fallbackMs: number, capMs: number): number;
export function parseCost(header: string | null | undefined): Record<string, number | string>;
export function sumCosts(list: Record<string, number | string>[]): Record<string, number>;
export function withinBudget(cost: Record<string, number | string>, spec: string): { ok: boolean; violations: string[] };

export interface PublicationRows {
  unpinned: string;
  pinned: string;
}
export const BUDGET_ROWS: Readonly<{
  workspaceList: string;
  overlap: string;
  forecast: string;
  enqueue: string;
  publication: Readonly<PublicationRows>;
}>;
export const CHECK_IDS: Readonly<{ publication: string; monetary: string }>;
export interface PublicationClass {
  row: string;
  total: number;
  within: number;
}
export interface PublicationOutside {
  number: number;
  pinned: boolean;
  row: string;
  cost: string;
  violations: string[];
}
export function comparePublications(
  pubs: { number: number; cost: Record<string, number | string> }[],
  pinnedNumbers: ReadonlySet<number>,
  rows: PublicationRows,
): { ok: boolean; classes: { unpinned: PublicationClass; pinned: PublicationClass }; outside: PublicationOutside[]; detail: string };
export function endpointClass(method: string, url: string): string;

export interface AcceptedPublication {
  number: number;
  headSha: string;
  mergeCommit: string;
  previous?: string;
}

export function verifyGraph(input: {
  firstParent: { sha: string; parents: string[] }[];
  seed: string;
  accepted: AcceptedPublication[];
  ledgerCommits: Set<string>;
}): { ok: boolean; problems: string[]; order: number[] };

export function longestQueueIdle(
  rows: { change_number: number; state: string; reason_code: string | null; enqueued_at: number; updated_at: number }[],
): { ms: number; fromMs: number; toMs: number; endedBy: string } | null;

export function verifyNotes(input: { notesList: string | null; expected: string[] }): {
  ok: boolean;
  missing: string[];
  unexpected: string[];
  noted: number;
};

export function countMarkers(files: { path: string; text: string }[], markers: string[]): Map<string, number>;

export function reconcileWorkspaces(input: {
  created: { id: string; expect: string }[];
  abandoned?: string[];
  listed: { id: string; status: string }[];
}): {
  ok: boolean;
  byStatus: Record<string, number>;
  missing: string[];
  unexpected: string[];
  mismatched: { id: string; expected: string; actual: string }[];
};

export function percentile(values: number[], p: number): number | null;
export function aggregateTrainPhases(entries: Array<Record<string, number | undefined>>): Record<string, { n: number; p50: number | null; p90: number | null; max: number }>;
export function findMonetary(text: string): string[];
export function renderBenchmarkMarkdown(report: Record<string, any>): string;
