import { create } from 'zustand';
import { knownInSelectedScope, noOrgWideClaim, partialScopeUnavailable } from '@project-x/shared';
import type {
  MultiRepoArchitectureContext,
  MultiRepoChangeImpactAnalysis,
  MultiRepoRequirementCoverage,
  ProjectSystem,
  SystemFlowTrace,
  SystemFlowTrigger,
} from '@project-x/types';

import {
  analyzeChangeImpact,
  compareRequirement,
  findApiConsumers,
  findEventConsumers,
  getSystemContext,
  listSystems,
  MultiRepoApiError,
  refreshSystem,
  traceSystemFlow,
  type FindConsumersResponse,
} from '../../api/systems';

export type MultiRepoPlanningSummary = {
  systemId: string;
  name?: string;
  enabledRepositories: number;
  knownRelationships: string[];
};

type MultiRepoStoreState = {
  systems: ProjectSystem[];
  selectedSystemId: string | null;
  /** Local checklist of enabled repo keys (`owner/repo`) for analysis scope. */
  enabledRepoKeys: string[];
  context: MultiRepoArchitectureContext | null;
  lastImpact: MultiRepoChangeImpactAnalysis | null;
  lastFlow: SystemFlowTrace | null;
  lastCoverage: MultiRepoRequirementCoverage | null;
  lastConsumers: FindConsumersResponse | null;
  scopeNote: string | null;
  loading: boolean;
  error: string | null;
  panelOpen: boolean;

  setPanelOpen: (open: boolean) => void;
  selectSystem: (systemId: string | null) => void;
  setEnabledRepoKeys: (keys: string[]) => void;
  toggleEnabledRepoKey: (key: string) => void;
  loadSystems: () => Promise<ProjectSystem[]>;
  buildContext: (systemId?: string) => Promise<MultiRepoArchitectureContext | null>;
  refreshSelected: () => Promise<boolean>;
  analyzeImpact: (input: {
    owner: string;
    repository: string;
    pullRequestNumber?: number;
    headSha?: string;
    summary?: string;
  }) => Promise<MultiRepoChangeImpactAnalysis | null>;
  traceFlow: (trigger: SystemFlowTrigger) => Promise<SystemFlowTrace | null>;
  compareReq: (
    issueKey: string,
    criteria?: string[],
  ) => Promise<MultiRepoRequirementCoverage | null>;
  findApi: (input: {
    path: string;
    method?: string;
    operationId?: string;
  }) => Promise<FindConsumersResponse | null>;
  findEvents: (input: {
    topic: string;
    eventType?: string;
  }) => Promise<FindConsumersResponse | null>;
  planningSummary: () => MultiRepoPlanningSummary | null;
  clearResults: () => void;
  clear: () => void;
};

function repoKey(owner: string, repository: string): string {
  return `${owner}/${repository}`;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof MultiRepoApiError ? err.message : fallback;
}

function buildScopeNote(context: MultiRepoArchitectureContext | null): string {
  const parts = [knownInSelectedScope('resources'), noOrgWideClaim()];
  if (!context) {
    return parts.join(' ');
  }
  if (context.scope.repositoriesUnavailable > 0) {
    parts.push(
      `${context.scope.repositoriesUnavailable} selected repositor${
        context.scope.repositoriesUnavailable === 1 ? 'y was' : 'ies were'
      } unavailable.`,
    );
  }
  if (context.scope.truncated) {
    parts.push('Results may be truncated within analysis budgets.');
  }
  return parts.join(' ');
}

