import type {
  AgentPlanConfidence,
  DeveloperAgentGoal,
  PlanningContext,
  PlanningLimitSummary,
  PlanningPolicySummary,
  ProjectMemorySummary,
  WorkflowArtifactRef,
  WorkflowArtifactSummary,
  WorkflowContextBinding,
} from '@project-x/types';
import {
  WORKFLOW_MAX_AI_CALLS,
  WORKFLOW_MAX_BRANCH_DEPTH,
  WORKFLOW_MAX_GOAL_CHARS,
  WORKFLOW_MAX_PLANNING_RETRIES,
  WORKFLOW_MAX_REPLANS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WRITE_CHECKPOINTS,
} from '@project-x/types';

import { getPlanningCapabilityDescriptions } from './capabilities';

export type BuildPlanningContextInput = {
  goal: DeveloperAgentGoal;
  binding: WorkflowContextBinding;
  available: {
    jira?: {
      issueKey: string;
      summary?: string;
      hasNormalizedIssue: boolean;
      criteriaCount?: number;
    };
    github?: {
      repository: string;
      prNumber: number;
      headSha: string;
      hasPrReport: boolean;
      findingCounts?: { high: number; medium: number; low: number };
      writeAccessAvailable?: boolean;
    };
    api?: {
      documentHash: string;
      operationKey?: string;
      hasContractAnalysis: boolean;
    };
    ci?: {
      headSha: string;
      overallStatus?: string;
      failedCheckCount: number;
      hasFailureAnalysis: boolean;
    };
  };
  artifacts?: Record<string, WorkflowArtifactRef>;
  confidence?: AgentPlanConfidence;
  assumptions?: string[];
  projectMemory?: ProjectMemorySummary;
  multiRepoSystem?: PlanningContext['multiRepoSystem'];
};

function summarizeArtifacts(
  artifacts: Record<string, WorkflowArtifactRef> | undefined,
): WorkflowArtifactSummary[] {
  if (!artifacts) return [];
  return Object.values(artifacts)
    .slice(0, 12)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      summary: a.summary?.slice(0, 120),
      status: a.provenanceStatus ?? 'CURRENT',
      createdAt: a.createdAt,
    }));
}

export function defaultPlanningPolicy(): PlanningPolicySummary {
  return {
    maxSteps: WORKFLOW_MAX_STEPS,
    maxWriteCheckpoints: WORKFLOW_MAX_WRITE_CHECKPOINTS,
    maxAiCalls: WORKFLOW_MAX_AI_CALLS,
    maxReplans: WORKFLOW_MAX_REPLANS,
    writesRequireConfirmation: true,
  };
}

export function defaultPlanningLimits(): PlanningLimitSummary {
  return {
    maxGoalChars: WORKFLOW_MAX_GOAL_CHARS,
    maxBranchDepth: WORKFLOW_MAX_BRANCH_DEPTH,
    maxPlanningRetries: WORKFLOW_MAX_PLANNING_RETRIES,
  };
}

export function inferPlanningConfidence(input: {
  goal: DeveloperAgentGoal;
  available: BuildPlanningContextInput['available'];
  ambiguousIdentities?: boolean;
}): AgentPlanConfidence {
  if (input.ambiguousIdentities) {
    return 'LOW';
  }
  const sources =
    Number(Boolean(input.available.jira)) +
    Number(Boolean(input.available.github)) +
    Number(Boolean(input.available.api)) +
    Number(Boolean(input.available.ci));
  if (sources >= 2 && input.goal.unsupportedRequests.length === 0) {
    return 'HIGH';
  }
  if (sources >= 1) {
    return 'MEDIUM';
  }
  return 'LOW';
}

/**
 * Bounded planning context — metadata/summaries only; never diffs, logs, tokens, or full specs.
 */
export function buildPlanningContext(input: BuildPlanningContextInput): PlanningContext {
  const assumptions = [...(input.assumptions ?? [])];
  if (input.available.github) {
    assumptions.push(
      `Analysis is scoped to PR #${input.available.github.prNumber} @ ${input.available.github.headSha.slice(0, 7)}.`,
    );
  }
  if (input.available.jira) {
    assumptions.push(`${input.available.jira.issueKey} is treated as the primary requirement.`);
  }
  if (input.available.api?.operationKey) {
    assumptions.push(
      `Only the selected API operation ${input.available.api.operationKey} is included.`,
    );
  }
  assumptions.push('Project X will not merge the PR.');
  assumptions.push('Project X will not modify Jira.');
  assumptions.push('Every repository write requires separate confirmation.');
  assumptions.push(
    'Multi-repo steps are read-only — never plan multi-repo writes, commits, or branch creation.',
  );

  if (input.multiRepoSystem) {
    assumptions.push(
      `Multi-repo analysis is limited to system ${input.multiRepoSystem.name ?? input.multiRepoSystem.systemId} (${input.multiRepoSystem.enabledRepositories} enabled repositories) — not organization-wide.`,
    );
  }

  if (input.goal.unsupportedRequests.length > 0) {
    assumptions.push(
      `Unsupported requests are out of scope: ${input.goal.unsupportedRequests.join(', ')}.`,
    );
  }

  return {
    goal: input.goal,
    availableContexts: {
      ...(input.available.jira ? { jira: input.available.jira } : {}),
      ...(input.available.github ? { github: input.available.github } : {}),
      ...(input.available.api ? { api: input.available.api } : {}),
      ...(input.available.ci ? { ci: input.available.ci } : {}),
    },
    availableArtifacts: summarizeArtifacts(input.artifacts),
    capabilities: getPlanningCapabilityDescriptions(),
    policy: defaultPlanningPolicy(),
    limits: defaultPlanningLimits(),
    confidence:
      input.confidence ??
      inferPlanningConfidence({
        goal: input.goal,
        available: input.available,
      }),
    assumptions: [...new Set(assumptions)].slice(0, 12),
    ...(input.projectMemory ? { projectMemory: input.projectMemory } : {}),
    ...(input.multiRepoSystem ? { multiRepoSystem: input.multiRepoSystem } : {}),
  };
}

