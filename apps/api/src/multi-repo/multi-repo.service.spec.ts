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

function systemRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-09-12T12:00:00.000Z');
  return {
    id: 'sys-1',
    userId: 'user-1',
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

describe('MultiRepoService', () => {
  const prisma = {
    projectSystem: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
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

  const githubConnections = {
    getDecryptedToken: vi.fn(),
  };

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

    service = new MultiRepoService(
      prisma as never,
      githubConnections as never,
      githubContent as never,
      projectMemory as never,
    );
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

  it('enforces user isolation on getSystem', async () => {
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
        where: { id: 'sys-1', userId: 'user-2' },
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
    githubContent.fetchRepositoryFileAtRef.mockImplementation(
      async (_userId: string, _o: string, repo: string, path: string) => {
        if (repo === 'api' && path === 'README.md') {
          return '# See also https://github.com/acme/billing-service\n';
        }
        if (repo === 'api' && path === 'package.json') {
          return JSON.stringify({ name: '@acme/api' });
        }
        return null;
      },
    );

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

  it('impact requiresChange yes only when relationship evidence matches identifiers', async () => {
    prisma.repositoryRelationship.findMany.mockResolvedValue([
      {
        id: 'rel-1',
        userId: 'user-1',
        systemId: 'sys-1',
        fromOwner: 'acme',
        fromRepository: 'web',
        toOwner: 'acme',
        toRepository: 'api',
        type: 'CONSUMES_API',
        resourceKind: 'http_operation',
        resourceKey: 'POST /payments/retry',
        confidence: 'high',
        status: 'active',
        freshnessJson: null,
        provenanceJson: [
          {
            type: 'http_call',
            summary: 'HTTP client POST /payments/retry',
            filePath: 'src/api.ts',
            observedAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
        lastValidatedAt: new Date(),
      },
    ]);

    const withEvidence = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Changed POST /payments/retry',
    });
    expect(withEvidence.impactedRepositories.some((i) => i.requiresChange === 'yes')).toBe(true);
    expect(
      withEvidence.impactedRepositories.every(
        (i) => i.requiresChange !== 'yes' || i.evidence.length > 0,
      ),
    ).toBe(true);

    const withoutEvidence = await service.analyzeChangeImpact('user-1', {
      systemId: 'sys-1',
      owner: 'acme',
      repository: 'api',
      summary: 'Refactored internal helpers only',
    });
    expect(withoutEvidence.impactedRepositories.every((i) => i.requiresChange !== 'yes')).toBe(
      true,
    );
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
