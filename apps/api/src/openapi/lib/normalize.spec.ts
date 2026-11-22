import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  OPENAPI_MAX_OPERATIONS,
  OPENAPI_MAX_PROPERTIES,
  OPENAPI_MAX_SCHEMA_DEPTH,
  OPENAPI_MAX_SCHEMA_NODES,
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

/** F-01: `$ref` fan-out must be bounded by a whole-document budget, not only by depth. */
describe('normalizeOpenApiDocument — expansion budget (F-01)', () => {
  function countNodes(schema: unknown): number {
    if (!schema || typeof schema !== 'object') return 0;
    const s = schema as Record<string, unknown>;
    let n = 1;
    for (const child of Object.values((s.properties as Record<string, unknown>) ?? {})) {
      n += countNodes(child);
    }
    if (s.items) n += countNodes(s.items);
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      n += countNodes(s.additionalProperties);
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      for (const child of (s[key] as unknown[]) ?? []) n += countNodes(child);
    }
    return n;
  }

  function fanOutDocument(levels: number, width: number) {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < levels; i += 1) {
      const properties: Record<string, unknown> = {};
      for (let p = 0; p < width; p += 1) {
        properties[`p${p}`] =
          i + 1 < levels ? { $ref: `#/components/schemas/S${i + 1}` } : { type: 'string' };
      }
      schemas[`S${i}`] = { type: 'object', properties };
    }
    return {
      openapi: '3.0.3',
      info: { title: 'Fan', version: '1' },
      paths: {},
      components: { schemas },
    };
  }

  it('a small wide-and-deep $ref document finishes fast and is reported partial', () => {
    // 7 schemas x 80 refs: ~80^6 expansions without a budget (the process never returns).
    const document = fanOutDocument(7, OPENAPI_MAX_PROPERTIES);
    const raw = JSON.stringify(document);
    expect(raw.length).toBeLessThan(40_000);
    const started = Date.now();
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, raw);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(contract.partial).toBe(true);
    expect(contract.warnings?.some((w) => /budget/i.test(w))).toBe(true);
    const total = Object.values(contract.schemas).reduce((n, s) => n + countNodes(s), 0);
    // Budgeted nodes plus the constant-time stubs their property loops emit.
    expect(total).toBeLessThanOrEqual(OPENAPI_MAX_SCHEMA_NODES * (OPENAPI_MAX_PROPERTIES + 1));
  });

  it('the budget is shared by operations: request/response schemas cannot restart it', () => {
    const document = fanOutDocument(7, OPENAPI_MAX_PROPERTIES) as Record<string, unknown>;
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < 50; i += 1) {
      paths[`/p${i}`] = {
        post: {
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
          },
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } },
            },
          },
        },
      };
    }
    document.paths = paths;
    const started = Date.now();
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, JSON.stringify(document));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(contract.partial).toBe(true);
    expect(contract.operations).toHaveLength(50);
    expect(contract.operations[49]!.requestBody?.schema?.truncated).toBe(true);
  });

  it('repeated references to one schema are still expanded for legitimate documents', () => {
    const schemas: Record<string, unknown> = {
      Money: {
        type: 'object',
        properties: { amount: { type: 'number' }, currency: { type: 'string' } },
      },
    };
    for (let i = 0; i < 200; i += 1) {
      schemas[`Order${i}`] = {
        type: 'object',
        properties: {
          total: { $ref: '#/components/schemas/Money' },
          tax: { $ref: '#/components/schemas/Money' },
          lines: { type: 'array', items: { $ref: '#/components/schemas/Money' } },
        },
      };
    }
    const document = {
      openapi: '3.0.3',
      info: { title: 'Big', version: '1' },
      paths: {},
      components: { schemas },
    };
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, JSON.stringify(document));
    expect(contract.partial).toBeUndefined();
    expect(contract.warnings).toBeUndefined();
    const order = contract.schemas.Order199!;
    expect(order.properties?.total?.properties?.currency?.type).toBe('string');
    expect(order.properties?.lines?.items?.properties?.amount?.type).toBe('number');
  });

  it('cycles and deep chains still terminate without touching the budget warning', () => {
    const schemas: Record<string, unknown> = {
      A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
      B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
    };
    for (let i = 0; i < 40; i += 1) {
      schemas[`Chain${i}`] = {
        type: 'object',
        properties: i < 39 ? { next: { $ref: `#/components/schemas/Chain${i + 1}` } } : {},
      };
    }
    const document = {
      openapi: '3.0.3',
      info: { title: 'Cyc', version: '1' },
      paths: {},
      components: { schemas },
    };
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, JSON.stringify(document));
    expect(contract.partial).toBeUndefined();
    expect(contract.warnings?.some((w) => /budget/i.test(w)) ?? false).toBe(false);
    expect(JSON.stringify(contract.schemas.A)).toContain('truncated');
  });

  // Per-node work must be bounded too: a node is revisited at every $ref that reaches it.
  function fanIn(target: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const leafRefs: Record<string, unknown> = {};
    for (let p = 0; p < OPENAPI_MAX_PROPERTIES; p += 1)
      leafRefs[`p${p}`] = { $ref: '#/components/schemas/E' };
    const schemas: Record<string, unknown> = {
      E: target,
      L1: { type: 'object', properties: leafRefs },
    };
    for (const name of ['L2a', 'L2b', 'L2c', 'L2d']) {
      const refs: Record<string, unknown> = {};
      for (let p = 0; p < OPENAPI_MAX_PROPERTIES; p += 1)
        refs[`p${p}`] = { $ref: '#/components/schemas/L1' };
      schemas[name] = { type: 'object', properties: refs };
    }
    return {
      openapi: '3.0.3',
      info: { title: 'Heavy', version: '1' },
      paths: {},
      components: { schemas },
      ...extra,
    };
  }
  /** Generous sanity guard only (shared CI machines); the bounded sizes are the real check. */
  const TIME_GUARD_MS = 20_000;
  const timed = (document: unknown) => {
    const started = Date.now();
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, 'raw');
    return { contract, ms: Date.now() - started, bytes: JSON.stringify(contract).length };
  };

  it('a huge enum referenced thousands of times costs bounded time and output', () => {
    const { contract, ms, bytes } = timed(
      fanIn({ type: 'string', enum: new Array(60_000).fill('x') }),
    );
    expect(ms).toBeLessThan(TIME_GUARD_MS);
    expect(bytes).toBeLessThan(20_000_000);
    expect((contract.schemas.E!.enum ?? []).length).toBeLessThanOrEqual(200);
  });

  it('a huge `required` list, `example` and `default` are cut before they are copied', () => {
    const big = { blob: 'y'.repeat(500_000) };
    const { contract, ms, bytes } = timed(
      fanIn({ type: 'object', required: new Array(60_000).fill('f'), example: big, default: big }),
    );
    expect(ms).toBeLessThan(TIME_GUARD_MS);
    expect(bytes).toBeLessThan(20_000_000);
    expect(contract.schemas.E!.example).toBeUndefined();
    expect((contract.schemas.E!.required ?? []).length).toBeLessThanOrEqual(100);
  });

  it('a megabyte-long $ref is refused without being split or echoed into warnings', () => {
    const longRef = `#/${'a/'.repeat(100_000)}`;
    const { contract, ms, bytes } = timed(fanIn({ $ref: longRef }));
    expect(ms).toBeLessThan(TIME_GUARD_MS);
    expect(bytes).toBeLessThan(5_000_000);
    expect(JSON.stringify(contract.warnings ?? []).length).toBeLessThan(50_000);
  });

  it('a schema with 20k properties is not enumerated in full at every visit', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i += 1) properties[`k${i}`] = { type: 'string' };
    const { contract, ms } = timed(fanIn({ type: 'object', properties }));
    expect(ms).toBeLessThan(TIME_GUARD_MS);
    expect(Object.keys(contract.schemas.E!.properties ?? {}).length).toBeLessThanOrEqual(
      OPENAPI_MAX_PROPERTIES,
    );
    expect(contract.schemas.E!.truncated).toBe(true);
  });

  it('a huge document-level security object is bounded and not multiplied by the operations', () => {
    const requirement: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i += 1) requirement[`scheme${i}`] = [];
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < OPENAPI_MAX_OPERATIONS; i += 1)
      paths[`/p${i}`] = { get: { responses: { '200': { description: 'ok' } } } };
    const { contract, ms, bytes } = timed({
      openapi: '3.0.3',
      info: { title: 'Sec', version: '1' },
      security: [requirement],
      paths,
    });
    expect(ms).toBeLessThan(TIME_GUARD_MS);
    expect(bytes).toBeLessThan(2_000_000);
    expect(contract.operations[0]!.security!.length).toBeLessThanOrEqual(20);
    expect(contract.operations[0]!.security).toBe(contract.operations[199]!.security); // shared
  });

  it('ordinary enums, examples and required lists are kept unchanged', () => {
    const document = {
      openapi: '3.0.3',
      info: { title: 'Ok', version: '1' },
      paths: {},
      components: {
        schemas: {
          Status: {
            type: 'string',
            enum: ['open', 'closed', null, 3],
            default: 'open',
            example: 'closed',
          },
          Pet: {
            type: 'object',
            required: ['id', 'name'],
            description: 'A pet.',
            example: { id: 1, name: 'Rex' },
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
          },
        },
      },
    };
    const contract = normalizeOpenApiDocument(document, { type: 'page' }, 'raw');
    expect(contract.schemas.Status).toMatchObject({
      enum: ['open', 'closed', null, 3],
      default: 'open',
      example: 'closed',
    });
    expect(contract.schemas.Pet).toMatchObject({
      required: ['id', 'name'],
      description: 'A pet.',
      example: { id: 1, name: 'Rex' },
    });
    expect(contract.partial).toBeUndefined();
  });
});
