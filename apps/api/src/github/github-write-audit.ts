import type { Logger } from '@nestjs/common';
import { hashUserIdForTelemetry } from '@project-x/shared';
import type { SecurityAuditEventType } from '@project-x/types';

import type { GitHubApiTokenSource } from '../github-app/github-access.service';
import type { SecurityAuditService } from '../observability/security-audit.service';

/**
 * H1 — attribution of GitHub writes to the Project X user who made them (writes through the
 * workspace App appear on GitHub as the App bot). Recorded once per real write (idempotent
 * replays return before writing and record nothing) and for refused writes.
 *
 * Both sinks carry only safe metadata: the user as an HMAC reference (the platform's audit
 * convention), workspace, repository, PR number, operation, credential TYPE and the GitHub
 * result id. Never tokens, Authorization headers, comment/review bodies or patch content.
 */
export type GithubWriteAudit = {
  operation: 'comment' | 'review' | 'patch';
  outcome: 'success' | 'blocked';
  userId: string;
  workspaceId?: string;
  owner: string;
  repository: string;
  pullRequestNumber?: number;
  credential?: GitHubApiTokenSource;
  /** e.g. the review event, or the refusal code. */
  detail?: string;
  /** GitHub comment / review id or commit SHA. */
  resultId?: string | number;
};

export function recordGithubWrite(
  audit: SecurityAuditService | undefined,
  logger: Logger,
  entry: GithubWriteAudit,
): void {
  const repository = `${entry.owner}/${entry.repository}`.toLowerCase();
  const detail = [
    `repo=${repository}`,
    entry.pullRequestNumber !== undefined ? `pr=${entry.pullRequestNumber}` : null,
    `op=${entry.operation}`,
    entry.credential ? `credential=${entry.credential}` : null,
    entry.detail ? `detail=${entry.detail}` : null,
    entry.resultId !== undefined ? `result=${entry.resultId}` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const type: SecurityAuditEventType =
    entry.outcome === 'blocked' ? 'github.write.denied' : `github.write.${entry.operation}`;
  try {
    audit?.record({
      type,
      outcome: entry.outcome,
      actorUserId: entry.userId,
      ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      detail,
    });
  } catch {
    // Auditing must never break the write path.
  }
  logger.log({
    msg: 'github.write.audit',
    type,
    outcome: entry.outcome,
    actorUserIdHash: hashUserIdForTelemetry(entry.userId),
    ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
    repository,
    ...(entry.pullRequestNumber !== undefined
      ? { pullRequestNumber: entry.pullRequestNumber }
      : {}),
    operation: entry.operation,
    ...(entry.credential ? { credential: entry.credential } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.resultId !== undefined ? { resultId: String(entry.resultId) } : {}),
  });
}
