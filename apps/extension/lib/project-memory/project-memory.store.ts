import { create } from 'zustand';
import { formatProjectMemoryForPrompt } from '@project-x/shared';
import type {
  AIAction,
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  PageContext,
  ProjectMemoryCandidate,
  ProjectMemoryItem,
  ProjectMemorySummary,
} from '@project-x/types';
import { AIAction as Action } from '@project-x/types';

import {
  fetchProjectMemoryList,
  fetchProjectMemorySummary,
  learnProjectMemory,
  parseOwnerRepo,
  ProjectMemoryApiError,
  confirmProjectMemoryCandidate,
  rejectProjectMemoryCandidate,
} from './project-memory.api';

export type ProjectMemoryCapability =
  | 'PLANNING'
  | 'PR_REVIEW'
  | 'GENERATE_PATCH'
  | 'JIRA_TECH_PLAN'
  | 'OPENAPI_ANALYSIS'
  | 'EXPLAIN_CODE';

const MEMORY_ACTION_CAPABILITY: Partial<Record<AIAction, ProjectMemoryCapability>> = {
  [Action.REVIEW_ENTIRE_PR]: 'PR_REVIEW',
  [Action.SUGGEST_FIX]: 'GENERATE_PATCH',
  [Action.PLAN_DEVELOPER_WORKFLOW]: 'PLANNING',
  [Action.ANALYZE_ENGINEERING_ALIGNMENT]: 'PLANNING',
  [Action.CREATE_TECHNICAL_PLAN]: 'JIRA_TECH_PLAN',
};

/** Actions that should pack a compact PROJECT_MEMORY block into user text. */
export const PROJECT_MEMORY_PROMPT_ACTIONS = new Set<AIAction>([
  Action.REVIEW_ENTIRE_PR,
  Action.SUGGEST_FIX,
  Action.ANALYZE_ENGINEERING_ALIGNMENT,
  Action.CREATE_TECHNICAL_PLAN,
  // PLAN_DEVELOPER_WORKFLOW gets memory via planning context; still listed for capability lookup.
  Action.PLAN_DEVELOPER_WORKFLOW,
]);

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

export function capabilityForAiAction(action: AIAction): ProjectMemoryCapability | null {
  return MEMORY_ACTION_CAPABILITY[action] ?? null;
}

export function shouldPackProjectMemory(action: AIAction): boolean {
  // Planning packs via buildPlanningContext — avoid duplicate PROJECT_MEMORY blocks.
  if (action === Action.PLAN_DEVELOPER_WORKFLOW) {
    return false;
  }
  return PROJECT_MEMORY_PROMPT_ACTIONS.has(action);
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

export function pathHintsFromContext(ctx: PageContext | null | undefined): string[] | undefined {
  const paths: string[] = [];
  if (ctx?.github?.filePath) {
    paths.push(ctx.github.filePath);
  }
  for (const file of ctx?.github?.changedFiles ?? []) {
    if (file.path && !paths.includes(file.path)) {
      paths.push(file.path);
    }
  }
  return paths.length > 0 ? paths.slice(0, 24) : undefined;
}

/**
 * Fetch (or reuse session-cached) summary and return compact prompt block.
 * Errors / empty memory → empty string (caller continues without memory).
 */
export async function loadProjectMemoryPromptBlock(input: {
  action: AIAction;
  pageContext?: PageContext | null;
  lastReviewContext?: PageContext | null;
  bindingRepository?: string | null;
}): Promise<string> {
  if (!shouldPackProjectMemory(input.action)) {
    return '';
  }
  const capability = capabilityForAiAction(input.action);
  if (!capability) {
    return '';
  }
  const repo = resolveGithubOwnerRepo(input);
  if (!repo) {
    return '';
  }
  const paths =
    pathHintsFromContext(input.pageContext) ?? pathHintsFromContext(input.lastReviewContext);
  const summary = await useProjectMemoryStore.getState().fetchSummary(repo.owner, repo.repo, {
    capability,
    paths,
  });
  if (!summary) {
    return '';
  }
  return formatProjectMemoryForPrompt(summary);
}

/** Prepend memory block to user text when non-empty. */
export function prependProjectMemoryBlock(text: string, memoryBlock: string): string {
  const block = memoryBlock.trim();
  if (!block) {
    return text;
  }
  if (text.includes('PROJECT_MEMORY')) {
    return text;
  }
  return `${block}\n\n${text}`;
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
          err instanceof ProjectMemoryApiError ? err.message : 'Unable to learn project memory.',
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
