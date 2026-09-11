import { describe, expect, it } from 'vitest';
import { WorkflowStepType } from '@project-x/types';

import { CAPABILITY_CATALOG, getCapability, getPlannerCapabilitySummaries } from './capabilities';

describe('CAPABILITY_CATALOG', () => {
  it('marks every WRITE step as EXPLICIT_CONFIRMATION', () => {
    const writeTypes = (
      Object.keys(CAPABILITY_CATALOG) as Array<keyof typeof CAPABILITY_CATALOG>
    ).filter((type) => CAPABILITY_CATALOG[type].mutationRisk === 'WRITE');

    expect(writeTypes.length).toBeGreaterThan(0);
    for (const type of writeTypes) {
      expect(CAPABILITY_CATALOG[type].executionMode).toBe('EXPLICIT_CONFIRMATION');
    }
  });

  it('includes APPLY_PATCH / submit writes as confirmation writes', () => {
    for (const type of [
      WorkflowStepType.APPLY_PATCH,
      WorkflowStepType.SUBMIT_PR_COMMENT,
      WorkflowStepType.SUBMIT_PR_REVIEW,
    ] as const) {
      const cap = getCapability(type);
      expect(cap.mutationRisk).toBe('WRITE');
      expect(cap.executionMode).toBe('EXPLICIT_CONFIRMATION');
    }
  });

  it('exposes planner-safe summaries without handlers', () => {
    const summaries = getPlannerCapabilitySummaries();
    expect(summaries.length).toBe(Object.keys(CAPABILITY_CATALOG).length);
    for (const summary of summaries) {
      expect(summary).toEqual(
        expect.objectContaining({
          type: expect.any(String),
          title: expect.any(String),
          description: expect.any(String),
          mutationRisk: expect.stringMatching(/^(NONE|LOW|WRITE)$/),
          executionMode: expect.stringMatching(/^(AUTO_READ|USER_DECISION|EXPLICIT_CONFIRMATION)$/),
          requiredContext: expect.any(Array),
          consumes: expect.any(Array),
          produces: expect.any(Array),
          costClass: expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/),
        }),
      );
      expect(summary).not.toHaveProperty('handler');
      expect(summary).not.toHaveProperty('plannerVisible');
      expect(summary).not.toHaveProperty('preconditions');
    }
  });

  it('requires catalog entries to declare Day 21 capability fields', () => {
    for (const type of Object.keys(CAPABILITY_CATALOG) as Array<keyof typeof CAPABILITY_CATALOG>) {
      const cap = CAPABILITY_CATALOG[type];
      expect(Array.isArray(cap.consumes)).toBe(true);
      expect(Array.isArray(cap.produces)).toBe(true);
      expect(Array.isArray(cap.preconditions)).toBe(true);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(cap.costClass);
    }
  });

  it('does not catalog forbidden capabilities', () => {
    const forbidden = [
      'MERGE_PR',
      'RUN_SHELL',
      'FORCE_PUSH',
      'UPDATE_JIRA',
      'CALL_API_ENDPOINT',
      'RERUN_WORKFLOW',
    ];
    for (const type of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(CAPABILITY_CATALOG, type)).toBe(false);
    }
  });
});
