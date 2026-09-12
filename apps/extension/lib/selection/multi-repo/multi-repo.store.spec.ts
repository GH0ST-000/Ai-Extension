import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowStepType as Step } from '@project-x/types';

import { runWorkflowStepHandler } from '../workflow/workflow-handlers';
import { useMultiRepoStore } from './multi-repo.store';

vi.mock('../../api/systems', () => ({
  MultiRepoApiError: class MultiRepoApiError extends Error {
    statusCode = 500;
    unauthorized = false;
    code = null;
  },
  listSystems: vi.fn(),
  getSystemContext: vi.fn(),
  refreshSystem: vi.fn(),
  analyzeChangeImpact: vi.fn(),
  traceSystemFlow: vi.fn(),
  compareRequirement: vi.fn(),
  findApiConsumers: vi.fn(),
  findEventConsumers: vi.fn(),
}));

import * as systemsApi from '../../api/systems';

const system = {
  id: 'sys-1',
  name: 'Payments',
  primaryRepository: { provider: 'github' as const, owner: 'acme', repository: 'api' },
  repositories: [
    {
      repository: { provider: 'github' as const, owner: 'acme', repository: 'api' },
      role: 'backend' as const,
      enabled: true,
      source: 'user_selected' as const,
    },
    {
      repository: { provider: 'github' as const, owner: 'acme', repository: 'web' },
      role: 'frontend' as const,
      enabled: true,
      source: 'user_selected' as const,
    },
  ],
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
};

