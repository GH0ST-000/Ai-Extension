import { AIAction } from '@project-x/types';

import type { AiPromptDefinition } from '../interfaces/ai-prompt-definition.interface';
import {
  BASE_RULES,
  formatPageContext,
  wrapCustomInstruction,
  wrapSelectedText,
} from './prompt.utils';

const INSTRUCTIONS = [
  'Propose a minimal corrected version of the selected code or diff hunk.',
  'Fix the concrete issue only — do not refactor unrelated code or invent APIs/files.',
  'If CMD contains prior review findings, address those findings; otherwise infer the issue from SEL/CTX.',
  'Output format (strict):',
  '1) One short "Issue:" line.',
  '2) One short "Why:" line.',
  '3) A single fenced code block with the corrected snippet only (no unified diff markers unless SEL was a diff).',
  '4) Optional one-line "Note:" after the fence.',
  'Do not wrap the whole answer in extra prose outside that shape.',
  BASE_RULES,
].join(' ');

export const suggestFixPrompt: AiPromptDefinition = {
  action: AIAction.SUGGEST_FIX,
  build: (input) => {
    const finding = input.customPrompt?.trim() ?? '';
    const contextBlock = formatPageContext(input.context, input.text);
    const parts = [
      'Suggest a minimal fix for SEL.',
      finding ? wrapCustomInstruction(finding) : null,
      contextBlock,
      wrapSelectedText(input.text),
    ].filter(Boolean);

    return {
      instructions: INSTRUCTIONS,
      messages: [
        {
          role: 'user',
          content: parts.join('\n'),
        },
      ],
    };
  },
};
