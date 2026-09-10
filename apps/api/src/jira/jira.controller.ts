import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { JiraIssueService } from './jira-issue.service';

@Controller('jira')
@UseGuards(JwtAuthGuard)
export class JiraController {
  constructor(private readonly jiraIssueService: JiraIssueService) {}

  @Get('issues/:issueKey')
  getIssue(
    @CurrentUser() user: AuthRequestUser,
    @Param('issueKey') issueKey: string,
    @Query('host') host?: string,
  ) {
    return this.jiraIssueService.getIssue(user.id, issueKey, host);
  }
}
