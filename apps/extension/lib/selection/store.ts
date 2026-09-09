import { create } from 'zustand';
import { AIAction } from '@project-x/types';

import {
  captureEditableSelectionSnapshot,
  replaceEditableSelection,
  type EditableSelectionSnapshot,
  type ReplacementResult,
} from '../editing';
import { extractPageContext } from '../context/extract-page-context';
import { AiClientError, buildAiRequest, streamAiAction } from '../services/ai-client';
import { USER_FACING_AI_ERROR } from './constants';
import type { AssistantView, SelectionRect, ToolbarPhase } from './types';
import { extractFixClipboardText } from './utils/parse-suggest-fix';

type SelectionToolbarState = {
  phase: ToolbarPhase;
  selectedText: string;
  anchorRect: SelectionRect | null;
  editableSnapshot: EditableSelectionSnapshot | null;
  assistant: AssistantView;
  customPrompt: string;
  requestId: number;
  abortController: AbortController | null;
  showTrigger: (text: string, rect: SelectionRect) => void;
  updateAnchor: (rect: SelectionRect) => void;
  openMenu: () => void;
  closeMenu: () => void;
  dismiss: () => void;
  openCustomPrompt: () => void;
  setCustomPromptInput: (value: string) => void;
  backToMenu: () => void;
  startAction: (action: AIAction, options?: { customPrompt?: string }) => Promise<void>;
  retry: () => Promise<void>;
  replaceSelection: () => ReplacementResult;
  cancelActiveRequest: () => void;
};

const MENU_VIEW: AssistantView = { status: 'menu' };

const INITIAL_STATE = {
  phase: 'hidden' as const,
  selectedText: '',
  anchorRect: null as SelectionRect | null,
  editableSnapshot: null as EditableSelectionSnapshot | null,
  assistant: MENU_VIEW,
  customPrompt: '',
  requestId: 0,
  abortController: null as AbortController | null,
};

function isAbortError(error: unknown): boolean {
  return error instanceof AiClientError && error.aborted;
}

function resolveEditableSnapshot(
  text: string,
  previous: EditableSelectionSnapshot | null,
): EditableSelectionSnapshot | null {
  const captured = captureEditableSelectionSnapshot(text);
  if (captured) {
    return captured;
  }
  // Keep prior snapshot when focus already left the field but text matches.
  if (previous && previous.selectedText.replace(/\u00a0/g, ' ').trim() === text.trim()) {
    return previous;
  }
  return null;
}

