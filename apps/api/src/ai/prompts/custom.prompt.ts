import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import {
  BASE_RULES,
  formatPageContext,
  wrapCustomInstruction,
  wrapSelectedText,
} from './prompt.utils';

const INSTRUCTIONS = [
  'Follow the custom instruction on the selected text.',
  'Return useful content directly.',
  BASE_RULES,
].join(' ');

export const customPrompt: AiPromptDefinition = {
  action: AIAction.CUSTOM,
  build: (input) => {
    const instruction = input.customPrompt?.trim() ?? '';
    const contextBlock = formatPageContext(input.context, input.text);

    return {
      instructions: INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: [
            'Apply CMD to SEL.',
            wrapCustomInstruction(instruction),
            contextBlock,
            wrapSelectedText(input.text),
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    };
  },
};