export const useMultiRepoStore = create<MultiRepoStoreState>((set, get) => ({
  systems: [],
  selectedSystemId: null,
  enabledRepoKeys: [],
  context: null,
  lastImpact: null,
  lastFlow: null,
  lastCoverage: null,
  lastConsumers: null,
  scopeNote: null,
  loading: false,
  error: null,
  panelOpen: false,

  setPanelOpen: (open) => set({ panelOpen: open }),

  selectSystem: (systemId) => {
    const system = get().systems.find((s) => s.id === systemId) ?? null;
    const enabledRepoKeys = system
      ? system.repositories
          .filter((r) => r.enabled)
          .map((r) => repoKey(r.repository.owner, r.repository.repository))
      : [];
    set({
      selectedSystemId: systemId,
      enabledRepoKeys,
      context: null,
      lastImpact: null,
      lastFlow: null,
      lastCoverage: null,
      lastConsumers: null,
      error: null,
      scopeNote: systemId ? knownInSelectedScope('resources') : null,
    });
  },

  setEnabledRepoKeys: (keys) => set({ enabledRepoKeys: keys }),

  toggleEnabledRepoKey: (key) => {
    const current = get().enabledRepoKeys;
    set({
      enabledRepoKeys: current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    });
  },

  loadSystems: async () => {
    set({ loading: true, error: null });
    try {
      const systems = await listSystems();
      const selectedSystemId = get().selectedSystemId;
      const stillSelected =
        selectedSystemId && systems.some((s) => s.id === selectedSystemId)
          ? selectedSystemId
          : (systems[0]?.id ?? null);
      set({ systems, loading: false });
      if (stillSelected !== selectedSystemId) {
        get().selectSystem(stillSelected);
      } else if (stillSelected && get().enabledRepoKeys.length === 0) {
        get().selectSystem(stillSelected);
      }
      return systems;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to load systems.'),
        systems: [],
      });
      return [];
    }
  },

  buildContext: async (systemId) => {
    const id = systemId ?? get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const context = await getSystemContext(id);
      set({
        context,
        loading: false,
        scopeNote: buildScopeNote(context),
        selectedSystemId: id,
      });
      return context;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to build multi-repo context.'),
        context: null,
      });
      return null;
    }
  },

  refreshSelected: async () => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return false;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const refresh = await refreshSystem(id);
      const context = await getSystemContext(id);
      const unavailableNotes = refresh.unavailable.map((r) =>
        partialScopeUnavailable(repoKey(r.owner, r.repository)),
      );
      set({
        context,
        loading: false,
        scopeNote: [buildScopeNote(context), ...unavailableNotes].filter(Boolean).join(' '),
      });
      return true;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to refresh system context.'),
      });
      return false;
    }
  },

  analyzeImpact: async (input) => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const lastImpact = await analyzeChangeImpact({
        systemId: id,
        owner: input.owner,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        summary: input.summary,
        repositoryIds: get().enabledRepoKeys,
      });
      set({
        lastImpact,
        loading: false,
        scopeNote: [
          knownInSelectedScope('impact'),
          noOrgWideClaim(),
          ...(lastImpact.scope.repositoriesUnavailable ?? []).map((r) =>
            partialScopeUnavailable(repoKey(r.owner, r.repository)),
          ),
        ].join(' '),
      });
      return lastImpact;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to analyze change impact.'),
      });
      return null;
    }
  },

  traceFlow: async (trigger) => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const lastFlow = await traceSystemFlow({
        systemId: id,
        trigger,
        repositoryIds: get().enabledRepoKeys,
      });
      set({
        lastFlow,
        loading: false,
        scopeNote: [
          knownInSelectedScope('flow hops'),
          noOrgWideClaim(),
          lastFlow.gaps.length > 0
            ? 'Project X found part of the flow, but one or more hops are not evident in the selected repositories.'
            : null,
        ]
          .filter(Boolean)
          .join(' '),
      });
      return lastFlow;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to trace system flow.'),
      });
      return null;
    }
  },

  compareReq: async (issueKey, criteria) => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const lastCoverage = await compareRequirement({
        systemId: id,
        issueKey,
        criteria,
      });
      set({
        lastCoverage,
        loading: false,
        scopeNote: [knownInSelectedScope('requirement coverage'), noOrgWideClaim()].join(' '),
      });
      return lastCoverage;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to compare requirement across repos.'),
      });
      return null;
    }
  },

  findApi: async (input) => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const lastConsumers = await findApiConsumers(id, input);
      set({
        lastConsumers,
        loading: false,
        scopeNote: knownInSelectedScope('API consumers'),
      });
      return lastConsumers;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to find API consumers.'),
      });
      return null;
    }
  },

  findEvents: async (input) => {
    const id = get().selectedSystemId;
    if (!id) {
      set({ error: 'Select a system first.' });
      return null;
    }
    set({ loading: true, error: null, panelOpen: true });
    try {
      const lastConsumers = await findEventConsumers(id, input);
      set({
        lastConsumers,
        loading: false,
        scopeNote: knownInSelectedScope('event consumers'),
      });
      return lastConsumers;
    } catch (err) {
      set({
        loading: false,
        error: errorMessage(err, 'Unable to find event consumers.'),
      });
      return null;
    }
  },

  planningSummary: () => {
    const { selectedSystemId, systems, context, lastImpact } = get();
    if (!selectedSystemId) {
      return null;
    }
    const system = systems.find((s) => s.id === selectedSystemId);
    const enabledRepositories =
      system?.repositories.filter((r) => r.enabled).length ??
      context?.repositories.filter((r) => r.enabled).length ??
      0;
    const knownRelationships = (context?.relationships ?? []).slice(0, 8).map((rel) => {
      const resource = rel.resource ? ` ${rel.resource.kind}:${rel.resource.key}` : '';
      return `${rel.from.owner}/${rel.from.repository} -[${rel.type}]-> ${rel.to.owner}/${rel.to.repository}${resource}`;
    });
    if (knownRelationships.length === 0 && lastImpact) {
      for (const item of lastImpact.impactedRepositories.slice(0, 8)) {
        knownRelationships.push(
          `${item.repository.owner}/${item.repository.repository}: ${item.impactType} (${item.likelihood})`,
        );
      }
    }
    return {
      systemId: selectedSystemId,
      name: system?.name ?? context?.system.name,
      enabledRepositories,
      knownRelationships: knownRelationships.slice(0, 8),
    };
  },

  clearResults: () =>
    set({
      lastImpact: null,
      lastFlow: null,
      lastCoverage: null,
      lastConsumers: null,
      error: null,
    }),

  clear: () =>
    set({
      systems: [],
      selectedSystemId: null,
      enabledRepoKeys: [],
      context: null,
      lastImpact: null,
      lastFlow: null,
      lastCoverage: null,
      lastConsumers: null,
      scopeNote: null,
      loading: false,
      error: null,
      panelOpen: false,
    }),
}));

/** Resolve GitHub owner/repo/PR from engineering sessions for impact analysis. */
export function githubChangeFromSessions(sessions: {
  lastReviewContext?: {
    github?: {
      owner?: string;
      repository?: string;
      pullRequestNumber?: number;
      pullRequestTitle?: string;
    };
  } | null;
  pageSnapshot?: {
    type?: string;
    github?: {
      owner?: string;
      repository?: string;
      pullRequestNumber?: number;
      pullRequestTitle?: string;
    };
  } | null;
  ciSummary?: { headSha?: string } | null;
}): {
  owner: string;
  repository: string;
  pullRequestNumber?: number;
  headSha?: string;
  summary?: string;
} | null {
  const github =
    sessions.lastReviewContext?.github ??
    (sessions.pageSnapshot?.type === 'github' ? sessions.pageSnapshot.github : undefined) ??
    sessions.pageSnapshot?.github;
  if (!github?.owner || !github.repository) {
    return null;
  }
  return {
    owner: github.owner,
    repository: github.repository,
    pullRequestNumber: github.pullRequestNumber,
    headSha: sessions.ciSummary?.headSha,
    summary: github.pullRequestTitle,
  };
}
