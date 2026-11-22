/**
 * Day 26 — Production observability types.
 *
 * Classification reminder for telemetry fields:
 * - SAFE_OPERATIONAL: bounded labels/status codes/durations
 * - INTERNAL_IDENTIFIER: requestId/traceId/executionId (logs/errors only — never metric labels)
 * - SENSITIVE: emails, tokens, secrets — redact or omit
 * - FORBIDDEN: prompts, source, diffs, selected text, page URLs, provider payloads
 */

export type ObservabilityProviderName =
  'openai' | 'github' | 'jira' | 'paddle' | 'openapi' | 'redis' | 'postgres';

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export type ObservabilityLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TelemetryFieldClass =
  'SAFE_OPERATIONAL' | 'INTERNAL_IDENTIFIER' | 'SENSITIVE' | 'FORBIDDEN';

export interface ObservabilityRepositoryRef {
  provider: 'github';
  repositoryId?: string;
  owner?: string;
  name?: string;
}

/**
 * Safe correlation context for logs/errors/metrics/spans.
 * Never attach prompts, source, tokens, or raw provider payloads.
 */
export interface ObservabilityContext {
  requestId?: string;
  traceId?: string;
  spanId?: string;

  workspaceId?: string;
  /** Hashed user reference — prefer over raw user id in external telemetry. */
  userIdHash?: string;

  workflowId?: string;
  executionId?: string;
  stepId?: string;

  capability?: string;

  repository?: ObservabilityRepositoryRef;
  pullRequestNumber?: number;

  provider?: ObservabilityProviderName;

  release?: string;
  environment?: string;

  plan?: 'free' | 'pro' | 'team';
  service?: string;
  errorCode?: string;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  /** True when values came from the provider SDK rather than estimation. */
  providerReported: boolean;
}

export type AICostEstimateSource = 'provider_usage' | 'estimated_usage' | 'unavailable';

export interface AICostEstimate {
  inputCostUsd?: number;
  outputCostUsd?: number;
  totalCostUsd?: number;
  pricingVersion?: string;
  source: AICostEstimateSource;
}

export interface ModelPricing {
  provider: string;
  model: string;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
  effectiveFrom?: string;
  pricingVersion: string;
}

export type ClientTelemetryClient = 'extension' | 'dashboard';

export type ClientTelemetryIntegration = 'github' | 'jira' | 'swagger' | 'generic';

/**
 * Allowlisted client telemetry events — no browsing analytics.
 */
export type ClientTelemetryEvent =
  | 'page_crash'
  | 'api_error'
  | 'hydration_failure'
  | 'render_failure'
  | 'content_script_init_failed'
  | 'shadow_root_mount_failed'
  | 'selection_listener_failed'
  | 'api_request_failed'
  | 'stream_parse_failed'
  | 'stream_failure'
  | 'github_context_extract_failed'
  | 'jira_context_extract_failed'
  | 'swagger_context_extract_failed'
  | 'floating_action.render.failed'
  | 'background_failure'
  | 'unhandled_error';

export interface ClientErrorTelemetryInput {
  client: ClientTelemetryClient;
  component: string;
  event: ClientTelemetryEvent;
  release?: string;
  integration?: ClientTelemetryIntegration;
  errorCode?: string;
  normalizedMessage?: string;
  requestId?: string;
  executionId?: string;
  /** Truncated + redacted stack fingerprint only. */
  stack?: string;
}

export interface ClientErrorTelemetryResponse {
  accepted: boolean;
  referenceId?: string;
}

export interface DependencyHealthMap {
  postgres: ProviderHealthStatus;
  redis: ProviderHealthStatus;
  github: ProviderHealthStatus;
  ai: ProviderHealthStatus;
  jira: ProviderHealthStatus;
  paddle: ProviderHealthStatus;
}

export interface DependencyHealthResponse {
  status: ProviderHealthStatus;
  dependencies: DependencyHealthMap;
  release?: string;
  environment?: string;
  timestamp: string;
}

