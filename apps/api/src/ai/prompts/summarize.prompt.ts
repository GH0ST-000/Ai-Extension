import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Summarize the selected text: main point + essential facts only.',
  'Do not add new information. Keep it brief.',
  BASE_RULES,
].join(' ');

export const summarizePrompt: AiPromptDefinition = {
  action: AIAction.SUMMARIZE,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Summarize SEL.'),
      },
    ],
  }),
};
