import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const analyzeApiContractPrompt: AiPromptDefinition = {
  action: AIAction.ANALYZE_API_CONTRACT,
  build: (input) => ({
    instructions: [
      'Analyze API contract risks grounded in the OpenAPI document and any deterministic findings provided.',
      'Only include relevant risks. Separate Contract Fact, Potential Risk, and Recommendation.',
      'Do not claim implementation bugs from design alone.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(
          input,
          'Analyze OpenAPI contract risks for the given scope.',
        ),
      },
    ],
  }),
};
