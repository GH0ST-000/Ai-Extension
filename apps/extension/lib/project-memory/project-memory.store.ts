import { create } from 'zustand';
import { memoryCapabilityForAiAction, type ProjectMemoryCapability } from '@project-x/shared';
import type {
  AIAction,
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  PageContext,
  ProjectMemoryCandidate,
  ProjectMemoryItem,
  ProjectMemorySummary,
} from '@project-x/types';

import {
  fetchProjectMemoryList,
  fetchProjectMemorySummary,
  learnProjectMemory,
  parseOwnerRepo,
  ProjectMemoryApiError,
  confirmProjectMemoryCandidate,
  rejectProjectMemoryCandidate,
} from './project-memory.api';

export type { ProjectMemoryCapability };

type SummaryCacheEntry = {
  summary: ProjectMemorySummary;
  fetchedAt: number;
};

type ProjectMemoryStoreState = {
  owner: string | null;
  repo: string | null;
  memoryVersion: string | null;
  items: ProjectMemoryItem[];
  candidates: ProjectMemoryCandidate[];
  loading: boolean;
  learning: boolean;
  error: string | null;
  /** Session cache: `${owner}/${repo}:${capability}:${paths}` → summary */
  summaryCache: Record<string, SummaryCacheEntry>;

  setRepo: (owner: string, repo: string) => void;
  clear: () => void;
  loadList: (owner: string, repo: string) => Promise<ListProjectMemoryResponse | null>;
  learn: (owner: string, repo: string) => Promise<LearnProjectMemoryResponse | null>;
  confirmCandidate: (candidateId: string) => Promise<ProjectMemoryItem | null>;
  rejectCandidate: (candidateId: string) => Promise<boolean>;
  getCachedSummary: (
    owner: string,
    repo: string,
    capability: string,
    paths?: string[],
  ) => ProjectMemorySummary | null;
  fetchSummary: (
    owner: string,
    repo: string,
    options: { capability: string; paths?: string[] },
  ) => Promise<ProjectMemorySummary | null>;
};

function cacheKey(owner: string, repo: string, capability: string, paths?: string[]): string {
  const pathPart = paths && paths.length > 0 ? paths.slice().sort().join(',') : '';
  return `${owner}/${repo}:${capability}:${pathPart}`;
}

/** Retrieval capability for a memory-aware AI action (shared with the API). */
export function capabilityForAiAction(action: AIAction): ProjectMemoryCapability | null {
  return memoryCapabilityForAiAction(action);
}

export function resolveGithubOwnerRepo(sources: {
  pageContext?: PageContext | null;
  lastReviewContext?: PageContext | null;
  bindingRepository?: string | null;
}): { owner: string; repo: string } | null {
  const fromGithub = (ctx: PageContext | null | undefined) => {
    const owner = ctx?.github?.owner?.trim();
    const repo = ctx?.github?.repository?.trim();
    if (owner && repo) {
      return { owner, repo };
    }
    return null;
  };

  return (
    fromGithub(sources.pageContext) ??
    fromGithub(sources.lastReviewContext) ??
    parseOwnerRepo(sources.bindingRepository ?? undefined)
  );
}

/**
 * `owner/repo` whose project memory the server should apply to this AI request, or null.
 * Only the identifier is sent: the API loads, authorizes and formats memory itself on
 * every request, so page content can never inject or suppress project rules, and
 * archived rules drop out without any client cache to invalidate.
 */
export function memoryRepositoryForRequest(input: {
  action: AIAction;
  pageContext?: PageContext | null;
  lastReviewContext?: PageContext | null;
  bindingRepository?: string | null;
}): string | null {
  if (!capabilityForAiAction(input.action)) {
    return null;
  }
  const repo = resolveGithubOwnerRepo(input);
  return repo ? `${repo.owner}/${repo.repo}` : null;
}

