import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import type {
  PrReviewHistoryPage,
  PrReviewHistoryPersistence,
  PrReviewReportDetail,
} from '@project-x/types';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { RequireWorkspacePermission } from '../workspaces/workspace.decorators';
import { WorkspaceGuard } from '../workspaces/workspace.guard';
import {
  LatestPrReviewQueryDto,
  ListPrReviewHistoryQueryDto,
} from './dto/pr-review-history-query.dto';
import { PrReviewHistoryService } from './pr-review-history.service';

/** Report ids: cuid (no slashes, bounded). Anything else is "not found" without a query. */
const REPORT_ID = /^[a-z0-9]{10,64}$/i;
/** Server-generated operation ids are UUIDs. */
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read-only PR review history. Every route: authenticated, workspace member with
 * `workspace:read` (every role), plus current repository access (service). No route calls
 * the AI, charges usage or writes to GitHub.
 */
@Controller('workspaces/:workspaceId/pr-reviews')
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@RequireWorkspacePermission('workspace:read')
export class PrReviewHistoryController {
  constructor(private readonly history: PrReviewHistoryService) {}

  @Get()
  list(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: ListPrReviewHistoryQueryDto,
  ): Promise<PrReviewHistoryPage> {
    return this.history.list(user.id, workspaceId, query);
  }

  /** Latest report for one PR; `{ report: null }` when the PR has no history. */
  @Get('latest')
  async latest(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Query() query: LatestPrReviewQueryDto,
  ): Promise<{ report: PrReviewReportDetail | null }> {
    const report = await this.history.latest(
      user.id,
      workspaceId,
      query.owner,
      query.repository,
      query.pullRequestNumber,
    );
    return { report };
  }

  /**
   * Was the caller's own review operation saved? Answered from PostgreSQL (never assumed), so a
   * client can show "saved to history" truthfully after a streamed review. Initiator only.
   */
  @Get('operations/:operationId')
  operation(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('operationId') operationId: string,
  ): Promise<PrReviewHistoryPersistence> {
    if (!OPERATION_ID.test(operationId)) {
      return Promise.resolve({ status: 'not_saved' });
    }
    return this.history.operationStatus(user.id, workspaceId, operationId);
  }

  @Get(':reportId')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('workspaceId') workspaceId: string,
    @Param('reportId') reportId: string,
  ): Promise<PrReviewReportDetail> {
    return this.history.get(user.id, workspaceId, REPORT_ID.test(reportId) ? reportId : '-');
  }
}
