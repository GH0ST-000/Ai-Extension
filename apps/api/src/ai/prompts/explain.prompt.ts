import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Explain the selected webpage text in plain language.',
  'Keep it short; preserve key technical detail; mark uncertainty.',
  BASE_RULES,
].join(' ');

export const explainPrompt: AiPromptDefinition = {
  action: AIAction.EXPLAIN,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Explain SEL.'),
      },
    ],
  }),
};
