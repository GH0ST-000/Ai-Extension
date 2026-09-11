import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowStepType as Step } from '@project-x/types';

import { didApprovePlanMutateGithub, useWorkflowSessionStore } from './workflow.store';

const validPlanJson = JSON.stringify({
  id: 'plan-test',
  goal: 'Align PR with Jira',
  summary: 'Build context then analyze',
  assumptions: ['Scoped to the current PR.'],
  completionCriteria: [{ type: 'ANALYSIS_PRESENTED', artifactType: 'alignment' }],
  confidence: 'MEDIUM',
  steps: [
    {
      id: 's1',
      type: Step.BUILD_ENGINEERING_CONTEXT,
      title: 'Build context',
      description: 'Assemble engineering context',
      reason: 'Need trusted cross-context inputs',
      dependencies: [],
      requiredContext: [],
      executionMode: 'AUTO_READ',
      mutationRisk: 'NONE',
      status: 'PENDING',
    },
    {
      id: 's2',
      type: Step.ANALYZE_ENGINEERING_ALIGNMENT,
      title: 'Analyze',
      description: 'Cross-check alignment',
      reason: 'Assess requirement coverage',
      dependencies: ['s1'],
      requiredContext: [],
      executionMode: 'AUTO_READ',
      mutationRisk: 'NONE',
      status: 'PENDING',
    },
    {
      id: 's3',
      type: Step.REVIEW_PULL_REQUEST,
      title: 'Review PR',
      description: 'Review the pull request',
      reason: 'Surface findings before deciding next work',
      dependencies: ['s1'],
      requiredContext: ['github'],
      executionMode: 'AUTO_READ',
      mutationRisk: 'NONE',
      status: 'PENDING',
    },
  ],
});

