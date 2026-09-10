import { describe, expect, it } from 'vitest';

import { classifyError } from './error-classifier';

describe('classifyError', () => {
  it('classifies TypeError as runtime with high confidence', () => {
    const result = classifyError("TypeError: Cannot read properties of undefined (reading 'id')");
    expect(result.isError).toBe(true);
    expect(result.category).toBe('runtime');
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it('classifies TypeScript diagnostics', () => {
    const result = classifyError("TS2339: Property 'userId' does not exist on type 'User'");
    expect(result.isError).toBe(true);
    expect(result.category).toBe('type');
    expect(result.technology).toBe('typescript');
    expect(result.errorCode).toBe('TS2339');
  });

  it('classifies Node network errors', () => {
    const result = classifyError('Error: connect ECONNREFUSED 127.0.0.1:6379');
    expect(result.isError).toBe(true);
    expect(result.category).toBe('network');
    expect(result.errorCode).toBe('ECONNREFUSED');
  });

  it('classifies Prisma errors', () => {
    const result = classifyError('PrismaClientKnownRequestError: Unique constraint failed');
    expect(result.isError).toBe(true);
    expect(result.category).toBe('database');
    expect(result.technology).toBe('prisma');
  });

  it('classifies module resolution / build errors', () => {
    const result = classifyError("Module not found: Can't resolve '@app/config'");
    expect(result.isError).toBe(true);
    expect(['dependency', 'build']).toContain(result.category);
  });

  it('rejects normal prose false positives', () => {
    const result = classifyError('Our marketing campaign failed to reach the expected audience.');
    expect(result.isError).toBe(false);
  });

  it('rejects business "error" prose', () => {
    const result = classifyError('The project failed to meet its expected business objectives.');
    expect(result.isError).toBe(false);
  });
});
