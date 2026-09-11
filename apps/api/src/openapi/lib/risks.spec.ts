import { describe, expect, it } from 'vitest';
import type { NormalizedApiContract, NormalizedApiOperation } from '@project-x/types';

import { analyzeApiContractDeterministic } from './risks';

function op(
  partial: Partial<NormalizedApiOperation> & Pick<NormalizedApiOperation, 'method' | 'path'>,
): NormalizedApiOperation {
  return {
    id: `${partial.method}:${partial.path}`,
    parameters: [],
    responses: [{ statusCode: '200', description: 'OK', schema: { type: 'object' } }],
    ...partial,
  };
}

function contract(operations: NormalizedApiOperation[]): NormalizedApiContract {
  return {
    version: '3.0.3',
    title: 'Risks',
    servers: [],
    tags: [],
    operations,
    schemas: {},
    source: { type: 'page' },
    documentHash: 'hash',
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('analyzeApiContractDeterministic', () => {
  it('flags missing auth when no security', () => {
    const doc = contract([op({ method: 'GET', path: '/secret' })]);
    const result = analyzeApiContractDeterministic(doc, 'contract');
    expect(result.findings.some((f) => f.category === 'security')).toBe(true);
    expect(result.findings.every((f) => f.evidence.length > 0)).toBe(true);
  });

  it('flags inconsistent response schemas', () => {
    const doc = contract([
      op({
        method: 'GET',
        path: '/mixed',
        responses: [
          { statusCode: '200', schema: { type: 'object', name: 'Ok' } },
          { statusCode: '400', schema: { type: 'object', name: 'Error' } },
          { statusCode: '500', schema: { type: 'string', name: 'Plain' } },
        ],
      }),
    ]);
    const result = analyzeApiContractDeterministic(doc, 'operation', doc.operations[0]);
    expect(result.findings.some((f) => f.category === 'consistency')).toBe(true);
  });

  it('flags idempotency ambiguity for POST without idempotency key', () => {
    const doc = contract([
      op({
        method: 'POST',
        path: '/charges',
        security: [{ name: 'bearer' }],
        responses: [{ statusCode: '201', schema: { type: 'object' } }],
      }),
    ]);
    const result = analyzeApiContractDeterministic(doc, 'operation', doc.operations[0]);
    expect(result.findings.some((f) => f.category === 'idempotency')).toBe(true);
    expect(result.openQuestions.some((q) => /retried/i.test(q))).toBe(true);
  });

  it('includes evidence on findings', () => {
    const doc = contract([op({ method: 'DELETE', path: '/x', security: [{ name: 'a' }] })]);
    const result = analyzeApiContractDeterministic(doc, 'contract');
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.evidence.length).toBeGreaterThan(0);
      expect(finding.evidence[0]?.method).toBeDefined();
    }
  });

  it('avoids huge boilerplate on a tiny clean GET', () => {
    const doc = contract([
      op({
        method: 'GET',
        path: '/health',
        security: [{ name: 'none' }],
        parameters: [
          {
            name: 'verbose',
            in: 'query',
            required: false,
            schema: { type: 'boolean' },
          },
        ],
        responses: [{ statusCode: '200', schema: { type: 'object', name: 'Health' } }],
      }),
    ]);
    const result = analyzeApiContractDeterministic(doc, 'operation', doc.operations[0]);
    expect(result.findings.length).toBeLessThan(5);
    expect(result.findings.some((f) => f.category === 'idempotency')).toBe(false);
    expect(result.riskLevel).not.toBe('high');
  });
});
