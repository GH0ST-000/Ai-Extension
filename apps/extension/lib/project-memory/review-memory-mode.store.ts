import { create } from 'zustand';
import type { ProjectMemoryMode } from '@project-x/types';

/** chrome.storage.local key for the PR review Project Memory setting. */
export const REVIEW_MEMORY_MODE_STORAGE_KEY = 'px.prReview.projectMemoryMode';

type ReviewMemoryModeState = {
  /** Setting for the next PR review. Default `on` (the behaviour before the toggle existed). */
  mode: ProjectMemoryMode;
  hydrated: boolean;
  setMode: (mode: ProjectMemoryMode) => void;
  hydrate: () => Promise<void>;
};

function isMode(value: unknown): value is ProjectMemoryMode {
  return value === 'on' || value === 'off';
}

/**
 * Per-user Project Memory ON/OFF for PR reviews. Sent explicitly as `projectMemoryMode` with
 * every review request, so the server never has to infer it from `memoryRepository`.
 */
export const useReviewMemoryModeStore = create<ReviewMemoryModeState>((set) => ({
  mode: 'on',
  hydrated: false,
  setMode: (mode) => {
    set({ mode });
    try {
      void chrome.storage.local.set({ [REVIEW_MEMORY_MODE_STORAGE_KEY]: mode }).catch(() => {
        // Storage unavailable: the setting still applies for this page session.
      });
    } catch {
      // chrome.storage missing (tests / non-extension context): keep in-memory value.
    }
  },
  hydrate: async () => {
    try {
      const stored = await chrome.storage.local.get(REVIEW_MEMORY_MODE_STORAGE_KEY);
      const value = stored[REVIEW_MEMORY_MODE_STORAGE_KEY];
      set(isMode(value) ? { mode: value, hydrated: true } : { hydrated: true });
    } catch {
      set({ hydrated: true });
    }
  },
}));
