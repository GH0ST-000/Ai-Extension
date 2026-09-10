import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { JIRA_BASE_RULES, buildJiraUserContent } from './jira-prompt.utils';

export const createTechnicalPlanPrompt: AiPromptDefinition = {
  action: AIAction.CREATE_TECHNICAL_PLAN,
  build: (input) => ({
    instructions: [
      'Create an implementation plan for a senior developer from this Jira issue.',
      'Sections: Understanding, Affected Areas, Implementation Steps, Data/API Impact, Backward Compatibility, Testing, Deployment/Migration, Risks, Open Questions.',
      'Without repository/PR context, stay at subsystem level — do not invent filenames.',
      'Keep it scannable, not a long essay.',
      JIRA_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildJiraUserContent(input, 'Create a grounded technical implementation plan.'),
      },
    ],
  }),
};
