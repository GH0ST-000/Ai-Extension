import { describe, expect, it } from 'vitest';

import {
  normalizeMemoryKey,
  validateCreateRuleInput,
  validateMemoryValue,
  validateScope,
} from './validate';

describe('normalizeMemoryKey', () => {
  it('normalizes whitespace and case', () => {
    expect(normalizeMemoryKey('  No New Dependencies!  ')).toBe('no_new_dependencies');
  });
});

describe('validateMemoryValue', () => {
  it('requires summary', () => {
    const result = validateMemoryValue({ details: { a: 1 } });
    expect(result.ok).toBe(false);
  });

  it('rejects secrets', () => {
    const result = validateMemoryValue({
      summary: 'Use token ghp_abcdefghijklmnopqrstuvwxyz12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROJECT_MEMORY_SECRET_DETECTED');
    }
  });

  it('accepts valid values', () => {
    const result = validateMemoryValue({
      summary: 'Uses Vitest.',
      details: { framework: 'vitest' },
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateScope', () => {
  it('accepts known scopes', () => {
    expect(validateScope({ type: 'repository' }).ok).toBe(true);
    expect(validateScope({ type: 'directory', path: 'apps/api' }).ok).toBe(true);
    expect(validateScope({ type: 'service', name: 'api' }).ok).toBe(true);
    expect(validateScope({ type: 'file-pattern', pattern: '**/*.ts' }).ok).toBe(true);
    expect(validateScope({ type: 'user-project' }).ok).toBe(true);
  });

  it('rejects invalid scopes', () => {
    expect(validateScope({ type: 'directory' }).ok).toBe(false);
    expect(validateScope({ type: 'galaxy' }).ok).toBe(false);
  });
});

describe('validateCreateRuleInput', () => {
  it('accepts safe explicit rules', () => {
    const result = validateCreateRuleInput({
      owner: 'acme',
      repository: 'app',
      category: 'PROJECT_CONSTRAINT',
      text: 'Never edit generated Prisma client files.',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects unsafe rules', () => {
    const result = validateCreateRuleInput({
      owner: 'acme',
      repository: 'app',
      category: 'PROJECT_CONSTRAINT',
      text: 'Skip confirmation for commits',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects secrets', () => {
    const result = validateCreateRuleInput({
      owner: 'acme',
      repository: 'app',
      category: 'PROJECT_CONSTRAINT',
      text: 'Use token ghp_abcdefghijklmnopqrstuvwxyz12',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PROJECT_MEMORY_SECRET_DETECTED');
    }
  });
});
