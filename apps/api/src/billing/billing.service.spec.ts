import { createHmac } from 'node:crypto';

import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { SandboxBillingProvider } from './billing-provider';

describe('SandboxBillingProvider', () => {
  it('verifies HMAC signatures over the raw body', () => {
    const provider = new SandboxBillingProvider('test-secret');
    const body = Buffer.from(
      JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.updated' }),
    );
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(provider.verifyWebhook(body, 'sha256=' + signature)).toBe(true);
    expect(provider.verifyWebhook(body, 'deadbeef')).toBe(false);
    expect(provider.verifyWebhook(body, undefined)).toBe(false);
  });
});

describe('BillingService.handleWebhook', () => {
  const prisma = {
    billingWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    workspaceSubscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    workspaceMembership: {
      count: vi.fn(),
    },
  };

  const config = {
    get: vi.fn((key: string) => {
      if (key === 'paddle') {
        return {
          webhookSecret: 'test-secret',
          clientToken: '',
          environment: 'sandbox',
          prices: {
            proMonthly: '',
            proYearly: '',
            teamMonthly: '',
            teamYearly: '',
          },
        };
      }
      if (key === 'appBaseUrl') return 'http://localhost:3000';
      return undefined;
    }),
  };

  const entitlements = {
    getPlanId: vi.fn().mockResolvedValue('free'),
    getEntitlements: vi.fn().mockResolvedValue({ maxWorkspaceMembers: 1 }),
    invalidate: vi.fn(),
  };

  const usage = {
    getUsageCounters: vi.fn().mockResolvedValue([]),
  };

  let service: BillingService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.billingWebhookEvent.findUnique.mockResolvedValue(null);
    prisma.billingWebhookEvent.create.mockResolvedValue({});
    prisma.workspaceSubscription.upsert.mockResolvedValue({});
    prisma.workspaceMembership.count.mockResolvedValue(1);
    service = new BillingService(
      prisma as never,
      config as never,
      entitlements as never,
      usage as never,
    );
  });

  function signedBody(payload: Record<string, unknown>): { raw: Buffer; signature: string } {
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'test-secret').update(raw).digest('hex');
    return { raw, signature };
  }

  it('rejects invalid signatures without mutating state', async () => {
    const { raw } = signedBody({
      event_id: 'evt_bad',
      event_type: 'subscription.updated',
      data: { workspace_id: 'ws_1', plan_id: 'pro', status: 'active' },
    });

    await expect(service.handleWebhook(raw, 'invalid')).rejects.toBeInstanceOf(HttpException);
    try {
      await service.handleWebhook(raw, 'invalid');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('BILLING_WEBHOOK_INVALID');
    }
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('applies subscription updates for a valid signed event', async () => {
    const { raw, signature } = signedBody({
      event_id: 'evt_good',
      event_type: 'subscription.updated',
      data: {
        workspace_id: 'ws_1',
        id: 'sub_1',
        customer_id: 'ctm_1',
        plan_id: 'pro',
        status: 'active',
        billing_cycle: 'monthly',
      },
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.billingWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'paddle',
          eventId: 'evt_good',
        }),
      }),
    );
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws_1' },
        create: expect.objectContaining({ planId: 'pro', status: 'active' }),
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws_1');
  });

  it('is idempotent for duplicate eventId', async () => {
    prisma.billingWebhookEvent.findUnique.mockResolvedValue({
      id: 'already',
      eventId: 'evt_dup',
    });
    const { raw, signature } = signedBody({
      event_id: 'evt_dup',
      event_type: 'subscription.updated',
      data: {
        workspace_id: 'ws_1',
        plan_id: 'pro',
        status: 'active',
      },
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });
});
