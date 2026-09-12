import type { ExecutionFailureCategory, RetryDecision, RetryStageKind } from '@project-x/types';

import { RELIABILITY_MAX_RETRY_ATTEMPTS } from './budgets';

const WRITE_STAGES: ReadonlySet<RetryStageKind> = new Set([
  'GITHUB_WRITE',
  'PATCH_APPLY',
  'REVIEW_SUBMIT',
]);

/**
 * Retry only retryable read/AI stages. Never auto-retry confirmed GitHub writes
 * without explicit idempotency + user confirmation.
 */
export function decideRetry(input: {
  stage: RetryStageKind;
  category: ExecutionFailureCategory;
  attempt: number;
  writeConfirmed?: boolean;
  idempotentSafe?: boolean;
}): RetryDecision {
  const attempt = Math.max(0, input.attempt);

  if (attempt >= RELIABILITY_MAX_RETRY_ATTEMPTS) {
    return {
      allowed: false,
      reason: 'Max retry attempts reached.',
      requiresConfirmation: false,
    };
  }

  if (WRITE_STAGES.has(input.stage)) {
    if (input.writeConfirmed && !input.idempotentSafe) {
      return {
        allowed: false,
        reason:
          'GitHub writes are not auto-retried after confirmation without idempotency guarantees.',
        requiresConfirmation: true,
      };
    }
    return {
      allowed: false,
      reason: 'Write stages require explicit user confirmation before retry.',
      requiresConfirmation: true,
    };
  }

  const retryableCategories: ReadonlySet<ExecutionFailureCategory> = new Set([
    'NETWORK',
    'TIMEOUT',
    'RATE_LIMIT',
    'AI_PROVIDER',
    'GITHUB',
    'JIRA',
    'OPENAPI',
  ]);

  if (!retryableCategories.has(input.category)) {
    return {
      allowed: false,
      reason: `Failure category ${input.category} is not retryable.`,
      requiresConfirmation: false,
    };
  }

  return {
    allowed: true,
    reason: `Retry ${input.stage} (attempt ${attempt + 1}/${RELIABILITY_MAX_RETRY_ATTEMPTS}).`,
    requiresConfirmation: false,
  };
}
