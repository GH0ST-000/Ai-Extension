import { describe, expect, it } from 'vitest';

import {
  WORKFLOW_FACT_NAMES,
  conditionTypeToFactName,
  createWorkflowFact,
  isKnownWorkflowFactName,
  sanitizeWorkflowFacts,
  upsertWorkflowFacts,
} from './facts';

describe('workflow facts', () => {
  it('exposes allowlisted fact names', () => {
    expect(WORKFLOW_FACT_NAMES).toContain('HAS_BLOCKING_FINDINGS');
    expect(WORKFLOW_FACT_NAMES).toContain('CI_TARGET_PASSED');
    expect(WORKFLOW_FACT_NAMES).toContain('PATCH_APPLIED');
    expect(WORKFLOW_FACT_NAMES).toContain('MULTI_REPO_IMPACT_FOUND');
    expect(WORKFLOW_FACT_NAMES).toContain('SYSTEM_CONTEXT_PARTIAL');
    expect(WORKFLOW_FACT_NAMES).toContain('CROSS_REPO_CONTRACT_RISK');
    expect(isKnownWorkflowFactName('HAS_BLOCKING_FINDINGS')).toBe(true);
    expect(isKnownWorkflowFactName('INVENTED_FACT')).toBe(false);
  });

  it('sanitizeWorkflowFacts rejects unknown names and bad values', () => {
    const sanitized = sanitizeWorkflowFacts([
      { name: 'HAS_BLOCKING_FINDINGS', value: true, sourceStepId: 's1' },
      { name: 'AI_MADE_THIS_UP', value: true },
      { name: 'PATCH_PREPARED', value: 'yes' },
      { name: 'CRITICAL_FINDING_COUNT', value: Number.NaN },
      { name: 'HIGH_FINDING_COUNT', value: 3 },
      null,
      'nope',
    ]);
    expect(sanitized).toEqual([
      createWorkflowFact('HAS_BLOCKING_FINDINGS', true, 's1'),
      createWorkflowFact('HIGH_FINDING_COUNT', 3),
    ]);
  });

  it('upsertWorkflowFacts replaces by name and drops unknowns', () => {
    const existing = [
      createWorkflowFact('PATCH_PREPARED', false, 'old'),
      createWorkflowFact('CI_TARGET_PASSED', false),
    ];
    const next = [
      createWorkflowFact('PATCH_PREPARED', true, 'new'),
      { name: 'NOT_A_FACT' as 'PATCH_PREPARED', value: true },
    ];
    const upserted = upsertWorkflowFacts(existing, next);
    expect(upserted).toEqual(
      expect.arrayContaining([
        createWorkflowFact('PATCH_PREPARED', true, 'new'),
        createWorkflowFact('CI_TARGET_PASSED', false),
      ]),
    );
    expect(upserted).toHaveLength(2);
  });

  it('maps condition types to fact names and ALWAYS to null', () => {
    expect(conditionTypeToFactName('ALWAYS')).toBeNull();
    expect(conditionTypeToFactName('HAS_BLOCKING_FINDINGS')).toBe('HAS_BLOCKING_FINDINGS');
    expect(conditionTypeToFactName('HAS_HIGH_FINDINGS')).toBe('HAS_HIGH_FINDINGS');
    expect(conditionTypeToFactName('CI_TARGET_FAILED')).toBe('CI_TARGET_FAILED');
    expect(conditionTypeToFactName('CI_TARGET_PASSED')).toBe('CI_TARGET_PASSED');
    expect(conditionTypeToFactName('CI_DIFFERENT_FAILURE')).toBe('CI_DIFFERENT_FAILURE');
    expect(conditionTypeToFactName('HAS_ENGINEERING_CONTEXT')).toBe('HAS_ENGINEERING_CONTEXT');
    expect(conditionTypeToFactName('PATCH_PREPARED')).toBe('PATCH_PREPARED');
    expect(conditionTypeToFactName('PATCH_APPLIED')).toBe('PATCH_APPLIED');
    expect(conditionTypeToFactName('REVIEW_DRAFT_READY')).toBe('REVIEW_DRAFT_READY');
    expect(conditionTypeToFactName('CONTEXT_PARTIAL')).toBe('CONTEXT_PARTIAL');
  });
});
