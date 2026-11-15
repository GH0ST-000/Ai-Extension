import type { ProjectMemoryPromptMetadata, ProjectMemorySkipReason } from '@project-x/types';

const SKIP_REASON_TEXT: Record<ProjectMemorySkipReason, string> = {
  no_repository: 'No repository was identified for this page.',
  invalid_repository: 'The repository name could not be resolved.',
  memory_service_unavailable: 'Project memory is not available on this server.',
  workspace_permission_denied: 'Your role in this workspace cannot read project memory.',
  feature_not_available: 'Project memory is not included in this workspace plan.',
  github_not_connected: 'Connect GitHub in dashboard Settings to use project memory.',
  github_token_rejected: 'GitHub rejected the stored token. Update it in dashboard Settings.',
  repository_access_denied: 'The connected GitHub account cannot access this repository.',
  github_unavailable: 'GitHub could not be reached to verify repository access.',
  retrieval_failed: 'Project memory could not be loaded.',
  no_active_rules: 'This repository has no active project memory rules in this workspace.',
  all_rules_blocked_by_safety_policy: 'All saved rules were blocked by the safety policy.',
  no_relevant_rules: 'No saved rules apply to PR reviews.',
};

export function memorySkipReasonText(reason: ProjectMemorySkipReason): string {
  return SKIP_REASON_TEXT[reason] ?? 'Project memory was not applied.';
}

/**
 * Short status label for the review report: "Applied · 2 rules", "Skipped · no rules
 * applied", "Off for this review", or null while unknown.
 */
export function memoryChipLabel(metadata: ProjectMemoryPromptMetadata | null): string | null {
  if (!metadata) return null;
  if (metadata.status === 'disabled') return 'Off for this review';
  if (metadata.status === 'skipped') return 'Skipped · no rules applied';
  const n = metadata.ruleCount ?? metadata.rules.length;
  return `Applied · ${n} rule${n === 1 ? '' : 's'}`;
}

/** Number of rules placed in the prompt (0 unless applied). */
export function memoryAppliedRuleCount(metadata: ProjectMemoryPromptMetadata | null): number {
  if (!metadata || metadata.status !== 'applied') return 0;
  return metadata.ruleCount ?? metadata.rules.length;
}

/** Display name for a memory category, e.g. SECURITY_CONVENTION → "Security convention". */
export function memoryCategoryLabel(category: string): string {
  const words = category.toLowerCase().split('_').filter(Boolean);
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : category;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * One-line memory status for summaries: "Project Memory: applied (2 rules)", "…: off",
 * "…: not applied", or null when the server did not report it.
 */
export function memorySummaryLine(
  metadata: ProjectMemoryPromptMetadata | null | undefined,
): string | null {
  if (!metadata) return null;
  if (metadata.status === 'disabled') return 'Project Memory: off';
  if (metadata.status === 'skipped') return 'Project Memory: not applied';
  return `Project Memory: applied (${plural(memoryAppliedRuleCount(metadata), 'rule')})`;
}

/**
 * "## Project Memory" export section. Counts only — never rule text: exports can leave the
 * workspace and personal preferences are private. States that rules are context, not evidence.
 */
export function memoryExportSection(
  metadata: ProjectMemoryPromptMetadata | null | undefined,
): string[] {
  if (!metadata) return [];
  if (metadata.status === 'disabled') {
    return [
      '## Project Memory',
      'Off for this review — no saved rules were retrieved or sent to the AI.',
    ];
  }
  if (metadata.status === 'skipped') {
    return ['## Project Memory', `Not applied — ${memorySkipReasonText(metadata.reason)}`];
  }
  const n = memoryAppliedRuleCount(metadata);
  const personal = metadata.rules.filter((rule) => rule.visibility === 'user').length;
  const shared = Math.max(0, metadata.rules.length - personal);
  return [
    '## Project Memory',
    `Applied — ${plural(n, 'rule')} ${n === 1 ? 'was' : 'were'} sent to the AI as review context (${plural(shared, 'shared rule')}, ${plural(personal, 'personal preference')}).`,
    'Rules are context, not evidence: findings are based on the reviewed code, and this report does not show whether any rule changed a finding.',
  ];
}
