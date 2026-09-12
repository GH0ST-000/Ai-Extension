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

@Controller('reliability')
@UseGuards(JwtAuthGuard)
export class ReliabilityController {
  constructor(private readonly reliability: ReliabilityService) {}

  @Get('executions')
  list(@CurrentUser() user: AuthRequestUser): Promise<ListWorkflowExecutionsResponse> {
    return this.reliability.listExecutions(user.id);
  }

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

  @Post('executions/:executionId/events')
  appendEvent(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: AppendAuditEventDto,
  ): Promise<WorkflowExecutionDetail> {
    return this.reliability.appendAuditEvent(user.id, executionId, body);
  }

  @Post('executions/:executionId/checkpoints')
  checkpoint(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: CreateCheckpointDto,
  ): Promise<ExecutionCheckpoint> {
    return this.reliability.createCheckpoint(user.id, executionId, body);
  }

  @Post('executions/:executionId/failures')
  failure(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RecordFailureDto,
  ): Promise<NormalizedExecutionFailure> {
    return this.reliability.recordFailure(user.id, executionId, body);
  }

  @Post('executions/:executionId/ai-requests')
  aiRequest(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RecordAiRequestDto,
  ): Promise<AiRequestAuditSnapshot> {
    return this.reliability.recordAiRequest(user.id, executionId, body);
  }

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

  @Post('executions/:executionId/resume')
  resume(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
  ): Promise<ResumeExecutionResponse> {
    return this.reliability.resumeExecution(user.id, executionId);
  }

  @Post('executions/:executionId/retry')
  retry(
    @CurrentUser() user: AuthRequestUser,
    @Param('executionId') executionId: string,
    @Body() body: RetryExecutionDto,
  ): Promise<RetryExecutionResponse> {
    return this.reliability.retryExecution(user.id, executionId, body);
  }
}
