import { Module } from '@nestjs/common';

import { GithubAppModule } from '../github-app/github-app.module';
import { ContractImpactService } from './contract-impact.service';

/** Deterministic cross-repository contract impact (no AI, no usage). */
@Module({
  imports: [GithubAppModule],
  providers: [ContractImpactService],
  exports: [ContractImpactService],
})
export class ContractImpactModule {}
