import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { diffApiContracts } from './diff';
import { normalizeOpenApiDocument } from './normalize';
import { parseOpenApiRaw } from './parse-raw';

const fixturesDir = join(__dirname, '../fixtures');

function loadNormalized(name: string) {
  const raw = readFileSync(join(fixturesDir, name), 'utf8');
  const { document } = parseOpenApiRaw(raw);
  return normalizeOpenApiDocument(document, { type: 'page' }, raw);
}

describe('diffApiContracts', () => {
  const base = loadNormalized('breaking-base.json');
  const head = loadNormalized('breaking-head.json');
  const diff = diffApiContracts(base, head, { baseRef: 'main', headRef: 'feature' });

  it('binds baseRef and headRef', () => {
    expect(diff.baseRef).toBe('main');
    expect(diff.headRef).toBe('feature');
    expect(diff.baseHash).toBe(base.documentHash);
    expect(diff.headHash).toBe(head.documentHash);
  });

  it('marks removed endpoint as breaking', () => {
    expect(
      diff.breakingChanges.some(
        (c) => c.kind === 'removed-endpoint' && c.path === '/orders/{id}/cancel',
      ),
    ).toBe(true);
  });

  it('marks new required request field as breaking', () => {
    expect(
      diff.breakingChanges.some(
        (c) => c.kind === 'new-required-request-field' && c.description.includes('customerId'),
      ),
    ).toBe(true);
  });

  it('marks removed response property as breaking', () => {
    expect(
      diff.breakingChanges.some(
        (c) => c.kind === 'removed-response-field' && c.title.includes('legacyCode'),
      ),
    ).toBe(true);
  });

  it('marks type change as breaking', () => {
    expect(
      diff.breakingChanges.some((c) => c.kind === 'type-change' && c.title.includes('id')),
    ).toBe(true);
  });

  it('marks enum narrowing as breaking', () => {
    expect(
      diff.breakingChanges.some(
        (c) => c.kind === 'enum-narrowing' && /cancelled/i.test(c.description),
      ),
    ).toBe(true);
  });

  it('marks optional response field add as non-breaking', () => {
    expect(
      diff.nonBreakingChanges.some(
        (c) =>
          c.title.includes('currency') &&
          /non-breaking|optional/i.test(`${c.title} ${c.description} ${c.impact}`),
      ),
    ).toBe(true);
    expect(diff.nonBreakingChanges.some((c) => c.title.includes('currency'))).toBe(true);
  });

  it('classifies uncertain changes when appropriate', () => {
    // Widen enum on a stable endpoint to force uncertain classification
    const baseOnly = loadNormalized('breaking-base.json');
    const widened = structuredClone(baseOnly);
    const create = widened.operations.find((o) => o.operationId === 'createOrder');
    const status = create?.requestBody?.schema?.properties?.status;
    if (status?.enum) {
      status.enum = [...status.enum, 'archived'];
    }
    widened.documentHash = `${baseOnly.documentHash}-wide`;
    const widenedDiff = diffApiContracts(baseOnly, widened, {
      baseRef: 'a',
      headRef: 'b',
    });
    expect(widenedDiff.uncertainChanges.some((c) => c.kind === 'enum-widening')).toBe(true);
  });
});
