import type { Prisma, ProjectMemory as ProjectMemoryRow } from '@prisma/client';
import type {
  ProjectMemoryAuditActorType,
  ProjectMemoryAuditEventType,
  ProjectMemoryAuditReason,
  ProjectMemoryAuditState,
} from '@project-x/types';
import {
  PROJECT_MEMORY_AUDIT_MAX_TEXT_CHARS,
  PROJECT_MEMORY_AUDIT_SCHEMA_VERSION,
} from '@project-x/types';

/** Who caused a change: a person directly, or the system on behalf of a person. */
export type MemoryAuditActor = {
  userId: string;
  type: ProjectMemoryAuditActorType;
  /** Correlation id of the HTTP request, when available. */
  requestId?: string;
};

type AuditRow = Pick<
  ProjectMemoryRow,
  | 'id'
  | 'workspaceId'
  | 'userId'
  | 'visibility'
  | 'provider'
  | 'owner'
  | 'repository'
  | 'category'
  | 'key'
  | 'status'
  | 'confidence'
  | 'valueJson'
  | 'scopeJson'
>;

export type MemoryAuditEventInput = {
  eventType: ProjectMemoryAuditEventType;
  reason?: ProjectMemoryAuditReason;
  /** The rule as it is after the change (identity, slot and visibility come from it). */
  row: AuditRow;
  /** The rule before the change; null for creation. */
  previous?: AuditRow | null;
  relatedMemoryId?: string | null;
  /** Overrides the actor type for this event (e.g. a system supersession in a user action). */
  actorType?: ProjectMemoryAuditActorType;
};

/** Personal preferences (and pre-workspace rows) are private to their author. */
export function isPrivateRule(row: Pick<AuditRow, 'visibility' | 'workspaceId'>): boolean {
  return row.visibility === 'user' || row.workspaceId === null;
}

/**
 * State stored with an event. Shared rules keep their text and scope (already readable by every
 * member who can read memory). Personal preferences keep status and confidence only — never
 * their text or scope, so the audit table holds nothing private about them.
 */
export function auditState(row: AuditRow): ProjectMemoryAuditState {
  const base: ProjectMemoryAuditState = { status: row.status, confidence: row.confidence };
  if (isPrivateRule(row)) return base;
  const summary =
    row.valueJson && typeof row.valueJson === 'object' && !Array.isArray(row.valueJson)
      ? String((row.valueJson as { summary?: unknown }).summary ?? '')
      : '';
  return {
    ...base,
    text: summary.slice(0, PROJECT_MEMORY_AUDIT_MAX_TEXT_CHARS),
    scope: row.scopeJson ?? null,
  };
}

/** True when the stored state of a rule differs (used to skip no-op events). */
export function auditStateChanged(a: AuditRow, b: AuditRow): boolean {
  return JSON.stringify(auditState(a)) !== JSON.stringify(auditState(b));
}

/**
 * Append audit events inside the caller's transaction. If this fails, the transaction — and
 * therefore the memory change — rolls back: a committed change always has its events.
 */
export async function recordMemoryAudit(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  actor: MemoryAuditActor,
  events: MemoryAuditEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  const user = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { name: true },
  });
  const actorName = user?.name?.trim().slice(0, 120) || null;
  await tx.projectMemoryAuditEvent.createMany({
    data: events.map((event) => {
      const personal = isPrivateRule(event.row);
      return {
        schemaVersion: PROJECT_MEMORY_AUDIT_SCHEMA_VERSION,
        workspaceId,
        memoryId: event.row.id,
        relatedMemoryId: event.relatedMemoryId ?? null,
        eventType: event.eventType,
        actorType: event.actorType ?? actor.type,
        actorUserId: actor.userId,
        actorName,
        reason: event.reason ?? null,
        visibility: personal ? 'user' : 'workspace',
        subjectUserId: personal ? event.row.userId : null,
        provider: event.row.provider,
        owner: event.row.owner,
        repository: event.row.repository,
        category: event.row.category,
        key: event.row.key,
        previousState: event.previous
          ? (auditState(event.previous) as unknown as Prisma.InputJsonValue)
          : undefined,
        newState: auditState(event.row) as unknown as Prisma.InputJsonValue,
        requestId: actor.requestId?.slice(0, 128) ?? null,
      };
    }),
  });
}

/** Event for a status transition, or null when the status did not change. */
export function statusEventType(from: string, to: string): ProjectMemoryAuditEventType | null {
  if (from === to) return null;
  if (to === 'archived') return 'rule_archived';
  if (to === 'disputed') return 'rule_disputed';
  if (to === 'superseded') return 'rule_superseded';
  if (to === 'active') return from === 'disputed' ? 'rule_restored' : 'rule_reactivated';
  return null;
}
