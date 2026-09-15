import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import {
  buildPaddleWebhookSignatureHeader,
  PADDLE_WEBHOOK_MAX_AGE_SECONDS,
} from './paddle-webhook-signature';

function sign(body: Buffer, secret: string, ts?: number): string {
  return buildPaddleWebhookSignatureHeader(body, secret, { ts });
}

describe('BillingService webhook security', () => {
  const prisma = {
    billingWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    workspaceSubscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    workspaceMembership: {
      count: vi.fn().mockResolvedValue(1),
    },
  };

  const config = {
    get: vi.fn((key: string) => {
      if (key === 'nodeEnv') return 'test';
      if (key === 'paddle') {
        return {
          apiKey: '',
          webhookSecret: 'test-webhook-secret',
          environment: 'sandbox',
          clientToken: '',
          prices: {
            proMonthly: 'pri_pro_m',
            proYearly: 'pri_pro_y',
            teamMonthly: 'pri_team_m',
            teamYearly: 'pri_team_y',
          },
        };
      }
      if (key === 'appBaseUrl') return 'http://localhost:3000';
      return undefined;
    }),
  };

  const entitlements = {
    getPlanId: vi.fn(async () => 'free'),
    getEntitlements: vi.fn(async () => ({
      maxWorkspaceMembers: 1,
      monthlyAiActions: 50,
      monthlyWorkflowRuns: 10,
      monthlyMultiRepoAnalyses: 0,
    })),
    invalidate: vi.fn(),
  };

  const usage = {
    getUsageCounters: vi.fn(async () => []),
  };

  let service: BillingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new BillingService(
      prisma as never,
      config as never,
      entitlements as never,
      usage as never,
    );
  });

  it('rejects invalid webhook signatures without mutating billing state', async () => {
    const raw = Buffer.from(
      JSON.stringify({
        event_id: 'evt_1',
        event_type: 'subscription.updated',
        data: { workspaceId: 'ws_1', planId: 'pro', status: 'active' },
      }),
    );

    await expect(service.handleWebhook(raw, 'sha256=deadbeef')).rejects.toSatisfy(
      (err: unknown) => {
        const response =
          err && typeof err === 'object' && 'getResponse' in err
            ? (err as { getResponse: () => unknown }).getResponse()
            : null;
        return (
          typeof response === 'object' &&
          response !== null &&
          (response as { code?: string }).code === 'BILLING_WEBHOOK_INVALID'
        );
      },
    );
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('rejects replayed webhooks outside the Paddle timestamp window', async () => {
    const payload = {
      event_id: 'evt_stale',
      event_type: 'subscription.updated',
      data: { workspace_id: 'ws_1', plan_id: 'pro', status: 'active' },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const staleTs = Math.floor(Date.now() / 1000) - PADDLE_WEBHOOK_MAX_AGE_SECONDS - 60;
    const signature = sign(raw, 'test-webhook-secret', staleTs);

    await expect(service.handleWebhook(raw, signature)).rejects.toSatisfy((err: unknown) => {
      const response =
        err && typeof err === 'object' && 'getResponse' in err
          ? (err as { getResponse: () => unknown }).getResponse()
          : null;
      return (
        typeof response === 'object' &&
        response !== null &&
        (response as { code?: string }).code === 'BILLING_WEBHOOK_INVALID'
      );
    });
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
  });

  it('acks duplicate webhook event IDs without re-applying subscription mutations', async () => {
    const payload = {
      event_id: 'evt_dup',
      event_type: 'subscription.updated',
      data: {
        workspace_id: 'ws_1',
        plan_id: 'pro',
        status: 'active',
      },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = sign(raw, 'test-webhook-secret');

    prisma.billingWebhookEvent.findUnique.mockResolvedValue({
      id: 'existing',
      eventId: 'evt_dup',
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
  });
});
