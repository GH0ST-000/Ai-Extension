import { AIAction } from '@project-x/types';

import type { AiActionDefinition } from './types';

export const SHADOW_HOST_ID = 'project-x-selection-toolbar';

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
    id: AIAction.CUSTOM,
    label: 'Custom Prompt',
    description: 'Freeform ask',
    shortcut: 'P',
  },
] as const;

export const MIN_SELECTION_LENGTH = 1;
export const TRIGGER_OFFSET_PX = 6;
export const MENU_OFFSET_PX = 8;

export const USER_FACING_AI_ERROR = 'Unable to generate a response.';
export const USER_FACING_AUTH_ERROR = 'Sign in via the extension popup to use Ask AI.';

export function getActionLabel(action: AIAction): string {
  return AI_ACTIONS.find((item) => item.id === action)?.label ?? action;
}
