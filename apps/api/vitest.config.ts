/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // The PostgreSQL suites have their own config (vitest.integration.config.ts) that fails
    // without a database. Listing them here would only report them as "skipped".
    exclude: ['**/node_modules/**', '**/dist/**', 'test/integration/**'],
    globals: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
