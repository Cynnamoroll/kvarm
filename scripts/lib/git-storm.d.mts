export const GIT_STORM_LIMITS: Readonly<{ http: 5; git: 3; requests: 10000; dedicatedGit: 64 }>;
export function percentile(values: number[], p: number): number | null;
export function summarize(values: number[]): { n: number; min: number | null; mean: number | null; p50: number | null; p90: number | null; p99: number | null; max: number | null };
export function checkGitStormCaps(options: { target: string; concurrency: number; dedicated?: boolean; dedicatedHost?: string; targetHost?: string }): string | null;
export function gitAuthorization(mode: string, token?: string, username?: string): string | null;
export function writerCredentials(env?: { KVARM_PATS?: string; KVARM_PAT?: string }): string[];
export function credentialForWriter<T>(credentials: readonly T[], writer: number): T | null;
export function redactCredentials(text: string, tokens: readonly string[]): string;
export function benchBranch(ts: number | string, workload: string, suffix: number | string): string;
export function validateExistingRepoTarget(options: { benchId?: string; repo?: string; workloads: string[] }): string | null;
export function resolveRemoteOwner(options: {
  target: string;
  configuredOwner?: string;
  token?: string;
  fetchImpl?: typeof fetch;
}): Promise<string>;
export function scratchDeleteError(status: number, owner: string, repo: string): string | null;
export function createRandom(seed?: number): () => number;
export function fixtureFiles(fixture: 'small' | 'mixed' | 'large', seed?: number): Array<[string, string]>;
export function operationSummary(
  samples: Array<{ start?: number; end?: number; ms: number; ok: boolean; status?: number; attempts?: number; message?: string }>,
  requests: Array<{ op: string; status: number; reqBytes: number; resBytes: number; cost?: Record<string, number> }>,
): {
  metrics: { latencyMs: { n: number }; giveUps: number };
  errors: Record<string, number>;
  requests: Record<string, number>;
  totalRequests: number;
  totalReqBytes: number;
  totalResBytes: number;
  cost: Record<string, { median: Record<string, number | null>; total: Record<string, number> }>;
};
export function opForPath(path: string): string;
