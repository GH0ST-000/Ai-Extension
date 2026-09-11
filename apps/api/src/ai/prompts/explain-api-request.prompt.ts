import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const explainApiRequestPrompt: AiPromptDefinition = {
  action: AIAction.EXPLAIN_API_REQUEST,
  build: (input) => ({
    instructions: [
      'Explain the request contract for this OpenAPI operation.',
      'Cover path/query/header/cookie parameters, request body, required vs optional, constraints, content types, auth.',
      'Label OpenAPI-required fields as contract facts. Label AI suggestions as inference.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(input, 'Explain the request side of this API operation.'),
      },
    ],
  }),
};
