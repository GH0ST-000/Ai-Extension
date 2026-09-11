import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const explainApiEndpointPrompt: AiPromptDefinition = {
  action: AIAction.EXPLAIN_API_ENDPOINT,
  build: (input) => ({
    instructions: [
      'Explain this OpenAPI operation for a senior engineer.',
      'Sections: Purpose, Method/Path, Inputs, Request body, Authentication, Success responses, Important error responses, Side effects (only if documented), Deprecation, Notable constraints.',
      'Do not invent side effects or undocumented statuses.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(
          input,
          'Explain this API endpoint from the OpenAPI contract.',
        ),
      },
    ],
  }),
};
