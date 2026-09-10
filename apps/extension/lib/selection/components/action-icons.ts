import { AIAction } from '@project-x/types';

import type { ComponentType, SVGProps } from 'react';

import {
  CodeIcon,
  ExplainIcon,
  FixIcon,
  ImproveIcon,
  PromptIcon,
  PrReviewIcon,
  ReviewIcon,
  SummarizeIcon,
  TranslateIcon,
} from './icons';

export const ACTION_ICONS: Record<AIAction, ComponentType<SVGProps<SVGSVGElement>>> = {
  [AIAction.EXPLAIN]: ExplainIcon,
  [AIAction.IMPROVE_WRITING]: ImproveIcon,
  [AIAction.SUMMARIZE]: SummarizeIcon,
  [AIAction.TRANSLATE]: TranslateIcon,
  [AIAction.EXPLAIN_CODE]: CodeIcon,
  [AIAction.REVIEW_CODE]: ReviewIcon,
  [AIAction.SUGGEST_FIX]: FixIcon,
  [AIAction.REVIEW_ENTIRE_PR]: PrReviewIcon,
  [AIAction.UNDERSTAND_ERROR]: ExplainIcon,
  [AIAction.FIND_ROOT_CAUSE]: ReviewIcon,
  [AIAction.CUSTOM]: PromptIcon,
};
