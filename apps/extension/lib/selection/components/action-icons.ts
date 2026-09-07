import { AIAction } from '@project-x/types';

import type { ComponentType, SVGProps } from 'react';

import {
  CodeIcon,
  ExplainIcon,
  ImproveIcon,
  PromptIcon,
  SummarizeIcon,
  TranslateIcon,
} from './icons';

export const ACTION_ICONS: Record<AIAction, ComponentType<SVGProps<SVGSVGElement>>> = {
  [AIAction.EXPLAIN]: ExplainIcon,
  [AIAction.IMPROVE_WRITING]: ImproveIcon,
  [AIAction.SUMMARIZE]: SummarizeIcon,
  [AIAction.TRANSLATE]: TranslateIcon,
  [AIAction.EXPLAIN_CODE]: CodeIcon,
  [AIAction.CUSTOM]: PromptIcon,
};
