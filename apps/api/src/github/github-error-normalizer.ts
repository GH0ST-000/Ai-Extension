import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { GitHubWriteErrorBody, GitHubWriteErrorCode } from '@project-x/types';

@Injectable()
export class GithubErrorNormalizer {
  toHttpException(code: GitHubWriteErrorCode, message: string, status?: number): HttpException {
    const resolvedStatus = status ?? this.defaultStatus(code);
    const body: GitHubWriteErrorBody & { statusCode: number } = {
      code,
      message,
      statusCode: resolvedStatus,
    };
    return new HttpException(body, resolvedStatus);
  }

  private defaultStatus(code: GitHubWriteErrorCode): number {
    switch (code) {
      case 'NOT_CONNECTED':
      case 'INSUFFICIENT_PERMISSION':
      case 'REVIEW_ACTION_NOT_ALLOWED':
      case 'BRANCH_NOT_WRITABLE':
      case 'BRANCH_PROTECTED':
      case 'CHECKS_NOT_ACCESSIBLE':
        return HttpStatus.FORBIDDEN;
      case 'REPOSITORY_NOT_ACCESSIBLE':
      case 'PULL_REQUEST_NOT_FOUND':
      case 'REVIEW_VALIDATION_FAILED':
      case 'STALE_DIFF_POSITION':
      case 'PR_HEAD_CHANGED':
      case 'FILE_CHANGED':
      case 'PATCH_INVALID':
      case 'PATCH_CONFLICT':
      case 'PATCH_UNSUPPORTED':
      case 'COMMIT_VALIDATION_FAILED':
      case 'CHECK_NOT_FOUND':
      case 'CHECK_DETAILS_UNAVAILABLE':
      case 'CI_LOGS_UNAVAILABLE':
      case 'CI_EVIDENCE_TOO_LARGE':
      case 'STALE_CI_CONTEXT':
      case 'AI_ANALYSIS_FAILED':
      case 'FIX_SESSION_STALE':
      case 'FIX_TARGET_NOT_FOUND':
      case 'FIX_TARGET_AMBIGUOUS':
      case 'FIX_TARGET_INVALID':
      case 'FIX_CONTEXT_INSUFFICIENT':
      case 'NEW_CI_NOT_AVAILABLE':
      case 'VERIFICATION_CHECK_NOT_FOUND':
      case 'VERIFICATION_CONTEXT_STALE':
        return HttpStatus.BAD_REQUEST;
      case 'IDEMPOTENCY_CONFLICT':
        return HttpStatus.CONFLICT;
      case 'RATE_LIMITED':
        return HttpStatus.TOO_MANY_REQUESTS;
      case 'GITHUB_UNAVAILABLE':
      case 'WRITE_OUTCOME_UNKNOWN':
        return HttpStatus.SERVICE_UNAVAILABLE;
      case 'UNKNOWN':
      default:
        return HttpStatus.BAD_GATEWAY;
    }
  }

  fromGitHubStatus(
    status: number,
    payloadMessage: string | undefined,
    context: 'comment' | 'review' | 'patch' | 'ci',
  ): HttpException {
    const message = payloadMessage?.trim();

    if (status === 401) {
      return this.toHttpException(
        'NOT_CONNECTED',
        'GitHub rejected your stored token. Update it in dashboard Settings.',
      );
    }

    if (status === 403) {
      const lower = (message ?? '').toLowerCase();
      if (
        lower.includes('can not approve') ||
        lower.includes('cannot approve') ||
        lower.includes('pull request author') ||
        lower.includes('not allowed to request')
      ) {
        return this.toHttpException(
          'REVIEW_ACTION_NOT_ALLOWED',
          message ||
            'GitHub does not allow this review action for the connected account on this pull request.',
        );
      }
      if (
        lower.includes('protected') ||
        lower.includes('resource not accessible') ||
        lower.includes('not authorized')
      ) {
        return this.toHttpException(
          context === 'patch'
            ? 'BRANCH_NOT_WRITABLE'
            : context === 'ci'
              ? 'CHECKS_NOT_ACCESSIBLE'
              : 'INSUFFICIENT_PERMISSION',
          message ||
            (context === 'patch'
              ? 'Your connected GitHub account cannot update this pull request branch.'
              : context === 'ci'
                ? 'Your GitHub connection cannot read checks for this pull request.'
                : 'GitHub forbade this action. Check PAT permissions and org SSO.'),
        );
      }
      return this.toHttpException(
        context === 'ci' ? 'CHECKS_NOT_ACCESSIBLE' : 'INSUFFICIENT_PERMISSION',
        message ||
          (context === 'review'
            ? 'The connected GitHub account cannot submit this review. Check PAT permissions (Pull requests: Read and write) and org SSO.'
            : context === 'patch'
              ? 'The connected GitHub account cannot update repository contents. Check Contents write permission and org SSO.'
              : context === 'ci'
                ? 'Your GitHub connection cannot read checks for this pull request. Grant Checks (read) and optionally Actions (read) on the PAT, then reconnect.'
                : 'GitHub forbade posting this comment. Check PAT permissions (Pull requests: Read and write) and org SSO.'),
      );
    }

    if (status === 404) {
      return this.toHttpException(
        context === 'patch'
          ? 'REPOSITORY_NOT_ACCESSIBLE'
          : context === 'ci'
            ? 'CHECK_NOT_FOUND'
            : 'PULL_REQUEST_NOT_FOUND',
        context === 'ci'
          ? 'GitHub could not find that check, repository, or pull request (or the token cannot access it).'
          : 'GitHub could not find that repository or pull request (or the token cannot access it).',
      );
    }

    if (status === 409) {
      return this.toHttpException(
        'FILE_CHANGED',
        message || 'The target file changed after this fix was prepared.',
      );
    }

    if (status === 422) {
      const lower = (message ?? '').toLowerCase();
      if (
        lower.includes('protected') ||
        lower.includes('branch is protected') ||
        lower.includes('required status')
      ) {
        return this.toHttpException(
          'BRANCH_PROTECTED',
          message || 'GitHub repository rules prevent this branch from being updated this way.',
        );
      }
      if (
        lower.includes('diff hunk') ||
        lower.includes('pull request review thread') ||
        lower.includes('line must be part of the diff') ||
        (lower.includes('path') && lower.includes('diff'))
      ) {
        return this.toHttpException(
          'STALE_DIFF_POSITION',
          message ||
            'One or more inline comments no longer match the current diff. Return to the draft and convert them to PR-level notes.',
        );
      }
      if (
        lower.includes('review') &&
        (lower.includes('not allowed') || lower.includes('approve'))
      ) {
        return this.toHttpException(
          'REVIEW_ACTION_NOT_ALLOWED',
          message || 'GitHub does not permit the selected review action.',
        );
      }
      return this.toHttpException(
        context === 'patch' ? 'PATCH_INVALID' : 'REVIEW_VALIDATION_FAILED',
        message ||
          (context === 'patch'
            ? 'GitHub rejected the patch payload.'
            : 'GitHub rejected the review payload.'),
      );
    }

    if (status === 429) {
      return this.toHttpException(
        'RATE_LIMITED',
        message || 'GitHub rate limit exceeded. Try again later.',
      );
    }

    return this.toHttpException(
      'UNKNOWN',
      message || `GitHub ${context} failed (HTTP ${status}).`,
      status >= 500 ? HttpStatus.BAD_GATEWAY : HttpStatus.BAD_REQUEST,
    );
  }
}
