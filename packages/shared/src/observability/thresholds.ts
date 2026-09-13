/** Day 26 — slow-operation thresholds (ms). Configurable via env overrides. */

export interface SlowOperationThresholds {
  httpRequestMs: number;
  aiRequestMs: number;
  providerRequestMs: number;
  workflowStepMs: number;
  dbOperationMs: number;
}

export const DEFAULT_SLOW_OPERATION_THRESHOLDS: SlowOperationThresholds = {
  httpRequestMs: 5_000,
  aiRequestMs: 30_000,
  providerRequestMs: 8_000,
  workflowStepMs: 60_000,
  dbOperationMs: 2_000,
};

export function parseSlowThreshold(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
