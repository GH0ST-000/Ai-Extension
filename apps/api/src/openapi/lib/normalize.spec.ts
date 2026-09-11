import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPENAPI_MAX_OPERATIONS,
  OPENAPI_MAX_PROPERTIES,
  OPENAPI_MAX_SCHEMA_DEPTH,
} from '@project-x/types';
import { describe, expect, it } from 'vitest';

import { normalizeOpenApiDocument } from './normalize';
import { hashOpenApiDocument, parseOpenApiRaw } from './parse-raw';

const fixturesDir = join(__dirname, '../fixtures');

function loadFixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function normalizeFixture(name: string) {
  const raw = loadFixture(name);
  const { document } = parseOpenApiRaw(raw);
  return normalizeOpenApiDocument(
    document,
    { type: 'url', documentUrl: 'https://api.example.com/openapi.json' },
    raw,
  );
}

describe('normalizeOpenApiDocument', () => {
  it('normalizes OpenAPI 3.x operations, params, body, responses, security', () => {
    const contract = normalizeFixture('minimal-openapi-3.json');
    expect(contract.version).toBe('3.0.3');
    expect(contract.title).toBe('Pets API');
    expect(contract.operations.length).toBeGreaterThanOrEqual(3);

    const create = contract.operations.find((o) => o.operationId === 'createPet');
    expect(create?.method).toBe('POST');
    expect(create?.requestBody?.required).toBe(true);
    expect(create?.requestBody?.schema?.properties?.name).toBeDefined();
    expect(create?.responses.some((r) => r.statusCode === '201')).toBe(true);
    expect(create?.security?.[0]?.name).toBe('bearerAuth');

    const list = contract.operations.find((o) => o.operationId === 'listPets');
    expect(list?.parameters.some((p) => p.name === 'limit' && p.in === 'query')).toBe(true);
  });

  it('resolves local $ref', () => {
    const contract = normalizeFixture('minimal-openapi-3.json');
    const getPet = contract.operations.find((o) => o.operationId === 'getPet');
    const schema = getPet?.responses[0]?.schema;
    expect(schema?.name).toBe('Pet');
    expect(schema?.properties?.id?.format).toBe('uuid');
    expect(contract.schemas.Pet?.properties?.name).toBeDefined();
  });

  it('truncates circular $ref', () => {
    const contract = normalizeFixture('circular-ref.json');
    const node = contract.schemas.Node;
    expect(node).toBeDefined();
    const child = node?.properties?.child;
    const responseSchema = contract.operations[0]?.responses[0]?.schema;
    const circularMarked =
      Boolean(child?.truncated || child?.unresolvedRef) ||
      Boolean(
        responseSchema?.properties?.child?.truncated ||
        responseSchema?.properties?.child?.unresolvedRef,
      ) ||
      Boolean(contract.warnings?.some((w) => /Reference|circular|unresolved/i.test(w)));
    expect(circularMarked).toBe(true);
  });

  it('marks external $ref unsupported/truncated', () => {
    const contract = normalizeFixture('external-ref.json');
    const op = contract.operations[0];
    const schema = op?.responses[0]?.schema;
    expect(schema?.truncated).toBe(true);
    expect(schema?.unresolvedRef).toContain('https://example.com');
    expect(contract.warnings?.some((w) => /External \$ref/i.test(w))).toBe(true);
  });

  it('marks truncated when schema property or depth limits exceeded', () => {
    const props: Record<string, { type: string }> = {};
    for (let i = 0; i < OPENAPI_MAX_PROPERTIES + 5; i += 1) {
      props[`p${i}`] = { type: 'string' };
    }
    const document = {
      openapi: '3.0.3',
      info: { title: 'Deep', version: '1.0.0' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: props },
                  },
                },
              },
            },
          },
        },
      },
    };
    const raw = JSON.stringify(document);
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, raw);
    const schema = contract.operations[0]?.responses[0]?.schema;
    expect(schema?.truncated).toBe(true);
    expect(Object.keys(schema?.properties ?? {}).length).toBeLessThanOrEqual(
      OPENAPI_MAX_PROPERTIES,
    );

    // Nested object chain beyond OPENAPI_MAX_SCHEMA_DEPTH
    let nested: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < OPENAPI_MAX_SCHEMA_DEPTH + 3; i += 1) {
      nested = { type: 'object', properties: { next: nested } };
    }
    const deepDoc = {
      openapi: '3.0.3',
      info: { title: 'Depth', version: '1.0.0' },
      paths: {
        '/deep': {
          get: {
            responses: {
              '200': {
                description: 'OK',
                content: { 'application/json': { schema: nested } },
              },
            },
          },
        },
      },
    };
    const deepContract = normalizeOpenApiDocument(
      deepDoc,
      { type: 'page' },
      JSON.stringify(deepDoc),
    );
    const serialized = JSON.stringify(deepContract.operations[0]?.responses[0]?.schema);
    expect(serialized).toContain('"truncated":true');
  });

  it('ignores vendor x-* extensions as inert', () => {
    const document = {
      openapi: '3.0.3',
      info: { title: 'Vendor', version: '1.0.0', 'x-internal': { secret: true } },
      'x-tagGroups': [{ name: 'hidden' }],
      paths: {
        '/ping': {
          'x-stability': 'experimental',
          get: {
            'x-codegen': { ignore: true },
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };
    const raw = JSON.stringify(document);
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, raw);
    expect(contract.operations).toHaveLength(1);
    expect(contract.operations[0]?.method).toBe('GET');
    expect(JSON.stringify(contract)).not.toContain('x-codegen');
    expect(JSON.stringify(contract)).not.toContain('x-tagGroups');
  });

  it('produces a stable documentHash', () => {
    const raw = loadFixture('minimal-openapi-3.json');
    const a = normalizeFixture('minimal-openapi-3.json');
    const b = normalizeFixture('minimal-openapi-3.json');
    expect(a.documentHash).toBe(b.documentHash);
    expect(a.documentHash).toBe(hashOpenApiDocument(raw));
  });

  it('supports swagger 2.0 best-effort or documents the path', () => {
    const raw = loadFixture('swagger-2.json');
    const { document } = parseOpenApiRaw(raw);
    const contract = normalizeOpenApiDocument(
      document,
      { type: 'url', documentUrl: 'https://api.example.com/swagger.json' },
      raw,
    );
    expect(contract.version).toBe('2.0');
    expect(contract.operations.length).toBeGreaterThan(0);
    expect(contract.warnings?.some((w) => /Swagger 2\.0/i.test(w))).toBe(true);
    expect(contract.servers[0]?.url).toContain('api.example.com');

    const create = contract.operations.find((o) => o.operationId === 'createPet');
    expect(create?.requestBody?.schema).toBeDefined();
  });

  it('throws for unsupported OpenAPI major versions', () => {
    const document = { openapi: '4.0.0', info: { title: 'x', version: '1' }, paths: {} };
    expect(() =>
      normalizeOpenApiDocument(document, { type: 'page' }, JSON.stringify(document)),
    ).toThrow(/UNSUPPORTED/);
  });

  it('marks partial when too many operations', () => {
    const paths: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < OPENAPI_MAX_OPERATIONS + 10; i += 1) {
      paths[`/p${i}`] = {
        get: {
          responses: { '200': { description: 'OK' } },
        },
      };
    }
    const document = {
      openapi: '3.0.3',
      info: { title: 'Many', version: '1.0.0' },
      paths,
    };
    const raw = JSON.stringify(document);
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, raw);
    expect(contract.partial).toBe(true);
    expect(contract.operationCountIncluded).toBe(OPENAPI_MAX_OPERATIONS);
    expect(contract.operationCountTotal).toBe(OPENAPI_MAX_OPERATIONS + 10);
    expect(contract.warnings?.some((w) => /operations/i.test(w))).toBe(true);
  });
});
