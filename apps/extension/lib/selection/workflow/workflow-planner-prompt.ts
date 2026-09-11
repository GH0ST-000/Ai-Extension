import type { DeveloperAgentGoal, WorkflowContextBinding } from '@project-x/types';
import { WORKFLOW_MAX_GOAL_CHARS } from '@project-x/types';
import { formatCapabilityCatalogForPlanner } from '@project-x/shared';

export type WorkflowAvailableFlags = {
  jira: boolean;
  github: boolean;
  api: boolean;
  ci: boolean;
};

export type BuildPlannerPromptOptions = {
  planningContextText?: string;
  agentGoal?: DeveloperAgentGoal;
  catalogText?: string;
};

/**
 * Build the planner user payload: goal + binding identities + available flags + catalog.
 * Credentials and raw provider objects are never included.
 */
export function buildPlannerPrompt(
  goal: string,
  binding: WorkflowContextBinding,
  flags: WorkflowAvailableFlags,
  catalogText?: string,
  options?: BuildPlannerPromptOptions,
): string {
  const trimmedGoal = goal.trim().slice(0, WORKFLOW_MAX_GOAL_CHARS);
  const catalog = options?.catalogText ?? catalogText ?? formatCapabilityCatalogForPlanner();
  const lines: string[] = [
    'Developer workflow planning request',
    '',
    'USER_GOAL (untrusted):',
    trimmedGoal || '(empty)',
    '',
  ];

  if (options?.agentGoal) {
    const g = options.agentGoal;
    lines.push(
      'AGENT_GOAL_SUMMARY (trusted normalization):',
      `objective=${g.normalizedIntent.objective}`,
      `desiredOutcome=${g.normalizedIntent.desiredOutcome}`,
      `constraints=${g.normalizedIntent.constraints.map((c) => c.type).join(',') || '(none)'}`,
      `unsupported=${g.unsupportedRequests.join(',') || '(none)'}`,
      '',
    );
  }

  lines.push(
    'AVAILABLE_CONTEXT_FLAGS (trusted metadata):',
    `jira=${flags.jira}`,
    `github=${flags.github}`,
    `api=${flags.api}`,
    `ci=${flags.ci}`,
    '',
    'CONTEXT_BINDING (trusted identities only):',
  );

  if (binding.jira) {
    lines.push(`jira.issueKey=${binding.jira.issueKey}`);
    if (binding.jira.updatedAt) {
      lines.push(`jira.updatedAt=${binding.jira.updatedAt}`);
    }
  }
  if (binding.github) {
    lines.push(`github.repository=${binding.github.repository}`);
    lines.push(`github.prNumber=${binding.github.prNumber}`);
    lines.push(`github.headSha=${binding.github.headSha}`);
  }
  if (binding.api) {
    lines.push(`api.documentHash=${binding.api.documentHash}`);
    if (binding.api.operationKey) {
      lines.push(`api.operationKey=${binding.api.operationKey}`);
    }
  }
  if (binding.ci) {
    lines.push(`ci.headSha=${binding.ci.headSha}`);
    if (binding.ci.checkIds?.length) {
      lines.push(`ci.checkIds=${binding.ci.checkIds.join(',')}`);
    }
  }

  if (options?.planningContextText) {
    lines.push('', options.planningContextText);
  }

  lines.push('', catalog, '', 'Return DeveloperWorkflowPlan JSON only.');
  return lines.join('\n');
}
