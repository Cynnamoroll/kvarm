export interface BenchResources {
  prefix: string;
  worker: string;
  d1: string;
  bucket: string;
  queue: string;
  deadLetterQueue: string;
  namespace: string;
  seedRepo: string;
}

export function emptyBenchBucket(options: {
  id: string;
  bucketName: string;
  accountId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ deleted: number }>;
export function benchResources(id: string): BenchResources;
export function benchmarkConfig(base: any, resources: BenchResources, databaseId?: string): any;
export function subscribeBenchRepo(resources: BenchResources, repo: string, wrangler: (args: string[]) => Promise<any>): Promise<{ created: boolean; name: string }>;
export function unsubscribeBenchRepo(resources: BenchResources, repo: string, wrangler: (args: string[]) => Promise<any>): Promise<{ deleted: boolean; name: string }>;
export function emptyBenchBucket(options: {
  id: string;
  bucketName: string;
  accountId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ deleted: number }>;
export function runBenchStack(options: {
  action: string;
  id: string;
  repo?: string;
  baseConfig: any;
  wrangler: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  accountId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
  writeConfig?: (config: any) => Promise<void>;
  removeConfig?: () => Promise<void>;
}): Promise<any>;
