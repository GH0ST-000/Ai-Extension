import { AIAction, type ContentType } from '@project-x/types';

import { AI_ACTIONS } from '../constants';
import type { AiActionDefinition } from '../types';
import { classifyContent, type RankingHints } from './classify-content';

/**
 * Preferred action order per content type. Every AIAction must appear exactly once.
 */
const RANKINGS: Record<ContentType, readonly AIAction[]> = {
  code: [
    AIAction.EXPLAIN_CODE,
    AIAction.REVIEW_CODE,
    AIAction.SUGGEST_FIX,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.EXPLAIN,
    AIAction.CUSTOM,
    AIAction.SUMMARIZE,
    AIAction.TRANSLATE,
    AIAction.IMPROVE_WRITING,
  ],
  error: [
    AIAction.EXPLAIN,
    AIAction.EXPLAIN_CODE,
    AIAction.REVIEW_CODE,
    AIAction.SUGGEST_FIX,
    AIAction.REVIEW_ENTIRE_PR,
    AIAction.CUSTOM,
    AIAction.SUMMARIZE,
    AIAction.TRANSLATE,
    AIAction.IMPROVE_WRITING,
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
  ],
};

/** GitHub PR + code/diff selection */
const PR_CODE_PREFIX: readonly AIAction[] = [
  AIAction.REVIEW_ENTIRE_PR,
  AIAction.REVIEW_CODE,
  AIAction.SUGGEST_FIX,
  AIAction.EXPLAIN_CODE,
  AIAction.SUMMARIZE,
  AIAction.EXPLAIN,
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

/**
 * Reorder the catalog so the most useful actions appear first.
 * Never drops an action.
 */
export function rankActions(
  contentType: ContentType,
  catalog: readonly AiActionDefinition[] = AI_ACTIONS,
  hints?: RankingHints,
): AiActionDefinition[] {
  let preferred = [...(RANKINGS[contentType] ?? RANKINGS.unknown)];

  if (hints?.githubView === 'pr') {
    preferred = withPreferredPrefix(
      contentType === 'code' || hints.selectionInCodeElement ? PR_CODE_PREFIX : PR_PROSE_PREFIX,
      preferred,
    );
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
): { contentType: ContentType; actions: AiActionDefinition[] } {
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
    actions: rankActions(contentType, catalog, hints),
  };
}

export { RANKINGS };
