import { describe, expect, it } from 'vitest';
import type {
  DeveloperWorkflowPlan,
  DeveloperWorkflowSession,
  WorkflowArtifactRef,
  WorkflowStepResult,
} from '@project-x/types';
import { WorkflowStepType } from '@project-x/types';

import { buildWorkflowGoalOutcome, isCompletionCriterionSatisfied } from './completion';
import { createWorkflowFact } from './facts';

const now = '2026-09-12T00:00:00.000Z';

function makePlan(
  overrides?: Partial<DeveloperWorkflowPlan> & {
    steps?: DeveloperWorkflowPlan['steps'];
  },
): DeveloperWorkflowPlan {
  return {
    id: 'plan-1',
    goal: 'Test goal',
    summary: 'Test',
    steps: overrides?.steps ?? [
      {
        id: 's1',
        type: WorkflowStepType.REVIEW_PULL_REQUEST,
        title: 'Review',
        description: 'Review',
        dependencies: [],
        requiredContext: ['github'],
        executionMode: 'AUTO_READ',
        mutationRisk: 'NONE',
        status: 'PENDING',
      },
    ],
    completionCriteria: overrides?.completionCriteria,
    ...overrides,
  };
}

function makeSession(input: {
  plan?: DeveloperWorkflowPlan;
  stepResults?: Record<string, WorkflowStepResult>;
  artifacts?: Record<string, WorkflowArtifactRef>;
  facts?: DeveloperWorkflowSession['facts'];
  status?: DeveloperWorkflowSession['status'];
}): DeveloperWorkflowSession {
  return {
    id: 'wf-1',
    goal: 'Test goal',
    createdAt: now,
    updatedAt: now,
    contextBinding: {},
    status: input.status ?? 'RUNNING',
    plan: input.plan ?? makePlan(),
    stepResults: input.stepResults ?? {},
    artifacts: input.artifacts ?? {},
    facts: input.facts,
    execution: {},
  };
}

function artifact(
  kind: WorkflowArtifactRef['kind'],
  id = `${kind}-1`,
  provenanceStatus: WorkflowArtifactRef['provenanceStatus'] = 'CURRENT',
): WorkflowArtifactRef {
  return { id, kind, createdAt: now, provenanceStatus };
}

