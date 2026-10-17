export interface MetricsQueryArguments {
  dataset: string;
  sinceHours: number;
}

export interface MetricsQueries {
  mirrorCompare: string;
  receivePack: string;
}

export function parseMetricsQueryArgs(args: readonly string[]): MetricsQueryArguments;
export function buildMetricsQueries(dataset: string, hours?: number): MetricsQueries;