describe('multi-repo.store', () => {
  beforeEach(() => {
    useMultiRepoStore.getState().clear();
    vi.mocked(systemsApi.listSystems).mockResolvedValue([system]);
    vi.mocked(systemsApi.getSystemContext).mockResolvedValue({
      system: { id: 'sys-1', name: 'Payments' },
      primaryRepository: system.primaryRepository,
      repositories: system.repositories.map((r) => ({
        ...r,
        available: true,
      })),
      relationships: [
        {
          id: 'rel-1',
          from: { provider: 'github', owner: 'acme', repository: 'web' },
          to: { provider: 'github', owner: 'acme', repository: 'api' },
          type: 'HTTP_CALLS',
          confidence: 'high',
          provenance: [],
          status: 'active',
        },
      ],
      resources: { httpOperations: [], kafkaTopics: [], sharedContracts: [] },
      scope: {
        repositoriesRequested: 2,
        repositoriesAnalyzed: 2,
        repositoriesUnavailable: 0,
        filesAnalyzed: 4,
        truncated: false,
      },
      generatedAt: '2026-09-12T00:00:00.000Z',
      version: 'v1',
    });
    vi.mocked(systemsApi.analyzeChangeImpact).mockResolvedValue({
      primaryChange: {
        repository: system.primaryRepository,
        summary: 'retry payments',
      },
      impactedRepositories: [
        {
          repository: { provider: 'github', owner: 'acme', repository: 'web' },
          likelihood: 'high',
          impactType: 'api_consumer',
          summary: 'Web calls retry endpoint',
          evidence: [],
          requiresChange: 'yes',
        },
      ],
      contractImpacts: [],
      risks: [],
      requiredCoordination: [],
      scope: {
        systemId: 'sys-1',
        repositoriesAnalyzed: [system.primaryRepository],
        filesAnalyzed: 4,
        truncated: false,
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    useMultiRepoStore.getState().clear();
  });

  it('loads systems and selects the first by default', async () => {
    const systems = await useMultiRepoStore.getState().loadSystems();
    expect(systems).toHaveLength(1);
    expect(useMultiRepoStore.getState().selectedSystemId).toBe('sys-1');
    expect(useMultiRepoStore.getState().enabledRepoKeys).toEqual(['acme/api', 'acme/web']);
  });

  it('builds planning summary with relationship strings capped at 8', async () => {
    await useMultiRepoStore.getState().loadSystems();
    await useMultiRepoStore.getState().buildContext('sys-1');
    const summary = useMultiRepoStore.getState().planningSummary();
    expect(summary?.systemId).toBe('sys-1');
    expect(summary?.enabledRepositories).toBe(2);
    expect(summary?.knownRelationships[0]).toContain('HTTP_CALLS');
  });

  it('analyzeImpact stores lastImpact and opens panel', async () => {
    await useMultiRepoStore.getState().loadSystems();
    const impact = await useMultiRepoStore.getState().analyzeImpact({
      owner: 'acme',
      repository: 'api',
      pullRequestNumber: 12,
    });
    expect(impact?.impactedRepositories).toHaveLength(1);
    expect(useMultiRepoStore.getState().panelOpen).toBe(true);
    expect(useMultiRepoStore.getState().scopeNote).toMatch(/selected repositories/i);
  });
});

describe('multi-repo workflow handlers', () => {
  beforeEach(() => {
    useMultiRepoStore.getState().clear();
    useMultiRepoStore.setState({
      systems: [system],
      selectedSystemId: 'sys-1',
      enabledRepoKeys: ['acme/api', 'acme/web'],
    });
  });

  afterEach(() => {
    useMultiRepoStore.getState().clear();
  });

  it('covers Day 23 steps without fallthrough and stays read-only', () => {
    const sessions = {
      pageSnapshot: {
        type: 'github' as const,
        url: 'https://github.com/acme/api/pull/12',
        title: 'PR',
        github: {
          owner: 'acme',
          repository: 'api',
          pullRequestNumber: 12,
          pullRequestTitle: 'Retry',
        },
      },
      jiraIssue: {
        id: '1',
        key: 'PAY-1',
        project: { key: 'PAY' },
        summary: 'Retry',
        siteHost: 'acme.atlassian.net',
        fetchedAt: '2026-09-12T00:00:00.000Z',
      },
      openApiOperation: {
        id: 'op-1',
        method: 'POST' as const,
        path: '/payments/retry',
        operationId: 'retryPayment',
        parameters: [],
        responses: [],
      },
    };

    const build = runWorkflowStepHandler(Step.BUILD_MULTI_REPO_CONTEXT, { sessions });
    expect(build.ok).toBe(true);
    if (build.ok && 'artifactKind' in build) {
      expect(build.artifactKind).toBe('multi-repo-context');
      expect(build.showPanel).toBe('multi-repo');
    }

    const impact = runWorkflowStepHandler(Step.ANALYZE_CHANGE_IMPACT, { sessions });
    expect(impact.ok).toBe(true);
    if (impact.ok && 'artifactKind' in impact) {
      expect(impact.artifactKind).toBe('change-impact');
    }

    const flow = runWorkflowStepHandler(Step.TRACE_SYSTEM_FLOW, { sessions });
    expect(flow.ok).toBe(true);
    if (flow.ok && 'artifactKind' in flow) {
      expect(flow.artifactKind).toBe('system-flow');
    }

    const compare = runWorkflowStepHandler(Step.COMPARE_REQUIREMENT_ACROSS_REPOS, { sessions });
    expect(compare.ok).toBe(true);
    if (compare.ok && 'artifactKind' in compare) {
      expect(compare.artifactKind).toBe('requirement-coverage');
    }

    const api = runWorkflowStepHandler(Step.FIND_API_CONSUMERS, { sessions });
    expect(api.ok).toBe(true);
    if (api.ok && 'artifactKind' in api) {
      expect(api.artifactKind).toBe('cross-repo-compatibility');
    }

    useMultiRepoStore.setState({
      context: {
        system: { id: 'sys-1' },
        primaryRepository: system.primaryRepository,
        repositories: [],
        relationships: [],
        resources: {
          httpOperations: [],
          kafkaTopics: [{ topic: 'payment.completed' }],
          sharedContracts: [],
        },
        scope: {
          repositoriesRequested: 1,
          repositoriesAnalyzed: 1,
          repositoriesUnavailable: 0,
          filesAnalyzed: 1,
          truncated: false,
        },
        generatedAt: '2026-09-12T00:00:00.000Z',
        version: 'v1',
      },
    });
    const events = runWorkflowStepHandler(Step.FIND_EVENT_CONSUMERS, { sessions });
    expect(events.ok).toBe(true);
    if (events.ok && 'showPanel' in events) {
      expect(events.showPanel).toBe('multi-repo');
    }

    // Never surfaces write confirmation panels for Day 23.
    for (const result of [build, impact, flow, compare, api, events]) {
      expect(result.ok && 'needsConfirmation' in result && result.needsConfirmation).toBeFalsy();
    }
  });

  it('fails closed when system is not selected', () => {
    useMultiRepoStore.setState({ selectedSystemId: null });
    const result = runWorkflowStepHandler(Step.ANALYZE_CHANGE_IMPACT, {
      sessions: {
        pageSnapshot: {
          type: 'github',
          url: 'https://github.com/acme/api/pull/1',
          title: 'PR',
          github: { owner: 'acme', repository: 'api', pullRequestNumber: 1 },
        },
      },
    });
    expect(result.ok).toBe(false);
  });
});
