import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  PromptSnapshot as PromptSnapshotRow,
  WorkflowExecution as ExecutionRow,
} from '@prisma/client';
import {
  RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION,
  RELIABILITY_MAX_LIST_EXECUTIONS,
  RELIABILITY_MAX_RETRY_ATTEMPTS,
  RELIABILITY_PROMPT_REGISTRY_NAME,
  RELIABILITY_STALE_AFTER_MS,
  buildArtifactLineage,
  buildExecutionSnapshot,
  classifyFailure,
  computeWorkflowHealthScore,
  createCheckpoint,
  createWorkflowExecutionId,
  decideRetry,
  detectContextDrift,
  emptyHealthSignals,
  hashBoundedInput,
  hashPromptContent,
  preparePromptSnapshotBody,
  redactForReliability,
  resolveNextPromptVersion,
  resumeFromCheckpoint,
  sanitizeSafeMetadata,
  truncateSafeText,
} from '@project-x/shared';
import type {
  AiRequestAuditSnapshot,
  AppendAuditEventRequest,
  CompleteExecutionRequest,
  CreateCheckpointRequest,
  ExecutionCheckpoint,
  ExecutionContextVersion,
  ExecutionHealthSignals,
  ListWorkflowExecutionsResponse,
  RecordAiRequestRequest,
  RecordArtifactLineageRequest,
  RecordFailureRequest,
  ReplayPreviewRequest,
  ReplayPreviewResponse,
  ResumeExecutionResponse,
  RetryExecutionRequest,
  RetryExecutionResponse,
  StartWorkflowExecutionRequest,
  WorkflowArtifactRef,
  WorkflowExecution,
  WorkflowExecutionDetail,
  WorkflowExecutionTrigger,
} from '@project-x/types';

import { MetricsService } from '../observability/metrics.service';
import { RequestContextService } from '../observability/request-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { reliabilityException } from './reliability.errors';
import { toCheckpoint, toExecutionDetail, toWorkflowExecution } from './reliability.mapper';

type ExecutionLoaded = ExecutionRow & {
  promptSnapshot?: PromptSnapshotRow | null;
};

