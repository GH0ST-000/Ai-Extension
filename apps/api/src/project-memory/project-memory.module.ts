import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProjectMemoryController } from './project-memory.controller';
import { ProjectMemoryService } from './project-memory.service';

@Module({
  imports: [AuthModule, SettingsModule, GithubModule, WorkspacesModule],
  controllers: [ProjectMemoryController],
  providers: [ProjectMemoryService],
  exports: [ProjectMemoryService],
})
export class ProjectMemoryModule {}
