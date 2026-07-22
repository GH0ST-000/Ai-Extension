import type { ComponentType, SVGProps } from 'react';

import type { AiActionId } from '../types';
import {
  CodeIcon,
  ExplainIcon,
  ImproveIcon,
  PromptIcon,
  SummarizeIcon,
  TranslateIcon,
} from './icons';

export const ACTION_ICONS: Record<AiActionId, ComponentType<SVGProps<SVGSVGElement>>> = {
  explain: ExplainIcon,
  'improve-writing': ImproveIcon,
  summarize: SummarizeIcon,
  translate: TranslateIcon,
  'explain-code': CodeIcon,
  'custom-prompt': PromptIcon,
};
