/** Day 25 — Workspace tenancy types */

export type WorkspaceStatus = 'active' | 'suspended' | 'deleted';

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type WorkspaceMembershipStatus = 'active' | 'invited' | 'removed';

export type WorkspaceInvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

export type WorkspacePermission =
  | 'workspace:read'
  | 'workspace:update'
  | 'workspace:delete'
  | 'members:read'
  | 'members:invite'
  | 'members:manage'
  | 'billing:read'
  | 'billing:manage'
  | 'integrations:read'
  | 'integrations:manage'
  | 'workflow:execute'
  | 'memory:read'
  | 'memory:manage'
  | 'systems:read'
  | 'systems:manage';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  status: WorkspaceMembershipStatus;
  joinedAt?: string;
  createdAt: string;
  updatedAt: string;
  user?: {
    id: string;
    email: string;
    name: string | null;
  };
}

export interface WorkspaceInvitation {
  id: string;
  workspaceId: string;
  email: string;
  role: Exclude<WorkspaceRole, 'owner'>;
  status: WorkspaceInvitationStatus;
  expiresAt: string;
  invitedByUserId: string;
  acceptedByUserId?: string;
  createdAt: string;
  /** Present only when creating — plaintext token for invite URL. Never stored. */
  token?: string;
}

export interface WorkspaceMemberView {
  membership: WorkspaceMembership;
}

export type ProductPlanId = 'free' | 'pro' | 'team';

export type ProductFeature =
  | 'AI_ACTIONS'
  | 'GITHUB_INTELLIGENCE'
  | 'JIRA_INTELLIGENCE'
  | 'OPENAPI_INTELLIGENCE'
  | 'WORKFLOW_AGENT'
  | 'PROJECT_MEMORY'
  | 'MULTI_REPO_INTELLIGENCE'
  | 'RELIABILITY_HISTORY';

export interface ProductEntitlements {
  aiActions: boolean;
  githubIntelligence: boolean;
  jiraIntelligence: boolean;
  openApiIntelligence: boolean;
  workflowAgent: boolean;
  projectMemory: boolean;
  multiRepoIntelligence: boolean;
  workflowReliability: boolean;
  maxWorkspaceMembers: number;
  maxProjectSystems: number;
  maxRepositoriesPerSystem: number;
  /** null = unlimited */
  monthlyAiActions: number | null;
  monthlyWorkflowRuns: number | null;
  monthlyMultiRepoAnalyses: number | null;
}

export type ProductPlanBilling =
  { type: 'free' } | { type: 'paid'; monthlyPriceRef: string; yearlyPriceRef?: string };

export interface ProductPlan {
  id: ProductPlanId;
  name: string;
  billing: ProductPlanBilling;
  entitlements: ProductEntitlements;
}

export type SubscriptionStatus =
  'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'expired' | 'none';

export type BillingCycle = 'monthly' | 'yearly';

export interface WorkspaceSubscription {
  id: string;
  workspaceId: string;
  provider: 'paddle';
  planId: ProductPlanId;
  status: SubscriptionStatus;
  billingCycle?: BillingCycle;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type UsageMetric = 'ai_action' | 'workflow_run' | 'pr_review' | 'multi_repo_analysis';

export interface WorkspaceUsageCounter {
  workspaceId: string;
  metric: UsageMetric;
  period: string;
  count: number;
  limit: number | null;
  remaining: number | null;
}

export interface UsageConsumeResult {
  allowed: boolean;
  metric: UsageMetric;
  current: number;
  limit: number | null;
  remaining: number | null;
  resetAt: string;
  upgradeAvailable: boolean;
}

export interface CurrentWorkspaceContext {
  workspace: {
    id: string;
    name: string;
    slug: string;
    status: WorkspaceStatus;
  };
  membership: {
    role: WorkspaceRole;
    permissions: WorkspacePermission[];
  };
  plan: {
    id: ProductPlanId;
    name: string;
    status: SubscriptionStatus;
  };
  entitlements: ProductEntitlements;
  usage: WorkspaceUsageCounter[];
  compliance: {
    compliant: boolean;
    violations: Array<{ code: string; message: string }>;
  };
}

export interface WorkspaceBootstrapResponse {
  user: {
    id: string;
    email: string;
    name: string | null;
  };
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    role: WorkspaceRole;
  }>;
  current: CurrentWorkspaceContext;
}

export interface CreateWorkspaceRequest {
  name: string;
  slug?: string;
}

export interface UpdateWorkspaceRequest {
  name?: string;
  slug?: string;
}

export interface InviteWorkspaceMemberRequest {
  email: string;
  role: 'admin' | 'member';
}

export interface ChangeWorkspaceMemberRoleRequest {
  role: 'admin' | 'member';
}

export interface TransferWorkspaceOwnershipRequest {
  membershipId: string;
}

export interface CreateBillingCheckoutRequest {
  planId: Exclude<ProductPlanId, 'free'>;
  billingCycle: BillingCycle;
}

export interface BillingCheckoutResponse {
  checkoutUrl?: string;
  transactionId?: string;
  clientToken?: string;
  planId: ProductPlanId;
  billingCycle: BillingCycle;
}

export interface BillingPortalResponse {
  url: string;
}

export interface WorkspaceBillingView {
  subscription: WorkspaceSubscription;
  plan: ProductPlan;
  entitlements: ProductEntitlements;
  usage: WorkspaceUsageCounter[];
  seats: {
    used: number;
    limit: number;
  };
  paddleClientToken?: string;
  environment?: 'sandbox' | 'production';
}

export type WorkspaceErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_ACCESS_DENIED'
  | 'WORKSPACE_INACTIVE'
  | 'WORKSPACE_LIMIT_REACHED'
  | 'WORKSPACE_MEMBER_NOT_FOUND'
  | 'WORKSPACE_OWNER_REQUIRED'
  | 'WORKSPACE_LAST_OWNER'
  | 'WORKSPACE_INVITATION_INVALID'
  | 'WORKSPACE_INVITATION_EXPIRED'
  | 'WORKSPACE_INVITATION_ALREADY_USED'
  | 'WORKSPACE_MEMBER_LIMIT_REACHED'
  | 'WORKSPACE_RESOURCE_ACCESS_DENIED'
  | 'FEATURE_NOT_AVAILABLE'
  | 'USAGE_LIMIT_REACHED'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'SUBSCRIPTION_REQUIRED'
  | 'SUBSCRIPTION_INACTIVE'
  | 'BILLING_PROVIDER_UNAVAILABLE'
  | 'BILLING_CONFIGURATION_INVALID'
  | 'BILLING_CHECKOUT_FAILED'
  | 'BILLING_SUBSCRIPTION_UPDATE_FAILED'
  | 'BILLING_WEBHOOK_INVALID'
  | 'BILLING_WEBHOOK_DUPLICATE'
  | 'BILLING_RECONCILIATION_REQUIRED'
  | 'UNKNOWN';

export interface WorkspaceErrorBody {
  code: WorkspaceErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type MemoryVisibility = 'workspace' | 'user';
