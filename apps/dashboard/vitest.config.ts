import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next compiles JSX itself (tsconfig "jsx": "preserve"); tests need the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
