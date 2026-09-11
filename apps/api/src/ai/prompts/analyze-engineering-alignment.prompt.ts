import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { ENGINEERING_BASE_RULES, buildEngineeringUserContent } from './engineering-prompt.utils';

export const analyzeEngineeringAlignmentPrompt: AiPromptDefinition = {
  action: AIAction.ANALYZE_ENGINEERING_ALIGNMENT,
  build: (input) => ({
    instructions: [
      'Analyze cross-context engineering alignment across the provided Jira, GitHub PR, OpenAPI, and optional CI slices.',
      'Respond with JSON only (no markdown fences) matching:',
      '{"overview":"...","alignment":"strong|partial|weak|conflicting|uncertain","requirementCoverage":[{"criterionId":"...","criterion":"...","criterionSource":"description|comment|inferred","status":"covered|partial|not-evident|conflicting|uncertain","evidence":[{"source":"jira|github-diff|github-finding|openapi|ci","label":"...","reference":{"issueKey":"...","criterionId":"...","filePath":"...","line":1,"operationId":"...","method":"...","path":"...","responseCode":"...","checkId":"...","findingId":"..."},"excerpt":"..."}],"notes":"...","confidence":"high|medium|low"}],"implementationObservations":[{"observation":"...","kind":"beyond-scope|implementation|other","evidence":[...],"confidence":"high|medium|low"}],"contractAlignment":[{"aspect":"...","status":"covered|partial|not-evident|conflicting|uncertain","evidence":[...],"notes":"...","confidence":"high|medium|low"}],"crossContextConflicts":[{"id":"...","severity":"high|medium|low","sources":["jira|github-pr|github-review|openapi|ci"],"title":"...","description":"...","evidence":[...],"recommendation":"..."}],"risks":[{"severity":"high|medium|low","title":"...","description":"...","evidence":[...],"kind":"fact|potential|recommendation"}],"openQuestions":["..."],"scope":{"partial":true,"limitations":["..."]}}',
      'Do not invent evidence. Cite only paths, criteria, operations, and checks present in the prompt.',
      'When context is truncated or only partially loaded, set scope.partial=true, list limitations, and prefer not-evident over covered.',
      'Do not equate "not evident in provided materials" with "definitely unimplemented" unless evidence is strong.',
      'Keep explicit vs inferred criteria distinct in requirementCoverage.criterionSource.',
      'Every coverage / conflict / risk claim that asserts a fact should include confidence high|medium|low.',
      ENGINEERING_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildEngineeringUserContent(
          input,
          'Analyze engineering alignment across the provided contexts. Return JSON only.',
        ),
      },
    ],
  }),
};