/** Compact text for planner prompts — no credentials, diffs, or raw provider bodies. */
export function formatPlanningContextForPrompt(ctx: PlanningContext): string {
  const lines: string[] = [
    'PLANNING_CONTEXT (trusted application metadata):',
    `goal.objective=${ctx.goal.normalizedIntent.objective}`,
    `goal.desiredOutcome=${ctx.goal.normalizedIntent.desiredOutcome}`,
    `goal.confidence=${ctx.confidence}`,
    `goal.constraints=${ctx.goal.normalizedIntent.constraints.map((c) => c.type).join(',') || '(none)'}`,
    `unsupported=${ctx.goal.unsupportedRequests.join(',') || '(none)'}`,
    '',
    'AVAILABLE_CONTEXTS:',
  ];

  if (ctx.availableContexts.jira) {
    const j = ctx.availableContexts.jira;
    lines.push(
      `jira: key=${j.issueKey}; normalized=${j.hasNormalizedIssue}; criteriaCount=${j.criteriaCount ?? 0}`,
    );
  }
  if (ctx.availableContexts.github) {
    const g = ctx.availableContexts.github;
    lines.push(
      `github: repo=${g.repository}; pr=${g.prNumber}; head=${g.headSha}; hasPrReport=${g.hasPrReport}; findings=${
        g.findingCounts
          ? `h=${g.findingCounts.high},m=${g.findingCounts.medium},l=${g.findingCounts.low}`
          : 'unknown'
      }; writeAccess=${g.writeAccessAvailable ?? 'unknown'}`,
    );
  }
  if (ctx.availableContexts.api) {
    const a = ctx.availableContexts.api;
    lines.push(
      `api: hash=${a.documentHash}; op=${a.operationKey ?? 'none'}; hasAnalysis=${a.hasContractAnalysis}`,
    );
  }
  if (ctx.availableContexts.ci) {
    const c = ctx.availableContexts.ci;
    lines.push(
      `ci: head=${c.headSha}; status=${c.overallStatus ?? 'unknown'}; failed=${c.failedCheckCount}; hasAnalysis=${c.hasFailureAnalysis}`,
    );
  }

  lines.push('', 'AVAILABLE_ARTIFACTS:');
  if (ctx.availableArtifacts.length === 0) {
    lines.push('(none)');
  } else {
    for (const a of ctx.availableArtifacts) {
      lines.push(`- ${a.kind} id=${a.id} status=${a.status}`);
    }
  }

  lines.push('', 'ASSUMPTIONS:');
  for (const a of ctx.assumptions) {
    lines.push(`- ${a}`);
  }

  lines.push(
    '',
    'POLICY:',
    `maxSteps=${ctx.policy.maxSteps}; maxWrites=${ctx.policy.maxWriteCheckpoints}; maxAiCalls=${ctx.policy.maxAiCalls}; writesRequireConfirmation=true`,
    '',
    'PREFERENCE: REUSE existing fresh artifacts > FETCH > AI ANALYZE > WRITE. Prefer the smallest useful plan.',
  );

  if (ctx.projectMemory && ctx.projectMemory.relevantRules.length > 0) {
    lines.push(
      '',
      'PROJECT_MEMORY (prior facts/rules — current trusted source evidence wins if they conflict):',
      `memoryVersion=${ctx.projectMemory.version}`,
    );
    for (const rule of ctx.projectMemory.relevantRules.slice(0, 12)) {
      lines.push(
        `- [${rule.confidence.toUpperCase()}][${rule.category}] ${rule.key}: ${rule.text}`,
      );
    }
  }

  if (ctx.multiRepoSystem) {
    lines.push(
      '',
      'MULTI_REPO_SYSTEM (read-only scope — never org-wide; never plan multi-repo writes):',
      `systemId=${ctx.multiRepoSystem.systemId}; name=${ctx.multiRepoSystem.name ?? '(unnamed)'}; enabledRepos=${ctx.multiRepoSystem.enabledRepositories}`,
      'knownRelationships (max 8 summaries):',
    );
    if (ctx.multiRepoSystem.knownRelationships.length === 0) {
      lines.push('(none known yet in selected repositories)');
    } else {
      for (const rel of ctx.multiRepoSystem.knownRelationships.slice(0, 8)) {
        lines.push(`- ${rel}`);
      }
    }
    lines.push(
      'Scope wording: use “Known … in selected repositories”. Never claim organization-wide coverage.',
    );
  }

  return lines.join('\n');
}
