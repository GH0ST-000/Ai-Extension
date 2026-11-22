import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateText, streamText } from 'ai';
import { createHash, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { ApiConfig } from '../config/configuration';
import { FeatureGate } from '../entitlements/feature-gate';
import { featureForAiAction, usageMetricForAiAction } from '../entitlements/feature-for-ai-action';
import { AiObservabilityService } from '../observability/ai-observability.service';
import { ProviderHealthService } from '../observability/provider-health.service';
import { RequestContextService } from '../observability/request-context.service';
import { ReliabilityService } from '../reliability/reliability.service';
import { SettingsService } from '../settings/settings.service';
import { UsageService, withRetry, type UsageReservation } from '../usage/usage.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecuteAiActionDto } from './dto/execute-ai-action.dto';
import type { AiActionRequest } from './interfaces/ai-prompt-definition.interface';
import { AiModelFactory } from './models/ai-model.factory';
import { PromptRegistry } from './prompts/prompt.registry';
import { neutralizeProjectMemoryMarkers, responseStyleHint } from './prompts/prompt.utils';
import {
  estimateAiCost,
  memoryCapabilityForAiAction,
  redactSensitiveString,
  toRepositoryIdentity,
} from '@project-x/shared';
import {
  AIAction,
  PR_REVIEW_INCOMPLETE_MARKER,
  PR_REVIEW_SCOPE_HEADER,
  PROJECT_MEMORY_METADATA_HEADER,
  type PageContextGitHub,
  type PrReviewDownstreamImpact,
  type PRReviewCoverage,
  type PrReviewHistoryPersistence,
  type PRReviewScope,
  type ProjectMemoryPromptMetadata,
  type ProjectMemorySkipReason,
  AI_OPERATION_ID_HEADER,
  AI_OPERATION_REPLAYED_HEADER,
} from '@project-x/types';
import { PrReviewHistoryService } from '../pr-review-history/pr-review-history.service';
import { ProjectMemoryService } from '../project-memory/project-memory.service';
import {
  batchPromptOverheadChars,
  type BatchPromptContext,
} from './pr-review/pr-review-batch.prompt';
import { buildCoverage, scopeFromPlan } from './pr-review/pr-review-coverage';
import type { FileContentProvider } from './pr-review/pr-review-context';
import { DEP_MAX_REQUESTS_PER_REVIEW } from './pr-review/pr-review-deps';
import { computeRiskLevel } from './pr-review/pr-review-findings';
import {
  PrReviewOrchestrator,
  type PrReviewRunResult,
} from './pr-review/pr-review-orchestrator.service';
import {
  DEFAULT_PR_REVIEW_LIMITS,
  planPrReview,
  sanitizeLimits,
  type PrReviewLimits,
  type PrReviewPlan,
} from './pr-review/pr-review-plan';
import { renderPrReview } from './pr-review/pr-review-render';
import { renderDownstreamImpactSection } from './pr-review/pr-review-impact-render';
import {
  PrReviewImpactService,
  type PrReviewImpactInput,
} from './pr-review/pr-review-impact.service';
import { PullRequestDiffService } from './pr-review/pull-request-diff.service';
import {
  redactDiffFilesForAi,
  redactErrorMessageForLog,
  redactFileProviderForAi,
  redactPlanForAi,
  sanitizeProviderPrompt,
} from './ai-redaction';

export interface AiTextStreamHandle {
  pipeTextStreamToResponse: (response: ServerResponse) => Promise<void>;
}

type StreamTextHandle = ReturnType<typeof streamText>;

/** Trailer appended to a PR review that ended before the model finished normally. */
export function prReviewIncompleteTrailer(reason: string): string {
  return `\n\n${PR_REVIEW_INCOMPLETE_MARKER} reason=${reason}]]`;
}

/** Keep-alive interval while a batched PR review runs (see pipePrReview). */
const PR_REVIEW_HEARTBEAT_MS = 10_000;

/**
 * In-band failure body once a streamed review has committed its headers: no findings, an
 * explicit "not reviewed" section, and the incomplete marker so no client shows it as clean.
 */
export const PR_REVIEW_FAILED_TEXT = [
  '## Summary',
  'The PR review could not be completed: every AI review batch failed. No usage was charged. Try again in a moment.',
  '',
  '## Risk Findings',
  'Not reviewed.',
  `${PR_REVIEW_INCOMPLETE_MARKER} reason=error]]`,
].join('\n');

/**
 * Same body when the unit WAS charged (F-06: the review ran model calls and this user's daily
 * refund budget for such failures is spent) — it must not claim otherwise.
 */
export const PR_REVIEW_FAILED_CHARGED_TEXT = PR_REVIEW_FAILED_TEXT.replace(
  ' No usage was charged.',
  '',
);

/**
 * F-07: structured JSON actions need room to finish their object. The per-user response-length
 * setting (down to 150 tokens) would truncate it — an unparsable, refunded result every time.
 */
const STRUCTURED_OUTPUT_MIN_TOKENS = 1_500;

/** Used when config predates the PR review overrides (e.g. hand-built test config). */
const DEFAULT_PR_REVIEW_MAX_OUTPUT_TOKENS = 4_096;
const DEFAULT_PR_REVIEW_TIMEOUT_MS = 120_000;

type LoadedProjectMemory = {
  block?: string;
  version?: string;
  metadata: ProjectMemoryPromptMetadata;
};

/**
 * base64url(UTF-8 JSON) so rule titles in any language are header-safe. Only the rules the
 * requester was authorized to read and that were actually placed in the prompt.
 */
export function encodeProjectMemoryMetadata(metadata: ProjectMemoryPromptMetadata): string {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url');
}

type ResolvedAiRun = {
  request: AiActionRequest;
  /** Set for REVIEW_ENTIRE_PR: the diff scope actually sent to the model. */
  reviewScope?: PRReviewScope;
  /** Set for memory-aware actions: rules applied, or why none were. */
  memoryMetadata?: ProjectMemoryPromptMetadata;
  instructions: string;
  messages: ReturnType<PromptRegistry['build']>['messages'];
  maxOutputTokens: number;
  requestTimeoutMs: number;
  workspaceId: string;
  /** Server-created usage reservation; committed when output is delivered, else refunded. */
  reservation?: UsageReservation;
  /** A lost-response retry of a completed operation: its stored result (no AI, no charge). */
  replay?: StoredResult;
  /** Client linkage for reliability audit only — never part of billing identity. */
  executionId?: string;
  promptName: string;
  contextVersions: {
    memoryVersion?: string;
    systemContextVersion?: string;
    openapiVersion?: string;
    jiraVersion?: string;
  };
};

/** A REVIEW_ENTIRE_PR run resolved and authorized, ready for the batched orchestrator. */
/** Deadline of the deterministic downstream impact analysis (runs alongside the batches). */
const PR_IMPACT_BUDGET_MS = 45_000;

type PrReviewRun = {
  request: AiActionRequest;
  workspaceId: string;
  plan: PrReviewPlan;
  context: BatchPromptContext;
  limits: PrReviewLimits;
  memoryBlock?: string;
  memoryMetadata?: ProjectMemoryPromptMetadata;
  /** Usage reservation for this review (absent when no AI call is needed: never charged). */
  reservation?: UsageReservation;
  /** How the reservation ended (unset while it is still open). */
  settled?: 'committed' | 'released';
  /** A lost-response retry of a completed review: its stored result (no AI, no charge). */
  replay?: StoredResult;
  executionId?: string;
  /** PR head the diff was loaded at (absent for the page fallback). */
  headSha?: string;
  contextVersions: ResolvedAiRun['contextVersions'];
  /** Read-only code context loader at the PR head (GitHub API source only). */
  fileProvider?: FileContentProvider;
  /** Same access path, separate budget: cross-file dependencies for verification. */
  dependencyProvider?: FileContentProvider;
  /** Inputs of the deterministic downstream impact analysis (contract diff + Systems graph). */
  impactInput?: Omit<PrReviewImpactInput, 'userId' | 'signal' | 'now'>;
};

export type PrReviewExecution = {
  text: string;
  reviewScope: PRReviewScope;
  coverage: PRReviewCoverage;
  projectMemory?: ProjectMemoryPromptMetadata;
  /** Server operation id; the client sends it back as `retryOperationId` after a lost response. */
  operationId?: string;
  /** True when this is the stored result of an earlier completed operation. */
  replayed?: boolean;
  /** History snapshot status as confirmed by PostgreSQL (absent when not recorded). */
  reviewHistory?: PrReviewHistoryPersistence;
  /** Deterministic cross-repository contract impact (consumers authorized for this reviewer). */
  downstreamImpact?: PrReviewDownstreamImpact;
};

/** Metadata stored (as JSON) with a delivered result. */
type StoredMeta = {
  reviewScope?: PRReviewScope;
  coverage?: PRReviewCoverage;
  projectMemory?: ProjectMemoryPromptMetadata;
};

/** A completed operation's stored result, replayed to a lost-response retry. */
type StoredResult = { operationId: string; text: string; meta: StoredMeta };

function jsonMeta(meta: StoredMeta): StoredMeta {
  return JSON.parse(JSON.stringify(meta)) as StoredMeta;
}

/** Final scope (header / JSON response) derived from the authoritative coverage. */
export function scopeFromCoverage(coverage: PRReviewCoverage): PRReviewScope {
  const c = coverage.counts;
  const analyzed = c.reviewed_full + c.reviewed_partial;
  const total = coverage.totalFiles ?? coverage.files.length + c.not_fetched;
  return {
    source: coverage.source,
    totalFiles: coverage.totalFiles,
    analyzedFiles: analyzed,
    skippedFiles: Math.max(0, total - analyzed),
    truncated: !coverage.complete,
  };
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly promptRegistry: PromptRegistry,
    private readonly modelFactory: AiModelFactory,
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly settingsService: SettingsService,
    private readonly prisma: PrismaService,
    private readonly featureGate: FeatureGate,
    private readonly usage: UsageService,
    private readonly aiObservability: AiObservabilityService,
    private readonly requestContext: RequestContextService,
    private readonly providerHealth: ProviderHealthService,
    @Optional()
    @Inject(forwardRef(() => ReliabilityService))
    private readonly reliability?: ReliabilityService,
    @Optional()
    @Inject(forwardRef(() => ProjectMemoryService))
    private readonly projectMemory?: ProjectMemoryService,
    // Optional so unit tests that build AiService by hand keep the legacy (page-only) path.
    @Optional()
    private readonly pullRequestDiff?: PullRequestDiffService,
    @Optional()
    private readonly prReviewOrchestrator?: PrReviewOrchestrator,
    @Optional() private readonly prReviewHistory?: PrReviewHistoryService,
    @Optional() private readonly prReviewImpact?: PrReviewImpactService,
  ) {}

  /** REVIEW_ENTIRE_PR runs through the batched orchestrator when the diff service exists. */
  private usesPrOrchestrator(input: ExecuteAiActionDto): boolean {
    return input.action === AIAction.REVIEW_ENTIRE_PR && Boolean(this.pullRequestDiff);
  }

  async generateAction(userId: string, input: ExecuteAiActionDto): Promise<string> {
    return (await this.generateActionWithMetadata(userId, input)).text;
  }

  /** Like {@link generateAction}, plus the review scope and project memory metadata. */
  async generateActionWithMetadata(
    userId: string,
    input: ExecuteAiActionDto,
    options: {
      /**
       * Accept the model output before it is charged. Throwing here (e.g. the output is not
       * the structured result the caller needs) refunds the operation: no usable result, no
       * charge. Not applied to PR reviews.
       */
      validate?: (text: string) => void;
    } = {},
  ): Promise<{
    text: string;
    reviewScope?: PRReviewScope;
    projectMemory?: ProjectMemoryPromptMetadata;
    coverage?: PRReviewCoverage;
    operationId?: string;
    replayed?: boolean;
    reviewHistory?: PrReviewHistoryPersistence;
    downstreamImpact?: PrReviewDownstreamImpact;
  }> {
    if (this.usesPrOrchestrator(input)) {
      const run = await this.resolvePrReviewRun(userId, input);
      let result: PrReviewExecution | null;
      try {
        result = await this.executePrReview(userId, run);
      } finally {
        await this.releaseCharge(run, 'unsettled');
      }
      if (!result) {
        throw new ServiceUnavailableException('The PR review was cancelled.');
      }
      return result;
    }
    const startedAt = Date.now();
    const run = await this.resolveRun(userId, input, { allowReplay: true });
    if (run.replay) {
      return {
        text: run.replay.text,
        ...run.replay.meta,
        operationId: run.replay.operationId,
        replayed: true,
      };
    }
    const provider = this.modelFactory.getProviderName();
    const model = this.modelFactory.getModelName();
    const capability = String(run.request.action);
    const aiOperationId = this.aiObservability.createOperationId();

    this.requestContext.patch({
      capability,
      ...(run.executionId ? { executionId: run.executionId } : {}),
    });

    await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
      status: 'started',
      provider,
      model,
      capability,
      action: capability,
      promptName: run.promptName,
      promptBody: run.instructions,
      inputParts: [run.request.text],
      aiOperationId,
      traceId: this.requestContext.get()?.traceId,
      ...run.contextVersions,
    });

    try {
      const { result: text, observation } = await this.aiObservability.observeGenerate({
        provider,
        model,
        capability,
        call: async () => {
          const result = await generateText({
            model: this.modelFactory.getDefaultModel(),
            instructions: run.instructions,
            messages: run.messages,
            maxOutputTokens: run.maxOutputTokens,
            timeout: run.requestTimeoutMs,
          });
          const out = result.text.trim();
          if (!out) {
            // The provider call completed (and was billed) but returned nothing usable.
            throw new EmptyProviderOutput();
          }
          const incomplete =
            run.request.action === AIAction.REVIEW_ENTIRE_PR &&
            result.finishReason != null &&
            result.finishReason !== 'stop';
          return {
            result: incomplete ? out + prReviewIncompleteTrailer(result.finishReason) : out,
            usageRaw: {
              inputTokens: result.usage?.inputTokens,
              outputTokens: result.usage?.outputTokens,
              totalTokens: result.usage?.totalTokens,
              cachedInputTokens: result.usage?.inputTokenDetails?.cacheReadTokens,
            },
          };
        },
      });

      this.providerHealth.recordSignal('ai', true);
      try {
        options.validate?.(text);
      } catch (error) {
        throw new OutputRejected(error);
      }
      await this.settleUsage(run.reservation, 'commit', {
        text,
        meta: jsonMeta({
          ...(run.reviewScope ? { reviewScope: run.reviewScope } : {}),
          ...(run.memoryMetadata ? { projectMemory: run.memoryMetadata } : {}),
        }),
      });

      this.logger.log({
        msg: 'ai.generate.success',
        action: run.request.action,
        provider,
        model,
        durationMs: observation.durationMs,
        inputLength: run.request.text.length,
        outputLength: text.length,
        maxOutputTokens: run.maxOutputTokens,
        contextType: run.request.context?.type ?? null,
        contextHost: this.safeHost(run.request.context?.url),
        aiOperationId: observation.aiOperationId,
        inputTokens: observation.usage.inputTokens,
        outputTokens: observation.usage.outputTokens,
      });

      await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
        status: 'completed',
        provider,
        model,
        capability,
        action: capability,
        promptName: run.promptName,
        inputParts: [run.request.text],
        outputText: text,
        durationMs: observation.durationMs,
        aiOperationId: observation.aiOperationId,
        traceId: observation.traceId,
        ...(observation.usage.inputTokens != null || observation.usage.outputTokens != null
          ? {
              tokenUsage: {
                ...(observation.usage.inputTokens != null
                  ? { promptTokens: observation.usage.inputTokens }
                  : {}),
                ...(observation.usage.outputTokens != null
                  ? { completionTokens: observation.usage.outputTokens }
                  : {}),
                ...(observation.usage.totalTokens != null
                  ? { totalTokens: observation.usage.totalTokens }
                  : {}),
                ...(observation.usage.cachedInputTokens != null
                  ? { cachedInputTokens: observation.usage.cachedInputTokens }
                  : {}),
              },
            }
          : {}),
        ...(observation.cost.totalCostUsd != null
          ? { estimatedCostUsd: observation.cost.totalCostUsd }
          : {}),
        ...(observation.cost.pricingVersion
          ? { pricingVersion: observation.cost.pricingVersion }
          : {}),
        ...run.contextVersions,
      });

      return {
        text,
        ...(run.reviewScope ? { reviewScope: run.reviewScope } : {}),
        ...(run.memoryMetadata ? { projectMemory: run.memoryMetadata } : {}),
        ...(run.reservation ? { operationId: run.reservation.operationId } : {}),
      };
    } catch (error) {
      if (error instanceof OutputRejected) {
        // The caller could not use the output. The provider call COMPLETED (tokens were
        // spent), so this is a budgeted refund, not an unconditional one (F-07): repeated
        // unusable outputs stop being free. Not a provider fault.
        await this.settleAfterProviderWork(run.reservation, userId, 'output_rejected');
        throw error.cause;
      }
      this.providerHealth.recordSignal('ai', false);
      if (error instanceof EmptyProviderOutput) {
        // Completed provider work with an empty answer (which a prompt can ask for): a
        // budgeted refund, like any other unusable output — not an unconditional one.
        await this.settleAfterProviderWork(run.reservation, userId, 'empty_output');
      } else {
        // The provider itself failed (error / timeout): a plain refund.
        await this.settleUsage(run.reservation, 'release');
      }
      this.logFailure('ai.generate.failure', run.request, startedAt, error);
      await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
        status: 'failed',
        provider,
        model,
        capability,
        action: capability,
        promptName: run.promptName,
        inputParts: [run.request.text],
        durationMs: Date.now() - startedAt,
        aiOperationId,
        traceId: this.requestContext.get()?.traceId,
        ...run.contextVersions,
      });
      throw this.toSafeError(error);
    }
  }

  async streamAction(
    userId: string,
    input: ExecuteAiActionDto,
    abortSignal?: AbortSignal,
  ): Promise<AiTextStreamHandle> {
    const run = await this.resolveRun(userId, input);
    return this.streamResolvedRun(userId, run, abortSignal);
  }

  private async streamResolvedRun(
    userId: string,
    run: ResolvedAiRun,
    abortSignal?: AbortSignal,
    /**
     * Record delivery from the first model chunk. Pipe paths turn this off and record it
     * themselves BEFORE writing the first byte to the client (no unrecorded-delivery window).
     */
    markOnChunk = true,
  ): Promise<StreamTextHandle> {
    const startedAt = Date.now();
    const provider = this.modelFactory.getProviderName();
    const model = this.modelFactory.getModelName();
    const capability = String(run.request.action);
    const aiOperationId = this.aiObservability.createOperationId();
    let firstTokenAt: number | undefined;
    // Charged once output reached the client; refunded when nothing was delivered.
    let delivered = false;
    let settled = false;
    const settle = (charge: boolean, text?: string) => {
      if (settled) return;
      settled = true;
      void this.settleUsage(
        run.reservation,
        charge ? 'commit' : 'release',
        charge && text ? { text, meta: {} } : undefined,
      );
    };
    /**
     * F-06: the model call was started and the client went away before the first chunk. The
     * provider has been sent (and bills for) the prompt, so the refund is budgeted.
     */
    const settleAborted = () => {
      if (settled) return;
      if (delivered) {
        settle(true);
        return;
      }
      settled = true;
      void this.settleAfterProviderWork(run.reservation, userId, 'stream_aborted');
    };

    this.requestContext.patch({
      capability,
      ...(run.executionId ? { executionId: run.executionId } : {}),
    });

    await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
      status: 'started',
      provider,
      model,
      capability,
      action: capability,
      promptName: run.promptName,
      promptBody: run.instructions,
      inputParts: [run.request.text],
      aiOperationId,
      traceId: this.requestContext.get()?.traceId,
      ...run.contextVersions,
    });

    try {
      return streamText({
        model: this.modelFactory.getDefaultModel(),
        instructions: run.instructions,
        messages: run.messages,
        maxOutputTokens: run.maxOutputTokens,
        abortSignal,
        timeout: run.requestTimeoutMs,
        onChunk: ({ chunk }) => {
          if (firstTokenAt == null) firstTokenAt = Date.now();
          if (chunk.type === 'text-delta' && !delivered) {
            delivered = true;
            // From now on the unit is owed, even if this process dies before the end.
            if (markOnChunk) void this.markDelivered(run.reservation);
          }
        },
        onAbort: () => {
          settleAborted();
        },
        onFinish: ({ text, usage }) => {
          if (text.trim().length > 0 || delivered) {
            settle(true, text);
          } else if (!settled) {
            // The stream completed without any text: provider work with nothing usable.
            settled = true;
            void this.settleAfterProviderWork(run.reservation, userId, 'empty_stream');
          }
          const observation = this.aiObservability.recordStreamSuccess({
            provider,
            model,
            capability,
            aiOperationId,
            durationMs: Date.now() - startedAt,
            ...(firstTokenAt != null ? { firstTokenLatencyMs: firstTokenAt - startedAt } : {}),
            usageRaw: {
              inputTokens: usage?.inputTokens,
              outputTokens: usage?.outputTokens,
              totalTokens: usage?.totalTokens,
              cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens,
            },
            aborted: abortSignal?.aborted === true,
          });
          this.providerHealth.recordSignal('ai', !abortSignal?.aborted);

          this.logger.log({
            msg: 'ai.stream.success',
            action: run.request.action,
            provider,
            model,
            durationMs: observation.durationMs,
            inputLength: run.request.text.length,
            outputLength: text.length,
            maxOutputTokens: run.maxOutputTokens,
            cancelled: abortSignal?.aborted === true,
            contextType: run.request.context?.type ?? null,
            contextHost: this.safeHost(run.request.context?.url),
            firstTokenLatencyMs: observation.firstTokenLatencyMs,
            inputTokens: observation.usage.inputTokens,
            outputTokens: observation.usage.outputTokens,
          });

          void this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
            status: 'completed',
            provider,
            model,
            capability,
            action: capability,
            promptName: run.promptName,
            inputParts: [run.request.text],
            outputText: text,
            durationMs: observation.durationMs,
            aiOperationId: observation.aiOperationId,
            traceId: observation.traceId,
            ...(observation.firstTokenLatencyMs != null
              ? { firstTokenLatencyMs: observation.firstTokenLatencyMs }
              : {}),
            ...(observation.usage.inputTokens != null || observation.usage.outputTokens != null
              ? {
                  tokenUsage: {
                    ...(observation.usage.inputTokens != null
                      ? { promptTokens: observation.usage.inputTokens }
                      : {}),
                    ...(observation.usage.outputTokens != null
                      ? { completionTokens: observation.usage.outputTokens }
                      : {}),
                    ...(observation.usage.totalTokens != null
                      ? { totalTokens: observation.usage.totalTokens }
                      : {}),
                    ...(observation.usage.cachedInputTokens != null
                      ? { cachedInputTokens: observation.usage.cachedInputTokens }
                      : {}),
                  },
                }
              : {}),
            ...(observation.cost.totalCostUsd != null
              ? { estimatedCostUsd: observation.cost.totalCostUsd }
              : {}),
            ...(observation.cost.pricingVersion
              ? { pricingVersion: observation.cost.pricingVersion }
              : {}),
            ...run.contextVersions,
          });
        },
        onError: ({ error }) => {
          settle(delivered);
          this.providerHealth.recordSignal('ai', false);
          this.aiObservability.recordStreamFailure({
            provider,
            model,
            capability,
            aiOperationId,
            durationMs: Date.now() - startedAt,
            error,
          });
          this.logFailure('ai.stream.failure', run.request, startedAt, error);
          void this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
            status: 'failed',
            provider,
            model,
            capability,
            action: capability,
            promptName: run.promptName,
            inputParts: [run.request.text],
            durationMs: Date.now() - startedAt,
            aiOperationId,
            traceId: this.requestContext.get()?.traceId,
            ...run.contextVersions,
          });
        },
      });
    } catch (error) {
      this.providerHealth.recordSignal('ai', false);
      this.aiObservability.recordStreamFailure({
        provider,
        model,
        capability,
        aiOperationId,
        durationMs: Date.now() - startedAt,
        error,
      });
      settle(false);
      this.logFailure('ai.stream.start_failure', run.request, startedAt, error);
      throw this.toSafeError(error);
    }
  }

  async pipeActionStream(
    userId: string,
    input: ExecuteAiActionDto,
    response: ServerResponse,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    if (this.usesPrOrchestrator(input)) {
      await this.pipePrReview(userId, input, response, abortSignal);
      return;
    }
    const run = await this.resolveRun(userId, input, { allowReplay: true });
    if (run.replay) {
      // Lost-response retry of a completed operation: its stored result, no AI, no charge.
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader(AI_OPERATION_ID_HEADER, run.replay.operationId);
      response.setHeader(AI_OPERATION_REPLAYED_HEADER, '1');
      response.end(run.replay.text);
      return;
    }
    if (run.reservation) response.setHeader(AI_OPERATION_ID_HEADER, run.reservation.operationId);
    const result = await this.streamResolvedRun(userId, run, abortSignal, false);
    if (run.request.action !== AIAction.REVIEW_ENTIRE_PR) {
      await this.pipeTextWithDelivery(result, response, run.reservation, abortSignal);
      return;
    }
    if (run.reviewScope) {
      response.setHeader(PR_REVIEW_SCOPE_HEADER, JSON.stringify(run.reviewScope));
    }
    if (run.memoryMetadata) {
      response.setHeader(
        PROJECT_MEMORY_METADATA_HEADER,
        encodeProjectMemoryMetadata(run.memoryMetadata),
      );
    }
    await this.pipePrReviewStream(result, response, abortSignal, run.reservation);
  }

  /**
   * Plain-text streaming with delivery recorded before the first byte reaches the client, so
   * a process that dies mid-stream is charged for what it delivered (never silently free).
   * Recording is retried; if it still fails the output is delivered anyway (logged).
   */
  private async pipeTextWithDelivery(
    result: StreamTextHandle,
    response: ServerResponse,
    reservation: UsageReservation | undefined,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    let first = true;
    try {
      for await (const text of result.textStream) {
        if (abortSignal?.aborted) break;
        if (!text) continue;
        if (first) {
          first = false;
          await this.markDelivered(reservation);
        }
        response.write(text);
      }
    } finally {
      if (!response.writableEnded) response.end();
    }
  }

  /**
   * Like pipeTextStreamToResponse, but a PR review that stops early (output-token limit,
   * provider error, content filter) ends with an explicit incomplete trailer instead of
   * looking like a finished review with zero findings.
   */
  private async pipePrReviewStream(
    result: StreamTextHandle,
    response: ServerResponse,
    abortSignal?: AbortSignal,
    reservation?: UsageReservation,
  ): Promise<void> {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    let incompleteReason: string | null = null;
    let finished = false;
    let wroteText = false;
    try {
      for await (const part of result.stream) {
        if (abortSignal?.aborted) return;
        if (part.type === 'text-delta' && part.text) {
          if (!wroteText) await this.markDelivered(reservation);
          response.write(part.text);
          wroteText = true;
        } else if (part.type === 'error') {
          incompleteReason = 'error';
        } else if (part.type === 'finish') {
          finished = true;
          if (part.finishReason !== 'stop') incompleteReason = part.finishReason;
        }
      }
    } catch {
      incompleteReason = 'error';
    }
    if (abortSignal?.aborted || response.writableEnded) return;
    if (!wroteText) {
      // Nothing streamed yet: fail as a normal error (503) rather than an empty 200.
      throw new ServiceUnavailableException('Unable to generate a response.');
    }
    if (!finished && !incompleteReason) incompleteReason = 'other';
    if (incompleteReason) {
      response.write(prReviewIncompleteTrailer(incompleteReason));
    }
    response.end();
  }

  private async resolveRun(
    userId: string,
    input: ExecuteAiActionDto,
    options: { allowReplay?: boolean } = {},
  ): Promise<ResolvedAiRun> {
    const ai = this.config.get('ai', { infer: true });
    const settings = await this.settingsService.getForUser(userId);
    const request = this.toRequest(input, settings.includePageContext);

    // N-1: active membership in an active workspace + workflow:execute, re-checked per run
    // (including lost-response replays) — never a predicted workspace id.
    const workspaceId = await resolveWorkspaceIdForUser(
      this.prisma,
      userId,
      this.requestContext.get()?.workspaceId,
      'workflow:execute',
    );
    await this.featureGate.require(workspaceId, featureForAiAction(request.action));

    // REVIEW_ENTIRE_PR with the diff service uses resolvePrReviewRun; this path is only the
    // legacy page-context review (no server diff available).
    const reviewScope: PRReviewScope | undefined = undefined;

    const built = this.promptRegistry.build(request);
    const promptName = this.promptRegistry.registryNameFor(request.action);
    const memory = await this.loadProjectMemory(
      userId,
      workspaceId,
      input,
      request.context?.github?.changedFiles,
    );
    // M6: what reaches the provider (and the audit snapshot) is the redacted prompt —
    // selection, page context, PR metadata and Project Memory alike.
    const prompt = sanitizeProviderPrompt({
      ...built,
      messages: this.withTrustedMemory(built.messages, memory?.block),
    });

    let contextVersions: ResolvedAiRun['contextVersions'] = memory?.version
      ? { memoryVersion: memory.version }
      : {};
    if (input.executionId && this.reliability) {
      try {
        const detail = await this.reliability.getExecution(userId, input.executionId);
        const ctx = detail.contextVersion;
        contextVersions = {
          ...contextVersions,
          ...(ctx.memoryVersion ? { memoryVersion: ctx.memoryVersion } : {}),
          ...(ctx.systemContextVersion ? { systemContextVersion: ctx.systemContextVersion } : {}),
          ...(ctx.openapiHash ? { openapiVersion: ctx.openapiHash } : {}),
          ...(ctx.jiraUpdatedAt || ctx.jiraIssueKey
            ? { jiraVersion: ctx.jiraUpdatedAt ?? ctx.jiraIssueKey }
            : {}),
        };
      } catch {
        // best-effort — AI must not fail if reliability lookup fails
      }
    }

    const requestKey = inFlightKey(userId, request.action, {
      text: request.text,
      url: request.context?.url ?? null,
      ...memoryModeKeyPart(input),
    });
    const replay =
      options.allowReplay && input.retryOperationId
        ? await this.findReplay(workspaceId, userId, input.retryOperationId, requestKey)
        : null;
    // Reserve last, right before the model call: the server chooses the operation id, and
    // an identical in-flight request of this user is rejected instead of run twice.
    const reservation = replay
      ? undefined
      : await this.usage.reserve({
          workspaceId,
          userId,
          metric: usageMetricForAiAction(request.action),
          operationId: randomUUID(),
          inFlightKey: requestKey,
        });
    if (reservation) this.holdLease(reservation);

    return {
      request,
      workspaceId,
      ...(reservation ? { reservation } : {}),
      ...(replay ? { replay } : {}),
      ...(reviewScope ? { reviewScope } : {}),
      ...(memory ? { memoryMetadata: memory.metadata } : {}),
      instructions: `${prompt.instructions} ${responseStyleHint(settings.responseStyle)}`,
      messages: prompt.messages,
      ...this.outputBudgetFor(request.action, settings.maxOutputTokens, ai),
      promptName,
      contextVersions,
      ...(input.executionId ? { executionId: input.executionId } : {}),
    };
  }

  /** Per-review limits from config, re-clamped to the hard ceilings. */
  private prReviewLimits(): PrReviewLimits {
    const pr = this.config.get('ai', { infer: true })?.prReview;
    return sanitizeLimits({
      ...DEFAULT_PR_REVIEW_LIMITS,
      ...(pr?.maxBatches != null ? { maxBatches: pr.maxBatches } : {}),
      ...(pr?.concurrency != null ? { concurrency: pr.concurrency } : {}),
      ...(pr?.batchInputTokens != null ? { batchInputTokens: pr.batchInputTokens } : {}),
      ...(pr?.maxInputTokens != null ? { maxInputTokens: pr.maxInputTokens } : {}),
      ...(pr?.maxOutputTokens != null ? { maxOutputTokensPerBatch: pr.maxOutputTokens } : {}),
      ...(pr?.maxTotalOutputTokens != null
        ? { maxTotalOutputTokens: pr.maxTotalOutputTokens }
        : {}),
      ...(pr?.requestTimeoutMs != null ? { batchTimeoutMs: pr.requestTimeoutMs } : {}),
      ...(pr?.reviewTimeoutMs != null ? { reviewTimeoutMs: pr.reviewTimeoutMs } : {}),
      ...(pr?.maxVerifications != null ? { maxVerifications: pr.maxVerifications } : {}),
      ...(pr?.verifyInputTokens != null ? { verifyInputTokens: pr.verifyInputTokens } : {}),
      ...(pr?.verifyOutputTokens != null ? { verifyOutputTokens: pr.verifyOutputTokens } : {}),
      ...(pr?.maxContextFiles != null ? { maxContextFiles: pr.maxContextFiles } : {}),
    });
  }

  /**
   * Resolve and authorize a REVIEW_ENTIRE_PR run: acting workspace (membership-checked),
   * plan feature, the full PR file list (GitHub API, page excerpts only as fallback),
   * server-side project memory, the deterministic review plan, and the single usage charge.
   *
   * Order matters for cost: nothing is charged when the diff cannot be loaded (422) or when
   * the plan needs no AI call (e.g. only lockfiles changed).
   */
  private async resolvePrReviewRun(
    userId: string,
    input: ExecuteAiActionDto,
  ): Promise<PrReviewRun> {
    const settings = await this.settingsService.getForUser(userId);
    const request = this.toRequest(input, settings.includePageContext);
    // N-1: active membership in an active workspace + workflow:execute, re-checked per run
    // (including lost-response replays) — never a predicted workspace id.
    const workspaceId = await resolveWorkspaceIdForUser(
      this.prisma,
      userId,
      this.requestContext.get()?.workspaceId,
      'workflow:execute',
    );
    await this.featureGate.require(workspaceId, featureForAiAction(request.action));

    const identity = input.context?.github;
    const pageGithub = request.context?.github;
    const diff = await this.pullRequestDiff!.resolve({
      userId,
      workspaceId,
      owner: identity?.owner,
      repository: identity?.repository,
      pullRequestNumber: identity?.pullRequestNumber,
      pageFiles: pageGithub?.changedFiles,
      pageTruncated: pageGithub?.changedFilesTruncated,
    });

    const limits = this.prReviewLimits();
    const owner = identity?.owner ?? '';
    const repository = identity?.repository ?? '';
    const pullRequestNumber = identity?.pullRequestNumber ?? 0;
    const pullRequestTitle = pageGithub?.pullRequestTitle ?? diff.pullRequestTitle;

    // Plan once without memory to get the priority order for memory path hints.
    const draft = planPrReview({
      files: diff.files,
      totalFiles: diff.totalFiles,
      source: diff.source,
      overheadChars: 0,
      limits,
    });
    const allPaths = draft.files.map((f) => f.path);
    const github: PageContextGitHub = {
      ...(pageGithub ?? {}),
      owner: owner || undefined,
      repository: repository || undefined,
      pullRequestNumber: pullRequestNumber || undefined,
      changedFiles: allPaths.map((path) => ({ path })),
      changedFilesSource: diff.source,
      ...(diff.totalFiles != null ? { changedFilesTotal: diff.totalFiles } : {}),
      ...(pullRequestTitle ? { pullRequestTitle } : {}),
      ...(diff.baseBranch ? { baseBranch: diff.baseBranch } : {}),
      ...(diff.headBranch ? { headBranch: diff.headBranch } : {}),
    };
    request.context = request.context
      ? { ...request.context, github }
      : {
          type: 'github',
          url: `https://github.com/${owner}/${repository}/pull/${pullRequestNumber}`,
          title: pullRequestTitle ?? `PR #${pullRequestNumber}`,
          github,
        };

    const memory = await this.loadProjectMemory(userId, workspaceId, input, github.changedFiles);
    const context: BatchPromptContext = {
      owner,
      repository,
      pullRequestNumber,
      ...(pullRequestTitle ? { pullRequestTitle } : {}),
      ...(diff.baseBranch ? { baseBranch: diff.baseBranch } : {}),
      ...(diff.headBranch ? { headBranch: diff.headBranch } : {}),
      allPaths,
      batchCount: 0,
    };
    // M6: batches carry redacted diff chunks (prompt, validation and verification all read
    // them); the GitHub diff itself (`diff.files`, used by non-AI analysis) is untouched.
    const plan = redactPlanForAi(
      planPrReview({
        // N1: whole-file redaction before chunking (keys split across chunks).
        files: redactDiffFilesForAi(diff.files),
        totalFiles: diff.totalFiles,
        source: diff.source,
        overheadChars: batchPromptOverheadChars(context, memory?.block),
        limits,
      }),
    );
    context.batchCount = plan.batches.length;

    // Same workspace-scoped credentials as the diff; only for the authoritative API diff.
    const fileProvider =
      diff.source === 'github_api' && diff.headSha && limits.maxContextFiles > 0
        ? redactFileProviderForAi(
            this.pullRequestDiff!.createFileProvider({
              userId,
              workspaceId,
              owner,
              repository,
              ref: diff.headSha,
              maxFiles: limits.maxContextFiles,
            }),
          )
        : undefined;

    // Dependency sources: same authorized access layer, same pinned head SHA, own budget.
    const dependencyProvider =
      diff.source === 'github_api' && diff.headSha
        ? redactFileProviderForAi(
            this.pullRequestDiff!.createFileProvider({
              userId,
              workspaceId,
              owner,
              repository,
              ref: diff.headSha,
              // Network cap; the resolver charges only existing source files to the 16-file
              // budget, with separate caps for config reads and missing-file probes.
              maxFiles: DEP_MAX_REQUESTS_PER_REVIEW,
            }),
          )
        : undefined;

    // One review = one unit, whatever the number of batches or retries. Reserved last (after
    // every step that can fail without an AI call), under a server-chosen operation id; the
    // same user's identical in-flight review of the same PR head is rejected, not re-run.
    const requestKey = inFlightKey(userId, request.action, {
      pr: `${owner}/${repository}#${pullRequestNumber}`,
      head: diff.headSha ?? null,
      ...memoryModeKeyPart(input),
    });
    const replay =
      plan.batches.length > 0 && input.retryOperationId
        ? await this.findReplay(workspaceId, userId, input.retryOperationId, requestKey)
        : null;
    const reservation =
      plan.batches.length > 0 && !replay
        ? await this.usage.reserve({
            workspaceId,
            userId,
            metric: usageMetricForAiAction(request.action),
            operationId: randomUUID(),
            inFlightKey: requestKey,
          })
        : undefined;
    if (reservation) this.holdLease(reservation);

    // Deterministic contract impact inputs: only path/status metadata and immutable SHAs.
    const impactInput: PrReviewRun['impactInput'] = {
      workspaceId,
      owner,
      repository,
      source: diff.source,
      ...(diff.baseSha ? { baseSha: diff.baseSha } : {}),
      ...(diff.headSha ? { headSha: diff.headSha } : {}),
      files: diff.files.map((f) => ({
        path: f.path,
        status: f.status,
        ...(f.previousPath ? { previousPath: f.previousPath } : {}),
      })),
    };

    return {
      request,
      workspaceId,
      impactInput,
      ...(fileProvider ? { fileProvider } : {}),
      ...(dependencyProvider ? { dependencyProvider } : {}),
      plan,
      context,
      limits,
      ...(memory?.block ? { memoryBlock: memory.block } : {}),
      ...(memory ? { memoryMetadata: memory.metadata } : {}),
      ...(reservation ? { reservation } : {}),
      ...(replay ? { replay } : {}),
      ...(input.executionId ? { executionId: input.executionId } : {}),
      ...(diff.headSha ? { headSha: diff.headSha } : {}),
      contextVersions: memory?.version ? { memoryVersion: memory.version } : {},
    };
  }

  /**
   * Run the batches and build the final report.
   *
   * Usage policy (one review = at most one unit):
   * - every batch succeeded → charged, complete or partial coverage as computed;
   * - some batches failed → charged, report marked partial (failed files listed);
   * - no batch succeeded, or the client cancelled → charge released, nothing delivered;
   * - no AI call needed → never charged.
   * Returns null when the client cancelled.
   */
  private async executePrReview(
    userId: string,
    run: PrReviewRun,
    abortSignal?: AbortSignal,
  ): Promise<PrReviewExecution | null> {
    if (run.replay?.meta.coverage && run.replay.meta.reviewScope) {
      const { coverage, reviewScope, projectMemory } = run.replay.meta;
      return {
        text: run.replay.text,
        coverage,
        reviewScope,
        ...(projectMemory ? { projectMemory } : {}),
        operationId: run.replay.operationId,
        replayed: true,
      };
    }
    const provider = this.modelFactory.getProviderName();
    const model = this.modelFactory.getModelName();
    const capability = String(run.request.action);
    const startedAt = Date.now();
    this.requestContext.patch({
      capability,
      ...(run.executionId ? { executionId: run.executionId } : {}),
    });

    let result: PrReviewRunResult = {
      outcomes: [],
      findings: [],
      findingStats: {
        accepted: 0,
        duplicates: 0,
        rejected: 0,
        rejectedByReason: {},
        linesCorrected: 0,
      },
      cancelled: false,
      tokens: { input: 0, output: 0, calls: 0 },
      verificationTokens: { input: 0, output: 0, calls: 0 },
    };
    // Runs alongside the AI batches; isolated: it can never fail or block the review.
    const impact = this.startDownstreamImpact(userId, run, abortSignal);
    if (run.plan.batches.length > 0) {
      if (!this.prReviewOrchestrator) {
        impact?.cancel();
        await this.releaseCharge(run, 'not_configured');
        throw new ServiceUnavailableException('Unable to generate a response.');
      }
      await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
        status: 'started',
        provider,
        model,
        capability,
        action: capability,
        promptName: 'review-entire-pr-batched',
        inputParts: [run.request.text],
        traceId: this.requestContext.get()?.traceId,
        ...run.contextVersions,
      });
      try {
        result = await this.prReviewOrchestrator.run({
          plan: run.plan,
          context: run.context,
          ...(run.memoryBlock ? { memoryBlock: run.memoryBlock } : {}),
          limits: run.limits,
          ...(abortSignal ? { abortSignal } : {}),
          ...(run.fileProvider ? { fileProvider: run.fileProvider } : {}),
          ...(run.dependencyProvider ? { dependencyProvider: run.dependencyProvider } : {}),
        });
      } catch (error) {
        impact?.cancel();
        await this.releaseCharge(run, 'orchestrator_error');
        await this.recordHistory(userId, run, {
          status: 'failed',
          failureCode: 'orchestrator_error',
          result,
          startedAt,
        });
        this.logger.error({
          msg: 'pr_review.orchestrator.failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        throw new ServiceUnavailableException(
          'Unable to complete the PR review right now. No usage was charged; try again.',
        );
      }
    }

    const anySucceeded = result.outcomes.some((o) => o.status === 'succeeded');
    const cancelled = result.cancelled || abortSignal?.aborted === true;
    if (run.plan.batches.length > 0 && (!anySucceeded || cancelled)) {
      impact?.cancel();
      // F-06: model calls already ran (and were billed by the provider) when the client hung
      // up or every batch failed — a budgeted refund. Nothing ran: a plain refund.
      const providerWorked = result.tokens.calls + result.verificationTokens.calls > 0;
      const settlement = await this.releaseCharge(
        run,
        cancelled ? 'cancelled' : 'all_batches_failed',
        providerWorked ? { providerWorkedFor: userId } : {},
      );
      this.logPrReview(run, result, null, startedAt);
      await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
        status: 'failed',
        provider,
        model,
        capability,
        action: capability,
        promptName: 'review-entire-pr-batched',
        inputParts: [run.request.text],
        durationMs: Date.now() - startedAt,
        traceId: this.requestContext.get()?.traceId,
        ...run.contextVersions,
      });
      if (cancelled) return null;
      await this.recordHistory(userId, run, {
        status: 'failed',
        failureCode: 'all_batches_failed',
        result,
        startedAt,
      });
      throw new ServiceUnavailableException(
        settlement === 'charged'
          ? 'Unable to complete the PR review right now. Try again in a moment.'
          : 'Unable to complete the PR review right now. No usage was charged; try again.',
      );
    }

    const coverage = buildCoverage({
      plan: run.plan,
      outcomes: result.outcomes,
      findings: result.findingStats,
      riskFor: (complete) => computeRiskLevel(result.findings, complete),
      usageUnits: anySucceeded ? 1 : 0,
    });
    const text = renderPrReview({
      coverage,
      findings: result.findings,
    });
    this.logPrReview(run, result, coverage, startedAt);
    const downstreamImpact = impact ? await impact.result : undefined;
    // The reviewer's live (and replayed) response shows the section; the shared history
    // Markdown does not — history renders the structured snapshot, re-authorized per viewer.
    const impactSection = downstreamImpact ? renderDownstreamImpactSection(downstreamImpact) : null;
    const liveText = impactSection ? `${impactSection}\n\n${text}` : text;

    let reviewHistory: PrReviewHistoryPersistence | undefined;
    if (anySucceeded) {
      await this.commitCharge(run, {
        text: liveText,
        meta: jsonMeta({
          reviewScope: scopeFromCoverage(coverage),
          coverage,
          ...(run.memoryMetadata ? { projectMemory: withoutRuleText(run.memoryMetadata) } : {}),
        }),
      });
      await this.reliability?.recordAiRequestBestEffort(userId, run.executionId, {
        status: 'completed',
        provider,
        model,
        capability,
        action: capability,
        promptName: 'review-entire-pr-batched',
        inputParts: [run.request.text],
        outputText: text,
        durationMs: Date.now() - startedAt,
        traceId: this.requestContext.get()?.traceId,
        tokenUsage: {
          promptTokens: result.tokens.input,
          completionTokens: result.tokens.output,
          totalTokens: result.tokens.input + result.tokens.output,
        },
        ...run.contextVersions,
      });
      reviewHistory = await this.recordHistory(userId, run, {
        status: coverage.complete ? 'completed' : 'partial',
        result,
        startedAt,
        coverage,
        text,
        ...(downstreamImpact ? { downstreamImpact } : {}),
      });
    }

    return {
      text: liveText,
      reviewScope: scopeFromCoverage(coverage),
      coverage,
      ...(run.memoryMetadata ? { projectMemory: run.memoryMetadata } : {}),
      ...(run.reservation ? { operationId: run.reservation.operationId } : {}),
      ...(reviewHistory ? { reviewHistory } : {}),
      ...(downstreamImpact ? { downstreamImpact } : {}),
    };
  }

  /** Stream variant: everything is computed first, so failures still map to HTTP errors. */
  private async pipePrReview(
    userId: string,
    input: ExecuteAiActionDto,
    response: ServerResponse,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    // Authorization, diff, plan and the usage charge fail fast with real HTTP statuses.
    const run = await this.resolvePrReviewRun(userId, input);

    // A batched review can run for minutes. MV3 extension service workers (which proxy this
    // stream for the github.com content script) are terminated when a fetch() response takes
    // more than 30s to arrive, so commit the response now and keep bytes flowing: leading
    // newlines are ignored by every PR review parser.
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('X-Accel-Buffering', 'no');
    response.setHeader(PR_REVIEW_SCOPE_HEADER, JSON.stringify(scopeFromPlan(run.plan)));
    const operationId = run.reservation?.operationId ?? run.replay?.operationId;
    if (operationId) response.setHeader(AI_OPERATION_ID_HEADER, operationId);
    if (run.replay) response.setHeader(AI_OPERATION_REPLAYED_HEADER, '1');
    if (run.memoryMetadata) {
      response.setHeader(
        PROJECT_MEMORY_METADATA_HEADER,
        encodeProjectMemoryMetadata(run.memoryMetadata),
      );
    }
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (run.plan.batches.length > 0) {
      response.flushHeaders?.();
      heartbeat = setInterval(() => {
        if (!response.writableEnded) response.write('\n');
      }, PR_REVIEW_HEARTBEAT_MS);
    }

    let result: PrReviewExecution | null;
    try {
      result = await this.executePrReview(userId, run, abortSignal);
    } catch (error) {
      await this.releaseCharge(run, 'unsettled');
      clearInterval(heartbeat);
      if (abortSignal?.aborted || response.writableEnded) return;
      // Headers are committed: report the failure in-band instead of an HTTP status.
      this.logger.warn({
        msg: 'pr_review.stream.failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      response.write(
        run.settled === 'committed' ? PR_REVIEW_FAILED_CHARGED_TEXT : PR_REVIEW_FAILED_TEXT,
      );
      response.end();
      return;
    }
    clearInterval(heartbeat);
    if (!result || abortSignal?.aborted || response.writableEnded) {
      if (!response.writableEnded) response.end();
      return;
    }
    response.write(result.text);
    response.end();
  }

  /**
   * Deterministic downstream impact, started with the batches: own deadline, follows the
   * review's cancellation, never throws (failures become an `unavailable` result). No AI
   * call and no usage charge.
   */
  private startDownstreamImpact(
    userId: string,
    run: PrReviewRun,
    abortSignal?: AbortSignal,
  ): { result: Promise<PrReviewDownstreamImpact>; cancel: () => void } | null {
    if (!this.prReviewImpact || !run.impactInput || run.replay) return null;
    const input = run.impactInput;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PR_IMPACT_BUDGET_MS);
    const onAbort = () => controller.abort();
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    const result = this.prReviewImpact
      .analyze({ ...input, userId, signal: controller.signal })
      .catch((error: unknown): PrReviewDownstreamImpact => {
        this.logger.warn({
          msg: 'pr_review.impact.failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        return {
          status: 'unavailable',
          provider: toRepositoryIdentity(input.owner, input.repository),
          contracts: [],
          findings: [],
          withheldConsumers: 0,
          warnings: [controller.signal.aborted ? 'timeout' : 'contract_unavailable'],
          analyzedAt: new Date().toISOString(),
        };
      })
      .finally(() => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', onAbort);
      });
    return { result, cancel: () => controller.abort() };
  }

  /**
   * Persist the immutable history snapshot of a settled, charged-or-refunded execution.
   * Only real executions (with a usage reservation) are recorded — never replays, cancelled
   * runs or reviews that needed no AI call — so there is exactly one row per operation id.
   * Runs after settlement, outside any transaction; best-effort (never throws).
   */
  private async recordHistory(
    userId: string,
    run: PrReviewRun,
    outcome: {
      status: 'completed' | 'partial' | 'failed';
      failureCode?: string;
      result: PrReviewRunResult;
      startedAt: number;
      coverage?: PRReviewCoverage;
      text?: string;
      downstreamImpact?: PrReviewDownstreamImpact;
    },
  ): Promise<PrReviewHistoryPersistence | undefined> {
    if (!this.prReviewHistory || !run.reservation || run.replay) return undefined;
    let coverage = outcome.coverage ?? null;
    if (!coverage && outcome.result.outcomes.length > 0) {
      try {
        coverage = buildCoverage({
          plan: run.plan,
          outcomes: outcome.result.outcomes,
          findings: outcome.result.findingStats,
          // Failed runs carry no risk verdict (record() stores null for them).
          riskFor: (complete) => computeRiskLevel([], complete),
          usageUnits: 0,
        });
      } catch {
        coverage = null;
      }
    }
    return this.prReviewHistory.record({
      workspaceId: run.workspaceId,
      userId,
      operationId: run.reservation.operationId,
      owner: run.context.owner,
      repository: run.context.repository,
      pullRequestNumber: run.context.pullRequestNumber,
      ...(run.context.pullRequestTitle ? { pullRequestTitle: run.context.pullRequestTitle } : {}),
      headSha: run.headSha ?? null,
      ...(run.context.baseBranch ? { baseBranch: run.context.baseBranch } : {}),
      ...(run.context.headBranch ? { headBranch: run.context.headBranch } : {}),
      status: outcome.status,
      ...(outcome.failureCode ? { failureCode: outcome.failureCode } : {}),
      coverage,
      reviewScope: coverage ? scopeFromCoverage(coverage) : scopeFromPlan(run.plan),
      findings: outcome.status === 'failed' ? [] : outcome.result.findings,
      outcomes: outcome.result.outcomes,
      ...(run.memoryMetadata ? { memory: run.memoryMetadata } : {}),
      durationMs: Date.now() - outcome.startedAt,
      batchCount: run.plan.batches.length,
      markdown: outcome.text ?? null,
      ...(outcome.downstreamImpact ? { downstreamImpact: outcome.downstreamImpact } : {}),
      startedAt: new Date(outcome.startedAt),
      completedAt: new Date(),
    });
  }

  /**
   * Settle a review that delivered nothing. Once only; never after a commit. A plain refund
   * unless `providerWorkedFor` names the user whose review already ran model calls — then the
   * refund comes out of that user's daily budget and the unit is charged once it is spent
   * (F-06). Returns what happened to the unit.
   */
  private async releaseCharge(
    run: PrReviewRun,
    reason: string,
    options: { providerWorkedFor?: string } = {},
  ): Promise<'refunded' | 'charged' | 'none'> {
    if (!run.reservation || run.settled) return 'none';
    if (options.providerWorkedFor) {
      const outcome = await this.settleAfterProviderWork(
        run.reservation,
        options.providerWorkedFor,
        reason,
      );
      run.settled = outcome === 'charged' ? 'committed' : 'released';
      this.logger.log({ msg: 'pr_review.usage.settled_after_provider_work', reason, outcome });
      return outcome === 'charged' ? 'charged' : 'refunded';
    }
    run.settled = 'released';
    const released = await this.settleUsage(run.reservation, 'release');
    this.logger.log({ msg: 'pr_review.usage.released', reason, released });
    return 'refunded';
  }

  /** Charge the review's unit (output is being delivered), keeping a replay copy. Once only. */
  private async commitCharge(
    run: PrReviewRun,
    result: { text: string; meta: StoredMeta },
  ): Promise<void> {
    if (!run.reservation || run.settled) return;
    run.settled = 'committed';
    await this.settleUsage(run.reservation, 'commit', result);
  }

  /** Lease heartbeats of this process's running operations (stopped by settlement). */
  private readonly leases = new Map<string, () => void>();

  private holdLease(reservation: UsageReservation): void {
    this.leases.set(reservation.idempotencyKey, this.usage.startHeartbeat(reservation));
  }

  private dropLease(reservation: UsageReservation): void {
    this.leases.get(reservation.idempotencyKey)?.();
    this.leases.delete(reservation.idempotencyKey);
  }

  /** Output reached the client: the unit is owed from now on (retried; never throws). */
  private async markDelivered(reservation: UsageReservation | undefined): Promise<void> {
    if (!reservation) return;
    try {
      await withRetry(() => this.usage.markDelivered(reservation));
    } catch (error) {
      this.logger.error({
        msg: 'usage.mark_delivered_failed',
        operationId: reservation.operationId,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /** The stored result of this user's completed operation, if the retry matches it exactly. */
  private async findReplay(
    workspaceId: string,
    userId: string,
    operationId: string,
    requestKey: string,
  ): Promise<StoredResult | null> {
    const found = await this.usage.findReplay({ workspaceId, userId, operationId, requestKey });
    if (!found) return null;
    this.logger.log({ msg: 'usage.replay', operationId });
    return { operationId, text: found.text, meta: (found.meta ?? {}) as StoredMeta };
  }

  /**
   * Settle a reservation whose provider work was already done but produced nothing usable
   * (F-06 / F-07): refunded from the user's daily budget, charged beyond it. Never throws; on
   * failure the open reservation is left to lease recovery, like {@link settleUsage}.
   */
  private async settleAfterProviderWork(
    reservation: UsageReservation | undefined,
    userId: string,
    reason: string,
  ): Promise<'refunded' | 'charged' | 'missing'> {
    if (!reservation) return 'missing';
    this.dropLease(reservation);
    try {
      const outcome = await withRetry(() =>
        this.usage.settleAfterProviderWork(reservation, userId),
      );
      this.logger.log({
        msg: 'usage.settled_after_provider_work',
        outcome,
        reason,
        operationId: reservation.operationId,
        metric: reservation.metric,
      });
      return outcome;
    } catch (error) {
      this.logger.error({
        msg: 'usage.settlement_failed',
        action: 'settle_after_provider_work',
        operationId: reservation.operationId,
        metric: reservation.metric,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return 'missing';
    }
  }

  /**
   * Finalize a usage reservation, retrying transient failures (settlement is idempotent).
   * Never throws. If a commit still fails, delivery is recorded (best effort) and the open
   * reservation is left to recovery once its lease lapses: charged when delivery was
   * recorded, otherwise refunded. Every such case is logged (`usage.settlement_failed`) with
   * the operation id for reconciliation.
   */
  private async settleUsage(
    reservation: UsageReservation | undefined,
    action: 'commit' | 'release',
    result?: { text: string; meta: StoredMeta },
  ): Promise<boolean> {
    if (!reservation) return false;
    this.dropLease(reservation);
    try {
      const done = await withRetry(() =>
        action === 'commit'
          ? this.usage.commit(
              reservation,
              result ? { text: result.text, meta: result.meta as object } : undefined,
            )
          : this.usage.releaseReservation(reservation),
      );
      if (!done) {
        this.logger.warn({
          msg: `usage.${action}.missing`,
          operationId: reservation.operationId,
          metric: reservation.metric,
        });
      }
      return done;
    } catch (error) {
      if (action === 'commit') await this.markDelivered(reservation);
      this.logger.error({
        msg: 'usage.settlement_failed',
        action,
        operationId: reservation.operationId,
        metric: reservation.metric,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  private logPrReview(
    run: PrReviewRun,
    result: PrReviewRunResult,
    coverage: PRReviewCoverage | null,
    startedAt: number,
  ): void {
    // Every call of a review uses the same model, and token totals are reconciled to the
    // provider-reported usage, so pricing the totals once gives the review's cost.
    const cost = estimateAiCost({
      provider: this.modelFactory.getProviderName(),
      model: this.modelFactory.getModelName(),
      usage: {
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
        // Totals fall back to reservations where a call reported no usage.
        providerReported: false,
      },
    });
    this.logger.log({
      msg: 'pr_review.completed',
      source: run.plan.source,
      totalFiles: run.plan.totalFiles,
      batches: run.plan.batches.length,
      succeededBatches: result.outcomes.filter((o) => o.status === 'succeeded').length,
      calls: result.tokens.calls,
      verificationCalls: result.verificationTokens.calls,
      verificationInputTokens: result.verificationTokens.input,
      verificationOutputTokens: result.verificationTokens.output,
      inputTokens: result.tokens.input,
      outputTokens: result.tokens.output,
      durationMs: Date.now() - startedAt,
      ...(cost.totalCostUsd != null ? { estimatedCostUsd: cost.totalCostUsd } : {}),
      cancelled: result.cancelled,
      ...(coverage
        ? {
            complete: coverage.complete,
            counts: coverage.counts,
            riskLevel: coverage.riskLevel,
            findings: coverage.findings.accepted,
            rejectedFindings: coverage.findings.rejected,
            usageUnits: coverage.usageUnits,
            needsInvestigation: coverage.findings.needsInvestigation ?? 0,
            dismissedFindings: coverage.findings.dismissed ?? 0,
            severityAdjusted: coverage.findings.severityAdjusted ?? 0,
            verification: coverage.findings.verification,
          }
        : { usageUnits: 0 }),
    });
  }

  private clampTokens(userTokens: number): number {
    return Math.min(2000, Math.max(150, userTokens));
  }

  /**
   * Output budget and timeout for this action. REVIEW_ENTIRE_PR uses its own configured
   * budget (a multi-file review does not fit the per-user 150–2000 setting); every other
   * action keeps the user setting and the global timeout unchanged.
   */
  private outputBudgetFor(
    action: AIAction,
    userTokens: number,
    ai: ApiConfig['ai'],
  ): { maxOutputTokens: number; requestTimeoutMs: number } {
    if (action === AIAction.REVIEW_ENTIRE_PR) {
      return {
        maxOutputTokens: ai.prReview?.maxOutputTokens ?? DEFAULT_PR_REVIEW_MAX_OUTPUT_TOKENS,
        requestTimeoutMs: Math.max(
          ai.requestTimeoutMs,
          ai.prReview?.requestTimeoutMs ?? DEFAULT_PR_REVIEW_TIMEOUT_MS,
        ),
      };
    }
    if (action === AIAction.ANALYZE_CI_FAILURE) {
      return {
        maxOutputTokens: Math.max(this.clampTokens(userTokens), STRUCTURED_OUTPUT_MIN_TOKENS),
        requestTimeoutMs: ai.requestTimeoutMs,
      };
    }
    return { maxOutputTokens: this.clampTokens(userTokens), requestTimeoutMs: ai.requestTimeoutMs };
  }

  /**
   * Project memory for memory-aware actions, loaded and authorized server-side on every
   * request. The client only names the repository; it never supplies memory text.
   * Returns null for actions that do not use memory; otherwise the applied rules or the
   * reason none were applied (also logged, as codes and counts only).
   */
  private async loadProjectMemory(
    userId: string,
    workspaceId: string,
    input: ExecuteAiActionDto,
    /** Server-resolved changed files (PR review); falls back to the client's page files. */
    resolvedChangedFiles?: { path: string }[],
  ): Promise<LoadedProjectMemory | null> {
    const capability = memoryCapabilityForAiAction(input.action);
    if (!capability) {
      return null;
    }
    // The client's explicit setting; omitted (older clients) keeps the previous default: on.
    const record = {
      requested: input.projectMemoryMode ?? 'on',
      requestSource: input.projectMemoryMode ? 'explicit' : 'default',
    } as const;
    const skipped = (
      reason: ProjectMemorySkipReason,
      extra: Record<string, unknown> = {},
    ): LoadedProjectMemory => {
      this.logger.log({
        msg: 'ai.project_memory.skipped',
        action: input.action,
        capability,
        reason,
        ...record,
        ...extra,
      });
      return { metadata: { status: 'skipped', reason, ...record, ruleCount: 0 } };
    };

    if (record.requested === 'off') {
      // Turned off for this request: no retrieval, no authorization lookups, no prompt block.
      this.logger.log({
        msg: 'ai.project_memory.disabled',
        action: input.action,
        capability,
        ...record,
      });
      return { metadata: { status: 'disabled', ...record, ruleCount: 0 } };
    }

    if (!this.projectMemory) {
      return skipped('memory_service_unavailable');
    }
    const github = input.context?.github;
    const [owner, repository] = input.memoryRepository
      ? input.memoryRepository.split('/')
      : [github?.owner ?? undefined, github?.repository ?? undefined];
    if (!owner || !repository) {
      return skipped('no_repository');
    }
    const paths = [
      ...(github?.filePath ? [github.filePath] : []),
      ...(resolvedChangedFiles ?? github?.changedFiles ?? [])
        .map((file) => file.path)
        .filter(Boolean),
    ].slice(0, 24);

    let resolved: Awaited<ReturnType<ProjectMemoryService['resolvePromptContext']>>;
    try {
      resolved = await this.projectMemory.resolvePromptContext({
        userId,
        workspaceId,
        owner,
        repository,
        capability,
        paths,
      });
    } catch (error) {
      // Unexpected failure: log the error class only — messages can carry request data.
      this.logger.warn({
        msg: 'ai.project_memory.unavailable',
        action: input.action,
        capability,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return {
        metadata: { status: 'skipped', reason: 'retrieval_failed', ...record, ruleCount: 0 },
      };
    }

    if (resolved.status === 'skipped') {
      return skipped(resolved.reason, resolved.diagnostics);
    }
    this.logger.log({
      msg: 'ai.project_memory.applied',
      action: input.action,
      capability,
      ...record,
      ruleCount: resolved.rules.length,
      version: resolved.version,
      ruleIds: resolved.rules.map((rule) => rule.id),
      ...resolved.diagnostics,
    });
    return {
      block: resolved.block,
      version: resolved.version,
      metadata: {
        status: 'applied',
        version: resolved.version,
        rules: resolved.rules,
        ...record,
        ruleCount: resolved.rules.length,
      },
    };
  }

  /**
   * Untrusted content must not impersonate project memory: defang look-alikes in every
   * message, then prepend the server's block (the only trusted memory) to the first one.
   */
  private withTrustedMemory(
    messages: ResolvedAiRun['messages'],
    memoryBlock: string | undefined,
  ): ResolvedAiRun['messages'] {
    let prepended = false;
    return messages.map((message) => {
      if (message.role !== 'user') {
        return message;
      }
      const prefix = !prepended && memoryBlock ? `${memoryBlock}\n\n` : '';
      prepended = prepended || Boolean(prefix);
      if (typeof message.content === 'string') {
        return { ...message, content: prefix + neutralizeProjectMemoryMarkers(message.content) };
      }
      const parts = message.content.map((part) =>
        part.type === 'text' ? { ...part, text: neutralizeProjectMemoryMarkers(part.text) } : part,
      );
      return {
        ...message,
        content: prefix ? [{ type: 'text' as const, text: prefix.trimEnd() }, ...parts] : parts,
      };
    });
  }

  private toRequest(input: ExecuteAiActionDto, includePageContext: boolean): AiActionRequest {
    const ai = this.config.get('ai', { infer: true });
    if (input.text.length > ai.maxInputCharacters) {
      throw new BadRequestException(`text must be at most ${ai.maxInputCharacters} characters`);
    }

    return {
      action: input.action,
      text: redactSensitiveString(input.text),
      customPrompt: input.customPrompt ? redactSensitiveString(input.customPrompt) : null,
      targetLanguage: input.targetLanguage ?? null,
      context: includePageContext ? this.toPageContext(input.context) : null,
      errorIntelligence: this.toErrorIntelligence(input.errorIntelligence),
    };
  }

  private toErrorIntelligence(
    errorIntelligence: ExecuteAiActionDto['errorIntelligence'],
  ): AiActionRequest['errorIntelligence'] {
    if (!errorIntelligence) {
      return null;
    }

    return {
      classification: {
        isError: errorIntelligence.classification.isError,
        confidence: errorIntelligence.classification.confidence,
        category: errorIntelligence.classification.category ?? undefined,
        technology: errorIntelligence.classification.technology ?? undefined,
        errorCode: errorIntelligence.classification.errorCode ?? undefined,
        signals: errorIntelligence.classification.signals ?? [],
      },
      errorText: errorIntelligence.errorText,
      stackTrace: errorIntelligence.stackTrace
        ? {
            raw: errorIntelligence.stackTrace.raw ?? undefined,
            frames: errorIntelligence.stackTrace.frames?.map((frame) => ({
              functionName: frame.functionName ?? undefined,
              file: frame.file ?? undefined,
              line: frame.line ?? undefined,
              column: frame.column ?? undefined,
            })),
          }
        : undefined,
      page: errorIntelligence.page
        ? {
            url: errorIntelligence.page.url ?? undefined,
            title: errorIntelligence.page.title ?? undefined,
          }
        : undefined,
      code: errorIntelligence.code
        ? {
            language: errorIntelligence.code.language ?? undefined,
            fileName: errorIntelligence.code.fileName ?? undefined,
            surroundingCode: errorIntelligence.code.surroundingCode ?? undefined,
          }
        : undefined,
      github: errorIntelligence.github
        ? {
            owner: errorIntelligence.github.owner ?? undefined,
            repository: errorIntelligence.github.repository ?? undefined,
            filePath: errorIntelligence.github.filePath ?? undefined,
            pullRequestNumber: errorIntelligence.github.pullRequestNumber ?? undefined,
            pullRequestTitle: errorIntelligence.github.pullRequestTitle ?? undefined,
          }
        : undefined,
    };
  }

  private toPageContext(context: ExecuteAiActionDto['context']): AiActionRequest['context'] {
    if (!context) {
      return null;
    }

    return {
      type: context.type,
      url: context.url,
      title: context.title,
      surroundingText: context.surroundingText ?? undefined,
      page: context.page
        ? {
            description: context.page.description ?? undefined,
          }
        : undefined,
      code: context.code
        ? {
            language: context.code.language ?? undefined,
            fileName: context.code.fileName ?? undefined,
            surroundingCode: context.code.surroundingCode ?? undefined,
          }
        : undefined,
      github: context.github
        ? {
            owner: context.github.owner ?? undefined,
            repository: context.github.repository ?? undefined,
            branch: context.github.branch ?? undefined,
            filePath: context.github.filePath ?? undefined,
            pullRequestTitle: context.github.pullRequestTitle ?? undefined,
            pullRequestNumber: context.github.pullRequestNumber ?? undefined,
            pullRequestBody: context.github.pullRequestBody ?? undefined,
            baseBranch: context.github.baseBranch ?? undefined,
            headBranch: context.github.headBranch ?? undefined,
            changedFiles: context.github.changedFiles?.slice(0, 12).map((file) => ({
              path: file.path,
              patchExcerpt: file.patchExcerpt ?? undefined,
            })),
            // Files beyond the 12 accepted here are never silently dropped: flag truncation.
            changedFilesTruncated:
              (context.github.changedFiles?.length ?? 0) > 12
                ? true
                : (context.github.changedFilesTruncated ?? undefined),
            filesTab: context.github.filesTab ?? undefined,
          }
        : undefined,
    };
  }

  private toSafeError(error: unknown): Error {
    if (error instanceof BadRequestException || error instanceof ServiceUnavailableException) {
      return error;
    }

    return new ServiceUnavailableException('Unable to generate a response.');
  }

  private logFailure(
    msg: string,
    request: AiActionRequest,
    startedAt: number,
    error: unknown,
  ): void {
    const err = error instanceof Error ? error : new Error('Unknown AI error');
    this.logger.error({
      msg,
      action: request.action,
      provider: this.modelFactory.getProviderName(),
      model: this.modelFactory.getModelName(),
      durationMs: Date.now() - startedAt,
      inputLength: request.text.length,
      contextType: request.context?.type ?? null,
      contextHost: this.safeHost(request.context?.url),
      errorName: err.name,
      // N-7: provider errors may echo request content.
      errorMessage: redactErrorMessageForLog(err.message),
    });
  }

  private safeHost(url: string | undefined): string | null {
    if (!url) {
      return null;
    }
    try {
      return new URL(url).host;
    } catch {
      return null;
    }
  }
}

/**
 * Identity of one user's logical AI operation, used only to reject an identical request while
 * the first is still running. Bound to the authenticated user and action; hashed (no content
 * is stored).
 */
/**
 * A memory-off request is a different logical request from a memory-on one: it must never be
 * deduplicated against, or replay the result of, the other. `on` (explicit or default) adds
 * nothing, so request keys of existing clients are unchanged.
 */
function memoryModeKeyPart(input: ExecuteAiActionDto): { memory?: 'off' } {
  return input.projectMemoryMode === 'off' ? { memory: 'off' } : {};
}

/**
 * Stored (replay) copy of memory metadata: rule identifiers, categories and counts only —
 * never rule text. A replayed report shows the rule key where the title would be.
 */
export function withoutRuleText(
  metadata: ProjectMemoryPromptMetadata,
): ProjectMemoryPromptMetadata {
  if (metadata.status !== 'applied') return metadata;
  return { ...metadata, rules: metadata.rules.map((rule) => ({ ...rule, title: '' })) };
}

function inFlightKey(userId: string, action: string, payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([userId, action, payload]))
    .digest('hex');
}

/** The provider answered, with no text at all (settled as provider work, not as a failure). */
class EmptyProviderOutput extends ServiceUnavailableException {
  constructor() {
    super('Unable to generate a response.');
  }
}

/** The caller's `validate` rejected the model output (refunded; rethrown as the cause). */
class OutputRejected extends Error {
  constructor(override readonly cause: unknown) {
    super('output rejected');
  }
}
