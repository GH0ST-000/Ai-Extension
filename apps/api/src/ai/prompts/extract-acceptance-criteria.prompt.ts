import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { JIRA_BASE_RULES, buildJiraUserContent } from './jira-prompt.utils';

export const extractAcceptanceCriteriaPrompt: AiPromptDefinition = {
  action: AIAction.EXTRACT_ACCEPTANCE_CRITERIA,
  build: (input) => ({
    instructions: [
      'Extract acceptance criteria from the Jira issue.',
      'Respond with JSON only (no markdown fences):',
      '{"explicit":[{"id":"e1","text":"...","source":"description|comment","testability":"clear|partial|unclear"}],"inferred":[{"id":"i1","text":"...","source":"inferred","testability":"partial|unclear"}],"openQuestions":["..."],"completeness":"high|medium|low"}',
      'Never present inferred criteria as if the author wrote them.',
      'If no explicit criteria exist, return explicit:[].',
      JIRA_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildJiraUserContent(
          input,
          'Extract explicit vs inferred acceptance criteria as JSON only.',
        ),
      },
    ],
  }),
};
