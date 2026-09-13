import { AIAction } from '@project-x/types';
import type { ProductFeature } from '@project-x/types';

/** Map AI actions to product features. Billing/admin are never AI-reachable. */
export function featureForAiAction(action: AIAction): ProductFeature {
  switch (action) {
    case AIAction.PLAN_DEVELOPER_WORKFLOW:
      return 'WORKFLOW_AGENT';
    case AIAction.SUMMARIZE_JIRA_ISSUE:
    case AIAction.EXTRACT_ACCEPTANCE_CRITERIA:
    case AIAction.CREATE_TECHNICAL_PLAN:
    case AIAction.ANALYZE_JIRA_RISKS:
    case AIAction.COMPARE_JIRA_WITH_PR:
      return 'JIRA_INTELLIGENCE';
    case AIAction.EXPLAIN_API_ENDPOINT:
    case AIAction.EXPLAIN_API_REQUEST:
    case AIAction.EXPLAIN_API_RESPONSE:
    case AIAction.GENERATE_API_EXAMPLE:
    case AIAction.ANALYZE_API_CONTRACT:
    case AIAction.COMPARE_API_WITH_JIRA:
    case AIAction.ANALYZE_API_CHANGES:
      return 'OPENAPI_INTELLIGENCE';
    case AIAction.REVIEW_ENTIRE_PR:
    case AIAction.ANALYZE_CI_FAILURE:
    case AIAction.ANALYZE_ENGINEERING_ALIGNMENT:
      return 'GITHUB_INTELLIGENCE';
    default:
      return 'AI_ACTIONS';
  }
}

export function usageMetricForAiAction(action: AIAction): 'ai_action' | 'workflow_run' {
  if (action === AIAction.PLAN_DEVELOPER_WORKFLOW) {
    return 'workflow_run';
  }
  return 'ai_action';
}
