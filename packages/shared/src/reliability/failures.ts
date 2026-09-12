import type {
  ExecutionFailureCategory,
  NormalizedExecutionFailure,
  WorkflowErrorCode,
} from '@project-x/types';

import { RELIABILITY_MAX_FAILURE_MESSAGE_CHARS } from './budgets';
import { redactForReliability, truncateSafeText } from './redaction';

const RETRYABLE_CATEGORIES: ReadonlySet<ExecutionFailureCategory> = new Set([
  'NETWORK',
  'AI_PROVIDER',
  'TIMEOUT',
  'RATE_LIMIT',
  'GITHUB',
  'JIRA',
  'OPENAPI',
]);

export function classifyFailure(input: {
  code?: string | null;
  message?: string | null;
  httpStatus?: number | null;
  stage?: string | null;
}): NormalizedExecutionFailure {
  const code = (input.code ?? '').toUpperCase();
  const message = truncateSafeText(
    redactForReliability(input.message ?? 'Unexpected failure'),
    RELIABILITY_MAX_FAILURE_MESSAGE_CHARS,
  );
  const lower = message.toLowerCase();

  let category: ExecutionFailureCategory = 'UNKNOWN';
  let technicalReason = code || 'UNKNOWN';

  if (
    code.includes('TIMEOUT') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    input.httpStatus === 408
  ) {
    category = 'TIMEOUT';
    technicalReason = 'timeout';
  } else if (code.includes('RATE') || lower.includes('rate limit') || input.httpStatus === 429) {
    category = 'RATE_LIMIT';
    technicalReason = 'rate_limit';
  } else if (
    code.includes('STALE') ||
    lower.includes('stale') ||
    lower.includes('binding changed')
  ) {
    category = 'STALE_CONTEXT';
    technicalReason = 'stale_context';
  } else if (
    code.includes('VALIDATION') ||
    code.includes('INVALID') ||
    lower.includes('validation') ||
    input.httpStatus === 400
  ) {
    category = 'VALIDATION';
    technicalReason = 'validation';
  } else if (code.includes('GITHUB') || lower.includes('github')) {
    category = 'GITHUB';
    technicalReason = 'github';
  } else if (code.includes('JIRA') || lower.includes('jira')) {
    category = 'JIRA';
    technicalReason = 'jira';
  } else if (code.includes('OPENAPI') || lower.includes('openapi')) {
    category = 'OPENAPI';
    technicalReason = 'openapi';
  } else if (
    code.includes('AI') ||
    code.includes('PROVIDER') ||
    lower.includes('openai') ||
    lower.includes('anthropic') ||
    lower.includes('model')
  ) {
    category = 'AI_PROVIDER';
    technicalReason = 'ai_provider';
  } else if (
    code.includes('NETWORK') ||
    lower.includes('network') ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound')
  ) {
    category = 'NETWORK';
    technicalReason = 'network';
  }

  const retryable = RETRYABLE_CATEGORIES.has(category) && category !== 'STALE_CONTEXT';

  return {
    category,
    retryable,
    userMessage: userFacingMessage(category, message),
    technicalReason,
    ...(input.stage ? { stage: input.stage } : {}),
    ...(code ? { code: code as WorkflowErrorCode | string } : {}),
  };
}

function userFacingMessage(category: ExecutionFailureCategory, technical: string): string {
  switch (category) {
    case 'NETWORK':
      return 'A network error interrupted this step. You can retry.';
    case 'TIMEOUT':
      return 'This step timed out. You can retry.';
    case 'RATE_LIMIT':
      return 'A provider rate limit was hit. Wait a moment, then retry.';
    case 'AI_PROVIDER':
      return 'The AI provider failed. You can retry this stage.';
    case 'GITHUB':
      return 'A GitHub request failed. Retry reads; writes still need confirmation.';
    case 'JIRA':
      return 'A Jira request failed. You can retry.';
    case 'OPENAPI':
      return 'OpenAPI loading failed. You can retry.';
    case 'STALE_CONTEXT':
      return 'Context went stale. Resume after refreshing context.';
    case 'VALIDATION':
      return 'Validation failed. Fix inputs before retrying.';
    case 'UNKNOWN':
    default:
      return technical.slice(0, 200) || 'Something went wrong.';
  }
}

export function isRetryableFailure(
  failure: Pick<NormalizedExecutionFailure, 'retryable' | 'category'>,
): boolean {
  return failure.retryable === true && failure.category !== 'STALE_CONTEXT';
}