export interface ObservabilityBuildInfo {
  service: string;
  version: string;
  release: string;
  environment: string;
  nodeVersion?: string;
}

export interface InternalObservabilityHealthResponse {
  status: ProviderHealthStatus;
  build: ObservabilityBuildInfo;
  dependencies: DependencyHealthMap;
  timestamp: string;
}

/** Security audit events exportable via internal observability API (SIEM hook). */
export type SecurityAuditEventType =
  | 'auth.login.success'
  | 'auth.login.failure'
  | 'auth.register'
  | 'auth.logout'
  | 'auth.refresh.reuse_detected'
  | 'auth.session.invalidated'
  | 'auth.password_reset.requested'
  | 'auth.password_reset.completed'
  /** Decision A: email ownership verified. */
  | 'auth.email.verified'
  /** F-05: a verification link was presented by a session of a different account. */
  | 'auth.email.verification_wrong_account'
  /** Decision 1: free AI refused for an unverified actor / workspace owner (abuse signal). */
  | 'ai.free_quota.verification_required'
  /** Decision 1: a free workspace exhausted its monthly AI quota (multi-account monitoring). */
  | 'ai.free_quota.exhausted'
  /** H1: GitHub writes made for a Project X user (also through the workspace App). */
  | 'github.write.comment'
  | 'github.write.review'
  | 'github.write.patch'
  | 'github.write.denied'
  /** M3: workspace membership and invitation lifecycle. */
  | 'workspace.invitation.created'
  | 'workspace.invitation.accepted'
  | 'workspace.invitation.revoked'
  | 'workspace.member.removed'
  | 'workspace.member.role_changed'
  | 'workspace.ownership.transferred'
  | 'workspace.membership.denied'
  /** M4: Systems configuration changes and refused Systems operations. */
  | 'systems.system.created'
  | 'systems.system.updated'
  | 'systems.system.deleted'
  | 'systems.repository.added'
  | 'systems.repository.updated'
  | 'systems.repository.removed'
  | 'systems.access.denied'
  /** N-3: a required billing cancellation failed and is scheduled for retry. */
  | 'billing.cancellation.failed'
  /** F-02: a subscription webhook named a workspace without a checkout of that workspace. */
  | 'billing.subscription.unbound'
  /** F-23: a second billable subscription appeared while another is still billable. */
  | 'billing.subscription.conflict'
  /** N-2: workspace deletion lifecycle. */
  | 'workspace.deletion.started'
  | 'workspace.deletion.completed';

export type SecurityAuditOutcome = 'success' | 'failure' | 'blocked';

export interface SecurityAuditEvent {
  id: string;
  type: SecurityAuditEventType;
  timestamp: string;
  service: string;
  release: string;
  environment: string;
  outcome: SecurityAuditOutcome;
  requestId?: string;
  workspaceId?: string;
  /** HMAC-derived user reference — not reversible to raw user id in export consumers. */
  actorUserIdHash?: string;
  /** Hash of email domain only (failures) — no full email. */
  emailDomainHash?: string;
  /** Truncated operational context when already collected for auth (max 64 chars). */
  ipTruncated?: string;
  /** Safe operational detail — never tokens or passwords. */
  detail?: string;
}

export type ObservabilityErrorCode =
  | 'AI_PROVIDER_UNAVAILABLE'
  | 'AI_RATE_LIMITED'
  | 'AI_TIMEOUT'
  | 'AI_ABORTED'
  | 'GITHUB_UNAVAILABLE'
  | 'GITHUB_RATE_LIMITED'
  | 'JIRA_UNAVAILABLE'
  | 'JIRA_RATE_LIMITED'
  | 'OPENAPI_FETCH_FAILED'
  | 'PADDLE_UNAVAILABLE'
  | 'DB_UNAVAILABLE'
  | 'REDIS_UNAVAILABLE'
  | 'WORKFLOW_STEP_FAILED'
  | 'WRITE_OUTCOME_UNKNOWN'
  | 'CLIENT_TELEMETRY_REJECTED'
  | 'INTERNAL_ERROR'
  | 'UNKNOWN';
