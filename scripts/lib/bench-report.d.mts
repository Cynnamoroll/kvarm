export interface SpanStats {
  n: number;
  min: number | null;
  p50: number | null;
  max: number | null;
}

export const BENCH_GROUPS: readonly string[];
export function spanStats(values: number[]): SpanStats;
export function cacheRate(costs: Record<string, number | string>[]): { requests: number; hits: number; rate: number };
export function renderBenchReadme(report: Record<string, any>): string;
export function checkBenchReadme(md: string): string[];
