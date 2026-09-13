import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { EntitlementsModule } from '../entitlements/entitlements.module';
import { UsageModule } from '../usage/usage.module';
import { WorkspaceInvitationsService } from './invitations.service';
import { WorkspaceMembersService } from './members.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { WorkspaceGuard } from './workspace.guard';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [AuthModule, EntitlementsModule, UsageModule, BillingModule],
  controllers: [WorkspacesController],
  providers: [
    WorkspacesService,
    WorkspaceAuthorizationService,
    WorkspaceGuard,
    WorkspaceMembersService,
    WorkspaceInvitationsService,
  ],
  exports: [WorkspacesService, WorkspaceAuthorizationService, WorkspaceGuard],
})
export class WorkspacesModule {}
