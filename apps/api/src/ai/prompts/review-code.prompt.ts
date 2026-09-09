import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Review the selected code or diff as a senior engineer.',
  'Focus on bugs, regressions, edge cases, security, and clarity.',
  'Use PR/file CTX when present; do not invent files or behavior absent from SEL/CTX.',
  'Prefer concrete findings over praise. If solid, say so briefly.',
  BASE_RULES,
].join(' ');

export const reviewCodePrompt: AiPromptDefinition = {
  action: AIAction.REVIEW_CODE,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Review SEL as a code change.'),
      },
    ],
  }),
};
