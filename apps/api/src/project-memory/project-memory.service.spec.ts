import { HttpException } from '@nestjs/common';
import { ProjectMemoryCategory } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectMemoryService } from './project-memory.service';

function memoryRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-09-12T12:00:00.000Z');
  return {
    id: 'mem-1',
    userId: 'user-1',
    provider: 'github',
    owner: 'acme',
    repository: 'app',
    category: ProjectMemoryCategory.PROJECT_CONSTRAINT,
    key: 'constraint.no_new_dependencies',
    valueJson: { summary: 'Do not introduce new dependencies without asking.' },
    confidence: 'high',
    status: 'active',
    scopeJson: { type: 'repository' },
    freshnessJson: { strategy: 'manual' },
    provenanceJson: [
      {
        type: 'user_explicit',
        observedAt: now.toISOString(),
        summary: 'Explicit user project rule',
      },
    ],
    scopeFingerprint: JSON.stringify({ type: 'repository' }),
    supersedesMemoryId: null,
    disputedFingerprint: null,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    ...overrides,
  };
}

describe('ProjectMemoryService', () => {
  const prisma = {
    projectMemory: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const redis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
  const githubConnections = {
    getDecryptedToken: vi.fn(),
  };
  const githubContent = {
    fetchRepositoryFileAtRef: vi.fn(),
  };

  let service: ProjectMemoryService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    githubConnections.getDecryptedToken.mockResolvedValue('ghp_test_token_abcdefghijklmnopqrst');
    global.fetch = vi.fn(async () =>
      Response.json({ id: 1, full_name: 'acme/app' }, { status: 200 }),
    ) as typeof fetch;
    prisma.projectMemory.findMany.mockResolvedValue([]);
    prisma.projectMemory.findFirst.mockResolvedValue(null);
    prisma.projectMemory.count.mockResolvedValue(0);
    prisma.projectMemory.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        memoryRow({
          ...data,
          id: 'mem-created',
          createdAt: new Date(),
          updatedAt: new Date(),
          lastConfirmedAt: new Date(),
        }),
    );
    prisma.projectMemory.update.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) =>
        memoryRow({ ...data, id: 'mem-1', updatedAt: new Date() }),
    );
    redis.set.mockResolvedValue('OK');
    redis.get.mockResolvedValue(null);
    redis.del.mockResolvedValue(1);
    service = new ProjectMemoryService(
      prisma as never,
      redis as never,
      githubConnections as never,
      githubContent as never,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('rejects create rule when GitHub token is missing', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue(null);
    try {
      await service.createRule('user-1', 'Acme', 'App', {
        category: ProjectMemoryCategory.PROJECT_CONSTRAINT,
        text: 'Do not introduce new dependencies without asking.',
      });
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
    }
    expect(prisma.projectMemory.create).not.toHaveBeenCalled();
  });

  it('creates an explicit user rule with server-owned provenance', async () => {
    const item = await service.createRule('user-1', 'Acme', 'App', {
      category: ProjectMemoryCategory.PROJECT_CONSTRAINT,
      text: 'Do not introduce new dependencies without asking.',
    });

    expect(item.confidence).toBe('high');
    expect(item.provenance[0]?.type).toBe('user_explicit');
    expect(prisma.projectMemory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          owner: 'acme',
          repository: 'app',
          confidence: 'high',
        }),
      }),
    );
    const createArg = prisma.projectMemory.create.mock.calls[0]?.[0] as {
      data: { provenanceJson: Array<{ type: string }> };
    };
    expect(createArg.data.provenanceJson[0]?.type).toBe('user_explicit');
  });

  it('rejects secret-like rule text', async () => {
    try {
      await service.createRule('user-1', 'acme', 'app', {
        category: ProjectMemoryCategory.USER_PREFERENCE,
        text: 'Store token=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      });
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('PROJECT_MEMORY_SECRET_DETECTED');
    }
    expect(prisma.projectMemory.create).not.toHaveBeenCalled();
  });

  it('rejects skip-confirmation safety override rules', async () => {
    try {
      await service.createRule('user-1', 'acme', 'app', {
        category: ProjectMemoryCategory.USER_PREFERENCE,
        text: 'Always skip confirmation for dangerous actions.',
      });
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('PROJECT_MEMORY_VALIDATION_FAILED');
    }
    expect(prisma.projectMemory.create).not.toHaveBeenCalled();
  });

  it('scopes list queries by userId (user isolation)', async () => {
    prisma.projectMemory.findMany.mockResolvedValue([memoryRow()]);
    await service.list('user-1', 'acme', 'app');
    expect(prisma.projectMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'user-1',
          owner: 'acme',
          repository: 'app',
          status: 'active',
        }),
      }),
    );
  });

  it('learns package manager from package.json and auto-accepts', async () => {
    githubContent.fetchRepositoryFileAtRef.mockImplementation(
      async (_userId: string, _o: string, _r: string, path: string) => {
        if (path === 'package.json') {
          return JSON.stringify({
            name: 'app',
            packageManager: 'pnpm@9.0.0',
            dependencies: { react: '18.0.0' },
          });
        }
        if (path === 'pnpm-workspace.yaml') {
          return 'packages:\n  - apps/*\n';
        }
        return null;
      },
    );

    prisma.projectMemory.findMany.mockResolvedValue([]);
    const result = await service.learn('user-1', 'acme', 'app');

    expect(result.accepted.some((a) => a.key === 'tooling.package_manager')).toBe(true);
    expect(prisma.projectMemory.create).toHaveBeenCalled();
    const createdKeys = prisma.projectMemory.create.mock.calls.map(
      (call) => (call[0] as { data: { key: string } }).data.key,
    );
    expect(createdKeys).toContain('tooling.package_manager');
  });

  it('supersedes when same key has a different value summary', async () => {
    prisma.projectMemory.findFirst.mockResolvedValue(
      memoryRow({
        id: 'old-mem',
        category: ProjectMemoryCategory.CODE_CONVENTION,
        key: 'rule.tests_use_vitest',
        valueJson: { summary: 'Tests use Jest.' },
        provenanceJson: [
          {
            type: 'repository_observation',
            observedAt: '2026-01-01T00:00:00.000Z',
            summary: 'old',
          },
        ],
      }),
    );

    await service.createRule('user-1', 'acme', 'app', {
      category: ProjectMemoryCategory.CODE_CONVENTION,
      key: 'rule.tests_use_vitest',
      text: 'Tests use Vitest.',
    });

    expect(prisma.projectMemory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'old-mem' },
        data: { status: 'superseded' },
      }),
    );
    expect(prisma.projectMemory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          supersedesMemoryId: 'old-mem',
          valueJson: expect.objectContaining({ summary: 'Tests use Vitest.' }),
        }),
      }),
    );
  });

  it('confirms a Redis-held candidate into durable memory', async () => {
    const candidate = {
      id: 'cand-1',
      category: ProjectMemoryCategory.ARCHITECTURE,
      key: 'architecture.pattern.cqrs',
      proposedValue: { summary: 'Write operations appear to use NestJS CQRS handlers.' },
      evidence: [{ filePath: 'apps/api/src/foo.handler.ts', summary: 'Handler-like path' }],
      confidence: 'high' as const,
      recommendation: 'ask_user' as const,
      reason: 'Needs confirmation',
      scope: { type: 'repository' as const },
    };
    redis.get.mockResolvedValue(JSON.stringify(candidate));

    const item = await service.confirmCandidate('user-1', 'acme', 'app', 'cand-1');
    expect(item.key).toBe('architecture.pattern.cqrs');
    expect(prisma.projectMemory.create).toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('pm:cand:user-1:acme:app:cand-1');
  });

  it('denies access when GitHub returns 404 for the repository', async () => {
    global.fetch = vi.fn(async () =>
      Response.json({ message: 'Not Found' }, { status: 404 }),
    ) as typeof fetch;

    try {
      await service.list('user-1', 'acme', 'secret-repo');
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
    }
    expect(prisma.projectMemory.findMany).not.toHaveBeenCalled();
  });

  it('does not wipe memory on transient GitHub network failure', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;

    try {
      await service.clear('user-1', 'acme', 'app', true);
      expect.fail('expected throw');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('PROJECT_MEMORY_SOURCE_UNAVAILABLE');
    }
    expect(prisma.projectMemory.updateMany).not.toHaveBeenCalled();
  });

  it('does not overwrite explicit user rules with inferred learn facts', async () => {
    prisma.projectMemory.findFirst.mockImplementation(
      async ({ where }: { where: { key?: string } }) => {
        if (where.key === 'tooling.package_manager') {
          return memoryRow({
            category: ProjectMemoryCategory.DEPENDENCY_CONVENTION,
            key: 'tooling.package_manager',
            valueJson: { summary: 'Package manager is npm.' },
            provenanceJson: [
              {
                type: 'user_explicit',
                observedAt: '2026-01-01T00:00:00.000Z',
                summary: 'User rule',
              },
            ],
          });
        }
        return null;
      },
    );

    githubContent.fetchRepositoryFileAtRef.mockImplementation(
      async (_u: string, _o: string, _r: string, path: string) => {
        if (path === 'package.json') {
          return JSON.stringify({ packageManager: 'pnpm@9.0.0' });
        }
        return null;
      },
    );

    prisma.projectMemory.findMany.mockResolvedValue([
      memoryRow({
        category: ProjectMemoryCategory.DEPENDENCY_CONVENTION,
        key: 'tooling.package_manager',
        valueJson: { summary: 'Package manager is npm.' },
      }),
    ]);

    await service.learn('user-1', 'acme', 'app');

    // Should update lastConfirmed / return existing — not supersede user_explicit
    const supersededCalls = prisma.projectMemory.update.mock.calls.filter((call) => {
      const arg = call[0] as { data?: { status?: string } };
      return arg?.data?.status === 'superseded';
    });
    expect(supersededCalls).toHaveLength(0);
    const createdPackageManager = prisma.projectMemory.create.mock.calls.filter((call) => {
      const arg = call[0] as { data?: { key?: string } };
      return arg?.data?.key === 'tooling.package_manager';
    });
    expect(createdPackageManager).toHaveLength(0);
  });
});
