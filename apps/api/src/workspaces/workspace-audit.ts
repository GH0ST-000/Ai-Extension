import { HttpException, type Logger } from '@nestjs/common';
import { hashUserIdForTelemetry } from '@project-x/shared';
import type { SecurityAuditEventType } from '@project-x/types';

import type { SecurityAuditService } from '../observability/security-audit.service';

/**
 * M3 — audit of membership and invitation changes. Safe metadata only: the actor as an HMAC
 * reference, workspace, target membership/invitation id, action, roles and outcome. Never
 * invitation tokens (or their hashes) and never e-mail addresses.
 */
export type WorkspaceAuditEntry = {
  type: SecurityAuditEventType;
  outcome: 'success' | 'blocked';
  actorUserId: string;
  workspaceId: string;
  action: string;
  /** Membership or invitation id. */
  targetId?: string;
  detail?: string;
};

const DENIAL_CODES = new Set([
  'WORKSPACE_ACCESS_DENIED',
  'WORKSPACE_LAST_OWNER',
  'WORKSPACE_OWNER_REQUIRED',
]);

export function recordWorkspaceAudit(
  audit: SecurityAuditService | undefined,
  logger: Logger,
  entry: WorkspaceAuditEntry,
): void {
  const detail = [
    `action=${entry.action}`,
    entry.targetId ? `target=${entry.targetId}` : null,
    entry.detail ?? null,
  ]
    .filter(Boolean)
    .join(' ');
  try {
    audit?.record({
      type: entry.type,
      outcome: entry.outcome,
      actorUserId: entry.actorUserId,
      workspaceId: entry.workspaceId,
      detail,
    });
  } catch {
    // Auditing must never break the membership operation.
  }
  logger.log({
    msg: 'workspace.membership.audit',
    type: entry.type,
    outcome: entry.outcome,
    actorUserIdHash: hashUserIdForTelemetry(entry.actorUserId),
    workspaceId: entry.workspaceId,
    action: entry.action,
    ...(entry.targetId ? { targetId: entry.targetId } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
  });
}

/** Records a refused privilege change (403-class workspace errors); rethrows nothing. */
export function recordWorkspaceDenial(
  audit: SecurityAuditService | undefined,
  logger: Logger,
  error: unknown,
  entry: Omit<WorkspaceAuditEntry, 'type' | 'outcome' | 'detail'>,
): void {
  if (!(error instanceof HttpException)) return;
  const response = error.getResponse() as { code?: string } | string;
  const code = typeof response === 'object' ? response.code : undefined;
  if (!code || !DENIAL_CODES.has(code)) return;
  recordWorkspaceAudit(audit, logger, {
    ...entry,
    type: 'workspace.membership.denied',
    outcome: 'blocked',
    detail: `code=${code}`,
  });
}
