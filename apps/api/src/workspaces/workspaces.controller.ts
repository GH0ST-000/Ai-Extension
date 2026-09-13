import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  BillingCheckoutResponse,
  BillingPortalResponse,
  Workspace,
  WorkspaceBillingView,
  WorkspaceBootstrapResponse,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceUsageCounter,
} from '@project-x/types';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { UsageService } from '../usage/usage.service';
import { BillingService } from '../billing/billing.service';
import {
  ChangeWorkspaceMemberRoleDto,
  CreateCheckoutDto,
  CreateWorkspaceDto,
  InviteWorkspaceMemberDto,
  TransferWorkspaceOwnershipDto,
  UpdateWorkspaceDto,
} from './dto/workspaces.dto';
import { WorkspaceInvitationsService } from './invitations.service';
import { WorkspaceMembersService } from './members.service';
import { RequireWorkspacePermission } from './workspace.decorators';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';

@Controller()
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly members: WorkspaceMembersService,
    private readonly invitations: WorkspaceInvitationsService,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
  ) {}

  @Get('workspaces/bootstrap')
  bootstrap(
    @CurrentUser() user: AuthRequestUser,
    @Headers('x-workspace-id') workspaceHeader?: string,
  ): Promise<WorkspaceBootstrapResponse> {
    return this.workspaces.bootstrap(user.id, workspaceHeader?.trim() || undefined);
  }

  @Get('workspaces')
  list(@CurrentUser() user: AuthRequestUser): Promise<Workspace[]> {
    return this.workspaces.listForUser(user.id);
  }

  @Post('workspaces')
  @HttpCode(201)
  create(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: CreateWorkspaceDto,
  ): Promise<Workspace> {
    return this.workspaces.create(user.id, body);
  }

  @Get('workspaces/:workspaceId')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('workspace:read')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<Workspace> {
    return this.workspaces.get(workspaceId, user.id);
  }

  @Patch('workspaces/:workspaceId')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('workspace:update')
  update(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: UpdateWorkspaceDto,
  ): Promise<Workspace> {
    return this.workspaces.update(workspaceId, user.id, body);
  }

  @Delete('workspaces/:workspaceId')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('workspace:delete')
  async remove(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<void> {
    await this.workspaces.softDelete(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/transfer-ownership')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('workspace:delete')
  async transfer(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: TransferWorkspaceOwnershipDto,
  ): Promise<void> {
    await this.workspaces.transferOwnership(workspaceId, user.id, body);
  }

  @Get('workspaces/:workspaceId/members')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:read')
  listMembers(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceMembership[]> {
    return this.members.listMembers(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/invitations')
  @HttpCode(201)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:invite')
  invite(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: InviteWorkspaceMemberDto,
  ): Promise<WorkspaceInvitation> {
    return this.invitations.createInvitation(workspaceId, user.id, body);
  }

  @Patch('workspaces/:workspaceId/members/:membershipId')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:manage')
  changeRole(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('membershipId') membershipId: string,
    @Body() body: ChangeWorkspaceMemberRoleDto,
  ): Promise<WorkspaceMembership> {
    return this.members.changeRole(workspaceId, user.id, membershipId, body);
  }

  @Delete('workspaces/:workspaceId/members/:membershipId')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:manage')
  async removeMember(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('membershipId') membershipId: string,
  ): Promise<void> {
    await this.members.removeMember(workspaceId, user.id, membershipId);
  }

  @Post('workspace-invitations/:token/accept')
  acceptInvitation(
    @CurrentUser() user: AuthRequestUser,
    @Param('token') token: string,
  ): Promise<WorkspaceMembership> {
    return this.invitations.acceptInvitation(token, user.id);
  }

  @Get('workspaces/:workspaceId/usage')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:read')
  getUsage(@Param('workspaceId') workspaceId: string): Promise<WorkspaceUsageCounter[]> {
    return this.usage.getUsageCounters(workspaceId);
  }

  @Get('workspaces/:workspaceId/billing')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:read')
  getBilling(@Param('workspaceId') workspaceId: string): Promise<WorkspaceBillingView> {
    return this.billing.getBillingView(workspaceId);
  }

  @Post('workspaces/:workspaceId/billing/checkout')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:manage')
  createCheckout(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: CreateCheckoutDto,
  ): Promise<BillingCheckoutResponse> {
    return this.billing.createCheckout(workspaceId, user.email, body);
  }

  @Post('workspaces/:workspaceId/billing/portal')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:manage')
  createPortal(@Param('workspaceId') workspaceId: string): Promise<BillingPortalResponse> {
    return this.billing.createPortal(workspaceId);
  }

  @Post('workspaces/:workspaceId/billing/cancel')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:manage')
  cancelSubscription(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceBillingView> {
    return this.billing.cancel(workspaceId, user.id);
  }

  @Post('workspaces/:workspaceId/billing/refresh')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:manage')
  refreshBilling(@Param('workspaceId') workspaceId: string): Promise<WorkspaceBillingView> {
    return this.billing.refresh(workspaceId);
  }
}
