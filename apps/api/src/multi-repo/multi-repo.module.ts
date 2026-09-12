import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { ProjectMemoryModule } from '../project-memory/project-memory.module';
import { SettingsModule } from '../settings/settings.module';
import { MultiRepoController } from './multi-repo.controller';
import { MultiRepoService } from './multi-repo.service';

@Module({
  imports: [AuthModule, SettingsModule, GithubModule, ProjectMemoryModule],
  controllers: [MultiRepoController],
  providers: [MultiRepoService],
  exports: [MultiRepoService],
})
export class MultiRepoModule {}
