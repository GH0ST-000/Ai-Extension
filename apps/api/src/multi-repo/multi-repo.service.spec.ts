import { HttpException } from '@nestjs/common';
import {
  MULTI_REPO_MAX_REPOS_PER_SYSTEM,
  compareHttpRequiredFieldsAdded,
  compareTopicRename,
  assertNoInventedRepositories,
  toRepositoryIdentity,
} from '@project-x/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MultiRepoService } from './multi-repo.service';
import { roleHasPermission } from '@project-x/shared';
import type { WorkspacePermission, WorkspaceRole } from '@project-x/types';
import { workspaceException } from '../workspaces/workspace.errors';
import { usageStub } from '../ai/pr-review/pr-review-fixtures';
import { repositoryAccessStub } from '../github-app/github-access.test-helpers';
import { personalWorkspaceMembership } from '../workspaces/workspace-membership.test-helpers';

function systemRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-09-12T12:00:00.000Z');
  return {
    id: 'sys-1',
    userId: 'user-1',
    workspaceId: 'ws_user-1',
    createdByUserId: 'user-1',
    name: 'Payments',
    primaryProvider: 'github',
    primaryOwner: 'acme',
    primaryRepository: 'api',
    createdAt: now,
    updatedAt: now,
    repositories: [
      {
        id: 'psr-1',
        systemId: 'sys-1',
        provider: 'github',
        owner: 'acme',
        repository: 'api',
        role: 'backend',
        enabled: true,
        source: 'user_selected',
        createdAt: now,
      },
      {
        id: 'psr-2',
        systemId: 'sys-1',
        provider: 'github',
        owner: 'acme',
        repository: 'web',
        role: 'frontend',
        enabled: true,
        source: 'user_selected',
        createdAt: now,
      },
    ],
    ...overrides,
  };
}

/** Authorization double backed by the REAL shared permission matrix. */
let actingRole: WorkspaceRole = 'owner';
const authorization = {
  assertAccess: vi.fn(async ({ permission }: { permission?: WorkspacePermission }) => {
    if (permission && !roleHasPermission(actingRole, permission)) {
      throw workspaceException(
        'WORKSPACE_ACCESS_DENIED',
        'You do not have permission to perform this action.',
      );
    }
    return { workspaceId: 'ws', membershipId: 'm', role: actingRole, permissions: [] };
  }),
};
const audit = { record: vi.fn() };

