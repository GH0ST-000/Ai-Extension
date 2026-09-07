import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['lib/**/*.spec.ts', 'lib/**/*.spec.tsx'],
    globals: true,
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, '.'),
      '@project-x/types': path.resolve(__dirname, '../../packages/types/src/index.ts'),
    },
  },
});
