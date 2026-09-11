import { AIAction } from '@project-x/types';

export type AssistantTabId = 'text' | 'github' | 'jira' | 'api';

export type AssistantTab = {
  id: AssistantTabId;
  label: string;
};

export const ASSISTANT_TABS: readonly AssistantTab[] = [
  { id: 'text', label: 'Text' },
  { id: 'github', label: 'GitHub' },
  { id: 'jira', label: 'Jira' },
  { id: 'api', label: 'API' },
] as const;

/** Verbal / writing / general diagnostics. */
export const TEXT_TAB_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.EXPLAIN,
  AIAction.IMPROVE_WRITING,
  AIAction.SUMMARIZE,
  AIAction.TRANSLATE,
  AIAction.CUSTOM,
  AIAction.UNDERSTAND_ERROR,
  AIAction.FIND_ROOT_CAUSE,
]);

/** GitHub / code-review oriented. */
export const GITHUB_TAB_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.EXPLAIN_CODE,
  AIAction.REVIEW_CODE,
  AIAction.SUGGEST_FIX,
  AIAction.REVIEW_ENTIRE_PR,
]);

/** Jira issue intelligence. */
export const JIRA_TAB_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.SUMMARIZE_JIRA_ISSUE,
  AIAction.EXTRACT_ACCEPTANCE_CRITERIA,
  AIAction.CREATE_TECHNICAL_PLAN,
  AIAction.ANALYZE_JIRA_RISKS,
  AIAction.COMPARE_JIRA_WITH_PR,
]);

/** OpenAPI / Swagger intelligence. */
export const API_TAB_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.EXPLAIN_API_ENDPOINT,
  AIAction.EXPLAIN_API_REQUEST,
  AIAction.EXPLAIN_API_RESPONSE,
  AIAction.GENERATE_API_EXAMPLE,
  AIAction.ANALYZE_API_CONTRACT,
  AIAction.COMPARE_API_WITH_JIRA,
  AIAction.ANALYZE_API_CHANGES,
]);

export function actionsForTab(tab: AssistantTabId): ReadonlySet<AIAction> {
  switch (tab) {
    case 'text':
      return TEXT_TAB_ACTIONS;
    case 'github':
      return GITHUB_TAB_ACTIONS;
    case 'jira':
      return JIRA_TAB_ACTIONS;
    case 'api':
      return API_TAB_ACTIONS;
  }
}

export function resolveDefaultAssistantTab(input: {
  pageType?: string | null;
  hasOpenApi?: boolean;
  hasJiraIssue?: boolean;
  hasGithub?: boolean;
}): AssistantTabId {
  if (input.hasOpenApi || input.pageType === 'openapi') {
    return 'api';
  }
  if (input.hasJiraIssue || input.pageType === 'jira') {
    return 'jira';
  }
  if (input.hasGithub || input.pageType === 'github') {
    return 'github';
  }
  return 'text';
}
