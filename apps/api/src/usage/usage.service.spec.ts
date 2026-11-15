import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LEASE_RENEW_MS, UsageService } from './usage.service';

describe('UsageService', () => {
  const prisma = {
    workspaceUsageCounter: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
    workspaceUsageEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
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
    prisma.workspaceUsageEvent.findMany.mockResolvedValue([]);
    service = new UsageService(prisma as never, entitlements as never);
  });

  it('atomically consumes usage and increments the counter', async () => {
    prisma.workspaceUsageEvent.findUnique.mockResolvedValue(null);
    prisma.workspaceUsageCounter.updateMany.mockResolvedValue({ count: 1 });
    prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 1 });
    prisma.workspaceUsageEvent.create.mockResolvedValue({});

    const result = await service.consume({
      workspaceId: 'ws_1',
      metric: 'ai_action',
      quantity: 1,
      idempotencyKey: 'key-1',
    });

    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
    // One conditional UPDATE: the limit check and the increment cannot interleave.
    expect(prisma.workspaceUsageCounter.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.workspaceUsageCounter.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ workspaceId: 'ws_1', count: { lte: 1 } }),
      data: { count: { increment: 1 } },
    });
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
    expect(prisma.workspaceUsageCounter.updateMany).not.toHaveBeenCalled();
    expect(prisma.workspaceUsageEvent.create).not.toHaveBeenCalled();
  });

  it('throws USAGE_LIMIT_REACHED when the plan usage limit is reached', async () => {
    prisma.workspaceUsageEvent.findUnique.mockResolvedValue(null);
    prisma.workspaceUsageCounter.updateMany.mockResolvedValue({ count: 0 });
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
    expect(prisma.workspaceUsageEvent.create).not.toHaveBeenCalled();
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

  describe('reservations (AI operations)', () => {
    const input = {
      workspaceId: 'ws_1',
      userId: 'u1',
      metric: 'ai_action' as const,
      operationId: 'op-1',
      inFlightKey: 'k',
    };

    it('reserves under the server operation id, counted at once, owned by the user', async () => {
      prisma.workspaceUsageCounter.updateMany.mockResolvedValue({ count: 1 });
      prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 1 });
      const r = await service.reserve(input);
      expect(r).toEqual({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        idempotencyKey: 'op:op-1',
        operationId: 'op-1',
        quantity: 1,
      });
      expect(prisma.workspaceUsageEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          idempotencyKey: 'op:op-1',
          status: 'reserved',
          userId: 'u1',
          inFlightKey: 'k',
        }),
      });
    });

    it('an exhausted quota rejects the reservation (no event, no execution)', async () => {
      prisma.workspaceUsageCounter.updateMany.mockResolvedValue({ count: 0 });
      prisma.workspaceUsageCounter.findUnique.mockResolvedValue({ count: 2 });
      await expect(service.reserve(input)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'USAGE_LIMIT_REACHED' }),
      });
      expect(prisma.workspaceUsageEvent.create).not.toHaveBeenCalled();
    });

    it('an identical in-flight operation is rejected with 409 AI_OPERATION_IN_PROGRESS', async () => {
      prisma.$transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }),
      );
      const error = await service.reserve(input).catch((e: HttpException) => e);
      expect((error as HttpException).getStatus()).toBe(409);
      expect((error as HttpException).getResponse()).toMatchObject({
        code: 'AI_OPERATION_IN_PROGRESS',
      });
    });

    it('commit finalizes only an open reservation; release refunds only an open one', async () => {
      prisma.workspaceUsageEvent.updateMany.mockResolvedValue({ count: 1 });
      const r = {
        workspaceId: 'ws_1',
        metric: 'ai_action' as const,
        idempotencyKey: 'op:op-1',
        operationId: 'op-1',
        quantity: 1,
      };
      expect(await service.commit(r)).toBe(true);
      expect(prisma.workspaceUsageEvent.updateMany).toHaveBeenCalledWith({
        where: { workspaceId: 'ws_1', idempotencyKey: 'op:op-1', status: 'reserved' },
        data: expect.objectContaining({ status: 'committed', inFlightKey: null }),
      });
      prisma.$queryRaw.mockResolvedValue([]);
      expect(await service.releaseReservation(r)).toBe(false);
      expect(prisma.workspaceUsageCounter.updateMany).not.toHaveBeenCalled();
      prisma.$queryRaw.mockResolvedValue([{ quantity: 1, period_key: '2026-11' }]);
      expect(await service.releaseReservation(r)).toBe(true);
      expect(prisma.workspaceUsageCounter.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ periodKey: '2026-11', count: { gte: 1 } }),
        data: { count: { decrement: 1 } },
      });
    });
  });

  it('the heartbeat renews the lease until stopped', async () => {
    vi.useFakeTimers();
    try {
      const renew = vi.spyOn(service, 'renewLease').mockResolvedValue(true);
      const stop = service.startHeartbeat({
        workspaceId: 'ws_1',
        metric: 'ai_action',
        idempotencyKey: 'op:x',
        operationId: 'x',
        quantity: 1,
      });
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3);
      expect(renew).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS * 3);
      expect(renew).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
