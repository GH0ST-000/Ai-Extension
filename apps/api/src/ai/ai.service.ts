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
import type { ServerResponse } from 'node:http';
import type { ApiConfig } from '../config/configuration';
import { FeatureGate } from '../entitlements/feature-gate';
import { featureForAiAction, usageMetricForAiAction } from '../entitlements/feature-for-ai-action';
import { AiObservabilityService } from '../observability/ai-observability.service';
import { ProviderHealthService } from '../observability/provider-health.service';
import { RequestContextService } from '../observability/request-context.service';
import { ReliabilityService } from '../reliability/reliability.service';
import { SettingsService } from '../settings/settings.service';
import { UsageService } from '../usage/usage.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { PrismaService } from '../prisma/prisma.service';
import type { ExecuteAiActionDto } from './dto/execute-ai-action.dto';
import type { AiActionRequest } from './interfaces/ai-prompt-definition.interface';
import { AiModelFactory } from './models/ai-model.factory';
import { PromptRegistry } from './prompts/prompt.registry';
import { responseStyleHint } from './prompts/prompt.utils';

export interface AiTextStreamHandle {
  pipeTextStreamToResponse: (response: ServerResponse) => Promise<void>;
}

type ResolvedAiRun = {
  request: AiActionRequest;
  instructions: string;
  messages: ReturnType<PromptRegistry['build']>['messages'];
  maxOutputTokens: number;
  requestTimeoutMs: number;
  executionId?: string;
  promptName: string;
  contextVersions: {
    memoryVersion?: string;
    systemContextVersion?: string;
    openapiVersion?: string;
    jiraVersion?: string;
  };
};

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
  ) {}

  async generateAction(userId: string, input: ExecuteAiActionDto): Promise<string> {
    const startedAt = Date.now();
    const run = await this.resolveRun(userId, input);
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
            throw new ServiceUnavailableException('Unable to generate a response.');
          }
          return {
            result: out,
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

      return text;
    } catch (error) {
      this.providerHealth.recordSignal('ai', false);
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
    const startedAt = Date.now();
    const run = await this.resolveRun(userId, input);
    const provider = this.modelFactory.getProviderName();
    const model = this.modelFactory.getModelName();
    const capability = String(run.request.action);
    const aiOperationId = this.aiObservability.createOperationId();
    let firstTokenAt: number | undefined;

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
        onChunk: () => {
          if (firstTokenAt == null) firstTokenAt = Date.now();
        },
        onFinish: ({ text, usage }) => {
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
    const result = await this.streamAction(userId, input, abortSignal);
    await result.pipeTextStreamToResponse(response);
  }

  private async resolveRun(userId: string, input: ExecuteAiActionDto): Promise<ResolvedAiRun> {
    const ai = this.config.get('ai', { infer: true });
    const settings = await this.settingsService.getForUser(userId);
    const request = this.toRequest(input, settings.includePageContext);

    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    await this.featureGate.require(workspaceId, featureForAiAction(request.action));
    await this.usage.consume({
      workspaceId,
      metric: usageMetricForAiAction(request.action),
      quantity: 1,
      ...(input.executionId ? { idempotencyKey: `ai:${input.executionId}:${request.action}` } : {}),
    });

    const prompt = this.promptRegistry.build(request);
    const promptName = this.promptRegistry.registryNameFor(request.action);

    let contextVersions: ResolvedAiRun['contextVersions'] = {};
    if (input.executionId && this.reliability) {
      try {
        const detail = await this.reliability.getExecution(userId, input.executionId);
        const ctx = detail.contextVersion;
        contextVersions = {
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

    return {
      request,
      instructions: `${prompt.instructions} ${responseStyleHint(settings.responseStyle)}`,
      messages: prompt.messages,
      maxOutputTokens: this.clampTokens(settings.maxOutputTokens),
      requestTimeoutMs: ai.requestTimeoutMs,
      promptName,
      contextVersions,
      ...(input.executionId ? { executionId: input.executionId } : {}),
    };
  }

  private clampTokens(userTokens: number): number {
    return Math.min(2000, Math.max(150, userTokens));
  }

  private toRequest(input: ExecuteAiActionDto, includePageContext: boolean): AiActionRequest {
    const ai = this.config.get('ai', { infer: true });
    if (input.text.length > ai.maxInputCharacters) {
      throw new BadRequestException(`text must be at most ${ai.maxInputCharacters} characters`);
    }

    return {
      action: input.action,
      text: input.text,
      customPrompt: input.customPrompt ?? null,
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
            changedFilesTruncated: context.github.changedFilesTruncated ?? undefined,
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
      errorMessage: err.message,
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
