import { describe, expect, it } from 'vitest';

import { filterOpenApiSpecPaths, isOpenApiSpecPath } from './spec-path';

describe('isOpenApiSpecPath', () => {
  it('matches exact well-known names', () => {
    expect(isOpenApiSpecPath('openapi.json')).toBe(true);
    expect(isOpenApiSpecPath('docs/openapi.yaml')).toBe(true);
    expect(isOpenApiSpecPath('swagger.yml')).toBe(true);
    expect(isOpenApiSpecPath('api/swagger.json')).toBe(true);
  });

  it('matches glob-style openapi/swagger names', () => {
    expect(isOpenApiSpecPath('specs/petstore.openapi.json')).toBe(true);
    expect(isOpenApiSpecPath('v1-swagger.yaml')).toBe(true);
    expect(isOpenApiSpecPath('openapi-v2.yml')).toBe(true);
  });

  it('rejects unrelated files', () => {
    expect(isOpenApiSpecPath('src/index.ts')).toBe(false);
    expect(isOpenApiSpecPath('README.md')).toBe(false);
    expect(isOpenApiSpecPath('openapi.txt')).toBe(false);
  });
});

describe('filterOpenApiSpecPaths', () => {
  it('dedupes and filters', () => {
    expect(
      filterOpenApiSpecPaths(['src/a.ts', 'openapi.json', 'docs/swagger.yaml', 'openapi.json']),
    ).toEqual(['openapi.json', 'docs/swagger.yaml']);
  });
});
