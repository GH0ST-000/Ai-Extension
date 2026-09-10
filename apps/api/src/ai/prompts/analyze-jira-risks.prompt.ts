import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { JIRA_BASE_RULES, buildJiraUserContent } from './jira-prompt.utils';

export const analyzeJiraRisksPrompt: AiPromptDefinition = {
  action: AIAction.ANALYZE_JIRA_RISKS,
  build: (input) => ({
    instructions: [
      'Analyze requirement risks and open questions for this Jira issue.',
      'Only include relevant categories (ambiguity, edge cases, auth/security, concurrency, migration, API contracts, failure modes, observability, performance, rollout, testing).',
      'Label each item as Known risk, Potential risk, or Question.',
      'Do not force every category.',
      JIRA_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildJiraUserContent(input, 'List relevant risks and questions for this issue.'),
      },
    ],
  }),
};
