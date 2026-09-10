import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { JiraConnectionService } from './jira-connection.service';
import { JiraController } from './jira.controller';
import { JiraErrorNormalizer } from './jira-error-normalizer';
import { JiraIssueService } from './jira-issue.service';

@Module({
  imports: [AuthModule],
  controllers: [JiraController],
  providers: [JiraConnectionService, JiraIssueService, JiraErrorNormalizer],
  exports: [JiraConnectionService, JiraIssueService],
})
export class JiraModule {}
