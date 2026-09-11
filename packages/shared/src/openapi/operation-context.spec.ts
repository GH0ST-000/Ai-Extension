import { describe, expect, it } from 'vitest';
import type { NormalizedApiContract, NormalizedApiOperation } from '@project-x/types';

import { buildOperationAiContext, findOperation } from './operation-context';

function op(
  partial: Partial<NormalizedApiOperation> & Pick<NormalizedApiOperation, 'method' | 'path'>,
): NormalizedApiOperation {
  return {
    id: `${partial.method}:${partial.path}`,
    parameters: [],
    responses: [{ statusCode: '200' }],
    ...partial,
  };
}

function contract(operations: NormalizedApiOperation[]): NormalizedApiContract {
  return {
    version: '3.0.3',
    title: 'Test API',
    servers: [],
    tags: [],
    operations,
    schemas: {},
    source: { type: 'page' },
    documentHash: 'abc123',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('findOperation', () => {
  const doc = contract([
    op({ method: 'GET', path: '/pets', operationId: 'listPets' }),
    op({ method: 'POST', path: '/pets', operationId: 'createPet' }),
    op({ method: 'GET', path: '/pets/{id}', id: 'get-pet', operationId: 'getPet' }),
  ]);

  it('finds by method and path', () => {
    const found = findOperation(doc, { method: 'get', path: '/pets' });
    expect(found?.operationId).toBe('listPets');
  });

  it('finds by id', () => {
    expect(findOperation(doc, { id: 'get-pet' })?.path).toBe('/pets/{id}');
  });

  it('returns null when missing', () => {
    expect(findOperation(doc, { method: 'DELETE', path: '/pets' })).toBeNull();
  });
});

describe('buildOperationAiContext', () => {
  it('includes method and path and stays bounded', () => {
    const operation = op({
      method: 'POST',
      path: '/orders',
      summary: 'Create order',
      description: 'x'.repeat(50_000),
      requestBody: {
        required: true,
        schema: {
          type: 'object',
          properties: Object.fromEntries(
            Array.from({ length: 40 }, (_, i) => [
              `field${i}`,
              { type: 'string', description: 'y'.repeat(500) },
            ]),
          ),
        },
      },
      responses: [
        {
          statusCode: '201',
          schema: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ],
    });
    const doc = contract([operation]);
    const text = buildOperationAiContext(doc, operation, 2_000);
    expect(text).toContain('POST /orders');
    expect(text.length).toBeLessThanOrEqual(2_020);
    expect(text).toMatch(/truncated|…/);
  });
});
