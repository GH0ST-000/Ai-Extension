import { nestjsConfig } from '@project-x/eslint-config/nestjs';

export default [
  ...nestjsConfig,
  {
    // Review-quality benchmark corpus: intentionally defective code under review (test data).
    // The harness, specs and witness tests around it are still linted.
    ignores: [
      'test/benchmark/corpus/*/head/**',
      'test/benchmark/corpus/*/base/**',
      'test/benchmark/corpus/*/fixed/**',
    ],
  },
];
