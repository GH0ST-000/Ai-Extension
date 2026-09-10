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
        return HttpStatus.FORBIDDEN;
      case 'REPOSITORY_NOT_ACCESSIBLE':
      case 'PULL_REQUEST_NOT_FOUND':
      case 'REVIEW_VALIDATION_FAILED':
      case 'STALE_DIFF_POSITION':
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
    context: 'comment' | 'review',
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
      return this.toHttpException(
        'INSUFFICIENT_PERMISSION',
        message ||
          (context === 'review'
            ? 'The connected GitHub account cannot submit this review. Check PAT permissions (Pull requests: Read and write) and org SSO.'
            : 'GitHub forbade posting this comment. Check PAT permissions (Pull requests: Read and write) and org SSO.'),
      );
    }

    if (status === 404) {
      return this.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'GitHub could not find that repository or pull request (or the token cannot access it).',
      );
    }

    if (status === 422) {
      const lower = (message ?? '').toLowerCase();
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
        'REVIEW_VALIDATION_FAILED',
        message || 'GitHub rejected the review payload.',
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