describe('isCompletionCriterionSatisfied', () => {
  it('satisfies ANALYSIS_PRESENTED via current alignment artifact', () => {
    const session = makeSession({
      artifacts: { a1: artifact('alignment') },
    });
    expect(
      isCompletionCriterionSatisfied(
        { type: 'ANALYSIS_PRESENTED', artifactType: 'alignment' },
        session,
      ),
    ).toBe(true);
  });

  it('satisfies PR_REVIEW_COMPLETED via review artifact or succeeded step', () => {
    expect(
      isCompletionCriterionSatisfied(
        { type: 'PR_REVIEW_COMPLETED' },
        makeSession({ artifacts: { r: artifact('pr-review') } }),
      ),
    ).toBe(true);

    expect(
      isCompletionCriterionSatisfied(
        { type: 'PR_REVIEW_COMPLETED' },
        makeSession({
          stepResults: {
            s1: { stepId: 's1', status: 'SUCCEEDED' },
          },
        }),
      ),
    ).toBe(true);
  });

  it('satisfies PATCH_PREPARED via fact, artifact, or step', () => {
    expect(
      isCompletionCriterionSatisfied(
        { type: 'PATCH_PREPARED' },
        makeSession({ facts: [createWorkflowFact('PATCH_PREPARED', true)] }),
      ),
    ).toBe(true);
    expect(
      isCompletionCriterionSatisfied(
        { type: 'PATCH_PREPARED' },
        makeSession({ artifacts: { p: artifact('prepared-patch') } }),
      ),
    ).toBe(true);
  });

  it('satisfies PATCH_APPLIED via fact, commit artifact, or APPLY_PATCH step', () => {
    expect(
      isCompletionCriterionSatisfied(
        { type: 'PATCH_APPLIED' },
        makeSession({ facts: [createWorkflowFact('PATCH_APPLIED', true)] }),
      ),
    ).toBe(true);
    expect(
      isCompletionCriterionSatisfied(
        { type: 'PATCH_APPLIED' },
        makeSession({ artifacts: { c: artifact('commit') } }),
      ),
    ).toBe(true);
  });

  it('satisfies CI_CHECK_VERIFIED only with CI_TARGET_PASSED fact', () => {
    expect(
      isCompletionCriterionSatisfied(
        { type: 'CI_CHECK_VERIFIED', expected: 'PASSED' },
        makeSession({ facts: [createWorkflowFact('CI_TARGET_PASSED', true)] }),
      ),
    ).toBe(true);
    expect(
      isCompletionCriterionSatisfied(
        { type: 'CI_CHECK_VERIFIED', expected: 'PASSED' },
        makeSession({
          facts: [],
          stepResults: {
            s1: {
              stepId: 's1',
              status: 'SUCCEEDED',
              summary: 'AI says CI passed',
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it('satisfies REVIEW_DRAFT_PREPARED and REVIEW_SUBMITTED', () => {
    expect(
      isCompletionCriterionSatisfied(
        { type: 'REVIEW_DRAFT_PREPARED' },
        makeSession({ artifacts: { d: artifact('review-draft') } }),
      ),
    ).toBe(true);

    const submitPlan = makePlan({
      steps: [
        {
          id: 'submit',
          type: WorkflowStepType.SUBMIT_PR_REVIEW,
          title: 'Submit',
          description: 'Submit',
          dependencies: [],
          requiredContext: ['github'],
          executionMode: 'EXPLICIT_CONFIRMATION',
          mutationRisk: 'WRITE',
          status: 'SUCCEEDED',
        },
      ],
    });
    expect(
      isCompletionCriterionSatisfied(
        { type: 'REVIEW_SUBMITTED' },
        makeSession({
          plan: submitPlan,
          stepResults: { submit: { stepId: 'submit', status: 'SUCCEEDED' } },
        }),
      ),
    ).toBe(true);
  });
});

describe('buildWorkflowGoalOutcome', () => {
  it('returns ACHIEVED when all criteria are satisfied', () => {
    const session = makeSession({
      plan: makePlan({
        completionCriteria: [{ type: 'PR_REVIEW_COMPLETED' }],
      }),
      artifacts: { r: artifact('pr-review') },
    });
    const outcome = buildWorkflowGoalOutcome({ session });
    expect(outcome.status).toBe('ACHIEVED');
    expect(outcome.satisfiedCriteria.length).toBe(1);
    expect(outcome.unsatisfiedCriteria).toEqual([]);
  });

  it('returns PARTIALLY_ACHIEVED when some criteria remain', () => {
    const session = makeSession({
      plan: makePlan({
        completionCriteria: [{ type: 'PATCH_PREPARED' }, { type: 'PATCH_APPLIED' }],
      }),
      facts: [createWorkflowFact('PATCH_PREPARED', true)],
    });
    const outcome = buildWorkflowGoalOutcome({ session });
    expect(outcome.status).toBe('PARTIALLY_ACHIEVED');
    expect(outcome.satisfiedCriteria.length).toBe(1);
    expect(outcome.unsatisfiedCriteria.length).toBe(1);
  });

  it('returns NOT_ACHIEVED when nothing is satisfied', () => {
    const session = makeSession({
      plan: makePlan({
        completionCriteria: [{ type: 'PATCH_APPLIED' }],
      }),
    });
    expect(buildWorkflowGoalOutcome({ session }).status).toBe('NOT_ACHIEVED');
  });

  it('returns CANCELLED when cancelled', () => {
    const session = makeSession({
      status: 'CANCELLED',
      plan: makePlan({
        completionCriteria: [{ type: 'PR_REVIEW_COMPLETED' }],
      }),
    });
    expect(buildWorkflowGoalOutcome({ session }).status).toBe('CANCELLED');
    expect(buildWorkflowGoalOutcome({ session: makeSession({}), cancelled: true }).status).toBe(
      'CANCELLED',
    );
  });

  it('returns BLOCKED when blockers are provided', () => {
    const outcome = buildWorkflowGoalOutcome({
      session: makeSession({
        plan: makePlan({
          completionCriteria: [{ type: 'PR_REVIEW_COMPLETED' }],
        }),
      }),
      blocked: [{ code: 'AGENT_BLOCKED', message: 'GitHub disconnected' }],
    });
    expect(outcome.status).toBe('BLOCKED');
    expect(outcome.blockers?.[0]?.message).toBe('GitHub disconnected');
  });

  it('does not let AI prose satisfy CI without the trusted fact', () => {
    const session = makeSession({
      plan: makePlan({
        completionCriteria: [{ type: 'CI_CHECK_VERIFIED', expected: 'PASSED' }],
        steps: [
          {
            id: 'verify',
            type: WorkflowStepType.VERIFY_CI_FIX,
            title: 'Verify',
            description: 'Verify',
            dependencies: [],
            requiredContext: ['ci'],
            executionMode: 'AUTO_READ',
            mutationRisk: 'NONE',
            status: 'SUCCEEDED',
          },
        ],
      }),
      stepResults: {
        verify: {
          stepId: 'verify',
          status: 'SUCCEEDED',
          summary: 'All checks are green according to the model.',
        },
      },
      facts: [],
    });
    const outcome = buildWorkflowGoalOutcome({ session });
    expect(outcome.status).toBe('NOT_ACHIEVED');
    expect(outcome.unsatisfiedCriteria[0]).toMatch(/CI check verified/i);
  });
});
