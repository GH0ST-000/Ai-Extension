import { describe, expect, it } from 'vitest';
import type { DeveloperAgentGoal, WorkflowArtifactRef } from '@project-x/types';
import { WORKFLOW_MAX_STEPS } from '@project-x/types';

import {
  buildPlanningContext,
  formatPlanningContextForPrompt,
  inferPlanningConfidence,
} from './planning-context';

const goal: DeveloperAgentGoal = {
  id: 'goal-1',
  originalText: 'Review this PR',
  normalizedIntent: {
    objective: 'Review the pull request',
    scope: { pullRequestNumber: 42 },
    desiredOutcome: 'REVIEW',
    constraints: [],
  },
  unsupportedRequests: [],
  createdAt: '2026-09-12T00:00:00.000Z',
};

describe('buildPlanningContext', () => {
  it('builds bounded context without full diffs or raw bodies', () => {
    const ctx = buildPlanningContext({
      goal,
      binding: {
        github: {
          repository: 'acme/pay',
          prNumber: 42,
          headSha: 'abcdef0123456789',
        },
      },
      available: {
        github: {
          repository: 'acme/pay',
          prNumber: 42,
          headSha: 'abcdef0123456789',
          hasPrReport: true,
          findingCounts: { high: 1, medium: 2, low: 0 },
          writeAccessAvailable: true,
        },
        jira: {
          issueKey: 'PAY-321',
          summary: 'Retry payments',
          hasNormalizedIssue: true,
          criteriaCount: 3,
        },
      },
      artifacts: {
        r1: {
          id: 'r1',
          kind: 'pr-review',
          summary: 'Review summary',
          createdAt: '2026-09-12T00:00:00.000Z',
          provenanceStatus: 'CURRENT',
        } satisfies WorkflowArtifactRef,
      },
    });

    expect(ctx.policy.maxSteps).toBe(WORKFLOW_MAX_STEPS);
    expect(ctx.availableContexts.github?.hasPrReport).toBe(true);
    expect(ctx.availableArtifacts).toHaveLength(1);
    expect(JSON.stringify(ctx)).not.toMatch(/diff|patch hunk|@@ -/i);
    expect(ctx.assumptions.some((a) => a.includes('will not merge'))).toBe(true);
  });
});

describe('formatPlanningContextForPrompt', () => {
  it('omits token-like strings when secrets are not provided', () => {
    const ctx = buildPlanningContext({
      goal,
      binding: {},
      available: {
        github: {
          repository: 'acme/pay',
          prNumber: 42,
          headSha: 'abc1234',
          hasPrReport: false,
        },
      },
    });
    const text = formatPlanningContextForPrompt(ctx);
    expect(text).toContain('PLANNING_CONTEXT');
    expect(text).toContain('github: repo=acme/pay');
    expect(text).not.toMatch(/ghp_[A-Za-z0-9]+/);
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/);
    expect(text).not.toMatch(/xox[baprs]-/);
    expect(text).not.toMatch(/api[_-]?key\s*=/i);
    expect(text).not.toMatch(/authorization:/i);
  });

  it('includes PROJECT_MEMORY rules with key and text', () => {
    const ctx = buildPlanningContext({
      goal,
      binding: {},
      available: {
        github: {
          repository: 'acme/pay',
          prNumber: 42,
          headSha: 'abc1234',
          hasPrReport: false,
        },
      },
      projectMemory: {
        version: 'pmv-1-abc',
        relevantRules: [
          {
            category: 'ARCHITECTURE',
            key: 'stack',
            text: 'NestJS API + React extension',
            confidence: 'high',
          },
        ],
      },
    });
    const text = formatPlanningContextForPrompt(ctx);
    expect(text).toContain('PROJECT_MEMORY');
    expect(text).toContain('stack: NestJS API + React extension');
    expect(text).toContain('memoryVersion=pmv-1-abc');
  });
});

describe('inferPlanningConfidence', () => {
  it('returns HIGH with multiple sources and no unsupported requests', () => {
    expect(
      inferPlanningConfidence({
        goal,
        available: {
          github: {
            repository: 'acme/pay',
            prNumber: 1,
            headSha: 'a',
            hasPrReport: true,
          },
          jira: {
            issueKey: 'PAY-1',
            hasNormalizedIssue: true,
          },
        },
      }),
    ).toBe('HIGH');
  });

  it('returns MEDIUM with a single source', () => {
    expect(
      inferPlanningConfidence({
        goal,
        available: {
          ci: {
            headSha: 'a',
            failedCheckCount: 1,
            hasFailureAnalysis: false,
          },
        },
      }),
    ).toBe('MEDIUM');
  });

  it('returns LOW with no sources or ambiguous identities', () => {
    expect(inferPlanningConfidence({ goal, available: {} })).toBe('LOW');
    expect(
      inferPlanningConfidence({
        goal,
        available: {
          github: {
            repository: 'acme/pay',
            prNumber: 1,
            headSha: 'a',
            hasPrReport: true,
          },
          jira: { issueKey: 'PAY-1', hasNormalizedIssue: true },
        },
        ambiguousIdentities: true,
      }),
    ).toBe('LOW');
  });
});
