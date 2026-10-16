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
export function benchmarkConfig(base: any, resources: BenchResources, databaseId?: string, mirrorMode?: 'off' | 'shadow' | 'on'): any;
export function assertArtifactsNamespace(namespace: string | undefined, resources: BenchResources): void;
export function patKeys(count: number): string[];
export function withPatList(text: string, keys: readonly string[]): string;
export function withBenchUser(text: string, id: string): string;
export function subscribeBenchRepo(resources: BenchResources, repo: string, wrangler: (args: string[], options?: { input?: string }) => Promise<any>): Promise<{ created: boolean; name: string }>;
export function unsubscribeBenchRepo(resources: BenchResources, repo: string, wrangler: (args: string[], options?: { input?: string }) => Promise<any>): Promise<{ deleted: boolean; name: string }>;
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
  mirrorMode?: 'off' | 'shadow' | 'on';
  baseConfig: any;
  wrangler: (args: string[], options?: { input?: string }) => Promise<{ code: number; stdout: string; stderr: string }>;
  accountId?: string;
  apiToken?: string;
  fetchImpl?: typeof fetch;
  writeConfig?: (config: any) => Promise<void>;
  removeConfig?: () => Promise<void>;
  patFile?: string;
  mintPat?: (databaseId: string, tokenFile: string, key: string) => Promise<void>;
  removePatFile?: () => Promise<void>;
  pats?: number;
  readPatFile?: () => Promise<string>;
  writePatFile?: (text: string) => Promise<void>;
}): Promise<any>;
