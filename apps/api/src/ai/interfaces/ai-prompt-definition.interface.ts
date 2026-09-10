import type { AIAction, ErrorIntelligenceContext, PageContext } from '@project-x/types';
import type { ModelMessage } from 'ai';

export interface AiActionRequest {
  action: AIAction;
  text: string;
  customPrompt?: string | null;
  targetLanguage?: string | null;
  context?: PageContext | null;
  errorIntelligence?: ErrorIntelligenceContext | null;
}

export interface AiPromptBuildResult {
  /** System-level instructions for Vercel AI SDK (`instructions` option). */
  instructions: string;
  /** Conversation messages — must not include `system` roles (AI SDK v7). */
  messages: ModelMessage[];
}

export interface AiPromptDefinition {
  action: AIAction;
  build: (input: AiActionRequest) => AiPromptBuildResult;
}
