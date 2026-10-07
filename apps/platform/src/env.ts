/**
 * Runtime bindings (D1, R2, Queues, Workflows, DOs, Artifacts, vars) are
 * generated into worker-configuration.d.ts by `wrangler types`. Secrets are
 * not listed in wrangler.jsonc, so they are declared here instead.
 */
declare global {
  interface Env {
    /** WorkOS API key (secret). */
    WORKOS_API_KEY: string;
    /** WorkOS client ID (secret; safe to move to vars if preferred). */
    WORKOS_CLIENT_ID: string;
    /** >= 32 char secret used to seal AuthKit session cookies. */
    WORKOS_COOKIE_PASSWORD: string;
  }
}

export {};
