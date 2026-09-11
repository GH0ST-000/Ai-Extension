import { AIAction, type ContentType, type ErrorClassification } from '@project-x/types';

import { AI_ACTIONS } from '../constants';
import type { AiActionDefinition } from '../types';
import { classifyContent, type RankingHints } from './classify-content';
import { classifyError } from '../error-intelligence';

/**
 * Preferred action order per content type. Every AIAction must appear exactly once.
 */
/** Day 17 Jira actions — appended unless a Jira-specific prefix elevates them. */
const JIRA_ACTIONS_TAIL: readonly AIAction[] = [
  AIAction.SUMMARIZE_JIRA_ISSUE,
  AIAction.EXTRACT_ACCEPTANCE_CRITERIA,
  AIAction.CREATE_TECHNICAL_PLAN,
  AIAction.ANALYZE_JIRA_RISKS,
  AIAction.COMPARE_JIRA_WITH_PR,
];

/** Day 18 OpenAPI actions — appended after Jira unless elevated elsewhere. */
const OPENAPI_ACTIONS_TAIL: readonly AIAction[] = [
  AIAction.EXPLAIN_API_ENDPOINT,
  AIAction.EXPLAIN_API_REQUEST,
  AIAction.EXPLAIN_API_RESPONSE,
  AIAction.GENERATE_API_EXAMPLE,
  AIAction.ANALYZE_API_CONTRACT,
  AIAction.COMPARE_API_WITH_JIRA,
  AIAction.ANALYZE_API_CHANGES,
];

/** Day 19 cross-context — banner-only; still ranked for assertCompleteRanking. */
const ENGINEERING_ACTIONS_TAIL: readonly AIAction[] = [AIAction.ANALYZE_ENGINEERING_ALIGNMENT];

/** Day 20 workflow planner — Flow tab owns UX; still ranked for assertCompleteRanking. */
const WORKFLOW_ACTIONS_TAIL: readonly AIAction[] = [AIAction.PLAN_DEVELOPER_WORKFLOW];

