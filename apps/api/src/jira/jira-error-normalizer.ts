import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { JiraErrorBody, JiraErrorCode } from '@project-x/types';

@Injectable()
export class JiraErrorNormalizer {
  toHttpException(code: JiraErrorCode, message: string, status?: number): HttpException {
    const resolvedStatus = status ?? this.defaultStatus(code);
    const body: JiraErrorBody & { statusCode: number } = {
      code,
      message,
      statusCode: resolvedStatus,
    };
    return new HttpException(body, resolvedStatus);
  }

  private defaultStatus(code: JiraErrorCode): number {
    switch (code) {
      case 'JIRA_NOT_CONNECTED':
      case 'JIRA_SITE_NOT_CONNECTED':
      case 'JIRA_PERMISSION_REQUIRED':
      case 'JIRA_ISSUE_NOT_ACCESSIBLE':
      case 'JIRA_SITE_NOT_ACCESSIBLE':
        return HttpStatus.FORBIDDEN;
      case 'JIRA_ISSUE_NOT_FOUND':
      case 'JIRA_CONTEXT_STALE':
      case 'JIRA_CONTENT_UNSUPPORTED':
      case 'JIRA_PR_LINK_NOT_FOUND':
      case 'JIRA_PR_LINK_AMBIGUOUS':
      case 'JIRA_PR_COMPARISON_STALE':
        return HttpStatus.BAD_REQUEST;
      case 'JIRA_RATE_LIMITED':
        return HttpStatus.TOO_MANY_REQUESTS;
      case 'JIRA_UNAVAILABLE':
        return HttpStatus.SERVICE_UNAVAILABLE;
      case 'UNKNOWN':
      default:
        return HttpStatus.BAD_GATEWAY;
    }
  }

  fromJiraStatus(status: number, payloadMessage?: string): HttpException {
    const message = payloadMessage?.trim();
    if (status === 401) {
      return this.toHttpException(
        'JIRA_NOT_CONNECTED',
        'Jira rejected your stored credentials. Update them in dashboard Settings.',
      );
    }
    if (status === 403) {
      return this.toHttpException(
        'JIRA_PERMISSION_REQUIRED',
        message || 'Your connected Jira account cannot access this resource.',
      );
    }
    if (status === 404) {
      return this.toHttpException(
        'JIRA_ISSUE_NOT_FOUND',
        message || 'Jira could not find that issue (or the account cannot access it).',
      );
    }
    if (status === 429) {
      return this.toHttpException(
        'JIRA_RATE_LIMITED',
        message || 'Jira rate limit reached. Try again later.',
      );
    }
    if (status >= 500) {
      return this.toHttpException(
        'JIRA_UNAVAILABLE',
        message || 'Jira is temporarily unavailable.',
      );
    }
    return this.toHttpException('UNKNOWN', message || `Jira request failed (HTTP ${status}).`);
  }
}
