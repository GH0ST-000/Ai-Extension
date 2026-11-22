/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * PostgreSQL integration suites (test/integration). Run through `pnpm test:integration`
 * (local throwaway container) or `pnpm test:integration:ci` (CI service container).
 *
 * - `globalSetup` FAILS the run when MEMORY_IT_DATABASE_URL is missing or does not point at a
 *   throwaway database, so these suites can never be "green because they were skipped".
 * - Files run one at a time: several suites call process-wide operations (the deletion
 *   reconciler, the usage sweep) that act on every row of the shared database, so parallel
 *   files would process each other's fixtures.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.spec.ts'],
    globals: true,
    globalSetup: ['test/integration/require-database.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
