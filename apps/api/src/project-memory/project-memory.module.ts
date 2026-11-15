import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubModule } from '../github/github.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { ProjectMemoryAuditController } from './audit/project-memory-audit.controller';
import { ProjectMemoryAuditService } from './audit/project-memory-audit.service';
import { ProjectMemoryController } from './project-memory.controller';
import { ProjectMemoryService } from './project-memory.service';

@Module({
  imports: [AuthModule, SettingsModule, GithubModule, WorkspacesModule],
  controllers: [ProjectMemoryController, ProjectMemoryAuditController],
  providers: [ProjectMemoryService, ProjectMemoryAuditService],
  exports: [ProjectMemoryService],
})
export class ProjectMemoryModule {}
