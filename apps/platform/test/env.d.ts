import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      LIVE_GITWRITE_REMOTE: string;
      LIVE_GITWRITE_NAME: string;
      LIVE_GITWRITE_TOKEN: string;
    }
  }
}

export {};
