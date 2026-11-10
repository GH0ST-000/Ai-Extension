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

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active', 'past_due', 'paused']);

/** The plan a workspace is entitled to, given its subscription row (or none). */
export function effectivePlanId(
  subscription: { planId: string; status: string } | null,
): ProductPlanId {
  if (!subscription || !isProductPlanId(subscription.planId)) {
    return 'free';
  }
  if (ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status) || subscription.planId === 'free') {
    return subscription.planId;
  }
  return 'free';
}

@Injectable()
export class EntitlementService {
  private readonly cache = new Map<string, CachedEntitlements>();
  /**
   * Bumped on every invalidate. A read that started before an invalidate must not
   * write its (now stale) result back into the cache afterwards.
   */
  private readonly generation = new Map<string, number>();
  private globalGeneration = 0;

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
    this.generation.set(workspaceId, (this.generation.get(workspaceId) ?? 0) + 1);
    this.cache.delete(workspaceId);
  }

  invalidateAll(): void {
    this.globalGeneration += 1;
    this.cache.clear();
  }

  private generationOf(workspaceId: string): string {
    return `${this.globalGeneration}:${this.generation.get(workspaceId) ?? 0}`;
  }

  private async resolve(workspaceId: string): Promise<CachedEntitlements> {
    const generationAtStart = this.generationOf(workspaceId);
    const subscription = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId },
      select: { planId: true, status: true },
    });

    const planId = effectivePlanId(subscription);
    const entry: CachedEntitlements = {
      planId,
      entitlements: getProductPlan(planId).entitlements,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };
    if (this.generationOf(workspaceId) === generationAtStart) {
      this.cache.set(workspaceId, entry);
    }
    return entry;
  }
}
