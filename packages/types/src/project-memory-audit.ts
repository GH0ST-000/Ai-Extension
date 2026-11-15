/**
 * Project Memory audit log — append-only history of changes to memory rules.
 *
 * Auditing starts when this feature is deployed: rules that existed before have no earlier
 * events (none are fabricated).
 *
 * Privacy: events for personal preferences (visibility `user`) are visible only to the
 * preference owner and never store rule text. Events for shared rules are visible to every
 * workspace member who can read Project Memory.
 */

export const PROJECT_MEMORY_AUDIT_SCHEMA_VERSION = 1;

export const PROJECT_MEMORY_AUDIT_EVENT_TYPES = [
  /** A new rule row was stored (explicit rule, confirmed candidate, or Learn). */
  'rule_created',
  /** An identical active fact was stored again: confirmation time / confidence refreshed. */
  'rule_reconfirmed',
  /** Rule text or scope changed. */
  'rule_edited',
  /** Rule archived (single archive, status change, or clearing the repository's memory). */
  'rule_archived',
  /** Rule marked disputed. */
  'rule_disputed',
  /** A disputed rule made active again (dispute resolved). */
  'rule_restored',
  /** An archived or superseded rule made active again. */
  'rule_reactivated',
  /** Rule replaced by another active rule in the same slot (or marked superseded). */
  'rule_superseded',
] as const;
export type ProjectMemoryAuditEventType = (typeof PROJECT_MEMORY_AUDIT_EVENT_TYPES)[number];

/** `user` = a person's direct action; `system` = an automatic change (Learn, supersession). */
export const PROJECT_MEMORY_AUDIT_ACTOR_TYPES = ['user', 'system'] as const;
export type ProjectMemoryAuditActorType = (typeof PROJECT_MEMORY_AUDIT_ACTOR_TYPES)[number];

/** Why an event happened (machine code). */
export type ProjectMemoryAuditReason =
  | 'user_rule'
  | 'candidate_confirmed'
  | 'learned'
  | 'status_change'
  | 'repository_cleared'
  | 'replaced_by_new_rule'
  | 'slot_reactivated';

/** Rule state recorded with an event. Personal preferences carry status / confidence only. */
export interface ProjectMemoryAuditState {
  status?: string;
  confidence?: string;
  /** Shared rules only. */
  text?: string;
  /** Shared rules only. */
  scope?: unknown;
}

export interface ProjectMemoryAuditEvent {
  id: string;
  schemaVersion: number;
  eventType: ProjectMemoryAuditEventType;
  actorType: ProjectMemoryAuditActorType;
  /** Person who acted (or whose action triggered a system change); null once deleted. */
  actorUserId: string | null;
  /** Display name recorded at the time of the event (never an email address). */
  actorName: string | null;
  /** True when the viewer is the actor. */
  actorIsViewer: boolean;
  reason: ProjectMemoryAuditReason | null;
  memoryId: string;
  /** e.g. the rule that superseded / was superseded by this one. */
  relatedMemoryId: string | null;
  visibility: 'workspace' | 'user';
  provider: string;
  owner: string;
  repository: string;
  category: string;
  key: string;
  previousState: ProjectMemoryAuditState | null;
  newState: ProjectMemoryAuditState | null;
  requestId: string | null;
  createdAt: string;
}

export interface ProjectMemoryAuditPage {
  items: ProjectMemoryAuditEvent[];
  /** Opaque; null when there are no more events. */
  nextCursor: string | null;
}

export interface ProjectMemoryAuditQuery {
  owner?: string;
  repository?: string;
  memoryId?: string;
  eventType?: ProjectMemoryAuditEventType;
  actorType?: ProjectMemoryAuditActorType;
  actorUserId?: string;
  /** ISO 8601, inclusive. */
  from?: string;
  /** ISO 8601, exclusive. */
  to?: string;
  cursor?: string;
  limit?: number;
}

export const PROJECT_MEMORY_AUDIT_DEFAULT_LIMIT = 25;
export const PROJECT_MEMORY_AUDIT_MAX_LIMIT = 100;
/** Longest rule text kept in an audit state (rule text is already capped far below). */
export const PROJECT_MEMORY_AUDIT_MAX_TEXT_CHARS = 4_000;

/**
 * One memory rule in the grouped Activity view (`GET …/memory/audit/rules`). Grouped by the
 * rule's id (never its key), after the visibility rules are applied.
 */
export interface ProjectMemoryAuditRuleSummary {
  memoryId: string;
  owner: string;
  repository: string;
  category: string;
  key: string;
  visibility: 'workspace' | 'user';
  /** Events of this rule matching the current filters. */
  matchingEventCount: number;
  /** All events of this rule the viewer may see (ignores filters). */
  totalEventCount: number;
  /** Most recent matching event (its time orders the list). */
  latestEvent: ProjectMemoryAuditEvent;
  /** Status after the rule's most recent visible event, if recorded. */
  currentStatus: string | null;
}

export interface ProjectMemoryAuditRulePage {
  items: ProjectMemoryAuditRuleSummary[];
  /** Opaque; null when there are no more rules. */
  nextCursor: string | null;
}

export interface ProjectMemoryAuditRuleQuery extends Omit<ProjectMemoryAuditQuery, 'memoryId'> {
  /** Case-insensitive match on the rule key. */
  q?: string;
}

export const PROJECT_MEMORY_AUDIT_RULES_DEFAULT_LIMIT = 20;
export const PROJECT_MEMORY_AUDIT_RULES_MAX_LIMIT = 50;
export const PROJECT_MEMORY_AUDIT_SEARCH_MAX_CHARS = 100;
