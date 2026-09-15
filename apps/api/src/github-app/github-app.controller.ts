import { Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { RequireWorkspacePermission } from '../workspaces/workspace.decorators';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { GithubAppInstallationService } from './github-app-installation.service';

@Controller('workspaces/:workspaceId/integrations/github-app')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
export class GithubAppController {
  constructor(private readonly installations: GithubAppInstallationService) {}

  @Get('status')
  @RequireWorkspacePermission('integrations:read')
  getStatus(@Param('workspaceId') workspaceId: string) {
    return this.installations.getStatusForWorkspace(workspaceId);
  }

  @Post('install')
  @RequireWorkspacePermission('integrations:manage')
  startInstall(@Param('workspaceId') workspaceId: string, @CurrentUser() user: AuthRequestUser) {
    return this.installations.startInstall(workspaceId, user.id);
  }

  @Delete()
  @HttpCode(204)
  @RequireWorkspacePermission('integrations:manage')
  async disconnect(@Param('workspaceId') workspaceId: string) {
    await this.installations.disconnectWorkspace(workspaceId);
  }
}
