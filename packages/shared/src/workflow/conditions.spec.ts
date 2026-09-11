import { describe, expect, it } from 'vitest';

import { evaluateWorkflowCondition } from './conditions';

describe('evaluateWorkflowCondition', () => {
  const state = {
    hasHighFindings: true,
    hasBlockingFindings: true,
    ciTargetFailed: false,
    ciTargetPassed: false,
    ciDifferentFailure: false,
    hasEngineeringContext: true,
    patchPrepared: false,
    patchApplied: false,
    reviewDraftReady: false,
    contextPartial: false,
  };

  it('ALWAYS is true', () => {
    expect(evaluateWorkflowCondition({ type: 'ALWAYS' }, state)).toBe(true);
  });

  it('HAS_HIGH_FINDINGS reflects state', () => {
    expect(evaluateWorkflowCondition({ type: 'HAS_HIGH_FINDINGS' }, state)).toBe(true);
    expect(
      evaluateWorkflowCondition(
        { type: 'HAS_HIGH_FINDINGS' },
        { ...state, hasHighFindings: false },
      ),
    ).toBe(false);
  });

  it('HAS_BLOCKING_FINDINGS reflects state', () => {
    expect(evaluateWorkflowCondition({ type: 'HAS_BLOCKING_FINDINGS' }, state)).toBe(true);
  });

  it('supports negate', () => {
    expect(evaluateWorkflowCondition({ type: 'HAS_BLOCKING_FINDINGS', negate: true }, state)).toBe(
      false,
    );
  });

  it('CI_TARGET_FAILED reflects state', () => {
    expect(evaluateWorkflowCondition({ type: 'CI_TARGET_FAILED' }, state)).toBe(false);
    expect(
      evaluateWorkflowCondition({ type: 'CI_TARGET_FAILED' }, { ...state, ciTargetFailed: true }),
    ).toBe(true);
  });

  it('HAS_ENGINEERING_CONTEXT reflects state', () => {
    expect(evaluateWorkflowCondition({ type: 'HAS_ENGINEERING_CONTEXT' }, state)).toBe(true);
    expect(
      evaluateWorkflowCondition(
        { type: 'HAS_ENGINEERING_CONTEXT' },
        { ...state, hasEngineeringContext: false },
      ),
    ).toBe(false);
  });
});
