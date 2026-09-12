import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  PromptSnapshot as PromptSnapshotRow,
  WorkflowExecution as ExecutionRow,
} from '@prisma/client';
import {
  RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION,
  RELIABILITY_MAX_LIST_EXECUTIONS,
  RELIABILITY_PROMPT_REGISTRY_NAME,
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
  nextExecutionNumber,
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

import { PrismaService } from '../prisma/prisma.service';
import { reliabilityException } from './reliability.errors';
import { toCheckpoint, toExecutionDetail, toWorkflowExecution } from './reliability.mapper';

type ExecutionLoaded = ExecutionRow & {
  promptSnapshot?: PromptSnapshotRow | null;
};

@Injectable()
export class ReliabilityService {
  private readonly logger = new Logger(ReliabilityService.name);

  constructor(private readonly prisma: PrismaService) {}

  async listExecutions(userId: string): Promise<ListWorkflowExecutionsResponse> {
    const rows = await this.prisma.workflowExecution.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: RELIABILITY_MAX_LIST_EXECUTIONS,
      include: { promptSnapshot: true },
    });
    return { executions: rows.map(toWorkflowExecution) };
  }

  async getExecution(userId: string, executionId: string): Promise<WorkflowExecutionDetail> {
    const row = await this.requireExecution(userId, executionId);
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
    const existingCount = await this.prisma.workflowExecution.count({
      where: { userId, workflowId: input.workflowId },
    });
    const executionNumber = nextExecutionNumber(existingCount);
    const id = createWorkflowExecutionId();
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
      const snap = await this.upsertPromptSnapshot(userId, {
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

    const created = await this.prisma.workflowExecution.create({
      data: {
        id,
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
    });

    return toWorkflowExecution(created);
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
      const snap = await this.upsertPromptSnapshot(userId, {
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
    const decision = decideRetry({
      stage: input.stage,
      category: input.category,
      attempt: input.attempt ?? row.retryCount,
      writeConfirmed: input.writeConfirmed,
      idempotentSafe: input.idempotentSafe,
    });

    if (!decision.allowed) {
      return { decision };
    }

    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: { retryCount: { increment: 1 } },
    });

    const signals = this.readSignals(row);
    signals.retries += 1;
    const health = computeWorkflowHealthScore(signals);
    await this.prisma.workflowExecution.update({
      where: { id: executionId },
      data: {
        healthSignalsJson: signals as unknown as Prisma.InputJsonValue,
        healthScore: health.score,
        healthBand: health.band,
        status: 'running',
        completedAt: null,
        durationMs: null,
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
      this.logger.warn({
        msg: 'reliability.ai_audit.skipped',
        executionId,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private async upsertPromptSnapshot(
    userId: string,
    input: {
      name: string;
      rawBody: string;
      capability?: string;
      action?: string;
    },
  ): Promise<{ id: string; version: number; hash: string }> {
    const prepared = preparePromptSnapshotBody(input.rawBody);
    const hash = hashPromptContent(input.rawBody);
    const existing = await this.prisma.promptSnapshot.findMany({
      where: { userId, name: input.name },
      select: { id: true, hash: true, version: true },
      orderBy: { version: 'desc' },
      take: 100,
    });
    const match = existing.find((row) => row.hash === hash);
    if (match) {
      return { id: match.id, version: match.version, hash: match.hash };
    }
    const resolved = resolveNextPromptVersion(existing, hash);
    const created = await this.prisma.promptSnapshot.create({
      data: {
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
    await this.prisma.workflowAuditEvent.create({
      data: {
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
    const row = await this.prisma.workflowExecution.findFirst({
      where: { id: executionId, userId },
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
