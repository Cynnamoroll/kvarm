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
          include: ['packages/**/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
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
