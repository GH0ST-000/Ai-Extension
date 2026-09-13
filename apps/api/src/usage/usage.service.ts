import { Injectable } from '@nestjs/common';
import { usagePeriodKey, usagePeriodResetAt } from '@project-x/shared';
import type {
  ProductEntitlements,
  UsageConsumeResult,
  UsageMetric,
  WorkspaceUsageCounter,
} from '@project-x/types';
import { Prisma } from '@prisma/client';

import { EntitlementService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { workspaceException } from '../workspaces/workspace.errors';

const METRIC_LIMIT_KEY: Record<Exclude<UsageMetric, 'pr_review'>, keyof ProductEntitlements> = {
  ai_action: 'monthlyAiActions',
  workflow_run: 'monthlyWorkflowRuns',
  multi_repo_analysis: 'monthlyMultiRepoAnalyses',
};

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
  ) {}

  async getUsageCounters(workspaceId: string): Promise<WorkspaceUsageCounter[]> {
    const period = usagePeriodKey();
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const metrics: UsageMetric[] = ['ai_action', 'workflow_run', 'multi_repo_analysis'];

    const rows = await this.prisma.workspaceUsageCounter.findMany({
      where: { workspaceId, periodKey: period, metric: { in: metrics } },
    });
    const byMetric = new Map(rows.map((r) => [r.metric, r.count]));

    return metrics.map((metric) => {
      const limit = limitForMetric(entitlements, metric);
      const count = byMetric.get(metric) ?? 0;
      return {
        workspaceId,
        metric,
        period,
        count,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - count),
      };
    });
  }

  async consume(input: {
    workspaceId: string;
    metric: UsageMetric;
    quantity?: number;
    idempotencyKey?: string;
  }): Promise<UsageConsumeResult> {
    if (input.metric === 'pr_review') {
      throw workspaceException('USAGE_LIMIT_REACHED', 'Unsupported usage metric.');
    }

    const quantity = input.quantity ?? 1;
    if (quantity < 1) {
      throw workspaceException('USAGE_LIMIT_REACHED', 'Quantity must be at least 1.');
    }

    const period = usagePeriodKey();
    const entitlements = await this.entitlements.getEntitlements(input.workspaceId);
    const limit = limitForMetric(entitlements, input.metric);
    const resetAt = usagePeriodResetAt(period);
    const planId = await this.entitlements.getPlanId(input.workspaceId);
    const upgradeAvailable = planId !== 'team';

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        if (input.idempotencyKey) {
          const existing = await tx.workspaceUsageEvent.findUnique({
            where: {
              workspaceId_idempotencyKey: {
                workspaceId: input.workspaceId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (existing) {
            const counter = await tx.workspaceUsageCounter.findUnique({
              where: {
                workspaceId_metric_periodKey: {
                  workspaceId: input.workspaceId,
                  metric: input.metric,
                  periodKey: period,
                },
              },
            });
            const current = counter?.count ?? 0;
            return {
              allowed: true,
              current,
              duplicate: true as const,
            };
          }
        }

        const counter = await tx.workspaceUsageCounter.findUnique({
          where: {
            workspaceId_metric_periodKey: {
              workspaceId: input.workspaceId,
              metric: input.metric,
              periodKey: period,
            },
          },
        });

        const current = counter?.count ?? 0;
        if (limit !== null && current + quantity > limit) {
          return {
            allowed: false,
            current,
            duplicate: false as const,
          };
        }

        const updated = await tx.workspaceUsageCounter.upsert({
          where: {
            workspaceId_metric_periodKey: {
              workspaceId: input.workspaceId,
              metric: input.metric,
              periodKey: period,
            },
          },
          create: {
            workspaceId: input.workspaceId,
            metric: input.metric,
            periodKey: period,
            count: quantity,
          },
          update: {
            count: { increment: quantity },
          },
        });

        if (input.idempotencyKey) {
          await tx.workspaceUsageEvent.create({
            data: {
              workspaceId: input.workspaceId,
              metric: input.metric,
              periodKey: period,
              idempotencyKey: input.idempotencyKey,
              quantity,
            },
          });
        }

        return {
          allowed: true,
          current: updated.count,
          duplicate: false as const,
        };
      });

      if (!result.allowed) {
        throw workspaceException(
          'USAGE_LIMIT_REACHED',
          `You've used all ${limit ?? 0} ${input.metric.replace(/_/g, ' ')}s included in your current plan.`,
          {
            metric: input.metric,
            limit,
            used: result.current,
            resetAt,
            upgradeAvailable,
          },
        );
      }

      return {
        allowed: true,
        metric: input.metric,
        current: result.current,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - result.current),
        resetAt,
        upgradeAvailable,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        input.idempotencyKey
      ) {
        // Concurrent duplicate idempotency key — treat as success without double-count.
        const counters = await this.getUsageCounters(input.workspaceId);
        const row = counters.find((c) => c.metric === input.metric);
        return {
          allowed: true,
          metric: input.metric,
          current: row?.count ?? 0,
          limit,
          remaining: row?.remaining ?? null,
          resetAt,
          upgradeAvailable,
        };
      }
      throw error;
    }
  }
}

function limitForMetric(entitlements: ProductEntitlements, metric: UsageMetric): number | null {
  if (metric === 'pr_review') {
    return null;
  }
  const key = METRIC_LIMIT_KEY[metric];
  const value = entitlements[key];
  return typeof value === 'number' || value === null ? value : null;
}
