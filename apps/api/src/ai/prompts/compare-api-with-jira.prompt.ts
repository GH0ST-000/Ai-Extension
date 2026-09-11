import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { OPENAPI_BASE_RULES, buildOpenApiUserContent } from './openapi-prompt.utils';

export const compareApiWithJiraPrompt: AiPromptDefinition = {
  action: AIAction.COMPARE_API_WITH_JIRA,
  build: (input) => ({
    instructions: [
      'Compare the Jira requirement with the OpenAPI operation contract (contract-level only).',
      'Respond with careful coverage language: covered / partial / not-evident / uncertain.',
      'Do not claim runtime correctness. Prefer “the OpenAPI contract does not define X”.',
      'Preserve explicit vs inferred Jira acceptance criteria distinction when present.',
      OPENAPI_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildOpenApiUserContent(
          input,
          'Compare Jira requirements with this OpenAPI operation. Contract-level only.',
        ),
      },
    ],
  }),
};
