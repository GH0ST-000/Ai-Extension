import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { ERROR_BASE_RULES, buildErrorUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Explain the software error clearly and practically.',
  'Cover when evidence supports it: what happened, what the message means, where it likely happened, and what to inspect first.',
  'Prefer nearby source / stack / classification over generic textbook definitions.',
  'If context is thin, say what is missing instead of inventing details.',
  ERROR_BASE_RULES,
].join(' ');

export const understandErrorPrompt: AiPromptDefinition = {
  action: AIAction.UNDERSTAND_ERROR,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildErrorUserContent(
          input,
          'Explain this error for a developer. Be practical and evidence-based.',
        ),
      },
    ],
  }),
};
