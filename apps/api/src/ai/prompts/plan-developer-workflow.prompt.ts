import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { WORKFLOW_BASE_RULES, buildWorkflowPlannerUserContent } from './workflow-prompt.utils';

export const planDeveloperWorkflowPrompt: AiPromptDefinition = {
  action: AIAction.PLAN_DEVELOPER_WORKFLOW,
  build: (input) => ({
    instructions: [
      'Plan a safe multi-step developer workflow for the user goal using only allowlisted capabilities.',
      'Respond with JSON only (no markdown fences) matching DeveloperWorkflowPlan:',
      '{"id":"...","goal":"...","summary":"...","steps":[{"id":"...","type":"...","title":"...","description":"...","reason":"...","dependencies":[],"requiredContext":["jira|github|api|ci"],"executionMode":"AUTO_READ|USER_DECISION|EXPLICIT_CONFIRMATION","mutationRisk":"NONE|LOW|WRITE","status":"PENDING","condition":{"type":"ALWAYS|HAS_HIGH_FINDINGS|...","negate":false}}],"estimatedScope":{"aiCalls":1,"providerReads":1,"writeCheckpoints":0},"warnings":["..."],"assumptions":["..."],"completionCriteria":[{"type":"ANALYSIS_PRESENTED","artifactType":"ci-analysis"}],"confidence":"HIGH|MEDIUM|LOW"}',
      'Only use step types present in the capability catalog text in the user content.',
      'Every step.status must be PENDING. Dependencies must reference earlier step ids only; no cycles.',
      'Include concise step.reason (user-visible, never chain-of-thought). Include assumptions and completionCriteria when possible.',
      'APPLY_PATCH requires PREPARE_PATCH earlier; SUBMIT_PR_REVIEW requires CREATE_REVIEW_DRAFT; SUBMIT_PR_COMMENT requires GENERATE_PR_COMMENT.',
      'Write steps (APPLY_PATCH, SUBMIT_PR_COMMENT, SUBMIT_PR_REVIEW) stay EXPLICIT_CONFIRMATION + WRITE — never AUTO_READ.',
      'Preference order: REUSE existing fresh artifacts > FETCH > AI ANALYZE > WRITE. Prefer the smallest useful plan.',
      'Forbidden: merge, shell, jira write, API execution, CI re-run, deploy, force-push. Never emit merge or shell steps.',
      'Never choose a review event (APPROVE / REQUEST_CHANGES / COMMENT) for the user — do not include USER_SELECT_REVIEW_EVENT unless the goal explicitly requires submitting a review and the event must be chosen by the user.',
      'Emit 3–10 steps. Prefer short reusable plans over exhaustive chains.',
      'Planning only — do not execute or claim execution.',
      WORKFLOW_BASE_RULES,
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: buildWorkflowPlannerUserContent(
          input,
          'Produce a DeveloperWorkflowPlan JSON for the goal and available context. Return JSON only.',
        ),
      },
    ],
  }),
};