/** Attempts to allocate an execution number when concurrent starts collide on it. */
const EXECUTION_NUMBER_ATTEMPTS = 5;
/** Running executions examined per stale sweep (one user's workspace view). */
const STALE_SWEEP_LIMIT = 50;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class ReliabilityService {
  private readonly logger = new Logger(ReliabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly requestContext?: RequestContextService,
  ) {}

  async listExecutions(userId: string): Promise<ListWorkflowExecutionsResponse> {
    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    await this.markStaleExecutions(userId, workspaceId);
    const rows = await this.prisma.workflowExecution.findMany({
      where: { workspaceId, userId },
      orderBy: { startedAt: 'desc' },
      take: RELIABILITY_MAX_LIST_EXECUTIONS,
      include: { promptSnapshot: true },
    });
    return { executions: rows.map(toWorkflowExecution) };
  }

  async getExecution(userId: string, executionId: string): Promise<WorkflowExecutionDetail> {
    let row = await this.requireExecution(userId, executionId);
    if (
      row.status === 'running' &&
      (await this.markStaleExecutions(userId, row.workspaceId, [row.id]))
    ) {
      row = await this.requireExecution(userId, executionId);
    }
    const [events, checkpoints, failures] = await Promise.all([
      this.prisma.workflowAuditEvent.findMany({
        where: { userId, executionId },
        orderBy: { timestamp: 'asc' },
        take: RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION,
      }),
      this.prisma.executionCheckpoint.findMany({
        where: { userId, executionId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.executionFailure.findMany({
        where: { userId, executionId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return toExecutionDetail(row, events, checkpoints, failures);
  }

  async startExecution(
    userId: string,
    input: StartWorkflowExecutionRequest,
  ): Promise<WorkflowExecution> {
    const trigger: WorkflowExecutionTrigger = input.trigger ?? 'user';
    const startedAt = new Date();
    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    const contextVersion = (input.contextVersion ?? {}) as ExecutionContextVersion;
    const snapshot = buildExecutionSnapshot({
      goal: input.goal,
      constraints: input.constraints,
      selectedRepositories: input.selectedRepositories,
      workflowCapability: input.workflowCapability,
      trigger,
    });

    let promptSnapshotId: string | undefined;
    if (input.promptBody) {
      const snap = await this.upsertPromptSnapshot(userId, workspaceId, {
        name: input.promptName ?? RELIABILITY_PROMPT_REGISTRY_NAME,
        rawBody: input.promptBody,
        capability: input.capability,
        action: input.action,
      });
      promptSnapshotId = snap.id;
      if (!contextVersion.promptVersion) {
        contextVersion.promptVersion = String(snap.version);
      }
      if (!contextVersion.promptHash) {
        contextVersion.promptHash = snap.hash;
      }
    }

    // Numbers are allocated under a per-workflow transaction lock (PostgreSQL advisory lock,
    // released at commit), so concurrent starts from any process are serialized and get
    // consecutive numbers. The unique (workspace, workflow, number) index stays the backstop:
    // a conflict is retried rather than surfacing as a 500.
    let created: ExecutionLoaded | null = null;
    for (let attempt = 0; created === null; attempt += 1) {
      try {
        created = await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${input.workflowId}))`;
          const executionNumber = await this.nextExecutionNumber(tx, workspaceId, input.workflowId);
          return this.createExecutionRow(tx, {
            id: createWorkflowExecutionId(),
            workspaceId,
            userId,
            executionNumber,
            trigger,
            startedAt,
            input,
            contextVersion,
            snapshot,
            ...(promptSnapshotId ? { promptSnapshotId } : {}),
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt + 1 >= EXECUTION_NUMBER_ATTEMPTS) throw error;
      }
    }
    const executionNumber = created.executionNumber;
    const id = created.id;

    await this.appendEventInternal(userId, created.id, created.workflowId, {
      type:
        trigger === 'replay'
          ? 'REPLAY_STARTED'
          : trigger === 'resume'
            ? 'RESUME_STARTED'
            : 'WORKFLOW_STARTED',
      message: `Execution #${executionNumber} started`,
      metadata: { trigger },
    });

    this.logger.log({
      msg: 'reliability.execution.started',
      executionId: id,
      workflowId: input.workflowId,
      trigger,
      requestId: this.requestContext?.get()?.requestId,
      traceId: this.requestContext?.get()?.traceId,
    });

    this.requestContext?.patch({
      executionId: id,
      workflowId: input.workflowId,
    });

    this.metrics?.recordWorkflowExecution({
      workflowType: input.workflowCapability ?? 'workflow',
      status: 'running',
    });

    return toWorkflowExecution(created);
  }

  /** Next number for a workflow, from persisted rows (correct across processes and restarts). */
  private async nextExecutionNumber(
    tx: PrismaRuntime.TransactionClient,
    workspaceId: string,
    workflowId: string,
  ): Promise<number> {
    const latest = await tx.workflowExecution.aggregate({
      where: { workspaceId, workflowId },
      _max: { executionNumber: true },
    });
    return (latest._max.executionNumber ?? 0) + 1;
  }

  private createExecutionRow(
    tx: PrismaRuntime.TransactionClient,
    args: {
      id: string;
      workspaceId: string;
      userId: string;
      executionNumber: number;
      trigger: WorkflowExecutionTrigger;
      startedAt: Date;
      input: StartWorkflowExecutionRequest;
      contextVersion: ExecutionContextVersion;
      snapshot: ReturnType<typeof buildExecutionSnapshot>;
      promptSnapshotId?: string;
    },
  ): Promise<ExecutionLoaded> {
    const { id, workspaceId, userId, executionNumber, trigger, startedAt, input } = args;
    const contextVersion = args.contextVersion;
    const snapshot = args.snapshot;
    const promptSnapshotId = args.promptSnapshotId;
    return tx.workflowExecution.create({
      data: {
        id,
        workspaceId,
        userId,
        workflowId: input.workflowId,
        executionNumber,
        trigger,
        status: 'running',
        healthScore: 100,
        healthBand: 'Excellent',
        startedAt,
        ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
        goal: truncateSafeText(redactForReliability(input.goal), 500),
        contextVersionJson: contextVersion as Prisma.InputJsonValue,
        snapshotJson: snapshot as unknown as Prisma.InputJsonValue,
        healthSignalsJson: emptyHealthSignals() as unknown as Prisma.InputJsonValue,
        aiRequestsJson: [] as unknown as Prisma.InputJsonValue,
        lineageJson: buildArtifactLineage({ artifacts: [] }) as unknown as Prisma.InputJsonValue,
        ...(promptSnapshotId ? { promptSnapshotId } : {}),
        resumeAvailable: false,
        replayAvailable: true,
      },
      include: { promptSnapshot: true },
    });
  }

  async appendAuditEvent(
    userId: string,
    executionId: string,
    input: AppendAuditEventRequest,
  ): Promise<WorkflowExecutionDetail> {
    const row = await this.requireExecution(userId, executionId);
    await this.appendEventInternal(userId, executionId, row.workflowId, input);
    return this.getExecution(userId, executionId);
  }

  async createCheckpoint(
    userId: string,
    executionId: string,
    input: CreateCheckpointRequest,
  ): Promise<ExecutionCheckpoint> {
    const row = await this.requireExecution(userId, executionId);
    if (row.status !== 'running') {
      throw reliabilityException(
        'INVALID_EXECUTION_STATE',
        'Checkpoints can only be created for running executions.',
      );
    }

    const checkpoint = createCheckpoint({
      id: `cp_${randomUUID().replace(/-/g, '')}`,
      kind: input.kind,
      label: input.label,
      createdAt: new Date().toISOString(),
      stepId: input.stepId,
      state: input.state ?? {},
    });

    const created = await this.prisma.executionCheckpoint.create({
      data: {
        id: checkpoint.id,
        workspaceId: row.workspaceId,
        userId,
        executionId,
        kind: checkpoint.kind,
        label: checkpoint.label,
        ...(checkpoint.stepId ? { stepId: checkpoint.stepId } : {}),
        stateJson: checkpoint.state as Prisma.InputJsonValue,
      },
    });

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { resumeAvailable: true },
    });

    await this.appendEventInternal(userId, executionId, row.workflowId, {
      type: 'CHECKPOINT_CREATED',
      stepId: input.stepId,
      message: input.label,
      metadata: { kind: input.kind },
    });

    return toCheckpoint(created);
  }

  async recordFailure(userId: string, executionId: string, input: RecordFailureRequest) {
    const row = await this.requireExecution(userId, executionId);
    const failure = classifyFailure({
      code: input.code,
      message: input.message,
      httpStatus: input.httpStatus,
      stage: input.stage,
    });
    if (input.metadata) {
      failure.metadata = sanitizeSafeMetadata(input.metadata);
    }

    await this.prisma.executionFailure.create({
      data: {
        workspaceId: row.workspaceId,
        userId,
        executionId,
        category: failure.category,
        retryable: failure.retryable,
        userMessage: failure.userMessage,
        technicalReason: failure.technicalReason,
        ...(failure.stage ? { stage: failure.stage } : {}),
        ...(failure.code ? { code: String(failure.code) } : {}),
        ...(failure.metadata ? { metadataJson: failure.metadata as Prisma.InputJsonValue } : {}),
      },
    });

    const signals = this.readSignals(row);
    signals.failedStages += 1;
    if (failure.category === 'TIMEOUT') signals.timeouts += 1;
    const health = computeWorkflowHealthScore(signals);

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        failureCount: { increment: 1 },
        healthSignalsJson: signals as unknown as Prisma.InputJsonValue,
        healthScore: health.score,
        healthBand: health.band,
        resumeAvailable: true,
        status: row.status === 'running' ? 'failed' : row.status,
        ...(row.status === 'running'
          ? {
              completedAt: new Date(),
              durationMs: Date.now() - row.startedAt.getTime(),
            }
          : {}),
      },
    });

    await this.appendEventInternal(userId, executionId, row.workflowId, {
      type: 'FAILURE_RECORDED',
      message: failure.userMessage,
      metadata: {
        category: failure.category,
        retryable: failure.retryable,
        stage: failure.stage,
      },
    });

    return failure;
  }

  async recordAiRequest(
    userId: string,
    executionId: string,
    input: RecordAiRequestRequest,
  ): Promise<AiRequestAuditSnapshot> {
    const row = await this.requireExecution(userId, executionId);
    const inputHash = hashBoundedInput(input.inputParts ?? [input.promptBody ?? '']);
    const outputHash = input.outputText ? hashPromptContent(input.outputText) : undefined;

    let promptHash: string | undefined;
    let promptVersion: string | undefined;
    if (input.promptBody) {
      const snap = await this.upsertPromptSnapshot(userId, row.workspaceId, {
        name:
          input.promptName ??
          (input.capability
            ? `prompt-registry:${input.capability}`
            : RELIABILITY_PROMPT_REGISTRY_NAME),
        rawBody: input.promptBody,
        capability: input.capability,
        action: input.action ?? input.capability,
      });
      promptHash = snap.hash;
      promptVersion = String(snap.version);

      if (!row.promptSnapshotId) {
        await this.prisma.workflowExecution.update({
          where: { id: executionId },
          data: { promptSnapshotId: snap.id },
        });
      }

      const ctx = row.contextVersionJson as ExecutionContextVersion;
      if (!ctx.promptVersion || !ctx.promptHash) {
        await this.prisma.workflowExecution.update({
          where: { id: executionId },
          data: {
            contextVersionJson: {
              ...ctx,
              promptVersion: ctx.promptVersion ?? promptVersion,
              promptHash: ctx.promptHash ?? promptHash,
              aiModel: ctx.aiModel ?? input.model,
              aiProvider: ctx.aiProvider ?? input.provider,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      }
    }

    const snapshot: AiRequestAuditSnapshot = {
      provider: input.provider,
      model: input.model,
      ...(input.temperature != null ? { temperature: input.temperature } : {}),
      ...(promptVersion ? { promptVersion } : {}),
      ...(promptHash ? { promptHash } : {}),
      ...(input.memoryVersion ? { memoryVersion: input.memoryVersion } : {}),
      ...(input.systemContextVersion ? { systemContextVersion: input.systemContextVersion } : {}),
      ...(input.openapiVersion ? { openapiVersion: input.openapiVersion } : {}),
      ...(input.jiraVersion ? { jiraVersion: input.jiraVersion } : {}),
      ...(input.workflowFactsVersion ? { workflowFactsVersion: input.workflowFactsVersion } : {}),
      ...(input.capability ? { capability: input.capability } : {}),
      inputHash,
      ...(outputHash ? { outputHash } : {}),
      ...(input.tokenUsage ? { tokenUsage: input.tokenUsage } : {}),
      ...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
      ...(input.firstTokenLatencyMs != null
        ? { firstTokenLatencyMs: input.firstTokenLatencyMs }
        : {}),
      ...(input.estimatedCostUsd != null ? { estimatedCostUsd: input.estimatedCostUsd } : {}),
      ...(input.pricingVersion ? { pricingVersion: input.pricingVersion } : {}),
      ...(input.retryCount != null ? { retryCount: input.retryCount } : {}),
      ...(input.traceId ? { traceId: input.traceId } : {}),
      ...(input.aiOperationId ? { aiOperationId: input.aiOperationId } : {}),
      ...(input.providerRequestId ? { providerRequestId: input.providerRequestId } : {}),
      status: input.status,
    };

    const existing = (row.aiRequestsJson as AiRequestAuditSnapshot[] | null) ?? [];
    const next = [...existing, snapshot].slice(-50);

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { aiRequestsJson: next as unknown as Prisma.InputJsonValue },
    });

    const eventType =
      input.status === 'started'
        ? 'AI_REQUEST_STARTED'
        : input.status === 'completed'
          ? 'AI_REQUEST_COMPLETED'
          : 'AI_REQUEST_FAILED';

    await this.appendEventInternal(userId, executionId, row.workflowId, {
      type: eventType,
      message: `${input.provider}/${input.model}`,
      metadata: {
        status: input.status,
        inputHash,
        ...(outputHash ? { outputHash } : {}),
        ...(promptVersion ? { promptVersion } : {}),
      },
    });

    return snapshot;
  }

  async recordArtifactLineage(
    userId: string,
    executionId: string,
    input: RecordArtifactLineageRequest,
  ): Promise<WorkflowExecutionDetail> {
    const row = await this.requireExecution(userId, executionId);
    const lineage = buildArtifactLineage({
      artifacts: input.artifacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        ...(a.summary ? { summary: truncateSafeText(redactForReliability(a.summary), 200) } : {}),
        ...(a.parentArtifactId ? { parentArtifactId: a.parentArtifactId } : {}),
        ...(a.producedByStepId ? { producedByStepId: a.producedByStepId } : {}),
      })),
    });

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        lineageJson: lineage as unknown as Prisma.InputJsonValue,
        artifactCount: lineage.nodes.length,
      },
    });

    for (const artifact of input.artifacts) {
      await this.appendEventInternal(userId, executionId, row.workflowId, {
        type: 'ARTIFACT_CREATED',
        artifactId: artifact.id,
        message: artifact.kind,
        metadata: {
          kind: artifact.kind,
          ...(artifact.parentArtifactId ? { parentArtifactId: artifact.parentArtifactId } : {}),
        },
      });
    }

    return this.getExecution(userId, executionId);
  }

  async completeExecution(
    userId: string,
    executionId: string,
    input: CompleteExecutionRequest,
  ): Promise<WorkflowExecution> {
    const row = await this.requireExecution(userId, executionId);
    const signals = {
      ...this.readSignals(row),
      ...(input.healthSignals ?? {}),
    } as ExecutionHealthSignals;
    if (input.status === 'cancelled') signals.cancelled = true;
    const health = computeWorkflowHealthScore(signals);
    const completedAt = new Date();

    let snapshotJson: Prisma.InputJsonValue | typeof row.snapshotJson = row.snapshotJson;
    if (input.snapshotArtifacts) {
      const base = row.snapshotJson as unknown as {
        goal?: string;
        constraints?: string[];
        selectedRepositories?: string[];
        workflowCapability?: string;
        checkpointIds?: string[];
      } | null;
      snapshotJson = buildExecutionSnapshot({
        goal: base?.goal ?? row.goal ?? '',
        constraints: base?.constraints,
        selectedRepositories: base?.selectedRepositories,
        workflowCapability: base?.workflowCapability,
        checkpointIds: base?.checkpointIds,
        artifactRefs: input.snapshotArtifacts as WorkflowArtifactRef[],
        trigger: row.trigger as WorkflowExecutionTrigger,
      }) as unknown as Prisma.InputJsonValue;
    }

    const updated = await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        status: input.status,
        completedAt,
        durationMs: completedAt.getTime() - row.startedAt.getTime(),
        healthSignalsJson: signals as unknown as Prisma.InputJsonValue,
        healthScore: health.score,
        healthBand: health.band,
        resumeAvailable: input.status === 'failed' || input.status === 'stale',
        ...(snapshotJson !== undefined && snapshotJson !== null
          ? { snapshotJson: snapshotJson as Prisma.InputJsonValue }
          : {}),
      },
      include: { promptSnapshot: true },
    });

    const eventType =
      input.status === 'completed'
        ? 'WORKFLOW_COMPLETED'
        : input.status === 'cancelled'
          ? 'WORKFLOW_CANCELLED'
          : 'WORKFLOW_FAILED';

    await this.appendEventInternal(userId, executionId, row.workflowId, {
      type: eventType,
      message: `Execution ${input.status}`,
      metadata: { healthScore: health.score, band: health.band },
    });

    const durationSeconds = (completedAt.getTime() - row.startedAt.getTime()) / 1000;
    this.metrics?.recordWorkflowExecution({
      workflowType:
        (row.snapshotJson as { workflowCapability?: string } | null)?.workflowCapability ??
        'workflow',
      status: input.status,
      durationSeconds,
    });
    if (input.status === 'stale') {
      this.metrics?.recordWorkflowStale();
      this.metrics?.recordStaleContext('workflow');
    }

    return toWorkflowExecution(updated);
  }

  async previewReplay(
    userId: string,
    executionId: string,
    input: ReplayPreviewRequest,
  ): Promise<ReplayPreviewResponse> {
    const row = await this.requireExecution(userId, executionId);
    if (!row.replayAvailable) {
      throw reliabilityException(
        'REPLAY_NOT_AVAILABLE',
        'Replay is not available for this execution.',
      );
    }
    const original = row.contextVersionJson as unknown as ExecutionContextVersion;
    const current = (input.currentContext ?? original) as ExecutionContextVersion;
    const drift = detectContextDrift(original, current);
    return {
      executionId,
      drift,
      canReplay: true,
      requiresWriteConfirmation: true,
    };
  }

  async replayExecution(
    userId: string,
    executionId: string,
    input: ReplayPreviewRequest,
  ): Promise<WorkflowExecution> {
    const preview = await this.previewReplay(userId, executionId, input);
    const original = await this.requireExecution(userId, executionId);
    const contextVersion = (input.currentContext ??
      (original.contextVersionJson as unknown as ExecutionContextVersion)) as ExecutionContextVersion;

    const started = await this.startExecution(userId, {
      workflowId: original.workflowId,
      goal: original.goal ?? 'Replay',
      trigger: 'replay',
      parentExecutionId: original.id,
      contextVersion,
    });

    if (original.promptSnapshotId) {
      await this.prisma.workflowExecution.update({
        where: { id: started.id },
        data: { promptSnapshotId: original.promptSnapshotId },
      });
    }

    await this.appendEventInternal(userId, started.id, started.workflowId, {
      type: 'REPLAY_STARTED',
      message: 'Replay execution created',
      metadata: {
        parentExecutionId: original.id,
        hasDrift: preview.drift.hasDrift,
        requiresWriteConfirmation: true,
      },
    });

    await this.appendEventInternal(userId, started.id, started.workflowId, {
      type: 'REPLAY_COMPLETED',
      message: preview.drift.hasDrift
        ? 'Replay started with context drift warning'
        : 'Replay started with matching context',
      metadata: {
        parentExecutionId: original.id,
        hasDrift: preview.drift.hasDrift,
        requiresWriteConfirmation: true,
      },
    });

    this.metrics?.recordWorkflowReplay();

    return this.getExecution(userId, started.id).then((d) => d);
  }

  async resumeExecution(userId: string, executionId: string): Promise<ResumeExecutionResponse> {
    const row = await this.requireExecution(userId, executionId);
    if (!row.resumeAvailable && row.status !== 'failed' && row.status !== 'stale') {
      throw reliabilityException(
        'RESUME_NOT_AVAILABLE',
        'No resumable checkpoint for this execution.',
      );
    }

    const checkpoints = await this.prisma.executionCheckpoint.findMany({
      where: { userId, executionId },
      orderBy: { createdAt: 'asc' },
    });
    const mapped = checkpoints.map(toCheckpoint);
    const resume = resumeFromCheckpoint(mapped);
    if (!resume.ok) {
      throw reliabilityException('CHECKPOINT_NOT_FOUND', resume.reason);
    }

    const started = await this.startExecution(userId, {
      workflowId: row.workflowId,
      goal: row.goal ?? 'Resume',
      trigger: 'resume',
      parentExecutionId: row.id,
      contextVersion: row.contextVersionJson as unknown as ExecutionContextVersion,
    });

    await this.prisma.executionCheckpoint.create({
      data: {
        id: `cp_${randomUUID().replace(/-/g, '')}`,
        workspaceId: row.workspaceId,
        userId,
        executionId: started.id,
        kind: resume.checkpoint.kind,
        label: `Resumed from ${resume.checkpoint.label}`,
        stateJson: {
          ...resume.checkpoint.state,
          resumedFromExecutionId: executionId,
          skipCompletedThrough: resume.skipCompletedThrough,
        } as Prisma.InputJsonValue,
      },
    });

    await this.appendEventInternal(userId, started.id, started.workflowId, {
      type: 'RESUME_COMPLETED',
      message: `Resumed from ${resume.checkpoint.kind}`,
      metadata: {
        parentExecutionId: executionId,
        skipCompletedThrough: resume.skipCompletedThrough,
      },
    });

    this.metrics?.recordWorkflowResume();

    return {
      execution: started,
      checkpoint: resume.checkpoint,
      skipCompletedThrough: resume.skipCompletedThrough,
    };
  }

  async retryExecution(
    userId: string,
    executionId: string,
    input: RetryExecutionRequest,
  ): Promise<RetryExecutionResponse> {
    const row = await this.requireExecution(userId, executionId);
    // The attempt number is the persisted retry count. `input.attempt` is accepted for API
    // compatibility but never trusted: a client cannot reset or forge its way past the cap.
    if (row.retryCount >= RELIABILITY_MAX_RETRY_ATTEMPTS) {
      throw this.retryLimitReached(row.retryCount);
    }
    const decision = decideRetry({
      stage: input.stage,
      category: input.category,
      attempt: row.retryCount,
      writeConfirmed: input.writeConfirmed,
      idempotentSafe: input.idempotentSafe,
    });

    if (!decision.allowed) {
      return { decision };
    }

    // Reserve the attempt atomically: concurrent requests cannot both pass the cap.
    const reserved = await this.prisma.workflowExecution.updateMany({
      where: {
        id: executionId,
        userId,
        workspaceId: row.workspaceId,
        retryCount: { lt: RELIABILITY_MAX_RETRY_ATTEMPTS },
      },
      data: { retryCount: { increment: 1 } },
    });
    if (reserved.count === 0) {
      throw this.retryLimitReached(RELIABILITY_MAX_RETRY_ATTEMPTS);
    }

    // The retry is a new child execution; the original keeps its final status (it is not
    // reopened, which previously left it `running` forever).
    const signals = this.readSignals(row);
    signals.retries += 1;
    const health = computeWorkflowHealthScore(signals);
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        healthSignalsJson: signals as unknown as Prisma.InputJsonValue,
        healthScore: health.score,
        healthBand: health.band,
      },
    });

    await this.appendEventInternal(userId, executionId, row.workflowId, {
      type: 'RETRY_STARTED',
      message: decision.reason,
      metadata: { stage: input.stage, category: input.category },
    });

    const child = await this.startExecution(userId, {
      workflowId: row.workflowId,
      goal: row.goal ?? 'Retry',
      trigger: 'retry',
      parentExecutionId: row.id,
      contextVersion: row.contextVersionJson as unknown as ExecutionContextVersion,
    });

    await this.appendEventInternal(userId, child.id, child.workflowId, {
      type: 'RETRY_COMPLETED',
      message: `Retry execution created for ${input.stage}`,
      metadata: { parentExecutionId: row.id, stage: input.stage },
    });

    this.metrics?.recordWorkflowRetry(input.category);

    return { decision, execution: child };
  }

  /** Optional hook from AI service — fire-and-forget safe. */
  async recordAiRequestBestEffort(
    userId: string,
    executionId: string | undefined,
    input: RecordAiRequestRequest,
  ): Promise<void> {
    if (!executionId) return;
    try {
      await this.recordAiRequest(userId, executionId, input);
    } catch (error) {
      // The AI request itself must not fail because auditing did, but the reason is logged:
      // a 404 means the execution is not this user's in this workspace (denied, not a bug).
      const status = error instanceof HttpException ? error.getStatus() : undefined;
      this.logger.warn({
        msg: status === 404 ? 'reliability.ai_audit.denied' : 'reliability.ai_audit.skipped',
        executionId,
        ...(status ? { status } : {}),
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private retryLimitReached(retryCount: number): HttpException {
    return reliabilityException(
      'RETRY_LIMIT_REACHED',
      `Retry limit reached (${RELIABILITY_MAX_RETRY_ATTEMPTS} attempts).`,
      { retryCount, maxRetries: RELIABILITY_MAX_RETRY_ATTEMPTS },
    );
  }

  /**
   * Mark this user's abandoned executions `stale`: `running`, and no server-recorded activity
   * (execution update or audit event, both server clocks) for RELIABILITY_STALE_AFTER_MS.
   * Runs lazily on reads — no background job. Idempotent and race-safe: the conditional
   * update only matches rows still `running` and still inactive, so concurrent sweeps record
   * one transition. Never fails, retries, replays or calls anything external; history is kept,
   * and a client that is in fact still active can still complete the execution normally.
   * Returns true when any execution was marked.
   */
  private async markStaleExecutions(
    userId: string,
    workspaceId: string,
    executionIds?: string[],
    now: Date = new Date(),
  ): Promise<boolean> {
    const cutoff = new Date(now.getTime() - RELIABILITY_STALE_AFTER_MS);
    const candidates = await this.prisma.workflowExecution.findMany({
      where: {
        workspaceId,
        userId,
        status: 'running',
        updatedAt: { lt: cutoff },
        ...(executionIds ? { id: { in: executionIds } } : {}),
      },
      select: { id: true, workflowId: true, startedAt: true },
      orderBy: { updatedAt: 'asc' },
      take: STALE_SWEEP_LIMIT,
    });
    let marked = false;
    for (const candidate of candidates) {
      const latestEvent = await this.prisma.workflowAuditEvent.findFirst({
        where: { executionId: candidate.id },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (latestEvent && latestEvent.createdAt >= cutoff) continue; // still active
      const lastActivity = latestEvent?.createdAt ?? candidate.startedAt;
      const result = await this.prisma.workflowExecution.updateMany({
        where: { id: candidate.id, userId, status: 'running', updatedAt: { lt: cutoff } },
        data: {
          status: 'stale',
          completedAt: now,
          durationMs: Math.max(0, lastActivity.getTime() - candidate.startedAt.getTime()),
          resumeAvailable: true,
        },
      });
      if (result.count !== 1) continue; // another sweep (or the client) got there first
      marked = true;
      this.metrics?.recordWorkflowStale();
      try {
        await this.appendEventInternal(userId, candidate.id, candidate.workflowId, {
          type: 'WORKFLOW_ABANDONED',
          message: 'No activity recorded; marked stale',
          metadata: { staleAfterHours: RELIABILITY_STALE_AFTER_MS / 3_600_000 },
        });
      } catch {
        // Audit limit reached: the status change itself is the record.
      }
    }
    return marked;
  }

  /**
   * Prompt versions are content-addressed per workspace — the same scope as the database's
   * unique (workspace, name, hash) constraint. Looking them up per user made a second member
   * using the same prompt hit that constraint, and their AI audit was silently dropped.
   * Snapshot bodies are never returned by the API (only name / version / hash), so sharing
   * a version row across members exposes nothing; `userId` stays the first recorder.
   */
  private async upsertPromptSnapshot(
    userId: string,
    workspaceId: string,
    input: {
      name: string;
      rawBody: string;
      capability?: string;
      action?: string;
    },
  ): Promise<{ id: string; version: number; hash: string }> {
    const prepared = preparePromptSnapshotBody(input.rawBody);
    const hash = hashPromptContent(input.rawBody);
    for (let attempt = 0; ; attempt += 1) {
      const existing = await this.prisma.promptSnapshot.findMany({
        where: { workspaceId, name: input.name },
        select: { id: true, hash: true, version: true },
        orderBy: { version: 'desc' },
        take: 100,
      });
      const match =
        existing.find((row) => row.hash === hash) ??
        (await this.prisma.promptSnapshot.findFirst({
          where: { workspaceId, name: input.name, hash },
          select: { id: true, hash: true, version: true },
        }));
      if (match) {
        return { id: match.id, version: match.version, hash: match.hash };
      }
      const resolved = resolveNextPromptVersion(existing, hash);
      try {
        const created = await this.prisma.promptSnapshot.create({
          data: {
            workspaceId,
            userId,
            name: input.name,
            version: resolved.version,
            hash,
            body: prepared.body,
            truncated: prepared.truncated,
            redacted: prepared.redacted,
            ...(input.capability ? { capability: input.capability } : {}),
            ...(input.action ? { action: input.action } : {}),
          },
        });
        return { id: created.id, version: created.version, hash: created.hash };
      } catch (error) {
        // A concurrent recorder created the same version: read it on the next pass.
        if (!isUniqueViolation(error) || attempt >= 2) throw error;
      }
    }
  }

  private async appendEventInternal(
    userId: string,
    executionId: string,
    workflowId: string,
    input: AppendAuditEventRequest,
  ): Promise<void> {
    const count = await this.prisma.workflowAuditEvent.count({ where: { executionId } });
    if (count >= RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION) {
      throw reliabilityException(
        'AUDIT_LIMIT_REACHED',
        `Audit event limit (${RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION}) reached.`,
      );
    }

    const metadata = sanitizeSafeMetadata(input.metadata);
    const execution = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, userId },
      select: { workspaceId: true },
    });
    const workspaceId =
      execution?.workspaceId ?? (await resolveWorkspaceIdForUser(this.prisma, userId));
    await this.prisma.workflowAuditEvent.create({
      data: {
        workspaceId,
        userId,
        executionId,
        workflowId,
        type: input.type,
        timestamp: input.timestamp ? new Date(input.timestamp) : new Date(),
        ...(input.stepId ? { stepId: input.stepId } : {}),
        ...(input.artifactId ? { artifactId: input.artifactId } : {}),
        ...(input.message
          ? { message: truncateSafeText(redactForReliability(input.message), 500) }
          : {}),
        ...(metadata ? { metadataJson: metadata as Prisma.InputJsonValue } : {}),
      },
    });
  }

  private async requireExecution(userId: string, executionId: string): Promise<ExecutionLoaded> {
    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    const row = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, workspaceId, userId },
      include: { promptSnapshot: true },
    });
    if (!row) {
      throw reliabilityException('EXECUTION_NOT_FOUND', 'Workflow execution not found.');
    }
    return row;
  }

  private readSignals(row: ExecutionRow): ExecutionHealthSignals {
    const raw = row.healthSignalsJson as ExecutionHealthSignals | null;
    return raw ? { ...emptyHealthSignals(), ...raw } : emptyHealthSignals();
  }
}
