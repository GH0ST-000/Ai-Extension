import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { JIRA_BASE_RULES, buildJiraUserContent } from './jira-prompt.utils';

export const summarizeJiraIssuePrompt: AiPromptDefinition = {
  action: AIAction.SUMMARIZE_JIRA_ISSUE,
  build: (input) => ({
    instructions: [
      'Summarize this Jira issue for a senior engineer.',
      'Use short sections: Goal, Problem/Context, Requested Behavior, Constraints, Important Details, Open Ambiguities.',
      'Do not repeat the full ticket. Do not invent missing requirements.',
      JIRA_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildJiraUserContent(input, 'Summarize this Jira issue for engineering.'),
      },
    ],
  }),
};
