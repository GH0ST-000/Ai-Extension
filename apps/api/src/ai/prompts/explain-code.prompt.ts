import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Explain what the selected code does and important behavior.',
  'Only note issues supported by the code. No invented runtime claims.',
  BASE_RULES,
].join(' ');

export const explainCodePrompt: AiPromptDefinition = {
  action: AIAction.EXPLAIN_CODE,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Explain SEL code.'),
      },
    ],
  }),
};
