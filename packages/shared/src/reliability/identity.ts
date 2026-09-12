import type { WorkflowExecutionTrigger } from '@project-x/types';

import { createOpaqueId, sha256Hex } from './hash';

/**
 * Server-owned execution IDs are opaque strings.
 * Deterministic linkage uses workflowId + executionNumber; retries link via parentExecutionId.
 */
export function createWorkflowExecutionId(): string {
  return createOpaqueId('wex_');
}

export function hashStableId(parts: ReadonlyArray<string>): string {
  return sha256Hex(parts.join('\0')).slice(0, 32);
}

export function nextExecutionNumber(existingCount: number): number {
  return Math.max(0, Math.floor(existingCount)) + 1;
}

export function isValidExecutionTrigger(value: unknown): value is WorkflowExecutionTrigger {
  return value === 'user' || value === 'retry' || value === 'resume' || value === 'replay';
}
