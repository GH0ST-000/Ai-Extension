import { describe, expect, it } from 'vitest';

import { planRepositoryScan, type TreeEntry } from './scan-plan';

const blob = (path: string, size = 1000): TreeEntry => ({ path, type: 'blob', size, sha: path });

describe('planRepositoryScan', () => {
  it('reads signal files first, then relevant source; skips vendored, built, test and type files', () => {
    const plan = planRepositoryScan([
      blob('src/utils/strings.ts'),
      blob('src/client/users-client.ts'),
      blob('node_modules/x/index.js'),
      blob('dist/index.js'),
      blob('src/client/users-client.spec.ts'),
      blob('src/types.d.ts'),
      blob('README.md'),
      blob('package.json'),
      blob('service-dependencies.json'),
      blob('openapi.yaml'),
      blob('docs/api/openapi.json'),
      blob('scripts/build.js'),
      blob('assets/logo.png'),
      { path: 'src', type: 'tree' },
    ]);
    expect(plan.selected.map((e) => e.path)).toEqual([
      'openapi.yaml',
      'package.json',
      'README.md',
      'service-dependencies.json',
      'docs/api/openapi.json',
      'src/client/users-client.ts',
      'src/utils/strings.ts',
      'scripts/build.js',
    ]);
  });

  it('enforces file count and size caps and reports what was left out', () => {
    const entries = [
      blob('src/huge.ts', 900_000),
      ...Array.from({ length: 30 }, (_, i) => blob(`src/f${i}.ts`)),
    ];
    const plan = planRepositoryScan(entries, 24, 512_000);
    expect(plan.selected).toHaveLength(24);
    expect(plan.oversized).toBe(1);
    expect(plan.overBudget).toBe(6);
    expect(plan.eligible).toBe(31);
  });
});
