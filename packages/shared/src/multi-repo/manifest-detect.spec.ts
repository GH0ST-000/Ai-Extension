import { describe, expect, it } from 'vitest';

import { parseServiceDependencyManifest } from './manifest-detect';

const FIXTURE = JSON.stringify({
  service: 'project-x-test-client',
  dependencies: [
    {
      service: 'project-x-test-api',
      type: 'http',
      repository: 'https://github.com/gh0st-000/project-x-test-api',
      baseUrlEnv: 'USER_API_BASE_URL',
      endpoints: ['GET /health', 'GET /api/users', 'GET /api/users/{id}'],
    },
  ],
});

describe('parseServiceDependencyManifest', () => {
  it('parses the test fixture and normalizes the repository', () => {
    const r = parseServiceDependencyManifest(FIXTURE);
    expect(r).toEqual({
      ok: true,
      service: 'project-x-test-client',
      issues: [],
      dependencies: [
        {
          type: 'http',
          service: 'project-x-test-api',
          repository: { owner: 'gh0st-000', repository: 'project-x-test-api' },
          baseUrlEnv: 'USER_API_BASE_URL',
          endpoints: [
            { method: 'GET', path: '/health' },
            { method: 'GET', path: '/api/users' },
            { method: 'GET', path: '/api/users/{param}' },
          ],
        },
      ],
    });
  });

  it('rejects malformed and oversized documents', () => {
    expect(parseServiceDependencyManifest('{')).toEqual({ ok: false, error: 'invalid_json' });
    expect(parseServiceDependencyManifest('[]')).toEqual({ ok: false, error: 'not_an_object' });
    expect(parseServiceDependencyManifest('{}')).toEqual({
      ok: false,
      error: 'missing_dependencies',
    });
    expect(parseServiceDependencyManifest(' '.repeat(70_000))).toEqual({
      ok: false,
      error: 'too_large',
    });
  });

  it('drops invalid entries, non-GitHub hosts and bad values; merges duplicates', () => {
    const r = parseServiceDependencyManifest(
      JSON.stringify({
        dependencies: [
          { repository: 'https://gitlab.com/a/b' },
          { repository: 'not a repo' },
          {},
          'nope',
          { repository: 'acme/api', baseUrlEnv: 'bad-name!', endpoints: ['GET /a', 'NOPE /b', 7] },
          { repository: 'https://github.com/ACME/api', endpoints: ['POST /c'] },
          { service: 'billing' },
        ],
      }),
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.dependencies).toEqual([
      {
        type: 'unknown',
        repository: { owner: 'acme', repository: 'api' },
        endpoints: [
          { method: 'GET', path: '/a' },
          { method: 'POST', path: '/c' },
        ],
      },
      { type: 'unknown', service: 'billing', endpoints: [] },
    ]);
    expect(r.issues).toEqual(
      expect.arrayContaining([
        'dependency_0_repository_invalid',
        'dependency_1_repository_invalid',
        'dependency_2_target_missing',
        'dependency_3_invalid',
        'dependency_4_env_invalid',
        'dependency_4_endpoint_invalid',
        'dependency_5_duplicate',
      ]),
    );
  });
});
