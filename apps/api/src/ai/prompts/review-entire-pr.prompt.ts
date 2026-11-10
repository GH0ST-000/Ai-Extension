import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent, PROJECT_MEMORY_POLICY } from './prompt.utils';

const INSTRUCTIONS = [
  'Review this pull request using the multi-file changedFiles list in CTX (and PR meta).',
  'Prefer concrete risks: bugs, security, regressions, missing tests, broken contracts.',
  'Only discuss files/lines present in CTX. Files listed without diff lines exist in the PR but were not provided — do not guess about them.',
  'If filesTruncated is 1, review what is provided and state in the Summary how many files were reviewed (files with diffs) versus filesTotal when given.',
  'SEL is optional focus — still review the whole bounded file set.',
  'Output format (strict markdown):',
  '## Summary',
  '2–5 sentences on overall risk and intent.',
  '## Risk Findings',
  'Numbered list. Each item:',
  '1. **[high|medium|low]** `path/to/file` — short title',
  '   Why: one or two sentences.',
  'Always include both headings. If no material risks, write exactly "No material risks found." under Risk Findings.',
  'Do not invent patches in this action — findings only.',
  PROJECT_MEMORY_POLICY,
  BASE_RULES,
].join(' ');

export const reviewEntirePrPrompt: AiPromptDefinition = {
  action: AIAction.REVIEW_ENTIRE_PR,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Review the entire pull request from CTX changedFiles.'),
      },
    ],
  }),
};
