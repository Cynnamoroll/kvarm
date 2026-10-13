export const SUBSCRIPTION_NAME: string;
export const ARTIFACTS_SEED_REPO: string;

export interface BootstrapResources {
  d1: string;
  bucket: string;
  queue: string;
  deadLetterQueue: string;
  artifactsNamespace: string;
  subscription: string;
  artifactsSeedRepo: string;
}

export interface AccountState {
  d1: { name: string; uuid: string } | null;
  buckets: string[];
  queues: string[];
  subscriptions: unknown[];
  artifactsNamespace: boolean;
}

export interface BootstrapStep {
  resource: string;
  name: string;
  action: 'exists' | 'create';
  command: string[] | null;
}

export type WranglerRun = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export function bootstrapResources(config: unknown): BootstrapResources;

export function parseR2BucketList(text: string): string[];

export function parseQueueList(text: string): string[];

export function planBootstrap(res: BootstrapResources, state: AccountState): BootstrapStep[];

export function envDeployWithDatabaseId(text: string, id: string): { text: string; status: 'written' | 'unchanged' | 'conflict' };

export function inspectAccount(res: BootstrapResources, wrangler: WranglerRun): Promise<AccountState>;

export function runBootstrap(opts: {
  resources: BootstrapResources;
  wrangler: WranglerRun;
  apply: boolean;
  log?: (line: string) => void;
}): Promise<{ steps: BootstrapStep[]; created: string[]; d1Id: string | null; verified: boolean }>;
