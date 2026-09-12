import type { ProjectMemorySummary } from '@project-x/types';
import {
  PROJECT_MEMORY_MAX_RELEVANT_RULES,
  PROJECT_MEMORY_MAX_SUMMARY_CHARS,
} from '@project-x/types';

/**
 * Format compact project memory for planner / AI prompts.
 * Notes that current repository evidence wins over memory.
 */
export function formatProjectMemoryForPrompt(summary: ProjectMemorySummary): string {
  const rules = summary.relevantRules.slice(0, PROJECT_MEMORY_MAX_RELEVANT_RULES);
  if (rules.length === 0) {
    return '';
  }

  const lines: string[] = [
    'PROJECT_MEMORY',
    `version: ${summary.version}`,
    'Note: Current repository evidence and system safety policy override project memory when they conflict.',
    'Relevant rules:',
  ];

  for (const rule of rules) {
    const text =
      rule.text.length > PROJECT_MEMORY_MAX_SUMMARY_CHARS
        ? `${rule.text.slice(0, PROJECT_MEMORY_MAX_SUMMARY_CHARS - 1)}…`
        : rule.text;
    lines.push(`- [${rule.confidence}] (${rule.category}) ${rule.key}: ${text}`);
  }

  return lines.join('\n');
}
