import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const generateApiExamplePrompt: AiPromptDefinition = {
  action: AIAction.GENERATE_API_EXAMPLE,
  build: (input) => ({
    instructions: [
      'Explain the provided GENERATED EXAMPLE for this OpenAPI operation.',
      'The example is synthetic. Never present it as an actual request.',
      'If Authorization is present it must remain Bearer <token> or similar placeholders.',
      'Do not invent fields that violate the schema.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(
          input,
          'Explain this schema-driven generated API example (do not execute it).',
        ),
      },
    ],
  }),
};
