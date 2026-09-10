import { BadRequestException, Injectable } from '@nestjs/common';
import { AIAction } from '@project-x/types';

import type {
  AiActionRequest,
  AiPromptBuildResult,
  AiPromptDefinition,
} from '../interfaces/ai-prompt-definition.interface';
import { customPrompt } from './custom.prompt';
import { analyzeCiFailurePrompt } from './analyze-ci-failure.prompt';
import { explainCodePrompt } from './explain-code.prompt';
import { explainPrompt } from './explain.prompt';
import { findRootCausePrompt } from './find-root-cause.prompt';
import { improveWritingPrompt } from './improve-writing.prompt';
import { reviewCodePrompt } from './review-code.prompt';
import { reviewEntirePrPrompt } from './review-entire-pr.prompt';
import { suggestFixPrompt } from './suggest-fix.prompt';
import { summarizePrompt } from './summarize.prompt';
import { translatePrompt } from './translate.prompt';
import { understandErrorPrompt } from './understand-error.prompt';

@Injectable()
export class PromptRegistry {
  private readonly prompts: ReadonlyMap<AIAction, AiPromptDefinition>;

  constructor() {
    const definitions: AiPromptDefinition[] = [
      explainPrompt,
      improveWritingPrompt,
      summarizePrompt,
      translatePrompt,
      explainCodePrompt,
      reviewCodePrompt,
      suggestFixPrompt,
      reviewEntirePrPrompt,
      understandErrorPrompt,
      findRootCausePrompt,
      analyzeCiFailurePrompt,
      customPrompt,
    ];

    this.prompts = new Map(definitions.map((definition) => [definition.action, definition]));
  }

  build(input: AiActionRequest): AiPromptBuildResult {
    const definition = this.prompts.get(input.action);
    if (!definition) {
      throw new BadRequestException(`Unsupported AI action: ${String(input.action)}`);
    }

    return definition.build(input);
  }

  has(action: AIAction): boolean {
    return this.prompts.has(action);
  }

  listActions(): AIAction[] {
    return [...this.prompts.keys()];
  }
}
