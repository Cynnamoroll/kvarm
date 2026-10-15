export type FixtureHttp = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number }>;

export function checkIsolatedName(repo: string, prefix: string): string | null;

export function withFixtureRepo<T>(
  opts: {
    owner: string;
    repo: string;
    prefix: string;
    /** When set, the repo is an org repo under this login (owner is ignored). */
    org?: string;
    http: FixtureHttp;
    keep?: boolean;
    visibility?: 'public' | 'private';
    log?: (line: string) => void;
  },
  body: () => Promise<T>,
): Promise<{ ok: true; created: true; value: T } | { ok: false; created: false; reason: string; value?: undefined }>;
