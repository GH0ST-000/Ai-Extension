/** Day 26 — observability identity helpers (isomorphic). */

import { createOpaqueId, sha256Hex } from '../reliability/hash';

const REQUEST_ID_RE = /^req_[a-zA-Z0-9]{8,64}$/;
const MAX_INCOMING_REQUEST_ID_LEN = 80;

export function createRequestId(): string {
  return createOpaqueId('req_');
}

export function createTraceId(): string {
  return createOpaqueId('trace_');
}

export function createSpanId(): string {
  return createOpaqueId('span_');
}

export function createAiOperationId(): string {
  return createOpaqueId('aiop_');
}

/**
 * Accept a trusted incoming request id only when it matches a safe format.
 * Rejects oversized or arbitrary client values.
 */
export function normalizeIncomingRequestId(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INCOMING_REQUEST_ID_LEN) {
    return undefined;
  }
  if (!REQUEST_ID_RE.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveRequestId(incoming: string | undefined | null): string {
  return normalizeIncomingRequestId(incoming) ?? createRequestId();
}

/** Stable hashed user reference for external telemetry — never email. */
export function hashUserIdForTelemetry(userId: string): string {
  return `u_${sha256Hex(userId).slice(0, 16)}`;
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}
