import { create } from 'zustand';
import { AIAction } from '@project-x/types';

import { extractPageContext } from '../context/extract-page-context';
import { AiClientError, buildAiRequest, streamAiAction } from '../services/ai-client';
import { USER_FACING_AI_ERROR } from './constants';
import type { AssistantView, SelectionRect, ToolbarPhase } from './types';

type SelectionToolbarState = {
  phase: ToolbarPhase;
  selectedText: string;
  anchorRect: SelectionRect | null;
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
  cancelActiveRequest: () => void;
};

const MENU_VIEW: AssistantView = { status: 'menu' };

const INITIAL_STATE = {
  phase: 'hidden' as const,
  selectedText: '',
  anchorRect: null as SelectionRect | null,
  assistant: MENU_VIEW,
  customPrompt: '',
  requestId: 0,
  abortController: null as AbortController | null,
};

function isAbortError(error: unknown): boolean {
  return error instanceof AiClientError && error.aborted;
}

export const useSelectionToolbarStore = create<SelectionToolbarState>((set, get) => ({
  ...INITIAL_STATE,

  showTrigger: (text, rect) => {
    const { phase, selectedText, assistant } = get();
    const assistantBusy =
      phase === 'assistant' &&
      (assistant.status === 'loading' ||
        assistant.status === 'streaming' ||
        assistant.status === 'success' ||
        assistant.status === 'error' ||
        assistant.status === 'custom-prompt');

    if (assistantBusy && text === selectedText) {
      set({ selectedText: text, anchorRect: rect });
      return;
    }

    if (assistantBusy && text !== selectedText) {
      get().cancelActiveRequest();
      set({
        phase: 'trigger',
        selectedText: text,
        anchorRect: rect,
        assistant: MENU_VIEW,
        customPrompt: '',
      });
      return;
    }

    if (phase === 'menu' && text === selectedText) {
      set({ selectedText: text, anchorRect: rect });
      return;
    }

    set({
      phase: 'trigger',
      selectedText: text,
      anchorRect: rect,
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
    set({
      phase: 'assistant',
      assistant: MENU_VIEW,
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
    const prompt =
      action === AIAction.CUSTOM ? (options?.customPrompt ?? get().customPrompt).trim() : null;

    if (action === AIAction.CUSTOM && (!prompt || prompt.length === 0)) {
      set({
        phase: 'assistant',
        assistant: { status: 'custom-prompt', input: get().customPrompt },
      });
      return;
    }

    set({
      phase: 'assistant',
      requestId,
      abortController,
      customPrompt: prompt ?? get().customPrompt,
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

    await get().startAction(assistant.action, {
      customPrompt: assistant.action === AIAction.CUSTOM ? customPrompt : undefined,
    });
  },
}));
