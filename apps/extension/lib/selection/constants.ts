import { AIAction } from '@project-x/types';

import type { AiActionDefinition } from './types';

export const SHADOW_HOST_ID = 'project-x-selection-toolbar';

/**
 * Keyboard shortcuts bind to AIAction identities — never to menu index.
 * Safe under Day 5 dynamic reordering.
 */
export const SHORTCUT_TO_ACTION: Readonly<Record<string, AIAction>> = {
  e: AIAction.EXPLAIN,
  i: AIAction.IMPROVE_WRITING,
  s: AIAction.SUMMARIZE,
  t: AIAction.TRANSLATE,
  c: AIAction.EXPLAIN_CODE,
  r: AIAction.REVIEW_CODE,
  f: AIAction.SUGGEST_FIX,
  a: AIAction.REVIEW_ENTIRE_PR,
  u: AIAction.UNDERSTAND_ERROR,
  o: AIAction.FIND_ROOT_CAUSE,
  p: AIAction.CUSTOM,
};

export const AI_ACTIONS: readonly AiActionDefinition[] = [
  {
    id: AIAction.EXPLAIN,
    label: 'Explain',
    description: 'Clarify meaning',
    shortcut: 'E',
  },
  {
    id: AIAction.IMPROVE_WRITING,
    label: 'Improve Writing',
    description: 'Polish tone',
    shortcut: 'I',
  },
  {
    id: AIAction.SUMMARIZE,
    label: 'Summarize',
    description: 'Key points only',
    shortcut: 'S',
  },
  {
    id: AIAction.TRANSLATE,
    label: 'Translate',
    description: 'Change language',
    shortcut: 'T',
  },
  {
    id: AIAction.EXPLAIN_CODE,
    label: 'Explain Code',
    description: 'Break it down',
    shortcut: 'C',
  },
  {
    id: AIAction.REVIEW_CODE,
    label: 'Code Review',
    description: 'Findings & risks',
    shortcut: 'R',
  },
  {
    id: AIAction.SUGGEST_FIX,
    label: 'Suggest Fix',
    description: 'Show practical fixes',
    shortcut: 'F',
  },
  {
    id: AIAction.REVIEW_ENTIRE_PR,
    label: 'Review Entire PR',
    description: 'Multi-file risks',
    shortcut: 'A',
  },
  {
    id: AIAction.UNDERSTAND_ERROR,
    label: 'Understand Error',
    description: 'Explain what failed',
    shortcut: 'U',
  },
  {
    id: AIAction.FIND_ROOT_CAUSE,
    label: 'Find Root Cause',
    description: 'Identify why this failed',
    shortcut: 'O',
  },
  {
    id: AIAction.CUSTOM,
    label: 'Custom Prompt',
    description: 'Ask anything',
    shortcut: 'P',
  },
] as const;

/** Diagnostic actions — never offer in-place Replace. */
export const DIAGNOSTIC_AI_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.UNDERSTAND_ERROR,
  AIAction.FIND_ROOT_CAUSE,
  AIAction.SUGGEST_FIX,
]);

export const ERROR_INTELLIGENCE_ACTIONS: ReadonlySet<AIAction> = new Set([
  AIAction.UNDERSTAND_ERROR,
  AIAction.FIND_ROOT_CAUSE,
  AIAction.SUGGEST_FIX,
]);

export const MIN_SELECTION_LENGTH = 1;
export const TRIGGER_OFFSET_PX = 6;
export const MENU_OFFSET_PX = 8;

export const USER_FACING_AI_ERROR = 'Unable to generate a response.';
export const USER_FACING_AUTH_ERROR = 'Sign in via the extension popup to use Ask AI.';

export function getActionLabel(action: AIAction): string {
  return AI_ACTIONS.find((item) => item.id === action)?.label ?? action;
}

export function getActionDefinition(action: AIAction): AiActionDefinition | undefined {
  return AI_ACTIONS.find((item) => item.id === action);
}

/** Resolve a keypress to an AIAction. Ignores menu order entirely. */
export function actionFromShortcut(key: string): AIAction | null {
  if (!key || key.length !== 1) {
    return null;
  }
  return SHORTCUT_TO_ACTION[key.toLowerCase()] ?? null;
}
