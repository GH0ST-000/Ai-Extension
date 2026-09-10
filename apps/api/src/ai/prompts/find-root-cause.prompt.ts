import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import { ERROR_BASE_RULES, buildErrorUserContent } from './prompt.utils';

const INSTRUCTIONS = [
  'Identify the most likely root cause from the provided evidence only.',
  'Structure the answer as: Likely root cause → Evidence → Suggested next check.',
  'Use calibrated wording: confirmed / likely / possible / insufficient context.',
  'When evidence is weak, say so explicitly and list what would help.',
  'Never claim certainty without direct evidence. Never invent code or files.',
  'Connect the error message to nearby code or stack frames when they match.',
  ERROR_BASE_RULES,
].join(' ');

export const findRootCausePrompt: AiPromptDefinition = {
  action: AIAction.FIND_ROOT_CAUSE,
  build: (input) => ({
    instructions: INSTRUCTIONS,
    messages: [
      {
        role: 'user',
        content: buildErrorUserContent(
          input,
          'Find the root cause of this error from the evidence. Calibrate confidence.',
        ),
      },
    ],
  }),
};
