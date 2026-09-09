import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Improve grammar, clarity, and tone of the selected writing.',
  'Preserve meaning. Return only the improved text.',
  BASE_RULES,
].join(' ');

export const improveWritingPrompt: AiPromptDefinition = {
  action: AIAction.IMPROVE_WRITING,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildUserContent(input, 'Improve SEL writing.'),
      },
    ],
  }),
};
