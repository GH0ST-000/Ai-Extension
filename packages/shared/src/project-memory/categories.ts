import type { ProjectMemoryCategory } from '@project-x/types';
import {
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
    case 'PR_REVIEW':
      return [
        Categories.ARCHITECTURE,
        Categories.CODE_CONVENTION,
        Categories.ERROR_HANDLING,
        Categories.SECURITY_CONVENTION,
        Categories.TESTING_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
        Categories.REVIEW_CONVENTION,
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
      ];
    case 'JIRA_TECH_PLAN':
      return [
        Categories.ARCHITECTURE,
        Categories.SERVICE_RESPONSIBILITY,
        Categories.API_CONVENTION,
        Categories.DATABASE_CONVENTION,
        Categories.TESTING_CONVENTION,
        Categories.PROJECT_CONSTRAINT,
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
