import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ObservabilityContext } from '@project-x/types';

export type RequestContextStore = ObservabilityContext & {
  sampled?: boolean;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * AsyncLocalStorage-backed request/trace context.
 * Must not use global mutable state — concurrent requests stay isolated.
 */
@Injectable()
export class RequestContextService {
  run<T>(context: RequestContextStore, fn: () => T): T {
    return storage.run({ ...context }, fn);
  }

  get(): RequestContextStore | undefined {
    return storage.getStore();
  }

  patch(partial: Partial<RequestContextStore>): void {
    const current = storage.getStore();
    if (!current) return;
    Object.assign(current, partial);
  }

  snapshot(): ObservabilityContext {
    const current = storage.getStore();
    if (!current) return {};
    const {
      requestId,
      traceId,
      spanId,
      workspaceId,
      userIdHash,
      workflowId,
      executionId,
      stepId,
      capability,
      repository,
      pullRequestNumber,
      provider,
      release,
      environment,
      plan,
      service,
      errorCode,
    } = current;
    return {
      ...(requestId ? { requestId } : {}),
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(userIdHash ? { userIdHash } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(executionId ? { executionId } : {}),
      ...(stepId ? { stepId } : {}),
      ...(capability ? { capability } : {}),
      ...(repository ? { repository } : {}),
      ...(pullRequestNumber != null ? { pullRequestNumber } : {}),
      ...(provider ? { provider } : {}),
      ...(release ? { release } : {}),
      ...(environment ? { environment } : {}),
      ...(plan ? { plan } : {}),
      ...(service ? { service } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }
}
