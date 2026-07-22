import { create } from 'zustand';

import type { SelectionRect, ToolbarPhase } from './types';

type SelectionToolbarState = {
  phase: ToolbarPhase;
  selectedText: string;
  anchorRect: SelectionRect | null;
  showTrigger: (text: string, rect: SelectionRect) => void;
  updateAnchor: (rect: SelectionRect) => void;
  openMenu: () => void;
  closeMenu: () => void;
  dismiss: () => void;
};

const INITIAL_STATE = {
  phase: 'hidden' as const,
  selectedText: '',
  anchorRect: null,
};

export const useSelectionToolbarStore = create<SelectionToolbarState>((set, get) => ({
  ...INITIAL_STATE,

  showTrigger: (text, rect) => {
    const { phase, selectedText } = get();

    // Keep the menu open only while the same selection is still active.
    if (phase === 'menu' && text === selectedText) {
      set({ selectedText: text, anchorRect: rect });
      return;
    }

    set({
      phase: 'trigger',
      selectedText: text,
      anchorRect: rect,
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
    set({ phase: 'menu' });
  },

  closeMenu: () => {
    if (get().phase !== 'menu') {
      return;
    }
    set({ phase: 'trigger' });
  },

  dismiss: () => {
    set({ ...INITIAL_STATE });
  },
}));
