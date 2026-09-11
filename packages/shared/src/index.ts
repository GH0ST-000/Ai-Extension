export { findJiraIssueKeysInText, detectJiraKeysInPrSignals } from './jira/jira-key-match';
export {
  validateOpenApiFetchUrl,
  sanitizeOpenApiDocumentUrl,
  isPrivateOrReservedIp,
  isIPv4,
  isIPv6,
} from './openapi/safe-url';
export type { SafeUrlResult, SafeUrlRejectReason } from './openapi/safe-url';
export { findOperation, buildOperationAiContext } from './openapi/operation-context';
export { generateApiExample } from './openapi/example';
export { isOpenApiSpecPath, filterOpenApiSpecPaths } from './openapi/spec-path';

export { normalizeRepositoryPath } from './ci-fix/normalize-path';
export {
  extractPathsFromText,
  resolveCIFixTargets,
  selectPrimaryCIFixTarget,
} from './ci-fix/resolve-targets';
export type { ResolveCIFixTargetsInput } from './ci-fix/resolve-targets';
export { buildCIFailureSignature, compareFailureSignatures } from './ci-fix/failure-signature';
export {
  matchCheckOnNewHead,
  verifyCIFixAgainstSummary,
  verificationToSessionStatus,
} from './ci-fix/verify-fix';
export type { VerifyCIFixInput } from './ci-fix/verify-fix';

export const APP_NAME = 'Project X' as const;

export const SERVICE_NAMES = {
  api: 'api',
  dashboard: 'dashboard',
  extension: 'extension',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
