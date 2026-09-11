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
  [AIAction.ANALYZE_CI_FAILURE]: ReviewIcon,
  [AIAction.SUMMARIZE_JIRA_ISSUE]: SummarizeIcon,
  [AIAction.EXTRACT_ACCEPTANCE_CRITERIA]: ReviewIcon,
  [AIAction.CREATE_TECHNICAL_PLAN]: CodeIcon,
  [AIAction.ANALYZE_JIRA_RISKS]: ExplainIcon,
  [AIAction.COMPARE_JIRA_WITH_PR]: PrReviewIcon,
  [AIAction.EXPLAIN_API_ENDPOINT]: ExplainIcon,
  [AIAction.EXPLAIN_API_REQUEST]: CodeIcon,
  [AIAction.EXPLAIN_API_RESPONSE]: CodeIcon,
  [AIAction.GENERATE_API_EXAMPLE]: FixIcon,
  [AIAction.ANALYZE_API_CONTRACT]: ReviewIcon,
  [AIAction.COMPARE_API_WITH_JIRA]: PrReviewIcon,
  [AIAction.ANALYZE_API_CHANGES]: ReviewIcon,
  [AIAction.CUSTOM]: PromptIcon,
};