export const useSelectionToolbarStore = create<SelectionToolbarState>((set, get) => ({
  ...INITIAL_STATE,

  showTrigger: (text, rect) => {
    const { phase, selectedText, assistant, editableSnapshot } = get();
    const nextSnapshot = resolveEditableSnapshot(text, editableSnapshot);

    const assistantBusy =
      phase === 'assistant' &&
      (assistant.status === 'loading' ||
        assistant.status === 'streaming' ||
        assistant.status === 'success' ||
        assistant.status === 'error' ||
        assistant.status === 'custom-prompt');

    if (assistantBusy && text === selectedText) {
      set({
        selectedText: text,
        anchorRect: rect,
        editableSnapshot: nextSnapshot ?? editableSnapshot,
      });
      return;
    }

    if (assistantBusy && text !== selectedText) {
      get().cancelActiveRequest();
      set({
        phase: 'trigger',
        selectedText: text,
        anchorRect: rect,
        editableSnapshot: nextSnapshot,
        assistant: MENU_VIEW,
        customPrompt: '',
      });
      return;
    }

    if (phase === 'menu' && text === selectedText) {
      set({
        selectedText: text,
        anchorRect: rect,
        editableSnapshot: nextSnapshot ?? editableSnapshot,
      });
      return;
    }

    set({
      phase: 'trigger',
      selectedText: text,
      anchorRect: rect,
      editableSnapshot: nextSnapshot,
      assistant: MENU_VIEW,
    });
  },

  updateAnchor: (rect) => {
    if (get().phase === 'hidden') {
      return;
    }
    set({ anchorRect: rect });
  },

  openMenu: () => {
    if (!get().anchorRect) {
      return;
    }
    const { selectedText, editableSnapshot } = get();
    set({
      phase: 'assistant',
      assistant: MENU_VIEW,
      editableSnapshot: resolveEditableSnapshot(selectedText, editableSnapshot),
    });
  },

  closeMenu: () => {
    const { phase, assistant } = get();
    if (phase === 'assistant' && assistant.status === 'menu') {
      set({ phase: 'trigger', assistant: MENU_VIEW });
      return;
    }
    if (phase === 'menu') {
      set({ phase: 'trigger' });
    }
  },

  dismiss: () => {
    get().cancelActiveRequest();
    set({ ...INITIAL_STATE });
  },

  openCustomPrompt: () => {
    set({
      phase: 'assistant',
      assistant: { status: 'custom-prompt', input: get().customPrompt },
    });
  },

  setCustomPromptInput: (value) => {
    set((state) => ({
      customPrompt: value,
      assistant:
        state.assistant.status === 'custom-prompt'
          ? { status: 'custom-prompt', input: value }
          : state.assistant,
    }));
  },

  backToMenu: () => {
    get().cancelActiveRequest();
    set({
      phase: 'assistant',
      assistant: MENU_VIEW,
    });
  },

  cancelActiveRequest: () => {
    const { abortController } = get();
    if (abortController && !abortController.signal.aborted) {
      abortController.abort();
    }
    set({ abortController: null });
  },

  startAction: async (action, options) => {
    const selectedText = get().selectedText;
    if (!selectedText.trim()) {
      return;
    }

    get().cancelActiveRequest();

    const abortController = new AbortController();
    const requestId = get().requestId + 1;

    let prompt: string | null = null;
    if (action === AIAction.CUSTOM) {
      prompt = (options?.customPrompt ?? get().customPrompt).trim() || null;
      if (!prompt) {
        set({
          phase: 'assistant',
          assistant: { status: 'custom-prompt', input: get().customPrompt },
        });
        return;
      }
    } else if (action === AIAction.SUGGEST_FIX) {
      // Menu launch: no prior finding. Review → Suggest Fix / Retry: pass via options.
      if (options && Object.prototype.hasOwnProperty.call(options, 'customPrompt')) {
        prompt = options.customPrompt?.trim() || null;
      } else {
        prompt = null;
      }
    }

    const editableSnapshot = resolveEditableSnapshot(selectedText, get().editableSnapshot);

    set({
      phase: 'assistant',
      requestId,
      abortController,
      editableSnapshot,
      customPrompt:
        action === AIAction.CUSTOM || action === AIAction.SUGGEST_FIX
          ? (prompt ?? '')
          : get().customPrompt,
      assistant: { status: 'loading', action },
    });

    let receivedChunk = false;

    try {
      const pageContext = extractPageContext();
      const finalText = await streamAiAction(
        buildAiRequest({
          action,
          text: selectedText,
          customPrompt: prompt,
          context: pageContext,
        }),
        {
          signal: abortController.signal,
          onChunk: (chunk) => {
            const current = get();
            if (current.requestId !== requestId) {
              return;
            }

            if (!receivedChunk) {
              receivedChunk = true;
              set({
                assistant: { status: 'streaming', action, content: chunk },
              });
              return;
            }

            if (current.assistant.status === 'streaming') {
              set({
                assistant: {
                  status: 'streaming',
                  action,
                  content: current.assistant.content + chunk,
                },
              });
            }
          },
        },
      );

      if (get().requestId !== requestId) {
        return;
      }

      set({
        abortController: null,
        assistant: { status: 'success', action, content: finalText },
      });
    } catch (error) {
      if (get().requestId !== requestId) {
        return;
      }

      if (isAbortError(error) || abortController.signal.aborted) {
        set({ abortController: null });
        return;
      }

      set({
        abortController: null,
        assistant: {
          status: 'error',
          action,
          message: USER_FACING_AI_ERROR,
        },
      });
    }
  },

  retry: async () => {
    const { assistant, customPrompt } = get();
    if (
      assistant.status !== 'success' &&
      assistant.status !== 'error' &&
      assistant.status !== 'streaming' &&
      assistant.status !== 'loading'
    ) {
      return;
    }

    const reuseFollowUp =
      assistant.action === AIAction.CUSTOM || assistant.action === AIAction.SUGGEST_FIX;

    await get().startAction(assistant.action, {
      customPrompt: reuseFollowUp ? customPrompt : undefined,
    });
  },

  replaceSelection: () => {
    const { assistant, editableSnapshot } = get();
    if (assistant.status !== 'success') {
      return {
        ok: false as const,
        reason: 'unsupported' as const,
        message: 'Wait for the result before replacing.',
      };
    }

    const replacement =
      assistant.action === AIAction.SUGGEST_FIX
        ? extractFixClipboardText(assistant.content)
        : assistant.content;

    const result = replaceEditableSelection(editableSnapshot, replacement);
    if (result.ok) {
      set({
        selectedText: replacement,
        editableSnapshot: null,
      });
    }
    return result;
  },
}));
