import { create } from 'zustand';
import type {
  CurrentWorkspaceContext,
  ProductEntitlements,
  WorkspaceBootstrapResponse,
} from '@project-x/types';

import {
  fetchWorkspaceBootstrap,
  switchWorkspaceBootstrap,
  WorkspaceApiError,
  type WorkspaceListItem,
} from '../api/workspace';
import { useProjectMemoryStore } from '../project-memory/project-memory.store';
import { useGithubCiStore } from '../selection/ci/ci.store';
import { useCIFixSessionStore } from '../selection/ci/fix/ci-fix.store';
import { useEngineeringSessionStore } from '../selection/engineering/engineering.store';
import { useJiraSessionStore } from '../selection/jira/jira.store';
import { useMultiRepoStore } from '../selection/multi-repo/multi-repo.store';
import { useOpenApiSessionStore } from '../selection/openapi/openapi.store';
import { usePatchApplyStore } from '../selection/patch-apply/patch-apply.store';
import { useGithubReviewDraftStore } from '../selection/review-draft/review-draft.store';
import { useSelectionToolbarStore } from '../selection/store';
import { useWorkflowSessionStore } from '../selection/workflow/workflow.store';
import {
  clearCurrentWorkspaceId,
  persistCurrentWorkspaceId,
  setCurrentWorkspaceIdMemory,
} from './current-workspace-id';

export type WorkspaceStoreState = {
  bootstrapped: boolean;
  loading: boolean;
  switching: boolean;
  error: string | null;
  user: WorkspaceBootstrapResponse['user'] | null;
  workspaces: WorkspaceListItem[];
  current: CurrentWorkspaceContext | null;
  currentWorkspaceId: string | null;
  entitlements: ProductEntitlements | null;

  bootstrap: (preferredWorkspaceId?: string | null) => Promise<WorkspaceBootstrapResponse | null>;
  switchWorkspace: (workspaceId: string) => Promise<boolean>;
  clear: () => Promise<void>;
};

/**
 * Clear workspace-bound session state carefully.
 * Does not retarget in-flight provider writes — callers should switch only when safe.
 */
export function clearWorkspaceBoundSessionState(): void {
  useSelectionToolbarStore.getState().dismiss();
  useWorkflowSessionStore.getState().clear();
  useCIFixSessionStore.getState().clear();
  useJiraSessionStore.getState().clear();
  useOpenApiSessionStore.getState().clear();
  useEngineeringSessionStore.getState().clear();
  useMultiRepoStore.getState().clear();
  useProjectMemoryStore.getState().clear();
  useGithubReviewDraftStore.getState().clearDraft();
  usePatchApplyStore.getState().reset();
  useGithubCiStore.getState().close();
}

function applyBootstrap(
  set: (partial: Partial<WorkspaceStoreState>) => void,
  data: WorkspaceBootstrapResponse,
): void {
  const workspaceId = data.current.workspace.id;
  setCurrentWorkspaceIdMemory(workspaceId);
  set({
    bootstrapped: true,
    loading: false,
    switching: false,
    error: null,
    user: data.user,
    workspaces: data.workspaces,
    current: data.current,
    currentWorkspaceId: workspaceId,
    entitlements: data.current.entitlements,
  });
}

export const useWorkspaceStore = create<WorkspaceStoreState>((set, get) => ({
  bootstrapped: false,
  loading: false,
  switching: false,
  error: null,
  user: null,
  workspaces: [],
  current: null,
  currentWorkspaceId: null,
  entitlements: null,

  bootstrap: async (preferredWorkspaceId) => {
    set({ loading: true, error: null });
    try {
      const data = await fetchWorkspaceBootstrap({
        workspaceId: preferredWorkspaceId ?? get().currentWorkspaceId,
      });
      applyBootstrap(set, data);
      await persistCurrentWorkspaceId(data.current.workspace.id);
      return data;
    } catch (err) {
      const message = err instanceof WorkspaceApiError ? err.message : 'Unable to load workspace.';
      set({ loading: false, error: message });
      return null;
    }
  },

  switchWorkspace: async (workspaceId) => {
    const trimmed = workspaceId.trim();
    if (!trimmed) {
      return false;
    }
    if (trimmed === get().currentWorkspaceId) {
      return true;
    }

    set({ switching: true, error: null });
    clearWorkspaceBoundSessionState();

    try {
      await persistCurrentWorkspaceId(trimmed);
      const data = await switchWorkspaceBootstrap(trimmed);
      if (data.current.workspace.id !== trimmed) {
        // Server fell back (stale / removed membership) — keep server truth.
        await persistCurrentWorkspaceId(data.current.workspace.id);
      }
      applyBootstrap(set, data);
      return true;
    } catch (err) {
      const message =
        err instanceof WorkspaceApiError ? err.message : 'Unable to switch workspace.';
      set({ switching: false, error: message });
      return false;
    }
  },

  clear: async () => {
    clearWorkspaceBoundSessionState();
    await clearCurrentWorkspaceId();
    set({
      bootstrapped: false,
      loading: false,
      switching: false,
      error: null,
      user: null,
      workspaces: [],
      current: null,
      currentWorkspaceId: null,
      entitlements: null,
    });
  },
}));
