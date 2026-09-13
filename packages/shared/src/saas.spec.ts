import { describe, expect, it } from 'vitest';
import type { ProductFeature, ProductPlanId, UsageMetric } from '@project-x/types';
import {
  DEFAULT_PRODUCT_PLANS,
  entitlementsAllowFeature,
  getProductPlan,
  isProductPlanId,
  permissionsForRole,
  roleHasPermission,
  usagePeriodKey,
  usagePeriodResetAt,
} from './index';

describe('workspace permissions', () => {
  it('gives owner billing:manage and member not', () => {
    expect(roleHasPermission('owner', 'billing:manage')).toBe(true);
    expect(roleHasPermission('admin', 'billing:manage')).toBe(false);
    expect(roleHasPermission('member', 'members:invite')).toBe(false);
    expect(permissionsForRole('member')).toContain('workflow:execute');
  });
});

describe('product plans', () => {
  it('exposes free/pro/team with free as default fallback', () => {
    expect(DEFAULT_PRODUCT_PLANS.map((p) => p.id)).toEqual(['free', 'pro', 'team']);
    expect(getProductPlan('pro').entitlements.workflowAgent).toBe(true);
    expect(getProductPlan('free').entitlements.multiRepoIntelligence).toBe(false);
    expect(isProductPlanId('team')).toBe(true);
    expect(isProductPlanId('enterprise' as ProductPlanId)).toBe(false);
  });

  it('gates features from entitlements', () => {
    const free = getProductPlan('free').entitlements;
    const team = getProductPlan('team').entitlements;
    const feature: ProductFeature = 'MULTI_REPO_INTELLIGENCE';
    expect(entitlementsAllowFeature(free, feature)).toBe(false);
    expect(entitlementsAllowFeature(team, feature)).toBe(true);
  });
});

describe('usage period', () => {
  it('uses UTC YYYY-MM keys', () => {
    const key = usagePeriodKey(new Date(Date.UTC(2026, 8, 13)));
    expect(key).toBe('2026-09');
    expect(usagePeriodResetAt(key)).toBe(new Date(Date.UTC(2026, 9, 1)).toISOString());
    const metric: UsageMetric = 'workflow_run';
    expect(metric).toBe('workflow_run');
  });
});
