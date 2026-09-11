import { BadRequestException, Injectable } from '@nestjs/common';
import { AIAction } from '@project-x/types';

import type {
  AiActionRequest,
  AiPromptBuildResult,
  AiPromptDefinition,
} from '../interfaces/ai-prompt-definition.interface';
import { analyzeApiChangesPrompt } from './analyze-api-changes.prompt';
import { analyzeApiContractPrompt } from './analyze-api-contract.prompt';
import { analyzeCiFailurePrompt } from './analyze-ci-failure.prompt';
import { analyzeEngineeringAlignmentPrompt } from './analyze-engineering-alignment.prompt';
import { analyzeJiraRisksPrompt } from './analyze-jira-risks.prompt';
import { compareApiWithJiraPrompt } from './compare-api-with-jira.prompt';
import { compareJiraWithPrPrompt } from './compare-jira-with-pr.prompt';
import { createTechnicalPlanPrompt } from './create-technical-plan.prompt';
import { customPrompt } from './custom.prompt';
import { explainApiEndpointPrompt } from './explain-api-endpoint.prompt';
import { explainApiRequestPrompt } from './explain-api-request.prompt';
import { explainApiResponsePrompt } from './explain-api-response.prompt';
import { explainCodePrompt } from './explain-code.prompt';
import { explainPrompt } from './explain.prompt';
import { extractAcceptanceCriteriaPrompt } from './extract-acceptance-criteria.prompt';
import { findRootCausePrompt } from './find-root-cause.prompt';
import { generateApiExamplePrompt } from './generate-api-example.prompt';
import { improveWritingPrompt } from './improve-writing.prompt';
import { planDeveloperWorkflowPrompt } from './plan-developer-workflow.prompt';
import { reviewCodePrompt } from './review-code.prompt';
import { reviewEntirePrPrompt } from './review-entire-pr.prompt';
import { suggestFixPrompt } from './suggest-fix.prompt';
import { summarizeJiraIssuePrompt } from './summarize-jira-issue.prompt';
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
      summarizeJiraIssuePrompt,
      extractAcceptanceCriteriaPrompt,
      createTechnicalPlanPrompt,
      analyzeJiraRisksPrompt,
      compareJiraWithPrPrompt,
      explainApiEndpointPrompt,
      explainApiRequestPrompt,
      explainApiResponsePrompt,
      generateApiExamplePrompt,
      analyzeApiContractPrompt,
      compareApiWithJiraPrompt,
      analyzeApiChangesPrompt,
      analyzeEngineeringAlignmentPrompt,
      planDeveloperWorkflowPrompt,
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
