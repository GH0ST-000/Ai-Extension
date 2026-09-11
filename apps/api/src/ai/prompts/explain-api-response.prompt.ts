import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const explainApiResponsePrompt: AiPromptDefinition = {
  action: AIAction.EXPLAIN_API_RESPONSE,
  build: (input) => ({
    instructions: [
      'Explain documented responses for this OpenAPI operation.',
      'Group by 2xx / 4xx / 5xx / other only when those codes exist in the contract.',
      'If only 200/400 are defined, do not invent 404/500 as facts.',
      'You may say other error behavior is not defined in this OpenAPI contract.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(input, 'Explain the response side of this API operation.'),
      },
    ],
  }),
};
