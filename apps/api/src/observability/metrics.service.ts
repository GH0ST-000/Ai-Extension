import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeModelLabel, normalizeRouteTemplate, httpStatusClass } from '@project-x/shared';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { ApiConfig } from '../config/configuration';

/**
 * Prometheus metrics — bounded labels only.
 * NEVER label with workspaceId/userId/repository/PR/requestId/executionId/traceId.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry: Registry;

  private readonly httpRequestsTotal: Counter;
  private readonly httpRequestDuration: Histogram;
  private readonly aiRequestsTotal: Counter;
  private readonly aiRequestDuration: Histogram;
  private readonly aiTokensInput: Counter;
  private readonly aiTokensOutput: Counter;
  private readonly aiStreamFirstToken: Histogram;
  private readonly aiRequestFailures: Counter;
  private readonly aiRetries: Counter;
  private readonly aiEstimatedCost: Counter;
  private readonly aiTimeouts: Counter;
  private readonly providerRequestsTotal: Counter;
  private readonly providerRequestDuration: Histogram;
  private readonly providerFailures: Counter;
  private readonly providerRateLimitEvents: Counter;
  private readonly providerTimeouts: Counter;
  private readonly githubRateLimitRemaining: Gauge;
  private readonly workflowExecutionsTotal: Counter;
  private readonly workflowExecutionDuration: Histogram;
  private readonly workflowStepTotal: Counter;
  private readonly workflowStepDuration: Histogram;
  private readonly workflowRetries: Counter;
  private readonly workflowReplans: Counter;
  private readonly workflowResumes: Counter;
  private readonly workflowReplays: Counter;
  private readonly workflowStaleEvents: Counter;
  private readonly workflowUncertainWrites: Counter;
  private readonly writeOutcomeUnknown: Counter;
  private readonly staleContextEvents: Counter;
  private readonly agentPlansTotal: Counter;
  private readonly agentPlanSteps: Histogram;
  private readonly agentPlanDuration: Histogram;
  private readonly agentPlanRevisions: Counter;
  private readonly agentPlanValidationFailures: Counter;
  private readonly agentGoalOutcomes: Counter;
  private readonly projectMemoryOperations: Counter;
  private readonly projectMemoryRefreshDuration: Histogram;
  private readonly projectMemoryConflicts: Counter;
  private readonly multiRepoAnalyses: Counter;
  private readonly multiRepoReposAnalyzed: Histogram;
  private readonly multiRepoAnalysisDuration: Histogram;
  private readonly multiRepoPartialScope: Counter;
  private readonly billingWebhookEvents: Counter;
  private readonly billingCheckoutRequests: Counter;
  private readonly webhookEvents: Counter;
  private readonly webhookProcessingDuration: Histogram;
  private readonly cacheRequests: Counter;
  private readonly rateLimitRejections: Counter;
  private readonly usageLimitRejections: Counter;
  private readonly redisOperationFailures: Counter;
  private readonly redisOperationDuration: Histogram;
  private readonly dbOperationDuration: Histogram;
  private readonly clientTelemetryTotal: Counter;
  private readonly buildInfo: Gauge;

  constructor(private readonly config: ConfigService<ApiConfig, true>) {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: 'project_x_' });

    const service = this.config.get('service', { infer: true });
    const environment = this.config.get('nodeEnv', { infer: true });
    const release = this.config.get('release', { infer: true });

    this.buildInfo = new Gauge({
      name: 'project_x_build_info',
      help: 'Build metadata (value always 1)',
      labelNames: ['service', 'environment', 'version'],
      registers: [this.registry],
    });
    this.buildInfo.set({ service, environment, version: release }, 1);

    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests',
      labelNames: ['method', 'route_template', 'status_class', 'service'],
      registers: [this.registry],
    });

    this.httpRequestDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route_template', 'service'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });

    this.aiRequestsTotal = new Counter({
      name: 'ai_requests_total',
      help: 'AI provider requests',
      labelNames: ['provider', 'model', 'capability', 'status'],
      registers: [this.registry],
    });

    this.aiRequestDuration = new Histogram({
      name: 'ai_request_duration_seconds',
      help: 'AI request duration',
      labelNames: ['provider', 'model', 'capability'],
      buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
      registers: [this.registry],
    });

    this.aiTokensInput = new Counter({
      name: 'ai_tokens_input_total',
      help: 'AI input tokens',
      labelNames: ['provider', 'model', 'capability'],
      registers: [this.registry],
    });

    this.aiTokensOutput = new Counter({
      name: 'ai_tokens_output_total',
      help: 'AI output tokens',
      labelNames: ['provider', 'model', 'capability'],
      registers: [this.registry],
    });

    this.aiStreamFirstToken = new Histogram({
      name: 'ai_stream_first_token_duration_seconds',
      help: 'AI streaming TTFT',
      labelNames: ['provider', 'model', 'capability'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
      registers: [this.registry],
    });

    this.aiRequestFailures = new Counter({
      name: 'ai_request_failures_total',
      help: 'AI request failures',
      labelNames: ['provider', 'model', 'capability', 'error_code'],
      registers: [this.registry],
    });

    this.aiRetries = new Counter({
      name: 'ai_retries_total',
      help: 'AI retries',
      labelNames: ['provider', 'model', 'capability', 'reason'],
      registers: [this.registry],
    });

    this.aiEstimatedCost = new Counter({
      name: 'ai_estimated_cost_usd_total',
      help: 'Estimated AI cost USD (operational, not billing)',
      labelNames: ['provider', 'model', 'capability'],
      registers: [this.registry],
    });

    this.aiTimeouts = new Counter({
      name: 'ai_timeouts_total',
      help: 'AI timeouts',
      labelNames: ['provider', 'model', 'capability'],
      registers: [this.registry],
    });

    this.providerRequestsTotal = new Counter({
      name: 'provider_requests_total',
      help: 'External provider requests',
      labelNames: ['provider', 'operation', 'status'],
      registers: [this.registry],
    });

    this.providerRequestDuration = new Histogram({
      name: 'provider_request_duration_seconds',
      help: 'External provider latency',
      labelNames: ['provider', 'operation'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.providerFailures = new Counter({
      name: 'provider_failures_total',
      help: 'External provider failures',
      labelNames: ['provider', 'operation', 'error_code'],
      registers: [this.registry],
    });

    this.providerRateLimitEvents = new Counter({
      name: 'provider_rate_limit_events_total',
      help: 'External provider rate-limit events',
      labelNames: ['provider', 'operation'],
      registers: [this.registry],
    });

    this.providerTimeouts = new Counter({
      name: 'provider_timeouts_total',
      help: 'External provider timeouts',
      labelNames: ['provider', 'operation'],
      registers: [this.registry],
    });

    this.githubRateLimitRemaining = new Gauge({
      name: 'github_rate_limit_remaining',
      help: 'Latest observed GitHub rate-limit remaining',
      labelNames: ['resource'],
      registers: [this.registry],
    });

    this.workflowExecutionsTotal = new Counter({
      name: 'workflow_executions_total',
      help: 'Workflow executions',
      labelNames: ['workflow_type', 'status'],
      registers: [this.registry],
    });

    this.workflowExecutionDuration = new Histogram({
      name: 'workflow_execution_duration_seconds',
      help: 'Workflow execution duration',
      labelNames: ['workflow_type', 'status'],
      buckets: [1, 5, 15, 30, 60, 120, 300, 600],
      registers: [this.registry],
    });

    this.workflowStepTotal = new Counter({
      name: 'workflow_step_total',
      help: 'Workflow steps',
      labelNames: ['step_type', 'status'],
      registers: [this.registry],
    });

    this.workflowStepDuration = new Histogram({
      name: 'workflow_step_duration_seconds',
      help: 'Workflow step duration',
      labelNames: ['step_type', 'status'],
      buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120],
      registers: [this.registry],
    });

    this.workflowRetries = new Counter({
      name: 'workflow_retries_total',
      help: 'Workflow retries',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.workflowReplans = new Counter({
      name: 'workflow_replans_total',
      help: 'Workflow replans',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.workflowResumes = new Counter({
      name: 'workflow_resumes_total',
      help: 'Workflow resumes',
      registers: [this.registry],
    });

    this.workflowReplays = new Counter({
      name: 'workflow_replays_total',
      help: 'Workflow replays',
      registers: [this.registry],
    });

    this.workflowStaleEvents = new Counter({
      name: 'workflow_stale_events_total',
      help: 'Workflow stale events',
      registers: [this.registry],
    });

    this.workflowUncertainWrites = new Counter({
      name: 'workflow_uncertain_writes_total',
      help: 'Workflow uncertain write outcomes',
      registers: [this.registry],
    });

    this.writeOutcomeUnknown = new Counter({
      name: 'write_outcome_unknown_total',
      help: 'Unknown write outcomes',
      labelNames: ['provider', 'operation'],
      registers: [this.registry],
    });

    this.staleContextEvents = new Counter({
      name: 'stale_context_events_total',
      help: 'Stale context events',
      labelNames: ['context_type'],
      registers: [this.registry],
    });

    this.agentPlansTotal = new Counter({
      name: 'agent_plans_total',
      help: 'Agent plans',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.agentPlanSteps = new Histogram({
      name: 'agent_plan_steps',
      help: 'Agent plan step counts',
      buckets: [1, 2, 3, 5, 8, 13, 21],
      registers: [this.registry],
    });

    this.agentPlanDuration = new Histogram({
      name: 'agent_plan_duration_seconds',
      help: 'Agent plan duration',
      buckets: [0.5, 1, 2, 5, 10, 30, 60],
      registers: [this.registry],
    });

    this.agentPlanRevisions = new Counter({
      name: 'agent_plan_revisions_total',
      help: 'Agent plan revisions',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.agentPlanValidationFailures = new Counter({
      name: 'agent_plan_validation_failures_total',
      help: 'Agent plan validation failures',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.agentGoalOutcomes = new Counter({
      name: 'agent_goal_outcomes_total',
      help: 'Agent goal outcomes',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.projectMemoryOperations = new Counter({
      name: 'project_memory_operations_total',
      help: 'Project memory operations',
      labelNames: ['operation', 'status'],
      registers: [this.registry],
    });

    this.projectMemoryRefreshDuration = new Histogram({
      name: 'project_memory_refresh_duration_seconds',
      help: 'Project memory refresh duration',
      buckets: [0.1, 0.5, 1, 2, 5, 15, 30],
      registers: [this.registry],
    });

    this.projectMemoryConflicts = new Counter({
      name: 'project_memory_conflicts_total',
      help: 'Project memory conflicts',
      registers: [this.registry],
    });

    this.multiRepoAnalyses = new Counter({
      name: 'multi_repo_analyses_total',
      help: 'Multi-repo analyses',
      labelNames: ['type', 'status'],
      registers: [this.registry],
    });

    this.multiRepoReposAnalyzed = new Histogram({
      name: 'multi_repo_repositories_analyzed',
      help: 'Repositories analyzed per multi-repo operation',
      buckets: [1, 2, 3, 5, 8, 13, 21],
      registers: [this.registry],
    });

    this.multiRepoAnalysisDuration = new Histogram({
      name: 'multi_repo_analysis_duration_seconds',
      help: 'Multi-repo analysis duration',
      buckets: [0.5, 1, 2, 5, 15, 30, 60, 120],
      registers: [this.registry],
    });

    this.multiRepoPartialScope = new Counter({
      name: 'multi_repo_partial_scope_total',
      help: 'Multi-repo partial scope events',
      registers: [this.registry],
    });

    this.billingWebhookEvents = new Counter({
      name: 'billing_webhook_events_total',
      help: 'Billing webhook events',
      labelNames: ['event_type_normalized', 'status'],
      registers: [this.registry],
    });

    this.billingCheckoutRequests = new Counter({
      name: 'billing_checkout_requests_total',
      help: 'Billing checkout requests',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.webhookEvents = new Counter({
      name: 'webhook_events_total',
      help: 'Webhook events',
      labelNames: ['provider', 'event_type_normalized', 'status'],
      registers: [this.registry],
    });

    this.webhookProcessingDuration = new Histogram({
      name: 'webhook_processing_duration_seconds',
      help: 'Webhook processing duration',
      labelNames: ['provider', 'event_type_normalized'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
      registers: [this.registry],
    });

    this.cacheRequests = new Counter({
      name: 'cache_requests_total',
      help: 'Cache requests',
      labelNames: ['cache', 'operation', 'result'],
      registers: [this.registry],
    });

    this.rateLimitRejections = new Counter({
      name: 'rate_limit_rejections_total',
      help: 'Internal rate-limit rejections',
      labelNames: ['scope', 'route_group'],
      registers: [this.registry],
    });

    this.usageLimitRejections = new Counter({
      name: 'usage_limit_rejections_total',
      help: 'Day 25 usage quota rejections',
      labelNames: ['metric', 'plan'],
      registers: [this.registry],
    });

    this.redisOperationFailures = new Counter({
      name: 'redis_operation_failures_total',
      help: 'Redis operation failures',
      labelNames: ['operation_group'],
      registers: [this.registry],
    });

    this.redisOperationDuration = new Histogram({
      name: 'redis_operation_duration_seconds',
      help: 'Redis operation duration',
      labelNames: ['operation_group'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
      registers: [this.registry],
    });

    this.dbOperationDuration = new Histogram({
      name: 'db_operation_duration_seconds',
      help: 'Important DB operation duration',
      labelNames: ['operation_group'],
      buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2],
      registers: [this.registry],
    });

    this.clientTelemetryTotal = new Counter({
      name: 'client_telemetry_events_total',
      help: 'Client telemetry ingest events',
      labelNames: ['client', 'event', 'status'],
      registers: [this.registry],
    });
  }

  onModuleDestroy(): void {
    try {
      this.registry.clear();
    } catch {
      // ignore
    }
  }

  safeIncrement(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.logger.warn({
        msg: 'metrics.increment.failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  recordHttpRequest(input: {
    method: string;
    route: string;
    statusCode: number;
    durationSeconds: number;
  }): void {
    this.safeIncrement(() => {
      const service = this.config.get('service', { infer: true });
      const route = normalizeRouteTemplate(input.route);
      const method = input.method.toUpperCase();
      const status = httpStatusClass(input.statusCode);
      this.httpRequestsTotal.inc({
        method,
        route_template: route,
        status_class: status,
        service,
      });
      this.httpRequestDuration.observe(
        { method, route_template: route, service },
        input.durationSeconds,
      );
    });
  }

  recordAiRequest(input: {
    provider: string;
    model: string;
    capability: string;
    status: 'success' | 'failure' | 'aborted';
    durationSeconds: number;
    inputTokens?: number;
    outputTokens?: number;
    firstTokenSeconds?: number;
    estimatedCostUsd?: number;
    errorCode?: string;
    timedOut?: boolean;
  }): void {
    this.safeIncrement(() => {
      const model = normalizeModelLabel(input.provider, input.model);
      const labels = {
        provider: input.provider,
        model,
        capability: input.capability.slice(0, 64),
      };
      this.aiRequestsTotal.inc({ ...labels, status: input.status });
      this.aiRequestDuration.observe(labels, input.durationSeconds);
      if (input.inputTokens != null && input.inputTokens > 0) {
        this.aiTokensInput.inc(labels, input.inputTokens);
      }
      if (input.outputTokens != null && input.outputTokens > 0) {
        this.aiTokensOutput.inc(labels, input.outputTokens);
      }
      if (input.firstTokenSeconds != null) {
        this.aiStreamFirstToken.observe(labels, input.firstTokenSeconds);
      }
      if (input.estimatedCostUsd != null && input.estimatedCostUsd > 0) {
        this.aiEstimatedCost.inc(labels, input.estimatedCostUsd);
      }
      if (input.status === 'failure' && input.errorCode) {
        this.aiRequestFailures.inc({
          ...labels,
          error_code: input.errorCode.slice(0, 64),
        });
      }
      if (input.timedOut) {
        this.aiTimeouts.inc(labels);
      }
    });
  }

  recordAiRetry(input: {
    provider: string;
    model: string;
    capability: string;
    reason: string;
  }): void {
    this.safeIncrement(() => {
      this.aiRetries.inc({
        provider: input.provider,
        model: normalizeModelLabel(input.provider, input.model),
        capability: input.capability.slice(0, 64),
        reason: input.reason.slice(0, 64),
      });
    });
  }

  recordProviderRequest(input: {
    provider: string;
    operation: string;
    status: 'success' | 'failure' | 'timeout' | 'rate_limited';
    durationSeconds: number;
    errorCode?: string;
  }): void {
    this.safeIncrement(() => {
      const labels = {
        provider: input.provider,
        operation: input.operation.slice(0, 64),
      };
      this.providerRequestsTotal.inc({ ...labels, status: input.status });
      this.providerRequestDuration.observe(labels, input.durationSeconds);
      if (input.status === 'failure' && input.errorCode) {
        this.providerFailures.inc({
          ...labels,
          error_code: input.errorCode.slice(0, 64),
        });
      }
      if (input.status === 'rate_limited') {
        this.providerRateLimitEvents.inc(labels);
      }
      if (input.status === 'timeout') {
        this.providerTimeouts.inc(labels);
      }
    });
  }

  setGithubRateLimitRemaining(resource: string, remaining: number): void {
    this.safeIncrement(() => {
      this.githubRateLimitRemaining.set({ resource: resource.slice(0, 32) }, remaining);
    });
  }

  recordWorkflowExecution(input: {
    workflowType: string;
    status: string;
    durationSeconds?: number;
  }): void {
    this.safeIncrement(() => {
      const labels = {
        workflow_type: input.workflowType.slice(0, 64),
        status: input.status.slice(0, 32),
      };
      this.workflowExecutionsTotal.inc(labels);
      if (input.durationSeconds != null) {
        this.workflowExecutionDuration.observe(labels, input.durationSeconds);
      }
    });
  }

  recordWorkflowStep(input: { stepType: string; status: string; durationSeconds?: number }): void {
    this.safeIncrement(() => {
      const labels = {
        step_type: input.stepType.slice(0, 64),
        status: input.status.slice(0, 32),
      };
      this.workflowStepTotal.inc(labels);
      if (input.durationSeconds != null) {
        this.workflowStepDuration.observe(labels, input.durationSeconds);
      }
    });
  }

  recordWorkflowRetry(reason: string): void {
    this.safeIncrement(() => this.workflowRetries.inc({ reason: reason.slice(0, 64) }));
  }

  recordWorkflowReplan(reason: string): void {
    this.safeIncrement(() => this.workflowReplans.inc({ reason: reason.slice(0, 64) }));
  }

  recordWorkflowResume(): void {
    this.safeIncrement(() => this.workflowResumes.inc());
  }

  recordWorkflowReplay(): void {
    this.safeIncrement(() => this.workflowReplays.inc());
  }

  recordWorkflowStale(): void {
    this.safeIncrement(() => this.workflowStaleEvents.inc());
  }

  recordUncertainWrite(): void {
    this.safeIncrement(() => this.workflowUncertainWrites.inc());
  }

  recordWriteOutcomeUnknown(provider: string, operation: string): void {
    this.safeIncrement(() =>
      this.writeOutcomeUnknown.inc({
        provider,
        operation: operation.slice(0, 64),
      }),
    );
  }

  recordStaleContext(contextType: string): void {
    this.safeIncrement(() =>
      this.staleContextEvents.inc({ context_type: contextType.slice(0, 64) }),
    );
  }

  recordAgentPlan(input: { status: string; stepCount?: number; durationSeconds?: number }): void {
    this.safeIncrement(() => {
      this.agentPlansTotal.inc({ status: input.status.slice(0, 32) });
      if (input.stepCount != null) this.agentPlanSteps.observe(input.stepCount);
      if (input.durationSeconds != null) {
        this.agentPlanDuration.observe(input.durationSeconds);
      }
    });
  }

  recordAgentPlanRevision(reason: string): void {
    this.safeIncrement(() => this.agentPlanRevisions.inc({ reason: reason.slice(0, 64) }));
  }

  recordAgentPlanValidationFailure(reason: string): void {
    this.safeIncrement(() => this.agentPlanValidationFailures.inc({ reason: reason.slice(0, 64) }));
  }

  recordAgentGoalOutcome(status: string): void {
    this.safeIncrement(() => this.agentGoalOutcomes.inc({ status: status.slice(0, 32) }));
  }

  recordProjectMemory(operation: string, status: string, durationSeconds?: number): void {
    this.safeIncrement(() => {
      this.projectMemoryOperations.inc({
        operation: operation.slice(0, 64),
        status: status.slice(0, 32),
      });
      if (durationSeconds != null && operation.includes('refresh')) {
        this.projectMemoryRefreshDuration.observe(durationSeconds);
      }
    });
  }

  recordProjectMemoryConflict(): void {
    this.safeIncrement(() => this.projectMemoryConflicts.inc());
  }

  recordMultiRepo(input: {
    type: string;
    status: string;
    repoCount?: number;
    durationSeconds?: number;
    partialScope?: boolean;
  }): void {
    this.safeIncrement(() => {
      this.multiRepoAnalyses.inc({
        type: input.type.slice(0, 64),
        status: input.status.slice(0, 32),
      });
      if (input.repoCount != null) {
        this.multiRepoReposAnalyzed.observe(input.repoCount);
      }
      if (input.durationSeconds != null) {
        this.multiRepoAnalysisDuration.observe(input.durationSeconds);
      }
      if (input.partialScope) this.multiRepoPartialScope.inc();
    });
  }

  recordBillingWebhook(eventType: string, status: string): void {
    this.safeIncrement(() =>
      this.billingWebhookEvents.inc({
        event_type_normalized: eventType.slice(0, 64),
        status: status.slice(0, 32),
      }),
    );
  }

  recordBillingCheckout(status: string): void {
    this.safeIncrement(() => this.billingCheckoutRequests.inc({ status: status.slice(0, 32) }));
  }

  recordWebhook(input: {
    provider: string;
    eventType: string;
    status: string;
    durationSeconds?: number;
  }): void {
    this.safeIncrement(() => {
      const labels = {
        provider: input.provider,
        event_type_normalized: input.eventType.slice(0, 64),
      };
      this.webhookEvents.inc({ ...labels, status: input.status.slice(0, 32) });
      if (input.durationSeconds != null) {
        this.webhookProcessingDuration.observe(labels, input.durationSeconds);
      }
    });
  }

  recordCache(cache: string, operation: string, result: 'hit' | 'miss' | 'error'): void {
    this.safeIncrement(() =>
      this.cacheRequests.inc({
        cache: cache.slice(0, 64),
        operation: operation.slice(0, 32),
        result,
      }),
    );
  }

  recordRateLimitRejection(scope: string, routeGroup: string): void {
    this.safeIncrement(() =>
      this.rateLimitRejections.inc({
        scope: scope.slice(0, 64),
        route_group: routeGroup.slice(0, 64),
      }),
    );
  }

  recordUsageLimitRejection(metric: string, plan: string): void {
    this.safeIncrement(() =>
      this.usageLimitRejections.inc({
        metric: metric.slice(0, 64),
        plan: plan.slice(0, 32),
      }),
    );
  }

  recordRedis(operationGroup: string, durationSeconds: number, failed?: boolean): void {
    this.safeIncrement(() => {
      const group = operationGroup.slice(0, 64);
      this.redisOperationDuration.observe({ operation_group: group }, durationSeconds);
      if (failed) this.redisOperationFailures.inc({ operation_group: group });
    });
  }

  recordDb(operationGroup: string, durationSeconds: number): void {
    this.safeIncrement(() =>
      this.dbOperationDuration.observe(
        { operation_group: operationGroup.slice(0, 64) },
        durationSeconds,
      ),
    );
  }

  recordClientTelemetry(client: string, event: string, status: string): void {
    this.safeIncrement(() =>
      this.clientTelemetryTotal.inc({
        client: client.slice(0, 32),
        event: event.slice(0, 64),
        status: status.slice(0, 32),
      }),
    );
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
