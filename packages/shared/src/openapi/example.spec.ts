import { describe, expect, it } from 'vitest';
import type { NormalizedApiOperation } from '@project-x/types';

import { generateApiExample } from './example';

function baseOp(overrides: Partial<NormalizedApiOperation> = {}): NormalizedApiOperation {
  return {
    id: 'GET:/items',
    method: 'GET',
    path: '/items',
    parameters: [],
    responses: [{ statusCode: '200', description: 'OK' }],
    ...overrides,
  };
}

describe('generateApiExample', () => {
  it('uses schema example, default, and enum', () => {
    const example = generateApiExample(
      baseOp({
        method: 'POST',
        path: '/pets',
        id: 'POST:/pets',
        requestBody: {
          required: true,
          contentType: 'application/json',
          schema: {
            type: 'object',
            required: ['name', 'status', 'tag'],
            properties: {
              name: { type: 'string', example: 'Fido' },
              status: { type: 'string', enum: ['available', 'pending'] },
              tag: { type: 'string', default: 'friendly' },
            },
          },
        },
      }),
    );

    expect(example.body).toEqual({
      name: 'Fido',
      status: 'available',
      tag: 'friendly',
    });
  });

  it('uses uuid/email/date-time placeholders', () => {
    const example = generateApiExample(
      baseOp({
        method: 'POST',
        path: '/users/{id}',
        id: 'POST:/users/{id}',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        requestBody: {
          required: true,
          schema: {
            type: 'object',
            required: ['email', 'createdAt'],
            properties: {
              email: { type: 'string', format: 'email' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      }),
    );

    expect(example.path).toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(example.body).toEqual({
      email: 'user@example.com',
      createdAt: '2026-01-15T12:00:00.000Z',
    });
  });

  it('adds Authorization Bearer <token> placeholder when security is present', () => {
    const example = generateApiExample(
      baseOp({
        security: [{ name: 'bearerAuth' }],
      }),
    );
    expect(example.headers.Authorization).toBe('Bearer <token>');
    expect(example.notes.some((n) => /placeholder/i.test(n))).toBe(true);
  });

  it('never includes eyJ-looking JWTs', () => {
    const example = generateApiExample(
      baseOp({
        security: [{ name: 'bearerAuth' }],
        requestBody: {
          required: true,
          schema: {
            type: 'object',
            properties: {
              token: { type: 'string' },
            },
          },
        },
      }),
    );
    const serialized = JSON.stringify(example);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]+/);
    expect(example.headers.Authorization).not.toMatch(/^Bearer eyJ/);
  });

  it('labels generated example', () => {
    const example = generateApiExample(baseOp());
    expect(example.notes[0]).toMatch(/Generated Example/i);
  });
});
