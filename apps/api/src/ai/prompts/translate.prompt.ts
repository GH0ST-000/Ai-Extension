import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { BASE_RULES, buildUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Translate the selected text. Preserve meaning and tone.',
  'Return only the translation.',
  BASE_RULES,
].join(' ');

export const translatePrompt: AiPromptDefinition = {
  action: AIAction.TRANSLATE,
  build: (input) => {
    const task = input.targetLanguage
      ? `Translate SEL to ${input.targetLanguage}.`
      : 'Translate SEL to a useful target language (prefer English if source is non-English).';

    return {
      instructions: INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: buildUserContent(input, task),
        },
      ],
    };
  },
};
