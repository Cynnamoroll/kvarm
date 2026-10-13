import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const platformDir = fileURLToPath(new URL('./apps/platform/', import.meta.url));

export default defineConfig({
  test: {
    reporters: 'default',
    projects: [
      {
        test: {
          name: 'packages',
          include: ['packages/**/test/**/*.test.ts', 'scripts/test/**/*.test.ts', 'apps/cli/test/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: `${platformDir}wrangler.jsonc` },
            remoteBindings: false,
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(`${platformDir}migrations`),
                // Opt-in live check of server-side git writes against a real Artifacts
                // remote (apps/platform/test/gitwriteLive.test.ts); empty in the gate.
                LIVE_GITWRITE_REMOTE: process.env.LIVE_GITWRITE_REMOTE ?? '',
                LIVE_GITWRITE_NAME: process.env.LIVE_GITWRITE_NAME ?? '',
                LIVE_GITWRITE_TOKEN: process.env.LIVE_GITWRITE_TOKEN ?? '',
                // Selects the live merge publication check (apps/platform/test/mergeLive.test.ts).
                LIVE_MERGE: process.env.LIVE_MERGE ?? '',
                // Test-only key for webhook secrets at rest (services/webhookSafety.ts).
                WEBHOOK_SECRET_KEY: 'test-only-webhook-secret-key-not-for-deployments',
              },
            },
          })),
        ],
        test: {
          name: 'platform',
          include: ['apps/platform/test/**/*.test.ts'],
          setupFiles: ['apps/platform/test/setup/apply-migrations.ts'],
        },
      },
    ],
  },
});
