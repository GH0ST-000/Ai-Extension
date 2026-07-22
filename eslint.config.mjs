import { baseConfig } from '@project-x/eslint-config/base';
import { nestjsConfig } from '@project-x/eslint-config/nestjs';
import { nextjsConfig } from '@project-x/eslint-config/nextjs';
import { reactConfig } from '@project-x/eslint-config/react';

/**
 * Root flat config for husky/lint-staged (runs from repo root).
 * Package-level eslint.config.mjs files remain for `turbo lint`.
 */

const globalIgnores = {
  ignores: [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/.plasmo/**',
    '**/coverage/**',
    '**/*.d.ts',
    'pnpm-lock.yaml',
  ],
};

/** Scope a shared preset to specific globs (drop nested ignore-only blocks). */
function withFiles(configs, files) {
  return configs
    .filter((config) => !config.ignores)
    .map((config) => ({
      ...config,
      files,
    }));
}

/** @type {import('eslint').Linter.Config[]} */
export default [
  globalIgnores,
  ...withFiles(baseConfig, [
    'packages/types/**/*.{ts,tsx,js,mjs}',
    'packages/shared/**/*.{ts,tsx,js,mjs}',
    'packages/config/**/*.{ts,tsx,js,mjs}',
    'packages/eslint-config/**/*.{js,mjs}',
    'packages/tsconfig/**/*.{js,mjs}',
    '*.{js,mjs,cjs}',
  ]),
  ...withFiles(nestjsConfig, ['apps/api/**/*.{ts,tsx,js,mjs}']),
  ...withFiles(nextjsConfig, ['apps/dashboard/**/*.{ts,tsx,js,jsx,mjs}']),
  {
    files: ['apps/dashboard/**/*.{ts,tsx,js,jsx,mjs}'],
    settings: {
      next: {
        rootDir: 'apps/dashboard/',
      },
    },
  },
  ...withFiles(reactConfig, [
    'apps/extension/**/*.{ts,tsx,js,jsx,mjs}',
    'packages/ui/**/*.{ts,tsx,js,jsx,mjs}',
  ]),
];