export const useProjectMemoryStore = create<ProjectMemoryStoreState>((set, get) => ({
  owner: null,
  repo: null,
  memoryVersion: null,
  items: [],
  candidates: [],
  loading: false,
  learning: false,
  error: null,
  summaryCache: {},

  setRepo: (owner, repo) => {
    set({ owner, repo, error: null });
  },

  clear: () => {
    set({
      owner: null,
      repo: null,
      memoryVersion: null,
      items: [],
      candidates: [],
      loading: false,
      learning: false,
      error: null,
      summaryCache: {},
    });
  },

  getCachedSummary: (owner, repo, capability, paths) => {
    const entry = get().summaryCache[cacheKey(owner, repo, capability, paths)];
    return entry?.summary ?? null;
  },

  fetchSummary: async (owner, repo, options) => {
    const key = cacheKey(owner, repo, options.capability, options.paths);
    const cached = get().summaryCache[key];
    if (cached) {
      return cached.summary;
    }
    try {
      const summary = await fetchProjectMemorySummary(owner, repo, {
        capability: options.capability,
        paths: options.paths,
      });
      set((state) => ({
        summaryCache: {
          ...state.summaryCache,
          [key]: { summary, fetchedAt: Date.now() },
        },
        memoryVersion: summary.version || state.memoryVersion,
        owner,
        repo,
        error: null,
      }));
      return summary;
    } catch (err) {
      // Not initialized / access / network — plan and AI continue without memory.
      if (
        err instanceof ProjectMemoryApiError &&
        (err.code === 'PROJECT_MEMORY_NOT_INITIALIZED' || err.statusCode === 404)
      ) {
        return null;
      }
      return null;
    }
  },

  loadList: async (owner, repo) => {
    set({ loading: true, error: null, owner, repo });
    try {
      const response = await fetchProjectMemoryList(owner, repo, { status: 'active' });
      set({
        loading: false,
        items: response.items,
        memoryVersion: response.memoryVersion || null,
        error: null,
      });
      return response;
    } catch (err) {
      const notReady =
        err instanceof ProjectMemoryApiError &&
        (err.code === 'PROJECT_MEMORY_NOT_INITIALIZED' ||
          err.statusCode === 404 ||
          err.statusCode === 401);
      set({
        loading: false,
        error: notReady
          ? null
          : err instanceof ProjectMemoryApiError
            ? err.message
            : 'Unable to load project memory.',
        items: [],
        memoryVersion: null,
      });
      return null;
    }
  },

  learn: async (owner, repo) => {
    set({ learning: true, error: null, owner, repo });
    try {
      const response = await learnProjectMemory(owner, repo);
      set((state) => ({
        learning: false,
        memoryVersion: response.memoryVersion || null,
        items: response.accepted.length > 0 ? response.accepted : state.items,
        candidates: response.candidates,
        // Invalidate summary cache after learn.
        summaryCache: {},
        error: null,
      }));
      return response;
    } catch (err) {
      set({
        learning: false,
        error:
          err instanceof ProjectMemoryApiError && err.statusCode === 403
            ? 'Only workspace Owners and Admins can learn project context.'
            : err instanceof ProjectMemoryApiError
              ? err.message
              : 'Unable to learn project memory.',
      });
      return null;
    }
  },

  confirmCandidate: async (candidateId) => {
    const { owner, repo } = get();
    if (!owner || !repo) {
      return null;
    }
    try {
      const item = await confirmProjectMemoryCandidate(owner, repo, candidateId);
      set((state) => ({
        items: [...state.items.filter((i) => i.id !== item.id), item],
        candidates: state.candidates.filter((c) => c.id !== candidateId),
        summaryCache: {},
        error: null,
      }));
      return item;
    } catch (err) {
      set({
        error:
          err instanceof ProjectMemoryApiError
            ? err.message
            : 'Unable to confirm memory candidate.',
      });
      return null;
    }
  },

  rejectCandidate: async (candidateId) => {
    const { owner, repo } = get();
    if (!owner || !repo) {
      return false;
    }
    try {
      await rejectProjectMemoryCandidate(owner, repo, candidateId);
      set((state) => ({
        candidates: state.candidates.filter((c) => c.id !== candidateId),
        error: null,
      }));
      return true;
    } catch (err) {
      set({
        error:
          err instanceof ProjectMemoryApiError ? err.message : 'Unable to reject memory candidate.',
      });
      return false;
    }
  },
}));