const RANKINGS: Record<ContentType, readonly AIAction[]> = {
  code: [
    AIAction.EXPLAIN_CODE,
    AIAction.REVIEW_CODE,
    AIAction.SUGGEST_FIX,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.EXPLAIN,
    AIAction.FIND_ROOT_CAUSE,
    AIAction.UNDERSTAND_ERROR,
    AIAction.CUSTOM,
    AIAction.SUMMARIZE,
    AIAction.TRANSLATE,
    AIAction.IMPROVE_WRITING,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
  error: [
    AIAction.FIND_ROOT_CAUSE,
    AIAction.SUGGEST_FIX,
    AIAction.UNDERSTAND_ERROR,
    AIAction.EXPLAIN_CODE,
    AIAction.CUSTOM,
    AIAction.EXPLAIN,
    AIAction.REVIEW_CODE,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.SUMMARIZE,
    AIAction.TRANSLATE,
    AIAction.IMPROVE_WRITING,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
  prose: [
    AIAction.SUMMARIZE,
    AIAction.EXPLAIN,
    AIAction.IMPROVE_WRITING,
    AIAction.TRANSLATE,
    AIAction.CUSTOM,
    AIAction.REVIEW_CODE,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.SUGGEST_FIX,
    AIAction.EXPLAIN_CODE,
    AIAction.FIND_ROOT_CAUSE,
    AIAction.UNDERSTAND_ERROR,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
  'short-text': [
    AIAction.EXPLAIN,
    AIAction.IMPROVE_WRITING,
    AIAction.TRANSLATE,
    AIAction.CUSTOM,
    AIAction.SUMMARIZE,
    AIAction.REVIEW_CODE,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.SUGGEST_FIX,
    AIAction.EXPLAIN_CODE,
    AIAction.FIND_ROOT_CAUSE,
    AIAction.UNDERSTAND_ERROR,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
  'structured-data': [
    AIAction.EXPLAIN,
    AIAction.SUMMARIZE,
    AIAction.CUSTOM,
    AIAction.REVIEW_CODE,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.SUGGEST_FIX,
    AIAction.TRANSLATE,
    AIAction.EXPLAIN_CODE,
    AIAction.IMPROVE_WRITING,
    AIAction.FIND_ROOT_CAUSE,
    AIAction.UNDERSTAND_ERROR,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
  unknown: [
    AIAction.EXPLAIN,
    AIAction.IMPROVE_WRITING,
    AIAction.SUMMARIZE,
    AIAction.TRANSLATE,
    AIAction.EXPLAIN_CODE,
    AIAction.REVIEW_CODE,
    AIAction.SUGGEST_FIX,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.CUSTOM,
    AIAction.FIND_ROOT_CAUSE,
    AIAction.UNDERSTAND_ERROR,
    ...JIRA_ACTIONS_TAIL,
    ...OPENAPI_ACTIONS_TAIL,
    ...ENGINEERING_ACTIONS_TAIL,
    ...WORKFLOW_ACTIONS_TAIL,
  ],
};

/** Strong runtime / type errors — root cause first. */
const ERROR_RUNTIME_PREFIX: readonly AIAction[] = [
  AIAction.FIND_ROOT_CAUSE,
  AIAction.SUGGEST_FIX,
  AIAction.UNDERSTAND_ERROR,
  AIAction.EXPLAIN_CODE,
  AIAction.CUSTOM,
];

/** Network errors — understand first, then diagnose. */
const ERROR_NETWORK_PREFIX: readonly AIAction[] = [
  AIAction.UNDERSTAND_ERROR,
  AIAction.FIND_ROOT_CAUSE,
  AIAction.SUGGEST_FIX,
  AIAction.EXPLAIN_CODE,
  AIAction.CUSTOM,
];

/** GitHub PR + code/diff selection */
const PR_CODE_PREFIX: readonly AIAction[] = [
  AIAction.REVIEW_ENTIRE_PR,
  AIAction.REVIEW_CODE,
  AIAction.SUGGEST_FIX,
  AIAction.EXPLAIN_CODE,
  AIAction.SUMMARIZE,
  AIAction.EXPLAIN,
];

/** GitHub PR + software error selection — keep error intel ahead of PR review. */
const PR_ERROR_PREFIX: readonly AIAction[] = [
  AIAction.FIND_ROOT_CAUSE,
  AIAction.SUGGEST_FIX,
  AIAction.UNDERSTAND_ERROR,
  AIAction.REVIEW_CODE,
  AIAction.REVIEW_ENTIRE_PR,
  AIAction.EXPLAIN_CODE,
];

/** GitHub PR description / comment prose */
const PR_PROSE_PREFIX: readonly AIAction[] = [
  AIAction.REVIEW_ENTIRE_PR,
  AIAction.SUMMARIZE,
  AIAction.REVIEW_CODE,
  AIAction.EXPLAIN,
];

/** GitHub blob file view */
const BLOB_CODE_PREFIX: readonly AIAction[] = [
  AIAction.EXPLAIN_CODE,
  AIAction.REVIEW_CODE,
  AIAction.SUGGEST_FIX,
  AIAction.EXPLAIN,
];

function assertCompleteRanking(order: readonly AIAction[]): void {
  const expected = new Set(AI_ACTIONS.map((action) => action.id));
  const actual = new Set(order);
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    throw new Error('Smart action ranking must include every AIAction exactly once.');
  }
}

for (const order of Object.values(RANKINGS)) {
  assertCompleteRanking(order);
}

function withPreferredPrefix(
  preferred: readonly AIAction[],
  base: readonly AIAction[],
): AIAction[] {
  const seen = new Set<AIAction>();
  const result: AIAction[] = [];

  for (const id of preferred) {
    if (base.includes(id) && !seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }

  for (const id of base) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }

  return result;
}

function errorCategoryPrefix(classification: ErrorClassification | undefined): readonly AIAction[] {
  if (classification?.category === 'network' || classification?.category === 'http') {
    return ERROR_NETWORK_PREFIX;
  }
  return ERROR_RUNTIME_PREFIX;
}

/**
 * Reorder the catalog so the most useful actions appear first.
 * Never drops an action.
 */
export function rankActions(
  contentType: ContentType,
  catalog: readonly AiActionDefinition[] = AI_ACTIONS,
  hints?: RankingHints,
  classification?: ErrorClassification,
): AiActionDefinition[] {
  let preferred = [...(RANKINGS[contentType] ?? RANKINGS.unknown)];

  if (contentType === 'error') {
    preferred = withPreferredPrefix(errorCategoryPrefix(classification), preferred);
  }

  if (hints?.githubView === 'pr') {
    if (contentType === 'error') {
      preferred = withPreferredPrefix(PR_ERROR_PREFIX, preferred);
    } else {
      preferred = withPreferredPrefix(
        contentType === 'code' || hints.selectionInCodeElement ? PR_CODE_PREFIX : PR_PROSE_PREFIX,
        preferred,
      );
    }
  } else if (hints?.githubView === 'blob' && contentType === 'code') {
    preferred = withPreferredPrefix(BLOB_CODE_PREFIX, preferred);
  }

  const byId = new Map(catalog.map((action) => [action.id, action]));
  const ranked: AiActionDefinition[] = [];

  for (const id of preferred) {
    const action = byId.get(id);
    if (action) {
      ranked.push(action);
      byId.delete(id);
    }
  }

  for (const action of catalog) {
    if (byId.has(action.id)) {
      ranked.push(action);
      byId.delete(action.id);
    }
  }

  return ranked;
}

/**
 * Classify selection + hints, then return a ranked action list for the menu.
 */
export function getRankedActions(
  selectedText: string,
  hints?: RankingHints,
  catalog: readonly AiActionDefinition[] = AI_ACTIONS,
): {
  contentType: ContentType;
  actions: AiActionDefinition[];
  classification: ErrorClassification;
} {
  const classification = classifyError(selectedText);
  let contentType = classifyContent(selectedText, hints);

  if (
    contentType !== 'error' &&
    contentType !== 'code' &&
    hints?.codeHost &&
    (hints.selectionInCodeElement || hints.pageType === 'github')
  ) {
    const trimmed = selectedText.trim();
    const looksTechnical =
      /[(){};=<>_/]/.test(trimmed) ||
      /^[+-][^+-]/.test(trimmed) ||
      /\b(src|lib|app|components|hooks|utils)\b/.test(trimmed) ||
      /\.\w{1,8}\b/.test(trimmed);
    if (hints.selectionInCodeElement || looksTechnical) {
      contentType = 'code';
    }
  }

  return {
    contentType,
    classification,
    actions: rankActions(contentType, catalog, hints, classification),
  };
}

export { RANKINGS };
