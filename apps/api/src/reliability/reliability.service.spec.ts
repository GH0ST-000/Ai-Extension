import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReliabilityService } from './reliability.service';

function executionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-09-12T20:00:00.000Z');
  return {
    id: 'wex_1',
    userId: 'user-1',
    workflowId: 'wf_1',
    executionNumber: 1,
    trigger: 'user',
    status: 'running',
    healthScore: 100,
    healthBand: 'Excellent',
    startedAt: now,
    completedAt: null,
    durationMs: null,
    parentExecutionId: null,
    goal: 'Fix CI',
    contextVersionJson: { prSha: 'aaa', memoryVersion: 'v1', repository: 'acme/app' },
    snapshotJson: { goal: 'Fix CI', checkpointIds: [], artifactRefs: [] },
    lineageJson: { nodes: [], edges: [] },
    healthSignalsJson: {
      completedStages: 0,
      failedStages: 0,
      retries: 0,
      warnings: 0,
      partialFailures: 0,
      staleArtifacts: 0,
      timeouts: 0,
      cancelled: false,
    },
    aiRequestsJson: [],
    promptSnapshotId: null,
    promptSnapshot: null,
    resumeAvailable: false,
    replayAvailable: true,
    artifactCount: 0,
    failureCount: 0,
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ReliabilityService', () => {
  const prisma = {
    workflowExecution: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workflowAuditEvent: {
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    executionCheckpoint: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    executionFailure: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    promptSnapshot: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  };

  let service: ReliabilityService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workflowExecution.count.mockResolvedValue(0);
    prisma.workflowAuditEvent.count.mockResolvedValue(0);
    prisma.workflowAuditEvent.create.mockResolvedValue({});
    prisma.workflowAuditEvent.findMany.mockResolvedValue([]);
    prisma.executionCheckpoint.findMany.mockResolvedValue([]);
    prisma.executionFailure.findMany.mockResolvedValue([]);
    prisma.promptSnapshot.findMany.mockResolvedValue([]);
    service = new ReliabilityService(prisma as never);
  });

  it('starts an execution with audit event and user isolation fields', async () => {
    const created = executionRow();
    prisma.workflowExecution.create.mockResolvedValue(created);

    const result = await service.startExecution('user-1', {
      workflowId: 'wf_1',
      goal: 'Fix CI with token=ghp_abcdefghijklmnopqrstuvwxyz12',
    });

    expect(result.id).toBe('wex_1');
    expect(prisma.workflowExecution.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          workflowId: 'wf_1',
          executionNumber: 1,
          status: 'running',
        }),
      }),
    );
    const createArg = prisma.workflowExecution.create.mock.calls[0]?.[0] as {
      data: { goal: string };
    };
    expect(createArg.data.goal).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz12');
    expect(prisma.workflowAuditEvent.create).toHaveBeenCalled();
  });

  it('creates checkpoints and marks resume available', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    prisma.executionCheckpoint.create.mockResolvedValue({
      id: 'cp_1',
      userId: 'user-1',
      executionId: 'wex_1',
      kind: 'PLANNING_COMPLETE',
      label: 'Planning Complete',
      stepId: null,
      stateJson: {},
      createdAt: new Date('2026-09-12T20:01:00.000Z'),
    });
    prisma.workflowExecution.update.mockResolvedValue(executionRow({ resumeAvailable: true }));

    const cp = await service.createCheckpoint('user-1', 'wex_1', {
      kind: 'PLANNING_COMPLETE',
      label: 'Planning Complete',
    });

    expect(cp.kind).toBe('PLANNING_COMPLETE');
    expect(prisma.workflowExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ resumeAvailable: true }),
      }),
    );
  });

  it('classifies and persists failures', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    prisma.executionFailure.create.mockResolvedValue({});
    prisma.workflowExecution.update.mockResolvedValue(executionRow({ status: 'failed' }));

    const failure = await service.recordFailure('user-1', 'wex_1', {
      code: 'AI_TIMEOUT',
      message: 'timed out',
      stage: 'AI_FETCH',
    });

    expect(failure.category).toBe('TIMEOUT');
    expect(failure.retryable).toBe(true);
    expect(prisma.executionFailure.create).toHaveBeenCalled();
  });

  it('records AI request hashes without storing secrets', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    prisma.promptSnapshot.findMany.mockResolvedValue([]);
    prisma.promptSnapshot.create.mockResolvedValue({
      id: 'ps_1',
      version: 1,
      hash: 'abc',
    });
    prisma.workflowExecution.update.mockResolvedValue(executionRow());

    const snap = await service.recordAiRequest('user-1', 'wex_1', {
      status: 'completed',
      provider: 'openai',
      model: 'gpt-test',
      promptBody: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb explain',
      inputParts: ['code'],
      outputText: 'ok',
    });

    expect(snap.inputHash).toBeTruthy();
    expect(snap.outputHash).toBeTruthy();
    const promptCreate = prisma.promptSnapshot.create.mock.calls[0]?.[0] as {
      data: { body: string; redacted: boolean };
    };
    expect(promptCreate.data.body).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(promptCreate.data.redacted).toBe(true);
  });

  it('detects drift on replay preview', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    const preview = await service.previewReplay('user-1', 'wex_1', {
      currentContext: { prSha: 'bbb', memoryVersion: 'v1', repository: 'acme/app' },
    });
    expect(preview.drift.hasDrift).toBe(true);
    expect(preview.requiresWriteConfirmation).toBe(true);
  });

  it('rejects auto-retry of confirmed GitHub writes', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    const result = await service.retryExecution('user-1', 'wex_1', {
      stage: 'GITHUB_WRITE',
      category: 'NETWORK',
      writeConfirmed: true,
    });
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.requiresConfirmation).toBe(true);
  });

  it('allows AI fetch retry and creates child execution', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    prisma.workflowExecution.update.mockResolvedValue(executionRow({ retryCount: 1 }));
    prisma.workflowExecution.count.mockResolvedValue(1);
    prisma.workflowExecution.create.mockResolvedValue(
      executionRow({
        id: 'wex_2',
        executionNumber: 2,
        trigger: 'retry',
        parentExecutionId: 'wex_1',
      }),
    );

    const result = await service.retryExecution('user-1', 'wex_1', {
      stage: 'AI_FETCH',
      category: 'TIMEOUT',
      attempt: 0,
    });

    expect(result.decision.allowed).toBe(true);
    expect(result.execution?.trigger).toBe('retry');
  });

  it('resumes from latest checkpoint', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(
      executionRow({ status: 'failed', resumeAvailable: true }),
    );
    prisma.executionCheckpoint.findMany.mockResolvedValue([
      {
        id: 'cp_1',
        userId: 'user-1',
        executionId: 'wex_1',
        kind: 'PATCH_GENERATED',
        label: 'Patch Generated',
        stepId: null,
        stateJson: { artifactId: 'art-1' },
        createdAt: new Date('2026-09-12T20:05:00.000Z'),
      },
    ]);
    prisma.workflowExecution.count.mockResolvedValue(1);
    prisma.workflowExecution.create.mockResolvedValue(
      executionRow({ id: 'wex_3', executionNumber: 2, trigger: 'resume' }),
    );
    prisma.executionCheckpoint.create.mockResolvedValue({});

    const resumed = await service.resumeExecution('user-1', 'wex_1');
    expect(resumed.skipCompletedThrough).toBe('PATCH_GENERATED');
    expect(resumed.execution.trigger).toBe('resume');
  });

  it('enforces user isolation on missing execution', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(null);
    await expect(service.getExecution('user-2', 'wex_1')).rejects.toBeInstanceOf(HttpException);
  });

  it('stores artifact lineage refs', async () => {
    prisma.workflowExecution.findFirst.mockResolvedValue(executionRow());
    prisma.workflowExecution.update.mockResolvedValue(executionRow({ artifactCount: 2 }));
    prisma.workflowAuditEvent.findMany.mockResolvedValue([]);
    prisma.executionCheckpoint.findMany.mockResolvedValue([]);
    prisma.executionFailure.findMany.mockResolvedValue([]);

    // getExecution after lineage update
    prisma.workflowExecution.findFirst
      .mockResolvedValueOnce(executionRow())
      .mockResolvedValueOnce(
        executionRow({ artifactCount: 2, lineageJson: { nodes: [{ id: 'a1' }], edges: [] } }),
      );

    await service.recordArtifactLineage('user-1', 'wex_1', {
      artifacts: [
        { id: 'a1', kind: 'pr-review' },
        { id: 'a2', kind: 'finding', parentArtifactId: 'a1' },
      ],
    });

    expect(prisma.workflowExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          artifactCount: 2,
        }),
      }),
    );
  });
});
