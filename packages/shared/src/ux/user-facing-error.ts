import type { UserFacingError, UserFacingErrorActionKind } from '@project-x/types';

type MapErrorInput = {
  code?: string | null;
  message?: string | null;
  referenceId?: string | null;
  unauthorized?: boolean;
  offline?: boolean;
  aborted?: boolean;
};

function error(
  partial: Omit<UserFacingError, 'detailsAvailable'> & { detailsAvailable?: boolean },
): UserFacingError {
  return {
    detailsAvailable: Boolean(partial.code || partial.referenceId),
    ...partial,
  };
}

function action(
  label: string,
  kind: UserFacingErrorActionKind,
): NonNullable<UserFacingError['primaryAction']> {
  return { label, kind };
}

/**
 * Deterministic product-facing error mapper.
 * Never renders raw provider payloads as the primary message.
 */
export function mapToUserFacingError(input: MapErrorInput): UserFacingError {
  if (input.offline) {
    return error({
      title: "You're offline",
      message: 'Reconnect to continue.',
      severity: 'warning',
      primaryAction: action('Retry', 'retry'),
    });
  }

  if (input.aborted) {
    return error({
      title: 'Analysis stopped',
      message: 'Completed results are still available.',
      severity: 'info',
      primaryAction: action('Close', 'none'),
    });
  }

  if (input.unauthorized) {
    return error({
      title: 'Sign in to continue',
      message: 'Your session expired or you are signed out. Sign in again, then retry the action.',
      severity: 'warning',
      code: 'UNAUTHORIZED',
      referenceId: input.referenceId ?? undefined,
      primaryAction: action('Sign in', 'sign_in'),
      secondaryAction: action('Retry', 'retry'),
    });
  }

  const code = input.code?.trim() || null;
  const referenceId = input.referenceId ?? undefined;

  switch (code) {
    case 'NOT_CONNECTED':
      return error({
        title: 'Connect GitHub',
        message:
          'Connect GitHub to review pull requests, analyze CI, and post comments after you confirm them.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Connect GitHub', 'reconnect_github'),
      });

    case 'REPOSITORY_NOT_ACCESSIBLE':
      return error({
        title: "Project X doesn't have access to this repository",
        message: 'Grant repository access for the token connected in Settings, then try again.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Grant repository access', 'grant_repo_access'),
        secondaryAction: action('Open settings', 'open_settings'),
      });

    case 'INSUFFICIENT_PERMISSION':
      return error({
        title: 'GitHub permission missing',
        message:
          'This action needs additional repository permission. Update the token scopes or grant access, then retry.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Open settings', 'open_settings'),
        secondaryAction: action('Retry', 'retry'),
      });

    case 'PULL_REQUEST_NOT_FOUND':
      return error({
        title: 'Pull request not found',
        message: 'This pull request may have been deleted, or Project X cannot access it.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Open GitHub', 'open_github'),
      });

    case 'RATE_LIMITED':
    case 'GITHUB_RATE_LIMITED':
    case 'AI_RATE_LIMITED':
      return error({
        title:
          code === 'AI_RATE_LIMITED'
            ? 'AI service is temporarily busy'
            : 'GitHub is rate limiting requests',
        message: 'Try again shortly.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Retry', 'retry'),
      });

    case 'GITHUB_UNAVAILABLE':
    case 'JIRA_UNAVAILABLE':
    case 'AI_PROVIDER_UNAVAILABLE':
    case 'PADDLE_UNAVAILABLE':
      return error({
        title: 'Service temporarily unavailable',
        message: 'Try again in a moment.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Retry', 'retry'),
      });

    case 'AI_TIMEOUT':
      return error({
        title: 'This took too long',
        message: 'The analysis timed out. Retry when ready.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Retry', 'retry'),
      });

    case 'WRITE_OUTCOME_UNKNOWN':
      return error({
        title: "We couldn't confirm whether GitHub completed this action",
        message: 'Check GitHub before trying again to avoid creating a duplicate.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Open GitHub', 'open_github'),
        secondaryAction: action("I've checked — try again", 'retry'),
      });

    case 'PR_HEAD_CHANGED':
    case 'FILE_CHANGED':
    case 'STALE_DIFF_POSITION':
    case 'STALE_CI_CONTEXT':
    case 'FIX_SESSION_STALE':
    case 'VERIFICATION_CONTEXT_STALE':
      return error({
        title: 'This result is based on an older version',
        message: 'Refresh the analysis before continuing.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Refresh', 'refresh'),
      });

    case 'PATCH_CONFLICT':
    case 'PATCH_INVALID':
    case 'BRANCH_NOT_WRITABLE':
    case 'BRANCH_PROTECTED':
      return error({
        title: 'This fix cannot be applied as prepared',
        message:
          code === 'BRANCH_PROTECTED' || code === 'BRANCH_NOT_WRITABLE'
            ? 'The branch is not writable with the current GitHub connection.'
            : 'The patch no longer applies cleanly. Refresh and generate a new patch.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Refresh', 'refresh'),
      });

    case 'FEATURE_NOT_AVAILABLE':
      return error({
        title: 'Available on a higher plan',
        message: 'Upgrade to unlock this capability for the current workspace.',
        severity: 'info',
        code,
        referenceId,
        primaryAction: action('View plans', 'view_plans'),
      });

    case 'USAGE_LIMIT_REACHED':
    case 'PLAN_LIMIT_EXCEEDED':
    case 'WORKFLOW_BUDGET_EXCEEDED':
    case 'AGENT_BUDGET_EXCEEDED':
      return error({
        title: 'Monthly usage limit reached',
        message: 'This workspace has reached its product usage limit for the current period.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('View plans', 'view_plans'),
      });

    case 'WORKSPACE_ACCESS_DENIED':
    case 'WORKSPACE_RESOURCE_ACCESS_DENIED':
    case 'WORKSPACE_OWNER_REQUIRED':
      return error({
        title: "You don't have permission",
        message:
          code === 'WORKSPACE_OWNER_REQUIRED'
            ? 'Ask a workspace owner to help with this action.'
            : 'Switch workspace or ask an owner for access.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Switch workspace', 'switch_workspace'),
      });

    case 'WORKSPACE_LAST_OWNER':
      return error({
        title: 'You are the last owner',
        message: 'Transfer ownership or delete the workspace before leaving.',
        severity: 'warning',
        code,
        referenceId,
      });

    case 'IDEMPOTENCY_CONFLICT':
      return error({
        title: 'This action may already be in progress',
        message: 'Check GitHub before submitting again.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Open GitHub', 'open_github'),
      });

    case 'CHECKS_NOT_ACCESSIBLE':
    case 'CHECK_NOT_FOUND':
    case 'CHECK_DETAILS_UNAVAILABLE':
    case 'CI_LOGS_UNAVAILABLE':
    case 'NEW_CI_NOT_AVAILABLE':
      return error({
        title: 'CI data is unavailable',
        message: 'Open GitHub to inspect the check, or retry after CI updates.',
        severity: 'warning',
        code,
        referenceId,
        primaryAction: action('Open GitHub', 'open_github'),
        secondaryAction: action('Retry', 'retry'),
      });

    default:
      break;
  }

  const fallbackMessage =
    typeof input.message === 'string' && input.message.trim().length > 0
      ? input.message.trim()
      : "We couldn't complete this action. Try again.";

  // Prefer product-safe fallback when message looks like internal/provider leakage.
  const looksInternal =
    /stack|exception|ECONN|ENOTFOUND|prisma|openai|anthropic|reservation|budget reservation/i.test(
      fallbackMessage,
    );

  return error({
    title: "We couldn't complete this action",
    message: looksInternal
      ? 'Try again. If the problem continues, use the reference when contacting support.'
      : fallbackMessage,
    severity: 'error',
    code: code ?? undefined,
    referenceId,
    primaryAction: action('Retry', 'retry'),
    secondaryAction: referenceId ? action('Copy reference', 'copy_reference') : undefined,
  });
}

export function workflowStatusLabel(status: string): string {
  switch (status) {
    case 'RUNNING':
    case 'IN_PROGRESS':
      return 'In progress';
    case 'USER_DECISION_REQUIRED':
    case 'AWAITING_USER':
      return 'Waiting for you';
    case 'STALE':
      return 'Needs refresh';
    case 'BLOCKED':
      return 'Blocked';
    case 'COMPLETED':
    case 'SUCCEEDED':
      return 'Completed';
    case 'FAILED':
      return 'Could not finish';
    case 'CANCELLED':
    case 'CANCELED':
      return 'Stopped';
    case 'PAUSED':
      return 'Paused';
    default:
      return status
        .toLowerCase()
        .split('_')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}
