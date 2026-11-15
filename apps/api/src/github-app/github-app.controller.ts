import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { RequireWorkspacePermission } from '../workspaces/workspace.decorators';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import { VerifyGithubAppInstallDto } from './dto/verify-github-app-install.dto';
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

  /**
   * Final step of linking: the signed-in Owner/Admin hands over GitHub's authorization `code`
   * and the verification `state`. The service links the installation only if the state was
   * issued to this user for this workspace and GitHub confirms the user controls it.
   */
  @Post('verify')
  @HttpCode(200)
  @RequireWorkspacePermission('integrations:manage')
  verify(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: AuthRequestUser,
    @Body() body: VerifyGithubAppInstallDto,
  ) {
    return this.installations.completeOwnershipVerification({
      code: body.code,
      state: body.state,
      userId: user.id,
      workspaceId,
    });
  }

  @Delete()
  @HttpCode(204)
  @RequireWorkspacePermission('integrations:manage')
  async disconnect(@Param('workspaceId') workspaceId: string) {
    await this.installations.disconnectWorkspace(workspaceId);
  }
}
