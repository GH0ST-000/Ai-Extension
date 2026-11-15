import type { ProjectMemoryCategory } from '@project-x/types';
import {
  AIAction,
  PROJECT_MEMORY_CATEGORY_VALUES,
  ProjectMemoryCategory as Categories,
} from '@project-x/types';

const CATEGORY_SET = new Set<string>(PROJECT_MEMORY_CATEGORY_VALUES);

export { PROJECT_MEMORY_CATEGORY_VALUES };

export function isKnownProjectMemoryCategory(value: string): value is ProjectMemoryCategory {
  return CATEGORY_SET.has(value);
}

/**
 * Deterministic category relevance for capability / action contexts.
 * Never invent categories; only return allowlisted values.
 */
export function categoryRelevanceForCapability(capability: string): ProjectMemoryCategory[] {
  switch (capability) {
    // Every category a user can pick for an explicit rule (EXPLICIT_PROJECT_RULE_CATEGORIES)
    // must reach PR review and patch generation; otherwise a saved rule is silently inert.
    case 'PR_REVIEW':
      return [
        Categories.ARCHITECTURE,
        Categories.CODE_CONVENTION,
        Categories.ERROR_HANDLING,
        Categories.SECURITY_CONVENTION,
        Categories.TESTING_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
        Categories.REVIEW_CONVENTION,
        Categories.TECHNICAL_DECISION,
        Categories.DEPENDENCY_CONVENTION,
        Categories.USER_PREFERENCE,
      ];
    case 'GENERATE_PATCH':
      return [
        Categories.ARCHITECTURE,
        Categories.CODE_CONVENTION,
        Categories.NAMING_CONVENTION,
        Categories.ERROR_HANDLING,
        Categories.TESTING_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
        Categories.DEPENDENCY_CONVENTION,
        Categories.TECHNICAL_DECISION,
        Categories.REVIEW_CONVENTION,
        Categories.USER_PREFERENCE,
      ];
    case 'JIRA_TECH_PLAN':
      return [
        Categories.ARCHITECTURE,
        Categories.SERVICE_RESPONSIBILITY,
        Categories.API_CONVENTION,
        Categories.DATABASE_CONVENTION,
        Categories.TESTING_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
        Categories.TECHNICAL_DECISION,
      ];
    case 'OPENAPI_ANALYSIS':
      return [
        Categories.API_CONVENTION,
        Categories.ERROR_HANDLING,
        Categories.SECURITY_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
      ];
    case 'PLANNING':
      return [
        Categories.ARCHITECTURE,
        Categories.PROJECT_CONSTRAINT,
        Categories.SERVICE_RESPONSIBILITY,
        Categories.DEPENDENCY_CONVENTION,
        Categories.USER_PREFERENCE,
        Categories.TECHNICAL_DECISION,
      ];
    case 'EXPLAIN_CODE':
      return [
        Categories.ARCHITECTURE,
        Categories.CODE_CONVENTION,
        Categories.NAMING_CONVENTION,
        Categories.FRAMEWORK,
        Categories.SERVICE_RESPONSIBILITY,
      ];
    default:
      return [Categories.PROJECT_CONSTRAINT, Categories.ARCHITECTURE];
  }
}

export type ProjectMemoryCapability =
  | 'PLANNING'
  | 'PR_REVIEW'
  | 'GENERATE_PATCH'
  | 'JIRA_TECH_PLAN'
  | 'OPENAPI_ANALYSIS'
  | 'EXPLAIN_CODE';

/** AI actions that receive project memory, and the retrieval capability each uses. */
const MEMORY_CAPABILITY_BY_ACTION: Partial<Record<AIAction, ProjectMemoryCapability>> = {
  [AIAction.REVIEW_ENTIRE_PR]: 'PR_REVIEW',
  [AIAction.SUGGEST_FIX]: 'GENERATE_PATCH',
  [AIAction.PLAN_DEVELOPER_WORKFLOW]: 'PLANNING',
  [AIAction.ANALYZE_ENGINEERING_ALIGNMENT]: 'PLANNING',
  [AIAction.CREATE_TECHNICAL_PLAN]: 'JIRA_TECH_PLAN',
};

export function memoryCapabilityForAiAction(action: AIAction): ProjectMemoryCapability | null {
  return MEMORY_CAPABILITY_BY_ACTION[action] ?? null;
}
