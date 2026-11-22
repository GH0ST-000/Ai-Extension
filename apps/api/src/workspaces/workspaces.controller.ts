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
  AcceptWorkspaceInvitationResponse,
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
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
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
import { AllowWorkspaceStatuses, RequireWorkspacePermission } from './workspace.decorators';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesService } from './workspaces.service';
import type { FreeWorkspaceUsage } from './workspace-limits';
import {
  DELETION_ALLOWED_STATUSES,
  type PendingWorkspaceDeletion,
  WorkspaceDeletionService,
} from './workspace-deletion.service';

/** N-10: new workspaces per user per day (atomic Redis counter, bounded local fallback). */
export const WORKSPACE_CREATE_LIMIT = {
  bucket: 'workspace_create',
  limit: 3,
  windowSeconds: 24 * 60 * 60,
};

@Controller()
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly members: WorkspaceMembersService,
    private readonly invitations: WorkspaceInvitationsService,
    private readonly usage: UsageService,
    private readonly billing: BillingService,
    private readonly deletion: WorkspaceDeletionService,
  ) {}

  @Get('workspaces/bootstrap')
  bootstrap(
    @CurrentUser() user: AuthRequestUser,
    @Headers('x-workspace-id') workspaceHeader?: string,
  ): Promise<WorkspaceBootstrapResponse> {
    return this.workspaces.bootstrap(user.id, workspaceHeader?.trim() || undefined);
  }

  /**
   * N-2: workspaces the caller owns that are pending deletion (not shown as normal workspaces
   * anywhere else), with their billing-cancellation state. Retry with DELETE /workspaces/:id.
   */
  @Get('workspaces/pending-deletions')
  pendingDeletions(@CurrentUser() user: AuthRequestUser): Promise<PendingWorkspaceDeletion[]> {
    return this.deletion.listPendingDeletions(user.id);
  }

  /** Decision B: free-workspace usage of the caller (limit, used, can create). */
  @Get('workspaces/limits')
  limits(@CurrentUser() user: AuthRequestUser): Promise<FreeWorkspaceUsage> {
    return this.workspaces.freeWorkspaceUsage(user.id);
  }

  @Get('workspaces')
  list(@CurrentUser() user: AuthRequestUser): Promise<Workspace[]> {
    return this.workspaces.listForUser(user.id);
  }

  /**
   * N-10: workspace creation is rate limited per user (each new workspace starts with its own
   * free AI quota). A hard cap on workspaces per user is a product decision (not set here).
   */
  @Post('workspaces')
  @HttpCode(201)
  @RateLimit(WORKSPACE_CREATE_LIMIT)
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

  /**
   * 204 when the workspace is deleted (also when it already was: idempotent). 502
   * BILLING_CANCELLATION_FAILED when the billing provider could not confirm the cancellation:
   * the workspace then stays `deletion_pending` (unusable) and the owner retries.
   */
  @Delete('workspaces/:workspaceId')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('workspace:delete')
  @AllowWorkspaceStatuses(...DELETION_ALLOWED_STATUSES)
  async remove(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<void> {
    await this.deletion.deleteWorkspace(workspaceId, user.id);
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
  @RateLimit({ bucket: 'invite', limit: 20, windowSeconds: 60 })
  invite(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Body() body: InviteWorkspaceMemberDto,
  ): Promise<WorkspaceInvitation> {
    return this.invitations.createInvitation(workspaceId, user.id, body);
  }

  /** Pending invitations (Owners/Admins). No tokens or token hashes are ever returned. */
  @Get('workspaces/:workspaceId/invitations')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:invite')
  listInvitations(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
  ): Promise<WorkspaceInvitation[]> {
    return this.invitations.listInvitations(workspaceId, user.id);
  }

  /** Revokes a pending invitation of this workspace. Idempotent (204 when already revoked). */
  @Delete('workspaces/:workspaceId/invitations/:invitationId')
  @HttpCode(204)
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('members:invite')
  @RateLimit({ bucket: 'invite', limit: 20, windowSeconds: 60 })
  async revokeInvitation(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await this.invitations.revokeInvitation(workspaceId, user.id, invitationId);
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

  /**
   * 200 with `alreadyMember: true` (and the unchanged membership) when the user already belongs
   * to the workspace: an invitation never changes an existing role.
   */
  @Post('workspace-invitations/:token/accept')
  acceptInvitation(
    @CurrentUser() user: AuthRequestUser,
    @Param('token') token: string,
  ): Promise<AcceptWorkspaceInvitationResponse> {
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
  @RateLimit({ bucket: 'billing', limit: 10, windowSeconds: 60 })
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
  @RateLimit({ bucket: 'billing', limit: 10, windowSeconds: 60 })
  createPortal(@Param('workspaceId') workspaceId: string): Promise<BillingPortalResponse> {
    return this.billing.createPortal(workspaceId);
  }

  @Post('workspaces/:workspaceId/billing/cancel')
  @UseGuards(WorkspaceGuard)
  @RequireWorkspacePermission('billing:manage')
  @RateLimit({ bucket: 'billing', limit: 10, windowSeconds: 60 })
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
