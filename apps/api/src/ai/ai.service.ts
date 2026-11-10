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
import { neutralizeProjectMemoryMarkers, responseStyleHint } from './prompts/prompt.utils';
import { memoryCapabilityForAiAction, redactSensitiveString } from '@project-x/shared';
import {
  AIAction,
  PR_REVIEW_INCOMPLETE_MARKER,
  PR_REVIEW_SCOPE_HEADER,
  PROJECT_MEMORY_METADATA_HEADER,
  type PageContextGitHub,
  type PRReviewScope,
  type ProjectMemoryPromptMetadata,
  type ProjectMemorySkipReason,
} from '@project-x/types';
import { ProjectMemoryService } from '../project-memory/project-memory.service';
import { PullRequestDiffService } from './pr-review/pull-request-diff.service';

export interface AiTextStreamHandle {
  pipeTextStreamToResponse: (response: ServerResponse) => Promise<void>;
}

type StreamTextHandle = ReturnType<typeof streamText>;

/** Trailer appended to a PR review that ended before the model finished normally. */
export function prReviewIncompleteTrailer(reason: string): string {
  return `\n\n${PR_REVIEW_INCOMPLETE_MARKER} reason=${reason}]]`;
}

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
    @Optional()
    @Inject(forwardRef(() => ProjectMemoryService))
    private readonly projectMemory?: ProjectMemoryService,
    // Optional so unit tests that build AiService by hand keep the legacy (page-only) path.
    @Optional()
    private readonly pullRequestDiff?: PullRequestDiffService,
  ) {}

  async generateAction(userId: string, input: ExecuteAiActionDto): Promise<string> {
    return (await this.generateActionWithMetadata(userId, input)).text;
  }

  /** Like {@link generateAction}, plus the review scope and project memory metadata. */
  async generateActionWithMetadata(
    userId: string,
    input: ExecuteAiActionDto,
  ): Promise<{
    text: string;
    reviewScope?: PRReviewScope;
    projectMemory?: ProjectMemoryPromptMetadata;
  }> {
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
      };
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
    const run = await this.resolveRun(userId, input);
    return this.streamResolvedRun(userId, run, abortSignal);
  }

  private async streamResolvedRun(
    userId: string,
    run: ResolvedAiRun,
    abortSignal?: AbortSignal,
  ): Promise<StreamTextHandle> {
    const startedAt = Date.now();
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
    const run = await this.resolveRun(userId, input);
    const result = await this.streamResolvedRun(userId, run, abortSignal);
    if (run.request.action !== AIAction.REVIEW_ENTIRE_PR) {
      await result.pipeTextStreamToResponse(response);
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
    await this.pipePrReviewStream(result, response, abortSignal);
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

  private async resolveRun(userId: string, input: ExecuteAiActionDto): Promise<ResolvedAiRun> {
    const ai = this.config.get('ai', { infer: true });
    const settings = await this.settingsService.getForUser(userId);
    const request = this.toRequest(input, settings.includePageContext);

    const workspaceId = await resolveWorkspaceIdForUser(
      this.prisma,
      userId,
      this.requestContext.get()?.workspaceId,
    );
    await this.featureGate.require(workspaceId, featureForAiAction(request.action));

    // Resolve the PR diff before usage is consumed: when no diff can be loaded the request
    // fails with PR_DIFF_UNAVAILABLE and neither the AI nor the quota is touched.
    const reviewScope =
      request.action === AIAction.REVIEW_ENTIRE_PR
        ? await this.attachPullRequestDiff(userId, workspaceId, input, request)
        : undefined;

    await this.usage.consume({
      workspaceId,
      metric: usageMetricForAiAction(request.action),
      quantity: 1,
      ...(input.executionId ? { idempotencyKey: `ai:${input.executionId}:${request.action}` } : {}),
    });

    const built = this.promptRegistry.build(request);
    const promptName = this.promptRegistry.registryNameFor(request.action);
    const memory = await this.loadProjectMemory(
      userId,
      workspaceId,
      input,
      request.context?.github?.changedFiles,
    );
    const prompt = { ...built, messages: this.withTrustedMemory(built.messages, memory?.block) };

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

    return {
      request,
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

  /**
   * REVIEW_ENTIRE_PR: replace the page-scraped file list with the GitHub API diff (falling
   * back to page files only when GitHub is unusable) and record the real review scope.
   * PR identity comes from the request even when page context sharing is off, since the
   * action cannot run without it; page-scraped diff text is only used when sharing is on.
   */
  private async attachPullRequestDiff(
    userId: string,
    workspaceId: string,
    input: ExecuteAiActionDto,
    request: AiActionRequest,
  ): Promise<PRReviewScope | undefined> {
    if (!this.pullRequestDiff) {
      return undefined;
    }
    const identity = input.context?.github;
    const pageGithub = request.context?.github;
    const diff = await this.pullRequestDiff.resolve({
      userId,
      workspaceId,
      owner: identity?.owner,
      repository: identity?.repository,
      pullRequestNumber: identity?.pullRequestNumber,
      pageFiles: pageGithub?.changedFiles,
      pageTruncated: pageGithub?.changedFilesTruncated,
    });

    const github: PageContextGitHub = {
      ...(pageGithub ?? {}),
      owner: identity?.owner ?? undefined,
      repository: identity?.repository ?? undefined,
      pullRequestNumber: identity?.pullRequestNumber ?? undefined,
      changedFiles: diff.changedFiles,
      changedFilesTruncated: diff.scope.truncated,
      changedFilesSource: diff.scope.source,
      ...(diff.scope.totalFiles != null ? { changedFilesTotal: diff.scope.totalFiles } : {}),
      ...(diff.pullRequestTitle && !pageGithub?.pullRequestTitle
        ? { pullRequestTitle: diff.pullRequestTitle }
        : {}),
      ...(diff.baseBranch ? { baseBranch: diff.baseBranch } : {}),
      ...(diff.headBranch ? { headBranch: diff.headBranch } : {}),
    };
    request.context = request.context
      ? { ...request.context, github }
      : {
          type: 'github',
          url: `https://github.com/${github.owner}/${github.repository}/pull/${github.pullRequestNumber}`,
          title: github.pullRequestTitle ?? `PR #${github.pullRequestNumber}`,
          github,
        };
    return diff.scope;
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
    const skipped = (
      reason: ProjectMemorySkipReason,
      extra: Record<string, unknown> = {},
    ): LoadedProjectMemory => {
      this.logger.log({
        msg: 'ai.project_memory.skipped',
        action: input.action,
        capability,
        reason,
        ...extra,
      });
      return { metadata: { status: 'skipped', reason } };
    };

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
      return { metadata: { status: 'skipped', reason: 'retrieval_failed' } };
    }

    if (resolved.status === 'skipped') {
      return skipped(resolved.reason, resolved.diagnostics);
    }
    this.logger.log({
      msg: 'ai.project_memory.applied',
      action: input.action,
      capability,
      version: resolved.version,
      ruleIds: resolved.rules.map((rule) => rule.id),
      ...resolved.diagnostics,
    });
    return {
      block: resolved.block,
      version: resolved.version,
      metadata: { status: 'applied', version: resolved.version, rules: resolved.rules },
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
