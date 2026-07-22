import type { AiActionId } from './types';

/**
 * Day 2 stub — log only. AI wiring lands later.
 */
export function dispatchAiAction(actionId: AiActionId, selectedText: string): void {
  // Keep payload minimal and intentional for later observability hooks.
  console.info('[Project X] action', {
    action: actionId,
    selectionLength: selectedText.length,
  });
}
