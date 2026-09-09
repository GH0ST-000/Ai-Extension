import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Review this pull request using the multi-file changedFiles list in CTX (and PR meta).',
  'Prefer concrete risks: bugs, security, regressions, missing tests, broken contracts.',
  'Only discuss files/lines present in CTX. If changedFiles is empty or truncated, say so and ask the user to open the Files tab / scroll to load more.',
  'SEL is optional focus — still review the whole bounded file set.',
  'Output format (strict markdown):',
  '## Summary',
  '2–5 sentences on overall risk and intent.',
  '## Risk Findings',
  'Numbered list. Each item:',
  '1. **[high|medium|low]** `path/to/file` — short title',
  '   Why: one or two sentences.',
  'If no material risks, say so under Risk Findings.',
  'Do not invent patches in this action — findings only.',
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
