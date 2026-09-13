import type { WorkspaceErrorCode } from '@project-x/types';

export const ENTITLEMENT_FAILURE_CODES = [
  'FEATURE_NOT_AVAILABLE',
  'USAGE_LIMIT_REACHED',
] as const satisfies readonly WorkspaceErrorCode[];

export type EntitlementFailureCode = (typeof ENTITLEMENT_FAILURE_CODES)[number];

export function isEntitlementFailureCode(
  code: string | null | undefined,
): code is EntitlementFailureCode {
  return code === 'FEATURE_NOT_AVAILABLE' || code === 'USAGE_LIMIT_REACHED';
}

export function entitlementFailureMessage(code: EntitlementFailureCode, fallback?: string): string {
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }
  if (code === 'USAGE_LIMIT_REACHED') {
    return 'Usage limit reached for this workspace plan.';
  }
  return 'This feature is not available on the current plan.';
}
