import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { JIRA_BASE_RULES, buildJiraUserContent } from './jira-prompt.utils';

export const compareJiraWithPrPrompt: AiPromptDefinition = {
  action: AIAction.COMPARE_JIRA_WITH_PR,
  build: (input) => ({
    instructions: [
      'Compare the Jira requirement with the provided PR/diff/review context.',
      'Respond with JSON only (no markdown fences) matching:',
      '{"alignment":"strong|partial|weak|uncertain","overview":"...","coveredRequirements":[{"requirement":"...","status":"covered|partial|not-evident|uncertain","evidence":[{"kind":"file|diff|finding|pr-description|other","path":"...","note":"..."}],"notes":"..."}],"missingOrUnclearRequirements":[...],"implementationBeyondScope":[{"observation":"...","evidence":"..."}],"acceptanceCriteriaCoverage":[{"criterion":"...","source":"description|comment|inferred|unknown","status":"covered|partial|not-evident|uncertain","notes":"..."}],"risks":[{"severity":"high|medium|low","text":"...","kind":"known|potential|question"}],"openQuestions":["..."]}',
      'Do not fabricate file/line evidence. Prefer not-evident/uncertain over false missing claims.',
      'If PR scope is truncated/partial, say so in overview and avoid overclaiming coverage.',
      'Do not equate "not evident in provided diff" with "definitely not implemented" unless evidence is strong.',
      JIRA_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildJiraUserContent(
          input,
          'Compare Jira requirements with PR context. Return JSON only.',
        ),
      },
    ],
  }),
};
