import type {
  ProjectMemoryAuditEvent,
  ProjectMemoryAuditEventType,
  ProjectMemoryAuditPage,
  ProjectMemoryAuditQuery,
  ProjectMemoryAuditRulePage,
  ProjectMemoryAuditRuleQuery,
  ProjectMemoryAuditRuleSummary,
} from '@project-x/types';

import { apiFetch } from '../../../lib/api';

/**
 * Read-only audit API. Authorization and the personal-preference privacy rule are enforced by
 * the server before pagination; the dashboard only renders what it is given and never caches
 * responses across workspaces or filters.
 */
export async function fetchMemoryAudit(
  workspaceId: string,
  query: ProjectMemoryAuditQuery,
  signal?: AbortSignal,
): Promise<ProjectMemoryAuditPage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return apiFetch<ProjectMemoryAuditPage>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory/audit${qs ? `?${qs}` : ''}`,
    { workspaceId, cache: 'no-store', ...(signal ? { signal } : {}) },
  );
}

/** Grouped view: one row per rule (server-side grouping, privacy and pagination). */
export async function fetchMemoryAuditRules(
  workspaceId: string,
  query: ProjectMemoryAuditRuleQuery,
  signal?: AbortSignal,
): Promise<ProjectMemoryAuditRulePage> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return apiFetch<ProjectMemoryAuditRulePage>(
    `/workspaces/${encodeURIComponent(workspaceId)}/memory/audit/rules${qs ? `?${qs}` : ''}`,
    { workspaceId, cache: 'no-store', ...(signal ? { signal } : {}) },
  );
}

/** "3 events", or "1 of 3 events" when filters select only some of them. */
export function ruleEventCountLabel(
  rule: Pick<ProjectMemoryAuditRuleSummary, 'matchingEventCount' | 'totalEventCount'>,
): string {
  const noun = rule.totalEventCount === 1 ? 'event' : 'events';
  return rule.matchingEventCount === rule.totalEventCount
    ? `${rule.totalEventCount} ${noun}`
    : `${rule.matchingEventCount} of ${rule.totalEventCount} ${noun}`;
}

export const AUDIT_EVENT_LABELS: Record<ProjectMemoryAuditEventType, string> = {
  rule_created: 'Created',
  rule_reconfirmed: 'Reconfirmed',
  rule_edited: 'Edited',
  rule_archived: 'Archived',
  rule_disputed: 'Disputed',
  rule_restored: 'Restored',
  rule_reactivated: 'Reactivated',
  rule_superseded: 'Superseded',
};

const REASON_LABELS: Record<string, string> = {
  user_rule: 'project rule',
  candidate_confirmed: 'confirmed suggestion',
  learned: 'learned from repository configuration',
  status_change: 'status change',
  repository_cleared: 'repository memory cleared',
  replaced_by_new_rule: 'replaced by a newer rule',
  slot_reactivated: 'another rule was reactivated in its place',
};

export function auditReasonLabel(reason: string | null): string | null {
  return reason ? (REASON_LABELS[reason] ?? null) : null;
}

/** "You", the recorded name, or a neutral label — never an email address. */
export function auditActorLabel(event: ProjectMemoryAuditEvent): string {
  const person = event.actorIsViewer
    ? 'You'
    : (event.actorName ?? (event.actorUserId ? 'A teammate' : 'Former member'));
  if (event.actorType === 'system')
    return `Automatic (started by ${person === 'You' ? 'you' : person})`;
  return person;
}

/** Human-readable change lines (shared rules only carry text / scope). */
export function auditChangeLines(event: ProjectMemoryAuditEvent): string[] {
  const lines: string[] = [];
  const before = event.previousState;
  const after = event.newState;
  if (before?.status && after?.status && before.status !== after.status) {
    lines.push(`Status: ${before.status} → ${after.status}`);
  }
  if (before?.text !== undefined && after?.text !== undefined && before.text !== after.text) {
    lines.push(`Text: “${before.text}” → “${after.text}”`);
  } else if (!before && after?.text) {
    lines.push(`Text: “${after.text}”`);
  }
  if (
    before?.scope !== undefined &&
    after?.scope !== undefined &&
    JSON.stringify(before.scope) !== JSON.stringify(after.scope)
  ) {
    lines.push('Scope changed');
  }
  if (before?.confidence && after?.confidence && before.confidence !== after.confidence) {
    lines.push(`Confidence: ${before.confidence} → ${after.confidence}`);
  }
  return lines;
}
