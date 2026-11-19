import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type {
  AiRequestAuditSnapshot,
  ExecutionCheckpoint,
  ListWorkflowExecutionsResponse,
  NormalizedExecutionFailure,
  ReplayPreviewResponse,
  ResumeExecutionResponse,
  RetryExecutionResponse,
  WorkflowExecution,
  WorkflowExecutionDetail,
} from '@project-x/types';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import {
  RateLimit,
  RateLimitGuard,
  type RateLimitPolicy,
} from '../common/security/rate-limit.guard';
import {
  AppendAuditEventDto,
  CompleteExecutionDto,
  CreateCheckpointDto,
  RecordAiRequestDto,
  RecordArtifactLineageDto,
  RecordFailureDto,
  ReplayPreviewDto,
  RetryExecutionDto,
  StartWorkflowExecutionDto,
} from './dto/reliability.dto';
import { ReliabilityService } from './reliability.service';

/**
 * Per-user limits (existing Redis guard; fails open if Redis is unavailable, like other
 * non-auth buckets). Reads (list / detail) are not limited.
 * - start: a new execution per workflow run (the extension starts one per approved plan).
 * - recovery: retry / resume / replay each create a child execution.
 * - audit: events, checkpoints, failures, AI audit, lineage, complete — a workflow run sends
 *   a few per step and is additionally capped at 200 audit events per execution.
 */
export const RELIABILITY_RATE_LIMITS = {
  start: { bucket: 'workflow_start', limit: 30, windowSeconds: 60 },
  recovery: { bucket: 'workflow_recovery', limit: 10, windowSeconds: 60 },
  audit: { bucket: 'workflow_audit', limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitPolicy>;

@Controller('reliability')
@UseGuards(JwtAuthGuard, RateLimitGuard)
export class ReliabilityController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get('executions')
  list(@CurrentUser() user: AuthRequestUser): Promise<ListWorkflowExecutionsResponse> {
    return this.reliability.listExecutions(user.id);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.start)
  @Post('executions')
  start(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: StartWorkflowExecutionDto,
  ): Promise<WorkflowExecution> {
    return this.reliability.startExecution(user.id, body);
  }

  @Get('executions/:executionId')
  get(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
  ): Promise<WorkflowExecutionDetail> {
    return this.reliability.getExecution(user.id, executionId);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/events')
  appendEvent(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: AppendAuditEventDto,
  ): Promise<WorkflowExecutionDetail> {
    return this.reliability.appendAuditEvent(user.id, executionId, body);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/checkpoints')
  checkpoint(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: CreateCheckpointDto,
  ): Promise<ExecutionCheckpoint> {
    return this.reliability.createCheckpoint(user.id, executionId, body);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/failures')
  failure(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RecordFailureDto,
  ): Promise<NormalizedExecutionFailure> {
    return this.reliability.recordFailure(user.id, executionId, body);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/ai-requests')
  aiRequest(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RecordAiRequestDto,
  ): Promise<AiRequestAuditSnapshot> {
    return this.reliability.recordAiRequest(user.id, executionId, body);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/lineage')
  lineage(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RecordArtifactLineageDto,
  ): Promise<WorkflowExecutionDetail> {
    return this.reliability.recordArtifactLineage(user.id, executionId, {
      artifacts: body.artifacts.map((a) => ({
        id: a.id,
        kind: a.kind as WorkflowExecutionDetail['lineage']['nodes'][number]['kind'],
        ...(a.summary ? { summary: a.summary } : {}),
        ...(a.parentArtifactId ? { parentArtifactId: a.parentArtifactId } : {}),
        ...(a.producedByStepId ? { producedByStepId: a.producedByStepId } : {}),
      })),
    });
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/complete')
  complete(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: CompleteExecutionDto,
  ): Promise<WorkflowExecution> {
    return this.reliability.completeExecution(user.id, executionId, {
      status: body.status,
      ...(body.healthSignals ? { healthSignals: body.healthSignals as never } : {}),
      ...(body.snapshotArtifacts ? { snapshotArtifacts: body.snapshotArtifacts as never } : {}),
    });
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.audit)
  @Post('executions/:executionId/replay/preview')
  replayPreview(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: ReplayPreviewDto,
  ): Promise<ReplayPreviewResponse> {
    return this.reliability.previewReplay(user.id, executionId, {
      currentContext: body.currentContext as ReplayPreviewDto['currentContext'] & object,
    });
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.recovery)
  @Post('executions/:executionId/replay')
  replay(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: ReplayPreviewDto,
  ): Promise<WorkflowExecution> {
    return this.reliability.replayExecution(user.id, executionId, {
      currentContext: body.currentContext as ReplayPreviewDto['currentContext'] & object,
    });
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.recovery)
  @Post('executions/:executionId/resume')
  resume(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
  ): Promise<ResumeExecutionResponse> {
    return this.reliability.resumeExecution(user.id, executionId);
  }

  @RateLimit(RELIABILITY_RATE_LIMITS.recovery)
  @Post('executions/:executionId/retry')
  retry(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RetryExecutionDto,
  ): Promise<RetryExecutionResponse> {
    return this.reliability.retryExecution(user.id, executionId, body);
  }
}
