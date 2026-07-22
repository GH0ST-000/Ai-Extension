import { nextjsConfig } from '@project-x/eslint-config/nextjs';

export default [
  ...nextjsConfig,
  {
    ignores: ['.next/**', 'next-env.d.ts', 'out/**'],
  },
];
