import type { ObservabilityContext, ObservabilityLogLevel } from '@project-x/types';

export interface ErrorTrackerCaptureContext extends ObservabilityContext {
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

export interface ErrorTracker {
  captureException(error: unknown, context?: ErrorTrackerCaptureContext): string | undefined;
  captureMessage(
    message: string,
    level: ObservabilityLogLevel,
    context?: ErrorTrackerCaptureContext,
  ): string | undefined;
  setContext(context: ObservabilityContext): void;
  flush(timeoutMs?: number): Promise<boolean>;
}

export const ERROR_TRACKER = Symbol('ERROR_TRACKER');