describe('workflow.store', () => {
  beforeEach(() => {
    useWorkflowSessionStore.getState().clear();
  });

  it('rejects invalid plan JSON on ingest', () => {
    useWorkflowSessionStore.setState({
      pendingPlanGeneration: true,
      draftGoal: 'test goal',
      sessionsSnapshot: {},
    });
    const ok = useWorkflowSessionStore.getState().ingestPlan('not-json');
    expect(ok).toBe(false);
    expect(useWorkflowSessionStore.getState().session).toBeNull();
    expect(useWorkflowSessionStore.getState().lastError).toBeTruthy();
  });

  it('rejects plans with unknown capabilities', () => {
    useWorkflowSessionStore.setState({
      pendingPlanGeneration: true,
      draftGoal: 'test goal',
      sessionsSnapshot: {},
    });
    const bad = JSON.stringify({
      id: 'p',
      goal: 'g',
      summary: 's',
      steps: [
        {
          id: 'x',
          type: 'MERGE_PR',
          title: 'Merge',
          description: 'nope',
          dependencies: [],
          requiredContext: [],
          executionMode: 'AUTO_READ',
          mutationRisk: 'NONE',
          status: 'PENDING',
        },
        {
          id: 'y',
          type: Step.BUILD_ENGINEERING_CONTEXT,
          title: 'Build',
          description: 'b',
          dependencies: [],
          requiredContext: [],
          executionMode: 'AUTO_READ',
          mutationRisk: 'NONE',
          status: 'PENDING',
        },
        {
          id: 'z',
          type: Step.SUMMARIZE_JIRA,
          title: 'Sum',
          description: 's',
          dependencies: [],
          requiredContext: ['jira'],
          executionMode: 'AUTO_READ',
          mutationRisk: 'NONE',
          status: 'PENDING',
        },
      ],
    });
    const ok = useWorkflowSessionStore.getState().ingestPlan(bad);
    expect(ok).toBe(false);
    expect(useWorkflowSessionStore.getState().session).toBeNull();
  });

  it('ingests a valid plan into AWAITING_PLAN_APPROVAL with Day 21 fields', () => {
    useWorkflowSessionStore.setState({
      pendingPlanGeneration: true,
      draftGoal: 'Align PR with Jira',
      pendingAgentGoal: {
        id: 'goal-1',
        originalText: 'Align PR with Jira',
        normalizedIntent: {
          objective: 'Assess whether requirements are implemented',
          scope: {},
          desiredOutcome: 'ASSESS',
          constraints: [],
        },
        unsupportedRequests: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      pendingPlanningAssumptions: ['Project X will not merge the PR.'],
      sessionsSnapshot: {
        jiraIssue: {
          id: '1',
          key: 'PAY-1',
          project: { key: 'PAY' },
          summary: 'Pay',
          siteHost: 'acme.atlassian.net',
          fetchedAt: '2026-01-01T00:00:00.000Z',
        },
        pageSnapshot: {
          type: 'github',
          url: 'https://github.com/acme/api/pull/1',
          title: 'PR',
          github: {
            owner: 'acme',
            repository: 'api',
            pullRequestNumber: 1,
            headBranch: 'feat',
          },
        },
      },
    });
    const ok = useWorkflowSessionStore.getState().ingestPlan(validPlanJson);
    expect(ok).toBe(true);
    const session = useWorkflowSessionStore.getState().session;
    expect(session?.status).toBe('AWAITING_PLAN_APPROVAL');
    expect(session?.plan.steps.length).toBeGreaterThanOrEqual(3);
    expect(session?.budget).toBeTruthy();
    expect(session?.facts).toEqual([]);
    expect(session?.planHistory).toEqual([]);
    expect(session?.agentGoal?.normalizedIntent.desiredOutcome).toBe('ASSESS');
    expect(session?.plan.assumptions?.some((a) => a.includes('will not merge'))).toBe(true);
    expect(session?.plan.completionCriteria?.length).toBeGreaterThan(0);
  });

  it('approvePlan does not call apply/submit APIs', () => {
    useWorkflowSessionStore.setState({
      pendingPlanGeneration: true,
      draftGoal: 'Align PR with Jira',
      sessionsSnapshot: {
        pageSnapshot: {
          type: 'github',
          url: 'https://github.com/acme/api/pull/1',
          title: 'PR',
          github: {
            owner: 'acme',
            repository: 'api',
            pullRequestNumber: 1,
            headBranch: 'feat',
          },
        },
      },
    });
    expect(useWorkflowSessionStore.getState().ingestPlan(validPlanJson)).toBe(true);

    // Spy: approve must not flip any github-write sentinel.
    expect(didApprovePlanMutateGithub()).toBe(false);
    useWorkflowSessionStore.getState().approvePlan();
    expect(didApprovePlanMutateGithub()).toBe(false);

    const session = useWorkflowSessionStore.getState().session;
    // May be RUNNING / COMPLETED / FAILED / AWAITING_* depending on handlers + context;
    // never implies a write occurred.
    expect(session?.status).not.toBe('AWAITING_PLAN_APPROVAL');
    expect(useWorkflowSessionStore.getState().openPanelHint).not.toBe('patch');
  });

  it('pauses for ambiguous multi-jira goals instead of launching AI', () => {
    useWorkflowSessionStore.getState().setGoal('Check whether PAY-321 and PAY-322 are implemented');
    useWorkflowSessionStore.getState().requestPlan({
      pageSnapshot: {
        type: 'github',
        url: 'https://github.com/acme/api/pull/1',
        title: 'PR',
        github: {
          owner: 'acme',
          repository: 'api',
          pullRequestNumber: 1,
          headBranch: 'feat',
        },
      },
    });

    const state = useWorkflowSessionStore.getState();
    expect(state.pendingPlanGeneration).toBe(false);
    expect(state.pendingAiLaunch).toBeNull();
    expect(state.session?.status).toBe('AWAITING_CONTEXT_SELECTION');
    expect(state.session?.planningQuestions?.[0]?.options?.map((o) => o.id)).toEqual([
      'PAY-321',
      'PAY-322',
    ]);
  });

  it('answerPlanningQuestion sets trusted jira and launches planning', () => {
    useWorkflowSessionStore.getState().setGoal('Check whether PAY-321 and PAY-322 are implemented');
    useWorkflowSessionStore.getState().requestPlan({});
    expect(useWorkflowSessionStore.getState().session?.status).toBe('AWAITING_CONTEXT_SELECTION');

    useWorkflowSessionStore.getState().answerPlanningQuestion('PAY-321');
    const state = useWorkflowSessionStore.getState();
    expect(state.trustedJiraOverride).toBe('PAY-321');
    expect(state.pendingPlanGeneration).toBe(true);
    expect(state.pendingAiLaunch?.action).toBeTruthy();
    expect(state.session).toBeNull();
  });
});
