import type {
  ProductEntitlements,
  ProductFeature,
  ProductPlan,
  ProductPlanId,
} from '@project-x/types';

/** Bump when entitlement defaults change for audit snapshots. */
export const PRODUCT_PLAN_CATALOG_VERSION = 'day25-v1';

const FREE_ENTITLEMENTS: ProductEntitlements = {
  aiActions: true,
  githubIntelligence: true,
  jiraIntelligence: true,
  openApiIntelligence: true,
  workflowAgent: false,
  projectMemory: false,
  multiRepoIntelligence: false,
  workflowReliability: true,
  maxWorkspaceMembers: 1,
  maxProjectSystems: 1,
  maxRepositoriesPerSystem: 2,
  monthlyAiActions: 50,
  monthlyWorkflowRuns: 10,
  monthlyMultiRepoAnalyses: 0,
};

const PRO_ENTITLEMENTS: ProductEntitlements = {
  aiActions: true,
  githubIntelligence: true,
  jiraIntelligence: true,
  openApiIntelligence: true,
  workflowAgent: true,
  projectMemory: true,
  multiRepoIntelligence: false,
  workflowReliability: true,
  maxWorkspaceMembers: 1,
  maxProjectSystems: 5,
  maxRepositoriesPerSystem: 5,
  monthlyAiActions: 500,
  monthlyWorkflowRuns: 100,
  monthlyMultiRepoAnalyses: 0,
};

const TEAM_ENTITLEMENTS: ProductEntitlements = {
  aiActions: true,
  githubIntelligence: true,
  jiraIntelligence: true,
  openApiIntelligence: true,
  workflowAgent: true,
  projectMemory: true,
  multiRepoIntelligence: true,
  workflowReliability: true,
  maxWorkspaceMembers: 10,
  maxProjectSystems: 20,
  maxRepositoriesPerSystem: 12,
  monthlyAiActions: 2000,
  monthlyWorkflowRuns: 500,
  monthlyMultiRepoAnalyses: 100,
};

/**
 * Canonical product plan catalog. Commercial Paddle price refs are injected at runtime
 * from server config — never trust client price IDs.
 */
export function buildProductPlanCatalog(priceRefs?: {
  proMonthly?: string;
  proYearly?: string;
  teamMonthly?: string;
  teamYearly?: string;
}): ReadonlyArray<ProductPlan> {
  return [
    {
      id: 'free',
      name: 'Free',
      billing: { type: 'free' },
      entitlements: FREE_ENTITLEMENTS,
    },
    {
      id: 'pro',
      name: 'Pro',
      billing: {
        type: 'paid',
        monthlyPriceRef: priceRefs?.proMonthly ?? 'pri_pro_monthly',
        ...(priceRefs?.proYearly ? { yearlyPriceRef: priceRefs.proYearly } : {}),
      },
      entitlements: PRO_ENTITLEMENTS,
    },
    {
      id: 'team',
      name: 'Team',
      billing: {
        type: 'paid',
        monthlyPriceRef: priceRefs?.teamMonthly ?? 'pri_team_monthly',
        ...(priceRefs?.teamYearly ? { yearlyPriceRef: priceRefs.teamYearly } : {}),
      },
      entitlements: TEAM_ENTITLEMENTS,
    },
  ];
}

export const DEFAULT_PRODUCT_PLANS = buildProductPlanCatalog();

export function getProductPlan(planId: ProductPlanId): ProductPlan {
  const plan = DEFAULT_PRODUCT_PLANS.find((p) => p.id === planId);
  if (!plan) {
    return DEFAULT_PRODUCT_PLANS[0]!;
  }
  return plan;
}

export function isProductPlanId(value: string): value is ProductPlanId {
  return value === 'free' || value === 'pro' || value === 'team';
}

const FEATURE_TO_ENTITLEMENT: Record<ProductFeature, keyof ProductEntitlements> = {
  AI_ACTIONS: 'aiActions',
  GITHUB_INTELLIGENCE: 'githubIntelligence',
  JIRA_INTELLIGENCE: 'jiraIntelligence',
  OPENAPI_INTELLIGENCE: 'openApiIntelligence',
  WORKFLOW_AGENT: 'workflowAgent',
  PROJECT_MEMORY: 'projectMemory',
  MULTI_REPO_INTELLIGENCE: 'multiRepoIntelligence',
  RELIABILITY_HISTORY: 'workflowReliability',
};

export function entitlementsAllowFeature(
  entitlements: ProductEntitlements,
  feature: ProductFeature,
): boolean {
  const key = FEATURE_TO_ENTITLEMENT[feature];
  const value = entitlements[key];
  return typeof value === 'boolean' ? value : false;
}

/** Technical safety hard caps — paid plans cannot exceed these. */
export const TECHNICAL_MAX_REPOS_PER_SYSTEM = 25;
export const TECHNICAL_MAX_PROJECT_SYSTEMS = 50;
export const TECHNICAL_MAX_WORKSPACE_MEMBERS = 50;

export function effectiveMaxRepositoriesPerSystem(planLimit: number): number {
  return Math.min(planLimit, TECHNICAL_MAX_REPOS_PER_SYSTEM);
}

export function effectiveMaxProjectSystems(planLimit: number): number {
  return Math.min(planLimit, TECHNICAL_MAX_PROJECT_SYSTEMS);
}

export function effectiveMaxWorkspaceMembers(planLimit: number): number {
  return Math.min(planLimit, TECHNICAL_MAX_WORKSPACE_MEMBERS);
}