describe('MultiRepoService', () => {
  const prisma = {
    user: {
      findUnique: vi.fn(),
    },
    workspaceMembership: {
      findFirst: vi.fn(),
    },
    projectSystem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    workspaceSubscription: {
      findUnique: vi.fn(),
    },
    projectSystemRepository: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    repositoryRelationship: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    projectMemory: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const githubConnections = repositoryAccessStub({
    getDecryptedToken: vi.fn(),
  });

  const githubContent = {
    fetchRepositoryFileAtRef: vi.fn(),
  };

  const projectMemory = {
    getProfile: vi.fn(),
  };

  let service: MultiRepoService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    githubConnections.getDecryptedToken.mockResolvedValue('ghp_test_token_abcdefghijklmnopqrst');
    global.fetch = vi.fn(async () =>
      Response.json({ id: 1, full_name: 'acme/api' }, { status: 200 }),
    ) as typeof fetch;

    prisma.user.findUnique.mockResolvedValue(null);
    prisma.workspaceMembership.findFirst.mockImplementation(personalWorkspaceMembership);
    prisma.projectSystem.findFirst.mockResolvedValue(systemRow());
    prisma.projectSystem.findMany.mockResolvedValue([systemRow()]);
    prisma.projectSystem.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const repos =
          (data.repositories as { create: Array<Record<string, unknown>> })?.create ?? [];
        return systemRow({
          id: 'sys-created',
          name: data.name,
          primaryOwner: data.primaryOwner,
          primaryRepository: data.primaryRepository,
          repositories: repos.map((r, i) => ({
            id: `psr-${i}`,
            systemId: 'sys-created',
            provider: 'github',
            owner: r.owner,
            repository: r.repository,
            role: r.role ?? 'unknown',
            enabled: r.enabled !== false,
            source: r.source ?? 'user_selected',
            createdAt: now,
          })),
          createdAt: now,
          updatedAt: now,
        });
      },
    );
    prisma.projectSystem.update.mockImplementation(async () => systemRow());
    prisma.projectSystemRepository.create.mockResolvedValue({});
    prisma.repositoryRelationship.findMany.mockResolvedValue([]);
    prisma.repositoryRelationship.findFirst.mockResolvedValue(null);
    prisma.repositoryRelationship.create.mockResolvedValue({});
    prisma.repositoryRelationship.update.mockResolvedValue({});
    prisma.repositoryRelationship.deleteMany.mockResolvedValue({ count: 0 });
    prisma.$transaction.mockImplementation(async (ops: unknown) => {
      if (Array.isArray(ops)) {
        return Promise.all(ops);
      }
      return ops;
    });
    projectMemory.getProfile.mockRejectedValue(new Error('no memory'));
    githubContent.fetchRepositoryFileAtRef.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.workspaceMembership.findFirst.mockImplementation(personalWorkspaceMembership);
    prisma.projectSystem.count.mockResolvedValue(0);
    prisma.workspaceSubscription.findUnique.mockResolvedValue({ planId: 'team', status: 'active' });

    const featureGate = { require: vi.fn(async () => undefined) };
    const entitlements = {
      getEntitlements: vi.fn(async () => ({
        multiRepoIntelligence: true,
        maxProjectSystems: 20,
        maxRepositoriesPerSystem: 12,
      })),
    };
    const usage = usageStub();

    service = new MultiRepoService(
      prisma as never,
      githubConnections as never,
      githubContent as never,
      projectMemory as never,
      featureGate as never,
      entitlements as never,
      usage as never,
      authorization as never,
      audit as never,
    );
    actingRole = 'owner';
    authorization.assertAccess.mockClear();
    audit.record.mockClear();
  });

  describe('M4 — Systems permissions', () => {
    const system = () => ({
      id: 'sys-1',
      workspaceId: 'ws_user-1',
      userId: 'user-1',
      name: 'S',
      primaryProvider: 'github',
      primaryOwner: 'acme',
      primaryRepository: 'api',
      createdByUserId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      repositories: [
        {
          id: 'r1',
          systemId: 'sys-1',
          provider: 'github',
          owner: 'acme',
          repository: 'api',
          role: 'unknown',
          enabled: true,
          source: 'user_selected',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'r2',
          systemId: 'sys-1',
          provider: 'github',
          owner: 'acme',
          repository: 'web',
          role: 'frontend',
          enabled: true,
          source: 'user_selected',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    const mutations: Array<[string, () => Promise<unknown>]> = [
      [
        'createSystem',
        () =>
          service.createSystem('user-1', { name: 'X', primaryOwner: 'a', primaryRepository: 'b' }),
      ],
      ['updateSystem', () => service.updateSystem('user-1', 'sys-1', { name: 'Y' })],
      ['deleteSystem', () => service.deleteSystem('user-1', 'sys-1')],
      [
        'addRepository',
        () => service.addRepository('user-1', 'sys-1', { owner: 'a', repository: 'c' }),
      ],
      [
        'updateRepository',
        () => service.updateRepository('user-1', 'sys-1', 'acme', 'web', { enabled: false }),
      ],
      ['removeRepository', () => service.removeRepository('user-1', 'sys-1', 'acme', 'web')],
    ];

    it.each(mutations)(
      '%s: a Member (no systems:manage) is refused before any read or write',
      async (_n, run) => {
        actingRole = 'member';
        prisma.projectSystem.findFirst.mockResolvedValue(system());
        await expect(run()).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'WORKSPACE_ACCESS_DENIED' }),
        });
        expect(authorization.assertAccess).toHaveBeenCalledWith(
          expect.objectContaining({ permission: 'systems:manage' }),
        );
        expect(prisma.projectSystem.findFirst).not.toHaveBeenCalled();
        expect(prisma.projectSystem.create).not.toHaveBeenCalled();
        expect(prisma.projectSystem.update).not.toHaveBeenCalled();
        expect(prisma.projectSystem.delete).not.toHaveBeenCalled();
        expect(audit.record).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'systems.access.denied', outcome: 'blocked' }),
        );
      },
    );

    it.each(['owner', 'admin'] as const)('%s may delete a system (audited)', async (role) => {
      actingRole = role;
      prisma.projectSystem.findFirst.mockResolvedValue(system());
      await expect(service.deleteSystem('user-1', 'sys-1')).resolves.toEqual({
        deleted: true,
        id: 'sys-1',
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'systems.system.deleted', outcome: 'success' }),
      );
    });

    it('reads require systems:read, which every role has (Member included)', async () => {
      actingRole = 'member';
      prisma.projectSystem.findFirst.mockResolvedValue(system());
      await service.getSystem('user-1', 'sys-1');
      await service.listSystems('user-1');
      await service.listRelationships('user-1', 'sys-1');
      const permissions = authorization.assertAccess.mock.calls.map((c) => c[0].permission);
      expect(permissions.length).toBeGreaterThanOrEqual(3);
      expect(new Set(permissions)).toEqual(new Set(['systems:read']));
    });

    it('no permission check is skipped: an unauthorized reader gets nothing from the database', async () => {
      authorization.assertAccess.mockRejectedValueOnce(
        workspaceException('WORKSPACE_ACCESS_DENIED', 'denied'),
      );
      await expect(service.listSystems('user-1')).rejects.toBeInstanceOf(HttpException);
      expect(prisma.projectSystem.findMany).not.toHaveBeenCalled();
    });

    it('internal downstream-impact entry point is permission-checked too', async () => {
      authorization.assertAccess.mockRejectedValueOnce(
        workspaceException('WORKSPACE_ACCESS_DENIED', 'denied'),
      );
      await expect(
        service.computeContractDownstreamImpact('user-1', {
          owner: 'acme',
          repository: 'api',
          changes: [],
        }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(authorization.assertAccess).toHaveBeenCalledWith(
        expect.objectContaining({ permission: 'systems:read' }),
      );
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('creates a system including primary as user_selected and normalizes owner/repo', async () => {
    const system = await service.createSystem('user-1', {
      name: 'Payments',
      primaryOwner: 'Acme',
      primaryRepository: 'API',
      repositories: [{ owner: 'Acme', repository: 'Web', role: 'frontend' }],
    });

    expect(system.primaryRepository.owner).toBe('acme');
    expect(system.primaryRepository.repository).toBe('api');
    expect(prisma.projectSystem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          workspaceId: 'ws_user-1',
          primaryOwner: 'acme',
          primaryRepository: 'api',
          repositories: {
            create: expect.arrayContaining([
              expect.objectContaining({
                owner: 'acme',
                repository: 'api',
                source: 'user_selected',
                enabled: true,
              }),
              expect.objectContaining({
                owner: 'acme',
                repository: 'web',
                role: 'frontend',
                source: 'user_selected',
              }),
            ]),
          },
        }),
      }),
    );
  });

  it('enforces workspace isolation on getSystem (cross-tenant IDOR)', async () => {
    prisma.projectSystem.findFirst.mockResolvedValue(null);
    try {
      await service.getSystem('user-2', 'sys-1');
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('SYSTEM_CONTEXT_NOT_CONFIGURED');
    }
    expect(prisma.projectSystem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sys-1', workspaceId: 'ws_user-2' },
      }),
    );
  });

  it('rejects create when repository limit would be exceeded', async () => {
    const repos = Array.from({ length: MULTI_REPO_MAX_REPOS_PER_SYSTEM }, (_, i) => ({
      owner: 'acme',
      repository: `extra-${i}`,
    }));
    try {
      await service.createSystem('user-1', {
        name: 'Too many',
        primaryOwner: 'acme',
        primaryRepository: 'api',
        repositories: repos,
      });
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('SYSTEM_REPOSITORY_LIMIT_REACHED');
    }
    expect(prisma.projectSystem.create).not.toHaveBeenCalled();
  });

  it('prevents duplicate repository add', async () => {
    try {
      await service.addRepository('user-1', 'sys-1', {
        owner: 'acme',
        repository: 'web',
      });
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('RELATIONSHIP_CONFLICT');
    }
    expect(prisma.projectSystemRepository.create).not.toHaveBeenCalled();
  });

  it('updates primary repository role in place without remove', async () => {
    prisma.projectSystem.findFirst
      .mockResolvedValueOnce(systemRow())
      .mockResolvedValueOnce(systemRow());
    prisma.projectSystemRepository.update.mockResolvedValue({});

    const updated = await service.updateRepository('user-1', 'sys-1', 'acme', 'api', {
      role: 'gateway',
    });

    expect(prisma.projectSystemRepository.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'psr-1' },
        data: { role: 'gateway' },
      }),
    );
    expect(prisma.projectSystemRepository.delete).not.toHaveBeenCalled();
    expect(updated.id).toBe('sys-1');
  });

  it('removeRepository deletes relationships but does not touch project memory', async () => {
    prisma.projectSystem.findFirst.mockResolvedValueOnce(systemRow()).mockResolvedValueOnce(
      systemRow({
        repositories: [
          {
            id: 'psr-1',
            systemId: 'sys-1',
            provider: 'github',
            owner: 'acme',
            repository: 'api',
            role: 'backend',
            enabled: true,
            source: 'user_selected',
            createdAt: new Date(),
          },
        ],
      }),
    );

    await service.removeRepository('user-1', 'sys-1', 'acme', 'web');

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.repositoryRelationship.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ systemId: 'sys-1' }),
      }),
    );
    expect(prisma.projectMemory.deleteMany).not.toHaveBeenCalled();
    expect(prisma.projectMemory.findMany).not.toHaveBeenCalled();
  });

  it('partial analysis marks inaccessible repos unavailable', async () => {
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/repos/acme/web')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return Response.json({ id: 1, full_name: 'acme/api' }, { status: 200 });
    }) as typeof fetch;

    const context = await service.buildArchitectureContext('user-1', 'sys-1');
    expect(context.scope.repositoriesUnavailable).toBe(1);
    expect(context.repositories.find((r) => r.repository.repository === 'web')?.available).toBe(
      false,
    );
    expect(context.repositories.find((r) => r.repository.repository === 'api')?.available).toBe(
      true,
    );
  });

  it('discover does not auto-add candidate repositories into the system', async () => {
    service.scannerFactory = () =>
      ({
        scan: async (_owner: string, repo: string) => ({
          status: 'complete',
          files:
            repo === 'api'
              ? [
                  {
                    path: 'README.md',
                    content: '# See also https://github.com/acme/billing-service\n',
                  },
                  { path: 'package.json', content: JSON.stringify({ name: '@acme/api' }) },
                ]
              : [],
          issues: new Map(),
        }),
      }) as never;

    const result = await service.discoverRelationships('user-1', 'sys-1');

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every((c) => c.recommendation === 'suggest_add')).toBe(true);
    expect(prisma.projectSystemRepository.create).not.toHaveBeenCalled();
    expect(
      result.candidates.some(
        (c) => c.repository.owner === 'acme' && c.repository.repository === 'billing-service',
      ),
    ).toBe(true);
  });

  function relRow(over: Record<string, unknown> = {}) {
    return {
      id: `rel-${Math.random()}`,
      userId: 'user-1',
      systemId: 'sys-1',
      fromOwner: 'acme',
      fromRepository: 'web',
      toOwner: 'acme',
      toRepository: 'api',
      type: 'HTTP_CALLS',
      resourceKind: 'http_operation',
      resourceKey: 'POST /payments/retry',
      confidence: 'high',
      status: 'active',
      freshnessJson: null,
      provenanceJson: [
        {
          type: 'http_call',
          summary: 'POST /payments/retry via API_URL (line 12)',
          filePath: 'src/api.ts',
          observedAt: new Date().toISOString(),
        },
        {
          type: 'openapi_reference',
          summary: 'OpenAPI POST /payments/retry',
          filePath: 'openapi.yaml',
          observedAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastValidatedAt: new Date(),
      ...over,
    };
  }

  it('impact: an HTTP operation named without a verified contract diff is an unverified risk, never "requires change: yes"', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([relRow()]);
    const named = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Changed POST /payments/retry',
    });
    expect(named.impactedRepositories).toEqual([]);
    expect(named.risks.map((r) => r.code)).toEqual(['HTTP_CONTRACT_IMPACT_UNVERIFIED']);
    expect(named.risks[0]!.summary).toContain('acme/web calls POST /payments/retry');
    expect(named.risks[0]!.evidence[0]).toMatchObject({
      path: 'src/api.ts',
      trust: 'deterministic_source',
    });
    expect(
      named.unaffectedOrNotEvident?.find((u) => u.repository.repository === 'web')?.reason,
    ).toContain('not verified');

    const unrelated = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Refactored internal helpers only',
    });
    expect(unrelated.impactedRepositories).toEqual([]);
    expect(unrelated.risks).toEqual([]);
  });

  it('impact: no substring matches, and /health is not flagged when another endpoint changes', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([
      relRow({ resourceKey: 'GET /health' }),
      relRow({ resourceKey: 'GET /api/users/{param}' }),
    ]);
    const analysis = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Changed /api/users and /api',
    });
    expect(analysis.risks).toEqual([]); // /api/users ≠ /api/users/{param}; /api matches nothing
    const byId = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Changed GET /api/users/{userId}',
    });
    expect(byId.risks[0]!.summary).toContain('GET /api/users/{param}');
    expect(byId.risks[0]!.summary).not.toContain('/health');
  });

  it('impact: a changed openapi.yaml file name alone flags nobody', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([
      relRow(),
      relRow({ resourceKey: 'GET /health' }),
    ]);
    global.fetch = vi.fn(async (input: string | URL | Request) =>
      String(input).includes('/pulls/7/files')
        ? Response.json([
            { filename: 'openapi.yaml', patch: '-  description: old\n+  description: new' },
          ])
        : Response.json({ id: 1, full_name: 'acme/api' }, { status: 200 }),
    ) as typeof fetch;
    const analysis = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      pullRequestNumber: 7,
    });
    expect(analysis.impactedRepositories).toEqual([]);
    expect(analysis.risks).toEqual([]);
  });

  it('impact is directional: a change to the consumer never flags its provider', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([relRow()]);
    const analysis = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'web',
      summary: 'Changed POST /payments/retry',
    });
    expect(analysis.risks).toEqual([]);
    expect(analysis.impactedRepositories).toEqual([]);
  });

  it('impact: non-HTTP (Kafka) behavior is preserved — an exact topic match is evidence', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([
      relRow({
        type: 'CONSUMES_EVENT',
        resourceKind: 'kafka_topic',
        resourceKey: 'orders.created',
        provenanceJson: [
          {
            type: 'kafka_consumer',
            summary: 'consumes orders.created',
            filePath: 'src/worker.ts',
            observedAt: new Date().toISOString(),
          },
        ],
      }),
    ]);
    const analysis = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Changed payload of orders.created',
    });
    expect(
      analysis.impactedRepositories.map((i) => [i.repository.repository, i.requiresChange]),
    ).toEqual([['web', 'yes']]);
  });

  it('rejects hallucinated repositories via assertNoInventedRepositories', () => {
    const allowed = [toRepositoryIdentity('acme', 'api'), toRepositoryIdentity('acme', 'web')];
    const ok = assertNoInventedRepositories([toRepositoryIdentity('acme', 'api')], allowed);
    expect(ok.ok).toBe(true);

    const bad = assertNoInventedRepositories(
      [toRepositoryIdentity('acme', 'invented-service')],
      allowed,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe('RELATED_REPOSITORY_AMBIGUOUS');
    }
  });

  it('uses topic rename and HTTP required-field compatibility helpers', () => {
    const topic = compareTopicRename('orders.created', 'orders.created.v2');
    expect(topic.status).toBe('breaking_evidence');

    const http = compareHttpRequiredFieldsAdded(['id'], ['id', 'idempotencyKey']);
    expect(http.status).toBe('potentially_breaking');
    expect(http.reasons.some((r) => r.field === 'idempotencyKey')).toBe(true);
  });

  it('analyzeChangeImpact surfaces topic rename contract impact from summary', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([]);
    const analysis = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'topic orders.created renamed to orders.created.v2',
    });
    expect(analysis.contractImpacts.some((c) => c.kind === 'kafka')).toBe(true);
  });
});
