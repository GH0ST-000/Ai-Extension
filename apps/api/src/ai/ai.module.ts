import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubAppModule } from '../github-app/github-app.module';
import { ProjectMemoryModule } from '../project-memory/project-memory.module';
import { ReliabilityModule } from '../reliability/reliability.module';
import { SettingsModule } from '../settings/settings.module';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiModelFactory } from './models/ai-model.factory';
import { PullRequestDiffService } from './pr-review/pull-request-diff.service';
import { PromptRegistry } from './prompts/prompt.registry';

@Module({
  imports: [
    AuthModule,
    SettingsModule,
    GithubAppModule,
    forwardRef(() => ReliabilityModule),
    // ProjectMemoryModule → GithubModule → AiModule closes a cycle.
    forwardRef(() => ProjectMemoryModule),
  ],
  controllers: [AiController],
  providers: [AiService, PromptRegistry, AiModelFactory, PullRequestDiffService],
  exports: [AiService],
})
export class AiModule {}
