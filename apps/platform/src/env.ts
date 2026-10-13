/**
 * Runtime bindings (D1, R2, Queues, Workflows, DOs, Artifacts, vars) are
 * generated into worker-configuration.d.ts by `wrangler types`. Secrets are
 * not listed in wrangler.jsonc, so they are declared here instead, as are the
 * rate-limit bindings (declared identically, so a regenerated file merges).
 */
declare global {
  interface Env {
    /** WorkOS API key (secret). */
    WORKOS_API_KEY: string;
    /** WorkOS client ID (secret; safe to move to vars if preferred). */
    WORKOS_CLIENT_ID: string;
    /** >= 32 char secret used to seal AuthKit session cookies. */
    WORKOS_COOKIE_PASSWORD: string;
    /**
     * Optional var: "true" links a first WorkOS sign-in to the single unlinked
     * PAT-only user with the same, WorkOS-verified email (services/identity.ts).
     */
    WORKOS_LINK_VERIFIED_EMAIL?: string;
    /**
     * >= 32 char secret from which the key encrypting webhook signing secrets
     * at rest is derived (services/webhookSafety.ts). Optional: without it the
     * webhooks API answers 503 WEBHOOKS_NOT_CONFIGURED.
     */
    WEBHOOK_SECRET_KEY?: string;
    /**
     * Optional: instance-wide trusted execution-service public keys for
     * verified provenance (raw Ed25519, base64url, comma- or
     * whitespace-separated). Public keys, so a var or a secret both work.
     */
    KVARM_PROVENANCE_KEYS?: string;
    /** Workers Rate Limiting: 600 requests/min per key. */
    READ_LIMITER: RateLimit;
    /** Workers Rate Limiting: 120 requests/min per key. */
    WRITE_LIMITER: RateLimit;
  }
}

export {};
