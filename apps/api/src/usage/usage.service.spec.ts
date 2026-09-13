import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UsageService } from './usage.service';

describe('UsageService', () => {
  const prisma = {
    workspaceUsageCounter: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceUsageEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const entitlements = {
    getEntitlements: vi.fn(),
    getPlanId: vi.fn(),
  };

  let service: UsageService;

  beforeEach(() => {
    vi.clearAllMocks();
    entitlements.getEntitlements.mockResolvedValue({
      monthlyAiActions: 2,
      monthlyWorkflowRuns: 10,
      monthlyMultiRepoAnalyses: 0,
    });
    entitlements.getPlanId.mockResolvedValue('free');
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    service = new UsageService(prisma as never, entitlements as never);
  });

  it('atomically consumes usage and increments the counter', async () => {
    prisma.workspaceUsageEvent.findUnique.mockResolvedValue(null);
    prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 0 });
    prisma.workspaceUsageCounter.upsert.mockResolvedValue({ count: 1 });
    prisma.workspaceUsageEvent.create.mockResolvedValue({});

    const result = await service.consume({
      workspaceId: 'ws_1',
      metric: 'ai_action',
      quantity: 1,
      idempotencyKey: 'key-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(prisma.workspaceUsageCounter.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ count: 1 }),
        update: { count: { increment: 1 } },
      }),
    );
    expect(prisma.workspaceUsageEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: 'ws_1',
          idempotencyKey: 'key-1',
          quantity: 1,
        }),
      }),
    );
  });

  it('does not double-count when the idempotency key already exists', async () => {
    prisma.workspaceUsageEvent.findUnique.mockResolvedValue({
      id: 'evt_1',
      workspaceId: 'ws_1',
      idempotencyKey: 'key-1',
    });
    prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 1 });

    const result = await service.consume({
      workspaceId: 'ws_1',
      metric: 'ai_action',
      quantity: 1,
      idempotencyKey: 'key-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    expect(prisma.workspaceUsageCounter.upsert).not.toHaveBeenCalled();
    expect(prisma.workspaceUsageEvent.create).not.toHaveBeenCalled();
  });

  it('throws USAGE_LIMIT_REACHED when the plan usage limit is reached', async () => {
    prisma.workspaceUsageEvent.findUnique.mockResolvedValue(null);
    prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 2 });

    await expect(
      service.consume({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        quantity: 1,
        idempotencyKey: 'key-limit',
      }),
    ).rejects.toBeInstanceOf(HttpException);

    try {
      await service.consume({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        quantity: 1,
        idempotencyKey: 'key-limit',
      });
    } catch (err) {
      const body = (err as HttpException).getResponse() as {
        code?: string;
        details?: { current?: number; limit?: number };
      };
      expect(body.code).toBe('USAGE_LIMIT_REACHED');
    }
    expect(prisma.workspaceUsageCounter.upsert).not.toHaveBeenCalled();
  });

  it('throws USAGE_LIMIT_REACHED for invalid quantity', async () => {
    await expect(
      service.consume({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        quantity: 0,
      }),
    ).rejects.toBeInstanceOf(HttpException);

    try {
      await service.consume({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        quantity: 0,
      });
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('USAGE_LIMIT_REACHED');
    }
  });
});
