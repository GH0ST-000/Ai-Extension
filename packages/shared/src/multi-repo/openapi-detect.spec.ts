import { describe, expect, it } from 'vitest';

import { detectHttpProviderPaths } from './http-detect';
import { extractOpenApiOperations } from './openapi-detect';

const ops = (content: string) =>
  extractOpenApiOperations(content).operations.map((o) => `${o.method ?? '*'} ${o.path}`);

const CONVENTIONAL = `openapi: 3.0.3
info:
  title: Users API
  version: 1.0.0
paths:
  /health:
    get:
      summary: Health
  /api/users:
    get:
      summary: List users
    post:
      summary: Create user
  /api/users/{id}:
    parameters:
      - name: id
        in: path
    get:
      summary: Get user
components:
  schemas:
    /not-a-path:
      type: object
`;

describe('extractOpenApiOperations', () => {
  it('reads conventional unquoted YAML paths with their methods (regression)', () => {
    expect(ops(CONVENTIONAL)).toEqual([
      'GET /health',
      'GET /api/users',
      'POST /api/users',
      'GET /api/users/{param}',
    ]);
  });

  it('reads quoted YAML keys and flow-style methods', () => {
    expect(
      ops(`openapi: 3.0.0\npaths:\n  "/a/{id}":\n    get: {}\n  '/b': { post: {}, delete: {} }\n`),
    ).toEqual(['GET /a/{param}', 'POST /b', 'DELETE /b']);
  });

  it('reads JSON documents and applies the server base path', () => {
    const doc = JSON.stringify({
      openapi: '3.1.0',
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: { '/users/{id}': { get: {}, patch: {} }, '/ping': {} },
    });
    expect(ops(doc)).toEqual(['GET /v2/users/{param}', 'PATCH /v2/users/{param}', '* /v2/ping']);
    expect(ops(`swagger: "2.0"\nbasePath: /api\npaths:\n  /users:\n    get: {}\n`)).toEqual([
      'GET /api/users',
    ]);
  });

  it('ignores YAML that is not OpenAPI and malformed documents', () => {
    expect(extractOpenApiOperations('paths:\n  /x:\n    get: {}\n').recognized).toBe(false);
    expect(extractOpenApiOperations('{ "openapi": "3.0.0", "paths": [').operations).toEqual([]);
    expect(extractOpenApiOperations('openapi: 3.0.0\npaths: not-a-map\n').operations).toEqual([]);
    expect(extractOpenApiOperations(42 as unknown as string).operations).toEqual([]);
  });

  it('is bounded and never executes YAML tags', () => {
    const many = Array.from({ length: 500 }, (_, i) => `  /p${i}:\n    get: {}`).join('\n');
    const big = extractOpenApiOperations(`openapi: 3.0.0\npaths:\n${many}\n`);
    expect(big.operations).toHaveLength(80);
    expect(big.truncated).toBe(true);
    const tagged = `openapi: 3.0.0\npaths:\n  /x: !!js/function "function(){ throw 1 }"\n`;
    expect(() => extractOpenApiOperations(tagged)).not.toThrow();
    expect(extractOpenApiOperations('x'.repeat(600_000)).operations).toEqual([]);
  });

  it('legacy provider detector now sees unquoted keys too', () => {
    const found = detectHttpProviderPaths(CONVENTIONAL, 'openapi.yaml');
    expect(found.some((e) => e.method === 'GET' && e.path === '/api/users/{param}')).toBe(true);
  });
});
