import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractImpactModule } from '../contract-impact/contract-impact.module';
import { GithubAppModule } from '../github-app/github-app.module';
import { PrReviewHistoryModule } from '../pr-review-history/pr-review-history.module';
import { ProjectMemoryModule } from '../project-memory/project-memory.module';
import { ReliabilityModule } from '../reliability/reliability.module';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelFactory } from './models/ai-model.factory';
import { PrReviewOrchestrator } from './pr-review/pr-review-orchestrator.service';
import { PrReviewImpactService } from './pr-review/pr-review-impact.service';
import { PullRequestDiffService } from './pr-review/pull-request-diff.service';
import { PromptRegistry } from './prompts/prompt.registry';

@Module({
  imports: [
    AuthModule,
    SettingsModule,
    GithubAppModule,
    ContractImpactModule,
    PrReviewHistoryModule,
    forwardRef(() => ReliabilityModule),
    // ProjectMemoryModule → GithubModule → AiModule closes a cycle.
    forwardRef(() => ProjectMemoryModule),
  ],
  controllers: [AiController],
  providers: [
    AiService,
    PromptRegistry,
    AiModelFactory,
    PullRequestDiffService,
    PrReviewOrchestrator,
    PrReviewImpactService,
  ],
  exports: [AiService],
})
export class AiModule {}
