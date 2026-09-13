import { Injectable } from '@nestjs/common';
import { entitlementsAllowFeature, getProductPlan, isProductPlanId } from '@project-x/shared';
import type { ProductEntitlements, ProductFeature, ProductPlanId } from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import { workspaceException } from '../workspaces/workspace.errors';

type CachedEntitlements = {
  planId: ProductPlanId;
  entitlements: ProductEntitlements;
  expiresAt: number;
};

const CACHE_TTL_MS = 30_000;

@Injectable()
export class EntitlementService {
  private readonly cache = new Map<string, CachedEntitlements>();

  constructor(private readonly prisma: PrismaService) {}

  async getPlanId(workspaceId: string): Promise<ProductPlanId> {
    const cached = this.cache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.planId;
    }
    const resolved = await this.resolve(workspaceId);
    return resolved.planId;
  }

  async getEntitlements(workspaceId: string): Promise<ProductEntitlements> {
    const cached = this.cache.get(workspaceId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.entitlements;
    }
    const resolved = await this.resolve(workspaceId);
    return resolved.entitlements;
  }

  async assertFeature(workspaceId: string, feature: ProductFeature): Promise<void> {
    const entitlements = await this.getEntitlements(workspaceId);
    if (!entitlementsAllowFeature(entitlements, feature)) {
      throw workspaceException(
        'FEATURE_NOT_AVAILABLE',
        `Feature ${feature} is not available on the current plan.`,
        { feature },
      );
    }
  }

  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  invalidateAll(): void {
    this.cache.clear();
  }

  private async resolve(workspaceId: string): Promise<CachedEntitlements> {
    const subscription = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { planId: true, status: true },
    });

    let planId: ProductPlanId = 'free';
    if (subscription && isProductPlanId(subscription.planId)) {
      const activeStatuses = new Set(['trialing', 'active', 'past_due', 'paused']);
      if (activeStatuses.has(subscription.status) || subscription.planId === 'free') {
        planId = subscription.planId;
      }
    }

    const entitlements = getProductPlan(planId).entitlements;
    const entry: CachedEntitlements = {
      planId,
      entitlements,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    this.cache.set(workspaceId, entry);
    return entry;
  }
}
