/**
 * Day 26 — bounded provider operation names for metrics labels.
 * Never use raw URLs as labels.
 */

export const GITHUB_OPERATIONS = [
  'get_pr',
  'get_pr_files',
  'create_comment',
  'submit_review',
  'get_checks',
  'get_check_run',
  'get_file',
  'update_ref',
  'apply_patch',
  'get_annotations',
  'get_actions_logs',
  'other',
] as const;

export type GithubOperation = (typeof GITHUB_OPERATIONS)[number];

export const JIRA_OPERATIONS = [
  'issue_fetch',
  'site_fetch',
  'validate_credentials',
  'other',
] as const;
export type JiraOperation = (typeof JIRA_OPERATIONS)[number];

export const PADDLE_OPERATIONS = [
  'create_checkout',
  'get_subscription',
  'cancel_subscription',
  'portal',
  'webhook_process',
  'other',
] as const;
export type PaddleOperation = (typeof PADDLE_OPERATIONS)[number];

export const OPENAPI_OPERATIONS = [
  'public_document_fetch',
  'parse',
  'resolve_refs',
  'other',
] as const;
export type OpenApiOperation = (typeof OPENAPI_OPERATIONS)[number];

export const REDIS_OPERATION_GROUPS = [
  'cache',
  'idempotency',
  'workflow',
  'rate_limit',
  'other',
] as const;
export type RedisOperationGroup = (typeof REDIS_OPERATION_GROUPS)[number];

export const DB_OPERATION_GROUPS = [
  'workspace.lookup',
  'workflow.persist',
  'memory.load',
  'usage.consume',
  'billing.apply',
  'other',
] as const;
export type DbOperationGroup = (typeof DB_OPERATION_GROUPS)[number];

function allowlist<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function normalizeGithubOperation(operation: string): GithubOperation {
  return allowlist(operation, GITHUB_OPERATIONS, 'other');
}

export function normalizeJiraOperation(operation: string): JiraOperation {
  return allowlist(operation, JIRA_OPERATIONS, 'other');
}

export function normalizePaddleOperation(operation: string): PaddleOperation {
  return allowlist(operation, PADDLE_OPERATIONS, 'other');
}

export function normalizeOpenApiOperation(operation: string): OpenApiOperation {
  return allowlist(operation, OPENAPI_OPERATIONS, 'other');
}

/** HTTP status class for metrics — never free-form messages. */
export function httpStatusClass(status: number): '2xx' | '3xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 300 && status < 400) return '3xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

/**
 * Normalize Express/Nest paths to route templates.
 * Strips high-cardinality IDs from metric labels.
 */
export function normalizeRouteTemplate(path: string): string {
  if (!path || path === '/') return path || '/';

  const withoutQuery = path.split('?')[0] ?? path;
  const segments = withoutQuery.split('/').map((segment) => {
    if (!segment) return segment;
    // UUIDs
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
      return ':id';
    }
    // Opaque prefixed ids (wex_, req_, ws_, etc.)
    if (/^[a-z]{2,8}_[a-zA-Z0-9]+$/i.test(segment)) {
      return ':id';
    }
    // Long hex / numeric ids
    if (/^[0-9a-f]{16,}$/i.test(segment) || /^\d{3,}$/.test(segment)) {
      return ':id';
    }
    // Invite tokens / long opaque strings
    if (segment.length > 40 && /^[a-zA-Z0-9_-]+$/.test(segment)) {
      return ':token';
    }
    return segment;
  });

  const joined = segments.join('/');
  return joined.length > 0 ? joined : '/';
}

export const CLIENT_TELEMETRY_EVENTS = [
  'page_crash',
  'api_error',
  'hydration_failure',
  'render_failure',
  'content_script_init_failed',
  'shadow_root_mount_failed',
  'selection_listener_failed',
  'api_request_failed',
  'stream_parse_failed',
  'stream_failure',
  'github_context_extract_failed',
  'jira_context_extract_failed',
  'swagger_context_extract_failed',
  'floating_action.render.failed',
  'background_failure',
  'unhandled_error',
] as const;

export function isClientTelemetryEvent(value: string): boolean {
  return (CLIENT_TELEMETRY_EVENTS as readonly string[]).includes(value);
}

/** Safe component name: bounded alphanumeric path segments. */
export function isSafeTelemetryComponent(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value);
}
