import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next compiles JSX itself (tsconfig "jsx": "preserve"); tests need the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  // Same `@/*` → `src/*` alias as tsconfig.json paths.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
