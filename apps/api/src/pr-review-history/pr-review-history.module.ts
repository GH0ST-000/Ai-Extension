import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ContractImpactModule } from '../contract-impact/contract-impact.module';
import { GithubAppModule } from '../github-app/github-app.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { PrReviewHistoryController } from './pr-review-history.controller';
import { PrReviewHistoryService } from './pr-review-history.service';

@Module({
  imports: [AuthModule, GithubAppModule, WorkspacesModule, ContractImpactModule],
  controllers: [PrReviewHistoryController],
  providers: [PrReviewHistoryService],
  exports: [PrReviewHistoryService],
})
export class PrReviewHistoryModule {}
