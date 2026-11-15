import { Controller, Get, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import type {
  ProjectMemoryAuditEvent,
  ProjectMemoryAuditPage,
  ProjectMemoryAuditRulePage,
} from '@project-x/types';

import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../../auth/jwt.strategy';
import { RequireWorkspacePermission } from '../../workspaces/workspace.decorators';
import { WorkspaceGuard } from '../../workspaces/workspace.guard';
import {
  ListProjectMemoryAuditQueryDto,
  ListProjectMemoryAuditRulesQueryDto,
} from './project-memory-audit-query.dto';
import { ProjectMemoryAuditService } from './project-memory-audit.service';

const EVENT_ID = /^[a-z0-9]{1,64}$/i;

/**
 * Read-only Project Memory audit log. Same boundary as reading memory: authenticated member
 * with `memory:read` (live membership check) and the PROJECT_MEMORY feature. There are no
 * write endpoints: events are only created inside memory mutations.
 */
@Controller('workspaces/:workspaceId/memory/audit')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@RequireWorkspacePermission('memory:read')
export class ProjectMemoryAuditController {
  constructor(private readonly audit: ProjectMemoryAuditService) {}

  @Get()
  list(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListProjectMemoryAuditQueryDto,
  ): Promise<ProjectMemoryAuditPage> {
    return this.audit.list(user.id, workspaceId, query);
  }

  /** One row per memory rule, newest activity first (declared before `:eventId`). */
  @Get('rules')
  listRules(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListProjectMemoryAuditRulesQueryDto,
  ): Promise<ProjectMemoryAuditRulePage> {
    return this.audit.listRules(user.id, workspaceId, query);
  }

  @Get(':eventId')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('eventId') eventId: string,
  ): Promise<ProjectMemoryAuditEvent> {
    if (!EVENT_ID.test(eventId)) throw new NotFoundException('Audit event not found.');
    return this.audit.get(user.id, workspaceId, eventId);
  }
}
