import { Module } from '@nestjs/common';

import { AiModule } from '../ai/ai.module';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { GithubController } from './github.controller';
import { GithubCiService } from './github-ci.service';
import { GithubContentService } from './github-content.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { GithubPatchService } from './github-patch.service';
import { GithubReviewService } from './github-review.service';
import { GithubWriteService } from './github-write.service';

@Module({
  imports: [AuthModule, SettingsModule, AiModule],
  controllers: [GithubController],
  providers: [
    GithubWriteService,
    GithubReviewService,
    GithubPatchService,
    GithubCiService,
    GithubContentService,
    GithubErrorNormalizer,
  ],
  exports: [GithubContentService, GithubErrorNormalizer],
})
export class GithubModule {}
