import { reactConfig } from '@project-x/eslint-config/react';

export default [
  ...reactConfig,
  {
    ignores: ['build/**', '.plasmo/**', 'assets/**'],
  },
];
