import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ObservabilityContext } from '@project-x/types';

export type RequestContextStore = ObservabilityContext & {
  sampled?: boolean;
  /**
   * True when the request carried a non-empty X-Workspace-Id that failed format validation.
   * `workspaceId` is left unset in that case, so this flag is what stops callers from
   * treating a malformed header as "absent" and falling back to another workspace.
   */
  workspaceHeaderInvalid?: boolean;
};

const storage = new AsyncLocalStorage<RequestContextStore>();

/** Read workspace from the active ALS store (set by RequestContextMiddleware from X-Workspace-Id). */
export function peekRequestWorkspaceId(): string | undefined {
  const workspaceId = storage.getStore()?.workspaceId;
  return typeof workspaceId === 'string' && workspaceId.length > 0 ? workspaceId : undefined;
}

/** True when the active request sent a malformed X-Workspace-Id header. */
export function peekRequestWorkspaceHeaderInvalid(): boolean {
  return storage.getStore()?.workspaceHeaderInvalid === true;
}

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
