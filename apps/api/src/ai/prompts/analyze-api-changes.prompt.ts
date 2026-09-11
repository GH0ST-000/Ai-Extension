import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const analyzeApiChangesPrompt: AiPromptDefinition = {
  action: AIAction.ANALYZE_API_CHANGES,
  build: (input) => ({
    instructions: [
      'Explain the impact of the provided DETERMINISTIC OpenAPI structural diff.',
      'Do not override breaking/non-breaking/uncertain classifications from the structural diff.',
      'You may explain client impact, but structural facts win.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(
          input,
          'Explain this deterministic OpenAPI contract diff for engineers.',
        ),
      },
    ],
  }),
};
