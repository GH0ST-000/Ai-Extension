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

/** Short chip label: "2 memory rules", "No memory", or null while unknown. */
export function memoryChipLabel(metadata: ProjectMemoryPromptMetadata | null): string | null {
  if (!metadata) return null;
  if (metadata.status === 'skipped') return 'No memory applied';
  const n = metadata.rules.length;
  return `${n} memory rule${n === 1 ? '' : 's'}`;
}

/** Display name for a memory category, e.g. SECURITY_CONVENTION → "Security convention". */
export function memoryCategoryLabel(category: string): string {
  const words = category.toLowerCase().split('_').filter(Boolean);
  const text = words.join(' ');
  return text ? text[0]!.toUpperCase() + text.slice(1) : category;
}
